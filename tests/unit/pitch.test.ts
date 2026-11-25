import { describe, it, expect } from 'vitest';
import { PitchRun, freqToMidi, judgeNote, judgedWindow, micErrorMessage, midiToFreq, summarise, type ExpectedNote, type Frame } from '@/lib/pitch';

const fr = (midi: number, n = 6, clarity = 0.97): Frame[] => Array.from({ length: n }, () => ({ midi, clarity }));

describe('judging one note', () => {
  it('green within 25 cents, yellow to 50 with a direction, red beyond', () => {
    expect(judgeNote(fr(60.1), 60)).toMatchObject({ status: 'green', reason: 'ok' });
    expect(judgeNote(fr(59.8), 60).status).toBe('green'); // -20 cents
    const sharp = judgeNote(fr(60.4), 60);
    expect(sharp).toMatchObject({ status: 'yellow', reason: 'sharp' });
    expect(sharp.cents).toBeCloseTo(40, 5);
    expect(judgeNote(fr(59.6), 60)).toMatchObject({ status: 'yellow', reason: 'flat' });
    expect(judgeNote(fr(61), 60)).toMatchObject({ status: 'red', reason: 'wrong' });
    expect(judgeNote(fr(48), 60)).toMatchObject({ status: 'red', reason: 'wrong' }); // an octave down is a wrong note
  });
  it('the 25 and 50 cent edges', () => {
    expect(judgeNote(fr(60.25), 60).status).toBe('green');
    expect(judgeNote(fr(60.26), 60).status).toBe('yellow');
    expect(judgeNote(fr(60.5), 60).status).toBe('yellow');
    expect(judgeNote(fr(60.51), 60).status).toBe('red');
  });
  it('too few clear frames means the note was missed', () => {
    expect(judgeNote([], 60)).toMatchObject({ status: 'red', reason: 'missed', cents: null });
    expect(judgeNote(fr(60, 2), 60).reason).toBe('missed');
    expect(judgeNote(fr(60, 10, 0.5), 60).reason).toBe('missed'); // noise, not a note
  });
  it('one wild frame does not spoil a good note (median)', () => {
    expect(judgeNote([...fr(60, 6), { midi: 72, clarity: 0.95 }], 60).status).toBe('green');
  });
  it('frequency conversion round trips', () => {
    expect(freqToMidi(440)).toBeCloseTo(69);
    expect(freqToMidi(midiToFreq(58.5))).toBeCloseTo(58.5);
  });
});

describe('following a play-through', () => {
  const notes: ExpectedNote[] = [
    { timeQ: 0, durQ: 1, midi: 60, measure: 1 },
    { timeQ: 1, durQ: 1, midi: 62, measure: 1 },
    { timeQ: 2, durQ: 1, midi: 64, measure: 2 },
    { timeQ: 3, durQ: 1, midi: 65, measure: 2 },
  ];
  /** Play the part: `heard[i]` is the pitch sounded for note i (null = silence). */
  function play(heard: (number | null)[], run = new PitchRun(notes)) {
    for (let q = 0; q < 4.2; q += 0.05) {
      const i = Math.min(3, Math.floor(q));
      const h = heard[i];
      run.push(q, h === null ? null : { midi: h, clarity: 0.97 });
    }
    run.finish();
    return run;
  }
  it('judges every note as it passes', () => {
    const run = play([60, 62.3, 70, null]);
    expect(run.results.map((r) => r?.status)).toEqual(['green', 'yellow', 'red', 'red']);
    expect(run.results[3]?.reason).toBe('missed');
  });
  it('notes that were over before the check started listening are left unjudged, not marked missed', () => {
    const run = new PitchRun(notes);
    for (let q = 2; q < 4.2; q += 0.05) run.push(q, { midi: q < 3 ? 64 : 65, clarity: 0.97 });
    run.finish();
    expect(run.results.map((r) => r?.status)).toEqual([undefined, undefined, 'green', 'green']);
  });
  it('a jump forward (seek) does not mark the skipped notes as missed', () => {
    const run = new PitchRun(notes);
    for (let q = 0; q < 1; q += 0.05) run.push(q, { midi: 60, clarity: 0.97 });
    for (let q = 3; q < 4.2; q += 0.05) run.push(q, { midi: 65, clarity: 0.97 });
    run.finish();
    expect(run.results[0]?.status).toBe('green');
    expect(run.results[1]).toBeUndefined();
    expect(run.results[2]).toBeUndefined();
    expect(run.results[3]?.status).toBe('green');
  });
  it('a perfect run is 100 %', () => {
    const run = play([60, 62, 64, 65]);
    const s = summarise(notes, run.results);
    expect(s).toMatchObject({ total: 4, green: 4, pct: 100, worstBars: [] });
  });
  it('summary: percent correct and the bars with the most misses first', () => {
    const run = play([60, 62.3, 70, null]);
    const s = summarise(notes, run.results);
    expect(s).toMatchObject({ total: 4, green: 1, yellow: 1, red: 2, pct: 25 });
    expect(s.worstBars).toEqual([{ measure: 2, misses: 2, notes: 2 }, { measure: 1, misses: 1, notes: 2 }]);
  });
  it('judges only the middle of a note, not the attack', () => {
    const [a, b] = judgedWindow(notes[0]);
    expect(a).toBeGreaterThan(0.2);
    expect(b).toBeLessThan(1);
    // a slide into the note during the attack does not count against it
    const run = new PitchRun(notes);
    for (let q = 0; q < 1; q += 0.05) run.push(q, { midi: q < 0.2 ? 57 : 60, clarity: 0.97 });
    run.push(1.5, null);
    expect(run.results[0]?.status).toBe('green');
  });
  it('a loop wraps: the second pass is judged afresh and replaces the first', () => {
    const run = new PitchRun(notes.slice(0, 2));
    const pass = (m: number) => { for (let q = 0; q < 2.1; q += 0.05) run.push(q, { midi: m, clarity: 0.97 }); };
    pass(70); // wrong
    pass(60); // note 1 right, note 2 (62) wrong
    run.finish();
    expect(run.results[0]?.status).toBe('green');
    expect(run.results[1]?.status).toBe('red');
  });
  it('notes never reached are not judged at all', () => {
    const run = new PitchRun(notes);
    for (let q = 0; q < 1.3; q += 0.05) run.push(q, { midi: 60, clarity: 0.97 });
    run.finish();
    expect(run.results[3]).toBeUndefined();
    expect(summarise(notes, run.results).total).toBeLessThan(4);
  });
});

describe('microphone problems', () => {
  it('says what to do', () => {
    expect(micErrorMessage({ name: 'NotAllowedError' })).toMatch(/blocked/i);
    expect(micErrorMessage({ name: 'NotFoundError' })).toMatch(/No microphone/);
    expect(micErrorMessage({ name: 'NotReadableError' })).toMatch(/busy/);
    expect(micErrorMessage({ name: 'unsupported' })).toMatch(/cannot use the microphone/);
    expect(micErrorMessage(new Error('x'))).toMatch(/could not be started/);
  });
});
