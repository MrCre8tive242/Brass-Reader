import { readMusicXmlFile } from './musicxml';
import { toGray, flattenLighting, grayToRgba, inkProfile, planStrips, rotatedSize, type Gray } from './imagePrep';
import type { OmrHints } from './omrPrompt';

/** Long edge of an image as sent: about the most detail the reader keeps of a page-shaped picture. */
export const MAX_EDGE = 2200;
/** Long edge of the working copy when a page may be cut into a top and a bottom image. */
const WORK_EDGE = 3000;
export const MAX_PDF_PAGES = 6;
/** Pages are cut into strips of a couple of systems (each sent zoomed, for more detail per note) only for short pieces. */
export const SPLIT_MAX_PAGES = 3;
/** Width every strip is scaled to (up or down): the notes of a small screenshot are enlarged to be readable. */
export const STRIP_WIDTH = 2000;
const MAX_ZOOM = 3;
const MAX_TOTAL = 3_800_000; // chars of data-URL payload, keeps the request under Vercel's 4.5 MB limit

/** Codes: 'client' = problem before anything was sent, 'too_large', 'network', or the server's code. */
export class OmrError extends Error {
  constructor(message: string, public code = 'error') { super(message); }
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new OmrError('Could not open that picture. If it is a HEIC photo, save or share it as JPEG first.', 'client')); };
    img.src = url;
  });
}

/** Decode a photo the right way up (the EXIF orientation written by the phone camera is applied). */
async function decode(blob: Blob): Promise<{ source: CanvasImageSource; w: number; h: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
    } catch { /* fall through to <img>, which also applies EXIF in current browsers */ }
  }
  const img = await loadImage(blob);
  return { source: img, w: img.naturalWidth, h: img.naturalHeight, close: () => {} };
}

/** A page image (or a horizontal strip of one) ready to be encoded. */
export interface Drawable { source: CanvasImageSource; w: number; h: number; sy?: number; sh?: number; /** Scale to STRIP_WIDTH wide (up or down) instead of only shrinking. */ zoom?: boolean }

/** Scale for a drawable: its width brought to STRIP_WIDTH if zoomed (at most MAX_ZOOM times larger), never past `maxEdge`. */
export function drawScale(w: number, sh: number, zoom: boolean | undefined, maxEdge: number): number {
  const base = zoom ? Math.min(MAX_ZOOM, STRIP_WIDTH / w) : 1;
  return Math.min(base, maxEdge / Math.max(w, sh));
}

/** Encode a drawable (or its strip) as a JPEG data URL with the long edge at most `maxEdge`. */
function encode(d: Drawable, maxEdge: number, quality: number): string {
  const sy = d.sy ?? 0, sh = d.sh ?? d.h;
  const scale = drawScale(d.w, sh, d.zoom, maxEdge);
  const w = Math.max(1, Math.round(d.w * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(d.source, 0, sy, d.w, sh, 0, 0, w, h);
  const url = canvas.toDataURL('image/jpeg', quality);
  canvas.width = canvas.height = 0; // release the pixels straight away (phones have little canvas memory)
  return url;
}

export interface PageOptions {
  /** Quarter turns clockwise (photos taken looking straight down often come out sideways). */
  rotate?: number;
  /** Greyscale, even out the lighting, stretch the contrast. On for photos, off for PDF pages. */
  clean?: boolean;
  /** Cut the page into strips of about two systems at the blank gaps between systems, and zoom each strip. */
  split?: boolean;
}

/**
 * Draw one page onto a working canvas (rotated, right size), clean it up, and return it as one drawable or as a
 * list of strips (top to bottom, at most 4).
 */
export function finishPage(src: { source: CanvasImageSource; w: number; h: number }, o: PageOptions = {}): Drawable[] {
  const turns = (((o.rotate ?? 0) % 4) + 4) % 4;
  const edge = o.split ? WORK_EDGE : MAX_EDGE;
  const scale = Math.min(1, edge / Math.max(src.w, src.h));
  const sw = Math.max(1, Math.round(src.w * scale)), sh = Math.max(1, Math.round(src.h * scale));
  const { w, h } = rotatedSize(sw, sh, turns);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: !!(o.clean || o.split) })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((turns * Math.PI) / 2);
  ctx.drawImage(src.source, -sw / 2, -sh / 2, sw, sh);
  ctx.restore();
  const whole: Drawable = { source: canvas, w, h, zoom: o.split };
  if (!o.clean && !o.split) return [whole];
  let gray: Gray;
  try {
    const px = ctx.getImageData(0, 0, w, h);
    gray = toGray(px.data, w, h);
    if (o.clean) {
      gray = flattenLighting(gray);
      grayToRgba(gray, px.data);
      ctx.putImageData(px, 0, 0);
    }
  } catch {
    return [whole]; // out of memory or a tainted canvas: send the page as it is
  }
  if (o.split) {
    // pages, screenshots and landscape pages alike: cut at every clean gap between systems
    const rows = planStrips(inkProfile(gray));
    const edges = [0, ...rows, h];
    const out: Drawable[] = [];
    for (let i = 0; i + 1 < edges.length; i++) out.push({ source: canvas, w, h, sy: edges[i], sh: edges[i + 1] - edges[i], zoom: true });
    return out;
  }
  return [whole];
}

