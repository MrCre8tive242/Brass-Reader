import {
  parseXml, partsOf, kids, kid, kidNum, kidText, pitchToMidi, type XEl,
} from './musicxml';

export interface TimelineEvent {
  /** Start, in quarter notes from the start of the score. */
  timeQ: number;
  durQ: number;
  /** SOUNDING (concert) MIDI pitch: the part's <transpose> is applied. */
  midi: number;
  /** 1-based WRITTEN measure index (for the cursor, bar highlight and bar counter). `timeQ` is in play order. */
  measure: number;
  /** Which part of an ensemble this note belongs to (0 = the player's own part). Absent = 0. */
  part?: number;
}

export interface Timeline {
  events: TimelineEvent[];
  /** Start (quarters, play order) of every played bar. With repeats this has more entries than the score has bars. */
  measureStartsQ: number[];
  totalQ: number;
  /** `measure` is the written bar index. */
  timeSigs: { measure: number; beats: number; beatType: number }[];
  /** Play order: written bar (1-based) for each played bar, i.e. repeats and endings unrolled. */
  order: number[];
  /** Number of written bars. */
  measureCount: number;
  /** Display label per written bar: "Pickup" for an anacrusis, otherwise the printed bar number. */
  barLabels: string[];
  /** Highest printed bar number (shown as the total in "Bar n / total"). */
  barTotal: number;
  /** True if the play order differs from the written order. */
  hasRepeats: boolean;
}

/** Per written bar: repeat / ending / jump markup. */
export interface MeasureFlow {
  forward?: boolean;
  backward?: boolean;
  times?: number;
  endings?: number[] | null;
  segno?: string;
  coda?: string;
  tocoda?: string;
  dacapo?: boolean;
  dalsegno?: string;
  fine?: boolean;
}

/**
 * Unroll repeats, volta endings and simple D.C./D.S. al Fine/Coda into a play order.
 * Returns 0-based written bar indices.
 */
export function unrollMeasures(flow: MeasureFlow[]): number[] {
  const n = flow.length;
  const out: number[] = [];
  let maxEnding = 0;
  for (const m of flow) for (const e of m.endings ?? []) maxEnding = Math.max(maxEnding, e);
  const find = (key: 'segno' | 'coda', v: string) => flow.findIndex((m) => m[key] === v);
  let i = 0, pass = 1, repeatStart = 0;
  let jumped = false, repeatsOff = false, byJump = false;
  const limit = n * 40 + 100;
  while (i < n && out.length < limit) {
    const m = flow[i];
    if (!m.endings && i > 0 && flow[i - 1].endings && !byJump) { pass = 1; repeatStart = i; }
    if (m.endings) {
      const ok = repeatsOff ? m.endings.includes(maxEnding) : m.endings.includes(pass);
      if (!ok) { i++; continue; }
    }
    if (m.forward && !byJump && !repeatsOff) { repeatStart = i; pass = 1; }
    byJump = false;
    out.push(i);
    if (jumped && m.fine) break;
    if (jumped && m.tocoda) {
      const c = find('coda', m.tocoda);
      if (c >= 0 && c !== i) { i = c; byJump = true; continue; }
    }
    if (m.backward && !repeatsOff) {
      if (pass < (m.times ?? 2)) { pass++; i = repeatStart; byJump = true; continue; }
      pass = 1; repeatStart = i + 1;
    }
    if (!jumped && (m.dacapo || m.dalsegno)) {
      const t = m.dacapo ? 0 : find('segno', m.dalsegno!);
      if (t >= 0) { jumped = true; repeatsOff = true; i = t; byJump = true; continue; }
    }
    i++;
  }
  return out;
}

