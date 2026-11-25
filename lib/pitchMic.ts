import { PitchDetector } from 'pitchy';
import { NoiseGate, freqToMidi, resolveOctave, windowFor } from './pitch';

export interface MicReading { midi: number; clarity: number; rms: number }

export interface Mic {
  stream: MediaStream;
  /**
   * Latest pitch heard, or null for silence, room noise or no clear pitch. `expectedHz` is the note the part has
   * at this moment, when there is one: it settles whether a low note was heard in the right octave.
   */
  read(expectedHz?: number | null): MicReading | null;
  /** Seconds between a sound reaching the microphone and `read()` seeing it (device + half the analysis window). */
  latencyS: number;
  /** Seconds of sound that are analysed at a time. */
  windowS: number;
  /** Tell the microphone the lowest note it will have to follow (Hz): low notes need a longer listen, high ones a shorter one. */
  setLowest(hz: number): void;
  stop(): void;
}

const MIN_HZ = 28;
const MAX_HZ = 2100;
const DEFAULT_LOW_HZ = 82; // E2: right for trombone and baritone until the part says otherwise

/** Open the microphone for pitch reading (no echo cancelling or levelling: they bend the pitch). Throws a DOMException-like error. */
export async function openMic(ctx: AudioContext): Promise<Mic> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md?.getUserMedia) throw Object.assign(new Error('unsupported'), { name: 'unsupported' });
  const stream = await md.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  source.connect(analyser); // not to the speakers: that would feed back
  const track = stream.getAudioTracks()[0];
  const reported = Number((track?.getSettings() as { latency?: number } | undefined)?.latency);
  const deviceLatency = Number.isFinite(reported) && reported > 0 ? reported : 0.03;
  const gate = new NoiseGate();
  let size = 0;
  let detector = PitchDetector.forFloat32Array(2048);
  let buf = new Float32Array(2048);
  const mic: Mic = {
    stream,
    latencyS: 0,
    windowS: 0,
    setLowest(hz: number) {
      const n = windowFor(hz > 0 ? hz : DEFAULT_LOW_HZ, ctx.sampleRate);
      if (n === size) return;
      size = n;
      analyser.fftSize = n;
      detector = PitchDetector.forFloat32Array(n);
      buf = new Float32Array(n);
      mic.windowS = n / ctx.sampleRate;
      mic.latencyS = deviceLatency + n / ctx.sampleRate / 2;
    },
    read(expectedHz) {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < size; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / size);
      if (rms < 0.002) { gate.pass(rms, 0); return null; } // silence: nothing to measure
      const [found, clarity] = detector.findPitch(buf, ctx.sampleRate);
      if (!gate.pass(rms, Number.isFinite(clarity) ? clarity : 0)) return null;
      if (!Number.isFinite(found) || found < MIN_HZ || found > MAX_HZ) return null;
      const hz = expectedHz && clarity >= 0.6 ? resolveOctave(buf, ctx.sampleRate, found, expectedHz) : found;
      return { midi: freqToMidi(hz), clarity, rms };
    },
    stop() {
      try { source.disconnect(); } catch { /* ignore */ }
      for (const t of stream.getTracks()) t.stop();
    },
  };
  mic.setLowest(DEFAULT_LOW_HZ);
  return mic;
}

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
/** Note name without the cents ("Bb4"). */
export function noteName(midi: number): string {
  const r = Math.round(midi);
  return `${NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
}
/** "Bb4 +12" for a fractional MIDI number. */
export function noteLabel(midi: number): string {
  const r = Math.round(midi);
  const cents = Math.round((midi - r) * 100);
  return `${NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1} ${cents >= 0 ? '+' : ''}${cents}`;
}
