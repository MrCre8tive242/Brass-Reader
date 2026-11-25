import { fingeringFor } from './fingering';
import type { InstrumentId } from './instruments';

/** How fingerings are written under the notes: numbers ("1-3"), valve dots, both, or not at all. */
export type FingerStyle = 'numbers' | 'dots' | 'both' | 'off';

export const FINGER_STYLES: { id: FingerStyle; label: string }[] = [
  { id: 'numbers', label: 'Numbers' },
  { id: 'dots', label: 'Valve dots' },
  { id: 'both', label: 'Both' },
  { id: 'off', label: 'Off' },
];

export const DEFAULT_FINGER_STYLE: FingerStyle = 'both';

export function normalizeFingerStyle(v: unknown): FingerStyle {
  return v === 'numbers' || v === 'dots' || v === 'both' || v === 'off' ? v : DEFAULT_FINGER_STYLE;
}

/** What to draw for one note. */
export interface FingerMark {
  /** The number text ("1-3", "0", slide position "4", or a dash outside the chart); null = no text. */
  text: string | null;
  /** Valve dots: pressed = true. null = no dots (slide instruments, notes outside the chart, or a style without dots). */
  dots: boolean[] | null;
  /** Slide position 1..7 for the small slide icon; null = no icon. */
  slide: number | null;
}

/**
 * The fingering of a SOUNDING (concert) pitch on `inst`, as data for the chosen style, or null when nothing is drawn
 * (style off). A note outside the chart gets a dash.
 */
export function fingerMark(inst: InstrumentId, soundingMidi: number, style: FingerStyle): FingerMark | null {
  if (style === 'off') return null;
  const f = fingeringFor(inst, soundingMidi);
  return markOfText(f ? f.primary : '—', f?.kind === 'slide', style);
}

/**
 * The same from a fingering as it is written ("1-3", "0", a slide position "4", or a dash for a note outside the
 * chart): used where the text is already known, e.g. when a player taps through the other ways to play a note.
 */
export function markOfText(text: string, slide: boolean, style: FingerStyle): FingerMark | null {
  if (style === 'off') return null;
  if (text === '—' || !/^\d(-\d)*$/.test(text)) return { text: '—', dots: null, slide: null };
  if (slide) {
    // a trombone has no valves: the position number always shows, with a small slide icon unless "Numbers" was chosen
    return { text, dots: null, slide: style === 'numbers' ? null : Number(text) };
  }
  const pressed = text === '0' ? [] : text.split('-').map(Number);
  const dots = [1, 2, 3].map((v) => pressed.includes(v));
  return {
    text: style === 'dots' ? null : text,
    dots: style === 'numbers' ? null : dots,
    slide: null,
  };
}

/** One thing to draw, in pixels relative to the centre-top of the fingering. */
export type FingerShape =
  | { t: 'box'; x: number; y: number; w: number; h: number; r: number }
  | { t: 'dot'; x: number; y: number; r: number; filled: boolean }
  | { t: 'text'; x: number; y: number; size: number; text: string; anchor?: 'start' | 'middle' | 'end'; muted?: boolean }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; w: number }
  | { t: 'marker'; x: number; y: number; r: number };

export interface FingerLayout { w: number; h: number; shapes: FingerShape[] }

const DOT_R = 0.24;
const DOT_STEP = 0.66;
const SLIDE_STEP = 0.28;

/** Width in px of a text of digits and dashes at `size` (digits 0.62 em, dash 0.38 em, em dash 1 em). */
export function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += ch === '-' ? 0.38 : ch === '—' ? 1 : 0.62;
  return w * size;
}

/** Layout of one fingering at font size `fs` px: dots on top, the number under them, or the slide icon over the number. */
export function layoutFinger(m: FingerMark, fs: number): FingerLayout {
  const shapes: FingerShape[] = [];
  const boxed = !!m.dots || m.slide !== null;
  const padX = boxed ? 0.22 * fs : 0;
  const padY = boxed ? 0.2 * fs : 0;
  let y = padY;
  let w = 0;
  if (m.dots) {
    const r = DOT_R * fs;
    for (let i = 0; i < 3; i++) shapes.push({ t: 'dot', x: (i - 1) * DOT_STEP * fs, y: y + r, r, filled: m.dots[i] });
    w = Math.max(w, 2 * DOT_STEP * fs + 2 * r);
    y += 2 * r + 0.3 * fs;
  }
  if (m.slide !== null) {
    // seven positions along a short rail, a filled marker on the one to play (1 = slide in, on the left)
    const half = 3 * SLIDE_STEP * fs;
    const r = 0.22 * fs;
    shapes.push({ t: 'line', x1: -half, y1: y + r, x2: half, y2: y + r, w: Math.max(1.2, 0.07 * fs) });
    for (let p = 1; p <= 7; p++) {
      const x = (p - 4) * SLIDE_STEP * fs;
      shapes.push({ t: 'line', x1: x, y1: y + r - 0.12 * fs, x2: x, y2: y + r + 0.12 * fs, w: Math.max(1, 0.05 * fs) });
    }
    shapes.push({ t: 'marker', x: (m.slide - 4) * SLIDE_STEP * fs, y: y + r, r });
    w = Math.max(w, 2 * half + 2 * r);
    y += 2 * r + 0.3 * fs;
  }
  if (m.text !== null) {
    shapes.push({ t: 'text', x: 0, y: y + 0.8 * fs, size: fs, text: m.text });
    w = Math.max(w, textWidth(m.text, fs));
    y += 1.05 * fs;
  }
  w += 2 * padX;
  const h = y + padY * 0.5;
  // a faint outline around valve dots and the slide icon, so that neighbours read as separate fingerings
  if (boxed) shapes.unshift({ t: 'box', x: -w / 2, y: 0, w, h, r: 0.3 * fs });
  return { w, h, shapes };
}

/**
 * Font size for a row of fingerings so that neighbours do not touch: the natural size `base`, smaller when the
 * closest two notes are tight (never below `min`).
 */
export function fitFingerSize(marks: { x: number; mark: FingerMark }[], base: number, min: number): number {
  const sorted = [...marks].sort((a, b) => a.x - b.x);
  let fs = base;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].x - sorted[i - 1].x;
    const wide = Math.max(layoutFinger(sorted[i].mark, 1).w, layoutFinger(sorted[i - 1].mark, 1).w);
    if (wide > 0) fs = Math.min(fs, (gap * 0.94) / wide);
  }
  return Math.max(min, Math.min(base, fs));
}
