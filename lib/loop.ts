import type { Timeline } from './timeline';

/** A range of written bars (1-based, inclusive) to repeat while practising. */
export interface LoopRange { from: number; to: number }

/** Speed trainer: start slow, step up by `step` BPM after every `every` passes until `target`. */
export interface Trainer { enabled: boolean; start: number; target: number; step: number; every: number }

export const DEFAULT_TRAINER: Trainer = { enabled: false, start: 70, target: 120, step: 5, every: 1 };

const clampBpm = (n: number) => Math.max(30, Math.min(240, Math.round(n)));

/** Keep a loop inside the score, from <= to. Returns null if there is nothing to loop. */
export function normalizeLoop(r: LoopRange | null | undefined, measureCount: number): LoopRange | null {
  if (!r || !Number.isFinite(r.from) || !Number.isFinite(r.to) || measureCount < 1) return null;
  const a = Math.max(1, Math.min(measureCount, Math.round(Math.min(r.from, r.to))));
  const b = Math.max(1, Math.min(measureCount, Math.round(Math.max(r.from, r.to))));
  return { from: a, to: b };
}

/** Make a trainer safe to use: whole numbers, BPM in range, at least one BPM per step and one pass per step. */
export function normalizeTrainer(t: Partial<Trainer> | null | undefined): Trainer {
  const d = DEFAULT_TRAINER;
  const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
  return {
    enabled: !!t?.enabled,
    start: clampBpm(num(t?.start, d.start)),
    target: clampBpm(num(t?.target, d.target)),
    step: Math.max(1, Math.min(60, Math.round(num(t?.step, d.step)))),
    every: Math.max(1, Math.min(32, Math.round(num(t?.every, d.every)))),
  };
}

/** BPM for pass `pass` (1-based): start, +step after every `every` passes, never past the target (either direction). */
export function trainerBpm(t: Trainer, pass: number): number {
  const n = Math.max(0, Math.floor((Math.max(1, pass) - 1) / Math.max(1, t.every)));
  const dir = t.target >= t.start ? 1 : -1;
  const v = t.start + dir * n * t.step;
  return clampBpm(dir > 0 ? Math.min(t.target, v) : Math.max(t.target, v));
}

/** "Pass 3 · 85 → 120 BPM" with a trainer, "Pass 3 · 100 BPM" without. */
export function passLabel(pass: number, bpm: number, t: Trainer | null): string {
  return t?.enabled ? `Pass ${pass} · ${bpm} → ${t.target} BPM` : `Pass ${pass} · ${bpm} BPM`;
}

/** Start and end (quarters, play order) of a loop over written bars. The end is the end of bar `to`. */
export function loopQ(tl: Timeline, r: LoopRange): { startQ: number; endQ: number } | null {
  const n = normalizeLoop(r, tl.measureCount);
  if (!n || !tl.measureStartsQ.length) return null;
  let s0 = tl.order.indexOf(n.from);
  if (s0 < 0) s0 = 0;
  let s1 = -1;
  for (let i = s0; i < tl.order.length; i++) if (tl.order[i] === n.to) { s1 = i; break; }
  if (s1 < 0) s1 = tl.order.lastIndexOf(n.to);
  if (s1 < s0) s1 = s0;
  const startQ = tl.measureStartsQ[s0];
  const endQ = s1 + 1 < tl.measureStartsQ.length ? tl.measureStartsQ[s1 + 1] : tl.totalQ;
  return endQ > startQ + 1e-6 ? { startQ, endQ } : null;
}
