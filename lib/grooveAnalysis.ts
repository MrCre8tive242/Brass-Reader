/**
 * Listening to a recorded drum line: onset detection (spectral flux), tempo estimate, cutting the loop into hits.
 * Pure functions on raw samples, so they run (and are tested) without a browser.
 */

export interface Slice {
  /** Where the hit falls in the loop, in beats (quarter notes) from the downbeat. */
  beat: number;
  /** Where the hit lives in the stored audio, in seconds. */
  start: number;
  end: number;
}

export interface Onsets { times: number[]; strengths: number[] }

const N = 1024;
const HOP = 256;

/** In-place radix-2 FFT. */
class Fft {
  private cos: Float64Array;
  private sin: Float64Array;
  private rev: Uint32Array;
  constructor(private n: number) {
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / n); this.sin[i] = -Math.sin((2 * Math.PI * i) / n); }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); this.rev[i] = r; }
  }
  transform(re: Float64Array, im: Float64Array) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) { const a = re[i]; re[i] = re[j]; re[j] = a; const b = im[i]; im[i] = im[j]; im[j] = b; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * this.cos[k] - im[b] * this.sin[k];
          const ti = re[b] * this.sin[k] + im[b] * this.cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

let fft: Fft | null = null;
const hann = (() => { const w = new Float64Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); return w; })();

/** Where the drum hits are: peaks of the log-spectral flux, with the time refined on the raw samples. `sensitivity` 1 = normal. */
export function detectOnsets(x: ArrayLike<number>, rate: number, sensitivity = 1): Onsets {
  fft ??= new Fft(N);
  const len = x.length;
  if (len < N) return { times: [], strengths: [] };
  const frames = Math.floor((len - 1) / HOP) + 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  const bins = N / 2;
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const flux = new Float64Array(frames);
  const scale = 4 / N;
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    for (let i = 0; i < N; i++) { re[i] = (o + i < len ? x[o + i] : 0) * hann[i]; im[i] = 0; }
    fft.transform(re, im);
    let s = 0;
    for (let k = 1; k < bins; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * scale;
      cur[k] = Math.log1p(100 * m);
      const d = cur[k] - prev[k];
      if (d > 0) s += d;
    }
    flux[f] = s;
    const t = prev; prev = cur; cur = t;
  }
  let max = 0;
  for (let f = 0; f < frames; f++) if (flux[f] > max) max = flux[f];
  if (max < 0.05) return { times: [], strengths: [] };
  const hopS = HOP / rate;
  const w = Math.max(2, Math.round(0.1 / hopS));
  const near = 3;
  const picks: { f: number; s: number }[] = [];
  let sum = 0, cnt = 0;
  // running local mean over +-w frames
  const prefix = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) prefix[f + 1] = prefix[f] + flux[f];
  for (let f = 0; f < frames; f++) {
    const a = Math.max(0, f - w), b = Math.min(frames, f + w + 1);
    sum = prefix[b] - prefix[a]; cnt = b - a;
    const thr = sum / cnt + (0.12 / Math.max(0.2, sensitivity)) * max;
    if (flux[f] <= thr) continue;
    let isMax = true;
    for (let j = Math.max(0, f - near); j <= Math.min(frames - 1, f + near); j++) if (flux[j] > flux[f] || (flux[j] === flux[f] && j < f)) { isMax = false; break; }
    if (isMax) picks.push({ f, s: flux[f] });
  }
  // refine each pick on the samples: the steepest rise of the smoothed level
  const times: number[] = [], strengths: number[] = [];
  const sm = 16;
  for (const p of picks) {
    const a = Math.max(sm, (p.f - 4) * HOP), b = Math.min(len - sm - 1, p.f * HOP + N);
    let best = a, bestRise = -Infinity;
    // running sums of |x| over the windows before and after i
    let before = 0, after = 0;
    for (let k = 1; k <= sm; k++) { before += Math.abs(x[a - k]); after += Math.abs(x[a + k - 1]); }
    for (let i = a; i <= b; i++) {
      const rise = after - before;
      if (rise > bestRise) { bestRise = rise; best = i; }
      before += Math.abs(x[i]) - Math.abs(x[i - sm]);
      after += Math.abs(x[i + sm]) - Math.abs(x[i]);
    }
    const t = best / rate;
    if (times.length && t - times[times.length - 1] < 0.04) {
      if (p.s > strengths[strengths.length - 1]) { times[times.length - 1] = t; strengths[strengths.length - 1] = p.s; }
      continue;
    }
    times.push(t); strengths.push(p.s);
  }
  return { times, strengths };
}

export const TEMPO_MIN = 75;
export const TEMPO_MAX = 165;

