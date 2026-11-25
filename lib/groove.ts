import type { Timeline } from './timeline';
import { loopSeconds, type Slice } from './grooveAnalysis';

export type Feel = 'straight' | 'triplet';

// ---------- the starter kit ----------

export type KitInst = 'bass' | 'lead' | 'cowHi' | 'cowLo' | 'whistle';
export const KIT_INSTS: { id: KitInst; label: string; gm: number }[] = [
  { id: 'bass', label: 'Bass drum', gm: 36 },
  { id: 'lead', label: 'Lead drum', gm: 47 },
  { id: 'cowHi', label: 'Cowbell high', gm: 56 },
  { id: 'cowLo', label: 'Cowbell low', gm: 56 },
  { id: 'whistle', label: 'Whistle', gm: 72 },
];
const GM_OF = Object.fromEntries(KIT_INSTS.map((k) => [k.id, k.gm])) as Record<KitInst, number>;

/** Step strengths: 0 rest, 1 soft, 2 normal, 3 accent. */
export interface KitPattern {
  steps: 12 | 16;
  bars: 1 | 2;
  tracks: Record<KitInst, number[]>;
}

export const STARTER_LABEL = 'Starter pattern — not a traditional rhythm. Fix it by ear.';

export function emptyPattern(steps: 12 | 16 = 16, bars: 1 | 2 = 1): KitPattern {
  const tracks = {} as Record<KitInst, number[]>;
  for (const k of KIT_INSTS) tracks[k.id] = new Array(steps * bars).fill(0);
  return { steps, bars, tracks };
}

const CH: Record<string, number> = { '.': 0, o: 1, x: 2, X: 3 };
const CHARS = ['.', 'o', 'x', 'X'];

/** "X . . . x . o ." (spaces optional) to step strengths. */
export function rowFromText(s: string): number[] {
  return [...s.replace(/\s+/g, '')].map((c) => CH[c] ?? 0);
}
export const rowToText = (r: number[]) => r.map((v) => CHARS[Math.max(0, Math.min(3, v | 0))]).join('');

/** Plain-text form of a pattern (one string per instrument, all bars joined): what is stored and exported. */
export function serializePattern(p: KitPattern): string {
  const tracks: Record<string, string> = {};
  for (const k of KIT_INSTS) tracks[k.id] = rowToText(p.tracks[k.id]);
  return JSON.stringify({ steps: p.steps, bars: p.bars, tracks });
}

/** Read a pattern written by `serializePattern` (or typed by hand). Anything wrong is repaired; null when it is not a pattern at all. */
export function parsePattern(text: string | unknown): KitPattern | null {
  let o: unknown = text;
  if (typeof text === 'string') { try { o = JSON.parse(text); } catch { return null; } }
  if (!o || typeof o !== 'object') return null;
  const r = o as { steps?: unknown; bars?: unknown; tracks?: Record<string, unknown> };
  const steps = r.steps === 12 ? 12 : r.steps === 16 ? 16 : null;
  const bars = r.bars === 2 ? 2 : r.bars === 1 ? 1 : null;
  if (!steps || !bars || !r.tracks || typeof r.tracks !== 'object') return null;
  const p = emptyPattern(steps, bars);
  for (const k of KIT_INSTS) {
    const raw = r.tracks[k.id];
    const row = typeof raw === 'string' ? rowFromText(raw) : Array.isArray(raw) ? raw.map((v) => Math.max(0, Math.min(3, Number(v) | 0))) : [];
    for (let i = 0; i < p.tracks[k.id].length; i++) p.tracks[k.id][i] = row[i] ?? 0;
  }
  return p;
}

/** Change the shape of a pattern (steps per bar, bars) keeping the hits that still fit. */
export function resizePattern(p: KitPattern, steps: 12 | 16, bars: 1 | 2): KitPattern {
  const q = emptyPattern(steps, bars);
  for (const k of KIT_INSTS) {
    for (let b = 0; b < Math.min(bars, p.bars); b++) {
      for (let i = 0; i < Math.min(steps, p.steps); i++) q.tracks[k.id][b * steps + i] = p.tracks[k.id][b * p.steps + i];
    }
  }
  return q;
}

