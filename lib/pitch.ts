/**
 * Pitch check: judging what the player sounds against what the part says, note by note.
 * Pure logic (no microphone here): frames of detected pitch go in, a verdict per written note comes out.
 */

export type NoteStatus = 'green' | 'yellow' | 'red';
export interface Frame { /** Detected pitch as a (fractional) MIDI number. */ midi: number; clarity: number }
export interface NoteResult {
  status: NoteStatus;
  /** Median deviation from the expected pitch in cents (+ sharp, - flat); null when nothing was heard. */
  cents: number | null;
  reason: 'ok' | 'sharp' | 'flat' | 'wrong' | 'missed';
  frames: number;
}

export const GREEN_CENTS = 25;
export const YELLOW_CENTS = 50;
export const MIN_CLARITY = 0.9;
export const MIN_FRAMES = 3;

export const freqToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);
export const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Verdict for one note: the frames heard while it should sound against the pitch it should have. */
export function judgeNote(frames: Frame[], expectedMidi: number, opts: { minFrames?: number; minClarity?: number } = {}): NoteResult {
  const minClarity = opts.minClarity ?? MIN_CLARITY;
  const voiced = frames.filter((f) => f.clarity >= minClarity && Number.isFinite(f.midi));
  if (voiced.length < (opts.minFrames ?? MIN_FRAMES)) return { status: 'red', cents: null, reason: 'missed', frames: voiced.length };
  const cents = (median(voiced.map((f) => f.midi)) - expectedMidi) * 100;
  const a = Math.abs(cents);
  if (a <= GREEN_CENTS) return { status: 'green', cents, reason: 'ok', frames: voiced.length };
  if (a <= YELLOW_CENTS) return { status: 'yellow', cents, reason: cents > 0 ? 'sharp' : 'flat', frames: voiced.length };
  return { status: 'red', cents, reason: 'wrong', frames: voiced.length };
}

export interface ExpectedNote { timeQ: number; durQ: number; midi: number; measure: number }

/** The part of a note that is judged: skip the attack (the pitch settles) and the very end (the next note starts). */
export function judgedWindow(n: ExpectedNote): [number, number] {
  const a = n.timeQ + Math.min(0.25 * n.durQ, 0.5);
  const b = n.timeQ + n.durQ - Math.min(0.1 * n.durQ, 0.12);
  return [a, Math.max(a + 0.05, b)];
}

/**
 * Follows a play-through. Feed it the position the player SHOULD be at (already corrected for latency) with
 * the pitch heard then; it returns the notes it could judge. Looping and seeking start a new pass.
 */
export class PitchRun {
  results: (NoteResult | undefined)[];
  private buf: Frame[][];
  private win: [number, number][];
  private judged: boolean[];
  private prevQ = -Infinity;

  constructor(readonly notes: ExpectedNote[], private opts: { minFrames?: number; minClarity?: number } = {}) {
    this.results = notes.map(() => undefined);
    this.buf = notes.map(() => []);
    this.win = notes.map(judgedWindow);
    this.judged = notes.map(() => false);
  }

  /** `frame` null = silence or no clear pitch. Returns indexes of notes judged by this call. */
  push(q: number, frame: Frame | null): number[] {
    const done: number[] = [];
    if (q < this.prevQ - 0.5) {
      // looped or jumped back: close what was open, start a fresh pass
      for (const i of this.open(this.prevQ + 1e-6)) done.push(this.close(i));
      this.judged = this.notes.map(() => false);
      this.buf = this.notes.map(() => []);
    }
    this.prevQ = q;
    for (let i = 0; i < this.notes.length; i++) {
      if (this.win[i][0] > q) { if (this.notes[i].timeQ > q + 8) break; continue; }
      if (this.judged[i]) continue;
      if (q <= this.win[i][1]) { if (frame) this.buf[i].push(frame); }
      else done.push(this.close(i));
    }
    return done;
  }

  /** End of the run: every note whose time has come is judged; notes never reached stay unjudged. */
  finish(): number[] {
    return this.open(this.prevQ).map((i) => this.close(i));
  }

  private open(upTo: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.notes.length; i++) if (!this.judged[i] && this.win[i][0] <= upTo) out.push(i);
    return out;
  }

  private close(i: number): number {
    this.judged[i] = true;
    this.results[i] = judgeNote(this.buf[i], this.notes[i].midi, this.opts);
    return i;
  }
}

export interface RunSummary {
  total: number;
  green: number;
  yellow: number;
  red: number;
  /** Percent of judged notes that were in tune (green), null when nothing was judged. */
  pct: number | null;
  /** Bars with the most notes that were not green, worst first (written bar numbers). */
  worstBars: { measure: number; misses: number; notes: number }[];
}

export function summarise(notes: ExpectedNote[], results: (NoteResult | undefined)[]): RunSummary {
  let green = 0, yellow = 0, red = 0;
  const bars = new Map<number, { misses: number; notes: number }>();
  notes.forEach((n, i) => {
    const r = results[i];
    if (!r) return;
    const b = bars.get(n.measure) ?? { misses: 0, notes: 0 };
    b.notes++;
    if (r.status === 'green') green++;
    else { b.misses++; if (r.status === 'yellow') yellow++; else red++; }
    bars.set(n.measure, b);
  });
  const total = green + yellow + red;
  const worstBars = [...bars.entries()]
    .filter(([, b]) => b.misses > 0)
    .map(([measure, b]) => ({ measure, ...b }))
    .sort((a, b) => b.misses - a.misses || a.measure - b.measure)
    .slice(0, 3);
  return { total, green, yellow, red, pct: total ? Math.round((green / total) * 100) : null, worstBars };
}

/** What to tell the player when the microphone cannot be used. */
export function micErrorMessage(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? '';
  if (name === 'unsupported') return 'This browser cannot use the microphone here. Open the app over https in a recent Chrome, Safari or Firefox.';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'The microphone is blocked. Allow microphone access for this site in the browser settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Plug one in (or put headphones with a microphone on) and try again.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is busy in another app. Close it there and try again.';
  return 'The microphone could not be started. Try again, or reload the page.';
}
