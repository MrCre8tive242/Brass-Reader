import { describe, it, expect } from 'vitest';
import { detectOnsets, estimateTempo, guessDownbeat, buildSlices, loopSeconds, peakLevel, recordingLevel, earlyTolerance, MIN_GAP_S, SLICE_XF } from '@/lib/grooveAnalysis';
import { grooveBarHits, playbackRateFor, upgradeGroove, SLICE_VERSION, type Groove } from '@/lib/groove';
import { slicePlan } from '@/lib/drums';
import { junkanooLoop, type LoopHit, type LoopOpts } from '../drumLoop';

/** The distinct moments something is hit (several players on one step count once). */
function steps(hits: LoopHit[]): number[][] {
  const m = new Map<number, number[]>();
  for (const h of hits) m.set(h.step, [...(m.get(h.step) ?? []), h.t]);
  return [...m.values()];
}
function score(o: LoopOpts) {
  const L = junkanooLoop(o);
  const on = detectOnsets(L.samples, L.rate);
  const truth = steps(L.hits);
  const found = truth.filter((ts) => on.times.some((v) => ts.some((x) => Math.abs(v - x) < 0.03))).length;
  const extra = on.times.filter((v) => !L.hits.some((h) => Math.abs(v - h.t) < 0.03)).length;
  return { L, on, truth, found, extra };
}

describe('finding the hits of a drum line (goatskin drums, cowbells, people)', () => {
  it('finds nearly every hit of a played line, and little else, at slow, medium and fast tempos', () => {
    for (const bpm of [84, 112, 140]) {
      for (const seed of [1, 2]) {
        const { truth, found, extra, on } = score({ bpm, bars: 4, jitterMs: 10, seed, flamMs: 28, room: true });
        expect(found / truth.length, `${bpm} BPM seed ${seed}: found`).toBeGreaterThanOrEqual(0.95);
        expect(extra, `${bpm} BPM seed ${seed}: extra`).toBeLessThanOrEqual(2);
        // never two hits closer than the smallest gap
        for (let i = 1; i < on.times.length; i++) expect(on.times[i] - on.times[i - 1]).toBeGreaterThanOrEqual(MIN_GAP_S * 0.6);
      }
    }
  }, 30_000);

  it('copes with an overloaded phone microphone and a noisy room', () => {
    const { truth, found, extra } = score({ bpm: 120, bars: 4, jitterMs: 10, seed: 3, flamMs: 28, room: true, drive: 2.5, noise: 0.02 });
    expect(found / truth.length).toBeGreaterThanOrEqual(0.9);
    expect(extra).toBeLessThanOrEqual(4);
  });

  it('a flam is one hit: it sits on its main stroke and starts at the grace note', () => {
    const L = junkanooLoop({ bpm: 100, bars: 2, flamMs: 30, pattern: { bass: '', lead: 'X...X...X...X...', cowHi: '', cowLo: '', whistle: '' } });
    const on = detectOnsets(L.samples, L.rate);
    expect(on.times).toHaveLength(L.hits.length);
    on.times.forEach((t, i) => {
      expect(Math.abs(t - L.hits[i].t)).toBeLessThan(0.006);
      expect(on.starts[i]).toBeLessThan(L.hits[i].t - 0.02);
      expect(on.starts[i]).toBeGreaterThan(L.hits[i].t - 0.04);
    });
  });

  it('drummers who are not quite together make one hit, not a stutter', () => {
    // three players on every beat, up to a few hundredths apart
    const L = junkanooLoop({ bpm: 96, bars: 2, jitterMs: 12, seed: 5, pattern: { bass: 'X...X...X...X...', lead: 'x...x...x...x...', cowHi: 'x...x...x...x...', cowLo: '', whistle: '' } });
    const on = detectOnsets(L.samples, L.rate);
    expect(on.times).toHaveLength(8);
    const groups = steps(L.hits);
    on.times.forEach((t, i) => {
      expect(t).toBeGreaterThanOrEqual(Math.min(...groups[i]) - 0.006);
      expect(t).toBeLessThanOrEqual(Math.max(...groups[i]) + 0.01);
      expect(on.starts[i]).toBeLessThanOrEqual(t);
      expect(on.starts[i]).toBeLessThan(Math.min(...groups[i]) + 0.006);
    });
  });

  it('does not chop up a trilling whistle or a ringing cowbell', () => {
    const L = junkanooLoop({ bpm: 90, bars: 2, pattern: { bass: '', lead: '', cowHi: '', cowLo: 'x.......x.......', whistle: '....X.......X...' } });
    const on = detectOnsets(L.samples, L.rate);
    expect(on.times).toHaveLength(L.hits.length);
    on.times.forEach((t, i) => expect(Math.abs(t - L.hits[i].t)).toBeLessThan(0.015));
  });

  it('hears nothing in room noise, hum or hiss alone', () => {
    const n = 44100 * 3;
    const hiss = new Float32Array(n), hum = new Float32Array(n);
    let seed = 99;
    for (let i = 0; i < n; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; hiss[i] = (seed / 2147483648 - 1) * 0.05; hum[i] = 0.2 * Math.sin((2 * Math.PI * 60 * i) / 44100) + hiss[i] * 0.1; }
    expect(detectOnsets(hiss, 44100).times).toEqual([]);
    expect(detectOnsets(hum, 44100).times).toEqual([]);
  });

  it('one huge bang (a knocked phone) does not hide the soft hits', () => {
    const L = junkanooLoop({ bpm: 100, bars: 2, pattern: { bass: '', lead: '', cowHi: 'o.o.o.o.o.o.o.o.', cowLo: '', whistle: '' } });
    const x = L.samples;
    const at = Math.round((L.downbeatS + 0.15) * L.rate);
    for (let i = 0; i < 2000; i++) x[at + i] += Math.sin(i * 0.9) * Math.exp(-i / 300) * 0.95 * (i % 2 ? 1 : -1);
    const on = detectOnsets(x, L.rate);
    const found = L.hits.filter((h) => on.times.some((t) => Math.abs(t - h.t) < 0.02)).length;
    expect(found).toBeGreaterThanOrEqual(L.hits.length - 1);
  });

  it('the sensitivity control finds more or fewer hits', () => {
    const L = junkanooLoop({ bpm: 110, bars: 2, jitterMs: 8, seed: 4, pattern: { lead: '..o..oX...o..oX.', cowHi: 'xoxoxoxoxoxoxoxo' } });
    const few = detectOnsets(L.samples, L.rate, 0.4).times.length, normal = detectOnsets(L.samples, L.rate, 1).times.length, many = detectOnsets(L.samples, L.rate, 2.5).times.length;
    expect(few).toBeLessThan(normal);
    expect(many).toBeGreaterThanOrEqual(normal);
  });
});

