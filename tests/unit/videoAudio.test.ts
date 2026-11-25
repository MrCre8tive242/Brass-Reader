import { describe, it, expect } from 'vitest';
import { planSegments, SEGMENT_S, VIDEO_RATE } from '@/lib/videoAudio';
import { rollKit } from '@/lib/drums';
import { KIT_TAKES } from '@/lib/kitSynth';

describe('the sound of a video is made in pieces', () => {
  const rate = 48000;
  it('a 5 minute song is 15 pieces of 20 s that cover it exactly, none of them long', () => {
    const total = 300 * rate + 1234;
    const segs = planSegments([], total, rate);
    expect(SEGMENT_S).toBe(20);
    expect(segs).toHaveLength(16);
    expect(segs[0]).toEqual({ start: 0, end: 20 * rate, from: 0 });
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBe(segs[i - 1].end);
    expect(segs[segs.length - 1].end).toBe(total);
    // memory: the longest render is one piece plus its lead-in (stereo float = 8 bytes a frame), about 8 MB instead of 115 MB
    const longest = Math.max(...segs.map((s) => s.end - s.from));
    expect(longest).toBeLessThanOrEqual(22 * rate);
    expect(longest * 8).toBeLessThan(9 * 1024 * 1024);
    expect(VIDEO_RATE).toBe(48000);
  });

  it('a piece starts early enough for what is still sounding, on a whole audio block', () => {
    // a note from 17 s to 26 s is still sounding at 20 s; a short one at 19.9 s rings on a little
    const segs = planSegments([{ t: 17, end: 26 }, { t: 19.9, end: 20.0 }, { t: 30, end: 31 }], 60 * rate, rate);
    expect(segs[1].start).toBe(20 * rate);
    expect(segs[1].from).toBeLessThanOrEqual(17 * rate);
    expect(segs[1].from).toBeGreaterThan(17 * rate - 128);
    expect(segs[1].from % 128).toBe(0);
    // nothing rings into 40 s: just the settling time
    expect(segs[2].from).toBeLessThanOrEqual((40 - 1.5) * rate);
    expect(segs[2].from).toBeGreaterThan((40 - 1.5) * rate - 128);
    expect(segs[2].from % 128).toBe(0);
  });

  it('a sound that ended long before a piece does not pull its start back', () => {
    const segs = planSegments([{ t: 1, end: 2 }], 45 * rate, rate);
    expect(segs[1].from).toBeGreaterThan(18 * rate);
    expect(segs[2].from).toBeGreaterThan(38 * rate);
  });

  it('other piece lengths and rates work the same way', () => {
    const segs = planSegments([], 10 * 44100, 44100, 3);
    expect(segs.map((s) => s.end - s.start)).toEqual([132300, 132300, 132300, 44100]);
    for (const s of segs) expect(s.from % 128).toBe(0);
  });
});

describe('kit drums in a video sound the same however it is cut up', () => {
  it('the dice of a hit are fixed up front: never the take before, small nudges', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    let last: number | undefined;
    for (let i = 0; i < 50; i++) {
      const d = rollKit('bass', rand, last);
      expect(d.take).toBeGreaterThanOrEqual(0);
      expect(d.take).toBeLessThan(KIT_TAKES);
      expect(d.take).not.toBe(last);
      expect(Math.abs(d.rate - 1)).toBeLessThanOrEqual(0.012 + 1e-9);
      expect(Math.abs(d.level - 1)).toBeLessThanOrEqual(0.07 + 1e-9);
      last = d.take;
    }
  });
});
