import { windowOverlay, type Overlay, type NoteLookup } from './windowOverlay';
import { drawWindow, makeWindowOsmd, measureLayout, type Box, type Osmd, type WindowLayout } from './windowRender';
import { noteKey, offsetInBar, slotAt, type Timeline } from './timeline';
import { glideX } from './glide';
import type { FingerShape, FingerStyle } from './fingerStyle';
import type { InstrumentId } from './instruments';
import { framePos, frameCount, videoSeconds, videoSize, countInLead, estimateBytes, NO_LEAD, WARN_BYTES, VIDEO_FPS, VIDEO_BPS, AUDIO_BPS, type FramePos, type Lead, type VideoOrientation, type VideoView } from './videoPlan';
import { AudioRenderer, type AudioJob } from './videoAudio';
import { VideoMux } from './videoMux';
import { browserProbes, chooseRoute, realtimeRoute, routeWords, type Route } from './videoSupport';

export interface VideoJob {
  title: string;
  instrumentName: string;
  bpm: number;
  /** Single-part MusicXML of my part (what the timeline was built from). */
  xml: string;
  /** What is played (the whole tune, or a part of it such as the practice loop). */
  tl: Timeline;
  /** The whole tune, when `tl` is only a part of it: the full sheet shows fingerings for every bar on the page. */
  wholeTl?: Timeline;
  myIdx: number;
  instrument: InstrumentId;
  view: VideoView;
  orientation: VideoOrientation;
  style: FingerStyle;
  /** One bar of clicks, counted on screen, before the music. */
  countIn?: boolean;
  audio: AudioJob;
}

export type VideoKind = 'mp4' | 'webm' | 'realtime';

export interface VideoResult {
  blob: Blob;
  mime: string;
  ext: 'mp4' | 'webm';
  /** `mp4` / `webm` = made faster than real time; `realtime` = recorded while playing. */
  kind: VideoKind;
  /** Plain words about the format for the screen. */
  format: string;
  durationS: number;
  bytes: number;
  width: number;
  height: number;
  frames: number;
  /** What the sound was made with, and how loud each second of it is (0 = silence). */
  audio: { engine: 'soundfont' | 'synth' | null; rms: number[] };
  /** Said under the result when something did not go the usual way. */
  note?: string;
}

export interface VideoOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number, label: string) => void;
  /** How to make the file (from `videoRoute`); worked out here when missing. */
  route?: Route;
  /**
   * An AudioContext made while the person tapped the button. Recording in real time needs one that is running, and a
   * phone only lets it start from a tap. Not closed here.
   */
  liveCtx?: AudioContext | null;
  /** Called with the canvas the frames are drawn on, to show it while the video is made. */
  onCanvas?: (canvas: HTMLCanvasElement) => void;
}

export class VideoCancelled extends Error { constructor() { super('cancelled'); } }

/** How this browser will make a video of this shape. */
export function videoRoute(orientation: VideoOrientation): Promise<Route> {
  const { width, height } = videoSize(orientation);
  return chooseRoute(width, height, browserProbes(), { fps: VIDEO_FPS, videoBps: VIDEO_BPS, audioBps: AUDIO_BPS });
}

// ---------------------------------------------------------------------------------------------------------------
// drawing a frame
// ---------------------------------------------------------------------------------------------------------------

const PAPER = '#fffdf7';
const BG = '#f3ead6';
const INK = '#2a2218';
const MUTED = '#8a7a5c';
const FAINT = '#cfc3a6';
const ACCENT = '#b05200';

interface Raster {
  img: HTMLImageElement;
  url: string;
  layout: WindowLayout;
  overlay: Overlay;
  /** Boxes of the drawn bars (reaching down over the fingerings). */
  boxes: Box[];
  /** Where in the notation area the drawing's top-left sits. */
  ox: number;
  oy: number;
  /** Full sheet: the part of the drawing this page shows (drawn px from the top). */
  y0: number;
  y1: number;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
  const k = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + k, y); ctx.arcTo(x + w, y, x + w, y + h, k); ctx.arcTo(x + w, y + h, x, y + h, k); ctx.arcTo(x, y + h, x, y, k); ctx.arcTo(x, y, x + w, y, k); ctx.closePath();
}

