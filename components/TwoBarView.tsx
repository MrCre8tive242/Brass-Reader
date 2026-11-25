'use client';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { noteKey, offsetInBar, type Timeline } from '@/lib/timeline';
import { windowAt, windowOfSlot, nextSlotOf, prevSlotOf, type BarWindow } from '@/lib/barWindow';
import { drawWindow, makeWindowOsmd, type Box, type Osmd, type WindowLayout } from '@/lib/windowRender';
import { windowOverlay, type Overlay, type NoteLookup } from '@/lib/windowOverlay';
import type { FingerStyle } from '@/lib/fingerStyle';
import type { InstrumentId } from '@/lib/instruments';
import type { NoteMark } from './ScoreView';

export interface TwoBarHandle {
  /** Move the cursor to quarter-note position q (play order). */
  setPosition: (q: number, measure: number, offsetQ?: number) => void;
  /** Scroll so the two bars are between the header and the transport. */
  ensureVisible: () => void;
}

interface Props {
  /** The score of my part (single part MusicXML) the timeline was built from. */
  xml: string;
  tl: Timeline;
  /** Practice loop in play-order quarters: at its end the next bar shown is its first. */
  loopQ: { startQ: number; endQ: number } | null;
  /** Practice loop in written bars, for the shading. */
  loop: { from: number; to: number } | null;
  instrument: InstrumentId;
  style: FingerStyle;
  /** Part of the timeline that is mine (events of other parts are not fingered). */
  myIdx: number;
  flagged?: number[];
  marks?: NoteMark[];
  /** Where the player is now (quarters, play order): the view starts there. */
  getQ?: () => number;
  onSeekMeasure: (measure: number) => void;
  onLoopSelect?: (from: number, to: number) => void;
  onReady?: () => void;
  onError?: (msg: string) => void;
}

const MARK_COLOR: Record<NoteMark['kind'], string> = { green: '#1c9c47', yellow: '#d99a00', red: '#d62d20', range: '#8a2be2' };
const NS = 'http://www.w3.org/2000/svg';

interface Pane {
  el: HTMLDivElement;
  host: HTMLDivElement;
  overlay: SVGSVGElement;
  hl: HTMLDivElement;
  extras: HTMLDivElement;
  osmd: Osmd | null;
  key: string;
  gen: number;
  bars: number[];
  layout: WindowLayout | null;
  /** Boxes of the drawn bars, reaching down over the fingerings. */
  boxes: Box[];
  ready: Promise<void>;
  /** px height the pane needs (drawing plus fingerings). */
  height: number;
  stamp: number;
  painted: { els: SVGElement[]; added: Element[] };
  failed: boolean;
}

const svgEl = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

/** The drawing, the fingerings and the moving line of the 2-bar view. Plain DOM work, driven by the React wrapper below. */
class Core {
  panes: Pane[] = [];
  active: Pane | null = null;
  gen = 0;
  token = 0;
  clock = 0;
  q = 0;
  minH = 0;
  disposed = false;
  readyOnce = false;
  placed = '';
  lookupCache: { tl: Timeline; my: number; map: Map<string, number> } | null = null;
  cursor: HTMLDivElement;
  constructor(public stage: HTMLDivElement, public props: () => Props, private onFirst: () => void) {
    this.cursor = document.createElement('div');
    this.cursor.className = 'tb-cursor';
    this.cursor.setAttribute('data-testid', 'tb-cursor');
    this.cursor.style.display = 'none';
    stage.appendChild(this.cursor);
    this.q = props().getQ?.() ?? 0;
  }

  // ---- sizes ----
  size() {
    const p = this.props();
    const width = Math.max(200, this.stage.clientWidth);
    const topbar = (document.querySelector('.topbar') as HTMLElement | null)?.offsetHeight ?? 56;
    const transport = (document.querySelector('.transport') as HTMLElement | null)?.offsetHeight ?? 150;
    const vh = window.innerHeight;
    const landscape = width > 560;
    const height = Math.max(150, Math.min(landscape ? 460 : 640, vh - topbar - transport - (landscape ? 28 : 70)));
    const below = p.style === 'off' ? 1.2 : p.style === 'dots' ? 3.6 : 5;
    return { width, height, stack: !landscape, below };
  }

