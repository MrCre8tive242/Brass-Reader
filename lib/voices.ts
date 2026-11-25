import { INSTRUMENTS, type InstrumentId } from './instruments';

export interface Voice {
  start(note: { note: number; time: number; duration: number; velocity: number }): void;
  stop(): void;
}

/** Small oscillator synth used when the sample soundfont cannot be loaded. */
export class SynthVoice implements Voice {
  private active = new Set<{ osc: OscillatorNode; gain: GainNode }>();
  constructor(private ctx: BaseAudioContext, private out: AudioNode) {}
  start({ note, time, duration, velocity }: { note: number; time: number; duration: number; velocity: number }) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = 440 * Math.pow(2, (note - 69) / 12);
    filter.type = 'lowpass';
    filter.frequency.value = 1800;
    const peak = 0.18 * velocity;
    const end = time + Math.max(0.05, duration);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.03);
    gain.gain.setValueAtTime(peak * 0.8, Math.max(time + 0.03, end - 0.05));
    gain.gain.linearRampToValueAtTime(0, end + 0.06);
    osc.connect(filter); filter.connect(gain); gain.connect(this.out);
    osc.start(time);
    osc.stop(end + 0.08);
    const h = { osc, gain };
    this.active.add(h);
    osc.onended = () => { this.active.delete(h); try { gain.disconnect(); } catch { /* ignore */ } };
  }
  stop() {
    for (const h of this.active) {
      try {
        h.gain.gain.cancelScheduledValues(0);
        h.gain.gain.setValueAtTime(0, this.ctx.currentTime);
        h.osc.stop(this.ctx.currentTime + 0.01);
      } catch { /* ignore */ }
    }
    this.active.clear();
  }
}

const LOAD_TIMEOUT_MS = 12000;

/** Decoded samples and downloaded sample files, kept between the pieces of an offline render (see `lib/videoAudio.ts`). */
export interface VoiceCache {
  decoded: Map<string, Promise<AudioBuffer>>;
  files: Map<string, Promise<string>>;
}
export const newVoiceCache = (): VoiceCache => ({ decoded: new Map(), files: new Map() });

export interface VoiceOptions {
  /**
   * The sound is rendered ahead of time (an OfflineAudioContext), not played live: every note is handed to the audio
   * engine the moment it is scheduled. (The sample player otherwise keeps notes that lie further ahead than 0.2 s in a
   * queue it works through by the clock on the wall, which an offline render does not wait for: they would be lost.)
   */
  offline?: boolean;
  /** Only load the samples these notes (MIDI numbers) need. */
  notes?: number[];
  /** Reuse samples already decoded for another context with the same sample rate. */
  cache?: VoiceCache;
}

function keyOf(data: ArrayBuffer): string {
  const b = new Uint8Array(data);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
  return `${b.length}:${h >>> 0}`;
}

/** Make `ctx.decodeAudioData` remember what it decoded, across contexts that share `cache`. */
function rememberDecodes(ctx: BaseAudioContext, cache: VoiceCache) {
  const orig = ctx.decodeAudioData.bind(ctx) as (d: ArrayBuffer) => Promise<AudioBuffer>;
  (ctx as unknown as { decodeAudioData: (d: ArrayBuffer) => Promise<AudioBuffer> }).decodeAudioData = (data: ArrayBuffer) => {
    const key = `${ctx.sampleRate}:${keyOf(data)}`;
    let p = cache.decoded.get(key);
    if (!p) {
      p = orig(data);
      cache.decoded.set(key, p);
      p.catch(() => cache.decoded.delete(key));
    }
    return p;
  };
}

/** One instrument's sound on `ctx` (live or offline), played into `dest`; falls back to a synth if the samples cannot be loaded. */
export async function createVoice(ctx: BaseAudioContext, dest: AudioNode, id: InstrumentId, o: VoiceOptions = {}): Promise<{ voice: Voice; engine: 'soundfont' | 'synth' }> {
  try {
    const { Soundfont, CacheStorage } = await import('smplr');
    // keep downloaded samples in the browser cache: rehearsal rooms often have no signal
    let storage: { fetch: (url: string) => Promise<{ status: number; text(): Promise<string>; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }> } | undefined;
    try { storage = new CacheStorage('brass-reader-sounds'); } catch { storage = undefined; }
    const cache = o.cache;
    if (cache) {
      rememberDecodes(ctx, cache);
      // the sample file is read once, not once per piece of the render
      const inner = storage ?? { fetch: (url: string) => fetch(url) };
      storage = {
        fetch: async (url: string) => {
          let text = cache.files.get(url);
          if (!text) {
            text = inner.fetch(url).then((r) => { if (r.status >= 400) throw new Error(`sound file ${r.status}`); return r.text(); });
            cache.files.set(url, text);
            text.catch(() => cache.files.delete(url));
          }
          const t = await text;
          return { status: 200, text: async () => t, json: async () => JSON.parse(t), arrayBuffer: async () => new TextEncoder().encode(t).buffer as ArrayBuffer };
        },
      };
    }
    const now = { schedule: (event: unknown, cb: (e: unknown) => void) => { cb(event); return () => {}; }, stop: () => {} };
    const inst = Soundfont(ctx as AudioContext, {
      instrument: INSTRUMENTS[id].sample, kit: 'MusyngKite', destination: dest,
      ...(storage ? { storage } : {}),
      ...(o.offline ? { scheduler: now as never } : {}),
      ...(o.notes ? { notesToLoad: { notes: o.notes } } : {}),
    });
    await Promise.race([
      inst.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error('soundfont load timeout')), LOAD_TIMEOUT_MS)),
    ]);
    return {
      voice: {
        start: ({ note, time, duration, velocity }) => { inst.start({ note, time, duration, velocity: Math.round(velocity * 127) }); },
        stop: () => inst.stop(),
      },
      engine: 'soundfont',
    };
  } catch {
    return { voice: new SynthVoice(ctx, dest), engine: 'synth' };
  }
}
