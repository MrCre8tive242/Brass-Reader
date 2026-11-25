import {
  parseXml, partsOf, kids, kid, kidNum, kidText, pitchToMidi, type XEl,
} from './musicxml';

export interface TimelineEvent {
  /** Start, in quarter notes from the start of the score. */
  timeQ: number;
  durQ: number;
  /** SOUNDING (concert) MIDI pitch: the part's <transpose> is applied. */
  midi: number;
  /** 1-based measure index. */
  measure: number;
}

export interface Timeline {
  events: TimelineEvent[];
  measureStartsQ: number[];
  totalQ: number;
  timeSigs: { measure: number; beats: number; beatType: number }[];
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
  const measureStartsQ: number[] = [];
  let acc = 0;
  for (const l of measureLens) { measureStartsQ.push(acc); acc += l; }

  const events: TimelineEvent[] = [];
  for (const p of perPart) {
    const abs = p.notes
      .map((n) => ({ ...n, timeQ: measureStartsQ[n.measureIdx] + n.startQ }))
      .sort((a, b) => a.timeQ - b.timeQ);
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
  return { events, measureStartsQ, totalQ: acc, timeSigs };
}

/** 1-based measure containing quarter-note position q (clamped). */
export function measureAt(tl: Timeline, q: number): number {
  const s = tl.measureStartsQ;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid] <= q + EPS) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}
