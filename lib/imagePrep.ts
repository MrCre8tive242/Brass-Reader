/**
 * Photo clean-up before reading. Pure functions on pixel arrays (no DOM), so they run in tests too.
 *
 * A phone photo of a music stand has uneven light, a grey or yellow page and soft ink. The reader does much
 * better on a flat, high-contrast page, so: greyscale, divide by the local paper brightness (removes shadows and
 * gradients), then stretch so paper is white and ink is dark. Anti-aliasing is kept (no hard threshold).
 */

export interface Gray { data: Uint8ClampedArray; w: number; h: number }

/** RGBA pixels (canvas ImageData layout) to luma. */
export function toGray(rgba: Uint8ClampedArray, w: number, h: number): Gray {
  const data = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return { data, w, h };
}

/** Value below which `p` (0..1) of the samples of a 256-bin histogram fall. */
function percentile(hist: Uint32Array, total: number, p: number): number {
  const want = total * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= want) return v; }
  return 255;
}

/**
 * Even out the lighting and stretch the contrast. Returns a new image; the paper ends up white (255) and
 * ink close to black wherever the photo had any usable contrast.
 */
export function flattenLighting(g: Gray): Gray {
  const { w, h, data } = g;
  const T = Math.max(16, Math.round(Math.min(w, h) / 24));
  const gw = Math.ceil(w / T), gh = Math.ceil(h / T);
  // paper brightness per tile: a high percentile ignores the ink
  const bg = new Float32Array(gw * gh);
  const hist = new Uint32Array(256);
  for (let ty = 0; ty < gh; ty++) {
    for (let tx = 0; tx < gw; tx++) {
      hist.fill(0);
      const x1 = Math.min(w, (tx + 1) * T), y1 = Math.min(h, (ty + 1) * T);
      let n = 0;
      for (let y = ty * T; y < y1; y++) for (let x = tx * T, i = y * w + x; x < x1; x++, i++) { hist[data[i]]++; n++; }
      bg[ty * gw + tx] = Math.max(48, percentile(hist, n, 0.85));
    }
  }
  // a tile that is mostly ink (a thick beam, a black table edge) must not be treated as dark paper:
  // lift every tile to the median of its neighbourhood if it is much darker
  const sm = new Float32Array(bg.length);
  const nb: number[] = [];
  for (let ty = 0; ty < gh; ty++) {
    for (let tx = 0; tx < gw; tx++) {
      nb.length = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = tx + dx, y = ty + dy;
        if (x >= 0 && y >= 0 && x < gw && y < gh) nb.push(bg[y * gw + x]);
      }
      nb.sort((a, b) => a - b);
      sm[ty * gw + tx] = Math.max(bg[ty * gw + tx], nb[nb.length >> 1]);
    }
  }
  const out = new Uint8ClampedArray(w * h);
  const LO = 0.3, HI = 0.92; // of the local paper brightness: below LO is black, above HI is white
  const k = 255 / (HI - LO);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / T - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), wy = fy - y0;
    for (let x = 0, i = y * w; x < w; x++, i++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / T - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), wx = fx - x0;
      const b = (sm[y0 * gw + x0] * (1 - wx) + sm[y0 * gw + x1] * wx) * (1 - wy) + (sm[y1 * gw + x0] * (1 - wx) + sm[y1 * gw + x1] * wx) * wy;
      out[i] = (data[i] / b - LO) * k; // clamped by the typed array
    }
  }
  return { data: out, w, h };
}

/** Write a grey image back into RGBA pixels (alpha untouched). */
export function grayToRgba(g: Gray, rgba: Uint8ClampedArray): void {
  for (let i = 0, j = 0; i < g.data.length; i++, j += 4) { const v = g.data[i]; rgba[j] = v; rgba[j + 1] = v; rgba[j + 2] = v; rgba[j + 3] = 255; }
}

/**
 * Share of dark pixels in every row (0..1). Columns that are dark almost from top to bottom (the table or
 * background beside the page) are left out, so a photo that shows more than the page still has blank rows.
 */
export function inkProfile(g: Gray, dark = 128): Float32Array {
  const { w, h, data } = g;
  const col = new Uint32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0, i = y * w; x < w; x++, i++) if (data[i] < dark) col[x]++;
  const use = new Uint8Array(w);
  let span = 0;
  for (let x = 0; x < w; x++) if (col[x] < h * 0.9) { use[x] = 1; span++; }
  const out = new Float32Array(h);
  if (span === 0) return out.fill(1);
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0, i = y * w; x < w; x++, i++) if (use[x] && data[i] < dark) n++;
    out[y] = n / span;
  }
  return out;
}

/**
 * Row at which a page can be cut into a top and a bottom image without touching any music: the middle of
 * the widest band of blank rows near the centre of the page. "Blank" is strict (at most a speck per row), so a
 * line that joins the staves of one system (a score, a duet) blocks the cut and the system stays in one image.
 * Null if there is no clean gap (a tilted photo, a page with a single system): the page is then sent whole.
 */
export function findSplitRow(profile: Float32Array, opts: { blank?: number; minBand?: number } = {}): number | null {
  const h = profile.length;
  const blank = opts.blank ?? 0.0006;
  const minBand = opts.minBand ?? Math.max(6, Math.round(h * 0.012));
  const from = Math.round(h * 0.34), to = Math.round(h * 0.66);
  // there must be music on both sides, otherwise there is nothing to gain
  const inked = (a: number, b: number) => { let n = 0; for (let y = a; y < b; y++) if (profile[y] > 0.02) n++; return n; };
  if (inked(0, from) < h * 0.02 || inked(to, h) < h * 0.02) return null;
  let best: { mid: number; score: number } | null = null;
  let start = -1;
  for (let y = from; y <= to; y++) {
    const isBlank = y < to && profile[y] <= blank;
    if (isBlank && start < 0) start = y;
    if (!isBlank && start >= 0) {
      const len = y - start;
      if (len >= minBand) {
        const mid = start + (len >> 1);
        // prefer wide bands, then bands near the middle
        const score = len - Math.abs(mid - h / 2) * 0.15;
        if (!best || score > best.score) best = { mid, score };
      }
      start = -1;
    }
  }
  return best ? best.mid : null;
}

/** Canvas size after rotating by a multiple of 90 degrees. */
export function rotatedSize(w: number, h: number, quarterTurns: number): { w: number; h: number } {
  return ((quarterTurns % 4) + 4) % 2 === 1 ? { w: h, h: w } : { w, h };
}