describe('tempo of a played drum line', () => {
  it('is right to a fraction of a BPM despite human timing', () => {
    for (const bpm of [84, 96, 104, 118, 126, 133, 148]) {
      const { on } = score({ bpm, bars: 4, jitterMs: 10, seed: bpm, flamMs: 25, room: true });
      const est = estimateTempo(on.times, on.strengths, { levels: on.levels })!;
      expect(Math.abs(est.bpm - bpm), `${bpm} BPM`).toBeLessThan(0.5);
      expect(est.sub).toBe(4);
      expect(est.confidence).toBeGreaterThan(0.6);
    }
  }, 30_000);

  it('80 against 160: the count-in tempo settles it, the tempo of the score leans it, and alone it takes the slower one', () => {
    const slow = score({ bpm: 80, bars: 4, jitterMs: 10, seed: 11 }).on;
    const fast = score({ bpm: 160, bars: 4, jitterMs: 8, seed: 12, pattern: { bass: 'X...X...X...X...', lead: '', cowHi: 'x.x.x.x.x.x.x.x.', cowLo: '', whistle: '' } }).on;
    const t = (o: typeof slow, opts: object) => estimateTempo(o.times, o.strengths, { levels: o.levels, ...opts })!.bpm;
    expect(t(slow, {})).toBeCloseTo(80, 0);
    expect(t(slow, { hint: 84 })).toBeCloseTo(80, 0);
    expect(t(slow, { hint: 150 })).toBeCloseTo(160, 0); // told 150, they play "80": it is 160 felt in two
    expect(t(fast, { hint: 152 })).toBeCloseTo(160, 0);
    expect(t(fast, { near: 140 })).toBeCloseTo(160, 0);
    expect(t(fast, { hint: 76 })).toBeCloseTo(80, 0);
    expect(t(fast, {})).toBeCloseTo(80, 0);
  });

  it('a triplet (12-to-the-bar) line is not mistaken for sixteenths at another tempo', () => {
    for (const bpm of [100, 132]) {
      const L = junkanooLoop({ bpm, bars: 4, steps: 12, jitterMs: 9, seed: 2, pattern: { bass: 'X..x..X..x..', lead: '..x..X..x..x', cowHi: 'xxxxxxxxxxxx', cowLo: 'x.....x.....', whistle: '' } });
      const on = detectOnsets(L.samples, L.rate);
      const est = estimateTempo(on.times, on.strengths, { levels: on.levels })!;
      expect(Math.abs(est.bpm - bpm)).toBeLessThan(0.4);
      expect(est.sub).toBe(3);
    }
  });

  it('only listens to the stretch after the count-in, and gives up on too little', () => {
    const { on, L } = score({ bpm: 120, bars: 2, jitterMs: 6, seed: 8, leadS: 2 });
    // count-in clicks at another tempo, heard by the microphone before the drums come in
    const times = [0.1, 0.43, 0.76, 1.09, ...on.times], st = [9, 9, 9, 9, ...on.strengths], lv = [1, 1, 1, 1, ...on.levels];
    const est = estimateTempo(times, st, { levels: lv, from: L.downbeatS - 0.15 })!;
    expect(Math.abs(est.bpm - 120)).toBeLessThan(0.5);
    expect(estimateTempo([0.5, 1, 1.5], [1, 1, 1])).toBeNull();
    expect(estimateTempo(times, st, { from: 100 })).toBeNull();
  });
});

