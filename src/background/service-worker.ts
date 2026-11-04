import { describeError } from '../lib/errors';
import { AUDIO_FILE } from '../lib/files';
import { copyName, downloadFolderPattern, MAX_COPIES, sanitizeFolderName } from '../lib/folder-name';
import { callHelper, openHelper, writeWithHelper } from '../lib/helper';
import { isPendingExport, listMeetings, MEETINGS_KEY, trimMeetings } from '../lib/meetings';
import { readStagedFile, removeStaged } from '../lib/opfs';
import { DEFAULT_SAVE_FOLDER, getSettings } from '../lib/settings';
import { folderStamp } from '../lib/stamp';
import type {
  BackgroundMessage,
  DownloadFile,
  FailedStep,
  HelperReply,
  IdleReply,
  MeetingRecord,
  MeetingStatus,
  OffscreenMessage,
  PipelineSettings,
  Reply,
  SaveReply,
} from '../types';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const ACTIVE_STATUSES: MeetingStatus[] = ['recording', 'saving', 'transcribing', 'translating', 'summarizing'];
const STEP_STATUS: Record<FailedStep, MeetingStatus> = {
  transcribe: 'transcribing',
  translate: 'translating',
  summarize: 'summarizing',
};

type SaveFilesMessage = Extract<BackgroundMessage, { type: 'save-files' }>;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

let queue: Promise<unknown> = Promise.resolve();
let pendingCommands = 0;

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}

const fail = (error: string): Reply => ({ ok: false, error });

const isActive = (meeting: MeetingRecord): boolean => ACTIVE_STATUSES.includes(meeting.status);

const isBackgroundMessage = (message: unknown): message is BackgroundMessage =>
  typeof message === 'object' && message !== null && (message as { target?: unknown }).target === 'background';

async function writeMeetings(meetings: MeetingRecord[]): Promise<void> {
  const { kept, dropped } = trimMeetings(meetings);
  await chrome.storage.local.set({ [MEETINGS_KEY]: kept });
  await Promise.all(dropped.map((meeting) => removeStaged(meeting.id)));
  await chrome.action.setBadgeText({ text: kept.some((meeting) => meeting.status === 'recording') ? 'REC' : '' });
}

function addRecording(meeting: MeetingRecord): Promise<boolean> {
  return enqueue(async () => {
    const meetings = await listMeetings();
    if (meetings.some((item) => item.status === 'recording')) return false;
    await writeMeetings([meeting, ...meetings]);
    return true;
  });
}

function applyPatch(meeting: MeetingRecord, patch: Partial<MeetingRecord>): MeetingRecord {
  const next: MeetingRecord = { ...meeting, ...patch };
  if (patch.status && patch.progress === undefined) delete next.progress;
  if (patch.status && patch.status !== 'error') {
    delete next.error;
    delete next.failedStep;
  }
  return next;
}

function changeMeeting(
  id: string,
  decide: (meeting: MeetingRecord) => Partial<MeetingRecord> | undefined,
): Promise<MeetingRecord | undefined> {
  return enqueue(async () => {
    const meetings = await listMeetings();
    const index = meetings.findIndex((meeting) => meeting.id === id);
    const current = meetings[index];
    const patch = current ? decide(current) : undefined;
    if (!current || !patch) return undefined;
    meetings[index] = applyPatch(current, patch);
    await writeMeetings(meetings);
    return current;
  });
}

async function updateMeeting(id: string, patch: Partial<MeetingRecord>): Promise<void> {
  await changeMeeting(id, () => patch);
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return contexts.length > 0;
}

function ensureOffscreenDocument(): Promise<void> {
  return enqueue(async () => {
    if (await hasOffscreenDocument()) return;
    // Meetings still marked as running belonged to a recorder page that no longer exists.
    await markInterrupted();
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.BLOBS],
      justification: 'Record meeting audio from the tab and the microphone, and hand the files to the download manager.',
    });
  });
}

function closeOffscreenWhenIdle(): void {
  enqueue(async () => {
    if (pendingCommands > 0 || !(await hasOffscreenDocument())) return;
    if ((await listMeetings()).some(isActive)) return;
    await chrome.offscreen.closeDocument();
  }).catch((error: unknown) => console.warn('Could not close the offscreen document', error));
}

