import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildTimeline } from '@/lib/timeline';
import { loopQ } from '@/lib/loop';
import { windowAt, windowOfSlot, nextSlotOf, prevSlotOf, buildWindowXml } from '@/lib/barWindow';
import { parseXml, partsOf, kids, kid } from '@/lib/musicxml';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, '../fixtures', n), 'utf8');

describe('window of bars from the timeline position', () => {
  const tl = buildTimeline(fx('scale.musicxml')); // 4 bars of 4 quarters

  it('shows the bar being played and the next one', () => {
    expect(windowAt(tl, 0, null)).toMatchObject({ slot: 0, bars: [1, 2], offQ: 0 });
    expect(windowAt(tl, 3.5, null)).toMatchObject({ slot: 0, bars: [1, 2], offQ: 3.5 });
    // entering bar 2 moves the window on by one bar: bars 2 and 3
    expect(windowAt(tl, 4, null)).toMatchObject({ slot: 1, bars: [2, 3], offQ: 0 });
    expect(windowAt(tl, 9.25, null)).toMatchObject({ slot: 2, bars: [3, 4], offQ: 1.25 });
  });

  it('shows the last bar alone', () => {
    expect(windowAt(tl, 12, null).bars).toEqual([4]);
    expect(windowAt(tl, 15.99, null).bars).toEqual([4]);
    expect(windowAt(tl, 99, null).bars).toEqual([4]); // past the end is clamped
  });

  it('gives the same key to the same two bars', () => {
    expect(windowOfSlot(tl, 1).key).toBe('2+3');
    expect(windowOfSlot(tl, 3).key).toBe('4');
  });

  it('follows a pickup bar by its place in the play order', () => {
    const p = buildTimeline(fx('qa-pickup.musicxml')); // pickup is 1 quarter, then 4-quarter bars
    expect(windowAt(p, 0, null).bars).toEqual([1, 2]);
    expect(windowAt(p, 0.9, null)).toMatchObject({ bars: [1, 2], offQ: 0.9 });
    expect(windowAt(p, 1, null)).toMatchObject({ bars: [2, 3], offQ: 0 });
    expect(windowAt(p, 17.5, null).bars).toEqual([6]);
  });

  it('uses the played order with repeats, not the written bar numbers', () => {
    const r = buildTimeline(fx('qa-repeats.musicxml')); // plays 1,2,3,1,2,4,5
    expect(r.order).toEqual([1, 2, 3, 1, 2, 4, 5]);
    expect(windowAt(r, 8, null).bars).toEqual([3, 1]); // second pass starts after bar 3
    expect(windowAt(r, 12, null)).toMatchObject({ slot: 3, bars: [1, 2] });
    expect(windowAt(r, 16, null)).toMatchObject({ slot: 4, bars: [2, 4] });
    expect(windowAt(r, 24, null).bars).toEqual([5]);
  });

  it('wraps at the end of a practice loop', () => {
    const loop = loopQ(tl, { from: 2, to: 3 }); // quarters 4..12
    expect(windowAt(tl, 4, loop).bars).toEqual([2, 3]);
    expect(windowAt(tl, 8, loop).bars).toEqual([3, 2]); // after bar 3 the loop goes back to bar 2
    expect(nextSlotOf(tl, 2, loop)).toBe(1);
    expect(prevSlotOf(tl, 1, loop)).toBe(2);
    // outside the loop nothing wraps
    expect(windowAt(tl, 0, loop).bars).toEqual([1, 2]);
    expect(windowAt(tl, 12, loop).bars).toEqual([4]);
  });

  it('a one-bar loop shows that bar twice', () => {
    const loop = loopQ(tl, { from: 3, to: 3 });
    expect(windowAt(tl, 8, loop).bars).toEqual([3, 3]);
  });

  it('next and previous slots at the ends', () => {
    expect(nextSlotOf(tl, 3, null)).toBeNull();
    expect(prevSlotOf(tl, 0, null)).toBeNull();
    expect(nextSlotOf(tl, 0, null)).toBe(1);
    expect(prevSlotOf(tl, 2, null)).toBe(1);
  });
});

describe('buildWindowXml', () => {
  const measuresOf = (xml: string) => kids(partsOf(parseXml(xml))[0], 'measure');

  it('keeps only the wanted bars with the clef, key and time that were in effect', () => {
    const w = buildWindowXml(fx('scale.musicxml'), [3, 4]);
    const ms = measuresOf(w.xml);
    expect(ms).toHaveLength(2);
    const attrs = kid(ms[0], 'attributes')!;
    expect(kid(attrs, 'divisions')?.textContent).toBe('1');
    expect(kid(attrs, 'clef')).not.toBeNull();
    expect(kid(attrs, 'key')).not.toBeNull();
    expect(kid(ms[1], 'attributes')).toBeNull(); // nothing changed between the two bars
    expect(w.showTime).toBe(false); // bar 3 is not where the time signature is written
    expect(kids(ms[0], 'note')).toHaveLength(4);
  });

  it('shows the time signature when the window starts the piece', () => {
    expect(buildWindowXml(fx('scale.musicxml'), [1, 2]).showTime).toBe(true);
  });

  it('puts a key change into the bar that starts after it, also when bars are not neighbours', () => {
    const src = fx('key-changes.musicxml');
    const tl = buildTimeline(src);
    expect(tl.measureCount).toBe(6);
    const keyOf = (xml: string, bar: number) => kid(kid(measuresOf(xml)[bar], 'attributes') ?? measuresOf(xml)[bar], 'key')?.textContent;
    const first = buildWindowXml(src, [1, 6]);
    const k1 = keyOf(first.xml, 0);
    const k6 = keyOf(first.xml, 1);
    expect(k1).toBeTruthy();
    expect(k6).toBeTruthy();
    expect(k1).not.toBe(k6); // bar 6 is in another key than bar 1: the key is written again
    // starting in a later bar still gets a key
    expect(keyOf(buildWindowXml(src, [6]).xml, 0)).toBe(k6);
  });

  it('can show a bar twice', () => {
    const w = buildWindowXml(fx('scale.musicxml'), [2, 2]);
    expect(measuresOf(w.xml)).toHaveLength(2);
    expect(measuresOf(w.xml).map((m) => m.getAttribute('number'))).toEqual(['1', '2']);
  });

  it('drops ties and slurs whose other end is not in the window', () => {
    const src = fx('ties-dots.musicxml');
    const w = buildWindowXml(src, [2]); // the B4 half note in bar 2 is tied from bar 1
    expect(w.xml).not.toContain('type="stop"');
    const both = buildWindowXml(src, [1, 2]);
    expect(both.xml).toContain('type="stop"');
  });

  it('reads back as a score with the same notes', () => {
    const w = buildWindowXml(fx('qa-repeats.musicxml'), [3, 1]);
    const tl = buildTimeline(w.xml);
    expect(tl.measureCount).toBe(2);
    expect(tl.events.length).toBeGreaterThan(0);
  });
});
