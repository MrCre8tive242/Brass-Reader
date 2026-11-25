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

/** One instrument's sound on `ctx` (live or offline), played into `dest`; falls back to a synth if the samples cannot be loaded. */
export async function createVoice(ctx: BaseAudioContext, dest: AudioNode, id: InstrumentId): Promise<{ voice: Voice; engine: 'soundfont' | 'synth' }> {
  try {
    const { Soundfont, CacheStorage } = await import('smplr');
    // keep downloaded samples in the browser cache: rehearsal rooms often have no signal
    let storage: InstanceType<typeof CacheStorage> | undefined;
    try { storage = new CacheStorage('brass-reader-sounds'); } catch { storage = undefined; }
    const inst = Soundfont(ctx as AudioContext, { instrument: INSTRUMENTS[id].sample, kit: 'MusyngKite', destination: dest, ...(storage ? { storage } : {}) });
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
