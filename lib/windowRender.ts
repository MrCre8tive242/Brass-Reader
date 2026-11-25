import { buildWindowXml } from './barWindow';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Osmd = any;

export interface Box { x: number; y: number; w: number; h: number }

/** Where things are in a drawn window (all in px of the drawn svg, whose top-left is 0,0). */
export interface WindowLayout {
  width: number;
  height: number;
  zoom: number;
  /** One staff space in px. */
  space: number;
  /** Box of each drawn bar (top of the staff to its bottom, plus a little room). */
  bars: Box[];
  /** Cursor stops: window bar (1-based), offset into the bar in quarters, iterator step, x of the line. */
  steps: { bar: number; off: number; idx: number; x: number }[];
  /** Every drawn note of the part: x of the note head, bottom of the head. */
  /** Lowest ink (note heads, stems, beams) of each drawn bar. */
  contentBottom: number[];
  notes: { bar: number; off: number; x: number; top: number; bottom: number; el?: SVGGElement }[];
  staffTop: number;
  staffBottom: number;
}

const UNIT = 10; // OSMD units are 10px at zoom 1
/** Closest two notes may be this far apart (staff spaces; a note head is about 1.3 wide). */
const MIN_NOTE_GAP = 1.9;

/** One OSMD drawing into `host`, set up for a 2-bar excerpt on a single line. */
export async function makeWindowOsmd(host: HTMLElement): Promise<Osmd> {
  const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay');
  const osmd = new OpenSheetMusicDisplay(host, {
    autoResize: false,
    backend: 'svg',
    drawTitle: false,
    drawSubtitle: false,
    drawComposer: false,
    drawLyricist: false,
    drawCredits: false,
    drawPartNames: false,
    drawMeasureNumbers: false,
    followCursor: false,
    drawingParameters: 'compact',
    cursorsOptions: [{ type: 0, color: '#ff7a00', alpha: 0.75, follow: false }],
    autoGenerateMultipleRestMeasuresFromRestMeasures: false,
  });
  const r = osmd.EngravingRules;
  r.RenderMultipleRestMeasures = false;
  r.RenderMeasureNumbers = false;
  return osmd;
}

export interface DrawOptions {
  /** Room to fit into, px. The notation is scaled up until it fills the width or the height. */
  width: number;
  height: number;
  /** Staff spaces kept free under the staff for the fingerings (included in the height budget). */
  below: number;
  /** Largest size of a staff space in px (keeps a single short bar from becoming huge). */
  maxSpace?: number;
  /** One bar per line, one above the other, each as wide as the room (a tall, narrow screen); otherwise both bars on one line. */
  stack?: boolean;
  /** Closest the note heads may get to each other, px (room for the fingerings under them). */
  minGapPx?: number;
  /** Margin px around the drawing. */
  pad?: number;
}

/**
 * Draw the written bars `bars` of `xml` (single part) into the OSMD's host as large as the room allows, and report where
 * everything is. Two passes: draw at zoom 1 to learn the natural size, then at the zoom that fills the room.
 */
