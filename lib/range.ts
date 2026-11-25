import { INSTRUMENTS, type InstrumentId } from './instruments';
import { parseXml, serializeXml, partsOf, kids, kid, kidNum, setKidText } from './musicxml';

export interface RangeIssue { /** index into the event list */ index: number; measure: number; dir: 'high' | 'low'; written: number }

/** Written pitch (what is printed for `inst`) of a sounding pitch. */
export const writtenMidi = (inst: InstrumentId, sounding: number) => sounding - INSTRUMENTS[inst].writtenToConcert;

/** Notes outside the instrument's comfortable written range. */
export function outOfRange(events: { midi: number; measure: number }[], inst: InstrumentId): RangeIssue[] {
  const [lo, hi] = INSTRUMENTS[inst].writtenRange;
  const out: RangeIssue[] = [];
  events.forEach((e, index) => {
    const w = writtenMidi(inst, e.midi);
    if (w > hi) out.push({ index, measure: e.measure, dir: 'high', written: w });
    else if (w < lo) out.push({ index, measure: e.measure, dir: 'low', written: w });
  });
  return out;
}

/** One-line summary: "3 notes out of range: 3 too high (bars 5, 6)". */
export function describeRange(issues: RangeIssue[]): string {
  if (!issues.length) return '';
  const hi = issues.filter((i) => i.dir === 'high').length;
  const lo = issues.length - hi;
  const bars = [...new Set(issues.map((i) => i.measure))].sort((a, b) => a - b);
  const span = bars.length > 4 ? `${bars.length} bars` : `bar${bars.length > 1 ? 's' : ''} ${bars.join(', ')}`;
  const what = [hi ? `${hi} too high` : '', lo ? `${lo} too low` : ''].filter(Boolean).join(' and ');
  return `${issues.length} note${issues.length > 1 ? 's' : ''} out of range: ${what} (${span})`;
}

/** Move the pitched notes of bars `from`..`to` (1-based, inclusive) by whole octaves (+1 = 8va, -1 = 8vb). */
export function shiftOctaves(xml: string, from: number, to: number, octaves: number): string {
  if (!octaves) return xml;
  const doc = parseXml(xml);
  for (const part of partsOf(doc)) {
    kids(part, 'measure').forEach((m, i) => {
      if (i + 1 < from || i + 1 > to) return;
      for (const note of kids(m, 'note')) {
        const p = kid(note, 'pitch');
        const oct = p ? kidNum(p, 'octave') : null;
        if (p && oct !== null) setKidText(doc, p, 'octave', oct + octaves);
      }
    });
  }
  return serializeXml(doc);
}

/** A saved passage move: `octaves` applied to bars from..to of one part while playing as `target`. */
export interface OctaveShift { from: number; to: number; octaves: number; target: InstrumentId; /** Part id; absent = the first part. */ part?: string }

export function applyShifts(xml: string, shifts: OctaveShift[] | undefined, target: InstrumentId, part?: string): string {
  let out = xml;
  for (const s of shifts ?? []) if (s.target === target && (s.part ?? undefined) === (part ?? undefined)) out = shiftOctaves(out, s.from, s.to, s.octaves);
  return out;
}

/** Add a move to the saved list; the same bars moved again add up, and a move that cancels out disappears. */
export function addShift(list: OctaveShift[] | undefined, s: OctaveShift): OctaveShift[] {
  const out: OctaveShift[] = [];
  let merged = false;
  for (const x of list ?? []) {
    if (!merged && x.from === s.from && x.to === s.to && x.target === s.target && x.part === s.part) {
      merged = true;
      if (x.octaves + s.octaves !== 0) out.push({ ...x, octaves: x.octaves + s.octaves });
    } else out.push(x);
  }
  if (!merged) out.push(s);
  return out;
}

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const noteName = (midi: number) => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
/** "F#3 to C6": the comfortable written range of an instrument. */
export function rangeLabel(inst: InstrumentId): string {
  const [lo, hi] = INSTRUMENTS[inst].writtenRange;
  return `${noteName(lo)} to ${noteName(hi)}`;
}
