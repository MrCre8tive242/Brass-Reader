import { describe, it, expect } from 'vitest';
import { fingerMark, markOfText, layoutFinger, fitFingerSize, normalizeFingerStyle, DEFAULT_FINGER_STYLE, FINGER_STYLES, textWidth } from '@/lib/fingerStyle';
import { windowOverlay } from '@/lib/windowOverlay';
import type { WindowLayout } from '@/lib/windowRender';

// trumpet: sounding = written - 2. Written A4 (69) sounds G4 (67): valves 1-2. Written G4 (67) sounds F4 (65): open.
const A4 = 67, G4 = 65, C5 = 70, FS4 = 64;

describe('fingering style', () => {
  it('defaults to both, and only knows four styles', () => {
    expect(DEFAULT_FINGER_STYLE).toBe('both');
    expect(FINGER_STYLES.map((s) => s.id)).toEqual(['numbers', 'dots', 'both', 'off']);
    expect(normalizeFingerStyle(undefined)).toBe('both');
    expect(normalizeFingerStyle('nope')).toBe('both');
    expect(normalizeFingerStyle('off')).toBe('off');
    expect(normalizeFingerStyle('dots')).toBe('dots');
  });

  it('numbers: text only', () => {
    expect(fingerMark('trumpet', A4, 'numbers')).toEqual({ text: '1-2', dots: null, slide: null });
    expect(fingerMark('trumpet', G4, 'numbers')).toEqual({ text: '0', dots: null, slide: null });
  });

  it('valve dots: filled = pressed, no text', () => {
    expect(fingerMark('trumpet', A4, 'dots')).toEqual({ text: null, dots: [true, true, false], slide: null });
    expect(fingerMark('trumpet', G4, 'dots')).toEqual({ text: null, dots: [false, false, false], slide: null });
    expect(fingerMark('trumpet', FS4, 'dots')?.dots).toEqual([false, true, false]); // written F#4: second valve
    expect(fingerMark('trumpet', 52, 'dots')?.dots).toEqual([true, true, true]); // written F#3: all three
  });

  it('both: dots and the number', () => {
    expect(fingerMark('trumpet', A4, 'both')).toEqual({ text: '1-2', dots: [true, true, false], slide: null });
    expect(fingerMark('trumpet', C5, 'both')?.text).toBe('0');
  });

  it('off draws nothing', () => {
    expect(fingerMark('trumpet', A4, 'off')).toBeNull();
    expect(fingerMark('trombone', 58, 'off')).toBeNull();
  });

  it('trombone shows the slide position, never dots; an icon unless Numbers', () => {
    // Bb3 (58) is first position, F3 (53) sixth ... written = concert for the bass-clef instruments
    expect(fingerMark('trombone', 58, 'numbers')).toEqual({ text: '1', dots: null, slide: null });
    expect(fingerMark('trombone', 58, 'dots')).toEqual({ text: '1', dots: null, slide: 1 });
    expect(fingerMark('trombone', 53, 'both')).toEqual({ text: '1', dots: null, slide: 1 });
    expect(fingerMark('trombone', 52, 'both')).toEqual({ text: '2', dots: null, slide: 2 });
  });

  it('baritone and sousaphone use 3 valve dots', () => {
    expect(fingerMark('baritone', 58, 'dots')?.dots).toEqual([false, false, false]);
    expect(fingerMark('baritone', 57, 'dots')?.dots).toEqual([false, true, false]);
    expect(fingerMark('sousaphone', 46, 'dots')?.dots).toEqual([false, false, false]);
    expect(fingerMark('mellophone', 60 - 7 + 12, 'dots')?.dots).toHaveLength(3);
  });

  it('a note outside the chart gets a dash', () => {
    expect(fingerMark('trumpet', 20, 'both')).toEqual({ text: '—', dots: null, slide: null });
  });
});

describe('fingering layout', () => {
  it('draws 3 dots (filled for pressed valves), a box and the number', () => {
    const l = layoutFinger({ text: '1-3', dots: [true, false, true], slide: null }, 20);
    const dots = l.shapes.filter((s) => s.t === 'dot');
    expect(dots).toHaveLength(3);
    expect(dots.map((d) => d.t === 'dot' && d.filled)).toEqual([true, false, true]);
    expect(l.shapes.filter((s) => s.t === 'text')).toHaveLength(1);
    expect(l.shapes.filter((s) => s.t === 'box')).toHaveLength(1);
    expect(l.h).toBeGreaterThan(20);
    expect(l.w).toBeGreaterThan(textWidth('1-3', 20));
    // dots sit above the number, left to right
    const xs = dots.map((d) => (d.t === 'dot' ? d.x : 0));
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
  });

  it('numbers only: one text, no box', () => {
    const l = layoutFinger({ text: '2', dots: null, slide: null }, 20);
    expect(l.shapes).toHaveLength(1);
    expect(l.shapes[0].t).toBe('text');
  });

  it('slide icon puts the marker on the right position of 7', () => {
    const m = (p: number) => layoutFinger({ text: String(p), dots: null, slide: p }, 20).shapes.find((s) => s.t === 'marker');
    const x1 = (m(1) as { x: number }).x, x4 = (m(4) as { x: number }).x, x7 = (m(7) as { x: number }).x;
    expect(x1).toBeLessThan(x4);
    expect(x4).toBeCloseTo(0);
    expect(x7).toBeCloseTo(-x1);
  });

  it('shrinks the size when notes are close, but not below the minimum', () => {
    const mk = (x: number) => ({ x, mark: { text: '1-2', dots: [true, true, false], slide: null } });
    expect(fitFingerSize([mk(0), mk(500)], 20, 8)).toBe(20);
    const tight = fitFingerSize([mk(0), mk(30)], 20, 8);
    expect(tight).toBeLessThan(20);
    expect(tight).toBeGreaterThanOrEqual(8);
    expect(fitFingerSize([mk(0), mk(2)], 20, 8)).toBe(8);
  });
});

