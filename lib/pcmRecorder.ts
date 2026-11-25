export interface PcmRecorder {
  /** Loudness right now, 0 to 1 (for the level meter). */
  level(): number;
  /** Seconds recorded so far. */
  elapsed(): number;
  /** Stop and hand back everything heard. */
  stop(): Promise<{ samples: Float32Array; rate: number }>;
  /** Give the microphone back without keeping anything. */
  cancel(): void;
}

export const MAX_RECORD_S = 30;

/** Open the microphone (no echo cancelling or levelling: they squash drums) and record raw samples. Throws like getUserMedia. */
export async function startPcmRecorder(ctx: AudioContext, onFull?: () => void): Promise<PcmRecorder> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md?.getUserMedia) throw Object.assign(new Error('unsupported'), { name: 'unsupported' });
  const stream = await md.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const sink = ctx.createGain();
  sink.gain.value = 0; // keeps the recorder running without sending the microphone to the speakers
  sink.connect(ctx.destination);
  const chunks: Float32Array[] = [];
  let frames = 0;
  const limit = Math.round(MAX_RECORD_S * ctx.sampleRate);
  let full = false;
  const push = (c: Float32Array) => {
    if (frames >= limit) { if (!full) { full = true; onFull?.(); } return; }
    chunks.push(c); frames += c.length;
  };
  let node: AudioNode;
  if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      await ctx.audioWorklet.addModule('/pcm-recorder-worklet.js');
      const w = new AudioWorkletNode(ctx, 'pcm-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      w.port.onmessage = (e) => push(e.data as Float32Array);
      node = w;
    } catch { node = scriptNode(ctx, push); }
  } else node = scriptNode(ctx, push);
  source.connect(node);
  node.connect(sink);
  const buf = new Float32Array(1024);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { source.disconnect(); node.disconnect(); sink.disconnect(); } catch { /* ignore */ }
    if ('port' in node) { const port = (node as AudioWorkletNode).port; port.onmessage = null; try { port.postMessage('stop'); port.close(); } catch { /* ignore */ } }
    else (node as ScriptProcessorNode).onaudioprocess = null;
    chunks.length = 0;
    for (const t of stream.getTracks()) t.stop();
  };
  return {
    level() {
      analyser.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      return Math.min(1, Math.sqrt(Math.sqrt(s / buf.length)) * 1.2);
    },
    elapsed: () => frames / ctx.sampleRate,
    async stop() {
      await new Promise((r) => setTimeout(r, 60)); // let the last blocks arrive
      const samples = new Float32Array(frames);
      let o = 0;
      for (const c of chunks) { samples.set(c, o); o += c.length; }
      close();
      return { samples, rate: ctx.sampleRate };
    },
    cancel: close,
  };
}

function scriptNode(ctx: AudioContext, push: (c: Float32Array) => void): AudioNode {
  const sp = ctx.createScriptProcessor(4096, 1, 1);
  sp.onaudioprocess = (e) => push(new Float32Array(e.inputBuffer.getChannelData(0)));
  return sp;
}
