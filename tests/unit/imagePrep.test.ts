import { describe, it, expect } from 'vitest';
import { toGray, flattenLighting, grayToRgba, inkProfile, findSplitRow, rotatedSize, type Gray } from '@/lib/imagePrep';

/** A fake photo: paper lit unevenly (bright top-left, shadow bottom-right) with staff lines every `gap` rows inside `systems`. */
function photo(w: number, h: number, systems: [number, number][], light: (x: number, y: number) => number, ink = 0.25): Gray {
  const data = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const inSystem = systems.some(([a, b]) => y >= a && y < b);
    for (let x = 0; x < w; x++) {
      const paper = light(x, y);
      const line = inSystem && y % 6 === 0 && x > w * 0.08 && x < w * 0.92;
      data[y * w + x] = Math.round(paper * (line ? ink : 1));
    }
  }
  return { data, w, h };
}
const shadow = (w: number, h: number) => (x: number, y: number) => 230 - 150 * ((x / w + y / h) / 2); // 230 .. 80

describe('toGray / grayToRgba', () => {
  it('converts colour to luma and back to grey RGBA', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 128]);
    const g = toGray(rgba, 2, 2);
    expect(Array.from(g.data)).toEqual([255, 0, 76, 149]);
    const out = new Uint8ClampedArray(16);
    grayToRgba(g, out);
    expect(Array.from(out.slice(8, 16))).toEqual([76, 76, 76, 255, 149, 149, 149, 255]);
  });
});

describe('flattenLighting', () => {
  const w = 400, h = 520;
  const src = photo(w, h, [[40, 200], [300, 470]], shadow(w, h));
  const out = flattenLighting(src);
  const at = (g: Gray, x: number, y: number) => g.data[y * g.w + x];
  it('makes the paper white in the bright corner and in the shadow', () => {
    expect(at(src, 380, 500)).toBeLessThan(100); // deep shadow before
    for (const [x, y] of [[20, 20], [380, 500], [200, 250], [380, 20], [20, 500]]) expect(at(out, x, y), `${x},${y}`).toBeGreaterThanOrEqual(250);
  });
  it('keeps the ink dark everywhere', () => {
    for (const [x, y] of [[60, 42], [350, 462], [200, 120], [300, 300]]) expect(at(out, x, y), `${x},${y}`).toBeLessThanOrEqual(30);
  });
  it('does not harm a page that is already clean', () => {
    const clean = photo(w, h, [[40, 200]], () => 255, 0);
    const o = flattenLighting(clean);
    expect(at(o, 10, 10)).toBe(255);
    expect(at(o, 200, 42)).toBe(0);
    let diff = 0;
    for (let i = 0; i < o.data.length; i++) if (o.data[i] !== clean.data[i]) diff++;
    expect(diff).toBe(0);
  });
  it('a block of solid black (a beam, a table edge) stays black and does not grey out its surroundings', () => {
    const g = photo(w, h, [], () => 200);
    for (let y = 100; y < 130; y++) for (let x = 100; x < 130; x++) g.data[y * w + x] = 20;
    const o = flattenLighting(g);
    expect(at(o, 115, 115)).toBeLessThan(20);
    expect(at(o, 80, 130)).toBeGreaterThan(245);
  });
  it('faint pencil on grey paper becomes clearly darker than the paper', () => {
    const g = photo(w, h, [[40, 200]], () => 150, 0.55);
    const o = flattenLighting(g);
    expect(at(o, 200, 42)).toBeLessThan(110);
    expect(at(o, 200, 44)).toBe(255);
  });
});

describe('findSplitRow', () => {
  const w = 300, h = 1000;
  it('cuts in the blank band between systems nearest the middle', () => {
    const g = flattenLighting(photo(w, h, [[50, 200], [260, 430], [520, 700], [760, 940]], shadow(w, h)));
    const row = findSplitRow(inkProfile(g));
    expect(row).not.toBeNull();
    expect(row!).toBeGreaterThan(432);
    expect(row!).toBeLessThan(518);
  });
  it('returns null when there is no clean gap near the middle', () => {
    const g = photo(w, h, [[50, 950]], () => 255);
    expect(findSplitRow(inkProfile(g))).toBeNull();
  });
  it('returns null when one half of the page has no music', () => {
    const g = photo(w, h, [[50, 300]], () => 255);
    expect(findSplitRow(inkProfile(g))).toBeNull();
  });
  it('ignores a gap that is too thin to be a gap between systems', () => {
    const g = photo(w, h, [[50, 497], [503, 950]], () => 255);
    expect(findSplitRow(inkProfile(g))).toBeNull();
  });
  it('tolerates a speck of dirt in the gap, at real photo sizes', () => {
    const W = 2000, H = 600;
    const g = photo(W, H, [[40, 250], [340, 560]], () => 255);
    g.data[300 * W + 900] = 0;
    const row = findSplitRow(inkProfile(g));
    expect(row).toBeGreaterThan(250);
    expect(row).toBeLessThan(340);
  });
  it('never cuts between the staves of one system when a line joins them', () => {
    const W = 1200, H = 1000;
    // two systems of two staves each; inside a system the staves are joined by a 2 px line at the left
    const g = photo(W, H, [[60, 200], [300, 440], [560, 700], [800, 940]], () => 255);
    for (const [a, b] of [[60, 440], [560, 940]]) for (let y = a; y < b; y++) { g.data[y * W + 100] = 0; g.data[y * W + 101] = 0; }
    const row = findSplitRow(inkProfile(g));
    expect(row).toBeGreaterThan(440);
    expect(row).toBeLessThan(560);
    // with the join running through the middle of the page there is no place to cut
    const one = photo(W, H, [[60, 400], [600, 940]], () => 255);
    for (let y = 60; y < 940; y++) { one.data[y * W + 100] = 0; one.data[y * W + 101] = 0; }
    expect(findSplitRow(inkProfile(one))).toBeNull();
  });
  it('a dark table beside the page does not stop the cut', () => {
    const W = 1200, H = 1000;
    const g = photo(W, H, [[60, 430], [570, 940]], () => 255);
    for (let y = 0; y < H; y++) for (let x = 0; x < 90; x++) g.data[y * W + x] = 30;
    const row = findSplitRow(inkProfile(g));
    expect(row).toBeGreaterThan(430);
    expect(row).toBeLessThan(570);
  });
});

describe('rotatedSize', () => {
  it('swaps sides on odd quarter turns, also for negative turns', () => {
    expect(rotatedSize(4, 3, 0)).toEqual({ w: 4, h: 3 });
    expect(rotatedSize(4, 3, 1)).toEqual({ w: 3, h: 4 });
    expect(rotatedSize(4, 3, 2)).toEqual({ w: 4, h: 3 });
    expect(rotatedSize(4, 3, -1)).toEqual({ w: 3, h: 4 });
  });
});
