/**
 * The sounds of the starter kit, computed sample by sample (no audio nodes, so they are cheap to play and can be
 * tested without a browser): goatskin drums as struck skins on a barrel, cowbells as struck steel, a pea whistle.
 * Every sound comes in three strengths (soft, normal, accent: an accent is brighter and bends more, not just louder)
 * and a few slightly different takes, so a bar of sixteenths does not sound like a machine.
 *
 * These are still synthesized stand-ins, tuned by ear against descriptions, not samples of Junkanoo instruments.
 */
import type { KitInst } from './groove';

/** 0 soft, 1 normal, 2 accent. */
export type Tier = 0 | 1 | 2;
export const TIER_VEL = [0.35, 0.7, 1] as const;
export const KIT_TAKES = 3;

export const tierOf = (vel: number): Tier => (vel < 0.5 ? 0 : vel < 0.85 ? 1 : 2);

const TAU = 2 * Math.PI;

function rng(seed: number) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * A two-pole resonator (band-pass): what a short burst of noise sounds like inside a barrel or a steel bell.
 * Scaled so that noise of level 1 comes out at about level `gain`, whatever the pitch and sharpness.
 */
function resonate(x: Float32Array, rate: number, hz: number, q: number, gain: number, out: Float32Array) {
  if (hz >= rate * 0.45) return;
  const w = (TAU * hz) / rate, alpha = Math.sin(w) / (2 * q);
  const b0 = alpha, a0 = 1 + alpha, a1 = -2 * Math.cos(w), a2 = 1 - alpha;
  const g = gain * Math.sqrt(rate / 2 / (hz / q));
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] - b0 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    out[i] += g * y;
  }
}

function normalise(y: Float32Array, peak: number) {
  let m = 0;
  for (let i = 0; i < y.length; i++) { const v = Math.abs(y[i]); if (v > m) m = v; }
  if (m > 0) { const k = peak / m; for (let i = 0; i < y.length; i++) y[i] *= k; }
  return y;
}

/** Fade the last few milliseconds to nothing and keep the peak under `peak`. */
function finish(y: Float32Array, rate: number, peak: number) {
  const n = y.length, f = Math.min(n, Math.round(0.02 * rate));
  for (let i = 0; i < f; i++) y[n - 1 - i] *= i / f;
  return normalise(y, peak);
}

interface DrumSpec {
  f0: number;
  /** How far the pitch starts above its resting note (the skin tightens under the blow), and how fast it settles. */
  bend: number;
  bendS: number;
  /** Membrane modes: frequency ratio, level, decay rate (1/s). */
  modes: [number, number, number][];
  /** The shell: resonances that the blow excites. */
  body: [number, number, number][];
  slapHz: number;
  slapS: number;
  slap: number;
  seconds: number;
  peak: number;
}

// The big drum. A phone speaker cannot play its 90 Hz note, so the modes above it and the barrel carry it there.
const BASS: DrumSpec = {
  f0: 92, bend: 0.34, bendS: 0.03,
  modes: [[1, 1, 7.5], [1.59, 0.75, 11], [2.14, 0.5, 16], [2.65, 0.32, 22], [3.16, 0.2, 30]],
  body: [[182, 5, 0.9], [410, 6, 0.8], [640, 5, 0.35]],
  slapHz: 1500, slapS: 0.009, slap: 0.5, seconds: 0.55, peak: 0.85,
};
const LEAD: DrumSpec = {
  f0: 222, bend: 0.2, bendS: 0.018,
  modes: [[1, 1, 13], [1.59, 0.7, 19], [2.14, 0.5, 26], [2.3, 0.3, 32], [2.92, 0.24, 40], [3.6, 0.16, 50]],
  body: [[340, 6, 0.5], [780, 7, 0.5], [1650, 4, 0.3]],
  slapHz: 2700, slapS: 0.013, slap: 0.55, seconds: 0.34, peak: 0.7,
};

