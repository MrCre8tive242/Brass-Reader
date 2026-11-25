import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildTimeline } from '@/lib/timeline';
import { framePos, frameCount, videoSeconds, songSeconds, videoFileName, videoSize, estimateBytes, countInLead, NO_LEAD, WARN_BYTES, VIDEO_TAIL_S } from '@/lib/videoPlan';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, '../fixtures', n), 'utf8');

describe('video frame timing', () => {
  const tl = buildTimeline(fx('scale.musicxml')); // 16 quarters, 4 bars

  it('length follows the tempo', () => {
    expect(songSeconds(tl, 120)).toBe(8);
    expect(songSeconds(tl, 60)).toBe(16);
    expect(videoSeconds(tl, 120)).toBe(8 + VIDEO_TAIL_S);
    expect(frameCount(videoSeconds(tl, 120), 30)).toBe(270);
  });

  it('frame k shows the right bar, offset and bar pair', () => {
    // 120 bpm: 2 quarters per second, a bar is 2 s, 30 fps
    const f0 = framePos(tl, 120, 0);
    expect(f0).toMatchObject({ q: 0, slot: 0, bar: 1, offQ: 0, ended: false });
    expect(f0.win.bars).toEqual([1, 2]);
    const f45 = framePos(tl, 120, 45); // 1.5 s = 3 quarters
    expect(f45.q).toBeCloseTo(3);
    expect(f45).toMatchObject({ slot: 0, bar: 1 });
    expect(f45.offQ).toBeCloseTo(3);
    const f60 = framePos(tl, 120, 60); // 2 s: bar 2 starts
    expect(f60).toMatchObject({ slot: 1, bar: 2 });
    expect(f60.win.bars).toEqual([2, 3]);
    expect(f60.offQ).toBeCloseTo(0);
    expect(framePos(tl, 120, 59).bar).toBe(1);
  });

  it('holds the last bar through the end', () => {
    const last = framePos(tl, 120, 8 * 30 - 1);
    expect(last).toMatchObject({ bar: 4, ended: false });
    expect(last.win.bars).toEqual([4]);
    const end = framePos(tl, 120, 8 * 30 + 10);
    expect(end).toMatchObject({ bar: 4, ended: true });
  });

  it('follows repeats by play order', () => {
    const r = buildTimeline(fx('qa-repeats.musicxml')); // plays 1 2 3 1 2 4 5, 4 quarters each
    // 240 bpm: 4 quarters per second
    expect(framePos(r, 240, 3 * 30).bar).toBe(1); // second pass starts after 3 s
    expect(framePos(r, 240, 3 * 30).slot).toBe(3);
    expect(framePos(r, 240, 3 * 30).win.bars).toEqual([1, 2]);
    expect(framePos(r, 240, 5 * 30).win.bars).toEqual([4, 5]);
  });

  it('a pickup is shorter than a bar', () => {
    const p = buildTimeline(fx('qa-pickup.musicxml')); // 1 quarter pickup
    expect(framePos(p, 60, 0).win.bars).toEqual([1, 2]);
    expect(framePos(p, 60, 29).slot).toBe(0);
    expect(framePos(p, 60, 30).slot).toBe(1);
  });
});

