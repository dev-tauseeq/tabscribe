import type { MeetingRecord, TranscriptResult } from '../types';
import { displayStamp, formatClock } from './stamp';

export const NO_SPEECH_LINE = 'No speech was detected in this recording.';

export const NO_SPEECH_SUMMARY = 'No speech was detected, so there is nothing to summarize.';

const PARAGRAPH_PAUSE_MS = 2000;
const PARAGRAPH_SOFT_LIMIT_MS = 30_000;
const PARAGRAPH_HARD_LIMIT_MS = 60_000;
const SENTENCE_END = /[.!?。！？]["')\]]*$/;

export type Timing = Pick<MeetingRecord, 'title' | 'startedAt' | 'endedAt'>;

export function recordedLine(meeting: Timing): string {
  const started = `Recorded ${displayStamp(new Date(meeting.startedAt))}`;
  return meeting.endedAt ? `${started}, length ${formatClock(meeting.endedAt - meeting.startedAt)}` : started;
}

export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export const isEnglish = (code: string): boolean => code === '' || code === 'en';

// Whisper returns short pieces of a few seconds. Join them into paragraphs that start
// with a timestamp and break at pauses or, for long stretches, at the end of a sentence.
export function transcriptLines(result: TranscriptResult): string[] {
  const lines: string[] = [];
  let texts: string[] = [];
  let start = 0;
  let end = 0;
  for (const segment of result.segments) {
    const length = end - start;
    const breakHere =
      segment.start - end >= PARAGRAPH_PAUSE_MS ||
      length >= PARAGRAPH_HARD_LIMIT_MS ||
      (length >= PARAGRAPH_SOFT_LIMIT_MS && SENTENCE_END.test(texts.at(-1) ?? ''));
    if (texts.length > 0 && breakHere) {
      lines.push(`[${formatClock(start)}] ${texts.join(' ')}`);
      texts = [];
    }
    if (texts.length === 0) start = segment.start;
    texts.push(segment.text);
    end = segment.end;
  }
  if (texts.length > 0) lines.push(`[${formatClock(start)}] ${texts.join(' ')}`);
  return lines;
}

export function buildTranscriptMarkdown(meeting: Timing, lines: string[], note: string): string {
  const header = [`# ${meeting.title}`, recordedLine(meeting), note].filter(Boolean).join('\n\n');
  const body = lines.length > 0 ? lines.join('\n\n') : NO_SPEECH_LINE;
  return `${header}\n\n## Transcript\n\n${body}\n`;
}