/** A hand or stick on a heated goatskin over a barrel: a skin whose pitch drops as it relaxes, the barrel ringing under it, the slap on top. */
function drum(spec: DrumSpec, tier: Tier, take: number, rate: number): Float32Array {
  const r = rng(1000 + spec.f0 * 7 + tier * 31 + take * 101);
  const n = Math.round(spec.seconds * rate);
  const y = new Float32Array(n);
  const hard = [0.45, 0.75, 1][tier]; // how hard it is hit: brightness, bend and slap follow
  const tune = 1 + (r() - 0.5) * 0.03 + (take % 2 ? 0.012 : -0.008); // two hands, never quite the same spot on the skin
  const f0 = spec.f0 * tune;
  const bend = spec.bend * (0.55 + 0.45 * hard) * (0.9 + 0.2 * r());
  const damp = (tier === 0 ? 1.35 : 1) * (0.92 + 0.16 * r()); // a soft touch rings shorter
  for (const [ratio, level, decay] of spec.modes) {
    const fm = f0 * ratio * (1 + (r() - 0.5) * 0.012);
    if (fm >= rate * 0.45) continue;
    // higher modes speak more the harder the skin is hit
    const a = level * (ratio === 1 ? 1 : 0.35 + 0.65 * hard) * (0.9 + 0.2 * r());
    const d = decay * damp, ph0 = r() * 0.6;
    // phase of a tone that starts `bend` sharp and settles: the integral of f(t) = fm * (1 + bend * e^(-t/bendS))
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const ph = TAU * fm * (t + bend * spec.bendS * (1 - Math.exp(-t / spec.bendS))) + ph0;
      y[i] += a * Math.sin(ph) * Math.exp(-t * d);
    }
  }
  // the blow itself: a short burst of noise, heard directly (the slap) and through the barrel
  const burst = new Float32Array(n);
  const bl = Math.round(spec.slapS * (0.8 + 0.5 * hard) * rate);
  for (let i = 0; i < bl && i < n; i++) burst[i] = (r() * 2 - 1) * Math.exp((-4 * i) / bl);
  resonate(burst, rate, spec.slapHz * (0.9 + 0.2 * r()), 1.1, spec.slap * (0.2 + 0.8 * hard * hard), y);
  for (const [hz, q, level] of spec.body) resonate(burst, rate, hz * tune, q, level * (0.45 + 0.55 * hard), y);
  // attack: the skin does not move instantly (and the buffer starts at zero: no click)
  const at = Math.max(2, Math.round(0.0012 * rate));
  for (let i = 0; i < at && i < n; i++) y[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / at);
  // a little overdrive glues the modes together the way a loud drum does
  const drive = 1.1 + 1.0 * hard;
  normalise(y, 1);
  for (let i = 0; i < n; i++) y[i] = Math.tanh(y[i] * drive);
  return finish(y, rate, spec.peak * TIER_VEL[tier] ** 0.85);
}

interface BellSpec { f0: number; ring: number; seconds: number; peak: number }
// big hand-made bells: lower than a drum-kit cowbell, and two of them a fourth apart
const BELL_HI: BellSpec = { f0: 520, ring: 1, seconds: 0.4, peak: 0.44 };
const BELL_LO: BellSpec = { f0: 392, ring: 1.45, seconds: 0.55, peak: 0.46 };
// partials of a struck steel bell with a flared mouth: not a harmonic series, which is what makes it clang
const BELL_PARTIALS: [number, number, number][] = [[1, 1, 17], [1.504, 0.9, 15], [2.43, 0.95, 20], [3.07, 0.85, 24], [4.16, 0.7, 32], [5.43, 0.6, 40], [6.79, 0.45, 50], [8.21, 0.32, 64]];

