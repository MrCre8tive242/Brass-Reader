import { playbackRateFor, type DrumHit, type Groove, type KitInst } from './groove';
import { SLICE_XF, type Slice } from './grooveAnalysis';
import { KIT_TAKES, TIER_VEL, renderKit, tierOf, type Tier } from './kitSynth';

/** Where the audio of a recorded groove comes from, and which groove the hits belong to. */
export interface DrumSource { groove: Groove; buffer: AudioBuffer | null }

export interface DrumLogEntry { t: number; q: number; inst?: string; slice?: number }

type Track = (node: AudioScheduledSourceNode) => void;

const STOP_FADE_S = 0.012;

// the kit's sounds: worked out once per sample rate, turned into a buffer once per audio context, then simply played
const kitSamples = new Map<string, Float32Array>();
const kitCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();
function kitBuffer(ctx: BaseAudioContext, inst: KitInst, tier: Tier, take: number): AudioBuffer {
  let m = kitCache.get(ctx);
  if (!m) { m = new Map(); kitCache.set(ctx, m); }
  const key = `${inst}${tier}${take}`;
  let b = m.get(key);
  if (!b) {
    const sk = `${ctx.sampleRate}:${key}`;
    let samples = kitSamples.get(sk);
    if (!samples) { samples = renderKit(inst, tier, take, ctx.sampleRate); kitSamples.set(sk, samples); }
    b = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    b.getChannelData(0).set(samples);
    m.set(key, b);
  }
  return b;
}

/** Render the sounds a groove needs ahead of time, a few at a time, so the first bar does not have to wait for them. */
export function warmKit(ctx: BaseAudioContext, hits: { inst?: KitInst; vel: number }[]) {
  const seen = new Set<string>();
  const todo: [KitInst, Tier, number][] = [];
  for (const h of hits) {
    if (!h.inst) continue;
    const tier = tierOf(h.vel);
    if (seen.has(h.inst + tier)) continue;
    seen.add(h.inst + tier);
    for (let k = 0; k < KIT_TAKES; k++) todo.push([h.inst, tier, k]);
  }
  if (!todo.length) return;
  const step = () => {
    const end = Date.now() + 6;
    while (todo.length && Date.now() < end) { const [i, t, k] = todo.shift()!; try { kitBuffer(ctx, i, t, k); } catch { return; } }
    if (todo.length) setTimeout(step, 30);
  };
  setTimeout(step, 0);
}

// which take each instrument played last, so the same one never comes twice in a row
const lastTake: Partial<Record<KitInst, number>> = {};
/** How much each hit differs from the last: a little in pitch (a drum more than a bell) and in loudness. */
const HUMAN: Record<KitInst, { pitch: number; level: number }> = {
  bass: { pitch: 0.012, level: 0.07 }, lead: { pitch: 0.016, level: 0.1 }, cowHi: { pitch: 0.003, level: 0.1 }, cowLo: { pitch: 0.003, level: 0.1 }, whistle: { pitch: 0.006, level: 0.06 },
  cymbal: { pitch: 0.01, level: 0.08 }, jkBass: { pitch: 0.01, level: 0.06 }, tumHi: { pitch: 0.012, level: 0.08 }, tumLo: { pitch: 0.012, level: 0.08 },
};

/** Which take of a kit sound is played, and how far its pitch and loudness are nudged. */
export interface KitDice { take: number; rate: number; level: number }

/** Roll the dice for one hit: another take than `last`, and a touch of pitch and loudness. */
export function rollKit(inst: KitInst, rand: () => number, last: number | undefined): KitDice {
  let take = Math.floor(rand() * KIT_TAKES) % KIT_TAKES;
  if (take === last) take = (take + 1) % KIT_TAKES;
  const h = HUMAN[inst];
  return { take, rate: 1 + (rand() * 2 - 1) * h.pitch, level: 1 + (rand() * 2 - 1) * h.level };
}

/**
 * Play one starter-kit sound at AudioContext time `t`. No two hits are quite the same: another take of the sound
 * than last time, and a touch of pitch and loudness (`rand` is the dice; pass a fixed one for a repeatable result,
 * or `dice` to say exactly how this hit sounds).
 */
export function playKit(ctx: BaseAudioContext, out: AudioNode, inst: KitInst, t: number, vel: number, track: Track = () => {}, rand: () => number = Math.random, dice?: KitDice) {
  const tier = tierOf(vel);
  const d = dice ?? rollKit(inst, rand, lastTake[inst]);
  if (!dice) lastTake[inst] = d.take;
  const src = ctx.createBufferSource();
  src.buffer = kitBuffer(ctx, inst, tier, d.take);
  src.playbackRate.value = d.rate;
  const g = ctx.createGain();
  g.gain.value = Math.max(0, (vel / TIER_VEL[tier]) * d.level);
  src.connect(g); g.connect(out);
  src.start(t);
  track(src);
}

export interface SlicePlan {
  /** Context time the audio starts (a little before the stroke). */
  startAt: number;
  /** Where in the recording it starts, seconds. */
  offset: number;
  /** How long it sounds, seconds of output. */
  play: number;
  /** Length of the fade in and of the fade out, seconds. */
  fade: number;
}

/**
 * When and how one recorded hit is played so that its main stroke lands at `when`.
 * Slices cut the current way begin a little before their stroke and run into the next one: started early and
 * cross-faded with their neighbours, the loop at its own tempo is the recording itself, and at any other tempo
 * there is no gap, no click and no doubled attack. `maxQ` (quarters to the next hit) cuts a hit that would run
 * into the next; `nextPre` is the lead-in of that next hit. Null when there is nothing left to play.
 */
