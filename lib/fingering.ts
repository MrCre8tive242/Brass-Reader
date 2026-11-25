import { INSTRUMENTS, type InstrumentId } from './instruments';

/** What to play for one note: the usual fingering first, other ways to play it after. */
export interface Fingering {
  kind: 'valves' | 'slide';
  /** "0" (open), "2", "1-3", "1-2-3" for valves; "1".."7" for the slide. */
  primary: string;
  alternates: string[];
}

/** Valves (or slide positions) that lower an open harmonic by 0 to 6 semitones. */
const VALVES = ['0', '2', '1', '1-2', '2-3', '1-3', '1-2-3'];

interface Chart { kind: 'valves' | 'slide'; /** open harmonics, in the pitch the chart reads (MIDI) */ partials: number[]; low: number; high: number; written: boolean }

// Bb trumpet and F mellophone: the same valve chart, read from the WRITTEN pitch (open: C4 G4 C5 E5 G5 C6).
const TRUMPET_LIKE: Chart = { kind: 'valves', partials: [60, 67, 72, 76, 79, 84], low: 54, high: 84, written: true };
// Bass-clef Bb instruments read CONCERT pitch (= what is written). Open harmonics of Bb: Bb2 F3 Bb3 D4 F4 Bb4.
const BB_PARTIALS = [46, 53, 58, 62, 65, 70];
const CHARTS: Record<InstrumentId, Chart> = {
  trumpet: TRUMPET_LIKE,
  mellophone: TRUMPET_LIKE,
  baritone: { kind: 'valves', partials: BB_PARTIALS, low: 40, high: 70, written: false }, // non-compensating 3-valve
  trombone: { kind: 'slide', partials: BB_PARTIALS, low: 40, high: 70, written: false },
  sousaphone: { kind: 'valves', partials: [34, 41, 46, 50, 53], low: 28, high: 53, written: false }, // 3-valve BBb
};

const label = (kind: Chart['kind'], drop: number) => (kind === 'slide' ? String(drop + 1) : VALVES[drop]);

/**
 * Fingering for a SOUNDING (concert) MIDI pitch on `inst`, or null when the note is outside the chart.
 * Trumpet and mellophone are looked up by their written pitch; the bass-clef instruments by concert pitch.
 */
export function fingeringFor(inst: InstrumentId, soundingMidi: number): Fingering | null {
  const c = CHARTS[inst];
  const pitch = c.written ? soundingMidi - INSTRUMENTS[inst].writtenToConcert : soundingMidi;
  if (!Number.isFinite(pitch) || pitch < c.low || pitch > c.high) return null;
  // every open harmonic at or above the note, at most 6 semitones away, can play it; the nearest is the usual way
  const ways = c.partials.filter((p) => p >= pitch && p - pitch <= 6).map((p) => p - pitch);
  if (!ways.length) return null;
  ways.sort((a, b) => a - b);
  const primary = label(c.kind, ways[0]);
  const alternates: string[] = [];
  for (const d of ways.slice(1)) alternates.push(label(c.kind, d));
  // the third valve alone is the usual substitute for 1-2 (both lower the pitch three semitones)
  if (c.kind === 'valves' && primary === '1-2') alternates.unshift('3');
  return { kind: c.kind, primary, alternates: [...new Set(alternates)].slice(0, 3) };
}

/** Text shown under a note: valves separated by dashes ("1-3"), "0" for open, slide position as a number. */
export function fingeringText(f: Fingering | null): string { return f ? f.primary : '—'; }