function parseEndingNumbers(s: string | null): number[] {
  const out: number[] = [];
  for (const part of (s ?? '').split(/[,\s]+/)) {
    const r = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (r) { for (let k = Number(r[1]); k <= Number(r[2]) && k < 50; k++) out.push(k); continue; }
    const v = parseInt(part, 10);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

export function readFlow(parts: XEl[]): { flow: MeasureFlow[]; labels: string[]; barTotal: number } {
  const count = Math.max(0, ...parts.map((p) => kids(p, 'measure').length));
  const flow: MeasureFlow[] = Array.from({ length: count }, () => ({}));
  const nums: (string | null)[] = Array(count).fill(null);
  const implicit: boolean[] = Array(count).fill(false);
  parts.forEach((part, pi) => {
    let ending: number[] | null = null;
    kids(part, 'measure').forEach((m, mi) => {
      const f = flow[mi];
      if (pi === 0) { nums[mi] = m.getAttribute('number'); implicit[mi] = m.getAttribute('implicit') === 'yes'; }
      let inEnding: number[] | null = null;
      let stopAfter = false;
      const sounds: XEl[] = [];
      for (const el of kids(m)) {
        if (el.nodeName === 'barline') {
          const rep = kid(el, 'repeat');
          if (rep) {
            if (rep.getAttribute('direction') === 'forward') f.forward = true;
            else if (rep.getAttribute('direction') === 'backward') {
              f.backward = true;
              const t = parseInt(rep.getAttribute('times') ?? '', 10);
              if (Number.isFinite(t) && t > 1) f.times = t;
            }
          }
          const end = kid(el, 'ending');
          if (end) {
            const type = end.getAttribute('type');
            if (type === 'start') { ending = parseEndingNumbers(end.getAttribute('number')); inEnding = ending; }
            else if (type === 'stop' || type === 'discontinue') {
              if (!ending) ending = parseEndingNumbers(end.getAttribute('number'));
              inEnding = ending; stopAfter = true;
            }
          }
        } else if (el.nodeName === 'sound') sounds.push(el);
        else if (el.nodeName === 'direction') for (const s of kids(el, 'sound')) sounds.push(s);
      }
      if (!inEnding && ending) inEnding = ending;
      if (inEnding && inEnding.length) f.endings = f.endings ?? inEnding;
      if (stopAfter) ending = null;
      for (const s of sounds) {
        if (s.getAttribute('segno')) f.segno = s.getAttribute('segno')!;
        if (s.getAttribute('coda')) f.coda = s.getAttribute('coda')!;
        if (s.getAttribute('tocoda')) f.tocoda = s.getAttribute('tocoda')!;
        if (s.getAttribute('dacapo') === 'yes') f.dacapo = true;
        if (s.getAttribute('dalsegno')) f.dalsegno = s.getAttribute('dalsegno')!;
        if (s.getAttribute('fine')) f.fine = true;
      }
    });
  });
  // bar labels: printed numbers when they are usable, else sequential after an optional pickup
  const labels: string[] = [];
  const pickup = count > 0 && (implicit[0] || nums[0] === '0');
  const ints = nums.map((x) => (x !== null && /^\d+$/.test(x) ? Number(x) : null));
  let usable = ints.every((x) => x !== null);
  for (let i = 1; usable && i < count; i++) if (ints[i]! <= ints[i - 1]!) usable = false;
  let barTotal = 0;
  for (let i = 0; i < count; i++) {
    if (i === 0 && pickup) { labels.push('Pickup'); continue; }
    const n = usable && (!pickup || ints[0] === 0) ? ints[i]! : i + 1 - (pickup ? 1 : 0);
    labels.push(String(n));
    barTotal = Math.max(barTotal, n);
  }
  return { flow, labels, barTotal };
}

interface RawNote {
  measureIdx: number;
  startQ: number; // within measure
  durQ: number;
  midi: number;
  tieStart: boolean;
  tieStop: boolean;
}

const EPS = 1e-6;

function parseBeats(s: string | null): number | null {
  if (!s) return null;
  const parts = s.split('+').map((x) => parseInt(x, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((a, b) => a + b, 0);
}

function hasTie(note: XEl, type: 'start' | 'stop'): boolean {
  for (const t of kids(note, 'tie')) if (t.getAttribute('type') === type) return true;
  const nots = kid(note, 'notations');
  if (nots) for (const t of kids(nots, 'tied')) if (t.getAttribute('type') === type) return true;
  return false;
}

export function buildTimeline(xml: string): Timeline {
  const doc = parseXml(xml);
  const parts = partsOf(doc);
  const timeSigs: Timeline['timeSigs'] = [];
  const perPart: { notes: RawNote[]; lens: number[] }[] = [];
  let measureCount = 0;

  parts.forEach((part, pi) => {
    const notes: RawNote[] = [];
    const lens: number[] = [];
    let divisions = 1;
    let transpose = 0;
    let beats = 4;
    let beatType = 4;
    const measures = kids(part, 'measure');
    measures.forEach((m, mi) => {
      let pos = 0; // in divisions
      let maxPos = 0;
      let lastStart = 0;
      for (const el of kids(m)) {
        switch (el.nodeName) {
          case 'attributes': {
            const d = kidNum(el, 'divisions');
            if (d && d > 0) divisions = d;
            const t = kid(el, 'transpose');
            if (t) transpose = (kidNum(t, 'chromatic') ?? 0) + 12 * (kidNum(t, 'octave-change') ?? 0);
            const time = kid(el, 'time');
            if (time) {
              const b = parseBeats(kidText(time, 'beats'));
              const bt = kidNum(time, 'beat-type');
              if (b && bt) {
                beats = b; beatType = bt;
                if (pi === 0) timeSigs.push({ measure: mi + 1, beats: b, beatType: bt });
              }
            }
            break;
          }
          case 'backup': pos -= kidNum(el, 'duration') ?? 0; break;
          case 'forward': pos += kidNum(el, 'duration') ?? 0; maxPos = Math.max(maxPos, pos); break;
          case 'note': {
            if (kid(el, 'grace')) break;
            const isChord = !!kid(el, 'chord');
            const isRest = !!kid(el, 'rest');
            let dur = kidNum(el, 'duration');
            if (dur === null && isRest) dur = (divisions * 4 * beats) / beatType;
            dur = dur ?? 0;
            const start = isChord ? lastStart : pos;
            if (!isRest) {
              const p = kid(el, 'pitch');
              const base = p ? pitchToMidi(p) : null;
              if (base !== null) {
                notes.push({
                  measureIdx: mi,
                  startQ: start / divisions,
                  durQ: dur / divisions,
                  midi: base + transpose,
                  tieStart: hasTie(el, 'start'),
                  tieStop: hasTie(el, 'stop'),
                });
              }
            }
            if (!isChord) { lastStart = pos; pos += dur; }
            maxPos = Math.max(maxPos, pos, start + dur);
            break;
          }
        }
      }
      lens[mi] = maxPos / divisions;
    });
    measureCount = Math.max(measureCount, measures.length);
    perPart.push({ notes, lens });
  });

  // Measure lengths: longest content across parts; fall back to the time signature when empty.
  const measureLens: number[] = [];
  let sigIdx = -1;
  for (let mi = 0; mi < measureCount; mi++) {
    while (sigIdx + 1 < timeSigs.length && timeSigs[sigIdx + 1].measure <= mi + 1) sigIdx++;
    let len = 0;
    for (const p of perPart) len = Math.max(len, p.lens[mi] ?? 0);
    if (len < EPS) {
      const s = sigIdx >= 0 ? timeSigs[sigIdx] : { beats: 4, beatType: 4 };
      len = (4 * s.beats) / s.beatType;
    }
    measureLens.push(len);
  }

  // Play order: unroll repeats / endings / jumps.
  const { flow, labels, barTotal } = readFlow(parts);
  let order0 = unrollMeasures(flow);
  if (order0.length === 0) order0 = measureLens.map((_, i) => i);
  const hasRepeats = order0.length !== measureCount || order0.some((v, i) => v !== i);
  const measureStartsQ: number[] = [];
  let acc = 0;
  for (const mi of order0) { measureStartsQ.push(acc); acc += measureLens[mi]; }

  const events: TimelineEvent[] = [];
  for (const p of perPart) {
    const byMeasure: RawNote[][] = Array.from({ length: measureCount }, () => []);
    for (const n of p.notes) byMeasure[n.measureIdx].push(n);
    const abs: (RawNote & { timeQ: number })[] = [];
    order0.forEach((mi, slot) => {
      for (const n of byMeasure[mi]) abs.push({ ...n, timeQ: measureStartsQ[slot] + n.startQ });
    });
    abs.sort((a, b) => a.timeQ - b.timeQ);
    const open = new Map<number, TimelineEvent>();
    for (const n of abs) {
      const prev = open.get(n.midi);
      if (n.tieStop && prev && Math.abs(prev.timeQ + prev.durQ - n.timeQ) < 1e-4) {
        prev.durQ += n.durQ;
        if (!n.tieStart) open.delete(n.midi);
        continue;
      }
      const ev: TimelineEvent = { timeQ: n.timeQ, durQ: n.durQ, midi: n.midi, measure: n.measureIdx + 1 };
      events.push(ev);
      if (n.tieStart) open.set(n.midi, ev); else open.delete(n.midi);
    }
  }
  events.sort((a, b) => a.timeQ - b.timeQ || a.midi - b.midi);
  return {
    events, measureStartsQ, totalQ: acc, timeSigs,
    order: order0.map((i) => i + 1), measureCount,
    barLabels: labels.length === measureCount ? labels : measureLens.map((_, i) => String(i + 1)),
    barTotal: barTotal || measureCount,
    hasRepeats,
  };
}

/** Index of the played bar that contains quarter-note position q (clamped). */
export function slotAt(tl: Timeline, q: number): number {
  const s = tl.measureStartsQ;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid] <= q + EPS) lo = mid; else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** Start (play-order quarters) of the FIRST time written bar `measure` (1-based) is played. */
export function firstQ(tl: Timeline, measure: number): number {
  for (let m = Math.max(1, Math.min(tl.measureCount, measure)); m <= tl.measureCount; m++) {
    const slot = tl.order.indexOf(m);
    if (slot >= 0) return tl.measureStartsQ[slot];
  }
  return 0;
}

/**
 * The bars between two bar starts (quarters, play order) as a timeline of their own that begins at 0: a practice loop
 * on its own. The written bar numbers and labels stay as they are. A note held over from before is not in it; a note
 * that runs past the end is cut there.
 */
export function sliceTimeline(tl: Timeline, startQ: number, endQ: number): Timeline {
  const from = Math.max(0, Math.min(tl.totalQ, startQ));
  const to = Math.max(from, Math.min(tl.totalQ, endQ));
  const slots: number[] = [];
  tl.measureStartsQ.forEach((q, i) => { if (q >= from - EPS && q < to - EPS) slots.push(i); });
  if (!slots.length) return tl;
  return {
    ...tl,
    events: tl.events
      .filter((e) => e.timeQ >= from - EPS && e.timeQ < to - EPS)
      .map((e) => ({ ...e, timeQ: Math.max(0, e.timeQ - from), durQ: Math.min(e.durQ, to - e.timeQ) })),
    measureStartsQ: slots.map((i) => tl.measureStartsQ[i] - from),
    totalQ: to - from,
    order: slots.map((i) => tl.order[i]),
  };
}

/** 1-based WRITTEN measure being played at quarter-note position q (clamped). */
export function measureAt(tl: Timeline, q: number): number {
  return tl.order[slotAt(tl, q)] ?? 1;
}

/** Distance in quarters from the start of the played bar that holds `timeQ`. */
export function offsetInBar(tl: Timeline, timeQ: number): number {
  return Math.max(0, timeQ - (tl.measureStartsQ[slotAt(tl, timeQ)] ?? 0));
}

/** Key that finds a note on the drawn score: written bar and offset into the bar. */
export const noteKey = (measure: number, offQ: number) => `${measure}:${Math.round(offQ * 1000)}`;