export function slicePlan(s: Slice, when: number, rate: number, spq: number, maxQ: number | undefined, nextPre: number | undefined, now: number): SlicePlan | null {
  const legacy = s.pre === undefined;
  const pre = s.pre ?? 0;
  const xf = legacy ? 0.004 : SLICE_XF;
  let startAt = when - pre / rate;
  let offset = s.start;
  if (startAt < now) { offset += (now - startAt) * rate; startAt = now; } // too late for the lead-in: skip it, keep the stroke on time
  let play = (s.end - offset) / rate;
  if (maxQ !== undefined && Number.isFinite(maxQ)) {
    const cut = legacy ? when + maxQ * spq * 1.02 : when + maxQ * spq - (nextPre ?? pre) / rate + xf;
    play = Math.min(play, cut - startAt);
  }
  if (!(play > 0.005)) return null;
  return { startAt, offset, play, fade: Math.min(xf, play / 2) };
}

/** The drums' own channel: hits go in, sound comes out, and everything can be cut off at once. */
export class DrumBus {
  readonly out: GainNode;
  source: DrumSource | null = null;
  /** The last few hits that were played (when, where in the score), for checking sync. */
  readonly log: DrumLogEntry[] = [];
  private active = new Set<AudioScheduledSourceNode>();

  /** What the hits play into. Swapped for a new one on `stop()`, so the old one can fade out without touching new hits. */
  private voices: GainNode;
  private bus: AudioNode;

  /** `expose` names a property of `window` under which the log can be read (for checking sync from outside). */
  constructor(private ctx: BaseAudioContext, dest: AudioNode, expose?: string) {
    this.out = ctx.createGain();
    this.out.gain.value = 0.8;
    this.out.connect(dest);
    // the whole kit on an accent can add up to more than full scale: hold the peaks instead of crackling
    let into: AudioNode = this.out;
    if (typeof ctx.createDynamicsCompressor === 'function') {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = -9; c.knee.value = 6; c.ratio.value = 8; c.attack.value = 0.002; c.release.value = 0.09;
      c.connect(this.out);
      into = c;
    }
    this.bus = into;
    this.voices = ctx.createGain();
    this.voices.connect(this.bus);
    if (expose && typeof window !== 'undefined') (window as unknown as Record<string, DrumLogEntry[]>)[expose] = this.log;
  }

  setVolume(v: number) { this.out.gain.value = Math.max(0, Math.min(1, v)) * 0.9; }

  private track = (n: AudioScheduledSourceNode) => {
    this.active.add(n);
    n.addEventListener?.('ended', () => this.active.delete(n));
  };

  /** Play a hit at context time `when`. `spq` = seconds per quarter note, `bpm` = the tempo it is played at. `dice` fixes how a kit sound comes out. */
  hit(h: DrumHit, when: number, spq: number, bpm: number, q = h.timeQ, dice?: KitDice) {
    this.log.push({ t: when, q, inst: h.inst, slice: h.slice });
    if (this.log.length > 400) this.log.splice(0, 100);
    if (h.inst) { playKit(this.ctx, this.voices, h.inst, when, h.vel, this.track, Math.random, dice); return; }
    const src = this.source;
    if (h.slice === undefined || !src?.buffer || !src.groove.slices) return;
    const s = src.groove.slices[h.slice];
    if (!s) return;
    const rate = playbackRateFor(src.groove.bpm ?? bpm, bpm);
    const plan = slicePlan(s, when, rate, spq, h.maxQ, h.nextPre, this.ctx.currentTime);
    if (!plan) return;
    const { startAt, offset, play, fade } = plan;
    const node = this.ctx.createBufferSource();
    node.buffer = src.buffer;
    node.playbackRate.value = rate;
    const g = this.ctx.createGain();
    const level = Math.max(0.1, Math.min(12, src.groove.gain ?? 1));
    g.gain.setValueAtTime(0, startAt);
    g.gain.linearRampToValueAtTime(level, startAt + fade);
    g.gain.setValueAtTime(level, startAt + play - fade);
    g.gain.linearRampToValueAtTime(0, startAt + play);
    node.connect(g); g.connect(this.voices);
    node.start(startAt, offset, play * rate + 0.01);
    this.track(node);
  }

  /** One kit sound right away (a step being tapped in). */
  tap(inst: KitInst, vel: number) {
    const when = this.ctx.currentTime + 0.01;
    this.log.push({ t: when, q: -1, inst });
    playKit(this.ctx, this.voices, inst, when, vel, this.track);
  }

  /** Cut everything that sounds or is waiting to sound: a few milliseconds of fade instead of a click. */
  stop() {
    if (!this.active.size) return;
    const old = this.voices, now = this.ctx.currentTime;
    const nodes = [...this.active];
    this.active.clear();
    try {
      old.gain.setValueAtTime(1, now);
      old.gain.linearRampToValueAtTime(0, now + STOP_FADE_S);
    } catch { /* ignore */ }
    for (const n of nodes) { try { n.stop(now + STOP_FADE_S + 0.005); } catch { /* already ended */ } }
    this.voices = this.ctx.createGain();
    this.voices.connect(this.bus);
    setTimeout(() => { try { old.disconnect(); } catch { /* ignore */ } }, 200);
  }

  dispose() { this.stop(); try { this.voices.disconnect(); this.bus.disconnect(); this.out.disconnect(); } catch { /* ignore */ } }
}