  lookup(): NoteLookup {
    const p = this.props();
    if (!this.lookupCache || this.lookupCache.tl !== p.tl || this.lookupCache.my !== p.myIdx) {
      const map = new Map<string, number>();
      for (const e of p.tl.events) {
        if (e.part !== undefined && e.part !== p.myIdx) continue;
        const k = noteKey(e.measure, offsetInBar(p.tl, e.timeQ));
        if (!map.has(k)) map.set(k, e.midi);
      }
      this.lookupCache = { tl: p.tl, my: p.myIdx, map };
    }
    const m = this.lookupCache.map;
    return (bar, off) => m.get(noteKey(bar, off));
  }

  // ---- panes ----
  makePane(): Pane {
    const el = document.createElement('div');
    el.className = 'tb-pane';
    el.style.visibility = 'hidden';
    const host = document.createElement('div');
    host.className = 'tb-host';
    const extras = document.createElement('div');
    extras.className = 'tb-extras';
    const hl = document.createElement('div');
    hl.className = 'bar-hl';
    hl.setAttribute('data-testid', 'bar-highlight');
    const overlay = svgEl('svg', { class: 'tb-fing', 'aria-hidden': 'true' });
    el.append(host, extras, hl, overlay);
    this.stage.insertBefore(el, this.cursor);
    return { el, host, overlay, hl, extras, osmd: null, key: '', gen: -1, bars: [], layout: null, boxes: [], ready: Promise.resolve(), height: 0, stamp: 0, painted: { els: [], added: [] }, failed: false };
  }

  windowFor(q: number) {
    const p = this.props();
    return windowAt(p.tl, q, p.loopQ);
  }

  ensure(win: BarWindow, protect: string[]): Pane {
    let pane = this.panes.find((x) => x.key === win.key && x.gen === this.gen);
    if (pane) { pane.stamp = ++this.clock; return pane; }
    const spare = this.panes.filter((x) => x !== this.active && !protect.includes(x.key));
    if (this.panes.length < 3) { pane = this.makePane(); this.panes.push(pane); }
    else {
      pane = spare.sort((a, b) => a.stamp - b.stamp)[0] ?? this.panes.filter((x) => x !== this.active).sort((a, b) => a.stamp - b.stamp)[0];
      if (!pane) { pane = this.makePane(); this.panes.push(pane); }
    }
    pane.key = win.key; pane.gen = this.gen; pane.bars = win.bars; pane.layout = null; pane.failed = false;
    pane.stamp = ++this.clock;
    const mine = pane;
    const prev = mine.ready;
    mine.ready = prev.then(() => this.render(mine, win));
    return mine;
  }

  async render(pane: Pane, win: BarWindow) {
    if (this.disposed || pane.key !== win.key || pane.gen !== this.gen) return;
    const p = this.props();
    try {
      if (!pane.osmd) pane.osmd = await makeWindowOsmd(pane.host);
      if (this.disposed || pane.key !== win.key || pane.gen !== this.gen) return;
      const s = this.size();
      pane.el.style.width = `${s.width}px`;
      const layout = await drawWindow(pane.osmd, p.xml, win.bars, { width: s.width, height: s.height, below: s.below, stack: s.stack, maxSpace: s.stack ? 22 : 30, minGapPx: p.style === 'off' ? 0 : 30 });
      if (this.disposed || pane.key !== win.key || pane.gen !== this.gen) return;
      pane.layout = layout;
      pane.osmd.cursor.hide();
      pane.el.setAttribute('data-zoom', String(Math.round(layout.zoom * 100) / 100));
      pane.el.setAttribute('data-notes', JSON.stringify(layout.notes.map((n) => [n.bar, Math.round(n.off * 1000) / 1000, Math.round(n.x)])));
      this.paint(pane);
    } catch (e) {
      pane.failed = true;
      pane.layout = null;
      p.onError?.(`Could not draw these bars: ${(e as Error).message}`);
    }
  }

