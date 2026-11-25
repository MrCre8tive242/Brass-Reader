import type { InstrumentId } from './instruments';
import type { Timeline } from './timeline';
import { partGain, type MixState } from './mixer';
import { DrumBus, rollKit, type DrumSource, type KitDice } from './drums';
import type { DrumHit, KitInst } from './groove';
import { SynthVoice, createVoice, newVoiceCache, type Voice, type VoiceCache } from './voices';

export const VIDEO_RATE = 48000;
/** The sound is made in pieces of this length, so that a long song never sits in memory whole. */
export const SEGMENT_S = 20;
/** How long a sound may still ring after its written end (a note's release, a drum's tail). */
const RING_S = 3;
/** Each piece starts this much early (thrown away afterwards), so that what was already sounding is there and the drum compressor has settled. */
const SETTLE_S = 1.5;

/** Roughly how high one part's loudest moments reach at full volume, and the drums at full volume (of full scale = 1). */
const PART_PEAK = 0.25;
const DRUM_PEAK = 0.6;
const TARGET_PEAK = 0.7;
const MAX_MAKEUP = 3;

/** What the video's sound is made of: the same parts, mix and drums the player makes. */
export interface AudioJob {
  tl: Timeline;
  bpm: number;
  /** Instrument of every part (index = part). */
  partInstruments: InstrumentId[];
  /** Loudness, mute and solo of every part. */
  mix: MixState[];
  drumHits: DrumHit[];
  drumSource: DrumSource | null;
  drumsOn: boolean;
  drumsVolume: number;
  /** Seconds of count-in before the music (the clicks are in `clicks`). */
  leadS?: number;
  /** Count-in clicks: seconds from the start of the video. */
  clicks?: { t: number; accent: boolean }[];
}

/** Web Audio works in blocks of this many sample frames. */
const BLOCK = 128;

/** One piece of the sound, in sample frames: `start`..`end` is kept; its render begins at `from` (<= start). */
export interface Segment { start: number; end: number; from: number }

/**
 * Cut `totalFrames` of sound into pieces of `segS` seconds. A piece's render starts early enough to hold every sound
 * that is still ringing when the piece begins (`sounds`: start and written end in seconds), and never less than
 * `settleS` before it.
 */
export function planSegments(sounds: { t: number; end: number }[], totalFrames: number, rate: number, segS = SEGMENT_S, ringS = RING_S, settleS = SETTLE_S): Segment[] {
  const out: Segment[] = [];
  const size = Math.max(1, Math.round(segS * rate));
  for (let start = 0; start < totalFrames; start += size) {
    const end = Math.min(totalFrames, start + size);
    const s = start / rate;
    let from = s - settleS;
    for (const x of sounds) if (x.t < s && x.end + ringS > s) from = Math.min(from, x.t);
    // a whole number of audio blocks before the piece: compressors work block by block, and only then do they do
    // exactly what they would do in one long render
    out.push({ start, end, from: start === 0 ? 0 : Math.max(0, Math.floor((from * rate) / BLOCK) * BLOCK) });
  }
  return out;
}

interface Note { t: number; d: number; midi: number; part: number; vel: number }
interface Hit { t: number; h: DrumHit; dice?: KitDice }

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * The sound of the whole video, made a piece at a time in OfflineAudioContexts (much faster than real time). The notes
 * and drums are scheduled exactly as the player schedules them (same gain per part, same note length, same drum bus),
 * minus the click; a count-in, if asked for, is clicked before the music. The pieces join without a seam: each one is
 * rendered from a little before its start, the kit drums' small random differences are fixed for the whole song up
 * front, and decoded samples are shared between the pieces.
 */
export class AudioRenderer {
  readonly totalFrames: number;
  readonly segments: Segment[];
  /** What the horns were played with so far: the samples, or (for at least one instrument) the simple synth. Null before any horn sounded. */
  get engine(): 'soundfont' | 'synth' | null { return this.synthOnly.size ? 'synth' : this.sampled ? 'soundfont' : null; }
  private sampled = false;
  private notes: Note[] = [];
  private hits: Hit[] = [];
  private clicks: { t: number; accent: boolean }[];
  private cache: VoiceCache = newVoiceCache();
  private synthOnly = new Set<InstrumentId>();
  private pitches = new Map<InstrumentId, number[]>();
  private spq: number;
  /** How much the whole mix is turned up (a part alone is quiet next to a full band with drums). */
  readonly makeup: number;

