import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { detectOnsets, estimateTempo, foldTempo, bpmFromTaps, guessBars, buildSlices, encodeWav } from '@/lib/grooveAnalysis';
import {
  STARTERS, starterGroove, emptyPattern, serializePattern, parsePattern, resizePattern, rowFromText, quantizeBeat, stepBeat,
  grooveBarHits, buildDrumEvents, hitTimes, playbackRateFor, makeGrooveFile, parseGrooveFile, type Groove,
} from '@/lib/groove';
import { buildTimeline } from '@/lib/timeline';
import { synthDrumLoop } from '../drumLoop';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, '../fixtures', n), 'utf8');
const RATE = 44100;

function clicks(times: number[], seconds: number): Float32Array {
  const x = new Float32Array(Math.round(seconds * RATE));
  for (const t of times) { const s = Math.round(t * RATE); for (let i = 0; i < 400; i++) x[s + i] += Math.sin(i * 0.5) * Math.exp(-i / 60) * 0.8; }
  return x;
}

describe('onset detection', () => {
  it('finds synthetic clicks within 8 ms', () => {
    const t = [0.3, 0.8, 1.3, 1.55, 2.1, 2.6];
    const on = detectOnsets(clicks(t, 3.2), RATE);
    expect(on.times).toHaveLength(t.length);
    on.times.forEach((v, i) => expect(Math.abs(v - t[i])).toBeLessThan(0.008));
  });
  it('finds nothing in silence or noise-free tone-less input', () => {
    expect(detectOnsets(new Float32Array(RATE), RATE).times).toEqual([]);
    expect(detectOnsets(new Float32Array(100), RATE).times).toEqual([]);
  });
  it('finds soft hits next to loud ones', () => {
    const x = clicks([0.4, 1.0], 2);
    const soft = clicks([0.7], 2);
    for (let i = 0; i < x.length; i++) x[i] += soft[i] * 0.3;
    expect(detectOnsets(x, RATE).times.map((v) => Math.round(v * 10) / 10)).toEqual([0.4, 0.7, 1.0]);
  });
});

describe('tempo detection on generated drum loops', () => {
  for (const bpm of [90, 120, 150]) {
    it(`${bpm} BPM`, () => {
      const loop = synthDrumLoop(bpm, 4, RATE);
      const on = detectOnsets(loop, RATE);
      expect(on.times.length).toBeGreaterThan(20);
      const est = estimateTempo(on.times, on.strengths, { levels: on.levels });
      expect(est).not.toBeNull();
      expect(Math.abs(est!.bpm - bpm)).toBeLessThanOrEqual(2);
    });
  }
  it('gives up on too few hits', () => { expect(estimateTempo([1, 2, 3])).toBeNull(); });
  it('folds octaves into the usual range and reads tap tempo', () => {
    expect(foldTempo(240)).toBe(120);
    expect(foldTempo(55)).toBe(110);
    expect(bpmFromTaps([0, 0.5, 1.0, 1.5])).toBe(120);
    expect(bpmFromTaps([10, 10.6, 11.2, 20, 20.5, 21.0])).toBe(120); // a pause starts over
    expect(bpmFromTaps([1])).toBeNull();
  });
  it('guesses the bar count', () => {
    expect(guessBars(8, 120)).toBe(4);
    expect(guessBars(4.1, 120)).toBe(2);
    expect(guessBars(2.2, 120)).toBe(1);
  });
});

describe('slicing', () => {
  it('keeps hits inside the loop, positions them in beats and ends each at the next hit', () => {
    const s = buildSlices([0.5, 1.0, 1.5, 2.0, 2.5, 3.0], 4, 0.5, 120, 1);
    expect(s.map((x) => x.beat)).toEqual([0, 1, 2, 3]);
    expect(s[0].end).toBeCloseTo(0.998, 2);
    expect(s[3].end).toBeCloseTo(2.498, 2); // ends where the next onset (outside the loop) begins
  });
  it('encodes a WAV file', () => {
    const b = encodeWav(new Float32Array([0, 1, -1]), 8000);
    expect(String.fromCharCode(...b.subarray(0, 4))).toBe('RIFF');
    expect(b.length).toBe(44 + 6);
  });
});