function drawShapes(ctx: CanvasRenderingContext2D, x: number, y: number, shapes: FingerShape[], color: string, muted: string) {
  for (const s of shapes) {
    if (s.t === 'box') {
      ctx.save(); ctx.globalAlpha = 0.28; ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      roundRect(ctx, x + s.x, y + s.y, s.w, s.h, s.r); ctx.stroke(); ctx.restore();
    } else if (s.t === 'dot' || s.t === 'marker') {
      ctx.beginPath(); ctx.arc(x + s.x, y + s.y, s.r, 0, Math.PI * 2);
      if (s.t === 'marker' || s.filled) { ctx.fillStyle = color; ctx.fill(); } else { ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, s.r * 0.3); ctx.stroke(); }
    } else if (s.t === 'line') {
      ctx.strokeStyle = color; ctx.lineWidth = s.w; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x + s.x1, y + s.y1); ctx.lineTo(x + s.x2, y + s.y2); ctx.stroke();
    } else {
      ctx.fillStyle = s.muted ? muted : color;
      ctx.font = `700 ${s.size}px ${FONT}`;
      ctx.textAlign = s.anchor === 'end' ? 'right' : s.anchor === 'start' ? 'left' : 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(s.text, x + s.x, y + s.y);
    }
  }
}

/** Draws the frames of a video: the notation (drawn by OSMD, turned into a picture once per bar pair or page) and what moves over it. */
export class FrameDrawer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private host: HTMLDivElement;
  private osmd: Osmd | null = null;
  private area: { x: number; y: number; w: number; h: number };
  private cache = new Map<string, Raster>();
  private pending = new Map<string, Promise<Raster>>();
  private chain: Promise<unknown> = Promise.resolve();
  private lookup: NoteLookup;
  private full: { layout: WindowLayout; overlay: Overlay; pages: { y0: number; y1: number }[]; pageOfBar: number[]; svg: string; zoom: number } | null = null;
  readonly width: number;
  readonly height: number;
  private headerH: number;

  constructor(private job: VideoJob) {
    const { width, height } = videoSize(job.orientation);
    this.width = width; this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width; this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    const portrait = job.orientation === 'portrait';
    this.headerH = portrait ? 330 : 190;
    const m = portrait ? 40 : 48;
    this.area = { x: m, y: this.headerH, w: width - 2 * m, h: height - this.headerH - (portrait ? 110 : 80) };
    // the OSMD drawing needs a laid-out, invisible home
    this.host = document.createElement('div');
    this.host.setAttribute('aria-hidden', 'true');
    this.host.style.cssText = `position:fixed;left:-100000px;top:0;width:${this.area.w}px;pointer-events:none;visibility:hidden`;
    document.body.appendChild(this.host);
    const map = new Map<string, number>();
    const all = job.wholeTl ?? job.tl;
    for (const e of all.events) {
      if (e.part !== undefined && e.part !== job.myIdx) continue;
      const k = noteKey(e.measure, offsetInBar(all, e.timeQ));
      if (!map.has(k)) map.set(k, e.midi);
    }
    this.lookup = (bar, off) => map.get(noteKey(bar, off));
  }

  dispose() {
    for (const r of this.cache.values()) URL.revokeObjectURL(r.url);
    this.cache.clear();
    try { this.osmd?.clear?.(); } catch { /* ignore */ }
    this.host.remove();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  private async toImage(svg: string): Promise<{ img: HTMLImageElement; url: string }> {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    const loaded = new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('The picture of the notes could not be made.')); });
    img.src = url;
    await loaded;
    // some browsers only say "loaded" before the picture can be drawn
    try { await img.decode(); } catch { /* it is drawn anyway */ }
    return { img, url };
  }

  private labelOf(bar: number) { return this.job.tl.barLabels[bar - 1] ?? String(bar); }

  // ---- two bars ----
  private keyFor(p: FramePos): string {
    if (this.job.view === 'full') return `p${this.full ? this.full.pageOfBar[p.bar] ?? 0 : 0}`;
    return p.win.key;
  }

  /** Make the picture for what frame `p` shows (once; later frames of the same bars reuse it). */
  ensure(p: FramePos): Promise<void> {
    const key = this.keyFor(p);
    if (this.cache.has(key)) { const r = this.cache.get(key)!; this.cache.delete(key); this.cache.set(key, r); return Promise.resolve(); }
    let pend = this.pending.get(key);
    if (!pend) {
      pend = this.serial(() => (this.job.view === 'full' ? this.makePage(p.bar) : this.makeWindow(p))).then((r) => {
        // the first page is made before the pages are known: file it under its real name
        const k = this.keyFor(p);
        this.cache.set(k, r);
        while (this.cache.size > 4) { const [k0, old] = this.cache.entries().next().value as [string, Raster]; URL.revokeObjectURL(old.url); this.cache.delete(k0); }
        this.pending.delete(key);
        return r;
      }, (e) => { this.pending.delete(key); throw e; });
      this.pending.set(key, pend);
    }
    return pend.then(() => {});
  }

  /** Is the picture for this frame ready? */
  has(p: FramePos): boolean { return this.cache.has(this.keyFor(p)); }

  private below() { const s = this.job.style; return s === 'off' ? 1.2 : s === 'dots' ? 3.6 : 5; }

  private async makeWindow(p: FramePos): Promise<Raster> {
    const j = this.job;
    if (!this.osmd) this.osmd = await makeWindowOsmd(this.host);
    const a = this.area;
    const stack = a.w < a.h * 1.1;
    const layout = await drawWindow(this.osmd, j.xml, p.win.bars, { width: a.w, height: a.h - 20, below: this.below(), stack, maxSpace: stack ? 44 : 58, minGapPx: j.style === 'off' ? 0 : 54 });
    const overlay = windowOverlay(layout, p.win.bars, p.win.bars.map((b) => this.labelOf(b)), this.lookup, j.instrument, j.style);
    const svg = this.host.querySelector('svg') as SVGSVGElement;
    const { img, url } = await this.toImage(new XMLSerializer().serializeToString(svg));
    const boxes = layout.bars.map((b, i) => ({ ...b, h: Math.max(b.h, (overlay.barBottom[i] ?? b.y + b.h) - b.y) }));
    const total = Math.max(layout.height, overlay.bottom);
    return { img, url, layout, overlay, boxes, ox: a.x + (a.w - layout.width) / 2, oy: a.y + Math.max(0, (a.h - total) / 2), y0: 0, y1: total };
  }

  // ---- whole sheet ----
  private async makePage(bar: number): Promise<Raster> {
    const j = this.job;
    const a = this.area;
    if (!this.full) {
      if (!this.osmd) this.osmd = await makeWindowOsmd(this.host);
      const osmd = this.osmd;
      const r = osmd.EngravingRules;
      const portrait = j.orientation === 'portrait';
      r.RenderSingleHorizontalStaffline = false; r.RenderXMeasuresPerLineAkaSystem = 0; r.StretchLastSystemLine = false;
      r.PageLeftMargin = 0.5; r.PageRightMargin = 0.5; r.PageTopMargin = 2.5; r.PageTopMarginNarrow = 2.5; r.PageBottomMargin = 1;
      r.RenderTimeSignatures = true;
      // the number of the first bar of every line, so a player can find the place
      r.RenderMeasureNumbers = true; r.RenderMeasureNumbersOnlyAtSystemStart = true;
      r.MinimumDistanceBetweenSystems = this.below() + 3.4;
      osmd.setOptions({ autoBeam: !j.xml.includes('<beam'), drawMeasureNumbers: true, drawMeasureNumbersOnlyAtSystemStart: true });
      this.host.style.width = `${a.w}px`;
      await osmd.load(j.xml);
      // lines of music from the top; as many as fit in the area make a page
      const lay = (z: number) => {
        osmd.zoom = z;
        osmd.render();
        const layout = measureLayout(osmd, this.host);
        const overlay = windowOverlay(layout, layout.bars.map((_, i) => i + 1), [], this.lookup, j.instrument, j.style);
        const rows: { top: number; bottom: number; bars: number[] }[] = [];
        layout.bars.forEach((b, i) => {
          if (!b.w) return;
          const bottom = overlay.barBottom[i] ?? b.y + b.h;
          const row = rows.find((q) => Math.abs(q.top - b.y) < layout.space * 3);
          if (row) { row.top = Math.min(row.top, b.y); row.bottom = Math.max(row.bottom, bottom); row.bars.push(i + 1); } else rows.push({ top: b.y, bottom, bars: [i + 1] });
        });
        rows.sort((x, y) => x.top - y.top);
        const pages: { y0: number; y1: number }[] = [];
        const pageOfBar: number[] = [];
        let cur: { y0: number; y1: number } | null = null;
        const over = layout.space * 1.4; // room over a line for its bar number and high notes
        for (const row of rows) {
          if (!cur || row.bottom + 8 - cur.y0 > a.h) { cur = { y0: Math.max(0, row.top - over), y1: row.bottom + 8 }; pages.push(cur); } else cur.y1 = row.bottom + 8;
          for (const b of row.bars) pageOfBar[b] = pages.length - 1;
        }
        return { layout, overlay, pages, pageOfBar };
      };
      let zoom = portrait ? 2.3 : 2.25;
      let made = lay(zoom);
      // the lines of a page seldom fill the card exactly: draw a little larger so they do (a short tune is not blown up)
      const used = made.pages[0] ? made.pages[0].y1 - made.pages[0].y0 : a.h;
      const grow = Math.min(1.3, (a.h - 10) / Math.max(1, used));
      if (grow > 1.05) {
        const bigger = lay(zoom * grow * 0.985);
        if (bigger.pages[0] && bigger.pages[0].y1 - bigger.pages[0].y0 <= a.h) { made = bigger; zoom = zoom * grow * 0.985; } else made = lay(zoom);
      }
      const { layout, overlay, pages, pageOfBar } = made;
      const svg = this.host.querySelector('svg') as SVGSVGElement;
      this.full = { layout, overlay, pages, pageOfBar, svg: new XMLSerializer().serializeToString(svg), zoom };
    }
    const f = this.full;
    const pi = f.pageOfBar[bar] ?? 0;
    const pg = f.pages[pi] ?? { y0: 0, y1: a.h };
    const h = Math.min(a.h, pg.y1 - pg.y0);
    // the same drawing, cropped to the lines of this page
    const m = f.svg.match(/<svg[^>]*>/)![0];
    const vb = (m.match(/viewBox="([^"]+)"/)?.[1] ?? '').split(/[\s,]+/).map(Number);
    const vbW = vb[2] || f.layout.width / f.zoom;
    let tag = m.replace(/\sviewBox="[^"]*"/, '').replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '');
    tag = tag.replace('<svg', `<svg viewBox="0 ${pg.y0 / f.zoom} ${vbW} ${h / f.zoom}" width="${f.layout.width}" height="${h}"`);
    const { img, url } = await this.toImage(f.svg.replace(m, tag));
    const boxes = f.layout.bars.map((b, i) => ({ ...b, h: Math.max(b.h, (f.overlay.barBottom[i] ?? b.y + b.h) - b.y) }));
    // a page that does not fill the card sits in its middle (a little above, where the eye goes first)
    return { img, url, layout: f.layout, overlay: f.overlay, boxes, ox: a.x + (a.w - f.layout.width) / 2, oy: a.y + Math.max(0, (a.h - h) * 0.4), y0: pg.y0, y1: pg.y0 + h };
  }

  /** Draw frame `p`. Returns false when its picture is not ready (nothing of the notation is drawn). */
  draw(p: FramePos): boolean {
    const { ctx, width: W, height: H, job: j } = this;
    const portrait = j.orientation === 'portrait';
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
    // header
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    const big = portrait ? 96 : 84;
    const barY = portrait ? 270 : 104;
    const label = this.labelOf(p.bar);
    const barText = label === 'Pickup' ? 'Pickup' : `Bar ${label}`;
    const ofText = label === 'Pickup' || !j.tl.barTotal ? '' : ` of ${j.tl.barTotal}`;
    ctx.font = `800 ${big}px ${FONT}`;
    const barW = ctx.measureText(barText).width;
    ctx.font = `700 ${Math.round(big * 0.46)}px ${FONT}`;
    const ofW = ofText ? ctx.measureText(ofText).width : 0;
    const titleFont = `800 ${portrait ? 64 : 56}px ${FONT}`;
    ctx.fillStyle = INK; ctx.font = titleFont;
    ctx.fillText(this.fit(j.title, W - 2 * 48 - (portrait ? 0 : Math.max(420, barW + ofW + 60)), titleFont), 48, portrait ? 100 : 80);
    ctx.fillStyle = MUTED; ctx.font = `600 ${portrait ? 40 : 36}px ${FONT}`;
    ctx.fillText(`${j.instrumentName} · ${Math.round(j.bpm)} BPM`, 48, portrait ? 158 : 130);
    if (p.count) this.drawCount(p.count, big, barY);
    else {
      const x0 = portrait ? 48 : W - 48 - barW - ofW;
      ctx.fillStyle = ACCENT; ctx.font = `800 ${big}px ${FONT}`; ctx.textAlign = 'left';
      ctx.fillText(barText, x0, barY);
      if (ofText) { ctx.fillStyle = MUTED; ctx.font = `700 ${Math.round(big * 0.46)}px ${FONT}`; ctx.fillText(ofText, x0 + barW, barY); }
    }
    ctx.textAlign = 'left';
    // notation card
    const a = this.area;
    ctx.fillStyle = PAPER;
    roundRect(ctx, a.x - 16, a.y - 8, a.w + 32, a.h + 16, 28); ctx.fill();
    const r = this.cache.get(this.keyFor(p));
    let ok = false;
    if (r) {
      ok = true;
      const full = j.view === 'full';
      const barIdx = full ? p.bar - 1 : 0;
      const sx = r.ox, sy = r.oy - r.y0;
      ctx.save();
      // nothing of another page (or of a tall drawing) may spill out of the card
      roundRect(ctx, a.x - 16, a.y - 8, a.w + 32, a.h + 16, 28); ctx.clip();
      ctx.drawImage(r.img, r.ox, r.oy, r.img.naturalWidth || r.layout.width, r.img.naturalHeight || (r.y1 - r.y0));
      const box = r.boxes[barIdx];
      const L = r.layout;
      const counting = !!p.count;
      if (box && box.w) {
        ctx.fillStyle = counting ? 'rgba(255,154,31,0.12)' : 'rgba(255,154,31,0.26)'; ctx.fillRect(sx + box.x, sy + box.y, box.w, box.h);
        ctx.strokeStyle = 'rgba(210,110,0,0.85)'; ctx.lineWidth = 3; ctx.strokeRect(sx + box.x, sy + box.y, box.w, box.h);
      }
      // the other bar of the pair: a faint frame so it is clear which one is next (two-bar view)
      if (!full) for (let i = 1; i < r.boxes.length; i++) { const b = r.boxes[i]; if (b?.w) { ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 2; ctx.strokeRect(sx + b.x, sy + b.y, b.w, b.h); } }
      // fingerings and bar names
      for (const it of r.overlay.items) {
        if (!it.finger && full) continue; // the full sheet has its bar numbers printed at the lines
        if (full && (it.y < r.y0 - 2 || it.y > r.y1)) continue; // on another page
        drawShapes(ctx, sx + it.x, sy + it.y, it.shapes, INK, MUTED);
      }
      // the moving line (it waits at the first note during the count-in)
      let pick = L.steps.find((s) => s.bar === (full ? p.bar : 1));
      for (const s of L.steps) if (s.bar === (full ? p.bar : 1) && s.off <= p.offQ + 1e-6) pick = s;
      if (pick && box && !counting) {
        const w = Math.max(5, L.space * 0.45);
        // glide from note to note (and on to the bar line), as on screen
        const slot = slotAt(j.tl, p.q);
        const barLen = (j.tl.measureStartsQ[slot + 1] ?? j.tl.totalQ) - (j.tl.measureStartsQ[slot] ?? 0);
        const pts = L.steps.filter((s) => s.bar === (full ? p.bar : 1)).sort((a, b) => a.off - b.off);
        let x = glideX(pts, p.offQ, barLen, box.x + box.w - w) ?? pick.x;
        if (Math.abs(x - pick.x) > box.w) x = pick.x;
        ctx.fillStyle = '#ff7a00'; ctx.globalAlpha = 0.9;
        roundRect(ctx, sx + x - w / 2, sy + box.y, w, box.h, 3); ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.restore();
    }
    // progress along the bottom
    const frac = p.count ? 0 : Math.min(1, p.q / Math.max(1e-6, j.tl.totalQ));
    const py = H - (portrait ? 56 : 40);
    ctx.fillStyle = 'rgba(0,0,0,0.12)'; roundRect(ctx, 48, py, W - 96, 10, 5); ctx.fill();
    if (frac > 0) { ctx.fillStyle = ACCENT; roundRect(ctx, 48, py, Math.max(10, (W - 96) * frac), 10, 5); ctx.fill(); }
    return ok;
  }

  /** The count-in, where the bar number will be: "1 2 3 4" with the beat being counted large and bright. */
  private drawCount(c: NonNullable<FramePos['count']>, big: number, y: number) {
    const { ctx, width: W, job: j } = this;
    const portrait = j.orientation === 'portrait';
    const step = big * 0.82;
    const n = c.beats.length;
    let x = portrait ? 48 + step * 0.3 : W - 48 - step * (n - 0.5);
    ctx.textAlign = 'center';
    c.beats.forEach((b, i) => {
      const now = i === c.i;
      ctx.font = `800 ${now ? big : Math.round(big * 0.7)}px ${FONT}`;
      ctx.fillStyle = now ? ACCENT : i < c.i ? MUTED : FAINT;
      ctx.fillText(String(b), x, y);
      x += step;
    });
    ctx.textAlign = 'left';
  }

  private fit(text: string, maxW: number, font: string): string {
    this.ctx.font = font;
    if (this.ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 3 && this.ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
    return `${t.trim()}…`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// making the file
// ---------------------------------------------------------------------------------------------------------------

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function check(o: VideoOptions) { if (o.signal?.aborted) throw new VideoCancelled(); }

/** Loudness of every second of sound, gathered while it goes by. */
class Loudness {
  readonly rms: number[] = [];
  private sum = 0;
  private n = 0;
  constructor(private rate: number) {}
  add(left: Float32Array, right: Float32Array) {
    for (let i = 0; i < left.length; i++) {
      this.sum += (left[i] * left[i] + right[i] * right[i]) / 2;
      if (++this.n >= this.rate) this.close();
    }
  }
  close() { if (this.n) { this.rms.push(Math.sqrt(this.sum / this.n)); this.sum = 0; this.n = 0; } }
}

/**
 * Make the video.
 *
 * Fast way: the sound is rendered offline a piece at a time, every frame is drawn to a canvas from the timeline and
 * handed to WebCodecs, and a small muxer writes MP4 (H.264 with AAC, or with Opus where the browser has no AAC) or,
 * without H.264, WebM (VP9/VP8 + Opus). The file is handed to the browser block by block while it grows.
 *
 * Slow way (no WebCodecs sound encoder, e.g. iPhones before iOS 26; or when the fast way fails): the same frames and
 * the same sound are played in real time into a MediaRecorder (canvas.captureStream), which makes MP4 on Apple devices.
 */
export async function makeVideo(job: VideoJob, o: VideoOptions = {}): Promise<VideoResult> {
  const progress = o.onProgress ?? (() => {});
  const lead = job.countIn ? countInLead(job.tl, job.bpm) : NO_LEAD;
  const seconds = videoSeconds(job.tl, job.bpm, lead);
  const frames = frameCount(seconds);
  progress(0.01, 'Getting ready');
  const route = o.route ?? await videoRoute(job.orientation);
  check(o);
  if (route.kind === 'none') throw new Error('This browser cannot make a video file. Try Safari on an iPhone or Chrome on Android or a computer.');
  const audioJob: AudioJob = { ...job.audio, leadS: lead.seconds, clicks: lead.clicks };
  const drawer = new FrameDrawer(job);
  o.onCanvas?.(drawer.canvas);
  try {
    if (route.kind === 'realtime') return await record(job, route, audioJob, drawer, frames, seconds, lead, o);
    try {
      return await encode(job, route, audioJob, drawer, frames, seconds, lead, o);
    } catch (e) {
      if (e instanceof VideoCancelled || o.signal?.aborted) throw e;
      // the quick way broke (an encoder gave up): record it while it plays instead, if this browser can
      const rt = realtimeRoute(browserProbes());
      if (!rt) throw e;
      const out = await record(job, rt, audioJob, drawer, frames, seconds, lead, o);
      return { ...out, note: 'The quick way did not work on this device, so the video was recorded in real time.' };
    }
  } finally {
    drawer.dispose();
  }
}

async function encode(job: VideoJob, route: Extract<Route, { kind: 'mp4' | 'webm' }>, audioJob: AudioJob, drawer: FrameDrawer, frames: number, seconds: number, lead: Lead, o: VideoOptions): Promise<VideoResult> {
  const { width, height } = drawer;
  const progress = o.onProgress ?? (() => {});
  const rate = route.a.sampleRate;
  const mux = new VideoMux({
    container: route.kind, video: route.kind === 'mp4' ? 'avc' : route.vcodec, audio: route.kind === 'mp4' ? route.audio : 'opus',
    width, height, fps: VIDEO_FPS, sampleRate: rate, channels: 2,
  });
  let err: Error | null = null;
  const fail = (e: unknown) => { if (!err) err = e instanceof Error ? e : new Error(String(e)); };
  const vEnc = new VideoEncoder({ output: (c, m) => { try { mux.addVideo(c, m); } catch (e) { fail(e); } }, error: fail });
  const aEnc = new AudioEncoder({ output: (c, m) => { try { mux.addAudio(c, m); } catch (e) { fail(e); } }, error: fail });
  const audio = new AudioRenderer(audioJob, seconds, rate);
  const loud = new Loudness(rate);
  try {
    vEnc.configure(route.v as VideoEncoderConfig);
    aEnc.configure(route.a as AudioEncoderConfig);
    progress(0.03, 'Making the sound');
    const CH = Math.round(rate / 10); // 0.1 s of sound per piece handed to the encoder
    let seg = -1;
    let cur: [Float32Array, Float32Array] | null = null;
    let inSeg = 0;
    let aPos = 0; // frames of sound handed over
    const feedAudio = async (untilS: number) => {
      const stop = Math.min(audio.totalFrames, Math.ceil(untilS * rate));
      while (aPos < stop) {
        if (!cur || inSeg >= cur[0].length) {
          if (seg + 1 >= audio.segments.length) break;
          check(o);
          cur = await audio.render(++seg);
          inSeg = 0;
          loud.add(cur[0], cur[1]);
        }
        const n = Math.min(CH, cur[0].length - inSeg, stop - aPos);
        if (n <= 0) break;
        const data = new Float32Array(n * 2);
        data.set(cur[0].subarray(inSeg, inSeg + n), 0);
        data.set(cur[1].subarray(inSeg, inSeg + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((aPos / rate) * 1e6), data });
        aEnc.encode(ad);
        ad.close();
        aPos += n; inSeg += n;
        if (aEnc.encodeQueueSize > 30) await tick();
        if (err) throw err;
      }
    };
    let last: FramePos | null = null;
    for (let k = 0; k < frames; k++) {
      check(o);
      if (err) throw err;
      const p = framePos(job.tl, job.bpm, k, VIDEO_FPS, lead);
      await drawer.ensure(p);
      // draw the bars that come next while this frame is made (the same drawer works through them one at a time)
      if (!last || last.win.key !== p.win.key || last.bar !== p.bar) {
        const nextK = Math.min(frames - 1, k + Math.ceil(VIDEO_FPS * 2));
        void drawer.ensure(framePos(job.tl, job.bpm, nextK, VIDEO_FPS, lead)).catch(() => {});
      }
      last = p;
      drawer.draw(p);
      await feedAudio(p.t + 0.5);
      const vf = new VideoFrame(drawer.canvas, { timestamp: Math.round((k / VIDEO_FPS) * 1e6), duration: Math.round(1e6 / VIDEO_FPS) });
      try { vEnc.encode(vf, { keyFrame: k % (VIDEO_FPS * 2) === 0 }); } finally { vf.close(); }
      while (vEnc.encodeQueueSize > 3) { await tick(); if (err) throw err; }
      if (k % 15 === 0) { progress(0.04 + 0.93 * (k / frames), 'Drawing the video'); await tick(); }
    }
    await feedAudio(Infinity);
    progress(0.98, 'Finishing');
    await vEnc.flush();
    await aEnc.flush();
    if (err) throw err;
    loud.close();
    const blob = mux.finish();
    return {
      blob, mime: mux.mime, ext: route.kind, kind: route.kind, durationS: frames / VIDEO_FPS, bytes: blob.size, width, height, frames,
      format: routeWords(route), audio: { engine: audio.engine, rms: loud.rms },
    };
  } finally {
    audio.dispose();
    try { if (vEnc.state !== 'closed') vEnc.close(); } catch { /* ignore */ }
    try { if (aEnc.state !== 'closed') aEnc.close(); } catch { /* ignore */ }
  }
}

/** The slow way: play the sound and the frames in real time into a MediaRecorder. */
async function record(job: VideoJob, route: Extract<Route, { kind: 'realtime' }>, audioJob: AudioJob, drawer: FrameDrawer, frames: number, seconds: number, lead: Lead, o: VideoOptions): Promise<VideoResult> {
  const progress = o.onProgress ?? (() => {});
  if (typeof MediaRecorder === 'undefined' || !drawer.canvas.captureStream) throw new Error('This browser cannot make a video file.');
  const own = !o.liveCtx || o.liveCtx.state === 'closed';
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const actx = own ? new AC() : o.liveCtx!;
  // a canvas that is not on the page is not always captured: keep it there (hardly visible) while recording
  const parked = !drawer.canvas.isConnected;
  if (parked) { drawer.canvas.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none'; document.body.appendChild(drawer.canvas); }
  let stream: MediaStream | null = null;
  let hidden = false;
  const onHide = () => { if (document.visibilityState === 'hidden') hidden = true; };
  document.addEventListener('visibilitychange', onHide);
  const sources = new Set<AudioBufferSourceNode>();
  const audio = new AudioRenderer(audioJob, seconds, actx.sampleRate);
  const loud = new Loudness(actx.sampleRate);
  try {
    progress(0.02, 'Getting ready to record');
    try { await actx.resume(); } catch { /* ignore */ }
    if (actx.state !== 'running') throw new Error('The sound could not start. Tap "Make video" again.');
    const rate = actx.sampleRate;
    const dest = actx.createMediaStreamDestination();
    // the first picture and the first sound must exist before the clock starts
    const first = framePos(job.tl, job.bpm, 0, VIDEO_FPS, lead);
    await drawer.ensure(first);
    drawer.draw(first);
    let next = 0; // piece of sound to make next
    let busy: Promise<void> | null = null;
    let t0 = 0;
    let failed: Error | null = null;
    const place = (i: number, ch: [Float32Array, Float32Array]) => {
      const seg = audio.segments[i];
      const buf = actx.createBuffer(2, ch[0].length, rate);
      buf.copyToChannel(ch[0] as Float32Array<ArrayBuffer>, 0); buf.copyToChannel(ch[1] as Float32Array<ArrayBuffer>, 1);
      loud.add(ch[0], ch[1]);
      const src = actx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      src.start(t0 + seg.start / rate);
      sources.add(src);
      src.onended = () => { sources.delete(src); try { src.disconnect(); } catch { /* ignore */ } };
    };
    const firstSound = await audio.render(next++);
    check(o);
    stream = drawer.canvas.captureStream(VIDEO_FPS);
    for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
    let rec: MediaRecorder;
    try { rec = new MediaRecorder(stream, { mimeType: route.mime, videoBitsPerSecond: VIDEO_BPS, audioBitsPerSecond: AUDIO_BPS }); } catch { rec = new MediaRecorder(stream); }
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = () => { failed = new Error('The recording stopped by itself.'); };
    const done = new Promise<void>((res) => { rec.onstop = () => res(); });
    // start on a whole sample, a moment from now, so that the pieces of sound join exactly
    t0 = Math.ceil((actx.currentTime + 0.3) * rate) / rate;
    place(0, firstSound);
    rec.start(1000);
    progress(0.03, 'Recording in real time');
    try {
      let lastK = -1;
      while (true) {
        check(o);
        if (failed) throw failed;
        if (hidden) throw new Error('The recording was interrupted because the screen was left or locked. Keep this page open and the phone awake until it is done, then try again.');
        const t = actx.currentTime - t0;
        if (t >= seconds) break;
        // make the next piece of sound while the one before it plays
        if (!busy && next < audio.segments.length && audio.segments[next].start / rate - t < 12) {
          const i = next++;
          busy = audio.render(i).then((ch) => { place(i, ch); busy = null; }, (e) => { failed = e as Error; busy = null; });
        }
        if (t >= 0) {
          const k = Math.min(frames - 1, Math.floor(t * VIDEO_FPS));
          if (k !== lastK) {
            lastK = k;
            const p = framePos(job.tl, job.bpm, k, VIDEO_FPS, lead);
            if (drawer.has(p)) drawer.draw(p); else void drawer.ensure(p).catch(() => {});
            void drawer.ensure(framePos(job.tl, job.bpm, Math.min(frames - 1, k + VIDEO_FPS * 2), VIDEO_FPS, lead)).catch(() => {});
          }
          progress(0.03 + 0.95 * (t / seconds), `Recording in real time, ${Math.max(0, Math.ceil(seconds - t))} s left`);
        }
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
    } finally {
      for (const s of sources) { try { s.stop(); } catch { /* ignore */ } }
      if (rec.state !== 'inactive') rec.stop();
      await Promise.race([done, new Promise<void>((r) => setTimeout(r, 4000))]);
    }
    loud.close();
    const mime = route.mime.split(';')[0];
    const blob = new Blob(chunks, { type: mime });
    if (!blob.size) throw new Error('The recording came out empty. Try again.');
    return {
      blob, mime, ext: route.ext, kind: 'realtime', durationS: seconds, bytes: blob.size, width: drawer.width, height: drawer.height, frames,
      format: routeWords(route), audio: { engine: audio.engine, rms: loud.rms },
    };
  } finally {
    document.removeEventListener('visibilitychange', onHide);
    audio.dispose();
    stream?.getTracks().forEach((t) => t.stop());
    if (parked) drawer.canvas.remove();
    if (own) { try { void actx.close(); } catch { /* ignore */ } }
  }
}

export { estimateBytes, WARN_BYTES };
export { AudioRenderer, renderWhole } from './videoAudio';