// The recorder page says it has nothing left to do. A meeting still marked as running lost its
// last status update, so it is marked interrupted, and the page is closed to free its memory.
function offscreenIdle(): void {
  enqueue(async () => {
    if (pendingCommands > 0 || !(await hasOffscreenDocument())) return;
    const reply = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'status' })) as IdleReply | undefined;
    if (!reply?.idle || pendingCommands > 0) return;
    await markInterrupted();
    await chrome.offscreen.closeDocument();
  }).catch((error: unknown) => console.warn('Could not close the offscreen document', error));
}

async function runCommand(command: () => Promise<Reply>): Promise<Reply> {
  pendingCommands += 1;
  try {
    return await command();
  } finally {
    pendingCommands -= 1;
    closeOffscreenWhenIdle();
  }
}

async function sendToOffscreen(message: OffscreenMessage): Promise<Reply | undefined> {
  return (await chrome.runtime.sendMessage(message)) as Reply | undefined;
}

function pipelineSettings({ model, prompt }: PipelineSettings): PipelineSettings {
  return { model, prompt };
}

async function interruptedPatch(meeting: MeetingRecord, reason: string): Promise<Partial<MeetingRecord>> {
  if (meeting.status === 'recording') {
    // The recorder stores the audio every few minutes, so most of it is usually still there.
    const kept = await readStagedFile(meeting.id, AUDIO_FILE).catch(() => undefined);
    if (!kept?.size) return { status: 'error', error: `${reason} No audio was kept.`, exported: true };
    return {
      status: 'error',
      failedStep: 'transcribe',
      folderName: meeting.customFolderName || folderStamp(new Date(meeting.startedAt)),
      error: `${reason} The audio up to a few minutes before that was kept. Use Retry to save it.`,
      exported: false,
    };
  }
  const failedStep: FailedStep =
    meeting.status === 'summarizing' ? 'summarize' : meeting.status === 'translating' ? 'translate' : 'transcribe';
  return { status: 'error', failedStep, error: 'Processing was interrupted. Use Retry to continue.', exported: false };
}

// Runs inside a queued task, so it does not queue itself.
async function markInterrupted(
  reason = 'The recording was interrupted.',
  affected: (meeting: MeetingRecord) => boolean = isActive,
): Promise<void> {
  const meetings = await listMeetings();
  if (!meetings.some(affected)) return;
  const patched = await Promise.all(
    meetings.map(async (meeting) => (affected(meeting) ? applyPatch(meeting, await interruptedPatch(meeting, reason)) : meeting)),
  );
  await writeMeetings(patched);
}

function recoverInterrupted(): Promise<void> {
  return enqueue(async () => {
    if (!(await hasOffscreenDocument())) await markInterrupted();
  });
}

function failRunningRecording(reason: string): Promise<void> {
  return enqueue(() =>
    markInterrupted(`The recording stopped unexpectedly: ${reason}.`, (meeting) => meeting.status === 'recording'),
  );
}

async function isDownloadFolderTaken(base: string, folder: string): Promise<boolean> {
  const matches = await chrome.downloads.search({ filenameRegex: downloadFolderPattern(base, folder), limit: 1 });
  return matches.length > 0;
}

function waitForDownload(downloadId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (error?: Error): void => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      if (error) reject(error);
      else resolve();
    };
    const check = (state?: string, reason?: string): void => {
      if (state === 'complete') settle();
      else if (state === 'interrupted') settle(new Error(`Chrome could not save the file (${reason ?? 'interrupted'}).`));
    };
    function onChanged(delta: chrome.downloads.DownloadDelta): void {
      if (delta.id === downloadId) check(delta.state?.current, delta.error?.current);
    }
    chrome.downloads.onChanged.addListener(onChanged);
    timer = setTimeout(() => settle(new Error('Chrome did not finish saving the file in time.')), DOWNLOAD_TIMEOUT_MS);
    chrome.downloads.search({ id: downloadId }).then(([item]) => check(item?.state, item?.error), () => undefined);
  });
}

