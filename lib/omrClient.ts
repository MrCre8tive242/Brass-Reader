import { readMusicXmlFile } from './musicxml';

export const MAX_EDGE = 2000;
export const MAX_PDF_PAGES = 6;
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
    img.onerror = () => { URL.revokeObjectURL(url); reject(new OmrError('Could not read that image.', 'client')); };
    img.src = url;
  });
}

type Drawable = { source: CanvasImageSource; w: number; h: number };

/** Encode a drawable as a JPEG data URL with the long edge at most `maxEdge`. */
function encode(d: Drawable, maxEdge: number, quality: number): string {
  const scale = Math.min(1, maxEdge / Math.max(d.w, d.h));
  const w = Math.max(1, Math.round(d.w * scale));
  const h = Math.max(1, Math.round(d.h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(d.source, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

/** Downscale an image to max 2000px on the long edge, JPEG q0.85, returned as a data URL. */
export async function imageToDataUrl(blob: Blob, maxEdge = MAX_EDGE, quality = 0.85): Promise<string> {
  const img = await loadImage(blob);
  return encode({ source: img, w: img.naturalWidth, h: img.naturalHeight }, maxEdge, quality);
}

async function pdfToDrawables(file: Blob, maxPages = MAX_PDF_PAGES): Promise<Drawable[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const out: Drawable[] = [];
  const n = Math.min(doc.numPages, maxPages);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, MAX_EDGE / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    out.push({ source: canvas, w: canvas.width, h: canvas.height });
  }
  return out;
}

/** Rasterise up to 6 PDF pages to data URLs. */
export async function pdfToDataUrls(file: Blob, maxPages = MAX_PDF_PAGES): Promise<string[]> {
  return (await pdfToDrawables(file, maxPages)).map((d) => encode(d, MAX_EDGE, 0.85));
}

/** Progressive size reduction: (long edge px, JPEG quality), gentlest first. */
export const SHRINK_STEPS: ReadonlyArray<readonly [number, number]> = [
  [2000, 0.85], [2000, 0.72], [1700, 0.7], [1500, 0.62], [1300, 0.55], [1100, 0.5], [900, 0.45], [720, 0.4],
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

export type Prepared = { kind: 'images'; images: string[] } | { kind: 'musicxml'; xml: string };

/** Turn any supported upload into either page images or MusicXML text. */
export async function prepareFiles(files: File[]): Promise<Prepared> {
  if (files.length === 0) throw new OmrError('Choose a file first.', 'client');
  const first = files[0];
  if (/\.(musicxml|xml|mxl)$/i.test(first.name)) {
    const xml = await readMusicXmlFile(new Uint8Array(await first.arrayBuffer()), first.name);
    return { kind: 'musicxml', xml };
  }
  const sources: Drawable[] = [];
  for (const f of files) {
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) sources.push(...(await pdfToDrawables(f)));
    else if (f.type.startsWith('image/')) {
      const img = await loadImage(f);
      sources.push({ source: img, w: img.naturalWidth, h: img.naturalHeight });
    } else throw new OmrError(`Unsupported file: ${f.name}`, 'client');
  }
  const images = fitToBudget(sources.slice(0, MAX_PDF_PAGES), encode);
  return { kind: 'images', images };
}

export interface OmrResponse { musicxml: string; engine: 'claude' | 'audiveris'; warnings: string[] }

export async function callOmr(images: string[], engine: 'auto' | 'claude' | 'audiveris' = 'auto', fetchImpl: typeof fetch = fetch): Promise<OmrResponse> {
  let res: Response;
  try {
    res = await fetchImpl('/api/omr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, engine }),
    });
  } catch {
    throw new OmrError('Could not reach the reader. Check your connection.', 'network');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new OmrError(json.error || `Reader error (${res.status})`, json.code || 'error');
  return json as OmrResponse;
}
