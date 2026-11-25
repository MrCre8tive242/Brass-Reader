import { fingerMark, fitFingerSize, layoutFinger, type FingerMark, type FingerShape, type FingerStyle } from './fingerStyle';
import type { InstrumentId } from './instruments';
import type { WindowLayout } from './windowRender';

/** Things drawn on top of a drawn window, in px of that window. */
export interface OverlayItem {
  /** Where the item's centre-top (fingering) or anchor point (label) sits. */
  x: number;
  y: number;
  shapes: FingerShape[];
  /** Fingering of a note: the text and the written bar and offset it belongs to (for tests and tapping). */
  finger?: { text: string | null; bar: number; off: number };
}

export interface Overlay {
  items: OverlayItem[];
  /** Font size used for the fingerings. */
  fs: number;
  /** Lowest point of anything drawn (to make room under the notation). */
  bottom: number;
  /** Per drawn bar: how far down its box reaches so that it holds the fingerings too. */
  barBottom: number[];
}

/** Sounding pitch of the note my part plays in written bar `bar` at `off` quarters into it, if there is one. */
export type NoteLookup = (bar: number, off: number) => number | undefined;

/**
 * The fingerings (and the small printed bar numbers) for a drawn window. One row of fingerings under each drawn line,
 * all at the same height and centred under the note heads; one font size for all, small enough that neighbours do not touch.
 * `bars` are the written bars drawn, in order; `labels` the printed bar names ("Pickup", "12") of them.
 */
export function windowOverlay(
  layout: WindowLayout, bars: number[], labels: string[], lookup: NoteLookup, inst: InstrumentId, style: FingerStyle,
): Overlay {
  const items: OverlayItem[] = [];
  const space = layout.space;
  let bottom = layout.height;
  // fingerings
  if (style !== 'off') {
    const marks: { x: number; bar: number; off: number; mark: FingerMark; bottom: number }[] = [];
    for (const n of layout.notes) {
      const midi = lookup(bars[n.bar - 1] ?? 0, n.off);
      if (midi === undefined) continue; // a rest, or the tied-on part of a note: nothing to finger
      const mark = fingerMark(inst, midi, style);
      if (mark) marks.push({ x: n.x, bar: n.bar, off: n.off, mark, bottom: n.bottom });
    }
    // lines: bars that share a height share a row
    const rowY = new Map<number, number>();
    layout.bars.forEach((b, i) => {
      if (!b.w) return;
      const staffBottom = b.y + b.h - 2.2 * space;
      let low = Math.max(staffBottom, layout.contentBottom[i] ?? 0);
      for (const m of marks) if (m.bar === i + 1) low = Math.max(low, m.bottom);
      rowY.set(i + 1, low + 0.7 * space);
    });
    // one row height per line of music, so that a one-line window keeps the fingerings level across both bars
    const lineOf = (bar: number) => Math.round((layout.bars[bar - 1]?.y ?? 0) / Math.max(1, space * 4));
    const lines = new Map<number, number>();
    for (const [bar, y] of rowY) lines.set(lineOf(bar), Math.max(lines.get(lineOf(bar)) ?? 0, y));
    const base = Math.max(12, Math.min(40, 1.8 * space));
    let fs = base;
    for (const line of lines.keys()) {
      fs = Math.min(fs, fitFingerSize(marks.filter((m) => lineOf(m.bar) === line).map((m) => ({ x: m.x, mark: m.mark })), base, 8));
    }
    const lineBottom = new Map<number, number>();
    for (const m of marks) {
      const y = lines.get(lineOf(m.bar)) ?? rowY.get(m.bar) ?? 0;
      const l = layoutFinger(m.mark, fs);
      lineBottom.set(lineOf(m.bar), Math.max(lineBottom.get(lineOf(m.bar)) ?? 0, y + l.h + 3));
      items.push({ x: m.x, y, shapes: l.shapes, finger: { text: m.mark.text ?? (m.mark.dots ? m.mark.dots.map((d) => (d ? '1' : '0')).join('') : null), bar: m.bar, off: m.off } });
      bottom = Math.max(bottom, y + l.h + 2);
    }
    const barBottom = layout.bars.map((b, i) => Math.max(b.y + b.h, lineBottom.get(lineOf(i + 1)) ?? 0));
    return withLabels({ items, fs, bottom, barBottom }, layout, labels);
  }
  return withLabels({ items, fs: 0, bottom, barBottom: layout.bars.map((b) => b.y + b.h) }, layout, labels);
}

function withLabels(o: Overlay, layout: WindowLayout, labels: string[]): Overlay {
  const size = Math.max(9, Math.min(15, layout.space * 1.35));
  layout.bars.forEach((b, i) => {
    if (!b.w || !labels[i]) return;
    o.items.push({ x: b.x + b.w - 3, y: b.y + 0.2 * layout.space, shapes: [{ t: 'text', x: 0, y: size * 0.85, size, text: labels[i] === 'Pickup' ? 'Pickup' : `Bar ${labels[i]}`, anchor: 'end', muted: true }] });
  });
  return o;
}
