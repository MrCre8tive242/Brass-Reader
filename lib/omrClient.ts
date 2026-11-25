import { readMusicXmlFile } from './musicxml';

export const MAX_EDGE = 2000;
export const MAX_PDF_PAGES = 6;
const MAX_TOTAL = 3_800_000; // chars of data-URL payload, keeps the request under Vercel's 4.5 MB limit

export class OmrError extends Error {
  constructor(message: string, public code = 'error') { super(message); }
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new OmrError('Could not read that image.')); };
    img.src = url;
  });
}

/** Downscale an image to max 2000px on the long edge, JPEG q0.85, returned as a data URL. */
export async function imageToDataUrl(blob: Blob, maxEdge = MAX_EDGE, quality = 0.85): Promise<string> {
  const img = await loadImage(blob);
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

/** Rasterise up to 6 PDF pages to data URLs. */
export async function pdfToDataUrls(file: Blob, maxPages = MAX_PDF_PAGES): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const out: string[] = [];
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
    out.push(canvas.toDataURL('image/jpeg', 0.85));
  }
  return out;
}

export type Prepared = { kind: 'images'; images: string[] } | { kind: 'musicxml'; xml: string };

/** Turn any supported upload into either page images or MusicXML text. */
export async function prepareFiles(files: File[]): Promise<Prepared> {
  if (files.length === 0) throw new OmrError('Choose a file first.');
  const first = files[0];
  if (/\.(musicxml|xml|mxl)$/i.test(first.name)) {
    const xml = await readMusicXmlFile(new Uint8Array(await first.arrayBuffer()), first.name);
    return { kind: 'musicxml', xml };
  }
  const images: string[] = [];
  for (const f of files) {
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) images.push(...(await pdfToDataUrls(f)));
    else if (f.type.startsWith('image/')) images.push(await imageToDataUrl(f));
    else throw new OmrError(`Unsupported file: ${f.name}`);
  }
  const capped = images.slice(0, MAX_PDF_PAGES);
  let total = capped.reduce((n, s) => n + s.length, 0);
  // shrink if over the request budget
  if (total > MAX_TOTAL) throw new OmrError('Those pages are too large to send. Try fewer pages or a smaller photo.');
  total = 0;
  return { kind: 'images', images: capped };
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
