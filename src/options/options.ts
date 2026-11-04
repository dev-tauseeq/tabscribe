import { describeError } from '../lib/errors';
import { callHelper } from '../lib/helper';
import { readMicAccess, type MicAccess } from '../lib/mic';
import { DEFAULT_MODEL, DEFAULT_PROMPT, getSettings, saveSettings } from '../lib/settings';
import type { HelperStatus } from '../types';

const SAVED_MESSAGE_MS = 2500;

const MIC_MESSAGES: Record<MicAccess, string> = {
  granted: 'Microphone access is allowed.',
  prompt: 'Microphone access has not been allowed yet.',
  denied: 'Microphone access is blocked. Enable it for this extension in Chrome site settings.',
  unknown: 'Microphone access could not be checked.',
};

function byId<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const helperStatus = byId<HTMLParagraphElement>('helper-status');
const helperProblems = byId<HTMLUListElement>('helper-problems');
const helperSetup = byId<HTMLDivElement>('helper-setup');
const checkHelperButton = byId<HTMLButtonElement>('check-helper');
const saveDirectoryInput = byId<HTMLInputElement>('save-directory');
const chooseFolderButton = byId<HTMLButtonElement>('choose-folder');
const modelInput = byId<HTMLInputElement>('model');
const promptInput = byId<HTMLTextAreaElement>('prompt');
const micStatus = byId<HTMLParagraphElement>('mic-status');
const savedText = byId<HTMLSpanElement>('saved');

byId<HTMLSpanElement>('extension-id').textContent = chrome.runtime.id;

let helperReachable = false;

function helperIssues(status: HelperStatus): string[] {
  const issues: string[] = [];
  if (!status.claude) issues.push('Claude Code (claude) was not found.');
  if (!status.whisper) issues.push('whisper-cli was not found.');
  if (!status.model) issues.push('The Whisper speech model is missing.');
  return issues;
}

async function showHelper(): Promise<void> {
  checkHelperButton.disabled = true;
  helperStatus.textContent = 'Checking the helper...';
  helperStatus.classList.remove('ready');
  helperProblems.hidden = true;
  helperSetup.hidden = true;
  try {
    const status = await callHelper<HelperStatus>({ type: 'status', details: true });
    const issues = helperIssues(status);
    if (issues.length === 0) {
      const claudeVersion = status.claudeVersion?.replace(/\s*\(Claude Code\)$/, '') ?? '';
      helperStatus.textContent = `Ready: Whisper ${status.modelName ?? ''} writes the transcript, Claude Code ${claudeVersion} writes the notes.`;
      helperStatus.classList.add('ready');
    } else {
      helperStatus.textContent = 'The helper is installed, but it is not complete:';
      helperProblems.replaceChildren(...issues.map((issue) => Object.assign(document.createElement('li'), { textContent: issue })));
      helperProblems.hidden = false;
      helperSetup.hidden = false;
    }
    helperReachable = true;
  } catch (error) {
    helperStatus.textContent = describeError(error);
    helperSetup.hidden = false;
    helperReachable = false;
  } finally {
    checkHelperButton.disabled = false;
    chooseFolderButton.disabled = !helperReachable;
  }
}

async function chooseFolder(): Promise<void> {
  chooseFolderButton.disabled = true;
  try {
    const { path } = await callHelper<{ path: string | null }>({
      type: 'choose-folder',
      current: saveDirectoryInput.value.trim() || undefined,
    });
    if (path) saveDirectoryInput.value = path;
  } catch (error) {
    showSaved(describeError(error), true);
  } finally {
    chooseFolderButton.disabled = !helperReachable;
  }
}

async function showMic(): Promise<void> {
  micStatus.textContent = MIC_MESSAGES[await readMicAccess()];
}

async function allowMic(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch (error) {
    micStatus.textContent = `Microphone was not allowed: ${describeError(error)}`;
    return;
  }
  await showMic();
}

let savedTimer: ReturnType<typeof setTimeout> | undefined;

function showSaved(message: string, isError = false): void {
  clearTimeout(savedTimer);
  savedText.textContent = message;
  savedText.classList.toggle('error', isError);
  if (!isError) {
    savedTimer = setTimeout(() => {
      savedText.textContent = '';
    }, SAVED_MESSAGE_MS);
  }
}

async function checkedDirectory(): Promise<string> {
  const typed = saveDirectoryInput.value.trim();
  if (!typed) return '';
  try {
    return (await callHelper<{ path: string }>({ type: 'check-folder', path: typed })).path;
  } catch (error) {
    throw new Error(`Save folder: ${describeError(error)}`);
  }
}

async function save(): Promise<void> {
  let saveDirectory: string;
  try {
    saveDirectory = await checkedDirectory();
  } catch (error) {
    showSaved(describeError(error), true);
    return;
  }
  saveDirectoryInput.value = saveDirectory;
  await saveSettings({
    saveDirectory,
    model: modelInput.value.trim() || DEFAULT_MODEL,
    prompt: promptInput.value.trim() || DEFAULT_PROMPT,
  });
  showSaved('Saved.');
}

async function load(): Promise<void> {
  const settings = await getSettings();
  saveDirectoryInput.value = settings.saveDirectory;
  modelInput.value = settings.model;
  promptInput.value = settings.prompt;
  await Promise.all([showMic(), showHelper()]);
}

checkHelperButton.addEventListener('click', () => void showHelper());
chooseFolderButton.addEventListener('click', () => void chooseFolder());
byId('allow-mic').addEventListener('click', () => void allowMic());
byId('save').addEventListener('click', () => void save());
byId('reset-prompt').addEventListener('click', () => {
  promptInput.value = DEFAULT_PROMPT;
});
void load();
