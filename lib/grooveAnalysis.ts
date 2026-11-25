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
  /**
   * Seconds of audio in the slice before its main stroke (the fade-in, and the grace note of a flam): the slice is
   * started this much early so the stroke itself lands on the beat. Missing in grooves saved by older versions.
   */
  pre?: number;
}

export interface Onsets {
  /** The main stroke of each hit, seconds. */
  times: number[];
  /** How sharply each hit stands out (spectral flux). */
  strengths: number[];
  /** Where the sound of each hit begins (at or a little before its main stroke). */
  starts: number[];
  /** How loud each hit is: peak level, 0..1. */
  levels: number[];
}

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

/** Two strokes closer than this are one hit: a flam, or drummers who are not quite together. */
export const MIN_GAP_S = 0.055;
/** How far before its main stroke a hit may begin (the grace note of a flam). */
export const FLAM_LEAD_S = 0.05;
/** How long after a strong hit a much weaker one is taken for its echo. */
const ECHO_S = 0.075;

const medianOf = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

/**
 * Where the drum hits are. Peaks of the log-spectral flux that stand clear of what is going on around them
 * (so a ringing cowbell, a whistle or room noise is not chopped up), with the time refined on the raw samples.
 * Strokes that fall within a few hundredths of a second are one hit: `times` is its main stroke (what sits on the
 * beat), `starts` is where its sound begins. `levels` is how loud each hit is (peak, 0..1). `sensitivity` 1 = normal,
 * higher finds more (softer) hits.
 */
