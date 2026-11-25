import { readMusicXmlFile } from './musicxml';
import { toGray, flattenLighting, grayToRgba, inkProfile, findSplitRow, rotatedSize, type Gray } from './imagePrep';
import type { InstrumentId } from './instruments';

/** Long edge of an image as sent: about the most detail the reader keeps of a page-shaped picture. */
export const MAX_EDGE = 2200;
/** Long edge of the working copy when a page may be cut into a top and a bottom image. */
const WORK_EDGE = 3000;
export const MAX_PDF_PAGES = 6;
/** Pages are cut in two (each half sent at full size, doubling the detail) only for short pieces. */
export const SPLIT_MAX_PAGES = 3;
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
export interface Drawable { source: CanvasImageSource; w: number; h: number; sy?: number; sh?: number }

/** Encode a drawable (or its strip) as a JPEG data URL with the long edge at most `maxEdge`. */
function encode(d: Drawable, maxEdge: number, quality: number): string {
  const sy = d.sy ?? 0, sh = d.sh ?? d.h;
  const scale = Math.min(1, maxEdge / Math.max(d.w, sh));
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
  /** Cut the page into a top and a bottom image when there is a clean gap between systems. */
  split?: boolean;
}

/**
 * Draw one page onto a working canvas (rotated, right size), clean it up, and return it as one drawable or as a
 * top and a bottom strip.
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
  const whole: Drawable = { source: canvas, w, h };
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
  // only tall pages with real detail to gain are cut
  if (o.split && h > w * 1.15 && h >= 1800) {
    const row = findSplitRow(inkProfile(gray));
    if (row) return [{ source: canvas, w, h, sy: 0, sh: row }, { source: canvas, w, h, sy: row, sh: h - row }];
  }
  return [whole];
}

interface PageJob { kind: 'image'; file: Blob; rotate: number } 
interface PdfJob { kind: 'pdf'; page: { getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: never) => { promise: Promise<void> } }; rotate: number }

async function pdfJobs(file: Blob, rotate: number, room: number): Promise<PdfJob[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const out: PdfJob[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, room); i++) out.push({ kind: 'pdf', page: (await doc.getPage(i)) as unknown as PdfJob['page'], rotate });
  return out;
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
  | { kind: 'images'; images: string[]; /** Images per page, top to bottom (1 or 2). */ tiles: number[] }
  | { kind: 'musicxml'; xml: string };

export interface FileInput { file: File; rotate?: number }

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
  const jobs: (PageJob | PdfJob)[] = [];
  for (const { file: f, rotate = 0 } of files) {
    const room = MAX_PDF_PAGES - jobs.length;
    if (room <= 0) break;
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) jobs.push(...(await pdfJobs(f, rotate, room)));
    else if (f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name)) jobs.push({ kind: 'image', file: f, rotate });
    else throw new OmrError(`Unsupported file: ${f.name}`, 'client');
  }
  if (jobs.length === 0) throw new OmrError('That file has no pages.', 'client');
  // 2. draw, clean and (for short pieces) cut every page
  const split = jobs.length <= SPLIT_MAX_PAGES;
  const sources: Drawable[] = [];
  const tiles: number[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    onProgress?.(jobs.length > 1 ? `Preparing page ${i + 1} of ${jobs.length}…` : 'Preparing the page…');
    await new Promise((r) => setTimeout(r, 0)); // let the message paint before the heavy work
    let parts: Drawable[];
    if (job.kind === 'pdf') {
      parts = finishPage(await renderPdfPage(job, split ? WORK_EDGE : MAX_EDGE), { rotate: job.rotate, split });
    } else {
      const d = await decode(job.file);
      try { parts = finishPage(d, { rotate: job.rotate, clean: true, split: split && Math.max(d.w, d.h) >= 1800 }); } finally { d.close(); }
    }
    sources.push(...parts);
    tiles.push(parts.length);
  }
  try {
    return { kind: 'images', images: fitToBudget(sources, encode), tiles };
  } finally {
    for (const s of sources) { const c = s.source as HTMLCanvasElement; if (c && 'width' in c) { try { c.width = c.height = 0; } catch { /* ignore */ } } }
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
export interface OmrHints { instrument?: InstrumentId; part?: string }

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
