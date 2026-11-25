'use client';
import { glideX } from '@/lib/glide';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { noteKey } from '@/lib/timeline';
import { layoutFinger, markOfText, type FingerStyle } from '@/lib/fingerStyle';

/** Colour a note on the drawn score. `range` marks a note outside the instrument's range. */
export interface NoteMark { measure: number; offQ: number; kind: 'green' | 'yellow' | 'red' | 'range'; arrow?: 'up' | 'down' }
/** Small text under a note (a fingering); tapping it steps through `alts`. */
export interface NoteLabel { measure: number; offQ: number; text: string; alts?: string[] }

const MARK_COLOR: Record<NoteMark['kind'], string> = { green: '#1c9c47', yellow: '#d99a00', red: '#d62d20', range: '#8a2be2' };
const FINGER_INK = '#5b4a2a';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Draw the valve dots (or, for a slide instrument, the slide icon) of fingering `text` into `g`, centred on x = 0 with
 * its top at y = 0. Returns its height in px.
 */
function drawFingerIcon(g: SVGGElement, text: string, slide: boolean, size: number): number {
  while (g.firstChild) g.removeChild(g.firstChild);
  const mark = markOfText(text, slide, 'dots');
  if (!mark || (!mark.dots && mark.slide === null)) {
    // outside the chart: a dash where the dots would be
    const t = document.createElementNS(SVG_NS, 'text');
    t.textContent = '—';
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('y', String(size * 0.8)); t.setAttribute('font-size', String(size));
    t.style.fill = FINGER_INK; t.style.stroke = 'none';
    g.appendChild(t);
    return size;
  }
  const lay = layoutFinger({ text: null, dots: mark.dots, slide: mark.slide }, size);
  const el = (name: string, attrs: Record<string, string | number>, fill: string, stroke: string, sw = 0) => {
    const e = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, typeof v === 'number' ? v.toFixed(1) : v);
    e.style.fill = fill; e.style.stroke = stroke; if (sw) e.style.strokeWidth = `${sw.toFixed(1)}px`;
    g.appendChild(e);
  };
  for (const s of lay.shapes) {
    if (s.t === 'box') el('rect', { x: s.x, y: s.y, width: s.w, height: s.h, rx: s.r, opacity: '0.3' }, 'transparent', FINGER_INK, 1);
    else if (s.t === 'dot') el('circle', { cx: s.x, cy: s.y, r: s.r }, s.filled ? FINGER_INK : 'none', FINGER_INK, Math.max(1, s.r * 0.3));
    else if (s.t === 'marker') el('circle', { cx: s.x, cy: s.y, r: s.r }, FINGER_INK, 'none');
    else if (s.t === 'line') el('line', { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, 'stroke-linecap': 'round' }, 'none', FINGER_INK, s.w);
  }
  return lay.h;
}

export interface ScoreViewHandle {
  /** Move the cursor + bar highlight to quarter-note position q. */
  setPosition: (q: number, measure: number, offsetQ?: number) => void;
  /** Scroll so the cursor is between the header and whatever covers the bottom of the screen (transport, practice drawer). */
  ensureVisible: () => void;
}

interface Props {
  xml: string;
  /** User zoom multiplier on top of the width-based default (1 = automatic size). */
  zoom?: number;
  /** Written bars (1-based) to mark as "check this bar". */
  flagged?: number[];
  /** Notes to colour (pitch check, range warnings) and fingerings to write under notes of my part. */
  marks?: NoteMark[];
  labels?: NoteLabel[];
  /** How the fingerings are written: numbers (default), valve dots / slide icon, or both. */
  labelStyle?: FingerStyle;
  /** A slide instrument: positions and a slide icon instead of valve dots. */
  slide?: boolean;
  /** Bars (written, 1-based, inclusive) shaded as the practice loop. */
  loop?: { from: number; to: number } | null;
  /** The player picked bars by long-press or drag. */
  onLoopSelect?: (from: number, to: number) => void;
  onSeekMeasure: (measure: number) => void;
  onReady?: (info: { measureCount: number }) => void;
  onError?: (msg: string) => void;
}

