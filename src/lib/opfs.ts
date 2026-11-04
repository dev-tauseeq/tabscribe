import { isNotFound } from './errors';
import { fileIfExists, writeFile } from './files';

const ROOT_NAME = 'meetings';

async function meetingsRoot(create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ROOT_NAME, { create });
}

async function meetingDir(id: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await meetingsRoot(create);
  return root.getDirectoryHandle(id, { create });
}

async function stagedFileHandle(id: string, name: string): Promise<FileSystemFileHandle> {
  const dir = await meetingDir(id, true);
  return dir.getFileHandle(name, { create: true });
}

export async function findStaged(id: string): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await meetingDir(id, false);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export interface StagedWriter {
  write(data: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

// Chrome only stores what a writable wrote when it is closed. Closing and reopening it every
// `checkpointBytes` means a crash or a failed write loses only the last part of the file.
export async function openCheckpointedWriter(id: string, name: string, checkpointBytes: number): Promise<StagedWriter> {
  const handle = await stagedFileHandle(id, name);
  let writable = await handle.createWritable();
  let written = 0;
  let sinceCheckpoint = 0;
  return {
    async write(data) {
      await writable.write(data);
      written += data.byteLength;
      sinceCheckpoint += data.byteLength;
      if (sinceCheckpoint < checkpointBytes) return;
      sinceCheckpoint = 0;
      await writable.close();
      writable = await handle.createWritable({ keepExistingData: true });
      await writable.seek(written);
    },
    close: () => writable.close(),
    abort: () => writable.abort(),
  };
}

export async function writeStaged(id: string, name: string, data: Blob | string): Promise<void> {
  await writeFile(await stagedFileHandle(id, name), data);
}

export async function readStagedFile(id: string, name: string): Promise<File | undefined> {
  const dir = await findStaged(id);
  return dir ? fileIfExists(dir, name) : undefined;
}

export async function readStagedText(id: string, name: string): Promise<string | undefined> {
  const file = await readStagedFile(id, name);
  return file?.text();
}

export async function removeStaged(id: string): Promise<void> {
  try {
    const root = await meetingsRoot(false);
    await root.removeEntry(id, { recursive: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}
