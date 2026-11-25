import { PitchDetector } from 'pitchy';
import { freqToMidi } from './pitch';

export interface MicReading { midi: number; clarity: number; rms: number }

export interface Mic {
  stream: MediaStream;
  /** Latest pitch heard, or null for silence / no clear pitch. */
  read(): MicReading | null;
  /** Seconds between a sound reaching the microphone and `read()` seeing it (device + half the analysis window). */
  latencyS: number;
  stop(): void;
}

const FFT = 4096; // 85 ms at 48 kHz: long enough for a sousaphone's low E (41 Hz)
const MIN_HZ = 28;
const MAX_HZ = 2100;

/** Open the microphone for pitch reading (no echo cancelling or levelling: they bend the pitch). Throws a DOMException-like error. */
export async function openMic(ctx: AudioContext): Promise<Mic> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md?.getUserMedia) throw Object.assign(new Error('unsupported'), { name: 'unsupported' });
  const stream = await md.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = FFT;
  source.connect(analyser); // not to the speakers: that would feed back
  const detector = PitchDetector.forFloat32Array(FFT);
  const buf = new Float32Array(FFT);
  const track = stream.getAudioTracks()[0];
  const deviceLatency = Number((track?.getSettings() as { latency?: number } | undefined)?.latency);
  const latencyS = (Number.isFinite(deviceLatency) && deviceLatency > 0 ? deviceLatency : 0.03) + FFT / ctx.sampleRate / 2;
  return {
    stream,
    latencyS,
    read() {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < FFT; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / FFT);
      if (rms < 0.008) return null;
      const [hz, clarity] = detector.findPitch(buf, ctx.sampleRate);
      if (!Number.isFinite(hz) || hz < MIN_HZ || hz > MAX_HZ) return null;
      return { midi: freqToMidi(hz), clarity, rms };
    },
    stop() {
      try { source.disconnect(); } catch { /* ignore */ }
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
/** "Bb4 +12" for a fractional MIDI number. */
export function noteLabel(midi: number): string {
  const r = Math.round(midi);
  const cents = Math.round((midi - r) * 100);
  return `${NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1} ${cents >= 0 ? '+' : ''}${cents}`;
}