interface PageJob { kind: 'image'; file: Blob; rotate: number } 
interface PdfJob { kind: 'pdf'; page: { getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: never) => { promise: Promise<void> } }; rotate: number }

async function pdfJobs(file: Blob, rotate: number, room: number): Promise<{ pages: PdfJob[]; dispose: () => Promise<void> }> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  const dispose = () => task.destroy().catch(() => {});
  try {
    const doc = await task.promise;
    const pages: PdfJob[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, room); i++) pages.push({ kind: 'pdf', page: (await doc.getPage(i)) as unknown as PdfJob['page'], rotate });
    return { pages, dispose };
  } catch (e) {
    await dispose();
    throw e;
  }
}

async function renderPdfPage(job: PdfJob, edge: number): Promise<{ source: HTMLCanvasElement; w: number; h: number }> {
  const base = job.page.getViewport({ scale: 1 });
  const scale = Math.min(4, edge / Math.max(base.width, base.height));
  const vp = job.page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await job.page.render({ canvasContext: ctx, viewport: vp, canvas } as never).promise;
  return { source: canvas, w: canvas.width, h: canvas.height };
}

/** Progressive size reduction: (long edge px, JPEG quality), gentlest first. */
export const SHRINK_STEPS: ReadonlyArray<readonly [number, number]> = [
  [2200, 0.85], [2200, 0.72], [1900, 0.7], [1700, 0.65], [1500, 0.6], [1300, 0.55], [1100, 0.5], [900, 0.45], [720, 0.4],
];

/**
 * Encode every source, lowering quality and size step by step until the total payload fits `budget`
 * characters. Throws a `too_large` OmrError only if even the smallest step is over.
 */
export function fitToBudget<T>(sources: T[], enc: (src: T, edge: number, quality: number) => string, budget = MAX_TOTAL): string[] {
  for (const [edge, q] of SHRINK_STEPS) {
    const out = sources.map((s) => enc(s, edge, q));
    if (out.reduce((n, x) => n + x.length, 0) <= budget) return out;
  }
  throw new OmrError('These pages are too detailed to send, even after shrinking. Try fewer pages or a smaller photo.', 'too_large');
}

export type Prepared =
  | { kind: 'images'; images: string[]; /** Images per page, top to bottom (1 to 4). */ tiles: number[] }
  | { kind: 'musicxml'; xml: string };

export interface FileInput { file: File; rotate?: number }

async function scanJobs(files: FileInput[]) {
  const jobs: (PageJob | PdfJob)[] = [];
  const close: (() => Promise<void>)[] = [];
  const dispose = () => Promise.all(close.map((fn) => fn()));
  try {
    for (const { file, rotate = 0 } of files) {
      const room = MAX_PDF_PAGES - jobs.length;
      if (room <= 0) break;
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        const pdf = await pdfJobs(file, rotate, room);
        jobs.push(...pdf.pages);
        close.push(pdf.dispose);
      } else if (file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name)) jobs.push({ kind: 'image', file, rotate });
      else throw new OmrError(`Unsupported file: ${file.name}`, 'client');
    }
    return { jobs, dispose };
  } catch (e) {
    await dispose();
    throw e;
  }
}

async function drawScanPage(job: PageJob | PdfJob, split: boolean, clean: boolean): Promise<Drawable[]> {
  const source = job.kind === 'pdf' ? await renderPdfPage(job, split ? WORK_EDGE : MAX_EDGE) : await decode(job.file);
  try { return finishPage(source, { rotate: job.rotate, split, clean: job.kind === 'image' && clean }); }
  finally {
    if ('close' in source) source.close();
    else source.source.width = source.source.height = 0;
  }
}

