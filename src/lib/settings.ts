import type { Settings } from '../types';

export const SETTINGS_KEY = 'settings';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export const DEFAULT_SAVE_FOLDER = 'Audio Recordings';

export const DEFAULT_PROMPT = `You write meeting notes in English from a timestamped transcript.

Use these Markdown sections:

## Summary
A short paragraph on what the meeting was about and what came out of it.

## Key points
Bullets, most important first.

## Decisions
Bullets. Write "None" if nothing was decided.

## Action items
A checklist in the form "- [ ] Owner: task (due date if mentioned)". Use "Unassigned" when no owner is clear. Write "None" if there are none.

## Open questions
Bullets. Write "None" if there are none.

The transcript has no speaker labels, so name a person only when the transcript makes clear who they are. Only state what is in the transcript.`;

// The default before the switch to Claude Code. People who saved it unchanged get the new default.
const PREVIOUS_DEFAULT_PROMPT = `You write meeting notes from a speaker-labeled transcript.

Use these Markdown sections:

## Overview
Two or three sentences on what the meeting was about.

## Key points
Bullets, most important first.

## Decisions
Bullets. Write "None" if nothing was decided.

## Action items
Bullets in the form "Owner: task (due date if mentioned)". Write "None" if there are none.

## Open questions
Bullets. Write "None" if there are none.

Speakers are labeled Speaker A, Speaker B and so on. Use a real name when someone says it out loud. Only state what is in the transcript. Write in the language of the meeting.`;

const DEFAULTS: Settings = {
  transcribe: true,
  saveDirectory: '',
  model: DEFAULT_MODEL,
  prompt: DEFAULT_PROMPT,
};

function pickSettings(stored: Partial<Settings> | undefined): Settings {
  const settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (stored?.[key] !== undefined) Object.assign(settings, { [key]: stored[key] });
  }
  if (settings.prompt === PREVIOUS_DEFAULT_PROMPT) settings.prompt = DEFAULT_PROMPT;
  return settings;
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return pickSettings(stored[SETTINGS_KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await getSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...patch } });
}

export function saveLocation(settings: Pick<Settings, 'saveDirectory'>): string {
  return settings.saveDirectory || `Downloads/${DEFAULT_SAVE_FOLDER}`;
}
