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
/** How clear a pitch must be to count while judging (a phone microphone on low brass is rarely cleaner than this). */
export const MIN_CLARITY = 0.85;
/** How clear it must be to be shown as "Hearing ...". */
export const SHOW_CLARITY = 0.9;
export const MIN_FRAMES = 3;
/** Frames this close to the written note (cents) are the player on that note; the rest are slides, splits and neighbours. */
const ON_NOTE_CENTS = 80;

export const freqToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);
export const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

export interface JudgeOpts {
  minFrames?: number;
  minClarity?: number;
  /** How many times the microphone was read while this note was being judged: a short note cannot give three clear readings. */
  ticks?: number;
}

/**
 * Verdict for one note: the frames heard while it should sound against the pitch it should have.
 * When a good share of the frames sit on the written note, the note is judged on those (how in tune it was), so the
 * tail of the note before or a splatter at the attack does not turn a right note red. Otherwise it is what was
 * mostly heard: a wrong note.
 */
export function judgeNote(frames: Frame[], expectedMidi: number, opts: JudgeOpts = {}): NoteResult {
  const minClarity = opts.minClarity ?? MIN_CLARITY;
  const voiced = frames.filter((f) => f.clarity >= minClarity && Number.isFinite(f.midi));
  const want = opts.minFrames ?? MIN_FRAMES;
  // a sixteenth at a quick tempo is read two or three times in all: one or two clear readings must do
  const need = opts.ticks !== undefined ? Math.max(1, Math.min(want, Math.round(opts.ticks * 0.34))) : want;
  if (voiced.length < need) return { status: 'red', cents: null, reason: 'missed', frames: voiced.length };
  const on = voiced.filter((f) => Math.abs(f.midi - expectedMidi) * 100 <= ON_NOTE_CENTS);
  const use = on.length >= need && on.length >= voiced.length * 0.35 ? on : voiced;
  const cents = (median(use.map((f) => f.midi)) - expectedMidi) * 100;
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
  private ticks: number[];
  private prevQ = -Infinity;

  constructor(readonly notes: ExpectedNote[], private opts: { minFrames?: number; minClarity?: number } = {}) {
    this.results = notes.map(() => undefined);
    this.buf = notes.map(() => []);
    this.win = notes.map(judgedWindow);
    this.judged = notes.map(() => false);
    this.ticks = notes.map(() => 0);
  }

  /** The note that should be sounding at `q` (its pitch tells the microphone which octave to expect); null in a rest. */
  expectedAt(q: number): number | null {
    return expectedAt(this.notes, q);
  }

  /** `frame` null = silence or no clear pitch. Returns indexes of notes judged by this call. */
  push(q: number, frame: Frame | null): number[] {
    const done: number[] = [];
    if (q < this.prevQ - 0.5) {
      // looped or jumped back: close what was open, start a fresh pass
      for (const i of this.open(this.prevQ + 1e-6)) done.push(this.close(i));
      this.judged = this.notes.map(() => false);
      this.buf = this.notes.map(() => []);
      this.ticks = this.notes.map(() => 0);
    }
    // the first reading (the check began mid-score, or the microphone opened late) and a jump forward (a seek):
    // notes that were already over were never listened to, so they are left unjudged instead of marked missed
    if (this.prevQ === -Infinity || q - this.prevQ > 1.5) {
      for (let i = 0; i < this.notes.length; i++) if (!this.judged[i] && this.win[i][1] < q) this.judged[i] = true;
    }
    this.prevQ = q;
    for (let i = 0; i < this.notes.length; i++) {
      if (this.win[i][0] > q) { if (this.notes[i].timeQ > q + 8) break; continue; }
      if (this.judged[i]) continue;
      if (q <= this.win[i][1]) { this.ticks[i]++; if (frame) this.buf[i].push(frame); }
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
    this.results[i] = judgeNote(this.buf[i], this.notes[i].midi, { ...this.opts, ticks: this.ticks[i] });
    return i;
  }
}

/** Index of the last note that starts at or before `q` (notes in time order); -1 when none has started. */
function lastStarted(notes: ExpectedNote[], q: number): number {
  let lo = 0, hi = notes.length - 1, at = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (notes[mid].timeQ <= q) { at = mid; lo = mid + 1; } else hi = mid - 1; }
  return at;
}

