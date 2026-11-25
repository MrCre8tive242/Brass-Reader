/** A synthetic drum loop for tests: kick on 1 and 3, snare on 2 and 4, closed hat on every eighth. */
export function synthDrumLoop(bpm: number, bars: number, rate = 44100): Float32Array {
  const beat = 60 / bpm;
  const n = Math.round(bars * 4 * beat * rate);
  const x = new Float32Array(n);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  const add = (t: number, fn: (s: number) => number, dur: number) => {
    const s0 = Math.round(t * rate);
    for (let i = 0; i < dur * rate && s0 + i < n; i++) x[s0 + i] += fn(i / rate);
  };
  for (let b = 0; b < bars * 4; b++) {
    const t = b * beat;
    if (b % 2 === 0) add(t, (s) => 0.9 * Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-s * 40)) * s) * Math.exp(-s * 14), 0.25);
    else add(t, (s) => 0.7 * rnd() * Math.exp(-s * 22) + 0.4 * Math.sin(2 * Math.PI * 190 * s) * Math.exp(-s * 25), 0.2);
    for (const off of [0, 0.5]) add(t + off * beat, (s) => 0.25 * rnd() * Math.exp(-s * 150), 0.04);
  }
  return x;
}

// ---------- a Junkanoo-like drum line (for testing the recorder on something closer to the real thing) ----------

export type LoopInst = 'bass' | 'lead' | 'cowHi' | 'cowLo' | 'whistle';
export interface LoopHit { t: number; inst: LoopInst; vel: number; step: number }
export interface LoopOpts {
  bpm: number;
  bars: number;
  rate?: number;
  /** Human timing: standard deviation of each player's error, milliseconds. */
  jitterMs?: number;
  seed?: number;
  /** One 16-step row per instrument ("X" accent, "x" hit, "o" soft, "." rest); a row may hold several bars. */
  pattern?: Partial<Record<LoopInst, string>>;
  /** Steps per bar: 16 (sixteenths) or 12 (triplets). */
  steps?: 12 | 16;
  /** Silence (room noise only) before the first downbeat and after the last bar, seconds. */
  leadS?: number;
  tailS?: number;
  /** Accented lead-drum hits get a grace note this many ms before them. */
  flamMs?: number;
  /** Room noise level (0.004 is a quiet room). */
  noise?: number;
  /** Early reflections of a hard room. */
  room?: boolean;
  /** Microphone overload: 0 = clean, 3 = badly clipped. */
  drive?: number;
}

export const JUNKANOO_ROWS: Record<LoopInst, string> = {
  bass: 'X...x...X...x...',
  lead: '..x..oX...x..oX.',
  cowHi: 'x.xxx.xxx.xxx.xx',
  cowLo: 'x...x...x...x...',
  whistle: '................',
};

