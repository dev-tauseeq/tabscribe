import { describeError } from '../lib/errors';
import {
  AUDIO_FILE,
  METADATA_FILE,
  ORIGINAL_TRANSCRIPT_FILE,
  SUMMARY_FILE,
  SUMMARY_PDF_FILE,
  TRANSCRIPT_FILE,
  WHISPER_FILE,
} from '../lib/files';
import { readStagedFile, readStagedText, writeStaged } from '../lib/opfs';
import { buildSummaryHtml } from '../lib/summary-document';
import {
  buildTranscriptMarkdown,
  isEnglish,
  languageName,
  NO_SPEECH_LINE,
  NO_SPEECH_SUMMARY,
  transcriptLines,
} from '../lib/transcript-format';
import type { FailedStep, MeetingRecord, PipelineSettings, TranscriptResult } from '../types';
import { fileExists, renderPdf, summarize, transcribeAudio, translateLines, type TranslationStore } from './helper-calls';
import { saveMeetingFiles } from './save';

export type Report = (patch: Partial<MeetingRecord>) => Promise<void>;

async function readWhisper(id: string): Promise<TranscriptResult | undefined> {
  const text = await readStagedText(id, WHISPER_FILE);
  return text === undefined ? undefined : (JSON.parse(text) as TranscriptResult);
}

function metadataJson(meeting: MeetingRecord, model: string, whisper: TranscriptResult | undefined): string {
  const seconds = meeting.endedAt ? Math.round((meeting.endedAt - meeting.startedAt) / 1000) : null;
  const translated = Boolean(whisper && whisper.segments.length > 0 && !isEnglish(whisper.language));
  const metadata = {
    title: meeting.title,
    url: meeting.url,
    startedAt: new Date(meeting.startedAt).toISOString(),
    endedAt: meeting.endedAt ? new Date(meeting.endedAt).toISOString() : null,
    durationSeconds: seconds,
    transcribed: meeting.transcribe,
    language: whisper?.language || null,
    translatedToEnglish: translated,
    transcriptionModel: whisper ? `whisper.cpp ${whisper.model}`.trim() : null,
    summaryModel: meeting.transcribe ? model : null,
    warning: meeting.warning ?? null,
    files: meeting.transcribe
      ? {
          audio: AUDIO_FILE,
          transcript: TRANSCRIPT_FILE,
          ...(translated ? { originalTranscript: ORIGINAL_TRANSCRIPT_FILE } : {}),
          summary: SUMMARY_PDF_FILE,
          summaryMarkdown: SUMMARY_FILE,
        }
      : { audio: AUDIO_FILE },
  };
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

function spokenLanguage(whisper: TranscriptResult | undefined): string | undefined {
  if (!whisper?.language) return undefined;
  const language = languageName(whisper.language);
  return isEnglish(whisper.language) ? `Spoken in ${language}` : `Spoken in ${language}, translated into English`;
}

// Whisper reads the recording from disk, so it has to be saved before it can be transcribed.
// If the saved file was moved or deleted since, the private copy is saved again.
async function savedAudioPath(meeting: MeetingRecord, update: Report): Promise<string> {
  if (meeting.audioPath && (await fileExists(meeting.id, meeting.audioPath))) return meeting.audioPath;
  const savedFiles = (meeting.savedFiles ?? []).filter((name) => name !== AUDIO_FILE);
  const saved = await saveMeetingFiles({ ...meeting, savedFiles, audioPath: '' }, false);
  await update({ savedFiles, audioPath: '', ...saved });
  if (saved.audioPath) return saved.audioPath;
  throw new Error(saved.exportNote || 'The recording could not be saved, so it cannot be transcribed.');
}

function translationStore(id: string): TranslationStore {
  return {
    async load(part) {
      const text = await readStagedText(id, `translation-${part}.json`);
      return text === undefined ? undefined : (JSON.parse(text) as string[]);
    },
    save: (part, lines) => writeStaged(id, `translation-${part}.json`, JSON.stringify(lines)),
  };
}

async function runWhisper(meeting: MeetingRecord, update: Report): Promise<TranscriptResult> {
  const staged = await readWhisper(meeting.id);
  if (staged) return staged;
  await update({ status: 'transcribing' });
  const result = await transcribeAudio(meeting.id, await savedAudioPath(meeting, update));
  await writeStaged(meeting.id, WHISPER_FILE, JSON.stringify(result));
  return result;
}

export async function runPipeline(initial: MeetingRecord, settings: PipelineSettings, report: Report): Promise<void> {
  let meeting = initial;
  let step: FailedStep = 'transcribe';
  const update: Report = async (patch) => {
    meeting = { ...meeting, ...patch };
    await report(patch);
  };

  try {
    if (meeting.transcribe) {
      let transcript = await readStagedText(meeting.id, TRANSCRIPT_FILE);
      if (transcript === undefined) {
        const whisper = await runWhisper(meeting, update);
        const lines = transcriptLines(whisper);
        const language = languageName(whisper.language);
        if (lines.length === 0 || isEnglish(whisper.language)) {
          transcript = buildTranscriptMarkdown(meeting, lines, whisper.language ? `Spoken language: ${language}.` : '');
        } else {
          const original = `Spoken language: ${language}. This is the original transcript. ${TRANSCRIPT_FILE} has the English translation.`;
          await writeStaged(meeting.id, ORIGINAL_TRANSCRIPT_FILE, buildTranscriptMarkdown(meeting, lines, original));
          step = 'translate';
          await update({ status: 'translating' });
          const english = await translateLines(meeting.id, settings, language, lines, translationStore(meeting.id));
          transcript = buildTranscriptMarkdown(meeting, english, `Spoken language: ${language}. Translated into English by Claude.`);
        }
        await writeStaged(meeting.id, TRANSCRIPT_FILE, transcript);
      }

      step = 'summarize';
      let summary = await readStagedText(meeting.id, SUMMARY_FILE);
      if (summary === undefined) {
        await update({ status: 'summarizing' });
        summary = transcript.includes(NO_SPEECH_LINE) ? NO_SPEECH_SUMMARY : await summarize(meeting.id, settings, transcript);
        await writeStaged(meeting.id, SUMMARY_FILE, `${summary.trim()}\n`);
      }
      if ((await readStagedFile(meeting.id, SUMMARY_PDF_FILE)) === undefined) {
        await update({ status: 'summarizing' });
        const html = buildSummaryHtml(meeting, summary, {
          language: spokenLanguage(await readWhisper(meeting.id)),
          model: settings.model,
        });
        await writeStaged(meeting.id, SUMMARY_PDF_FILE, await renderPdf(meeting.id, html));
      }
    }

    await writeStaged(meeting.id, METADATA_FILE, metadataJson(meeting, settings.model, await readWhisper(meeting.id)));
    await update({ status: 'saving' });
    await update({ status: 'done', ...(await saveMeetingFiles(meeting, true)) });
  } catch (error) {
    const failure: Partial<MeetingRecord> = { status: 'error', failedStep: step, error: describeError(error) };
    await update({ ...failure, ...(await saveMeetingFiles(meeting, false)) });
  }
}