  /** Fingerings, bar names, loop and flag shading, and note colours of one drawn window. */
  paint(pane: Pane) {
    const layout = pane.layout;
    if (!layout) return;
    const p = this.props();
    const labels = pane.bars.map((b) => p.tl.barLabels[b - 1] ?? String(b));
    const ov: Overlay = windowOverlay(layout, pane.bars, labels, this.lookup(), p.instrument, p.style);
    const svg = pane.overlay;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('width', String(layout.width));
    svg.setAttribute('height', String(Math.ceil(ov.bottom + 4)));
    svg.setAttribute('data-fs', String(Math.round(ov.fs * 10) / 10));
    for (const it of ov.items) {
      const g = svgEl('g', { transform: `translate(${it.x.toFixed(1)} ${it.y.toFixed(1)})` });
      if (it.finger) {
        g.setAttribute('data-tb-finger', it.finger.text ?? '');
        g.setAttribute('data-bar', String(it.finger.bar));
        g.setAttribute('data-off', String(Math.round(it.finger.off * 1000) / 1000));
      }
      for (const sh of it.shapes) {
        if (sh.t === 'box') g.appendChild(svgEl('rect', { x: sh.x.toFixed(1), y: sh.y.toFixed(1), width: sh.w.toFixed(1), height: sh.h.toFixed(1), rx: sh.r.toFixed(1), class: 'cell', 'stroke-width': 1 }));
        else if (sh.t === 'dot') g.appendChild(svgEl('circle', { cx: sh.x.toFixed(1), cy: sh.y.toFixed(1), r: sh.r.toFixed(1), 'stroke-width': Math.max(1.3, sh.r * 0.3).toFixed(1), class: sh.filled ? 'dot on' : 'dot' }));
        else if (sh.t === 'marker') g.appendChild(svgEl('circle', { cx: sh.x.toFixed(1), cy: sh.y.toFixed(1), r: sh.r.toFixed(1), class: 'dot on', 'stroke-width': 1 }));
        else if (sh.t === 'line') g.appendChild(svgEl('line', { x1: sh.x1.toFixed(1), y1: sh.y1.toFixed(1), x2: sh.x2.toFixed(1), y2: sh.y2.toFixed(1), 'stroke-width': sh.w.toFixed(1), class: 'ln' }));
        else {
          const t = svgEl('text', { x: sh.x.toFixed(1), y: sh.y.toFixed(1), 'font-size': sh.size.toFixed(1), 'text-anchor': sh.anchor ?? 'middle', class: sh.muted ? 'lbl' : 'num' });
          t.textContent = sh.text;
          g.appendChild(t);
        }
      }
      svg.appendChild(g);
    }
    pane.height = Math.max(layout.height, ov.bottom + 4);
    pane.boxes = layout.bars.map((b, i) => ({ ...b, h: Math.max(b.h, (ov.barBottom[i] ?? b.y + b.h) - b.y) }));
    pane.el.setAttribute('data-boxes', JSON.stringify(pane.boxes.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)])));
    // shading
    while (pane.extras.firstChild) pane.extras.removeChild(pane.extras.firstChild);
    pane.boxes.forEach((b, i) => {
      if (!b.w) return;
      const written = pane.bars[i];
      const style = `transform: translate(${b.x}px, ${b.y}px); width: ${b.w}px; height: ${b.h}px`;
      if (p.loop && written >= p.loop.from && written <= p.loop.to) {
        const d = document.createElement('div');
        d.className = 'loop-mark'; d.setAttribute('data-testid', 'loop-mark'); d.setAttribute('style', style);
        pane.extras.appendChild(d);
      }
      if (p.flagged?.includes(written)) {
        const d = document.createElement('div');
        d.className = 'bar-flag'; d.setAttribute('data-testid', 'bar-flag'); d.setAttribute('style', style);
        pane.extras.appendChild(d);
      }
    });
    this.paintMarks(pane);
    if (pane === this.active) this.fitStage(pane);
  }

  paintMarks(pane: Pane) {
    for (const el of pane.painted.els) { el.style.removeProperty('fill'); el.style.removeProperty('stroke'); }
    for (const el of pane.painted.added) el.remove();
    pane.painted = { els: [], added: [] };
    const layout = pane.layout;
    const marks = this.props().marks;
    if (!layout || !marks?.length) return;
    const by = new Map<string, NoteMark>();
    for (const m of marks) by.set(noteKey(m.measure, m.offQ), m);
    for (const n of layout.notes) {
      const m = by.get(noteKey(pane.bars[n.bar - 1] ?? 0, n.off));
      if (!m || !n.el) continue;
      const color = MARK_COLOR[m.kind];
      n.el.querySelectorAll<SVGElement>('path, rect, ellipse, circle').forEach((c) => { c.style.fill = color; c.style.stroke = color; pane.painted.els.push(c); });
      if (m.arrow) {
        const t = svgEl('text', { x: n.x, y: m.arrow === 'up' ? n.top - 4 : n.bottom + 14, 'text-anchor': 'middle', 'font-size': Math.max(12, layout.space * 1.6), 'font-weight': 700 });
        t.setAttribute('style', `fill:${color}`);
        t.textContent = m.arrow === 'up' ? '↑' : '↓';
        pane.overlay.appendChild(t);
        pane.painted.added.push(t);
      }
    }
  }

  fitStage(pane: Pane) {
    this.minH = Math.max(this.minH, pane.height);
    this.stage.style.height = `${Math.ceil(this.minH)}px`;
  }

  activate(pane: Pane) {
    for (const x of this.panes) x.el.style.visibility = x === pane ? 'visible' : 'hidden';
    this.active = pane;
    pane.el.setAttribute('data-active', '1');
    for (const x of this.panes) if (x !== pane) x.el.removeAttribute('data-active');
    this.stage.setAttribute('data-bars', pane.key);
    this.fitStage(pane);
    this.placed = '';
    this.cursor.style.display = 'block';
    if (!this.readyOnce) { this.readyOnce = true; this.onFirst(); }
  }

  // ---- showing the right window ----
  async show() {
    if (this.disposed) return;
    const win = this.windowFor(this.q);
    const a = this.active;
    if (a && a.key === win.key && a.gen === this.gen && a.layout) { this.applyPos(); return; }
    const token = ++this.token;
    const protect = this.protectKeys(win);
    const pane = this.ensure(win, protect);
    await pane.ready;
    if (token !== this.token || this.disposed) return;
    if (!pane.layout) return;
    // the position may have moved on while this was drawn
    const now = this.windowFor(this.q);
    if (now.key !== win.key) { void this.show(); return; }
    this.activate(pane);
    this.applyPos();
    this.autoScroll(false);
    // draw the bars that come next (and the ones before, for "back") while the music plays
    setTimeout(() => { void this.prefetch(win); }, 30);
  }

  protectKeys(win: BarWindow): string[] {
    const p = this.props();
    const keys = [win.key];
    const n = nextSlotOf(p.tl, win.slot, p.loopQ);
    const b = prevSlotOf(p.tl, win.slot, p.loopQ);
    if (n !== null) keys.push(windowOfSlot(p.tl, n, p.loopQ).key);
    if (b !== null) keys.push(windowOfSlot(p.tl, b, p.loopQ).key);
    return keys;
  }

  async prefetch(win: BarWindow) {
    if (this.disposed) return;
    const p = this.props();
    const protect = this.protectKeys(win);
    for (const s of [nextSlotOf(p.tl, win.slot, p.loopQ), prevSlotOf(p.tl, win.slot, p.loopQ)]) {
      if (s === null || this.disposed) continue;
      if (this.token && this.windowFor(this.q).key !== win.key) return; // moved on
      const w = windowOfSlot(p.tl, s, p.loopQ);
      const pane = this.ensure(w, protect);
      await pane.ready;
    }
  }

  setPosition(q: number) {
    this.q = q;
    const a = this.active;
    const win = this.windowFor(q);
    if (a && a.key === win.key && a.gen === this.gen) this.applyPos(win.offQ);
    else void this.show();
  }

  applyPos(offQ?: number) {
    const a = this.active;
    if (!a?.layout) return;
    const win = this.windowFor(this.q);
    if (win.key !== a.key) return;
    const off = offQ ?? win.offQ;
    const L = a.layout;
    let pick = L.steps.find((s) => s.bar === 1);
    for (const s of L.steps) if (s.bar === 1 && s.off <= off + 1e-6) pick = s;
    const b = a.boxes[0] ?? L.bars[0];
    const tag = `${a.key}:${pick?.idx ?? -1}:${this.gen}`;
    if (tag === this.placed) return;
    this.placed = tag;
    if (b && b.w > 0) {
      a.hl.style.display = 'block';
      a.hl.style.transform = `translate(${b.x}px, ${b.y}px)`;
      a.hl.style.width = `${b.w}px`;
      a.hl.style.height = `${b.h}px`;
      if (pick) {
        this.cursor.style.display = 'block';
        const w = Math.max(3, L.space * 0.45);
        this.cursor.style.width = `${w}px`;
        this.cursor.style.height = `${b.h}px`;
        this.cursor.style.transform = `translate(${pick.x - w / 2}px, ${b.y}px)`;
        this.cursor.setAttribute('data-step', String(pick.idx));
      }
    } else a.hl.style.display = 'none';
  }

  autoScroll(force: boolean) {
    const r = this.stage.getBoundingClientRect();
    if (!r.height) return;
    const topbar = (document.querySelector('.topbar') as HTMLElement | null)?.offsetHeight ?? 56;
    const transport = (document.querySelector('.transport') as HTMLElement | null)?.offsetHeight ?? 150;
    const sheet = document.querySelector('.sheet:not([hidden])') as HTMLElement | null;
    const sheetH = sheet && sheet.offsetWidth >= window.innerWidth - 2 ? sheet.offsetHeight : 0;
    const top = topbar + 6;
    const bottom = window.innerHeight - transport - sheetH - 6;
    if (force || r.top < top || r.bottom > bottom) {
      const room = Math.max(0, bottom - top - r.height);
      window.scrollTo({ top: Math.max(0, r.top + window.scrollY - top - room / 2), behavior: force ? 'auto' : 'smooth' });
    }
  }

  /** Everything drawn is stale (new score, new size): start again from the current position. */
  reset() {
    this.gen++;
    this.minH = 0;
    this.stage.style.height = '';
    this.placed = '';
    void this.show();
  }

  /** Only the writing on top changed (fingering style, instrument, shading, colours). */
  repaint() {
    this.lookupCache = null;
    for (const p of this.panes) if (p.layout && p.gen === this.gen) this.paint(p);
    this.placed = '';
    this.applyPos();
  }

  dispose() {
    this.disposed = true;
    for (const p of this.panes) { try { p.osmd?.clear?.(); } catch { /* ignore */ } p.el.remove(); }
    this.panes = [];
    this.active = null;
    this.cursor.remove();
  }
}

