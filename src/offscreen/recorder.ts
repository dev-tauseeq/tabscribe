import { Mp3Encoder } from '@breezystack/lamejs';
import { describeError } from '../lib/errors';
import { sleep } from '../lib/sleep';
import { createMp3Sink, createPcmConverter, type ByteWriter } from './encoding';

const RECORDING_SAMPLE_RATE = 24000;
const BITRATE_KBPS = 48;
const FIRST_AUDIO_TIMEOUT_MS = 5000;
const FINISH_TIMEOUT_MS = 2000;
const RELEASE_RENDER_SECONDS = 0.25;
const RELEASE_TIMEOUT_MS = 1000;

interface RecorderOptions {
  streamId: string;
  includeMic: boolean;
  output: ByteWriter;
  onInterrupted: () => void;
}

export interface Recorder {
  warning?: string;
  stop: () => Promise<void>;
}

type WorkletMessage = { type: 'pcm'; samples: Float32Array } | { type: 'finished' };

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Chrome frees an AudioWorkletNode, and the AudioContext it belongs to, only once the node's
// processor has stopped and the audio thread has seen the node disconnected. A context closed
// before that stays in memory until the recorder page closes, so it renders a little longer.
async function renderBriefly(context: AudioContext): Promise<void> {
  if (context.state !== 'running') return;
  const until = context.currentTime + RELEASE_RENDER_SECONDS;
  const deadline = Date.now() + RELEASE_TIMEOUT_MS;
  while (context.currentTime < until && Date.now() < deadline) await sleep(20);
}

function openTabStream(streamId: string): Promise<MediaStream> {
  const constraints = { audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } };
  return navigator.mediaDevices.getUserMedia(constraints as unknown as MediaStreamConstraints);
}

function openMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

export async function startRecorder({ streamId, includeMic, output, onInterrupted }: RecorderOptions): Promise<Recorder> {
  const sink = createMp3Sink(output, { onFailure: onInterrupted });
  const toPcm = createPcmConverter();
  const streams: MediaStream[] = [];
  const contexts: AudioContext[] = [];
  const nodes: AudioNode[] = [];
  let recording: AudioContext | undefined;
  let capture: AudioWorkletNode | undefined;
  let tabTrack: MediaStreamTrack | undefined;
  let warning: string | undefined;
  let resolveFirstAudio: () => void = () => undefined;
  let resolveFinished: () => void = () => undefined;
  const firstAudio = new Promise<void>((resolve) => {
    resolveFirstAudio = resolve;
  });

  const release = async (): Promise<void> => {
    tabTrack?.removeEventListener('ended', onInterrupted);
    if (capture) {
      capture.port.onmessage = null;
      capture.port.postMessage({ type: 'finish' });
    }
    nodes.forEach((node) => node.disconnect());
    streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    if (recording) await renderBriefly(recording);
    capture?.port.close();
    await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
  };

  try {
    const tabStream = await openTabStream(streamId);
    streams.push(tabStream);
    tabTrack = tabStream.getAudioTracks()[0];
    if (!tabTrack || tabTrack.readyState === 'ended') throw new Error('The meeting tab is no longer available.');
    tabTrack.addEventListener('ended', onInterrupted, { once: true });
    let micStream: MediaStream | undefined;
    if (includeMic) {
      try {
        micStream = await openMicStream();
        streams.push(micStream);
      } catch (error) {
        warning = `Your microphone is not in this recording (${describeError(error)}). Allow it on the settings page.`;
      }
    }

    const playback = new AudioContext();
    contexts.push(playback);
    const playbackSource = playback.createMediaStreamSource(tabStream);
    nodes.push(playbackSource);
    playbackSource.connect(playback.destination);

    const context = new AudioContext({ sampleRate: RECORDING_SAMPLE_RATE, latencyHint: 'playback' });
    recording = context;
    contexts.push(context);
    await context.audioWorklet.addModule(chrome.runtime.getURL('pcm-capture.worklet.js'));
    const encoder = new Mp3Encoder(1, context.sampleRate, BITRATE_KBPS);

    const node = new AudioWorkletNode(context, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    capture = node;
    node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      if (event.data.type === 'pcm') {
        sink.push(encoder.encodeBuffer(toPcm(event.data.samples)));
        resolveFirstAudio();
      } else {
        resolveFinished();
      }
    };

    const mixer = context.createGain();
    const tabSource = context.createMediaStreamSource(tabStream);
    const micSource = micStream ? context.createMediaStreamSource(micStream) : undefined;
    const silence = context.createGain();
    silence.gain.value = 0;
    nodes.push(tabSource, ...(micSource ? [micSource] : []), mixer, node, silence);
    tabSource.connect(mixer);
    micSource?.connect(mixer);
    mixer.connect(node);
    node.connect(silence);
    silence.connect(context.destination);

    void playback.resume();
    void context.resume();
    if ((await withTimeout(firstAudio, FIRST_AUDIO_TIMEOUT_MS)) === 'timeout') {
      throw new Error('No audio reached the recorder. Try starting the recording again.');
    }

    return {
      warning,
      async stop(): Promise<void> {
        const finished = new Promise<void>((resolve) => {
          resolveFinished = resolve;
        });
        node.port.postMessage({ type: 'finish' });
        await withTimeout(finished, FINISH_TIMEOUT_MS);
        sink.push(encoder.flush());
        await release();
        await sink.close();
      },
    };
  } catch (error) {
    await release();
    await sink.abort();
    throw error;
  }
}
