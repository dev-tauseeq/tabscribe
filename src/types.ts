export type MeetingStatus =
  | 'recording'
  | 'saving'
  | 'transcribing'
  | 'translating'
  | 'summarizing'
  | 'done'
  | 'error';

export type FailedStep = 'transcribe' | 'translate' | 'summarize';

export interface MeetingRecord {
  id: string;
  title: string;
  url: string;
  startedAt: number;
  endedAt?: number;
  transcribe: boolean;
  customFolderName?: string;
  folderName?: string;
  folderClaimed?: boolean;
  saveDirectory?: string;
  savedFiles?: string[];
  audioPath?: string;
  status: MeetingStatus;
  progress?: string;
  failedStep?: FailedStep;
  error?: string;
  warning?: string;
  exported: boolean;
  exportNote?: string;
}

export interface PipelineSettings {
  model: string;
  prompt: string;
}

export interface Settings extends PipelineSettings {
  transcribe: boolean;
  saveDirectory: string;
}

export type Reply = { ok: true; warning?: string } | { ok: false; error: string };

export interface DownloadFile {
  name: string;
  url: string;
}

export type SaveReply =
  | { ok: true; folderName: string; saveDirectory: string; saved: string[]; paths: Record<string, string> }
  | {
      ok: false;
      error: string;
      folderName?: string;
      saveDirectory?: string;
      saved: string[];
      paths: Record<string, string>;
    };

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  language: string;
  model: string;
  segments: Segment[];
}

export interface HelperStatus {
  version: number;
  ready: boolean;
  claude: string | null;
  claudeVersion?: string | null;
  whisper: string | null;
  model: string | null;
  modelName: string | null;
}

export type HelperRequest =
  | { type: 'status'; details?: boolean }
  | { type: 'choose-folder'; current?: string }
  | { type: 'check-folder'; path: string }
  | { type: 'claim-folder'; dir: string; name: string; claimed: boolean }
  | { type: 'write-file'; dir: string; folder: string; name: string; data: string; first: boolean; last: boolean }
  | { type: 'file-exists'; path: string }
  | { type: 'transcribe'; audioPath: string }
  | { type: 'claude'; model: string; system: string; prompt: string }
  | { type: 'pdf'; html: string };

export type HelperReply<T> = { ok: true; result: T } | { ok: false; error: string };

export type BackgroundMessage =
  | {
      target: 'background';
      type: 'start';
      tabId: number;
      title: string;
      url: string;
      includeMic: boolean;
      transcribe: boolean;
      folderName: string;
    }
  | { target: 'background'; type: 'stop' }
  | { target: 'background'; type: 'retry'; id: string }
  | { target: 'background'; type: 'save-again' }
  | { target: 'background'; type: 'discard'; id: string }
  | {
      target: 'background';
      type: 'save-files';
      meetingId: string;
      folderName: string;
      folderClaimed: boolean;
      saveDirectory?: string;
      files: DownloadFile[];
    }
  | { target: 'background'; type: 'helper'; meetingId: string; request: HelperRequest }
  | { target: 'background'; type: 'meeting-update'; id: string; patch: Partial<MeetingRecord> }
  | { target: 'background'; type: 'offscreen-idle' };

export type OffscreenMessage =
  | {
      target: 'offscreen';
      type: 'start';
      meeting: MeetingRecord;
      streamId: string;
      includeMic: boolean;
      settings: PipelineSettings;
    }
  | { target: 'offscreen'; type: 'stop' }
  | { target: 'offscreen'; type: 'retry'; meeting: MeetingRecord; settings: PipelineSettings }
  | { target: 'offscreen'; type: 'export'; meeting: MeetingRecord }
  | { target: 'offscreen'; type: 'status' };

export interface IdleReply {
  ok: true;
  idle: boolean;
}