const pat = (bars: string[][]): KitPattern => {
  const p = emptyPattern(16, bars.length as 1 | 2);
  bars.forEach((rows, b) => KIT_INSTS.forEach((k, ki) => { rowFromText(rows[ki] ?? '').forEach((v, i) => { p.tracks[k.id][b * 16 + i] = v; }); }));
  return p;
};
// rows: bass, lead, cowbell high, cowbell low, whistle (docs/GROOVE_RESEARCH.md, section 3). Hypotheses, not transcriptions.
export const STARTERS: { id: string; name: string; pattern: KitPattern }[] = [
  {
    id: 'starter-a', name: 'A · Pulse',
    pattern: pat([['X...x...X...x...', '......x.......x.', '..x...x...x...x.', 'x...x...x...x...', '............X.x.']]),
  },
  {
    id: 'starter-b', name: 'B · Interlock',
    pattern: pat([['X.....x.X.....x.', '..x..ox...x..ox.', 'x.x.x.x.x.x.x.x.', '...x...x...x...x', 'X...........xx..']]),
  },
  {
    id: 'starter-c', name: 'C · Call and response',
    pattern: pat([
      ['X...x...X...x...', 'x.x.xx.xx.x.xx..', 'x.xx.x.xx.xx.x.x', '................', '................'],
      ['X...x...X...x...', '................', 'x.xx.x.xx.xx.x.x', '................', 'X.x.X.x.XxX.....'],
    ]),
  },
];

// ---------- a groove ----------

export interface Groove {
  id: string;
  name: string;
  kind: 'recorded' | 'kit';
  createdAt: number;
  /** Built in (the starter patterns): cannot be renamed or deleted. */
  starter?: boolean;
  // recorded
  bpm?: number;
  bars?: number;
  /** How the quantize snaps: to sixteenths (straight) or triplet eighths. Also the default feel of a kit groove. */
  feel: Feel;
  /** 0 keeps the drummers' feel, 1 snaps every hit to the grid. */
  quantize?: number;
  downbeatS?: number;
  onsets?: number[];
  slices?: Slice[];
  durationS?: number;
  // kit
  pattern?: KitPattern;
}

export function starterGroove(id: string): Groove | null {
  const s = STARTERS.find((x) => x.id === id);
  return s ? { id: s.id, name: `Starter ${s.name}`, kind: 'kit', createdAt: 0, starter: true, feel: 'straight', pattern: s.pattern } : null;
}
export const starterGrooves = (): Groove[] => STARTERS.map((s) => starterGroove(s.id)!);

/** One hit of the drums, positioned in quarter notes. */
export interface DrumHit {
  timeQ: number;
  vel: number;
  /** General MIDI percussion note (for the MIDI download). */
  gm: number;
  durQ: number;
  /** Kit hit. */
  inst?: KitInst;
  /** Recorded hit: index into the groove's slices. */
  slice?: number;
  /** A recorded hit is cut when the next one starts (distance in quarters; Infinity = let it ring). */
  maxQ?: number;
}

/** Snap a beat position toward the grid (`amount` 0..1). */
export function quantizeBeat(beat: number, amount: number, feel: Feel): number {
  const grid = feel === 'triplet' ? 1 / 3 : 0.25;
  const snapped = Math.round(beat / grid) * grid;
  return beat + (snapped - beat) * Math.max(0, Math.min(1, amount));
}

const SWING = [0, 1 / 3, 1 / 2, 5 / 6];
/** Position in beats of step `i` of a bar. A 16-step pattern played with a triplet feel swings its sixteenths; 12 steps are already triplets. */
export function stepBeat(i: number, steps: 12 | 16, feel: Feel): number {
  if (steps === 12) return i / 3;
  return feel === 'triplet' ? Math.floor(i / 4) + SWING[i % 4] : i / 4;
}
const VEL = [0, 0.35, 0.7, 1];

