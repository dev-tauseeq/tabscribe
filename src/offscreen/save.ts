import { describeError } from '../lib/errors';
import { AUDIO_FILE, fileIfExists, OUTPUT_FILES } from '../lib/files';
import { sendToBackground } from '../lib/messaging';
import { findStaged, removeStaged } from '../lib/opfs';
import type { DownloadFile, MeetingRecord, SaveReply } from '../types';

export async function saveMeetingFiles(meeting: MeetingRecord, removeStagedAfter: boolean): Promise<Partial<MeetingRecord>> {
  if (!meeting.folderName) return { exported: true, exportNote: '' };
  const files: DownloadFile[] = [];
  try {
    const source = await findStaged(meeting.id);
    const alreadySaved = meeting.savedFiles ?? [];
    for (const name of OUTPUT_FILES) {
      const file = source && !alreadySaved.includes(name) ? await fileIfExists(source, name) : undefined;
      if (file) files.push({ name, url: URL.createObjectURL(file) });
    }
    if (files.length === 0) return { exported: true, exportNote: '' };

    const reply = await sendToBackground<SaveReply>({
      target: 'background',
      type: 'save-files',
      meetingId: meeting.id,
      folderName: meeting.folderName,
      folderClaimed: Boolean(meeting.folderClaimed),
      saveDirectory: meeting.saveDirectory,
      files,
    });
    if (!reply) return { exported: false, exportNote: 'The background worker did not answer.' };

    // A failed request can come back without the lists, so default them.
    const savedFiles = [...alreadySaved, ...(reply.saved ?? [])];
    const claim = reply.folderName
      ? { folderName: reply.folderName, folderClaimed: true, saveDirectory: reply.saveDirectory ?? '' }
      : {};
    const audioPath = reply.paths?.[AUDIO_FILE];
    const audio = audioPath ? { audioPath } : {};
    if (!reply.ok) return { exported: false, exportNote: reply.error, savedFiles, ...claim, ...audio };
    if (removeStagedAfter) await removeStaged(meeting.id);
    return { exported: true, exportNote: '', savedFiles, ...claim, ...audio };
  } catch (error) {
    return { exported: false, exportNote: describeError(error) };
  } finally {
    files.forEach(({ url }) => URL.revokeObjectURL(url));
  }
}