describe('step grid', () => {
  it('round-trips through its text form', () => {
    for (const s of STARTERS) {
      const back = parsePattern(serializePattern(s.pattern))!;
      expect(back).toEqual(s.pattern);
    }
    const p = emptyPattern(12, 2);
    p.tracks.lead[5] = 3; p.tracks.whistle[23] = 1;
    expect(parsePattern(serializePattern(p))).toEqual(p);
  });
  it('rejects junk and repairs short rows', () => {
    expect(parsePattern('nope')).toBeNull();
    expect(parsePattern({ steps: 8, bars: 1, tracks: {} })).toBeNull();
    const p = parsePattern({ steps: 16, bars: 1, tracks: { bass: 'X.x' } })!;
    expect(p.tracks.bass).toHaveLength(16);
    expect(p.tracks.bass.slice(0, 3)).toEqual([3, 0, 2]);
  });
  it('keeps hits when the shape changes', () => {
    const p = emptyPattern(16, 1);
    p.tracks.bass[0] = 3; p.tracks.bass[14] = 2;
    const q = resizePattern(p, 12, 2);
    expect(q.tracks.bass).toHaveLength(24);
    expect(q.tracks.bass[0]).toBe(3);
    expect(q.tracks.bass.filter(Boolean)).toHaveLength(1);
  });
  it('starter patterns are valid and carry the plan label', () => {
    expect(STARTERS.filter((s) => !s.traditional)).toHaveLength(3);
    for (const s of STARTERS) { const g = starterGroove(s.id)!; expect(g.starter).toBe(true); expect(grooveBarHits(g, 0).length).toBeGreaterThan(6); }
    expect(rowFromText('X . o x')).toEqual([3, 0, 1, 2]);
  });
  it('the built-in Junkanoo groove: bar 31 of the player\'s score, no starter warning', () => {
    const g = starterGroove('junkanoo')!;
    expect(g.name).toBe('Junkanoo');
    expect(g.traditional).toBe(true);
    expect(g.starter).toBe(true); // built in: cannot be renamed or deleted
    const at = (inst: string) => grooveBarHits(g, 0).filter((h) => h.inst === inst).map((h) => h.timeQ);
    expect(at('cymbal')).toEqual([0.5, 1.5, 2.5, 3.5]); // the off-beats
    expect(at('jkBass')).toEqual([0, 1.5, 2, 3.5]); // BOOM . . ka BOOM . . ka
    expect(grooveBarHits(g, 0).filter((h) => h.inst === 'jkBass' && h.vel === 1).map((h) => h.timeQ)).toEqual([0, 2]);
    expect(grooveBarHits(g, 0).filter((h) => h.inst === 'tumHi' && h.vel === 1).map((h) => h.timeQ)).toEqual([0, 1, 2, 3]);
    expect(at('tumHi')).toHaveLength(13);
    expect(at('tumLo')).toEqual([0, 0.75, 1.5, 2, 2.75, 3.5]);
    for (const k of ['bass', 'lead', 'cowHi', 'cowLo', 'whistle']) expect(at(k)).toEqual([]);
    expect(starterGroove('starter-a')!.traditional).toBeUndefined();
  });
  it('places steps straight, in 12, or swung', () => {
    expect(stepBeat(5, 16, 'straight')).toBe(1.25);
    expect(stepBeat(5, 16, 'triplet')).toBeCloseTo(1 + 1 / 3, 6);
    expect(stepBeat(4, 12, 'straight')).toBeCloseTo(4 / 3, 6);
  });
});

const rec = (over: Partial<Groove> = {}): Groove => ({
  id: 'r', name: 'r', kind: 'recorded', createdAt: 0, feel: 'straight', bpm: 100, bars: 2, quantize: 0,
  slices: [{ beat: 0, start: 0, end: 0.2 }, { beat: 1.1, start: 0.3, end: 0.5 }, { beat: 4.02, start: 1, end: 1.2 }, { beat: 6.5, start: 1.5, end: 1.9 }], ...over,
});

describe('quantize', () => {
  it('moves hits toward the grid by the given amount', () => {
    expect(quantizeBeat(1.1, 0, 'straight')).toBeCloseTo(1.1, 9);
    expect(quantizeBeat(1.1, 1, 'straight')).toBeCloseTo(1.0, 9);
    expect(quantizeBeat(1.1, 0.5, 'straight')).toBeCloseTo(1.05, 9);
    expect(quantizeBeat(1.3, 1, 'triplet')).toBeCloseTo(4 / 3, 9);
  });
  it('applies to recorded grooves', () => {
    const hits = grooveBarHits(rec({ quantize: 1 }), 0);
    expect(hits.map((h) => h.timeQ)).toEqual([0, 1]);
    expect(grooveBarHits(rec(), 0).map((h) => h.timeQ)[1]).toBeCloseTo(1.1, 9);
  });
});

