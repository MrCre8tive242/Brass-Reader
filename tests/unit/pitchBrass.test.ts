import { describe, it, expect } from 'vitest';
import { PitchDetector } from 'pitchy';
import {
  LagTracker, NoiseGate, PitchRun, expectedAt, freqToMidi, judgeNote, midiToFreq, oddShare, resolveOctave, windowFor,
  type ExpectedNote, type Frame,
} from '@/lib/pitch';

const RATE = 48000;

/**
 * A brass tone as a phone hears it: harmonics falling off gently (brass is bright), the microphone's high-pass
 * taking away the bottom (`cutHz`, 12 dB an octave), a little room noise.
 */
function brass(hz: number, n: number, opts: { cutHz?: number; noise?: number; seed?: number; /** Level of the odd harmonics against the even ones (1 = a plain tone). */ odd?: number } = {}): Float32Array {
  const cut = opts.cutHz ?? 0;
  let seed = opts.seed ?? 5;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  const x = new Float32Array(n);
  for (let k = 1; k * hz < 5000; k++) {
    const f = k * hz;
    const mic = cut ? (f / cut) ** 2 / Math.sqrt(1 + (f / cut) ** 4) : 1;
    const a = (1 / Math.pow(k, 0.8)) * mic * (k % 2 ? opts.odd ?? 1 : 1), ph = k * 1.3;
    for (let i = 0; i < n; i++) x[i] += a * Math.sin((2 * Math.PI * f * i) / RATE + ph);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  for (let i = 0; i < n; i++) x[i] = (x[i] / peak) * 0.5 + (opts.noise ?? 0.01) * rnd();
  return x;
}

/** What the microphone code does with one window of sound. */
function hear(buf: Float32Array, expectedHz: number | null) {
  const [hz, clarity] = PitchDetector.forFloat32Array(buf.length).findPitch(buf, RATE);
  return { raw: hz, hz: expectedHz ? resolveOctave(buf, RATE, hz, expectedHz) : hz, clarity };
}
const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

describe('listening for long enough', () => {
  it('six periods of the lowest note, never under 40 ms', () => {
    expect(windowFor(midiToFreq(52), 48000)).toBe(2048); // trumpet low E3 (165 Hz)
    expect(windowFor(midiToFreq(52), 44100)).toBe(2048);
    expect(windowFor(midiToFreq(40), 48000)).toBe(4096); // trombone / baritone low E2 (82 Hz)
    expect(windowFor(midiToFreq(28), 48000)).toBe(8192); // sousaphone low E1 (41 Hz)
    expect(windowFor(midiToFreq(34), 48000)).toBe(8192); // sousaphone Bb1 (58 Hz)
    expect(windowFor(2000, 48000)).toBe(2048);
    expect(windowFor(0, 48000)).toBe(8192);
  });
});

describe('low brass through a phone microphone: the right octave', () => {
  it('reads sousaphone and baritone notes in their octave although the phone passes almost none of the fundamental', () => {
    // E1 to Bb2: sousaphone and the bottom of the baritone / trombone, phone microphone rolling off under 250 Hz
    for (const midi of [28, 31, 34, 36, 39, 41, 43, 46]) {
      const f = midiToFreq(midi);
      const n = windowFor(f, RATE);
      for (const detune of [-18, 0, 22]) {
        const played = f * Math.pow(2, detune / 1200);
        const h = hear(brass(played, n, { cutHz: 250, noise: 0.015, seed: midi }), f);
        expect(Math.abs(cents(h.hz, played)), `MIDI ${midi} ${detune} cents (raw ${h.raw.toFixed(1)} Hz)`).toBeLessThan(12);
        expect(h.clarity).toBeGreaterThan(0.85);
      }
    }
  });

  it('a detector an octave too high is put right when the sound has the odd harmonics of the written note', () => {
    const f = midiToFreq(34); // Bb1, 58 Hz
    const buf = brass(f, 8192, { cutHz: 300 });
    expect(oddShare(buf, RATE, f)).toBeGreaterThan(0.2);
    expect(resolveOctave(buf, RATE, 2 * f, f)).toBeCloseTo(f, 6);
    expect(resolveOctave(buf, RATE, 2 * f * 1.01, f)).toBeCloseTo(f * 1.01, 6); // keeps how sharp it was
  });

  it('where the detector does go an octave up (odd harmonics nearly gone: a boomy room, a bad microphone), the sound puts it right', () => {
    let rawWrong = 0;
    for (const midi of [29, 34, 38, 41, 45]) {
      const f = midiToFreq(midi);
      const h = hear(brass(f, windowFor(f, RATE), { odd: 0.15, noise: 0.03, seed: midi }), f);
      if (Math.abs(cents(h.raw, f)) > 600) rawWrong++;
      expect(Math.abs(cents(h.hz, f)), `MIDI ${midi}`).toBeLessThan(15);
    }
    expect(rawWrong).toBeGreaterThanOrEqual(4); // the detector alone would have marked these right notes wrong
  });

  it('a note really played an octave too high stays wrong', () => {
    const f = midiToFreq(46); // written Bb2, played Bb3
    const buf = brass(2 * f, 4096, { cutHz: 200 });
    expect(oddShare(buf, RATE, f)).toBeLessThan(0.05);
    const h = hear(buf, f);
    expect(Math.abs(cents(h.hz, 2 * f))).toBeLessThan(10);
    expect(judgeNote(Array.from({ length: 5 }, () => ({ midi: freqToMidi(h.hz), clarity: h.clarity })), 46).reason).toBe('wrong');
    // the same on a trumpet: C4 written, C5 played (both open)
    const t = brass(midiToFreq(70), 2048);
    expect(Math.abs(cents(hear(t, midiToFreq(58)).hz, midiToFreq(70)))).toBeLessThan(10);
  });

  it('a ghost an octave below is lifted; a note really played an octave low is not', () => {
    const f = midiToFreq(58);
    const high = brass(f, 4096);
    expect(resolveOctave(high, RATE, f / 2, f)).toBeCloseTo(f, 6); // the detector said half: nothing is there
    const low = brass(f / 2, 4096);
    expect(resolveOctave(low, RATE, f / 2, f)).toBeCloseTo(f / 2, 6); // really an octave low
    // other intervals are left alone
    expect(resolveOctave(high, RATE, f * 1.5, f)).toBe(f * 1.5);
    expect(resolveOctave(high, RATE, f, f)).toBe(f);
    expect(resolveOctave(high, RATE, 0, f)).toBe(0);
  });
});

describe('the player against the room', () => {
  const feed = (g: NoiseGate, rms: number, clarity: number, n: number) => { let last = false; for (let i = 0; i < n; i++) last = g.pass(rms, clarity); return last; };
  it('in a quiet room a soft note counts and silence does not', () => {
    const g = new NoiseGate();
    feed(g, 0.0008, 0.1, 100);
    expect(g.pass(0.003, 0.95)).toBe(false);
    expect(g.pass(0.012, 0.95)).toBe(true);
  });
  it('in a loud band room only what stands above the noise counts', () => {
    const g = new NoiseGate();
    feed(g, 0.05, 0.2, 200); // drums and chatter
    expect(g.pass(0.07, 0.9)).toBe(false); // a horn across the room, barely above the din
    expect(g.pass(0.3, 0.95)).toBe(true); // the player's own horn at the phone
  });
  it('a horn across the room is not taken for the player, but the player playing softly is', () => {
    const g = new NoiseGate();
    feed(g, 0.002, 0.1, 100);
    feed(g, 0.4, 0.97, 50); // the player
    expect(g.pass(0.02, 0.95)).toBe(false); // 26 dB under the player: someone else
    expect(g.pass(0.06, 0.95)).toBe(true); // the player, piano
  });
  it('a long held tone never shuts itself out, and the memory of a loud passage fades', () => {
    const g = new NoiseGate();
    feed(g, 0.002, 0.1, 50);
    expect(feed(g, 0.3, 0.97, 1500)).toBe(true); // half a minute of one note
    feed(g, 0.002, 0.1, 1600); // half a minute of rest
    expect(g.pass(0.02, 0.95)).toBe(true);
    expect(g.pass(NaN, 1)).toBe(false);
  });
});

// a tune in eighths and quarters at 120 BPM: C D E F | G . E . | D D E C (the two Ds are tongued)
const TUNE: ExpectedNote[] = (() => {
  const seq: [number, number][] = [[60, 0.5], [62, 0.5], [64, 0.5], [65, 0.5], [67, 1], [64, 1], [62, 0.5], [62, 0.5], [64, 0.5], [60, 0.5], [67, 0.5], [65, 0.5], [64, 0.5], [62, 0.5], [60, 2]];
  let q = 0;
  return seq.map(([midi, durQ]) => { const n = { timeQ: q, durQ, midi, measure: 1 + Math.floor(q / 4) }; q += durQ; return n; });
})();
const END_Q = TUNE[TUNE.length - 1].timeQ + TUNE[TUNE.length - 1].durQ;

/**
 * Play the tune into the pitch check: the player's notes reach the microphone `lateS` after the score says, the
 * microphone is read every 20 ms and needs `settleS` before a new note reads clean. Returns the verdicts.
 */
function playTune(lateS: number, tracker: LagTracker | null, opts: { bpm?: number; settleS?: number; wrong?: number[]; dropoutAt?: number } = {}) {
  const bpm = opts.bpm ?? 120, spq = 60 / bpm, settle = opts.settleS ?? 0.05;
  const run = new PitchRun(TUNE);
  for (let t = 0; t < END_Q * spq + 0.5; t += 0.02) {
    const q = t / spq; // where the score is (latency known to the browser already taken off)
    const playedQ = q - lateS / spq; // what the player's sound at the microphone corresponds to
    const i = TUNE.findIndex((n) => playedQ >= n.timeQ && playedQ < n.timeQ + n.durQ);
    let frame: Frame | null = null;
    if (i >= 0) {
      const into = (playedQ - TUNE[i].timeQ) * spq;
      const left = (TUNE[i].timeQ + TUNE[i].durQ - playedQ) * spq;
      const dropped = opts.dropoutAt !== undefined && i === opts.dropoutAt && into > 0.3 && into < 0.4;
      // unclear while the attack settles and while the next note is taking over
      if (into >= settle && left > 0.015 && !dropped) frame = { midi: opts.wrong?.includes(i) ? TUNE[i].midi + 3 : TUNE[i].midi + 0.05, clarity: 0.95 };
    }
    tracker?.observe(TUNE, q, bpm, frame ? frame.midi : null);
    run.push(q - ((tracker?.lagS ?? 0) * bpm) / 60, frame);
  }
  run.finish();
  return run.results.map((r) => r?.status);
}

describe('learning how late the notes arrive', () => {
  it('Bluetooth headphones (200 ms late): without it right notes turn red, with it the delay is learned in a few notes', () => {
    const blind = playTune(0.2, null);
    expect(blind.filter((s) => s === 'red').length).toBeGreaterThan(4);
    const tr = new LagTracker(0, 0.05);
    playTune(0.2, tr); // the first time through, it learns
    expect(tr.samples).toBeGreaterThanOrEqual(8);
    expect(Math.abs(tr.lagS - 0.2)).toBeLessThan(0.03);
    expect(playTune(0.2, tr).every((s) => s === 'green')).toBe(true); // the second time, every right note is green
  });

  it('finds no delay where there is none, and follows a player who is a little ahead', () => {
    const tr = new LagTracker(0, 0.05);
    expect(playTune(0, tr).every((s) => s === 'green')).toBe(true);
    expect(Math.abs(tr.lagS)).toBeLessThan(0.03);
    const early = new LagTracker(0, 0.05);
    playTune(-0.06, early);
    expect(early.lagS).toBeLessThan(-0.03);
    expect(early.lagS).toBeGreaterThan(-0.09);
  });

  it('works at other tempos and remembers what it learned', () => {
    const tr = new LagTracker(0, 0.05);
    playTune(0.15, tr, { bpm: 90 });
    expect(Math.abs(tr.lagS - 0.15)).toBeLessThan(0.03);
    const again = new LagTracker(tr.lagS, 0.05); // next session on this phone
    expect(playTune(0.15, again, { bpm: 150 }).every((s) => s === 'green')).toBe(true);
    again.reset();
    expect(again.lagS).toBe(0);
    expect(new LagTracker(5).lagS).toBeLessThanOrEqual(0.4); // nonsense from storage is kept in bounds
    expect(new LagTracker(NaN).lagS).toBe(0);
  });

  it('wrong notes, a dropout in a held note and repeated notes do not mislead it', () => {
    const tr = new LagTracker(0, 0.05);
    const res = playTune(0.12, tr, { wrong: [2, 9], dropoutAt: 14 });
    expect(Math.abs(tr.lagS - 0.12)).toBeLessThan(0.035);
    const second = playTune(0.12, tr, { wrong: [2, 9], dropoutAt: 14 });
    expect(second[2]).toBe('red');
    expect(second[9]).toBe('red');
    expect(second.filter((s) => s === 'green').length).toBe(TUNE.length - 2);
    void res;
    // a held note alone says nothing
    const hold = new LagTracker(0, 0.05);
    for (let t = 0; t < 3; t += 0.02) hold.observe([{ timeQ: 0, durQ: 8, midi: 60, measure: 1 }], t * 2 + 1, 120, 60);
    expect(hold.samples).toBeLessThanOrEqual(1);
    expect(hold.lagS).toBe(0);
  });
});

describe('judging short notes and note changes', () => {
  it('a sixteenth read only three times can be right on one or two clear readings, and a long note still needs three', () => {
    const f = (n: number): Frame[] => Array.from({ length: n }, () => ({ midi: 60.05, clarity: 0.95 }));
    expect(judgeNote(f(1), 60, { ticks: 3 }).status).toBe('green');
    expect(judgeNote(f(2), 60, { ticks: 6 }).status).toBe('green');
    expect(judgeNote(f(2), 60, { ticks: 20 }).reason).toBe('missed');
    expect(judgeNote([], 60, { ticks: 2 }).reason).toBe('missed');
    expect(judgeNote(f(2), 60).reason).toBe('missed'); // no count given: the old rule
  });
  it('the tail of the note before does not turn a right note red, but a wrong note stays wrong', () => {
    const mix: Frame[] = [...Array.from({ length: 3 }, () => ({ midi: 62, clarity: 0.95 })), ...Array.from({ length: 3 }, () => ({ midi: 64.1, clarity: 0.95 }))];
    expect(judgeNote(mix, 64, { ticks: 7 })).toMatchObject({ status: 'green', reason: 'ok' });
    const mostlyWrong: Frame[] = [...Array.from({ length: 9 }, () => ({ midi: 62, clarity: 0.95 })), { midi: 64, clarity: 0.95 }];
    expect(judgeNote(mostlyWrong, 64, { ticks: 10 }).reason).toBe('wrong');
    // in tune is still measured on the note itself: 40 cents sharp is yellow
    const sharp: Frame[] = [...Array.from({ length: 2 }, () => ({ midi: 62, clarity: 0.95 })), ...Array.from({ length: 5 }, () => ({ midi: 64.4, clarity: 0.95 }))];
    expect(judgeNote(sharp, 64, { ticks: 8 })).toMatchObject({ status: 'yellow', reason: 'sharp' });
  });
  it('knows which note should be sounding', () => {
    expect(expectedAt(TUNE, 0.2)).toBe(60);
    expect(expectedAt(TUNE, 0.5)).toBe(62);
    expect(expectedAt(TUNE, 2.9)).toBe(67);
    expect(expectedAt(TUNE, -1)).toBeNull();
    expect(expectedAt(TUNE, END_Q + 0.1)).toBeNull();
    expect(expectedAt([{ timeQ: 0, durQ: 1, midi: 60, measure: 1 }, { timeQ: 2, durQ: 1, midi: 62, measure: 1 }], 1.5)).toBeNull(); // a rest
    expect(new PitchRun(TUNE).expectedAt(4.6)).toBe(62);
  });
});