/** Goatskin drums, two cowbells and a whistle played by people: decaying noise bursts and tones, slightly off the grid. */
export function junkanooLoop(o: LoopOpts): { samples: Float32Array; hits: LoopHit[]; downbeatS: number; rate: number } {
  const rate = o.rate ?? 44100;
  const steps = o.steps ?? 16;
  const beat = 60 / o.bpm;
  const stepS = (4 * beat) / steps;
  const lead = o.leadS ?? 0.4, tail = o.tailS ?? 0.3;
  const n = Math.round((lead + o.bars * 4 * beat + tail) * rate);
  const x = new Float32Array(n);
  let seed = (o.seed ?? 7) >>> 0 || 1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / Math.sqrt(0.5); };
  const noise = () => rnd() * 2 - 1;
  const add = (t: number, dur: number, fn: (s: number) => number) => {
    const s0 = Math.round(t * rate);
    for (let i = 0; i < dur * rate; i++) { const k = s0 + i; if (k >= 0 && k < n) x[k] += fn(i / rate); }
  };
  const TAU = 2 * Math.PI;
  // phase of a tone that falls from f0 to f1 with time constant tc
  const sweep = (f0: number, f1: number, tc: number) => (s: number) => TAU * (f1 * s + (f0 - f1) * tc * (1 - Math.exp(-s / tc)));
  const voices: Record<LoopInst, (t: number, v: number) => void> = {
    bass: (t, v) => {
      const ph = sweep(125, 78, 0.03), tune = 1 + 0.02 * gauss();
      add(t, 0.45, (s) => v * (0.8 * Math.sin(ph(s) * tune) * Math.exp(-s * 9) + 0.25 * Math.sin(ph(s) * 1.59 * tune) * Math.exp(-s * 16)) * Math.min(1, s / 0.0015));
      add(t, 0.012, (s) => v * 0.3 * noise() * Math.exp(-s * 300));
    },
    lead: (t, v) => {
      const ph = sweep(330, 245, 0.02), tune = 1 + 0.02 * gauss();
      add(t, 0.25, (s) => v * (0.55 * Math.sin(ph(s) * tune) * Math.exp(-s * 20) + 0.3 * Math.sin(ph(s) * 1.59 * tune) * Math.exp(-s * 30) + 0.15 * Math.sin(ph(s) * 2.14 * tune) * Math.exp(-s * 40)) * Math.min(1, s / 0.001));
      add(t, 0.02, (s) => v * 0.45 * noise() * Math.exp(-s * 180));
    },
    cowHi: (t, v) => {
      const f = 587 * (1 + 0.004 * gauss());
      add(t, 0.3, (s) => v * 0.3 * (Math.sin(TAU * f * s) + 0.7 * Math.sin(TAU * f * 1.48 * s) + 0.45 * Math.sin(TAU * f * 2.63 * s) * Math.exp(-s * 20) + 0.3 * Math.sin(TAU * f * 4.1 * s) * Math.exp(-s * 40)) * Math.exp(-s * 16) * Math.min(1, s / 0.0005));
      add(t, 0.004, (s) => v * 0.25 * noise() * Math.exp(-s * 900));
    },
    cowLo: (t, v) => {
      const f = 415 * (1 + 0.004 * gauss());
      add(t, 0.4, (s) => v * 0.3 * (Math.sin(TAU * f * s) + 0.7 * Math.sin(TAU * f * 1.51 * s) + 0.4 * Math.sin(TAU * f * 2.7 * s) * Math.exp(-s * 18) + 0.25 * Math.sin(TAU * f * 3.9 * s) * Math.exp(-s * 35)) * Math.exp(-s * 11) * Math.min(1, s / 0.0005));
      add(t, 0.004, (s) => v * 0.25 * noise() * Math.exp(-s * 900));
    },
    whistle: (t, v) => {
      const dur = 0.2, f = 2850;
      add(t, dur, (s) => v * 0.22 * Math.sin(TAU * f * s + 3 * Math.sin(TAU * 38 * s)) * (0.7 + 0.3 * Math.sin(TAU * 38 * s)) * Math.min(1, s / 0.012) * Math.min(1, (dur - s) / 0.03) + v * 0.02 * noise());
    },
  };
  const VEL: Record<string, number> = { X: 1, x: 0.7, o: 0.35 };
  const rows = { ...JUNKANOO_ROWS, ...(o.pattern ?? {}) };
  const jit = (o.jitterMs ?? 0) / 1000;
  const hits: LoopHit[] = [];
  for (const inst of Object.keys(rows) as LoopInst[]) {
    const row = rows[inst].replace(/\s+/g, '');
    if (!row.length) continue;
    for (let s = 0; s < o.bars * steps; s++) {
      const c = row[s % row.length];
      const v0 = VEL[c];
      if (!v0) continue;
      const t = lead + s * stepS + Math.max(-2.5, Math.min(2.5, gauss())) * jit;
      const v = v0 * (1 + (jit ? 0.12 * gauss() : 0));
      if (inst === 'lead' && c === 'X' && o.flamMs) voices.lead(t - o.flamMs / 1000, v * 0.4);
      voices[inst](t, v);
      hits.push({ t, inst, vel: v, step: s });
    }
  }
  if (o.room) {
    const d1 = Math.round(0.037 * rate), d2 = Math.round(0.071 * rate);
    for (let i = n - 1; i >= d2; i--) x[i] += 0.22 * x[i - d1] + 0.1 * x[i - d2];
  }
  const lvl = o.noise ?? 0.004;
  for (let i = 0; i < n; i++) x[i] += lvl * noise();
  if (o.drive) { const d = o.drive, k = Math.tanh(d); for (let i = 0; i < n; i++) x[i] = Math.tanh(x[i] * d) / k * 0.95; }
  else for (let i = 0; i < n; i++) x[i] = Math.max(-1, Math.min(1, x[i]));
  hits.sort((a, b) => a.t - b.t);
  return { samples: x, hits, downbeatS: lead, rate };
}
