import type { HelperRequest } from '../types';

// Keep in sync with HELPER_NAME in native-host/paths.mjs.
export const HELPER_NAME = 'com.meetingrecorder.helper';

export const SETUP_COMMAND = 'npm run setup';

type HelperMessage =
  | { id: number; type: 'progress'; message: string }
  | { id: number; type: 'part'; text: string }
  | { id: number; type: 'end' }
  | { id: number; type: 'reply'; body: HelperBody };

type HelperBody = { ok: true } | { ok: false; error: string };

interface Pending {
  parts: string[];
  onProgress?: (message: string) => void;
  resolve: (body: HelperBody) => void;
  reject: (error: Error) => void;
}

export interface HelperSession {
  call<T>(request: HelperRequest, onProgress?: (message: string) => void): Promise<T>;
  close(): void;
}

// Each piece is turned into a base64 string, so smaller pieces keep the worker's memory low.
const WRITE_CHUNK_BYTES = 2 * 1024 * 1024;

function disconnectReason(message: string | undefined): string {
  if (/not found/i.test(message ?? '')) {
    return `The Claude Code helper is not installed. Run ${SETUP_COMMAND} in the meeting-recorder folder, then reload the extension.`;
  }
  if (/forbidden/i.test(message ?? '')) {
    return `The helper is set up for a different extension ID. Run ${SETUP_COMMAND} again.`;
  }
  return `The Claude Code helper stopped unexpectedly${message ? ` (${message})` : ''}.`;
}

export function openHelper(): HelperSession {
  const port = chrome.runtime.connectNative(HELPER_NAME);
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed: Error | undefined;

  port.onMessage.addListener((message: HelperMessage) => {
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.type === 'progress') {
      entry.onProgress?.(message.message);
    } else if (message.type === 'part') {
      entry.parts.push(message.text);
    } else {
      pending.delete(message.id);
      try {
        entry.resolve(message.type === 'reply' ? message.body : (JSON.parse(entry.parts.join('')) as HelperBody));
      } catch (error) {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  port.onDisconnect.addListener(() => {
    closed = new Error(disconnectReason(chrome.runtime.lastError?.message));
    pending.forEach((entry) => entry.reject(closed as Error));
    pending.clear();
  });

  return {
    async call<T>(request: HelperRequest, onProgress?: (message: string) => void): Promise<T> {
      if (closed) throw closed;
      const id = nextId;
      nextId += 1;
      const body = await new Promise<HelperBody>((resolve, reject) => {
        pending.set(id, { parts: [], onProgress, resolve, reject });
        port.postMessage({ id, ...request });
      });
      if (!body.ok) throw new Error(body.error);
      return body as T;
    },
    close(): void {
      if (!closed) port.disconnect();
    },
  };
}

export async function callHelper<T>(request: HelperRequest, onProgress?: (message: string) => void): Promise<T> {
  const helper = openHelper();
  try {
    return await helper.call<T>(request, onProgress);
  } finally {
    helper.close();
  }
}

function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export async function writeWithHelper(
  helper: HelperSession,
  target: { dir: string; folder: string; name: string },
  file: Blob,
): Promise<string> {
  let path = '';
  let offset = 0;
  do {
    const bytes = new Uint8Array(await file.slice(offset, offset + WRITE_CHUNK_BYTES).arrayBuffer());
    const last = offset + WRITE_CHUNK_BYTES >= file.size;
    ({ path } = await helper.call<{ path: string }>({
      type: 'write-file',
      ...target,
      data: toBase64(bytes),
      first: offset === 0,
      last,
    }));
    offset += WRITE_CHUNK_BYTES;
  } while (offset < file.size);
  return path;
}