/** The hits of bar `bar` (0-based) of a groove, with `timeQ` counted from the start of that groove bar (4 quarters long). */
export function grooveBarHits(g: Groove, bar: number, feelOverride?: Feel): DrumHit[] {
  if (g.kind === 'kit' && g.pattern) {
    const p = g.pattern;
    const b = ((bar % p.bars) + p.bars) % p.bars;
    const feel = feelOverride ?? g.feel;
    const out: DrumHit[] = [];
    for (const k of KIT_INSTS) {
      for (let i = 0; i < p.steps; i++) {
        const v = p.tracks[k.id][b * p.steps + i];
        if (v > 0) out.push({ timeQ: stepBeat(i, p.steps, feel), vel: VEL[v], gm: GM_OF[k.id], durQ: 0.25, inst: k.id });
      }
    }
    return out.sort((a, c) => a.timeQ - c.timeQ);
  }
  if (g.kind === 'recorded' && g.slices) {
    const bars = Math.max(1, g.bars ?? 1);
    const b = ((bar % bars) + bars) % bars;
    const feel = feelOverride ?? g.feel;
    const pos = g.slices.map((s) => Math.min(bars * 4 - 1e-6, quantizeBeat(s.beat, g.quantize ?? 0, feel)));
    const out: DrumHit[] = [];
    g.slices.forEach((s, i) => {
      if (pos[i] < b * 4 || pos[i] >= b * 4 + 4) return;
      const next = pos.filter((p) => p > pos[i] + 1e-6).reduce((m, p) => Math.min(m, p), Infinity);
      out.push({ timeQ: pos[i] - b * 4, vel: 1, gm: 38, durQ: Math.min(0.5, next - pos[i]), slice: i, maxQ: next - pos[i] });
    });
    return out.sort((a, c) => a.timeQ - c.timeQ);
  }
  return [];
}

export const grooveBars = (g: Groove) => (g.kind === 'kit' ? g.pattern?.bars ?? 1 : Math.max(1, g.bars ?? 1));

function sigAt(tl: Timeline, written: number) {
  let sig = { beats: 4, beatType: 4 };
  for (const s of tl.timeSigs) { if (s.measure <= written) sig = s; else break; }
  return sig;
}

/**
 * The drums for a whole score, in quarter notes. The groove restarts on the downbeat of bar 1 and runs bar by bar
 * (repeats and endings just keep it going). A pickup bar gets the END of the groove's last bar, so the first full
 * bar starts the groove from its beginning. A 3/4 bar plays three beats of the groove's bar; 6/4 and 12/8 take two.
 */
export function buildDrumEvents(tl: Timeline, g: Groove, feel?: Feel): DrumHit[] {
  const G = grooveBars(g);
  const cache = new Map<number, DrumHit[]>();
  const bar = (i: number) => { let h = cache.get(i); if (!h) { h = grooveBarHits(g, i, feel); cache.set(i, h); } return h; };
  const out: DrumHit[] = [];
  let counter = 0;
  for (let m = 0; m < tl.measureStartsQ.length; m++) {
    const sig = sigAt(tl, tl.order[m] ?? m + 1);
    const nominal = (4 * sig.beats) / sig.beatType;
    const start = tl.measureStartsQ[m];
    const end = m + 1 < tl.measureStartsQ.length ? tl.measureStartsQ[m + 1] : tl.totalQ;
    const len = end - start;
    if (m === 0 && len < nominal - 1e-6) {
      for (const h of bar(G - 1)) { const q = end - 4 + h.timeQ; if (q >= start - 1e-6) out.push({ ...h, timeQ: q }); }
      continue;
    }
    for (let pos = 0; pos < len - 1e-6; pos += 4) {
      const room = Math.min(4, len - pos);
      for (const h of bar(counter)) if (h.timeQ < room - 1e-6) out.push({ ...h, timeQ: start + pos + h.timeQ });
      counter++;
    }
  }
  return out.sort((a, b) => a.timeQ - b.timeQ);
}

