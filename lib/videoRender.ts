import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer';
import { windowOverlay, type Overlay, type NoteLookup } from './windowOverlay';
import { drawWindow, makeWindowOsmd, measureLayout, type Box, type Osmd, type WindowLayout } from './windowRender';
import { noteKey, offsetInBar, type Timeline } from './timeline';
import type { FingerShape, FingerStyle } from './fingerStyle';
import type { InstrumentId } from './instruments';
import { framePos, frameCount, videoSeconds, videoSize, estimateBytes, WARN_BYTES, VIDEO_FPS, VIDEO_BPS, AUDIO_BPS, type FramePos, type VideoOrientation, type VideoView } from './videoPlan';
import { renderAudio, VIDEO_RATE, type AudioJob } from './videoAudio';

export interface VideoJob {
  title: string;
  instrumentName: string;
  bpm: number;
  /** Single-part MusicXML of my part (what the timeline was built from). */
  xml: string;
  tl: Timeline;
  myIdx: number;
  instrument: InstrumentId;
  view: VideoView;
  orientation: VideoOrientation;
  style: FingerStyle;
  audio: AudioJob;
}

export type VideoKind = 'mp4' | 'webm' | 'realtime';

export interface VideoResult {
  blob: Blob;
  mime: string;
  ext: 'mp4' | 'webm';
  /** `mp4` = H.264 + AAC made faster than real time; `webm` = VP9/VP8 + Opus made faster than real time; `realtime` = recorded while playing. */
  kind: VideoKind;
  /** Plain words about the format for the screen. */
  format: string;
  durationS: number;
  bytes: number;
  width: number;
  height: number;
  frames: number;
}

export interface VideoOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number, label: string) => void;
}

export class VideoCancelled extends Error { constructor() { super('cancelled'); } }

// ---------------------------------------------------------------------------------------------------------------
// what can this browser encode?
// ---------------------------------------------------------------------------------------------------------------

type Plan =
  | { kind: 'mp4'; v: VideoEncoderConfig; a: AudioEncoderConfig }
  | { kind: 'webm'; v: VideoEncoderConfig; a: AudioEncoderConfig; vcodec: 'V_VP9' | 'V_VP8' };

const has = (n: string) => typeof (globalThis as Record<string, unknown>)[n] !== 'undefined';