function releasePages(pages: Drawable[]) {
  for (const { source } of pages) {
    const canvas = source as HTMLCanvasElement;
    canvas.width = canvas.height = 0;
  }
}

/** The selected original page, in the same orientation used by the reader. */
export async function previewScanPage(files: FileInput[], index: number): Promise<string> {
  const { jobs, dispose } = await scanJobs(files);
  let pages: Drawable[] = [];
  try {
    const job = jobs[index];
    if (!job) throw new OmrError('That page is unavailable.', 'client');
    pages = await drawScanPage(job, false, false);
    return encode(pages[0], MAX_EDGE, 0.92);
  } finally {
    releasePages(pages);
    await dispose();
  }
}

export interface PageCrop { x: number; y: number; width: number; height: number }

export async function cropScanPage(url: string, crop: PageCrop): Promise<string> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const width = Math.round(crop.width * img.naturalWidth);
  const height = Math.round(crop.height * img.naturalHeight);
  if (width < 40 || height < 30) throw new OmrError('Select a larger area around the bar.', 'client');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  try {
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, Math.round(crop.x * img.naturalWidth), Math.round(crop.y * img.naturalHeight), width, height, 0, 0, width, height);
    return fitToBudget([{ source: canvas, w: width, h: height, zoom: true }], encode)[0];
  } finally { canvas.width = canvas.height = 0; }
}

/** Turn any supported upload into either page images or MusicXML text. */
export async function prepareFiles(input: (File | FileInput)[], onProgress?: (text: string) => void): Promise<Prepared> {
  const files: FileInput[] = input.map((f) => (f instanceof File ? { file: f } : f));
  if (files.length === 0) throw new OmrError('Choose a file first.', 'client');
  const first = files[0].file;
  if (/\.(musicxml|xml|mxl)$/i.test(first.name)) {
    const xml = await readMusicXmlFile(new Uint8Array(await first.arrayBuffer()), first.name);
    return { kind: 'musicxml', xml };
  }
  // 1. list the pages (a PDF is several)
  const { jobs, dispose } = await scanJobs(files);
  // 2. draw, clean and (for short pieces) cut every page into strips
  const split = jobs.length <= SPLIT_MAX_PAGES;
  const sources: Drawable[] = [];
  const tiles: number[] = [];
  try {
    if (jobs.length === 0) throw new OmrError('That file has no pages.', 'client');
    for (let i = 0; i < jobs.length; i++) {
      onProgress?.(jobs.length > 1 ? `Preparing page ${i + 1} of ${jobs.length}…` : 'Preparing the page…');
      await new Promise((r) => setTimeout(r, 0)); // let the message paint before the heavy work
      const parts = await drawScanPage(jobs[i], split, true);
      sources.push(...parts);
      tiles.push(parts.length);
    }
    return { kind: 'images', images: fitToBudget(sources, encode), tiles };
  } finally {
    releasePages(sources);
    await dispose();
  }
}

const PASSCODE_KEY = 'brass-reader:passcode';
export function getPasscode(): string {
  try { return localStorage.getItem(PASSCODE_KEY) ?? ''; } catch { return ''; }
}
export function setPasscode(v: string): void {
  try { if (v) localStorage.setItem(PASSCODE_KEY, v); else localStorage.removeItem(PASSCODE_KEY); } catch { /* ignore */ }
}

export interface OmrFlag { bar: string; text: string }
export interface OmrResponse { musicxml: string; engine: 'claude' | 'audiveris'; warnings: string[]; flags?: OmrFlag[] }
export type { OmrHints } from './omrPrompt';

export async function callOmr(
  page: { images: string[]; tiles?: number[]; hints?: OmrHints },
  engine: 'auto' | 'claude' | 'audiveris' = 'auto',
  fetchImpl: typeof fetch = fetch,
): Promise<OmrResponse> {
  let res: Response;
  try {
    res = await fetchImpl('/api/omr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(getPasscode() ? { 'X-App-Passcode': getPasscode() } : {}) },
      body: JSON.stringify({ images: page.images, tiles: page.tiles, hints: page.hints, engine }),
    });
  } catch {
    throw new OmrError('Could not reach the reader. Check your connection.', 'network');
  }
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) setPasscode(''); // wrong or missing: ask again
  if (res.status === 504 || res.status === 408) throw new OmrError('The reader took too long. Try fewer pages at a time.', 'too_long');
  if (!res.ok) throw new OmrError(json.error || `Reader error (${res.status})`, json.code || 'error');
  return json as OmrResponse;
}