/** A welded steel cowbell with a clapper: a hard tick, a clang of partials that are not in tune with each other, sometimes the clapper bouncing. */
function bell(spec: BellSpec, tier: Tier, take: number, rate: number): Float32Array {
  const r = rng(5000 + spec.f0 * 3 + tier * 37 + take * 113);
  const n = Math.round(spec.seconds * rate);
  const y = new Float32Array(n);
  const hard = [0.4, 0.72, 1][tier];
  const tune = 1 + (r() - 0.5) * 0.008; // steel does not change pitch; where it is struck changes the balance
  const strike = 0.75 + 0.5 * r(); // near the mouth (bright) or near the crown (dull)
  const one = (start: number, gain: number, short: number) => {
    BELL_PARTIALS.forEach(([ratio, level, decay], k) => {
      const f = spec.f0 * ratio * tune * (1 + (r() - 0.5) * 0.004);
      if (f >= rate * 0.45) return;
      const a = gain * level * (k < 2 ? 1 : (0.45 + 0.55 * hard) * strike) * (0.88 + 0.24 * r());
      const d = (decay * short) / spec.ring, ph0 = r() * TAU;
      // the two lowest partials are hollow (odd overtones), and the second one beats against a close twin
      const twin = k === 1 ? f * 1.011 : 0;
      for (let i = start; i < n; i++) {
        const t = (i - start) / rate, e = Math.exp(-t * d), ph = TAU * f * t + ph0;
        let v = Math.sin(ph);
        if (k < 2 && f * 3 < rate * 0.45) v += 0.22 * Math.sin(3 * ph);
        if (twin) v += 0.55 * Math.sin(TAU * twin * t + ph0 * 1.7);
        y[i] += a * v * e;
      }
    });
    // the tick of metal on metal
    const tl = Math.round(0.0025 * rate);
    let lp = 0;
    for (let i = 0; i < tl && start + i < n; i++) { const w = r() * 2 - 1; const hp = w - lp; lp += 0.35 * (w - lp); y[start + i] += gain * 0.55 * hard * hp * Math.exp((-3 * i) / tl); }
  };
  one(0, 1, 1);
  // a shaken bell: on some hits the clapper comes back for a second, softer touch
  if (tier > 0 && take % 2 === 1) one(Math.round((0.027 + 0.014 * r()) * rate), 0.2 + 0.1 * r(), 1.5);
  const at = Math.max(2, Math.round(0.0004 * rate));
  for (let i = 0; i < at && i < n; i++) y[i] *= i / at;
  const drive = 0.8 + 1.0 * hard; // the harsh edge of a bell hit hard
  normalise(y, 1);
  for (let i = 0; i < n; i++) y[i] = Math.tanh(y[i] * drive);
  return finish(y, rate, spec.peak * TIER_VEL[tier] ** 0.8);
}

/** A pea whistle: a shrill tone that scoops up, trills as the pea goes round, with breath in it. */
function whistle(tier: Tier, take: number, rate: number): Float32Array {
  const r = rng(9000 + tier * 41 + take * 127);
  const dur = [0.13, 0.18, 0.25][tier] * (0.94 + 0.12 * r());
  const n = Math.round((dur + 0.03) * rate);
  const y = new Float32Array(n);
  const f0 = Math.min(rate * 0.4, (2980 + 140 * tier) * (1 + (r() - 0.5) * 0.02));
  const trill = 31 + 7 * r() + 3 * tier; // the pea spins faster the harder you blow
  const air = new Float32Array(n);
  for (let i = 0; i < n; i++) air[i] = r() * 2 - 1;
  let ph = 0, ph2 = 0, tp = r() * TAU;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const pea = Math.sin(tp);
    tp += (TAU * trill * (1 + 0.15 * Math.exp(-t * 30))) / rate;
    const scoop = 1 - 0.06 * Math.exp(-t / 0.012); // it speaks a little flat and jumps up
    const f = f0 * scoop * (1 + 0.02 * pea);
    ph += (TAU * f) / rate;
    ph2 += (TAU * f * 1.083) / rate; // the second chamber, a little sharp: the roughness of a referee's whistle
    const env = Math.min(1, t / 0.006) * Math.min(1, Math.max(0, (dur - t) / 0.022)) * (0.72 + 0.28 * pea);
    y[i] = env * (Math.sin(ph) + 0.42 * Math.sin(ph2) + (2 * f < rate * 0.45 ? 0.1 * Math.sin(2 * ph) : 0));
  }
  // breath: noise through the mouth of the whistle, loudest as it starts to speak
  const breath = new Float32Array(n);
  resonate(air, rate, f0, 5, 1, breath);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t / 0.003) * Math.min(1, Math.max(0, (dur - t) / 0.022));
    y[i] += breath[i] * env * (0.5 + 1.6 * Math.exp(-t / 0.012));
  }
  return finish(y, rate, 0.26 * TIER_VEL[tier] ** 0.6);
}

// ---------- the Junkanoo groove's kit (tuned with the player by ear) ----------

/** Fade the tail over its last `s` seconds: a long ring cut to fit the buffer should die away, not stop. */
function tail(y: Float32Array, rate: number, s: number) {
  const n = y.length, f = Math.min(n, Math.round(s * rate));
  for (let i = 0; i < f; i++) y[n - 1 - i] *= (i / f) ** 2;
}