/** Seconds from `anchorTime` for each hit at `bpm` (what the player does with the hits). */
export const hitTimes = (hits: DrumHit[], bpm: number, anchorTime = 0, anchorQ = 0) => hits.map((h) => anchorTime + ((h.timeQ - anchorQ) * 60) / bpm);

/** How a recorded groove is played at another tempo: nudged by playbackRate within +-8%, otherwise at its own speed. */
export function playbackRateFor(origBpm: number, bpm: number): number {
  const r = bpm / origBpm;
  return Number.isFinite(r) && Math.abs(r - 1) <= 0.08 ? r : 1;
}

export const grooveLoopSeconds = (g: Groove, bpm: number) => loopSeconds(grooveBars(g), bpm);

// ---------- groove files ----------

export interface GrooveFile { format: 'brass-reader-groove'; version: 1; groove: Groove; audio?: { mime: string; base64: string } }

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

export function makeGrooveFile(g: Groove, audio?: { mime: string; bytes: Uint8Array }): string {
  const { starter: _s, ...groove } = g; void _s;
  const f: GrooveFile = { format: 'brass-reader-groove', version: 1, groove, ...(audio ? { audio: { mime: audio.mime, base64: toBase64(audio.bytes) } } : {}) };
  return JSON.stringify(f);
}

const num = (v: unknown, fb: number, lo = -Infinity, hi = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb);

/** Read a groove file. Throws an Error with a plain message when it is not a usable groove. */
export function parseGrooveFile(text: string): { groove: Groove; audio?: { mime: string; bytes: Uint8Array } } {
  let f: Partial<GrooveFile>;
  try { f = JSON.parse(text); } catch { throw new Error('This is not a groove file.'); }
  if (!f || f.format !== 'brass-reader-groove' || !f.groove || typeof f.groove !== 'object') throw new Error('This is not a Brass Reader groove file.');
  const g = f.groove as Groove;
  const name = typeof g.name === 'string' && g.name.trim() ? g.name.trim().slice(0, 60) : 'Imported groove';
  const feel: Feel = g.feel === 'triplet' ? 'triplet' : 'straight';
  if (g.kind === 'kit') {
    const pattern = parsePattern(g.pattern);
    if (!pattern) throw new Error('The pattern in this file is damaged.');
    return { groove: { id: '', name, kind: 'kit', createdAt: Date.now(), feel, pattern } };
  }
  if (g.kind !== 'recorded' || !f.audio || typeof f.audio.base64 !== 'string') throw new Error('This groove file has no audio in it.');
  const bpm = num(g.bpm, 0, 30, 300);
  const durationS = num(g.durationS, 0, 0, 120);
  if (!bpm) throw new Error('This groove file has no tempo.');
  const slices = Array.isArray(g.slices)
    ? g.slices.filter((s): s is Slice => !!s && [s.beat, s.start, s.end].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0) && s.end > s.start).slice(0, 2000)
    : [];
  const groove: Groove = {
    id: '', name, kind: 'recorded', createdAt: Date.now(), feel, bpm,
    bars: [1, 2, 4].includes(g.bars as number) ? (g.bars as number) : 1,
    quantize: num(g.quantize, 0, 0, 1), downbeatS: num(g.downbeatS, 0, 0, 120), durationS,
    onsets: Array.isArray(g.onsets) ? g.onsets.filter((v) => typeof v === 'number' && Number.isFinite(v)).slice(0, 4000) : [], slices,
  };
  let bytes: Uint8Array;
  try { bytes = fromBase64(f.audio.base64); } catch { throw new Error('The audio in this groove file is damaged.'); }
  return { groove, audio: { mime: typeof f.audio.mime === 'string' ? f.audio.mime : 'audio/wav', bytes } };
}