describe('guessing beat 1', () => {
  it('after a count-in: the first solid hit where the count-in ended (not a ghost note just before it)', () => {
    const { on, L } = score({ bpm: 112, bars: 2, jitterMs: 8, seed: 21, leadS: 2.2 });
    const dur = L.samples.length / L.rate;
    // the count-in ended a little before the players came in (speaker and microphone delay)
    expect(Math.abs(guessDownbeat(on.times, on.levels, 112, null, L.downbeatS - 0.06, dur) - L.downbeatS)).toBeLessThan(0.03);
    const times = [L.downbeatS - 0.1, ...on.times], levels = [0.05, ...on.levels];
    expect(Math.abs(guessDownbeat(times, levels, 112, null, L.downbeatS - 0.02, dur) - L.downbeatS)).toBeLessThan(0.03);
    // nobody played near the count-in: the first hit after it
    expect(guessDownbeat([3, 3.5, 4], [1, 1, 1], 120, null, 1, 5)).toBe(3);
    expect(guessDownbeat([], [], 120, null, 1.5, 5)).toBe(1.5);
  });

  it('without a count-in: the beat that carries the heaviest hits bar after bar', () => {
    // the players come in on beat 3 (a two-beat pickup), the big drum marks beat 1
    const L = junkanooLoop({ bpm: 104, bars: 5, jitterMs: 7, seed: 31, pattern: { bass: '........X.......', lead: '..x...x...x...x.', cowHi: 'x.x.x.x.x.x.x.x.', cowLo: '', whistle: '' } });
    const on = detectOnsets(L.samples, L.rate);
    const est = estimateTempo(on.times, on.strengths, { levels: on.levels })!;
    const beat = 60 / 104;
    const d = guessDownbeat(on.times, on.levels, est.bpm, est.phaseS, null, L.samples.length / L.rate);
    // a bar line: two beats after the start, give or take whole bars
    const bars = (d - (L.downbeatS + 2 * beat)) / (4 * beat);
    expect(Math.abs(bars - Math.round(bars))).toBeLessThan(0.03);
    // a single bar has nothing to compare: the first beat that is played
    expect(guessDownbeat([0.5, 1, 1.5, 2], [1, 0.5, 0.5, 0.5], 120, 0.5, null, 2.5)).toBe(0.5);
  });
});

/** What comes out of the speaker when the groove's hits are played back (what DrumBus does, sample by sample). */
function render(g: Groove, src: Float32Array, rate: number, bpm: number, loops: number, t0: number): Float32Array {
  const spq = 60 / bpm, r = playbackRateFor(g.bpm!, bpm), bars = g.bars!;
  const out = new Float32Array(Math.round((t0 + loops * bars * 4 * spq + 1) * rate));
  for (let c = 0; c < loops; c++) for (let bar = 0; bar < bars; bar++) for (const h of grooveBarHits(g, bar)) {
    const when = t0 + ((c * bars + bar) * 4 + h.timeQ) * spq;
    const p = slicePlan(g.slices![h.slice!], when, r, spq, h.maxQ, h.nextPre, 0);
    if (!p) continue;
    for (let n = Math.ceil(p.startAt * rate); n / rate < p.startAt + p.play && n < out.length; n++) {
      const t = n / rate - p.startAt;
      const env = Math.max(0, Math.min(1, t / p.fade, (p.play - t) / p.fade));
      const pos = (p.offset + t * r) * rate, i = Math.floor(pos), f = pos - i;
      out[n] += env * ((src[i] ?? 0) * (1 - f) + (src[i + 1] ?? 0) * f);
    }
  }
  return out;
}