/** First time OSMD's cursor visits a position: `idx` = how many iterator steps from the start. */
interface Step { off: number; idx: number; x: number }
interface Box { x: number; y: number; w: number; h: number }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Osmd = any;

const UNIT = 10; // OSMD units are 10px at zoom 1

const ScoreView = forwardRef<ScoreViewHandle, Props>(function ScoreView({ xml, zoom = 1, flagged, marks, labels, labelStyle = 'numbers', slide = false, loop, onLoopSelect, onSeekMeasure, onReady, onError }, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const hl = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<Osmd>(null);
  const steps = useRef<Step[][]>([]); // per written bar (1-based), sorted by offset
  const stepCount = useRef(0);
  const barLens = useRef<number[]>([]);
  const boxes = useRef<Box[]>([]);
  const cur = useRef(-1);
  const lastPos = useRef<{ q: number; measure: number; off: number }>({ q: 0, measure: 1, off: 0 });
  const lastSystemY = useRef(-1);
  const [busy, setBusy] = useState(true);
  const [layout, setLayout] = useState(0); // bumps after every (re)draw so the bar marks are placed again
  const placed = useRef<{ step: number; measure: number }>({ step: -1, measure: -1 });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const rerender = useRef<((scroll: boolean) => void) | null>(null);
  const seekRef = useRef(onSeekMeasure);
  seekRef.current = onSeekMeasure;
  const selectRef = useRef(onLoopSelect);
  selectRef.current = onLoopSelect;
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const gesture = useRef<{ bar: number; x: number; y: number; dragging: boolean; timer?: ReturnType<typeof setTimeout>; mouse: boolean } | null>(null);
  const swallowClick = useRef(false);
  /** Bar being pressed and held (a ring fills while the long press counts down). */
  const [holdBar, setHoldBar] = useState(0);
  const noteEls = useRef<Map<string, SVGElement[]> | null>(null);
  const painted = useRef<{ els: SVGElement[]; added: Element[]; groups: SVGElement[] }>({ els: [], added: [], groups: [] });

  function collect(osmd: Osmd) {
    const c = osmd.cursor;
    c.show();
    c.reset();
    const byBar: Step[][] = [];
    const seen = new Set<string>();
    let guard = 0;
    let idx = 0;
    // OSMD's iterator follows repeats itself; keep only the first visit of every position
    // (the player decides the play order, we only need "where is bar m at offset o").
    while (!c.iterator.EndReached && guard++ < 200000) {
      const m = c.iterator.CurrentMeasureIndex + 1;
      const startQ = (c.iterator.CurrentMeasure?.AbsoluteTimestamp?.RealValue ?? 0) * 4;
      const off = Math.max(0, c.iterator.currentTimeStamp.RealValue * 4 - startQ);
      const key = `${m}:${Math.round(off * 1000)}`;
      if (!seen.has(key)) {
        seen.add(key);
        // where the cursor stands at this step (for the glide between notes)
        c.update();
        const el = c.cursorElement as HTMLElement | undefined;
        const x = (parseFloat(el?.style.left ?? '') || 0) + (el?.offsetWidth || 0) / 2;
        (byBar[m] ??= []).push({ off, idx, x });
        barLens.current[m] = (c.iterator.CurrentMeasure?.Duration?.RealValue ?? 1) * 4;
      }
      c.iterator.moveToNext();
      idx++;
    }
    for (const list of byBar) list?.sort((a, b) => a.off - b.off);
    c.reset();
    steps.current = byBar;
    stepCount.current = idx;
    cur.current = 0;
  }

  /**
   * Full-height box per written bar: x/width from the bar's own bounds, y/height from the staff
   * itself (top line .. bottom line of every staff in the system, plus room for ledger lines), so the
   * box never depends on where the notes happen to sit.
   */
  function measureBoxes(osmd: Osmd) {
    const list: Box[] = [];
    const zoom = osmd.zoom ?? 1;
    const staffH = osmd.EngravingRules?.StaffHeight ?? 4;
    const padY = 2.2; // staff spaces above and below, for ledger lines
    type GM = { PositionAndShape: { AbsolutePosition: { x: number; y: number }; BorderLeft: number; BorderRight: number } } | undefined;
    const ml = osmd.GraphicSheet.MeasureList as GM[][];
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
      if (x0 === Infinity) { list[i] = { x: 0, y: 0, w: 0, h: 0 }; return; }
      const k = UNIT * zoom;
      list[i] = { x: x0 * k, y: (y0 - padY) * k, w: (x1 - x0) * k, h: (y1 - y0 + 2 * padY) * k };
    });
    boxes.current = list;
  }

  /** Slide the cursor from the note it stands on toward the next one (and on to the bar line). */
  function glide(measure: number, offsetQ: number) {
    const el = osmdRef.current?.cursor?.cursorElement as HTMLElement | undefined;
    if (!el) return;
    const list = steps.current[measure];
    const b = boxes.current[measure - 1];
    const left = parseFloat(el.style.left) || 0;
    const w = el.offsetWidth || 0;
    let dx = 0;
    if (list?.length && b && b.w > 0) {
      // the bar boxes and the cursor are placed in different elements: bring the bar end into the cursor's frame
      const cp = el.parentElement?.getBoundingClientRect();
      const hp = hl.current?.parentElement?.getBoundingClientRect();
      const shift = cp && hp ? hp.left - cp.left : 0;
      const x = glideX(list, offsetQ, barLens.current[measure] ?? 4, shift + b.x + b.w - w / 2 - 1);
      if (x !== null) dx = x - (left + w / 2);
      // never further than the bar: a stale step (wrong line) must not throw the line across the page
      if (Math.abs(dx) > b.w) dx = 0;
    }
    el.style.transform = dx ? `translateX(${dx}px)` : '';
  }

  /** Cursor iterator index for written bar `measure` at `offsetQ` into it. */
  function stepFor(measure: number, offsetQ: number): number {
    const by = steps.current;
    for (let m = Math.min(measure, by.length - 1); m >= 1; m--) {
      const list = by[m];
      if (!list?.length) continue;
      if (m !== measure) return list[list.length - 1].idx; // empty bar: stay on the last step before it
      let pick = list[0];
      for (const st of list) if (st.off <= offsetQ + 1e-6) pick = st; else break;
      return pick.idx;
    }
    return 0;
  }

  function place(q: number, measure: number, scroll: boolean, offsetQ = 0, forceScroll = false) {
    lastPos.current = { q, measure, off: offsetQ };
    const osmd = osmdRef.current;
    if (!osmd || !stepCount.current) return;
    const target = stepFor(measure, offsetQ);
    // called on every animation frame while playing: glide the line, the rest only when it moves on
    glide(measure, offsetQ);
    if (!forceScroll && placed.current.step === target && placed.current.measure === measure) return;
    placed.current = { step: target, measure };
    const c = osmd.cursor;
    if (target !== cur.current) {
      if (target < cur.current) { c.reset(); cur.current = 0; }
      while (cur.current < target) { c.iterator.moveToNext(); cur.current++; }
      c.update();
      glide(measure, offsetQ);
    }
    // highlight the current bar
    const b = boxes.current[measure - 1];
    const el = hl.current;
    if (el && b && b.w > 0) {
      el.style.display = 'block';
      el.style.transform = `translate(${b.x}px, ${b.y}px)`;
      el.style.width = `${b.w}px`;
      el.style.height = `${b.h}px`;
    } else if (el) el.style.display = 'none';
    if (scroll) autoScroll(c.cursorElement as HTMLElement | undefined, forceScroll);
  }

  function autoScroll(el?: HTMLElement, force = false) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.height) return;
    const top = r.top + window.scrollY;
    const vh = window.innerHeight;
    // keep the cursor between the sticky header and the (measured) transport
    const header = (document.querySelector('.topbar') as HTMLElement | null)?.offsetHeight ?? 60;
    const transport = (document.querySelector('.transport') as HTMLElement | null)?.offsetHeight ?? 150;
    // the practice drawer covers the bottom of the score when it is a full-width bottom sheet
    const sheet = document.querySelector('.sheet:not([hidden])') as HTMLElement | null;
    const sheetH = sheet && sheet.offsetWidth >= window.innerWidth - 2 ? sheet.offsetHeight : 0;
    const topLimit = header + 10;
    const bottomBand = vh - transport - sheetH - 10;
    const sysChanged = Math.abs(top - lastSystemY.current) > 20;
    lastSystemY.current = top;
    if (force || r.top < topLimit || r.bottom > bottomBand || sysChanged && (r.top > topLimit + (bottomBand - topLimit) * 0.55)) {
      const room = Math.max(0, bottomBand - topLimit);
      window.scrollTo({ top: Math.max(0, top - topLimit - room * 0.2), behavior: force ? 'auto' : 'smooth' });
    }
  }

  useImperativeHandle(ref, () => ({
    setPosition: (q, m, off) => place(q, m, true, off ?? 0),
    ensureVisible: () => autoScroll(osmdRef.current?.cursor?.cursorElement as HTMLElement | undefined),
  }), []);

  useEffect(() => {
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastW = 0;

    async function renderAll(loadXml: boolean, scrollAfter = false) {
      const osmd = osmdRef.current;
      if (!osmd || cancelled) return;
      const w = wrap.current?.clientWidth ?? 360;
      osmd.zoom = (w < 520 ? 0.62 : w < 900 ? 0.8 : 1) * zoomRef.current;
      if (loadXml) {
        // readings come without beams: let the engraver group eighths and sixteenths by beat
        osmd.setOptions({ autoBeam: !xml.includes('<beam') });
        await osmd.load(xml);
      }
      if (cancelled) return;
      osmd.render();
      measureBoxes(osmd);
      collect(osmd);
      noteEls.current = null;
      painted.current = { els: [], added: [], groups: [] }; // the redraw replaced every element
      lastW = w;
      const { q, measure, off } = lastPos.current;
      cur.current = 0;
      placed.current = { step: -1, measure: -1 };
      place(q, measure, false, off);
      setLayout((n) => n + 1);
      if (scrollAfter) {
        // after rotate / zoom the layout moved: put the cursor back in view once it has settled
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!cancelled) autoScroll(osmd.cursor.cursorElement as HTMLElement | undefined, true);
        }));
      }
    }
    rerender.current = (scroll) => { renderAll(false, scroll).catch(() => {}); };

    (async () => {
      setBusy(true);
      try {
        if (!osmdRef.current) {
          const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay');
          if (cancelled || !host.current) return;
          osmdRef.current = new OpenSheetMusicDisplay(host.current, {
            autoResize: false,
            backend: 'svg',
            drawTitle: true,
            drawPartNames: false,
            followCursor: false,
            drawingParameters: 'compact',
            cursorsOptions: [{ type: 0, color: '#ff7a00', alpha: 0.75, follow: false }],
            // every written bar must stay visible (bar counter, highlight, cursor): no merged multi-bar rests
            autoGenerateMultipleRestMeasuresFromRestMeasures: false,
          });
          osmdRef.current.EngravingRules.RenderMultipleRestMeasures = false;
        }
        await renderAll(true);
        if (cancelled) return;
        setBusy(false);
        onReady?.({ measureCount: Math.max(0, steps.current.length - 1) });
        if (!ro && wrap.current) {
          ro = new ResizeObserver(() => {
            const w = wrap.current?.clientWidth ?? 0;
            if (Math.abs(w - lastW) < 8) return;
            clearTimeout(timer);
            timer = setTimeout(() => { renderAll(false, true).catch(() => {}); }, 200);
          });
          ro.observe(wrap.current);
        }
      } catch (e) {
        if (!cancelled) { setBusy(false); onError?.(`Could not draw this score: ${(e as Error).message}`); }
      }
    })();

    return () => { cancelled = true; clearTimeout(timer); ro?.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xml]);

  // zoom -/+: redraw at the new size and keep the cursor in view
  const firstZoom = useRef(true);
  useEffect(() => {
    if (firstZoom.current) { firstZoom.current = false; return; }
    const t = setTimeout(() => rerender.current?.(true), 120);
    return () => clearTimeout(t);
  }, [zoom]);

  /** Written bar (1-based) nearest to a screen point, or 0. */
  function barAt(clientX: number, clientY: number): number {
    const h = host.current;
    if (!h || !boxes.current.length) return 0;
    const rect = h.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = -1, bestD = Infinity;
    boxes.current.forEach((b, i) => {
      if (!b.w) return;
      const dx = x < b.x ? b.x - x : x > b.x + b.w ? x - (b.x + b.w) : 0;
      const dy = y < b.y ? b.y - y : y > b.y + b.h ? y - (b.y + b.h) : 0;
      const d = dx * dx + dy * dy * 4;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best + 1;
  }

  /** Drawn note heads of my part by note key (built on first use after every redraw: walking every step is not free). */
  function noteMap(): Map<string, SVGElement[]> | null {
    if (noteEls.current) return noteEls.current;
    const osmd = osmdRef.current;
    if (!osmd || !stepCount.current) return null;
    const c = osmd.cursor;
    const map = new Map<string, SVGElement[]>();
    const mine = osmd.Sheet?.Instruments?.[0];
    const seen = new Set<string>();
    let guard = 0;
    c.reset();
    while (!c.iterator.EndReached && guard++ < 200000) {
      const m = c.iterator.CurrentMeasureIndex + 1;
      const startQ = (c.iterator.CurrentMeasure?.AbsoluteTimestamp?.RealValue ?? 0) * 4;
      const off = Math.max(0, c.iterator.currentTimeStamp.RealValue * 4 - startQ);
      const key = `${m}:${Math.round(off * 1000)}`;
      if (!seen.has(key)) {
        seen.add(key);
        let gns: Osmd[] = [];
        try { gns = c.GNotesUnderCursor() ?? []; } catch { gns = []; }
        for (const gn of gns) {
          try {
            if (gn.sourceNote?.isRest?.()) continue;
            const owner = gn.sourceNote?.ParentStaff?.ParentInstrument;
            if (mine && owner && owner !== mine) continue;
            const el = gn.getSVGGElement?.() as SVGElement | undefined;
            if (el) { const l = map.get(key) ?? []; l.push(el); map.set(key, l); }
          } catch { /* a note we cannot reach is simply not coloured */ }
        }
      }
      c.iterator.moveToNext();
    }
    c.reset();
    cur.current = 0;
    placed.current = { step: -1, measure: -1 };
    const { q, measure, off } = lastPos.current;
    place(q, measure, false, off);
    noteEls.current = map;
    return map;
  }

  function clearAnnotations() {
    for (const el of painted.current.els) { el.style.removeProperty('fill'); el.style.removeProperty('stroke'); }
    for (const el of painted.current.added) el.remove();
    for (const g of painted.current.groups) g.removeAttribute('data-mark');
    painted.current = { els: [], added: [], groups: [] };
  }

  function paint() {
    clearAnnotations();
    if (!marks?.length && !labels?.length) return;
    const map = noteMap();
    if (!map) return;
    const osmd = osmdRef.current;
    const fs = Math.max(9, (osmd?.zoom ?? 1) * UNIT * 1.5);
    const addText = (g: SVGElement, text: string, color: string, dy: number, extra?: Record<string, string>, box?: DOMRect, down = 0) => {
      let bb: DOMRect;
      try { bb = box ?? (g as unknown as SVGGraphicsElement).getBBox(); } catch { return; }
      if (!bb.width && !bb.height) return;
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.textContent = text;
      t.setAttribute('x', String(bb.x + bb.width / 2));
      t.setAttribute('y', String(dy < 0 ? bb.y - 3 : bb.y + bb.height + fs + 1 + down));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-size', String(fs));
      t.setAttribute('font-weight', '700');
      t.setAttribute('font-family', 'system-ui, sans-serif');
      t.style.fill = color;
      t.style.stroke = 'none';
      for (const [k, v] of Object.entries(extra ?? {})) t.setAttribute(k, v);
      g.appendChild(t);
      painted.current.added.push(t);
    };
    for (const m of marks ?? []) {
      const color = MARK_COLOR[m.kind];
      for (const g of map.get(noteKey(m.measure, m.offQ)) ?? []) {
        g.querySelectorAll<SVGElement>('path, rect, ellipse, circle').forEach((c) => { c.style.fill = color; c.style.stroke = color; painted.current.els.push(c); });
        g.setAttribute('data-mark', m.kind);
        painted.current.groups.push(g);
        if (m.arrow) addText(g, m.arrow === 'up' ? '↑' : '↓', color, -1, { 'data-arrow': m.arrow });
      }
    }
    if (labelStyle === 'off') return;
    for (const l of labels ?? []) {
      for (const g of map.get(noteKey(l.measure, l.offQ)) ?? []) {
        const attrs = { 'data-finger': l.text, 'data-opts': [l.text, ...(l.alts ?? [])].join('|'), 'data-i': '0', style: 'cursor:pointer' };
        const mark = markOfText(l.text, slide, labelStyle);
        if (!mark || (!mark.dots && mark.slide === null)) { addText(g, mark?.text ?? l.text, FINGER_INK, 1, attrs); continue; }
        // valve dots (or the slide icon) under the note, the number under them
        let bb: DOMRect;
        try { bb = (g as unknown as SVGGraphicsElement).getBBox(); } catch { continue; }
        if (!bb.width && !bb.height) continue;
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        icon.setAttribute('transform', `translate(${(bb.x + bb.width / 2).toFixed(1)} ${(bb.y + bb.height + 3).toFixed(1)})`);
        icon.setAttribute('data-finger-icon', '');
        const h = drawFingerIcon(icon, l.text, slide, fs * 0.92);
        g.appendChild(icon);
        painted.current.added.push(icon);
        if (mark.text !== null) addText(g, mark.text, FINGER_INK, 1, attrs, bb, h + 2);
        else { for (const [k, v] of Object.entries(attrs)) icon.setAttribute(k, v); icon.setAttribute('data-size', String(fs * 0.92)); }
      }
    }
  }
  const paintRef = useRef(paint);
  paintRef.current = paint;
  // marks and fingerings are painted again after every redraw and whenever they change
  useEffect(() => { if (!busy) paintRef.current(); }, [marks, labels, labelStyle, slide, layout, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  function onClick(e: React.MouseEvent) {
    if (swallowClick.current) { swallowClick.current = false; return; }
    // a fingering: tap to see the next way to play the note instead of jumping to the bar
    const f = (e.target as Element | null)?.closest?.('[data-finger]');
    if (f) {
      const opts = (f.getAttribute('data-opts') ?? '').split('|');
      if (opts.length > 1) {
        const i = (Number(f.getAttribute('data-i') ?? '0') + 1) % opts.length;
        f.setAttribute('data-i', String(i));
        f.setAttribute('data-alt', i === 0 ? '0' : '1');
        if (f.tagName.toLowerCase() === 'text') {
          f.textContent = opts[i];
          // the dots above the number show the same way of playing the note
          const icon = f.previousElementSibling;
          if (icon?.hasAttribute('data-finger-icon')) drawFingerIcon(icon as SVGGElement, opts[i], slide, Number(f.getAttribute('font-size')) * 0.92);
        } else drawFingerIcon(f as SVGGElement, opts[i], slide, Number(f.getAttribute('data-size')) || 12);
      }
      return;
    }
    const bar = barAt(e.clientX, e.clientY);
    if (bar > 0) seekRef.current(bar);
  }

  // pick practice-loop bars: press and hold a bar (touch), or press and drag across bars (mouse)
  function onPointerDown(e: React.PointerEvent) {
    if (!selectRef.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const bar = barAt(e.clientX, e.clientY);
    if (!bar) return;
    const g = { bar, x: e.clientX, y: e.clientY, dragging: false, mouse: e.pointerType === 'mouse' } as NonNullable<typeof gesture.current>;
    g.timer = setTimeout(() => {
      if (gesture.current !== g || g.dragging) return;
      g.dragging = true; // a long press: swallow the click that follows
      swallowClick.current = true;
      setHoldBar(0);
      try { navigator.vibrate?.(15); } catch { /* not every phone can */ }
      const l = loopRef.current;
      // a second long press beyond the loop stretches it, inside it starts a new one
      if (l && bar < l.from) selectRef.current?.(bar, l.to);
      else if (l && bar > l.to) selectRef.current?.(l.from, bar);
      else selectRef.current?.(bar, bar);
    }, 500);
    gesture.current = g;
    if (!g.mouse) setHoldBar(bar);
  }
  function onPointerMove(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g) return;
    const moved = Math.hypot(e.clientX - g.x, e.clientY - g.y);
    if (!g.mouse) { if (moved > 10 && !g.dragging) { clearTimeout(g.timer); gesture.current = null; setHoldBar(0); } return; }
    if (moved < 6 && !g.dragging) return;
    const bar = barAt(e.clientX, e.clientY);
    if (!bar) return;
    if (!g.dragging && bar === g.bar) return;
    clearTimeout(g.timer);
    g.dragging = true;
    swallowClick.current = true;
    selectRef.current?.(Math.min(g.bar, bar), Math.max(g.bar, bar));
  }
  function endGesture() {
    const g = gesture.current;
    if (g) clearTimeout(g.timer);
    gesture.current = null;
    setHoldBar(0);
    // the click (if any) comes right after pointerup; make sure a stale flag cannot swallow a later tap
    if (swallowClick.current) setTimeout(() => { swallowClick.current = false; }, 60);
  }

  useEffect(() => {
    const unmount = () => { try { osmdRef.current?.clear?.(); } catch { /* ignore */ } };
    return unmount;
  }, []);

  return (
    <div className="score" ref={wrap} data-testid="score" data-busy={busy ? '1' : '0'}>
      {busy && <div className="score-busy"><span className="spinner" aria-hidden /> Drawing score…</div>}
      <div className="score-inner" onClick={onClick} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endGesture} onPointerCancel={endGesture} onPointerLeave={endGesture} onContextMenu={(e) => { if (gesture.current?.dragging || swallowClick.current) e.preventDefault(); }}>
        <div className="score-host" ref={host} />
        {layout > 0 && loop && boxes.current.slice(loop.from - 1, loop.to).map((b, i) => (
          b && b.w > 0 ? <div key={`loop${loop.from + i}`} className={`loop-mark${i === 0 ? ' first' : ''}${i === loop.to - loop.from ? ' last' : ''}`} data-testid="loop-mark" data-label={i === 0 ? (loop.from === loop.to ? 'Loop' : `Loop ${loop.from}–${loop.to}`) : undefined} style={{ transform: `translate(${b.x}px, ${b.y}px)`, width: b.w, height: b.h }} /> : null
        ))}
        {layout > 0 && holdBar > 0 && boxes.current[holdBar - 1]?.w > 0 && (
          <div className="hold-ring" data-testid="hold-ring" style={{ transform: `translate(${boxes.current[holdBar - 1].x}px, ${boxes.current[holdBar - 1].y}px)`, width: boxes.current[holdBar - 1].w, height: boxes.current[holdBar - 1].h }}><i /></div>
        )}
        <div className="bar-hl" ref={hl} data-testid="bar-highlight" />
        {layout > 0 && (flagged ?? []).map((m) => {
          const b = boxes.current[m - 1];
          return b && b.w > 0 ? <div key={m} className="bar-flag" data-testid="bar-flag" style={{ transform: `translate(${b.x}px, ${b.y}px)`, width: b.w, height: b.h }} /> : null;
        })}
      </div>
    </div>
  );
});

export default ScoreView;