export async function drawWindow(osmd: Osmd, xml: string, bars: number[], o: DrawOptions): Promise<WindowLayout> {
  const w = buildWindowXml(xml, bars);
  osmd.setOptions({ autoBeam: !w.xml.includes('<beam') });
  const r = osmd.EngravingRules;
  r.RenderTimeSignatures = w.showTime;
  // OSMD's page margins are wide (5 units each side): the bars use the room instead; the top margin holds the bar name
  r.PageLeftMargin = 0.4; r.PageRightMargin = 0.4; r.PageTopMargin = 3.6; r.PageTopMarginNarrow = 3.6; r.PageBottomMargin = 0.4;
  // room between the lines for what is written under the notes
  r.MinimumDistanceBetweenSystems = o.stack ? o.below + 2 : 4;
  const host = osmd.container as HTMLElement;
  host.style.width = `${o.width}px`;
  await osmd.load(w.xml);
  const pad = o.pad ?? 2;
  // pass 1: every bar on a line of its own at zoom 1, to learn how wide the widest bar is by itself
  r.RenderSingleHorizontalStaffline = !o.stack;
  r.RenderXMeasuresPerLineAkaSystem = o.stack ? 1 : 0;
  r.StretchLastSystemLine = false;
  osmd.zoom = 1;
  osmd.render();
  const svg1 = host.querySelector('svg');
  const h1 = svg1 ? Number(svg1.getAttribute('height')) || svg1.getBoundingClientRect().height : 1;
  let w1 = 1;
  try {
    for (const sys of osmd.GraphicSheet.MusicPages[0].MusicSystems) w1 = Math.max(w1, sys.PositionAndShape.Size.width * UNIT);
  } catch { w1 = svg1 ? Number(svg1.getAttribute('width')) || 1 : 1; }
  // the staff space is 10px at zoom 1; the fingerings need `below` spaces more than the drawing's own height
  const zh = (o.height - 2 * pad) / Math.max(1, h1 + o.below * UNIT);
  const cap = Math.max(0.3, Math.min(zh, (o.maxSpace ?? 26) / UNIT));
  if (!o.stack) {
    // one line: its natural width at zoom 1 (nothing stretches it), scaled to the room
    const zw = (o.width - 2 * pad) / Math.max(1, w1 + UNIT * (r.PageLeftMargin + r.PageRightMargin));
    osmd.zoom = Math.max(0.3, Math.min(zw, cap));
    osmd.render();
    return measure(osmd, host);
  }
  // bars one under the other: let OSMD break the line where the page width is used up, and spread the bars of each line
  // over the whole width (also the last line). Start as large as the height allows; a bar that needs more width than
  // the page has (dense eighths) pokes out on the right: shrink until everything fits.
  r.RenderXMeasuresPerLineAkaSystem = 0;
  r.StretchLastSystemLine = true;
  r.LastSystemMaxScalingFactor = 100;
  let zoom = cap;
  const limit = o.width - 2 * pad;
  for (let k = 0; k < 5; k++) {
    osmd.zoom = zoom;
    osmd.render();
    // how much wider (in staff spaces) the page would have to be for the closest notes to get their room
    const pageUnits = o.width / (UNIT * zoom);
    const want = Math.max(MIN_NOTE_GAP, (o.minGapPx ?? 0) / (UNIT * zoom));
    let need = pageUnits;
    for (const staves of osmd.GraphicSheet.MeasureList as { staffEntries?: { PositionAndShape: { AbsolutePosition: { x: number } } }[] }[][]) {
      const xs = (staves[0]?.staffEntries ?? []).map((e) => e.PositionAndShape.AbsolutePosition.x).sort((x, y) => x - y);
      if (xs.length < 3) continue;
      let g = Infinity;
      for (let i = 2; i < xs.length; i++) g = Math.min(g, xs[i] - xs[i - 1]); // the first gap holds the barline and the clef
      if (g < want) need = Math.max(need, pageUnits + (want - g) * (xs.length - 1));
    }
    const right = rightEdge(osmd, zoom);
    if (need <= pageUnits + 0.05 && right <= limit + 1) break;
    zoom = Math.max(0.3, Math.min(zoom * Math.min(1, pageUnits / need, limit / Math.max(right, 1)) * 0.99, zoom));
  }
  return measure(osmd, host);
}

/** Right edge in px of the furthest drawn bar. */
function rightEdge(osmd: Osmd, zoom: number): number {
  let right = 0;
  type GM = { PositionAndShape: { AbsolutePosition: { x: number }; BorderRight: number } } | undefined;
  for (const staves of osmd.GraphicSheet.MeasureList as GM[][]) {
    for (const gm of staves) if (gm) right = Math.max(right, (gm.PositionAndShape.AbsolutePosition.x + gm.PositionAndShape.BorderRight) * UNIT * zoom);
  }
  return right;
}

