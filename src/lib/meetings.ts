import type { MeetingRecord } from '../types';

export const MEETINGS_KEY = 'meetings';

const KEEP_NEWEST = 15;

export async function listMeetings(): Promise<MeetingRecord[]> {
  const stored = await chrome.storage.local.get(MEETINGS_KEY);
  return (stored[MEETINGS_KEY] as MeetingRecord[] | undefined) ?? [];
}

export function isPendingExport(meeting: MeetingRecord): boolean {
  return (
    (meeting.status === 'done' || meeting.status === 'error') && !meeting.exported && Boolean(meeting.folderName)
  );
}

export function trimMeetings(meetings: MeetingRecord[]): { kept: MeetingRecord[]; dropped: MeetingRecord[] } {
  const sorted = [...meetings].sort((a, b) => b.startedAt - a.startedAt);
  const kept: MeetingRecord[] = [];
  const dropped: MeetingRecord[] = [];
  sorted.forEach((meeting, index) => {
    (index < KEEP_NEWEST || !meeting.exported ? kept : dropped).push(meeting);
  });
  return { kept, dropped };
}