describe('count-in before the music', () => {
  const tl = buildTimeline(fx('scale.musicxml')); // 4/4, 16 quarters

  it('one bar of clicks, counted 1 2 3 4, then the music', () => {
    const lead = countInLead(tl, 120);
    expect(lead.seconds).toBe(2);
    expect(lead.clicks.map((c) => c.t)).toEqual([0, 0.5, 1, 1.5]);
    expect(lead.clicks.map((c) => c.n)).toEqual([1, 2, 3, 4]);
    expect(lead.clicks.map((c) => c.accent)).toEqual([true, false, false, false]);
    expect(videoSeconds(tl, 120, lead)).toBe(2 + 8 + VIDEO_TAIL_S);
    expect(videoSeconds(tl, 120, NO_LEAD)).toBe(8 + VIDEO_TAIL_S);
  });

  it('frames of the count-in show the first bars waiting and the beat being counted', () => {
    const lead = countInLead(tl, 120);
    const f0 = framePos(tl, 120, 0, 30, lead);
    expect(f0).toMatchObject({ q: 0, bar: 1, offQ: 0, ended: false, count: { i: 0, beats: [1, 2, 3, 4] } });
    expect(f0.win.bars).toEqual([1, 2]);
    expect(framePos(tl, 120, 14, 30, lead).count?.i).toBe(0);
    expect(framePos(tl, 120, 15, 30, lead).count?.i).toBe(1); // 0.5 s: "2"
    expect(framePos(tl, 120, 59, 30, lead).count?.i).toBe(3); // "4"
    // the music starts at 2 s: frame 60 is its first, with no count
    const f60 = framePos(tl, 120, 60, 30, lead);
    expect(f60.count).toBeUndefined();
    expect(f60).toMatchObject({ q: 0, bar: 1 });
    // everything after is 2 s later than without a count-in
    const f105 = framePos(tl, 120, 105, 30, lead);
    expect(f105.q).toBeCloseTo(3);
    expect(framePos(tl, 120, 120, 30, lead)).toMatchObject({ slot: 1, bar: 2 });
    expect(framePos(tl, 120, 60 + 8 * 30 + 5, 30, lead)).toMatchObject({ bar: 4, ended: true });
  });

  it('before a pickup the count runs up to the pickup', () => {
    const p = buildTimeline(fx('qa-pickup.musicxml')); // 1 quarter pickup in 4/4
    const lead = countInLead(p, 60);
    expect(lead.seconds).toBe(3);
    expect(lead.clicks.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(framePos(p, 60, 89, 30, lead).count?.i).toBe(2);
    expect(framePos(p, 60, 90, 30, lead).count).toBeUndefined();
  });

  it('6/8 is counted in two', () => {
    const t = buildTimeline(fx('qa-timesig.musicxml')); // starts in 6/8: two dotted-quarter beats, 3 quarters long
    const lead = countInLead(t, 90);
    expect(lead.clicks.map((c) => c.n)).toEqual([1, 2]);
    expect(lead.seconds).toBeCloseTo(2, 6); // 3 quarters at 90 a minute
    expect(lead.clicks[1].t).toBeCloseTo(1, 6);
    expect(framePos(t, 90, 31, 30, lead).count).toEqual({ i: 1, beats: [1, 2] });
  });

  it('the tempo sets the length of the count', () => {
    expect(countInLead(tl, 240).seconds).toBe(1);
    expect(countInLead(tl, 60).seconds).toBe(4);
  });
});

describe('video names and sizes', () => {
  it('file name is title - instrument - bpm', () => {
    expect(videoFileName('My Tune', 'Bb Trumpet', 100, 'mp4')).toBe('My Tune - Bb Trumpet - 100bpm.mp4');
    expect(videoFileName('A/B: "C"?', 'Trombone', 87.4, 'webm')).toBe('AB C - Trombone - 87bpm.webm');
    expect(videoFileName('  ', 'Mellophone (F)', 90, 'mp4')).toBe('score - Mellophone (F) - 90bpm.mp4');
    // a video of the practice loop says which bars
    expect(videoFileName('My Tune', 'Bb Trumpet', 80, 'mp4', 'bars 9-12')).toBe('My Tune bars 9-12 - Bb Trumpet - 80bpm.mp4');
    expect(videoFileName('My Tune', 'Trombone', 80, 'mp4', 'bar 5')).toBe('My Tune bar 5 - Trombone - 80bpm.mp4');
  });
  it('sizes', () => {
    expect(videoSize('portrait')).toEqual({ width: 1080, height: 1920 });
    expect(videoSize('landscape')).toEqual({ width: 1920, height: 1080 });
  });
  it('a 5 minute song stays well under the memory warning', () => {
    expect(estimateBytes(300)).toBeLessThan(WARN_BYTES);
    expect(estimateBytes(3600)).toBeGreaterThan(WARN_BYTES);
  });
});