  constructor(private job: AudioJob, readonly seconds: number, readonly rate = VIDEO_RATE, segS = SEGMENT_S) {
    const lead = job.leadS ?? 0;
    this.spq = 60 / job.bpm;
    this.totalFrames = Math.max(1, Math.ceil(seconds * rate));
    const pitches = new Map<InstrumentId, Set<number>>();
    for (const e of job.tl.events) {
      const part = e.part ?? 0;
      const g = partGain(job.mix, part);
      if (g <= 0) continue;
      this.notes.push({ t: lead + e.timeQ * this.spq, d: Math.max(0.05, e.durQ * this.spq * 0.97), midi: e.midi, part, vel: 0.8 * g });
      const id = job.partInstruments[part] ?? job.partInstruments[0];
      if (!pitches.has(id)) pitches.set(id, new Set());
      pitches.get(id)!.add(e.midi);
    }
    this.notes.sort((a, b) => a.t - b.t);
    for (const [id, set] of pitches) this.pitches.set(id, [...set].sort((a, b) => a - b));
    if (job.drumsOn && job.drumHits.length) {
      const dice = mulberry(20240131);
      const last: Partial<Record<KitInst, number>> = {};
      for (const h of [...job.drumHits].sort((a, b) => a.timeQ - b.timeQ)) {
        const hit: Hit = { t: lead + h.timeQ * this.spq, h };
        if (h.inst) { hit.dice = rollKit(h.inst, dice, last[h.inst]); last[h.inst] = hit.dice.take; }
        this.hits.push(hit);
      }
    }
    this.clicks = job.clicks ?? [];
    // the mix as the player makes it peaks far below full scale when few parts play: turn it up, by an amount worked
    // out from what is in the mix (so it is the same for the whole song), and never past full scale
    let peak = 0;
    for (const part of new Set(this.notes.map((n) => n.part))) peak += (PART_PEAK * partGain(job.mix, part)) ** 2;
    peak = Math.sqrt(peak) * 1.1; // parts seldom peak at the same instant
    if (this.hits.length) peak += DRUM_PEAK * Math.max(0, Math.min(1, job.drumsVolume));
    this.makeup = Math.max(1, Math.min(MAX_MAKEUP, TARGET_PEAK / Math.max(0.01, peak)));
    const sounds = this.notes.map((n) => ({ t: n.t, end: n.t + n.d }));
    for (const h of this.hits) sounds.push({ t: h.t, end: h.t + 0.6 });
    this.segments = planSegments(sounds, this.totalFrames, rate, segS);
  }

  /** Forget the decoded samples. */
  dispose() { this.cache = newVoiceCache(); }

  /** The sound of piece `i`: left and right, `segments[i].end - segments[i].start` frames each. */
  async render(i: number): Promise<[Float32Array, Float32Array]> {
    const seg = this.segments[i];
    const rate = this.rate;
    const OAC = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    const ctx = new OAC(2, seg.end - seg.from, rate);
    const t0 = seg.from / rate, t1 = seg.end / rate;
    // horns and drums -> turned up together -> a limiter that only works if the guess above was too bold -> out
    const out = ctx.createGain();
    out.gain.value = this.makeup;
    if (typeof ctx.createDynamicsCompressor === 'function') {
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -1.5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.06;
      const trim = ctx.createGain();
      trim.gain.value = 0.9;
      out.connect(lim); lim.connect(trim); trim.connect(ctx.destination);
    } else out.connect(ctx.destination);
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(out);
    const notes = this.notes.filter((n) => n.t >= t0 - 1e-9 && n.t < t1);
    // only the instruments that play in this piece are loaded
    const ids = [...new Set(notes.map((n) => this.job.partInstruments[n.part] ?? this.job.partInstruments[0]))];
    const loaded = await Promise.all(ids.map(async (id) => [
      id, this.synthOnly.has(id) ? null : await createVoice(ctx, master, id, { offline: true, notes: this.pitches.get(id), cache: this.cache }),
    ] as const));
    const byId = new Map<InstrumentId, Voice>();
    for (const [id, v] of loaded) {
      if (v && v.engine === 'soundfont') { byId.set(id, v.voice); continue; }
      // the samples could not be loaded: this instrument is the simple synth for the whole video
      this.synthOnly.add(id);
      byId.set(id, new SynthVoice(ctx, master));
    }
    if (byId.size > this.synthOnly.size || [...byId.keys()].some((id) => !this.synthOnly.has(id))) this.sampled = true;
    for (const n of notes) {
      const id = this.job.partInstruments[n.part] ?? this.job.partInstruments[0];
      byId.get(id)?.start({ note: n.midi, time: Math.max(0, n.t - t0), duration: n.d, velocity: n.vel });
    }
    const hits = this.hits.filter((h) => h.t >= t0 - 1e-9 && h.t < t1);
    if (hits.length) {
      const bus = new DrumBus(ctx, out);
      bus.source = this.job.drumSource;
      bus.setVolume(this.job.drumsVolume);
      for (const h of hits) bus.hit(h.h, Math.max(0, h.t - t0), this.spq, this.job.bpm, h.h.timeQ, h.dice);
    }
    for (const c of this.clicks) if (c.t >= t0 - 1e-9 && c.t < t1) click(ctx, ctx.destination, c.t - t0, c.accent);
    const buf = await ctx.startRendering();
    const skip = seg.start - seg.from;
    const n = seg.end - seg.start;
    const left = buf.getChannelData(0), right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0);
    return [left.subarray(skip, skip + n), right.subarray(skip, skip + n)];
  }
}

/** The player's count-in click. */
function click(ctx: BaseAudioContext, out: AudioNode, time: number, accent: boolean) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = accent ? 1500 : 1000;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(accent ? 0.45 : 0.3, time + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  osc.connect(g); g.connect(out);
  osc.start(time);
  osc.stop(time + 0.06);
}

/** The whole sound in one buffer (short pieces of music only; used to check the pieces against). */
export async function renderWhole(job: AudioJob, seconds: number, rate = VIDEO_RATE): Promise<[Float32Array, Float32Array]> {
  const r = new AudioRenderer(job, seconds, rate, seconds + 1);
  try { return await r.render(0); } finally { r.dispose(); }
}