/** Marching cymbals on the off-beats: a short splash of bright noise. */
function cymbal(tier: Tier, take: number, rate: number): Float32Array {
  const r = rng(12000 + tier * 43 + take * 131);
  const n = Math.round(0.35 * rate);
  const y = new Float32Array(n);
  // white noise differenced twice: the low end goes, the sizzle stays
  let w1 = 0, w2 = 0;
  for (let i = 0; i < n; i++) {
    const w = (r() + r() + r() - 1.5) * 2;
    const d1 = w - w1, d2 = d1 - w2;
    w1 = w; w2 = d1;
    y[i] = d2 * Math.exp(-i / rate / 0.09);
  }
  const at = Math.max(2, Math.round(0.001 * rate));
  for (let i = 0; i < at && i < n; i++) y[i] *= i / at;
  return finish(y, rate, 0.9 * TIER_VEL[tier] ** 0.85);
}

/** The deep bass drum: a boom that drops a little in pitch and rings, with no slap noise on it. */
function deepBass(tier: Tier, take: number, rate: number): Float32Array {
  const r = rng(13000 + tier * 47 + take * 137);
  const n = Math.round(0.58 * rate);
  const y = new Float32Array(n);
  const tune = 1 + (r() - 0.5) * 0.02 + (take - 1) * 0.012;
  const f0 = 68 * tune, fb = 35 * tune, ts = 0.07;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const ph = TAU * (f0 * t + fb * ts * (1 - Math.exp(-t / ts)));
    y[i] = Math.sin(ph) * Math.exp(-t / 0.38) + 0.35 * Math.sin(1.59 * ph) * Math.exp(-t / 0.18) + 0.2 * Math.sin(2.3 * ph) * Math.exp(-t / 0.08);
  }
  const at = Math.max(2, Math.round(0.0012 * rate));
  for (let i = 0; i < at; i++) y[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / at);
  tail(y, rate, 0.12);
  return finish(y, rate, 0.85 * TIER_VEL[tier] ** 0.85);
}

/**
 * The tum tum: a drum-kit head (Remo Pinstripe type) pulled tight on an open barrel with the bottom cut out, played
 * with the hand. Soft attack (no stick), little pitch bend (no second head), and a skin that keeps singing after
 * the hit (a short ring sounded like a wood block). Accents add a slap made only of the head's own tones. No noise
 * at all: noise here sounds like snare wires. `middle`: struck in the centre of the skin, so a rounder hit.
 */
function tumTum(f0: number, peak: number, tier: Tier, take: number, rate: number, middle = false): Float32Array {
  const r = rng(14000 + f0 * 5 + tier * 53 + take * 139);
  const n = Math.round(0.58 * rate);
  const y = new Float32Array(n);
  const tune = 1 + (r() - 0.5) * 0.02 + (take - 1) * 0.015; // two hands, never quite the same spot
  const f = f0 * tune, dec = 0.22;
  const slap = middle ? 0.25 : [0.05, 0.12, 0.7][tier];
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const ph = TAU * f * (t + 0.08 * 0.015 * (1 - Math.exp(-t / 0.015)));
    const body = Math.sin(ph) * Math.exp(-t / dec) + 0.22 * Math.sin(1.59 * ph) * Math.exp(-t / (dec * 0.45))
      + 0.12 * Math.sin(2.14 * ph) * Math.exp(-t / (dec * 0.3))
      + 0.35 * Math.sin(TAU * f * 0.55 * t) * Math.exp(-t / 0.03); // the palm's thump
    const pop = (Math.sin(2 * ph) + 0.4 * Math.sin(3 * ph)) * Math.exp(-t / 0.01);
    y[i] = Math.min(1, t / 0.0025) * (body + slap * 1.2 * pop);
  }
  tail(y, rate, 0.15);
  return finish(y, rate, peak * TIER_VEL[tier]);
}

/** One take of one kit sound as samples (mono, starts and ends at zero). */
export function renderKit(inst: KitInst, tier: Tier, take: number, rate: number): Float32Array {
  const k = ((take % KIT_TAKES) + KIT_TAKES) % KIT_TAKES;
  switch (inst) {
    case 'bass': return drum(BASS, tier, k, rate);
    case 'lead': return drum(LEAD, tier, k, rate);
    case 'cowHi': return bell(BELL_HI, tier, k, rate);
    case 'cowLo': return bell(BELL_LO, tier, k, rate);
    case 'whistle': return whistle(tier, k, rate);
    case 'cymbal': return cymbal(tier, k, rate);
    case 'jkBass': return deepBass(tier, k, rate);
    case 'tumHi': return tumTum(460, 0.46, tier, k, rate);
    case 'tumLo': return tumTum(330, 0.4, tier, k, rate);
    case 'tumMid': return tumTum(460 * 0.88, 0.46, tier, k, rate, true);
  }
}
