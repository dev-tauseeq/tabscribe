export interface ByteWriter {
  write(data: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface Mp3Sink {
  push(bytes: Uint8Array): void;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface SinkOptions {
  flushBytes?: number;
  onFailure?: () => void;
}

const FLUSH_BYTES = 64 * 1024;

export function createPcmConverter(): (samples: Float32Array) => Int16Array {
  let scratch = new Int16Array(0);
  return (samples) => {
    if (scratch.length < samples.length) scratch = new Int16Array(samples.length);
    const pcm = scratch.subarray(0, samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const value = Math.max(-1, Math.min(1, samples[index]));
      pcm[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
    return pcm;
  };
}

export function createMp3Sink(output: ByteWriter, { flushBytes = FLUSH_BYTES, onFailure }: SinkOptions = {}): Mp3Sink {
  const buffer = new Uint8Array(flushBytes);
  let filled = 0;
  let writes: Promise<void> = Promise.resolve();
  let failure: { error: unknown } | undefined;

  const flush = (): void => {
    if (filled === 0) return;
    const chunk = buffer.slice(0, filled);
    filled = 0;
    writes = writes
      .then(async () => {
        if (!failure) await output.write(chunk);
      })
      .catch((error: unknown) => {
        failure = { error };
        onFailure?.();
      });
  };

  return {
    push(bytes: Uint8Array): void {
      let offset = 0;
      while (offset < bytes.length) {
        const count = Math.min(bytes.length - offset, buffer.length - filled);
        buffer.set(bytes.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === buffer.length) flush();
      }
    },
    async close(): Promise<void> {
      flush();
      await writes;
      if (failure) {
        await output.abort().catch(() => undefined);
        throw failure.error;
      }
      await output.close();
    },
    async abort(): Promise<void> {
      filled = 0;
      await writes;
      await output.abort().catch(() => undefined);
    },
  };
}