async function downloadFile(filename: string, url: string): Promise<{ id: number; path: string }> {
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  await waitForDownload(id);
  const [item] = await chrome.downloads.search({ id });
  return { id, path: item?.filename ?? '' };
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? '';

// Chrome only knows the folders in its download history. If the first file still had to be
// renamed, the folder was already on disk, so that copy is removed and the next name is tried.
async function downloadIntoNewFolder(base: string, wanted: string, file: DownloadFile): Promise<{ folder: string; path: string }> {
  for (let copy = 1; copy <= MAX_COPIES; copy += 1) {
    const folder = copyName(wanted, copy);
    if (await isDownloadFolderTaken(base, folder)) continue;
    const { id, path } = await downloadFile(`${base}/${folder}/${file.name}`, file.url);
    if (baseName(path) === file.name) return { folder, path };
    await chrome.downloads.removeFile(id).catch(() => undefined);
    await chrome.downloads.erase({ id });
  }
  throw new Error(`There are already ${MAX_COPIES} folders named "${wanted}".`);
}

async function saveToDownloads(message: SaveFilesMessage): Promise<SaveReply> {
  const base = DEFAULT_SAVE_FOLDER;
  const saved: string[] = [];
  const paths: Record<string, string> = {};
  let folder = message.folderClaimed ? message.folderName : undefined;
  try {
    for (const file of message.files) {
      if (folder) {
        paths[file.name] = (await downloadFile(`${base}/${folder}/${file.name}`, file.url)).path;
      } else {
        const first = await downloadIntoNewFolder(base, message.folderName, file).catch((error: unknown) => {
          // Names are cleaned with Chrome's own rules, but never leave a meeting stuck on a rejected one.
          if (!/invalid filename/i.test(describeError(error))) throw error;
          return downloadIntoNewFolder(base, `Recording ${folderStamp(new Date())}`, file);
        });
        folder = first.folder;
        paths[file.name] = first.path;
      }
      saved.push(file.name);
    }
    return { ok: true, folderName: folder ?? message.folderName, saveDirectory: '', saved, paths };
  } catch (error) {
    // A folder only counts as taken once a file is in it.
    const claimed = folder ? { folderName: folder, saveDirectory: '' } : {};
    return { ok: false, error: describeError(error), ...claimed, saved, paths };
  }
}

// Chrome downloads cannot leave the Downloads folder, so other folders go through the helper.
// The worker reads the files from the extension's private storage itself.
async function saveWithHelper(directory: string, message: SaveFilesMessage): Promise<SaveReply> {
  const saved: string[] = [];
  const paths: Record<string, string> = {};
  let folder: string | undefined;
  const helper = openHelper();
  try {
    const claim = { type: 'claim-folder', dir: directory, name: message.folderName, claimed: message.folderClaimed } as const;
    folder = (await helper.call<{ folder: string }>(claim)).folder;
    for (const file of message.files) {
      const staged = await readStagedFile(message.meetingId, file.name);
      if (!staged) throw new Error(`${file.name} is missing from the extension's storage.`);
      paths[file.name] = await writeWithHelper(helper, { dir: directory, folder, name: file.name }, staged);
      saved.push(file.name);
    }
    return { ok: true, folderName: folder, saveDirectory: directory, saved, paths };
  } catch (error) {
    const claimed = folder ? { folderName: folder, saveDirectory: directory } : {};
    return { ok: false, error: describeError(error), ...claimed, saved, paths };
  } finally {
    helper.close();
  }
}

// A meeting stays in the place its first file went to, even if the setting changes later.
async function saveFiles(message: SaveFilesMessage): Promise<SaveReply> {
  try {
    const directory = message.folderClaimed ? (message.saveDirectory ?? '') : (await getSettings()).saveDirectory;
    return directory ? await saveWithHelper(directory, message) : await saveToDownloads(message);
  } catch (error) {
    return { ok: false, error: describeError(error), saved: [], paths: {} };
  }
}

async function runHelper(message: Extract<BackgroundMessage, { type: 'helper' }>): Promise<HelperReply<unknown>> {
  let shown = '';
  const showProgress = (progress: string): void => {
    if (progress === shown) return;
    shown = progress;
    updateMeeting(message.meetingId, { progress }).catch(() => undefined);
  };
  try {
    return { ok: true, result: await callHelper(message.request, showProgress) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

async function startRecording(message: Extract<BackgroundMessage, { type: 'start' }>): Promise<Reply> {
  if ((await listMeetings()).some((meeting) => meeting.status === 'recording')) {
    return fail('A recording is already running.');
  }
  const settings = await getSettings();

  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: message.tabId });

  const startedAt = Date.now();
  const customFolderName = sanitizeFolderName(message.folderName);
  const meeting: MeetingRecord = {
    id: String(startedAt),
    title: message.title || 'Untitled meeting',
    url: message.url,
    startedAt,
    transcribe: message.transcribe,
    ...(customFolderName ? { customFolderName } : {}),
    status: 'recording',
    exported: false,
  };
  if (!(await addRecording(meeting))) return fail('A recording is already running.');

  try {
    const reply = await sendToOffscreen({
      target: 'offscreen',
      type: 'start',
      meeting,
      streamId,
      includeMic: message.includeMic,
      settings: pipelineSettings(settings),
    });
    if (!reply?.ok) throw new Error(reply ? reply.error : 'The recorder did not answer.');
    if (reply.warning) await updateMeeting(meeting.id, { warning: reply.warning });
    return { ok: true };
  } catch (error) {
    const reason = describeError(error);
    await updateMeeting(meeting.id, { status: 'error', error: reason, exported: true });
    return fail(reason);
  }
}

async function stopRecording(): Promise<Reply> {
  let reply: Reply | undefined;
  try {
    reply = await sendToOffscreen({ target: 'offscreen', type: 'stop' });
  } catch (error) {
    reply = fail(describeError(error));
  }
  if (reply?.ok) return reply;
  const reason = reply ? reply.error : 'The recorder did not answer.';
  await failRunningRecording(reason);
  return fail(reason);
}

function retryStatus(meeting: MeetingRecord): MeetingStatus {
  if (!meeting.transcribe) return 'saving';
  return STEP_STATUS[meeting.failedStep ?? 'transcribe'];
}

async function retryMeeting(id: string): Promise<Reply> {
  const settings = await getSettings();
  await ensureOffscreenDocument();
  const meeting = await changeMeeting(id, (current) =>
    current.status === 'error' && current.failedStep ? { status: retryStatus(current) } : undefined,
  );
  if (!meeting) return fail('This meeting is already being processed or can no longer be retried.');
  try {
    const reply = await sendToOffscreen({
      target: 'offscreen',
      type: 'retry',
      meeting,
      settings: pipelineSettings(settings),
    });
    if (!reply?.ok) throw new Error(reply ? reply.error : 'The recorder did not answer.');
    return { ok: true };
  } catch (error) {
    const reason = describeError(error);
    await updateMeeting(id, { status: 'error', failedStep: meeting.failedStep, error: reason });
    return fail(reason);
  }
}

async function saveAgain(): Promise<Reply> {
  const pending = (await listMeetings()).filter(isPendingExport);
  if (pending.length === 0) return { ok: true };
  await ensureOffscreenDocument();
  const errors: string[] = [];
  for (const { id } of pending) {
    // Read it again: Retry may have saved it while earlier meetings were being saved.
    const meeting = (await listMeetings()).find((item) => item.id === id);
    if (!meeting || !isPendingExport(meeting)) continue;
    const reply = await sendToOffscreen({ target: 'offscreen', type: 'export', meeting }).catch((error: unknown) =>
      fail(describeError(error)),
    );
    if (!reply?.ok) errors.push(`${meeting.title}: ${reply ? reply.error : 'The recorder did not answer.'}`);
  }
  return errors.length === 0 ? { ok: true } : fail(errors.join(' '));
}

// Removes a finished or failed meeting and its private copy. Files already saved stay on disk.
function discardMeeting(id: string): Promise<Reply> {
  return enqueue(async () => {
    const meetings = await listMeetings();
    const meeting = meetings.find((item) => item.id === id);
    if (!meeting) return { ok: true };
    if (isActive(meeting)) return fail('This meeting is still being recorded or processed.');
    await writeMeetings(meetings.filter((item) => item.id !== id));
    await removeStaged(id);
    return { ok: true };
  });
}

async function handleMessage(message: BackgroundMessage): Promise<Reply | SaveReply | HelperReply<unknown>> {
  try {
    switch (message.type) {
      case 'start':
        return await runCommand(() => startRecording(message));
      case 'stop':
        return await runCommand(stopRecording);
      case 'retry':
        return await runCommand(() => retryMeeting(message.id));
      case 'save-again':
        return await runCommand(saveAgain);
      case 'discard':
        return await discardMeeting(message.id);
      case 'save-files':
        return await saveFiles(message);
      case 'helper':
        return await runHelper(message);
      case 'meeting-update':
        await updateMeeting(message.id, message.patch);
        return { ok: true };
      case 'offscreen-idle':
        offscreenIdle();
        return { ok: true };
    }
  } catch (error) {
    return fail(describeError(error));
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isBackgroundMessage(message)) return false;
  void handleMessage(message).then(sendResponse);
  return true;
});

void chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
void recoverInterrupted();
