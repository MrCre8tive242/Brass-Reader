import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildClicks, barLengthQ } from '@/lib/player';
import { buildTimeline } from '@/lib/timeline';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, '../fixtures', n), 'utf8');

describe('player helpers', () => {
  it('builds clicks following the time signature', () => {
    const tl = buildTimeline(fx('key-changes.musicxml'));
    const clicks = buildClicks(tl);
    // bars: 4,4,3,3,4,4 beats
    expect(clicks).toHaveLength(22);
    expect(clicks.filter((c) => c.accent)).toHaveLength(6);
    expect(clicks[8].timeQ).toBe(8); // bar 3 downbeat
    expect(clicks[8].accent).toBe(true);
  });
  it('measures bar length', () => {
    const tl = buildTimeline(fx('key-changes.musicxml'));
    expect(barLengthQ(tl, 1)).toBe(4);
    expect(barLengthQ(tl, 3)).toBe(3);
    expect(barLengthQ(tl, 6)).toBe(4);
  });
});