/** The pitch (MIDI) of the note that should be sounding at `q`, or null in a rest. */
export function expectedAt(notes: ExpectedNote[], q: number): number | null {
  for (let i = lastStarted(notes, q); i >= 0 && notes[i].timeQ > q - 16; i--) if (q < notes[i].timeQ + notes[i].durQ) return notes[i].midi;
  return null;
}

/** How loud the sound in `buf` is at frequency `hz` (one bin of a spectrum, with a Hann window). */
function toneEnergy(buf: ArrayLike<number>, rate: number, hz: number): number {
  const n = buf.length, w = (2 * Math.PI * hz) / rate, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = buf[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))) + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

/** The share of a tone's energy that sits on the odd harmonics of `hz` (1st, 3rd, 5th, 7th) among its first eight. */
export function oddShare(buf: ArrayLike<number>, rate: number, hz: number): number {
  let odd = 0, even = 0;
  const top = Math.min(rate * 0.45, 6000);
  for (let k = 1; k <= 8; k++) {
    if (k * hz > top) break;
    const e = toneEnergy(buf, rate, k * hz);
    if (k % 2) odd += e; else even += e;
  }
  return odd + even > 0 ? odd / (odd + even) : 0;
}

/**
 * A pitch detector hears low brass through a phone an octave out now and then (the microphone barely passes the
 * fundamental). When the pitch heard is an octave from the note that is written, look at the sound itself: a real
 * note has energy on the ODD harmonics of its fundamental, a note an octave higher has none there. Returns the
 * pitch moved to the written octave only when the sound says so; a note really played an octave out stays wrong.
 */
export function resolveOctave(buf: ArrayLike<number>, rate: number, hz: number, expectedHz: number): number {
  if (!(hz > 0) || !(expectedHz > 0)) return hz;
  const cents = 1200 * Math.log2(hz / expectedHz);
  if (Math.abs(cents - 1200) < 90) {
    // heard an octave above the written note: is there a fundamental an octave below it after all?
    return oddShare(buf, rate, hz / 2) >= 0.03 ? hz / 2 : hz;
  }
  if (Math.abs(cents + 1200) < 90) {
    // heard an octave below: a real low note has odd harmonics of its own; a sub-octave ghost has none
    return oddShare(buf, rate, hz) < 0.04 ? hz * 2 : hz;
  }
  return hz;
}

/** Samples to analyse at a time: at least six periods of the lowest note of the part, and never less than 40 ms. */
export function windowFor(lowestHz: number, rate: number): 2048 | 4096 | 8192 {
  const need = Math.max(0.04, 6 / Math.max(20, lowestHz)) * rate;
  return need <= 2048 ? 2048 : need <= 4096 ? 4096 : 8192;
}

/**
 * Tells the player's sound from the room. A band room is never quiet: drums, other horns across the room and the
 * backing from the phone's own speaker all reach the microphone. The gate listens to how loud the unpitched noise
 * is and how loud the player's own clear notes are, and lets a sound count when it stands above the noise and is
 * not far below the player's usual level (a horn at arm's length is much louder than one across the room).
 * In a quiet room nearly everything counts; a soft passage after a loud one still counts.
 */
export class NoiseGate {
  private noiseHist: number[] = [];
  private i = 0;
  private n = 0;
  /** Level of the unpitched sound in the room (median of the recent readings without a clear pitch). */
  noise = 0;
  /** The player's level: the loudest clear note lately (it fades over some seconds). */
  peak = 0;
  /**
   * `size` unpitched readings are remembered; `halfLife` is how many readings it takes the remembered peak to halve
   * (about 8 seconds at 50 readings a second); nothing under `min` ever counts.
   */
  constructor(private size = 300, private halfLife = 400, private min = 0.004) {}

