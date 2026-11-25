import { describe, it, expect } from 'vitest';
import { glideX } from '../../lib/glide';

describe('glideX', () => {
  const pts = [{ off: 0, x: 10 }, { off: 1, x: 30 }, { off: 3, x: 50 }];
  it('sits on a note at its start', () => {
    expect(glideX(pts, 0, 4, 90)).toBe(10);
    expect(glideX(pts, 1, 4, 90)).toBe(30);
  });
  it('glides between notes at a steady speed', () => {
    expect(glideX(pts, 0.5, 4, 90)).toBeCloseTo(20);
    expect(glideX(pts, 2, 4, 90)).toBeCloseTo(40);
  });
  it('glides on to the end of the bar after the last note', () => {
    expect(glideX(pts, 3.5, 4, 90)).toBeCloseTo(70);
    expect(glideX(pts, 4, 4, 90)).toBeCloseTo(90);
  });
  it('never moves backwards past the bar end and handles empty input', () => {
    expect(glideX([{ off: 0, x: 50 }], 2, 4, 20)).toBe(50);
    expect(glideX([], 1, 4, 20)).toBeNull();
  });
});