export function detectOnsets(x: ArrayLike<number>, rate: number, sensitivity = 1): Onsets {
  fft ??= new Fft(N);
  const none: Onsets = { times: [], strengths: [], starts: [], levels: [] };
  const len = x.length;
  if (len < N) return none;
  // whole frames only: a frame hanging over the end sees the recording stop, which looks like a change
  const frames = Math.floor((len - N) / HOP) + 1;
  const re = new Float64Array(N), im = new Float64Array(N);
  const bins = N / 2;
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const flux = new Float64Array(frames);
  const scale = 4 / N;
  let peakAll = 0;
  for (let i = 0; i < len; i++) { const v = Math.abs(x[i]); if (v > peakAll) peakAll = v; }
  if (!(peakAll > 0.003)) return none;
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
    flux[f] = f === 0 ? 0 : s; // the first frame has nothing before it to compare with
    const t = prev; prev = cur; cur = t;
  }
  const hopS = HOP / rate;
  const near = Math.max(2, Math.round(0.016 / hopS));
  const w = Math.max(4, Math.round(0.15 / hopS));
  // every local peak of the flux
  const peaks: number[] = [];
  let max = 0;
  for (let f = 0; f < frames; f++) {
    if (flux[f] > max) max = flux[f];
    let isMax = flux[f] > 0;
    for (let j = Math.max(0, f - near); isMax && j <= Math.min(frames - 1, f + near); j++) if (flux[j] > flux[f] || (flux[j] === flux[f] && j < f)) isMax = false;
    if (isMax) peaks.push(f);
  }
  if (max < 0.05) return none;
  // what a solid hit looks like here: not the single loudest bang (a knocked phone, one huge accent) but the
  // level the strong hits share, so that softer hits are still measured against the right thing
  const big = peaks.map((f) => flux[f]).filter((v) => v >= 0.1 * max).sort((a, b) => b - a);
  const ref = big[Math.min(big.length - 1, Math.floor(big.length * 0.1))] ?? max;
  const delta = (0.12 / Math.max(0.2, sensitivity)) * ref;
  const win: number[] = [];
  const cands: { t: number; s: number; level: number }[] = [];
  const sm = Math.max(4, Math.round(0.0006 * rate));
  const lookS = Math.round(0.03 * rate);
  const gate = Math.max(0.003, 0.02 * peakAll);
  for (const f of peaks) {
    // must stand clear of the local background (the median ignores the peak itself and its neighbours)
    win.length = 0;
    for (let j = Math.max(0, f - w); j <= Math.min(frames - 1, f + w); j++) win.push(flux[j]);
    if (flux[f] <= 1.25 * medianOf(win) + delta) continue;
    // refine on the samples: where the level first climbs clear of what was sounding before
    const centre = f * HOP + N / 2;
    const a = Math.max(sm, centre - 3 * HOP), b = Math.min(len - sm - 1, centre + 2 * HOP);
    if (b <= a) continue;
    let before = 0;
    for (let i = Math.max(0, a - Math.round(0.004 * rate)); i < a; i++) { const v = Math.abs(x[i]); if (v > before) before = v; }
    let top = 0;
    for (let i = a; i <= Math.min(len - 1, b + Math.round(0.004 * rate)); i++) { const v = Math.abs(x[i]); if (v > top) top = v; }
    let best = -1;
    if (top > before * 1.15) {
      const thr = before + 0.3 * (top - before);
      for (let i = a; i <= b; i++) if (Math.abs(x[i]) >= thr) { best = i; break; }
    }
    if (best < 0) {
      // nothing rises clear (a hit inside a loud ring): take the steepest rise of the smoothed level
      let bestRise = -Infinity, bef = 0, aft = 0;
      for (let k = 1; k <= sm; k++) { bef += Math.abs(x[a - k]); aft += Math.abs(x[a + k - 1]); }
      for (let i = a; i <= b; i++) {
        const rise = aft - bef;
        if (rise > bestRise) { bestRise = rise; best = i; }
        bef += Math.abs(x[i]) - Math.abs(x[i - sm]);
        aft += Math.abs(x[i + sm]) - Math.abs(x[i]);
      }
    }
    let level = 0;
    for (let i = best; i < Math.min(len, best + lookS); i++) { const v = Math.abs(x[i]); if (v > level) level = v; }
    if (level < gate) continue;
    cands.push({ t: best / rate, s: flux[f], level });
  }
  // strongest first: each main stroke takes in what sounds just before it (it then starts there) and just after it
  const order = cands.map((_, i) => i).sort((i, j) => cands[j].s - cands[i].s);
  const taken = new Uint8Array(cands.length);
  const hits: { t: number; s: number; start: number; level: number }[] = [];
  for (const i of order) {
    if (taken[i]) continue;
    taken[i] = 1;
    const m = cands[i];
    let start = m.t, level = m.level;
    for (let j = 0; j < cands.length; j++) {
      if (taken[j]) continue;
      const d = cands[j].t - m.t;
      if (d < -FLAM_LEAD_S || d > MIN_GAP_S) continue;
      taken[j] = 1;
      if (cands[j].t < start) start = cands[j].t;
      if (cands[j].level > level) level = cands[j].level;
    }
    // a much weaker blip right behind a strong hit is its echo off the wall, not a stroke: it stays in this hit's slice
    for (let j = 0; j < cands.length; j++) {
      if (taken[j]) continue;
      const d = cands[j].t - m.t;
      if (d > MIN_GAP_S && d <= ECHO_S && cands[j].s < 0.4 * m.s) taken[j] = 1;
    }
    hits.push({ t: m.t, s: m.s, start, level });
  }
  hits.sort((p, q) => p.t - q.t);
  const out: Onsets = { times: [], strengths: [], starts: [], levels: [] };
  for (const h of hits) {
    // a main stroke that landed inside the previous hit's gap after all (two refinements met): keep the stronger
    const last = out.times.length - 1;
    if (last >= 0 && h.t - out.times[last] < MIN_GAP_S * 0.6) {
      if (h.s > out.strengths[last]) { out.times[last] = h.t; out.strengths[last] = h.s; }
      out.levels[last] = Math.max(out.levels[last], h.level);
      continue;
    }
    out.times.push(h.t); out.strengths.push(h.s); out.starts.push(Math.min(h.start, h.t)); out.levels.push(h.level);
  }
  return out;
}

export const TEMPO_MIN = 75;
export const TEMPO_MAX = 165;

export interface TempoEstimate {
  bpm: number;
  /** 0..1: how well the hits sit on a regular grid at this tempo. */
  confidence: number;
  /** The time of one beat (seconds): beats fall every 60/bpm from here. */
  phaseS: number;
  /** Hits per beat on the finest regular grid found (4 = sixteenths, 3 = triplets, 2 = eighths, 1 = beats only). */
  sub: number;
}

export interface TempoOpts {
  min?: number;
  max?: number;
  /** A tempo the players were given (the count-in click): settles 80 against 160. */
  hint?: number | null;
  /** A tempo the music is probably near (the tempo of the score on screen): a weaker pull than `hint`. */
  near?: number | null;
  /** How loud each hit is (accents show where the beat is). Defaults to `strengths`. */
  levels?: number[];
  /** Only listen to this stretch of the recording, seconds. */
  from?: number;
  to?: number;
}