  /** The level a sound must reach right now. */
  get threshold(): number {
    const overNoise = this.peak > 0 ? Math.min(2 * this.noise, 0.5 * this.peak) : 2 * this.noise;
    return Math.max(this.min, 0.1 * this.peak, overNoise);
  }

  /** Feed the loudness (RMS) and the pitch clarity (0..1) of the newest reading; true when it counts as the player. */
  pass(rms: number, clarity: number): boolean {
    if (!Number.isFinite(rms) || rms < 0) return false;
    this.peak *= Math.pow(0.5, 1 / this.halfLife);
    if (clarity < 0.5) {
      if (this.noiseHist.length < this.size) this.noiseHist.push(rms); else this.noiseHist[this.i] = rms;
      this.i = (this.i + 1) % this.size;
      if (this.n++ % 10 === 0) { const sorted = [...this.noiseHist].sort((a, b) => a - b); this.noise = sorted[sorted.length >> 1]; }
    }
    const ok = rms >= this.threshold;
    if (clarity >= 0.85 && rms > this.peak) this.peak = rms;
    return ok;
  }
}

/**
 * Learns how late the player's notes arrive at the microphone compared with where the score says they are.
 * The delay of speakers, Bluetooth headphones and microphones is only roughly known to the browser, and people play
 * a little behind or ahead; every time the pitch heard changes to the next written note, the moment is compared with
 * the moment the note was due. The middle of the last few such moments is the delay the pitch check works with,
 * so each note is judged on its own sound and not on its neighbour's.
 */
export class LagTracker {
  /** Seconds the notes arrive late (negative: early), on top of the delay the browser reports. */
  lagS: number;
  private errs: number[] = [];
  private prevMidi: number | null = null;
  private counted = -1;
  /** `settleS`: how long after a note starts the microphone can first read its pitch (half the analysis window and the attack). */
  constructor(initialS = 0, private settleS = 0.05, private minS = -0.12, private maxS = 0.4) {
    this.lagS = Math.max(minS, Math.min(maxS, Number.isFinite(initialS) ? initialS : 0));
  }

  get samples() { return this.errs.length; }
  reset() { this.errs = []; this.prevMidi = null; this.counted = -1; this.lagS = 0; }

  /** `q`: where the score is by the browser's own reckoning; `midi`: the pitch heard now (null: nothing clear). */
  observe(notes: ExpectedNote[], q: number, bpm: number, midi: number | null): void {
    const before = this.prevMidi;
    this.prevMidi = midi;
    if (midi === null || !(bpm > 0) || !notes.length) return;
    // only the moment the sound CHANGES tells the time: from silence, or from another pitch
    if (before !== null && Math.abs(before - midi) <= 0.6) return;
    const spq = 60 / bpm;
    const here = q - this.lagS / spq; // where the player is, by what has been learned so far
    // the written note with this pitch whose start is nearest: it may have started up to 0.4 s ago or be 0.2 s away
    let best = -1, bestD = Infinity;
    for (let i = lastStarted(notes, here + 0.2 / spq); i >= 0 && notes[i].timeQ >= here - 0.4 / spq; i--) {
      if (Math.abs(notes[i].midi - midi) > 0.6) continue;
      const d = Math.abs(notes[i].timeQ - here);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0 || best === this.counted) return; // a wrong note, or this note's start was already timed
    // the written music must change there too: a new pitch, or the same pitch after a rest
    const prev = best > 0 ? notes[best - 1] : null;
    const fresh = !prev || Math.abs(prev.midi - notes[best].midi) >= 0.9 || notes[best].timeQ - (prev.timeQ + prev.durQ) > 0.2 / spq;
    if (!fresh) return;
    this.counted = best;
    this.errs.push((q - notes[best].timeQ) * spq - this.settleS);
    if (this.errs.length > 15) this.errs.shift();
    if (this.errs.length >= 4) {
      // late readings (a dropout in a held note, a slow attack) are common, early ones are not: lean on the early side
      const sorted = [...this.errs].sort((x, y) => x - y);
      this.lagS = Math.max(this.minS, Math.min(this.maxS, sorted[Math.floor((sorted.length - 1) * 0.35)]));
    }
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