describe('overlay under the drawn notes', () => {
  // a drawn window: two bars on one line, two notes in bar 1 (at offset 0 and 1) and a rest + note in bar 2
  const layout: WindowLayout = {
    width: 400, height: 120, zoom: 1.5, space: 15,
    bars: [{ x: 10, y: 10, w: 180, h: 100 }, { x: 200, y: 10, w: 180, h: 100 }],
    contentBottom: [70, 70],
    steps: [],
    notes: [
      { bar: 1, off: 0, x: 40, top: 40, bottom: 52 },
      { bar: 1, off: 1, x: 120, top: 36, bottom: 48 },
      { bar: 2, off: 0, x: 230, top: 36, bottom: 48 },
      { bar: 2, off: 2, x: 300, top: 36, bottom: 48 },
    ],
    staffTop: 30, staffBottom: 80,
  };
  // sounding pitches by (bar, offset): bar 2's note at offset 2 is the tied-on half of a note: no fingering; offset 0 of bar 2 is a rest-less tie start
  const pitches = new Map<string, number>([['3:0', A4], ['3:1', G4], ['4:0', C5]]);
  const lookup = (bar: number, off: number) => pitches.get(`${bar}:${off}`);

  it('puts one fingering under every note that starts, centred under it, none for a tied-on note', () => {
    const ov = windowOverlay(layout, [3, 4], ['3', '4'], lookup, 'trumpet', 'both');
    const fingers = ov.items.filter((i) => i.finger);
    expect(fingers.map((f) => [f.finger!.bar, f.finger!.off, Math.round(f.x)])).toEqual([[1, 0, 40], [1, 1, 120], [2, 0, 230]]);
    expect(fingers.map((f) => f.finger!.text)).toEqual(['1-2', '0', '0']);
    // all on one level, under the lowest ink of both bars
    expect(new Set(fingers.map((f) => f.y)).size).toBe(1);
    expect(fingers[0].y).toBeGreaterThan(70);
    expect(ov.bottom).toBeGreaterThan(fingers[0].y);
  });

  it('writes the printed bar names', () => {
    const ov = windowOverlay(layout, [1, 2], ['Pickup', '2'], lookup, 'trumpet', 'numbers');
    const texts = ov.items.flatMap((i) => i.shapes).filter((s) => s.t === 'text').map((s) => (s.t === 'text' ? s.text : ''));
    expect(texts).toContain('Pickup');
    expect(texts).toContain('Bar 2');
  });

  it('has no fingerings when off', () => {
    const ov = windowOverlay(layout, [3, 4], ['3', '4'], lookup, 'trumpet', 'off');
    expect(ov.items.filter((i) => i.finger)).toHaveLength(0);
  });

  it('numbers style has no dots and dots style has no number text', () => {
    const num = windowOverlay(layout, [3, 4], ['3', '4'], lookup, 'trumpet', 'numbers').items.filter((i) => i.finger).flatMap((i) => i.shapes);
    expect(num.some((s) => s.t === 'dot')).toBe(false);
    const dots = windowOverlay(layout, [3, 4], ['3', '4'], lookup, 'trumpet', 'dots').items.filter((i) => i.finger).flatMap((i) => i.shapes);
    expect(dots.some((s) => s.t === 'text')).toBe(false);
    expect(dots.some((s) => s.t === 'dot')).toBe(true);
  });
});

describe('a fingering from its written form (what a tap on the full sheet steps through)', () => {
  it('valves: text and dots by style', () => {
    expect(markOfText('1-3', false, 'both')).toEqual({ text: '1-3', dots: [true, false, true], slide: null });
    expect(markOfText('1-3', false, 'dots')).toEqual({ text: null, dots: [true, false, true], slide: null });
    expect(markOfText('1-3', false, 'numbers')).toEqual({ text: '1-3', dots: null, slide: null });
    expect(markOfText('0', false, 'dots')).toEqual({ text: null, dots: [false, false, false], slide: null });
    expect(markOfText('3', false, 'both')?.dots).toEqual([false, false, true]);
    expect(markOfText('1-2-3', false, 'both')?.dots).toEqual([true, true, true]);
    expect(markOfText('2', false, 'off')).toBeNull();
  });
  it('slide: the number always, the icon unless numbers were asked for', () => {
    expect(markOfText('6', true, 'both')).toEqual({ text: '6', dots: null, slide: 6 });
    expect(markOfText('6', true, 'dots')).toEqual({ text: '6', dots: null, slide: 6 });
    expect(markOfText('6', true, 'numbers')).toEqual({ text: '6', dots: null, slide: null });
  });
  it('a dash (outside the chart) or anything unreadable stays a dash', () => {
    expect(markOfText('—', false, 'both')).toEqual({ text: '—', dots: null, slide: null });
    expect(markOfText('x', false, 'dots')).toEqual({ text: '—', dots: null, slide: null });
    expect(markOfText('', true, 'both')).toEqual({ text: '—', dots: null, slide: null });
  });
  it('agrees with the chart lookup for every style', () => {
    for (const style of ['numbers', 'dots', 'both'] as const) {
      expect(fingerMark('trumpet', A4, style)).toEqual(markOfText('1-2', false, style));
      expect(fingerMark('trombone', 58, style)).toEqual(markOfText('1', true, style));
    }
  });
});
