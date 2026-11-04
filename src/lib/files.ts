import { isNotFound } from './errors';

export const AUDIO_FILE = 'recording.mp3';
export const TRANSCRIPT_FILE = 'transcript.md';
export const ORIGINAL_TRANSCRIPT_FILE = 'transcript-original.md';
export const SUMMARY_FILE = 'summary.md';
export const SUMMARY_PDF_FILE = 'summary.pdf';
export const METADATA_FILE = 'meeting.json';
export const OUTPUT_FILES = [
  AUDIO_FILE,
  TRANSCRIPT_FILE,
  ORIGINAL_TRANSCRIPT_FILE,
  SUMMARY_PDF_FILE,
  SUMMARY_FILE,
  METADATA_FILE,
];

// Kept in the extension's private storage only, so Retry can skip Whisper.
export const WHISPER_FILE = 'whisper.json';

export async function fileIfExists(dir: FileSystemDirectoryHandle, name: string): Promise<File | undefined> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function writeFile(handle: FileSystemFileHandle, data: Blob | string): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}