/** How tightly the hits sit on a grid of period `tau`: 1 = all on it, 0 = spread evenly. Also the grid's phase. */
function gridFit(times: number[], w: number[], tau: number): { r: number; phase: number } {
  let c = 0, s = 0, tot = 0;
  const k = (2 * Math.PI) / tau;
  for (let i = 0; i < times.length; i++) { c += w[i] * Math.cos(k * times[i]); s += w[i] * Math.sin(k * times[i]); tot += w[i]; }
  if (!(tot > 0)) return { r: 0, phase: 0 };
  let ph = Math.atan2(s, c) / k;
  if (ph < 0) ph += tau;
  return { r: Math.hypot(c, s) / tot, phase: ph };
}

/** Which grouping of the fine grid makes a beat: how the tempo candidates are ranked before the accents are heard. */
const GROUP_BASE: Record<number, number> = { 1: 0.85, 2: 1, 3: 0.6, 4: 1, 6: 0.35 };

/**
 * Tempo from the hits. First the finest regular grid they sit on (every hit counts, so this is exact to a small
 * fraction of a BPM), then how many grid steps make a beat: the grouping whose accents repeat, in the usual tempo
 * range, nearest to the count-in tempo when there was one. Returns null when there is too little to go on.
 */
export function estimateTempo(times: number[], strengths: number[] = [], opts: TempoOpts = {}): TempoEstimate | null {
  const hint = opts.hint && opts.hint > 0 ? opts.hint : null;
  let min = (opts.min ?? TEMPO_MIN) - 5, max = (opts.max ?? TEMPO_MAX) + 10;
  // a count-in outside the usual range widens it (up to a point)
  if (hint) { min = Math.min(min, Math.max(55, hint * 0.88)); max = Math.max(max, Math.min(200, hint * 1.12)); }
  if (times.length < 4) return null;
  // listen to one stretch (people drift): from the first hit wanted, about ten seconds
  const from = opts.from ?? -Infinity;
  const first = times.find((t) => t >= from) ?? times[0];
  const to = Math.min(opts.to ?? Infinity, first + 10);
  const idx: number[] = [];
  for (let i = 0; i < times.length; i++) if (times[i] >= from && times[i] <= to) idx.push(i);
  const n = idx.length;
  if (n < 4) return null;
  const t = idx.map((i) => times[i]);
  const sRaw = strengths.length === times.length ? idx.map((i) => strengths[i]) : t.map(() => 1);
  const sMax = Math.max(...sRaw) || 1;
  const w = sRaw.map((v) => 0.25 + 0.75 * (v / sMax));
  const lvRaw = opts.levels && opts.levels.length === times.length ? idx.map((i) => opts.levels![i]) : sRaw;
  const lvMax = Math.max(...lvRaw) || 1;
  const lv = lvRaw.map((v) => v / lvMax);

  // 1. the finest grid: scan every period from a sixteenth at the top tempo to a beat at the bottom tempo
  const tauMin = 60 / max / 4, tauMax = 60 / min;
  const STEP = 1.0012;
  const taus: number[] = [], rs: number[] = [];
  for (let tau = tauMin; tau <= tauMax * 1.0001; tau *= STEP) { taus.push(tau); rs.push(gridFit(t, w, tau).r); }
  let rMax = 0;
  for (const r of rs) if (r > rMax) rMax = r;
  if (rMax < 0.3) return null;
  // the coarsest grid that still holds (nearly) all the hits; a finer one only fits because it has more lines
  let pick = -1;
  for (let i = taus.length - 2; i > 0; i--) {
    if (rs[i] >= 0.85 * rMax && rs[i] >= rs[i - 1] && rs[i] >= rs[i + 1]) { pick = i; break; }
  }
  if (pick < 0) pick = rs.indexOf(rMax);
  let tau = taus[pick], fit = gridFit(t, w, tau);
  for (let span = STEP - 1; span > 2e-6; span /= 4) {
    for (const cand of [tau * (1 - span), tau * (1 - span / 2), tau * (1 + span / 2), tau * (1 + span)]) {
      const g = gridFit(t, w, cand);
      if (g.r > fit.r) { fit = g; tau = cand; }
    }
  }

  // polish: the straight line through (grid step, time of the hit on it) is the best tempo the hits can give
  for (let pass = 0; pass < 2; pass++) {
    let sw = 0, sk = 0, st = 0, skk = 0, skt = 0;
    for (let i = 0; i < n; i++) {
      const k = Math.round((t[i] - fit.phase) / tau);
      if (Math.abs(t[i] - (fit.phase + k * tau)) > 0.3 * tau) continue;
      sw += w[i]; sk += w[i] * k; st += w[i] * t[i]; skk += w[i] * k * k; skt += w[i] * k * t[i];
    }
    const den = sw * skk - sk * sk;
    if (!(den > 1e-9)) break;
    const slope = (sw * skt - sk * st) / den;
    if (!(Math.abs(slope / tau - 1) < 0.01)) break;
    tau = slope;
    fit = { r: fit.r, phase: (st - slope * sk) / sw };
  }

  // 2. how loud each grid step is (0 = nobody plays there)
  const k0 = Math.round((t[0] - fit.phase) / tau), k1 = Math.round((t[n - 1] - fit.phase) / tau);
  const K = k1 - k0 + 1;
  const L = new Float64Array(K);
  for (let i = 0; i < n; i++) {
    const k = Math.round((t[i] - fit.phase) / tau);
    if (Math.abs(t[i] - (fit.phase + k * tau)) > 0.3 * tau) continue;
    if (lv[i] > L[k - k0]) L[k - k0] = lv[i];
  }
  let mu = 0;
  for (let k = 0; k < K; k++) mu += L[k];
  mu /= K;
  let varL = 0;
  for (let k = 0; k < K; k++) varL += (L[k] - mu) * (L[k] - mu);
  const flat = varL / K < 0.004; // every step about as loud: the accents say nothing
  const acf = (m: number) => {
    if (flat || K < m + 4) return 0;
    let num = 0;
    for (let k = 0; k + m < K; k++) num += (L[k] - mu) * (L[k + m] - mu);
    return (num / varL) * (K / (K - m));
  };

  // 3. steps per beat
  const usual = (bpm: number) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 108) / 0.8, 2));
  const soft = opts.near && opts.near > 0 ? opts.near : null;
  const prior = (bpm: number) => (hint
    ? 0.25 + 0.75 * Math.exp(-0.5 * Math.pow(Math.log2(bpm / hint) / 0.18, 2))
    : usual(bpm) * (soft ? 0.6 + 0.4 * Math.exp(-0.5 * Math.pow(Math.log2(bpm / soft) / 0.3, 2)) : 1));
  const groups = [1, 2, 3, 4, 6].filter((m) => { const b = 60 / (m * tau); return b >= min && b <= max; });
  if (!groups.length) return null;
  let bestM = groups[0], bestS = -Infinity;
  for (const m of groups) {
    // accents that clearly repeat at this grouping count in full: music has them at several levels at once
    const s = (0.35 + 0.65 * Math.max(0, Math.min(1, acf(m) / 0.6))) * GROUP_BASE[m] * prior(60 / (m * tau));
    if (s > bestS + 1e-9) { bestS = s; bestM = m; }
  }
  // 4. which steps are the beats: the loudest set
  let bestPhase = 0, bestMean = -1;
  for (let p = 0; p < bestM; p++) {
    let sum = 0, cnt = 0;
    for (let k = p; k < K; k += bestM) { sum += L[k]; cnt++; }
    const mean = cnt ? sum / cnt : 0;
    if (mean > bestMean + 1e-9) { bestMean = mean; bestPhase = p; }
  }
  const beatS = bestM * tau;
  let phaseS = fit.phase + (k0 + bestPhase) * tau;
  while (phaseS - beatS >= t[0] - 0.3 * tau) phaseS -= beatS;
  return { bpm: Math.round((60 / beatS) * 100) / 100, confidence: Math.max(0, Math.min(1, fit.r)), phaseS, sub: bestM };
}

