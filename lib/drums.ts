import { playbackRateFor, type DrumHit, type Groove, type KitInst } from './groove';

/** Where the audio of a recorded groove comes from, and which groove the hits belong to. */
export interface DrumSource { groove: Groove; buffer: AudioBuffer | null }

export interface DrumLogEntry { t: number; q: number; inst?: string; slice?: number }

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function noise(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.1), ctx.sampleRate);
    const d = b.getChannelData(0);
    let seed = 987654321;
    for (let i = 0; i < d.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; d[i] = seed / 2147483648 - 1; }
    noiseCache.set(ctx, b);
  }
  return b;
}

type Track = (node: AudioScheduledSourceNode) => void;

function thump(ctx: BaseAudioContext, out: AudioNode, t: number, vel: number, f0: number, f1: number, decay: number, slap: number, track: Track) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f1, t + 0.06);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.001, vel * 0.9), t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  osc.connect(g); g.connect(out);
  osc.start(t); osc.stop(t + decay + 0.02);
  track(osc);
  // the slap of the hand on the skin
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(vel * slap, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.018);
  n.connect(bp); bp.connect(ng); ng.connect(out);
  n.start(t); n.stop(t + 0.03);
  track(n);
}

function cowbell(ctx: BaseAudioContext, out: AudioNode, t: number, vel: number, base: number, decay: number, track: Track) {
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = base * 4.8; bp.Q.value = 0.9;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.001, vel * 0.5), t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  bp.connect(g); g.connect(out);
  for (const [f, detune] of [[base, 0], [base * 1.48, 7]] as const) {
    const o = ctx.createOscillator();
    o.type = 'square'; o.frequency.value = f; o.detune.value = detune;
    o.connect(bp);
    o.start(t); o.stop(t + decay + 0.02);
    track(o);
  }
  // a little clapper rattle
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 5000;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(vel * 0.12, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
  n.connect(hp); hp.connect(ng); ng.connect(out);
  n.start(t); n.stop(t + 0.04);
  track(n);
}

function whistle(ctx: BaseAudioContext, out: AudioNode, t: number, vel: number, track: Track) {
  const o = ctx.createOscillator();
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  const g = ctx.createGain();
  const dur = 0.12 + vel * 0.14;
  o.type = 'sine'; o.frequency.value = 2900 + vel * 400;
  lfo.frequency.value = 6.5; lfoGain.gain.value = 45;
  lfo.connect(lfoGain); lfoGain.connect(o.frequency);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.001, vel * 0.22), t + 0.012);
  g.gain.setValueAtTime(Math.max(0.001, vel * 0.2), t + dur - 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(out);
  for (const n of [o, lfo]) { n.start(t); n.stop(t + dur + 0.02); track(n); }
}

/** Play one starter-kit sound at AudioContext time `t`. */
export function playKit(ctx: BaseAudioContext, out: AudioNode, inst: KitInst, t: number, vel: number, track: Track = () => {}) {
  switch (inst) {
    case 'bass': return thump(ctx, out, t, vel, 160, 90, 0.26, 0.25, track);
    case 'lead': return thump(ctx, out, t, vel, 300, 200, 0.16, 0.4, track);
    case 'cowHi': return cowbell(ctx, out, t, vel, 540, 0.13, track);
    case 'cowLo': return cowbell(ctx, out, t, vel, 400, 0.2, track);
    case 'whistle': return whistle(ctx, out, t, vel, track);
  }
}

/** The drums' own channel: hits go in, sound comes out, and everything can be cut off at once. */
export class DrumBus {
  readonly out: GainNode;
  source: DrumSource | null = null;
  /** The last few hits that were played (when, where in the score), for checking sync. */
  readonly log: DrumLogEntry[] = [];
  private active = new Set<AudioScheduledSourceNode>();

  constructor(private ctx: BaseAudioContext, dest: AudioNode, expose = false) {
    this.out = ctx.createGain();
    this.out.gain.value = 0.8;
    this.out.connect(dest);
    if (expose && typeof window !== 'undefined') (window as unknown as { __brDrumLog?: DrumLogEntry[] }).__brDrumLog = this.log;
  }

  setVolume(v: number) { this.out.gain.value = Math.max(0, Math.min(1, v)) * 0.9; }

  private track = (n: AudioScheduledSourceNode) => {
    this.active.add(n);
    n.addEventListener?.('ended', () => this.active.delete(n));
  };

  /** Play a hit at context time `when`. `spq` = seconds per quarter note, `bpm` = the tempo it is played at. */
  hit(h: DrumHit, when: number, spq: number, bpm: number, q = h.timeQ) {
    this.log.push({ t: when, q, inst: h.inst, slice: h.slice });
    if (this.log.length > 400) this.log.splice(0, 100);
    if (h.inst) { playKit(this.ctx, this.out, h.inst, when, h.vel, this.track); return; }
    const src = this.source;
    if (h.slice === undefined || !src?.buffer || !src.groove.slices) return;
    const s = src.groove.slices[h.slice];
    if (!s) return;
    const rate = playbackRateFor(src.groove.bpm ?? bpm, bpm);
    const natural = s.end - s.start;
    const len = Math.min(natural, ((h.maxQ ?? Infinity) * spq * rate) * 1.02);
    if (len <= 0.005) return;
    const node = this.ctx.createBufferSource();
    node.buffer = src.buffer;
    node.playbackRate.value = rate;
    const g = this.ctx.createGain();
    const play = len / rate;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(1, when + 0.002);
    g.gain.setValueAtTime(1, when + Math.max(0.002, play - 0.006));
    g.gain.linearRampToValueAtTime(0, when + play);
    node.connect(g); g.connect(this.out);
    node.start(when, s.start, len);
    this.track(node);
  }

  stop() {
    for (const n of this.active) { try { n.stop(); } catch { /* already ended */ } }
    this.active.clear();
  }

  dispose() { this.stop(); try { this.out.disconnect(); } catch { /* ignore */ } }
}