function recorded(o: LoopOpts, bars: number) {
  const L = junkanooLoop(o);
  const on = detectOnsets(L.samples, L.rate);
  const dur = L.samples.length / L.rate;
  const down = guessDownbeat(on.times, on.levels, o.bpm, null, L.downbeatS - 0.03, dur);
  const g: Groove = {
    id: 'g', name: 'g', kind: 'recorded', createdAt: 0, feel: 'straight', bpm: o.bpm, bars, quantize: 0, downbeatS: down, durationS: dur,
    onsets: on.times, onsetStarts: on.starts, slices: buildSlices(on.times, dur, down, o.bpm, bars, on.starts), v: SLICE_VERSION,
  };
  return { L, on, g, down, dur };
}

describe('cutting the recording into hits and playing them back', () => {
  it('at its own tempo the loop is the recording itself: no dips, no clicks, a clean seam', () => {
    const { L, g, down } = recorded({ bpm: 108, bars: 4, jitterMs: 10, seed: 41, flamMs: 28, room: true }, 2);
    const loopS = loopSeconds(2, 108);
    const out = render(g, L.samples, L.rate, 108, 2, down);
    let worst = 0;
    // first pass: from just after the first fade-in to the end of the loop
    for (let n = Math.round((down + 0.01) * L.rate); n < Math.round((down + loopS - 0.03) * L.rate); n++) worst = Math.max(worst, Math.abs(out[n] - L.samples[n]));
    expect(worst).toBeLessThan(0.02);
    // second pass (after the seam) is the same loop again
    let worst2 = 0;
    const shift = Math.round(loopS * L.rate);
    for (let n = Math.round((down + 0.03) * L.rate); n < Math.round((down + loopS - 0.05) * L.rate); n++) worst2 = Math.max(worst2, Math.abs(out[n + shift] - L.samples[n]));
    expect(worst2).toBeLessThan(0.05);
    // no click anywhere: the output never jumps more between two samples than the recording does
    const jump = (x: Float32Array, a: number, b: number) => { let m = 0; for (let n = a + 1; n < b; n++) m = Math.max(m, Math.abs(x[n] - x[n - 1])); return m; };
    expect(jump(out, 0, out.length)).toBeLessThanOrEqual(jump(L.samples, 0, L.samples.length) * 1.5);
  });

  it('every slice has a lead-in, overlaps the next by the cross-fade and holds its whole flam', () => {
    const { g, on } = recorded({ bpm: 100, bars: 2, flamMs: 30, pattern: { bass: 'x.......x.......', lead: '....X.......X...', cowHi: '', cowLo: '', whistle: '' } }, 2);
    const s = g.slices!;
    expect(s.length).toBe(on.times.length);
    for (let i = 0; i < s.length; i++) {
      expect(s[i].pre!).toBeGreaterThanOrEqual(0.01);
      if (i + 1 < s.length) expect(s[i].end - s[i + 1].start).toBeCloseTo(SLICE_XF, 6);
    }
    // the lead-drum hits carry their grace note (30 ms early) inside their own slice
    expect(s[1].pre!).toBeGreaterThan(0.03);
    expect(s[1].beat).toBeCloseTo(1, 1);
  });

  it('at another tempo every stroke still lands on its beat, with its attack intact', () => {
    const { L, g, down } = recorded({ bpm: 100, bars: 2, jitterMs: 0, seed: 43 }, 2);
    for (const bpm of [70, 96, 104, 135]) {
      const spq = 60 / bpm, r = playbackRateFor(100, bpm);
      const out = render(g, L.samples, L.rate, bpm, 1, 1);
      for (const h of grooveBarHits(g, 0)) {
        const s = g.slices![h.slice!];
        const when = 1 + h.timeQ * spq;
        const src0 = s.start + s.pre!;
        // the 4 ms from the stroke on are the recording (at the playback rate), untouched by any fade
        let worst = 0;
        for (let n = Math.ceil(when * L.rate), k = 0; k < Math.round(0.004 * L.rate); k++, n++) {
          const pos = (src0 + (n / L.rate - when) * r) * L.rate, i = Math.floor(pos), f = pos - i;
          const want = L.samples[i] * (1 - f) + L.samples[i + 1] * f;
          worst = Math.max(worst, Math.abs(out[n] - want));
        }
        expect(worst, `${bpm} BPM, beat ${h.timeQ.toFixed(2)}`).toBeLessThan(0.01);
      }
    }
    void down;
  });

  it('a hit played a touch early before the bar line belongs to the next bar, and the last hit is cut by the loop coming round', () => {
    const tol = earlyTolerance(120);
    expect(tol).toBeGreaterThan(0.03);
    expect(tol).toBeLessThanOrEqual(0.07);
    // downbeat 1.0, one bar at 120 = 2 s; a hit 30 ms before the next downbeat is that downbeat, early
    const s = buildSlices([0.98, 1.5, 2.0, 2.5, 2.97, 3.5], 5, 1.0, 120, 1);
    expect(s.map((x) => Math.round(x.beat * 100) / 100)).toEqual([0, 1, 2, 3]);
    const g: Groove = { id: 'g', name: 'g', kind: 'recorded', createdAt: 0, feel: 'straight', bpm: 120, bars: 1, slices: s, v: SLICE_VERSION };
    const hits = grooveBarHits(g, 0);
    expect(hits.at(-1)!.maxQ).toBeCloseTo(1, 6); // beat 3 to beat 0 of the next pass
    expect(hits.at(-1)!.nextPre).toBeCloseTo(s[0].pre!, 9);
    expect(hits[0].maxQ).toBeCloseTo(1, 6);
  });

  it('a late start skips the lead-in instead of delaying the stroke', () => {
    const s = { beat: 0, start: 1, end: 1.6, pre: 0.02 };
    const onTime = slicePlan(s, 10, 1, 0.5, 1, 0.02, 9)!;
    expect(onTime.startAt).toBeCloseTo(9.98, 9);
    expect(onTime.offset).toBe(1);
    expect(onTime.play).toBeCloseTo(0.5 + SLICE_XF, 9);
    const late = slicePlan(s, 10, 1, 0.5, 1, 0.02, 9.995)!;
    expect(late.startAt).toBe(9.995);
    expect(late.offset).toBeCloseTo(1.015, 9); // the stroke (1.02 in the recording) still sounds at 10
    expect(slicePlan({ beat: 0, start: 1, end: 1.004, pre: 0 }, 10, 1, 0.5, 1, 0.02, 9)).toBeNull();
    // slices from an older version: started on the beat, cut just after the next one
    const old = slicePlan({ beat: 0, start: 1, end: 1.5 }, 10, 1, 0.5, 0.5, undefined, 9)!;
    expect(old.startAt).toBe(10);
    expect(old.play).toBeCloseTo(0.255, 9);
  });

  it('speeds the hits up or down near their own tempo and eases back to natural pitch further away, without a jump', () => {
    expect(playbackRateFor(100, 100)).toBe(1);
    expect(playbackRateFor(100, 104)).toBeCloseTo(1.04, 9);
    expect(playbackRateFor(100, 92)).toBeCloseTo(0.92, 9);
    expect(playbackRateFor(100, 112)).toBeCloseTo(1.04, 9); // easing back
    expect(playbackRateFor(100, 116)).toBe(1);
    expect(playbackRateFor(100, 60)).toBe(1);
    expect(playbackRateFor(0, 100)).toBe(1);
    for (let b = 50; b < 200; b += 0.5) expect(Math.abs(playbackRateFor(100, b + 0.5) - playbackRateFor(100, b))).toBeLessThanOrEqual(0.0051);
  });

  it('re-cuts a groove saved by an older version, and measures how loud a recording is', () => {
    const old: Groove = { id: 'o', name: 'o', kind: 'recorded', createdAt: 0, feel: 'straight', bpm: 120, bars: 1, downbeatS: 0.5, durationS: 4, onsets: [0.5, 1.0, 1.5, 2.0, 2.5], slices: [{ beat: 0, start: 0.496, end: 0.998 }] };
    const up = upgradeGroove(old);
    expect(up.v).toBe(SLICE_VERSION);
    expect(up.slices!.map((s) => s.beat)).toEqual([0, 1, 2, 3]);
    expect(up.slices!.every((s) => s.pre !== undefined)).toBe(true);
    expect(upgradeGroove(up)).toBe(up);
    const kit: Groove = { id: 'k', name: 'k', kind: 'kit', createdAt: 0, feel: 'straight' };
    expect(upgradeGroove(kit)).toBe(kit);
    const x = new Float32Array(1000); x[100] = -0.4; x[900] = 0.8;
    expect(peakLevel(x, 1000)).toBeCloseTo(0.8, 6);
    expect(peakLevel(x, 1000, 0, 0.5)).toBeCloseTo(0.4, 6);
    expect(recordingLevel(x).verdict).toBe('ok');
    expect(recordingLevel(junkanooLoop({ bpm: 120, bars: 1, drive: 4 }).samples.map((v) => Math.max(-1, Math.min(1, v * 1.2)))).verdict).toBe('hot');
    expect(recordingLevel(new Float32Array(100).fill(0.01)).verdict).toBe('quiet');
  });
});