/**
 * A first guess at beat 1. After a count-in it is the first solid hit where the count-in ended. Without one it is
 * the beat that carries the heaviest hits bar after bar (the earliest such beat when nothing stands out).
 * Always the time of a real hit; the player can still drag it.
 */
export function guessDownbeat(times: number[], levels: number[], bpm: number, phaseS: number | null, countInS: number | null, durS: number): number {
  if (!times.length) return Math.max(0, Math.min(durS, countInS ?? 0));
  const lv = levels.length === times.length ? levels : times.map(() => 1);
  if (countInS !== null) {
    const inWin: number[] = [];
    for (let i = 0; i < times.length; i++) if (times[i] >= countInS - 0.12 && times[i] <= countInS + 0.35) inWin.push(i);
    if (inWin.length) {
      const top = Math.max(...inWin.map((i) => lv[i]));
      return times[inWin.find((i) => lv[i] >= 0.4 * top)!];
    }
    return times.find((t) => t >= countInS - 0.12) ?? times[0];
  }
  const beat = 60 / bpm;
  if (phaseS === null || !(beat > 0)) return times[0];
  const tol = Math.min(0.07, beat * 0.2);
  // the hit (if any) on each beat
  const at = (tm: number) => {
    let best = -1, d = tol;
    for (let i = 0; i < times.length; i++) { const e = Math.abs(times[i] - tm); if (e <= d) { d = e; best = i; } }
    return best;
  };
  const onBeat = (tm: number) => { const d = (((tm - phaseS) % beat) + beat) % beat; return Math.min(d, beat - d) <= tol; };
  const firstOn = times.findIndex((tm) => onBeat(tm));
  const first = firstOn >= 0 ? times[firstOn] : times[0];
  const end = Math.min(durS, first + 12);
  if (end - first < 7.5 * beat) return first; // a single bar: nothing to compare, take the first beat that is played
  // every hit in the first bar could be beat 1: the one whose place is hit hardest in every bar wins
  // (a little in favour of hits on the beat and of the earlier one)
  let best = first, bestScore = -Infinity;
  for (let i = 0; i < times.length && times[i] < first + 4 * beat - tol; i++) {
    if (times[i] < first - tol) continue;
    let sum = 0, cnt = 0;
    for (let tm = times[i]; tm < end - 2 * beat; tm += 4 * beat) { const j = at(tm); sum += j >= 0 ? lv[j] : 0; cnt++; }
    const score = (cnt ? sum / cnt : 0) * (onBeat(times[i]) ? 1.1 : 1) * (1 - (0.03 * (times[i] - first)) / beat);
    if (score > bestScore + 1e-9) { bestScore = score; best = times[i]; }
  }
  return best;
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

/** Neighbouring hits overlap by this much and cross-fade, so the loop at its own tempo sounds exactly as recorded. */
export const SLICE_XF = 0.008;
/** A slice is cut this far before the hit, so the very start of the attack is never faded. */
const SLICE_GUARD = 0.003;

/** A hit this close before a downbeat is that downbeat played a little early, not the last note of the bar before. */
export const earlyTolerance = (bpm: number) => Math.min(0.07, (0.35 * 15) / bpm);

/**
 * Cut the recording into hits. Only hits inside the loop (starting at `downbeatS`) are kept. Each slice starts just
 * before its hit (`starts`, when given, is where the sound of each hit begins) and runs into the start of the next
 * one, where the two cross-fade.
 */
export function buildSlices(onsets: number[], durS: number, downbeatS: number, bpm: number, bars: number, starts?: number[]): Slice[] {
  const loopS = loopSeconds(bars, bpm);
  const tol = earlyTolerance(bpm);
  const order = onsets.map((_, i) => i).sort((a, b) => onsets[a] - onsets[b]);
  const all = order.map((i) => onsets[i]);
  const st = order.map((i, k) => Math.min(all[k], starts && starts.length === onsets.length ? starts[i] : all[k]));
  const begin = (k: number) => Math.max(0, k > 0 ? Math.max(st[k] - SLICE_GUARD - SLICE_XF, all[k - 1] + 0.02) : st[k] - SLICE_GUARD - SLICE_XF);
  const out: Slice[] = [];
  for (let k = 0; k < all.length; k++) {
    const t = all[k];
    if (t < downbeatS - tol || t >= downbeatS + loopS - tol || t >= durS) continue;
    const start = Math.min(t, begin(k));
    const next = k + 1 < all.length ? begin(k + 1) + SLICE_XF : durS;
    const end = Math.min(durS, next, start + 1.5);
    if (end - t < 0.015) continue;
    out.push({ beat: Math.max(0, ((t - downbeatS) * bpm) / 60), start, end, pre: t - start });
  }
  return out;
}

/** The loudest sample between two times (for bringing a quiet recording up to the level of the horns). */
export function peakLevel(x: ArrayLike<number>, rate: number, fromS = 0, toS = Infinity): number {
  const a = Math.max(0, Math.floor(fromS * rate)), b = Math.min(x.length, Math.ceil(toS * rate));
  let p = 0;
  for (let i = a; i < b; i++) { const v = Math.abs(x[i]); if (v > p) p = v; }
  return p;
}

/** How a recording sits in the microphone's range: 'hot' when the drums overloaded it, 'quiet' when they barely moved it. */
export function recordingLevel(x: ArrayLike<number>): { peak: number; clipped: number; verdict: 'ok' | 'hot' | 'quiet' } {
  let peak = 0, top = 0;
  for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > peak) peak = v; if (v >= 0.985) top++; }
  const clipped = x.length ? top / x.length : 0;
  return { peak, clipped, verdict: clipped > 0.002 ? 'hot' : peak < 0.06 ? 'quiet' : 'ok' };
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
