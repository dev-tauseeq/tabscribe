import { describeError } from '../lib/errors';
import { defaultRecordingName } from '../lib/folder-name';
import { callHelper } from '../lib/helper';
import { isPendingExport, listMeetings, MEETINGS_KEY } from '../lib/meetings';
import { sendToBackground } from '../lib/messaging';
import { readMicAccess, type MicAccess } from '../lib/mic';
import { getSettings, saveLocation, saveSettings, SETTINGS_KEY } from '../lib/settings';
import { formatClock } from '../lib/stamp';
import type { BackgroundMessage, HelperStatus, MeetingRecord, Reply } from '../types';

interface View {
  meetings: MeetingRecord[];
  helperReady: boolean;
  transcribe: boolean;
  saveLocation: string;
  mic: MicAccess;
  notice: string;
  working: boolean;
}

const SHOWN_MEETINGS = 5;
const CONFIRM_MS = 4000;

const STATUS_LABELS: Record<MeetingRecord['status'], string> = {
  recording: 'Recording',
  saving: 'Saving files',
  transcribing: 'Transcribing',
  translating: 'Translating to English',
  summarizing: 'Writing summary',
  done: 'Saved',
  error: 'Failed',
};

const view: View = {
  meetings: [],
  helperReady: false,
  transcribe: true,
  saveLocation: saveLocation({ saveDirectory: '' }),
  mic: 'unknown',
  notice: '',
  working: false,
};

function byId<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const issuesList = byId<HTMLUListElement>('issues');
const startOptions = byId<HTMLDivElement>('start-options');
const nameInput = byId<HTMLInputElement>('recording-name');
const micInput = byId<HTMLInputElement>('include-mic');
const transcribeInput = byId<HTMLInputElement>('transcribe');
const transcribeHint = byId<HTMLParagraphElement>('transcribe-hint');
const saveHint = byId<HTMLParagraphElement>('save-hint');
const toggleButton = byId<HTMLButtonElement>('toggle');
const timerText = byId<HTMLParagraphElement>('timer');
const noticeText = byId<HTMLParagraphElement>('notice');
const pendingBox = byId<HTMLElement>('pending');
const pendingText = byId<HTMLParagraphElement>('pending-text');
const pendingAction = byId<HTMLButtonElement>('pending-action');
const meetingsList = byId<HTMLUListElement>('meetings');

let timer: ReturnType<typeof setInterval> | undefined;
let confirmingDiscard: { id: string; timer: ReturnType<typeof setTimeout> } | undefined;

async function send(message: BackgroundMessage): Promise<Reply> {
  return (await sendToBackground<Reply>(message)) ?? { ok: false, error: 'The background worker did not answer.' };
}

const runningMeeting = (): MeetingRecord | undefined => view.meetings.find((meeting) => meeting.status === 'recording');

function setupIssues(): string[] {
  if (!micInput.checked || view.mic === 'granted') return [];
  return ['Allow the microphone on the Settings page first, or only the tab audio is recorded.'];
}

function statusLabel(meeting: MeetingRecord): string {
  if (meeting.status === 'done' && !meeting.exported) return 'Not saved yet';
  const label = STATUS_LABELS[meeting.status];
  return meeting.progress ? `${label} (${meeting.progress})` : label;
}

