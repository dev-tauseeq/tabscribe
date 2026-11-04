import { describeError } from '../lib/errors';
import { AUDIO_FILE } from '../lib/files';
import { sendToBackground } from '../lib/messaging';
import { openCheckpointedWriter, readStagedFile, removeStaged } from '../lib/opfs';
import { sleep } from '../lib/sleep';
import { folderStamp } from '../lib/stamp';
import type { IdleReply, MeetingRecord, OffscreenMessage, PipelineSettings, Reply } from '../types';
import { runPipeline, type Report } from './pipeline';
import { startRecorder, type Recorder } from './recorder';
import { saveMeetingFiles } from './save';

const REPORT_ATTEMPTS = 3;
// About five minutes of audio at 48 kbps.
const CHECKPOINT_BYTES = 2 * 1024 * 1024;

type StartMessage = Extract<OffscreenMessage, { type: 'start' }>;

interface ActiveRecording {
  meeting: MeetingRecord;
  settings: PipelineSettings;
  started: Promise<Recorder | undefined>;
}

interface SavedRecording {
  meeting: MeetingRecord;
  settings: PipelineSettings;
}

let active: ActiveRecording | undefined;
const processing = new Set<string>();

const isOffscreenMessage = (message: unknown): message is OffscreenMessage =>
  typeof message === 'object' && message !== null && (message as { target?: unknown }).target === 'offscreen';

function reporter(id: string): Report {
  return async (patch) => {
    for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt += 1) {
      try {
        await sendToBackground({ target: 'background', type: 'meeting-update', id, patch });
        return;
      } catch (error) {
        if (attempt === REPORT_ATTEMPTS) console.error('Could not report meeting status', error);
        else await sleep(500 * attempt);
      }
    }
  };
}

function notifyIfIdle(): void {
  if (active || processing.size > 0) return;
  sendToBackground({ target: 'background', type: 'offscreen-idle' }).catch(() => undefined);
}

async function processMeeting(meeting: MeetingRecord, settings: PipelineSettings): Promise<void> {
  if (processing.has(meeting.id)) return;
  processing.add(meeting.id);
  try {
    await runPipeline(meeting, settings, reporter(meeting.id));
  } finally {
    processing.delete(meeting.id);
    notifyIfIdle();
  }
}

async function stopActiveRecording(): Promise<SavedRecording | undefined> {
  const current = active;
  if (!current) return undefined;
  active = undefined;
  const recorder = await current.started;
  if (!recorder) return undefined;

  const endedAt = Date.now();
  const folderName = current.meeting.customFolderName || folderStamp(new Date(endedAt));
  let meeting: MeetingRecord = { ...current.meeting, endedAt, folderName, status: 'saving' };
  const report = reporter(meeting.id);
  await report({ status: 'saving', endedAt, folderName });

  try {
    await recorder.stop();
  } catch (error) {
    // The audio up to the last checkpoint is still stored, so keep going with that part.
    const kept = await readStagedFile(meeting.id, AUDIO_FILE).catch(() => undefined);
    if (!kept?.size) {
      await report({ status: 'error', error: `Could not save the recording: ${describeError(error)}`, exported: true });
      return undefined;
    }
    const warning = `The recording stopped early because the audio could not be written (${describeError(error)}). The part before that was kept.`;
    meeting = { ...meeting, warning };
    await report({ warning });
  }

  const saved = await saveMeetingFiles(meeting, false);
  await report(saved);
  return { meeting: { ...meeting, ...saved }, settings: current.settings };
}

async function finishRecording(): Promise<void> {
  const saved = await stopActiveRecording();
  if (saved) {
    await processMeeting(saved.meeting, saved.settings);
  } else {
    notifyIfIdle();
  }
}

async function openRecorder(message: StartMessage): Promise<Recorder> {
  const output = await openCheckpointedWriter(message.meeting.id, AUDIO_FILE, CHECKPOINT_BYTES);
  return startRecorder({
    streamId: message.streamId,
    includeMic: message.includeMic,
    output,
    onInterrupted: () => void finishRecording(),
  });
}

async function startRecording(message: StartMessage): Promise<Reply> {
  if (active) return { ok: false, error: 'A recording is already running.' };
  const opening = openRecorder(message);
  const session: ActiveRecording = {
    meeting: message.meeting,
    settings: message.settings,
    started: opening.catch(() => undefined),
  };
  active = session;
  try {
    const recorder = await opening;
    return { ok: true, warning: recorder.warning };
  } catch (error) {
    if (active === session) active = undefined;
    await removeStaged(message.meeting.id).catch(() => undefined);
    notifyIfIdle();
    return { ok: false, error: describeError(error) };
  }
}

// A meeting that is being processed saves its own files, so it is skipped here.
async function saveAgain(meeting: MeetingRecord): Promise<Reply> {
  if (processing.has(meeting.id)) return { ok: true };
  processing.add(meeting.id);
  try {
    const saved = await saveMeetingFiles(meeting, meeting.status === 'done');
    await reporter(meeting.id)(saved);
    return saved.exported ? { ok: true } : { ok: false, error: saved.exportNote || 'The files could not be saved.' };
  } finally {
    processing.delete(meeting.id);
    notifyIfIdle();
  }
}

async function handleMessage(message: OffscreenMessage): Promise<Reply | IdleReply> {
  switch (message.type) {
    case 'start':
      return startRecording(message);
    case 'stop':
      if (!active) {
        notifyIfIdle();
        return { ok: false, error: 'No recording is running.' };
      }
      void finishRecording();
      return { ok: true };
    case 'retry':
      if (processing.has(message.meeting.id)) return { ok: false, error: 'This meeting is still being saved. Try again in a moment.' };
      void processMeeting(message.meeting, message.settings);
      return { ok: true };
    case 'export':
      return saveAgain(message.meeting);
    case 'status':
      return { ok: true, idle: !active && processing.size === 0 };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isOffscreenMessage(message)) return false;
  handleMessage(message).then(sendResponse, (error: unknown) => sendResponse({ ok: false, error: describeError(error) }));
  return true;
});