/**
 * Tempo from onset times: the beat length (and a starting point) that puts the largest share of the hits' weight on a
 * regular grid. Hits in between (hi-hat eighths, fills) count against a tempo that is too slow. Returns BPM or null.
 */
export function estimateTempo(times: number[], strengths: number[] = [], min = TEMPO_MIN, max = TEMPO_MAX): { bpm: number; confidence: number } | null {
  const n = times.length;
  if (n < 4) return null;
  const s = strengths.length === n ? strengths : times.map(() => 1);
  const sMax = Math.max(...s) || 1;
  const w = s.map((v) => v / sMax);
  const total = w.reduce((a, b) => a + b, 0);
  const sd = 0.018;
  // phases to try: the strongest hits
  const order = w.map((v, i) => i).sort((a, b) => w[b] - w[a]).slice(0, 12);
  const score = (bpm: number) => {
    const T = 60 / bpm;
    let best = 0;
    for (const pi of order) {
      const phi = times[pi];
      let sc = 0;
      for (let j = 0; j < n; j++) {
        let d = (times[j] - phi) % T;
        if (d < 0) d += T;
        d = Math.min(d, T - d);
        const e = d / sd;
        if (e < 4) sc += w[j] * Math.exp(-0.5 * e * e);
      }
      if (sc > best) best = sc;
    }
    const base = Math.min(0.9, (sd * 2.5) / T); // what a random pattern would put on the grid
    const frac = best / total;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.9, 2));
    return ((frac - base) / (1 - base)) * (0.6 + 0.4 * prior);
  };
  let best = 0, bestScore = -Infinity;
  for (let bpm = min; bpm <= max; bpm += 0.25) { const v = score(bpm); if (v > bestScore) { bestScore = v; best = bpm; } }
  for (let bpm = best - 0.5; bpm <= best + 0.5; bpm += 0.05) { const v = score(bpm); if (v > bestScore) { bestScore = v; best = bpm; } }
  if (!(bestScore > 0)) return null;
  return { bpm: Math.round(best * 10) / 10, confidence: bestScore };
}

/** Fold a tempo by octaves into the usual range. */
export function foldTempo(bpm: number, min = TEMPO_MIN - 5, max = TEMPO_MAX + 10): number {
  let b = bpm;
  if (!Number.isFinite(b) || b <= 0) return NaN;
  while (b < min) b *= 2;
  while (b > max) b /= 2;
  return b;
}

/** BPM from tap times in seconds (the last few taps; a pause of 2 s or more starts over). Null with fewer than two taps. */
export function bpmFromTaps(taps: number[]): number | null {
  let t = taps;
  for (let i = t.length - 1; i > 0; i--) if (t[i] - t[i - 1] > 2) { t = t.slice(i); break; }
  t = t.slice(-8);
  if (t.length < 2) return null;
  const iv: number[] = [];
  for (let i = 1; i < t.length; i++) iv.push(t[i] - t[i - 1]);
  iv.sort((a, b) => a - b);
  const med = iv[Math.floor(iv.length / 2)];
  return med > 0 ? Math.round((60 / med) * 10) / 10 : null;
}

/** Number of bars (1, 2 or 4) that fit best in `durS` seconds of music at `bpm`. */
export function guessBars(durS: number, bpm: number): 1 | 2 | 4 {
  const bars = (durS * bpm) / 240;
  if (bars >= 3.85) return 4;
  if (bars >= 1.85) return 2;
  return 1;
}

/** Length of the loop in seconds. */
export const loopSeconds = (bars: number, bpm: number) => (bars * 4 * 60) / bpm;

/** Cut the recording into hits. Only hits inside the loop (starting at `downbeatS`) are kept; each lasts until the next onset. */
export function buildSlices(onsets: number[], durS: number, downbeatS: number, bpm: number, bars: number): Slice[] {
  const loopS = loopSeconds(bars, bpm);
  const PRE = 0.03;
  const all = [...onsets].sort((a, b) => a - b);
  const out: Slice[] = [];
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    if (t < downbeatS - PRE || t >= downbeatS + loopS - 0.02 || t >= durS) continue;
    const start = Math.max(0, t - 0.004);
    const next = i + 1 < all.length ? all[i + 1] - 0.002 : durS;
    const end = Math.min(durS, next, start + 1.5);
    if (end - start < 0.02) continue;
    out.push({ beat: Math.max(0, ((t - downbeatS) * bpm) / 60), start, end });
  }
  return out;
}

/** 16-bit mono WAV file bytes. */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const n = samples.length;
  const b = new Uint8Array(44 + n * 2);
  const v = new DataView(b.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return b;
}
