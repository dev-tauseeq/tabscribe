const BLOCK_FRAMES = 4608;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK_FRAMES);
    this.filled = 0;
    this.finished = false;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'finish' && !this.finished) {
        this.post(this.block.slice(0, this.filled));
        this.filled = 0;
        // process() returns false from now on. Chrome only frees a node whose processor has
        // stopped, and a node that is never freed keeps its whole AudioContext in memory.
        this.finished = true;
        this.port.postMessage({ type: 'finished' });
      }
    };
  }

  post(samples) {
    if (samples.length === 0) return;
    this.port.postMessage({ type: 'pcm', samples }, [samples.buffer]);
  }

  process(inputs) {
    if (this.finished) return false;
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, BLOCK_FRAMES - this.filled);
      this.block.set(channel.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === BLOCK_FRAMES) {
        this.post(this.block.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