const TwoBarView = forwardRef<TwoBarHandle, Props>(function TwoBarView(props, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const core = useRef<Core | null>(null);
  const P = useRef(props);
  P.current = props;
  const [busy, setBusy] = useState(true);
  const gesture = useRef<{ x: number; y: number; timer?: ReturnType<typeof setTimeout>; long: boolean } | null>(null);
  const swallow = useRef(false);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // the page is told once the first bars are drawn
    const c = new Core(stage, () => P.current, () => { setBusy(false); P.current.onReady?.(); });
    core.current = c;
    let lastW = stage.clientWidth;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      const w = stage.clientWidth;
      if (Math.abs(w - lastW) < 8) return;
      lastW = w;
      clearTimeout(timer);
      timer = setTimeout(() => c.reset(), 200);
    });
    ro.observe(stage);
    const onOrient = () => { clearTimeout(timer); timer = setTimeout(() => c.reset(), 250); };
    window.addEventListener('orientationchange', onOrient);
    return () => { clearTimeout(timer); ro.disconnect(); window.removeEventListener('orientationchange', onOrient); c.dispose(); core.current = null; };
  }, []);

  // a new score (another instrument, octave move, part): draw again
  useEffect(() => { core.current?.reset(); }, [props.xml, props.tl]);
  // the bars after a loop wraps differ: show the right ones
  useEffect(() => { core.current?.show(); }, [props.loopQ?.startQ, props.loopQ?.endQ]);
  // writing on top
  useEffect(() => { core.current?.repaint(); }, [props.style, props.instrument, props.marks, props.flagged, props.loop?.from, props.loop?.to]);

  useImperativeHandle(ref, () => ({
    setPosition: (q) => core.current?.setPosition(q),
    ensureVisible: () => core.current?.autoScroll(false),
  }), []);

  /** Written bar under a screen point (the drawn bar nearest to it), or 0. */
  function barAt(clientX: number, clientY: number): number {
    const c = core.current;
    const a = c?.active;
    const stage = stageRef.current;
    if (!c || !a?.layout || !stage) return 0;
    const r = stage.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    let best = -1, bestD = Infinity;
    a.boxes.forEach((b, i) => {
      if (!b.w) return;
      const dx = x < b.x ? b.x - x : x > b.x + b.w ? x - (b.x + b.w) : 0;
      const dy = y < b.y ? b.y - y : y > b.y + b.h ? y - (b.y + b.h) : 0;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best >= 0 ? a.bars[best] ?? 0 : 0;
  }
  function onClick(e: React.MouseEvent) {
    if (swallow.current) { swallow.current = false; return; }
    const bar = barAt(e.clientX, e.clientY);
    if (bar > 0) P.current.onSeekMeasure(bar);
  }
  function onPointerDown(e: React.PointerEvent) {
    if (!P.current.onLoopSelect || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const bar = barAt(e.clientX, e.clientY);
    if (!bar) return;
    const g: NonNullable<typeof gesture.current> = { x: e.clientX, y: e.clientY, long: false };
    g.timer = setTimeout(() => {
      if (gesture.current !== g) return;
      g.long = true;
      swallow.current = true;
      try { navigator.vibrate?.(15); } catch { /* not every phone can */ }
      P.current.onLoopSelect?.(bar, bar);
    }, 500);
    gesture.current = g;
  }
  function onPointerMove(e: React.PointerEvent) {
    const g = gesture.current;
    if (g && !g.long && Math.hypot(e.clientX - g.x, e.clientY - g.y) > 10) { clearTimeout(g.timer); gesture.current = null; }
  }
  function endGesture() {
    const g = gesture.current;
    if (g) clearTimeout(g.timer);
    gesture.current = null;
    if (swallow.current) setTimeout(() => { swallow.current = false; }, 60);
  }

  return (
    <div className="score tb" ref={wrap} data-testid="twobar" data-busy={busy ? '1' : '0'} data-style={props.style}>
      {busy && <div className="score-busy"><span className="spinner" aria-hidden /> Drawing bars…</div>}
      <div className="tb-stage" ref={stageRef} onClick={onClick} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endGesture} onPointerCancel={endGesture} onPointerLeave={endGesture} onContextMenu={(e) => { if (swallow.current) e.preventDefault(); }} />
    </div>
  );
});

export default TwoBarView;