/** The best way this browser can make the file without playing it in real time, or null. */
export async function pickPlan(width: number, height: number, fps = VIDEO_FPS): Promise<Plan | null> {
  if (!has('VideoEncoder') || !has('AudioEncoder') || !has('VideoFrame') || !has('AudioData')) return null;
  const ok = async (c: VideoEncoderConfig) => { try { return !!(await VideoEncoder.isConfigSupported(c)).supported; } catch { return false; } };
  const okA = async (c: AudioEncoderConfig) => { try { return !!(await AudioEncoder.isConfigSupported(c)).supported; } catch { return false; } };
  const base = { width, height, framerate: fps, bitrate: VIDEO_BPS };
  const aac: AudioEncoderConfig = { codec: 'mp4a.40.2', sampleRate: VIDEO_RATE, numberOfChannels: 2, bitrate: AUDIO_BPS };
  const opus: AudioEncoderConfig = { codec: 'opus', sampleRate: VIDEO_RATE, numberOfChannels: 2, bitrate: AUDIO_BPS };
  if (await okA(aac)) {
    for (const codec of ['avc1.640032', 'avc1.64002A', 'avc1.4D0032', 'avc1.42003E']) {
      const v: VideoEncoderConfig = { ...base, codec, avc: { format: 'avc' } };
      if (await ok(v)) return { kind: 'mp4', v, a: aac };
    }
  }
  if (await okA(opus)) {
    for (const [codec, vcodec] of [['vp09.00.40.08', 'V_VP9'], ['vp8', 'V_VP8']] as const) {
      const v: VideoEncoderConfig = { ...base, codec };
      if (await ok(v)) return { kind: 'webm', v, a: opus, vcodec };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// drawing a frame
// ---------------------------------------------------------------------------------------------------------------

const PAPER = '#fffdf7';
const BG = '#f3ead6';
const INK = '#2a2218';
const MUTED = '#8a7a5c';
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
  /** Full sheet: the page's top in drawn px (what the picture is cropped to). */
  y0: number;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function drawShapes(ctx: CanvasRenderingContext2D, x: number, y: number, shapes: FingerShape[], color: string, muted: string) {
  for (const s of shapes) {
    if (s.t === 'box') {
      ctx.save(); ctx.globalAlpha = 0.28; ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(x + s.x, y + s.y, s.w, s.h, s.r); ctx.stroke(); ctx.restore();
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
    for (const e of job.tl.events) {
      if (e.part !== undefined && e.part !== job.myIdx) continue;
      const k = noteKey(e.measure, offsetInBar(job.tl, e.timeQ));
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
    img.src = url;
    await img.decode();
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
        this.cache.set(key, r);
        while (this.cache.size > 4) { const [k, old] = this.cache.entries().next().value as [string, Raster]; URL.revokeObjectURL(old.url); this.cache.delete(k); }
        this.pending.delete(key);
        return r;
      });
      this.pending.set(key, pend);
    }
    return pend.then(() => {});
  }

  /** Is the picture for this frame ready? */
  has(p: FramePos): boolean { return this.cache.has(this.keyFor(p)); }

  private async makeWindow(p: FramePos): Promise<Raster> {
    const j = this.job;
    if (!this.osmd) this.osmd = await makeWindowOsmd(this.host);
    const a = this.area;
    const stack = a.w < a.h * 1.1;
    const below = j.style === 'off' ? 1.2 : j.style === 'dots' ? 3.6 : 5;
    const layout = await drawWindow(this.osmd, j.xml, p.win.bars, { width: a.w, height: a.h - 20, below, stack, maxSpace: stack ? 40 : 44, minGapPx: j.style === 'off' ? 0 : 54 });
    const overlay = windowOverlay(layout, p.win.bars, p.win.bars.map((b) => this.labelOf(b)), this.lookup, j.instrument, j.style);
    const svg = this.host.querySelector('svg') as SVGSVGElement;
    const { img, url } = await this.toImage(new XMLSerializer().serializeToString(svg));
    const boxes = layout.bars.map((b, i) => ({ ...b, h: Math.max(b.h, (overlay.barBottom[i] ?? b.y + b.h) - b.y) }));
    const total = Math.max(layout.height, overlay.bottom);
    return { img, url, layout, overlay, boxes, ox: a.x + (a.w - layout.width) / 2, oy: a.y + Math.max(0, (a.h - total) / 2), y0: 0 };
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
      const zoom = portrait ? 2.3 : 2.6;
      r.RenderSingleHorizontalStaffline = false; r.RenderXMeasuresPerLineAkaSystem = 0; r.StretchLastSystemLine = false;
      r.PageLeftMargin = 0.5; r.PageRightMargin = 0.5; r.PageTopMargin = 2.5; r.PageTopMarginNarrow = 2.5; r.PageBottomMargin = 1;
      r.RenderTimeSignatures = true;
      r.MinimumDistanceBetweenSystems = (j.style === 'off' ? 1.2 : j.style === 'dots' ? 3.6 : 5) + 3;
      osmd.setOptions({ autoBeam: !j.xml.includes('<beam') });
      this.host.style.width = `${a.w}px`;
      await osmd.load(j.xml);
      osmd.zoom = zoom;
      osmd.render();
      const layout = measureLayout(osmd, this.host);
      const bars = layout.bars.map((_, i) => i + 1);
      const overlay = windowOverlay(layout, bars, [], this.lookup, j.instrument, j.style);
      // lines of music from the top; as many as fit in the area make a page
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
      for (const row of rows) {
        if (!cur || row.bottom + 8 - cur.y0 > a.h) { cur = { y0: Math.max(0, row.top - 10), y1: row.bottom + 8 }; pages.push(cur); } else cur.y1 = row.bottom + 8;
        for (const b of row.bars) pageOfBar[b] = pages.length - 1;
      }
      const svg = this.host.querySelector('svg') as SVGSVGElement;
      this.full = { layout, overlay, pages, pageOfBar, svg: new XMLSerializer().serializeToString(svg), zoom };
    }
    const f = this.full;
    const pi = f.pageOfBar[bar] ?? 0;
    const pg = f.pages[pi] ?? { y0: 0, y1: a.h };
    const h = pg.y1 - pg.y0;
    // the same drawing, cropped to the lines of this page
    const m = f.svg.match(/<svg[^>]*>/)![0];
    const vb = (m.match(/viewBox="([^"]+)"/)?.[1] ?? '').split(/[\s,]+/).map(Number);
    const vbW = vb[2] || f.layout.width / f.zoom;
    let tag = m.replace(/\sviewBox="[^"]*"/, '').replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '');
    tag = tag.replace('<svg', `<svg viewBox="0 ${pg.y0 / f.zoom} ${vbW} ${h / f.zoom}" width="${f.layout.width}" height="${h}"`);
    const { img, url } = await this.toImage(f.svg.replace(m, tag));
    const boxes = f.layout.bars.map((b, i) => ({ ...b, h: Math.max(b.h, (f.overlay.barBottom[i] ?? b.y + b.h) - b.y) }));
    return { img, url, layout: f.layout, overlay: f.overlay, boxes, ox: a.x + (a.w - f.layout.width) / 2, oy: a.y, y0: pg.y0 };
  }

  /** Draw frame `p`. Returns false when its picture is not ready (nothing of the notation is drawn). */
  draw(p: FramePos): boolean {
    const { ctx, width: W, height: H, job: j } = this;
    const portrait = j.orientation === 'portrait';
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
    // header
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.fillStyle = INK; ctx.font = `800 ${portrait ? 64 : 56}px ${FONT}`;
    ctx.fillText(this.fit(j.title, W - 2 * 48 - (portrait ? 0 : 420), `800 ${portrait ? 64 : 56}px ${FONT}`), 48, portrait ? 100 : 80);
    ctx.fillStyle = MUTED; ctx.font = `600 ${portrait ? 40 : 36}px ${FONT}`;
    ctx.fillText(`${j.instrumentName} · ${Math.round(j.bpm)} BPM`, 48, portrait ? 158 : 130);
    const label = this.labelOf(p.bar);
    ctx.fillStyle = ACCENT; ctx.font = `800 ${portrait ? 96 : 84}px ${FONT}`;
    ctx.textAlign = portrait ? 'left' : 'right';
    ctx.fillText(label === 'Pickup' ? 'Pickup' : `Bar ${label}`, portrait ? 48 : W - 48, portrait ? 270 : 100);
    ctx.textAlign = 'left';
    // notation card
    const a = this.area;
    ctx.fillStyle = PAPER;
    ctx.beginPath(); ctx.roundRect(a.x - 16, a.y - 8, a.w + 32, a.h + 16, 28); ctx.fill();
    const r = this.cache.get(this.keyFor(p));
    let ok = false;
    if (r) {
      ok = true;
      const full = j.view === 'full';
      const barIdx = full ? p.bar - 1 : 0;
      const oy = r.oy - r.y0;
      ctx.drawImage(r.img, r.ox, full ? r.oy : r.oy, r.img.naturalWidth || r.layout.width, r.img.naturalHeight || r.layout.height);
      const box = r.boxes[barIdx];
      const L = r.layout;
      const sx = r.ox, sy = full ? oy : r.oy;
      if (box && box.w) {
        ctx.fillStyle = 'rgba(255,154,31,0.26)'; ctx.fillRect(sx + box.x, sy + box.y, box.w, box.h);
        ctx.strokeStyle = 'rgba(210,110,0,0.85)'; ctx.lineWidth = 3; ctx.strokeRect(sx + box.x, sy + box.y, box.w, box.h);
      }
      // the other bar of the pair: a faint frame so it is clear which one is next (two-bar view)
      if (!full) for (let i = 1; i < r.boxes.length; i++) { const b = r.boxes[i]; if (b?.w) { ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 2; ctx.strokeRect(sx + b.x, sy + b.y, b.w, b.h); } }
      // fingerings and bar names
      for (const it of r.overlay.items) {
        if (!it.finger && full) continue; // no bar names in the full sheet (they are not made for it)
        drawShapes(ctx, sx + it.x, sy + it.y, it.shapes, INK, MUTED);
      }
      // the moving line
      let pick = L.steps.find((s) => s.bar === (full ? p.bar : 1));
      for (const s of L.steps) if (s.bar === (full ? p.bar : 1) && s.off <= p.offQ + 1e-6) pick = s;
      if (pick && box) {
        const w = Math.max(5, L.space * 0.45);
        ctx.fillStyle = '#ff7a00'; ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.roundRect(sx + pick.x - w / 2, sy + box.y, w, box.h, 3); ctx.fill(); ctx.globalAlpha = 1;
      }
    }
    // progress along the bottom
    const frac = Math.min(1, p.q / Math.max(1e-6, j.tl.totalQ));
    const py = H - (portrait ? 56 : 40);
    ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(48, py, W - 96, 10);
    ctx.fillStyle = ACCENT; ctx.fillRect(48, py, (W - 96) * frac, 10);
    return ok;
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

/**
 * Make the video. Fast path: the sound is rendered offline, every frame is drawn to a canvas from the timeline and handed
 * to WebCodecs, and a small muxer writes MP4 (H.264 + AAC) or, where the browser cannot encode those, WebM (VP9/VP8 + Opus).
 * Otherwise: the sound is still rendered offline, but the video is recorded while it plays (canvas.captureStream +
 * MediaRecorder), which takes as long as the song.
 */
export async function makeVideo(job: VideoJob, o: VideoOptions = {}): Promise<VideoResult> {
  const progress = o.onProgress ?? (() => {});
  const { width, height } = videoSize(job.orientation);
  const seconds = videoSeconds(job.tl, job.bpm);
  const frames = frameCount(seconds);
  const drawer = new FrameDrawer(job);
  try {
    progress(0.02, 'Making the sound');
    const plan = await pickPlan(width, height);
    check(o);
    const audio = await renderAudio(job.audio, seconds);
    check(o);
    progress(0.12, plan ? 'Drawing the video' : 'Getting ready to record');
    if (plan) return await encode(job, plan, audio, drawer, frames, seconds, o);
    return await record(job, audio, drawer, frames, seconds, o);
  } finally {
    drawer.dispose();
  }
}

async function encode(job: VideoJob, plan: Plan, audio: AudioBuffer, drawer: FrameDrawer, frames: number, seconds: number, o: VideoOptions): Promise<VideoResult> {
  const { width, height } = drawer;
  const progress = o.onProgress ?? (() => {});
  const mp4 = plan.kind === 'mp4';
  const mp4m = mp4 ? new Mp4Muxer({ target: new Mp4Target(), video: { codec: 'avc', width, height, frameRate: VIDEO_FPS }, audio: { codec: 'aac', numberOfChannels: 2, sampleRate: VIDEO_RATE }, fastStart: 'in-memory' }) : null;
  const webm = !mp4 ? new WebmMuxer({ target: new WebmTarget(), video: { codec: (plan as Extract<Plan, { kind: 'webm' }>).vcodec, width, height, frameRate: VIDEO_FPS }, audio: { codec: 'A_OPUS', numberOfChannels: 2, sampleRate: VIDEO_RATE } }) : null;
  let err: Error | null = null;
  const vEnc = new VideoEncoder({
    output: (c, m) => { try { if (mp4m) mp4m.addVideoChunk(c, m); else webm!.addVideoChunk(c, m); } catch (e) { err = e as Error; } },
    error: (e) => { err = e as Error; },
  });
  const aEnc = new AudioEncoder({
    output: (c, m) => { try { if (mp4m) mp4m.addAudioChunk(c, m); else webm!.addAudioChunk(c, m); } catch (e) { err = e as Error; } },
    error: (e) => { err = e as Error; },
  });
  vEnc.configure(plan.v);
  aEnc.configure(plan.a);
  try {
    const chans = [audio.getChannelData(0), audio.numberOfChannels > 1 ? audio.getChannelData(1) : audio.getChannelData(0)];
    const CH = 4800; // 0.1 s of sound per piece
    let aPos = 0;
    const feedAudio = async (untilS: number) => {
      const stop = Math.min(chans[0].length, Math.ceil(untilS * VIDEO_RATE));
      while (aPos < stop) {
        const n = Math.min(CH, chans[0].length - aPos);
        const data = new Float32Array(n * 2);
        data.set(chans[0].subarray(aPos, aPos + n), 0);
        data.set(chans[1].subarray(aPos, aPos + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: VIDEO_RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((aPos / VIDEO_RATE) * 1e6), data });
        aEnc.encode(ad);
        ad.close();
        aPos += n;
        if (aEnc.encodeQueueSize > 30) await tick();
      }
    };
    let last: FramePos | null = null;
    for (let k = 0; k < frames; k++) {
      check(o);
      if (err) throw err;
      const p = framePos(job.tl, job.bpm, k);
      await drawer.ensure(p);
      // draw the bars that come next while this frame is made (the same drawer works through them one at a time)
      if (!last || last.win.key !== p.win.key || last.bar !== p.bar) {
        const nextK = Math.min(frames - 1, k + Math.ceil(VIDEO_FPS * 2));
        void drawer.ensure(framePos(job.tl, job.bpm, nextK)).catch(() => {});
      }
      last = p;
      drawer.draw(p);
      await feedAudio(p.t + 0.5);
      const vf = new VideoFrame(drawer.canvas, { timestamp: Math.round((k / VIDEO_FPS) * 1e6), duration: Math.round(1e6 / VIDEO_FPS) });
      vEnc.encode(vf, { keyFrame: k % (VIDEO_FPS * 2) === 0 });
      vf.close();
      while (vEnc.encodeQueueSize > 8) await tick();
      if (k % 15 === 0) { progress(0.12 + 0.85 * (k / frames), 'Drawing the video'); await tick(); }
    }
    await feedAudio(Infinity);
    progress(0.98, 'Finishing');
    await vEnc.flush();
    await aEnc.flush();
    if (err) throw err;
    let buffer: ArrayBuffer;
    if (mp4m) { mp4m.finalize(); buffer = (mp4m.target as Mp4Target).buffer; } else { webm!.finalize(); buffer = (webm!.target as WebmTarget).buffer; }
    const ext = mp4 ? 'mp4' : 'webm';
    const mime = mp4 ? 'video/mp4' : 'video/webm';
    return {
      blob: new Blob([buffer], { type: mime }), mime, ext, kind: plan.kind, durationS: frames / VIDEO_FPS, bytes: buffer.byteLength, width, height, frames,
      format: mp4 ? 'MP4 (H.264 + AAC)' : `WebM (${plan.kind === 'webm' && plan.vcodec === 'V_VP9' ? 'VP9' : 'VP8'} + Opus). This browser cannot make MP4 here`,
    };
  } finally {
    try { if (vEnc.state !== 'closed') vEnc.close(); } catch { /* ignore */ }
    try { if (aEnc.state !== 'closed') aEnc.close(); } catch { /* ignore */ }
    void seconds;
  }
}

/** Last resort: play the sound and the frames in real time into a MediaRecorder. */
async function record(job: VideoJob, audio: AudioBuffer, drawer: FrameDrawer, frames: number, seconds: number, o: VideoOptions): Promise<VideoResult> {
  const progress = o.onProgress ?? (() => {});
  if (typeof MediaRecorder === 'undefined' || !drawer.canvas.captureStream) throw new Error('This browser cannot make a video file.');
  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mime = types.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } });
  if (!mime) throw new Error('This browser cannot record video.');
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const actx = new AC();
  try { await actx.resume(); } catch { /* ignore */ }
  const dest = actx.createMediaStreamDestination();
  const src = actx.createBufferSource();
  const copy = actx.createBuffer(audio.numberOfChannels, audio.length, audio.sampleRate);
  for (let c = 0; c < audio.numberOfChannels; c++) copy.copyToChannel(audio.getChannelData(c), c);
  src.buffer = copy;
  src.connect(dest);
  // the first picture must exist before the clock starts
  await drawer.ensure(framePos(job.tl, job.bpm, 0));
  drawer.draw(framePos(job.tl, job.bpm, 0));
  const stream = drawer.canvas.captureStream(VIDEO_FPS);
  for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: VIDEO_BPS, audioBitsPerSecond: AUDIO_BPS });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise<void>((res) => { rec.onstop = () => res(); });
  rec.start(1000);
  const t0 = performance.now();
  src.start();
  progress(0.15, 'Recording in real time');
  try {
    let lastK = -1;
    while (true) {
      check(o);
      const t = (performance.now() - t0) / 1000;
      if (t >= seconds) break;
      const k = Math.min(frames - 1, Math.floor(t * VIDEO_FPS));
      if (k !== lastK) {
        lastK = k;
        const p = framePos(job.tl, job.bpm, k);
        if (drawer.has(p)) drawer.draw(p); else void drawer.ensure(p).catch(() => {});
        void drawer.ensure(framePos(job.tl, job.bpm, Math.min(frames - 1, k + VIDEO_FPS * 2))).catch(() => {});
      }
      progress(0.15 + 0.83 * (t / seconds), `Recording in real time (${Math.ceil(seconds - t)} s left)`);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
  } finally {
    try { src.stop(); } catch { /* ignore */ }
    if (rec.state !== 'inactive') rec.stop();
    await done.catch(() => {});
    stream.getTracks().forEach((t) => t.stop());
    try { void actx.close(); } catch { /* ignore */ }
  }
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  return {
    blob, mime: mime.split(';')[0], ext, kind: 'realtime', durationS: seconds, bytes: blob.size, width: drawer.width, height: drawer.height, frames,
    format: `${ext === 'mp4' ? 'MP4' : 'WebM'}, recorded in real time because this browser cannot make the file faster`,
  };
}

export { estimateBytes, WARN_BYTES };