function formatWhen(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function renderIssues(): void {
  const issues = setupIssues();
  issuesList.replaceChildren(...issues.map((issue) => element('li', '', issue)));
  issuesList.hidden = issues.length === 0;
}

function syncTimer(running: boolean): void {
  if (running && timer === undefined) timer = setInterval(updateTimer, 1000);
  if (!running && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

function updateTimer(): void {
  const running = runningMeeting();
  timerText.hidden = !running;
  if (running) {
    timerText.textContent = `Recording ${formatClock(Date.now() - running.startedAt).replace(/^00:/, '')}`;
  }
}

function renderStartOptions(running: boolean): void {
  startOptions.hidden = running;
  nameInput.disabled = view.working;
  micInput.disabled = view.working;
  transcribeInput.disabled = view.working || !view.helperReady;
  transcribeInput.checked = view.helperReady && view.transcribe;
  transcribeHint.hidden = view.helperReady;
  saveHint.textContent = `Saved in ${view.saveLocation}, in a folder with this name.`;
}

function renderPending(): void {
  const waiting = view.meetings.filter(isPendingExport).length;
  pendingBox.hidden = waiting === 0;
  if (waiting === 0) return;
  pendingText.textContent = `${waiting} ${waiting === 1 ? 'meeting was' : 'meetings were'} not saved yet.`;
  pendingAction.disabled = view.working;
}

function meetingRow(meeting: MeetingRecord): HTMLLIElement {
  const row = element('li', `meeting ${meeting.status}`);
  const kind = meeting.transcribe ? '' : ' | Recording only';
  row.append(element('div', 'meeting-title', meeting.title));
  row.append(element('div', 'meeting-meta', `${formatWhen(meeting.startedAt)} | ${statusLabel(meeting)}${kind}`));
  const folder = meeting.folderName ?? meeting.customFolderName;
  if (folder) row.append(element('div', 'meeting-folder', `Folder: ${folder}`));
  if (meeting.error) row.append(element('div', 'meeting-error', meeting.error));
  if (meeting.warning) row.append(element('div', 'meeting-warning', meeting.warning));
  if (!meeting.exported && meeting.exportNote && meeting.status !== 'recording') {
    row.append(element('div', 'meeting-warning', meeting.exportNote));
  }
  const actions = element('div', 'meeting-actions');
  if (meeting.status === 'error' && meeting.failedStep) {
    const retry = element('button', '', 'Retry');
    retry.type = 'button';
    retry.dataset.retry = meeting.id;
    retry.disabled = view.working;
    actions.append(retry);
  }
  if (holdsStorage(meeting)) {
    const confirming = confirmingDiscard?.id === meeting.id;
    const discard = element('button', confirming ? 'danger' : '', confirming ? 'Click again to delete' : 'Remove');
    discard.type = 'button';
    discard.dataset.discard = meeting.id;
    discard.disabled = view.working;
    discard.title = 'Removes it from this list and deletes the audio that was not saved. Saved files stay where they are.';
    actions.append(discard);
  }
  if (actions.childElementCount > 0) row.append(actions);
  return row;
}

// Failed or unsaved meetings keep their audio in the extension's storage until they are saved or removed.
function holdsStorage(meeting: MeetingRecord): boolean {
  return meeting.status === 'error' || (meeting.status === 'done' && !meeting.exported);
}

function renderMeetings(): void {
  const shown = view.meetings.filter((meeting, index) => index < SHOWN_MEETINGS || holdsStorage(meeting));
  meetingsList.replaceChildren(...(shown.length > 0 ? shown.map(meetingRow) : [element('li', 'empty', 'No recordings yet.')]));
}

function render(): void {
  const running = Boolean(runningMeeting());
  renderIssues();
  renderStartOptions(running);
  toggleButton.textContent = running ? 'Stop recording' : 'Start recording';
  toggleButton.classList.toggle('danger', running);
  toggleButton.classList.toggle('primary', !running);
  toggleButton.disabled = view.working;
  syncTimer(running);
  updateTimer();
  noticeText.hidden = view.notice === '';
  noticeText.textContent = view.notice;
  renderPending();
  renderMeetings();
}

async function refresh(): Promise<void> {
  const [meetings, settings, mic] = await Promise.all([listMeetings(), getSettings(), readMicAccess()]);
  view.meetings = meetings;
  view.transcribe = settings.transcribe;
  view.saveLocation = saveLocation(settings);
  view.mic = mic;
  render();
}

async function checkHelper(): Promise<void> {
  // Runs once when the popup opens; Start waits for it so the transcript choice is right.
  try {
    view.helperReady = (await callHelper<HelperStatus>({ type: 'status' })).ready;
  } catch {
    view.helperReady = false;
  }
  render();
}

async function prefillName(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (nameInput.value === '') nameInput.value = defaultRecordingName(tab?.title ?? '', new Date());
}

async function runAction(action: () => Promise<Reply>): Promise<void> {
  view.working = true;
  view.notice = '';
  render();
  try {
    const reply = await action();
    if (!reply.ok) view.notice = reply.error;
  } catch (error) {
    view.notice = describeError(error);
  } finally {
    view.working = false;
    await refresh();
  }
}

async function startFromActiveTab(): Promise<Reply> {
  await helperCheck;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return { ok: false, error: 'No active tab was found.' };
  const reply = await send({
    target: 'background',
    type: 'start',
    tabId: tab.id,
    title: tab.title ?? '',
    url: tab.url ?? '',
    includeMic: micInput.checked,
    transcribe: view.helperReady && view.transcribe,
    folderName: nameInput.value,
  });
  if (reply.ok) nameInput.value = '';
  return reply;
}

async function stopRecording(): Promise<Reply> {
  const reply = await send({ target: 'background', type: 'stop' });
  nameInput.value = '';
  await prefillName();
  return reply;
}

const toggleRecording = (): Promise<void> => runAction(() => (runningMeeting() ? stopRecording() : startFromActiveTab()));

toggleButton.addEventListener('click', () => void toggleRecording());
pendingAction.addEventListener('click', () => void runAction(() => send({ target: 'background', type: 'save-again' })));
micInput.addEventListener('change', renderIssues);
transcribeInput.addEventListener('change', () => {
  view.transcribe = transcribeInput.checked;
  void saveSettings({ transcribe: view.transcribe });
});
nameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !toggleButton.disabled) void toggleRecording();
});
byId('open-settings').addEventListener('click', () => void chrome.runtime.openOptionsPage());
meetingsList.addEventListener('click', (event) => {
  const target = event.target;
  if (target instanceof HTMLButtonElement && target.dataset.discard) {
    const id = target.dataset.discard;
    if (confirmingDiscard?.id === id) {
      clearTimeout(confirmingDiscard.timer);
      confirmingDiscard = undefined;
      void runAction(() => send({ target: 'background', type: 'discard', id }));
      return;
    }
    if (confirmingDiscard) clearTimeout(confirmingDiscard.timer);
    confirmingDiscard = {
      id,
      timer: setTimeout(() => {
        confirmingDiscard = undefined;
        renderMeetings();
      }, CONFIRM_MS),
    };
    renderMeetings();
    return;
  }
  if (target instanceof HTMLButtonElement && target.dataset.retry) {
    const id = target.dataset.retry;
    void runAction(() => send({ target: 'background', type: 'retry', id }));
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (MEETINGS_KEY in changes || SETTINGS_KEY in changes)) void refresh();
});
void prefillName();
void refresh();
const helperCheck = checkHelper();