describe('scheduling a groove on a score', () => {
  it('lines the hits up with bar downbeats and follows the loop length', () => {
    const tl = buildTimeline(fx('scale.musicxml'));
    const g = starterGroove('starter-a')!;
    const ev = buildDrumEvents(tl, g);
    // the bass drum accents every downbeat (step 0 and step 8 of the bar: beats 0 and 2)
    const bassDown = ev.filter((h) => h.inst === 'bass' && h.vel === 1).map((h) => h.timeQ);
    for (const s of tl.measureStartsQ) expect(bassDown).toContain(s);
    expect(ev[0].timeQ).toBe(0);
    for (let i = 1; i < ev.length; i++) expect(ev[i].timeQ).toBeGreaterThanOrEqual(ev[i - 1].timeQ);
  });
  it('a 2-bar groove alternates bars', () => {
    const tl = buildTimeline(fx('scale.musicxml'));
    const ev = buildDrumEvents(tl, starterGroove('starter-c')!);
    const bar = (i: number) => ev.filter((h) => h.timeQ >= tl.measureStartsQ[i] && h.timeQ < (tl.measureStartsQ[i + 1] ?? tl.totalQ)).map((h) => `${h.inst}${h.timeQ - tl.measureStartsQ[i]}`).join();
    expect(bar(0)).not.toBe(bar(1));
    expect(bar(0)).toBe(bar(2));
    expect(bar(1)).toBe(bar(3));
  });
  it('a pickup bar gets the end of the last groove bar and bar 2 starts the groove', () => {
    const tl = buildTimeline(fx('qa-pickup.musicxml'));
    const len0 = tl.measureStartsQ[1] - tl.measureStartsQ[0];
    expect(len0).toBeLessThan(4);
    const g = starterGroove('starter-c')!; // two groove bars
    const ev = buildDrumEvents(tl, g);
    const pick = ev.filter((h) => h.timeQ < tl.measureStartsQ[1]);
    const last = grooveBarHits(g, 1).filter((h) => h.timeQ >= 4 - len0 - 1e-9);
    expect(pick.map((h) => h.timeQ - (tl.measureStartsQ[1] - 4))).toEqual(last.map((h) => h.timeQ));
    const bar2 = ev.filter((h) => h.timeQ >= tl.measureStartsQ[1] && h.timeQ < tl.measureStartsQ[2]);
    expect(bar2.map((h) => h.timeQ - tl.measureStartsQ[1])).toEqual(grooveBarHits(g, 0).filter((h) => h.timeQ < tl.measureStartsQ[2] - tl.measureStartsQ[1]).map((h) => h.timeQ));
  });
  it('hit times are right at a new BPM (within 5 ms)', () => {
    const tl = buildTimeline(fx('scale.musicxml'));
    const ev = buildDrumEvents(tl, rec({ quantize: 0 }));
    for (const bpm of [70, 100, 133, 180]) {
      const t = hitTimes(ev, bpm, 2.0, 0);
      ev.forEach((h, i) => expect(Math.abs(t[i] - (2.0 + (h.timeQ * 60) / bpm))).toBeLessThan(0.005));
    }
    // recorded at 100 BPM: beat 1.1 of the groove lands at 1.1 * 60/133 s at 133 BPM
    const second = hitTimes(ev, 133, 0, 0)[1];
    expect(Math.abs(second - (1.1 * 60) / 133)).toBeLessThan(0.005);
  });
  it('plays at its own speed far from its tempo and follows the tempo within 8%', () => {
    expect(playbackRateFor(100, 104)).toBeCloseTo(1.04, 9);
    expect(playbackRateFor(100, 120)).toBe(1);
    expect(playbackRateFor(100, 80)).toBe(1);
  });
});

describe('groove files', () => {
  it('round-trips a recorded groove with its audio', () => {
    const audio = encodeWav(new Float32Array([0, 0.5, -0.5, 0.25]), 8000);
    const txt = makeGrooveFile(rec({ durationS: 2, downbeatS: 0.1, onsets: [0.1, 0.5] }), { mime: 'audio/wav', bytes: audio });
    const back = parseGrooveFile(txt);
    // the hits are cut again the current way when a file comes in: same beats, now with a lead-in
    expect(back.groove.slices!.map((x) => Math.round(x.beat * 1000) / 1000)).toEqual([0, 0.667]);
    expect(back.groove.slices![0].pre).toBeGreaterThan(0);
    expect(back.groove.v).toBe(2);
    expect(back.groove.bpm).toBe(100);
    expect(Array.from(back.audio!.bytes)).toEqual(Array.from(audio));
  });
  it('round-trips a kit groove and refuses junk', () => {
    const g = starterGroove('starter-b')!;
    const back = parseGrooveFile(makeGrooveFile(g));
    expect(back.groove.pattern).toEqual(g.pattern);
    expect(back.groove.starter).toBeUndefined();
    expect(() => parseGrooveFile('{}')).toThrow(/groove/);
    expect(() => parseGrooveFile('not json')).toThrow();
    expect(() => parseGrooveFile(JSON.stringify({ format: 'brass-reader-groove', version: 1, groove: { kind: 'recorded', name: 'x' } }))).toThrow(/audio/);
  });
});