function measure(osmd: Osmd, host: HTMLElement): WindowLayout {
  const svg = host.querySelector('svg') as SVGSVGElement | null;
  const hostRect = host.getBoundingClientRect();
  const zoom = osmd.zoom ?? 1;
  const space = UNIT * zoom;
  const staffH = osmd.EngravingRules?.StaffHeight ?? 4;
  const k = UNIT * zoom;
  type GM = { PositionAndShape: { AbsolutePosition: { x: number; y: number }; BorderLeft: number; BorderRight: number } } | undefined;
  const ml = osmd.GraphicSheet.MeasureList as GM[][];
  const bars: Box[] = [];
  let staffTop = Infinity, staffBottom = -Infinity;
  ml.forEach((staves, i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const gm of staves) {
      if (!gm) continue;
      const p = gm.PositionAndShape;
      x0 = Math.min(x0, p.AbsolutePosition.x + p.BorderLeft);
      x1 = Math.max(x1, p.AbsolutePosition.x + p.BorderRight);
      y0 = Math.min(y0, p.AbsolutePosition.y);
      y1 = Math.max(y1, p.AbsolutePosition.y + staffH);
    }
    if (x0 === Infinity) { bars[i] = { x: 0, y: 0, w: 0, h: 0 }; return; }
    staffTop = Math.min(staffTop, y0 * k);
    staffBottom = Math.max(staffBottom, y1 * k);
    const padY = 2.2;
    bars[i] = { x: x0 * k, y: (y0 - padY) * k, w: (x1 - x0) * k, h: (y1 - y0 + 2 * padY) * k };
  });

  // lowest ink of every bar (stems and beams reach below the staff for high notes): the fingerings go under all of it
  const contentBottom: number[] = bars.map(() => 0);
  svg?.querySelectorAll('.vf-stavenote, .vf-beam').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const cx = r.left - hostRect.left + r.width / 2;
    const bottom = r.bottom - hostRect.top;
    const top = r.top - hostRect.top;
    let best = -1, bd = Infinity;
    bars.forEach((b, i) => {
      if (!b.w) return;
      const dx = cx < b.x ? b.x - cx : cx > b.x + b.w ? cx - (b.x + b.w) : 0;
      const dy = top > b.y + b.h ? top - (b.y + b.h) : bottom < b.y ? b.y - bottom : 0;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0) contentBottom[best] = Math.max(contentBottom[best], bottom);
  });
  const steps: WindowLayout['steps'] = [];
  const notes: WindowLayout['notes'] = [];
  const c = osmd.cursor;
  c.show();
  c.reset();
  c.update();
  const seen = new Set<string>();
  let guard = 0;
  let idx = 0;
  while (!c.iterator.EndReached && guard++ < 5000) {
    const m = c.iterator.CurrentMeasureIndex + 1;
    const startQ = (c.iterator.CurrentMeasure?.AbsoluteTimestamp?.RealValue ?? 0) * 4;
    const off = Math.max(0, c.iterator.currentTimeStamp.RealValue * 4 - startQ);
    const key = `${m}:${Math.round(off * 1000)}`;
    if (!seen.has(key)) {
      seen.add(key);
      c.update();
      const el = c.cursorElement as HTMLElement | undefined;
      const left = parseFloat(el?.style.left ?? '') || 0;
      const width = parseFloat(el?.style.width ?? '') || 0;
      steps.push({ bar: m, off, idx, x: left + width / 2 });
      let gns: Osmd[] = [];
      try { gns = c.GNotesUnderCursor() ?? []; } catch { gns = []; }
      for (const gn of gns) {
        try {
          if (gn.sourceNote?.isRest?.()) continue;
          const g = gn.getSVGGElement?.() as SVGGElement | undefined;
          if (!g) continue;
          // the note head itself (not the stem or flag): its centre and bottom
          const head = (g.querySelector('.vf-notehead') ?? g.querySelector('path')) as SVGGraphicsElement | null;
          const r = (head ?? g).getBoundingClientRect();
          notes.push({ bar: m, off, x: r.left - hostRect.left + r.width / 2, top: r.top - hostRect.top, bottom: r.bottom - hostRect.top, el: g });
        } catch { /* a note we cannot reach has no fingering */ }
      }
    }
    c.iterator.moveToNext();
    idx++;
  }
  c.reset();
  c.update();
  const sw = svg ? Number(svg.getAttribute('width')) || svg.getBoundingClientRect().width : 0;
  const sh = svg ? Number(svg.getAttribute('height')) || svg.getBoundingClientRect().height : 0;
  return { width: sw, height: sh, zoom, space, bars, contentBottom, steps, notes, staffTop: Number.isFinite(staffTop) ? staffTop : 0, staffBottom: Number.isFinite(staffBottom) ? staffBottom : sh };
}
