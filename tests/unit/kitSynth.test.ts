import { describe, it, expect } from 'vitest';
import { renderKit, tierOf, KIT_TAKES, TIER_VEL, type Tier } from '@/lib/kitSynth';
import { KIT_INSTS, type KitInst } from '@/lib/groove';
import { DrumBus, playKit, warmKit } from '@/lib/drums';
import { spectrum, centroid, peaks } from '../spectrum';

const RATE = 44100;
const TIERS: Tier[] = [0, 1, 2];
const peakOf = (y: Float32Array) => y.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
/** Seconds until the sound has fallen for good below `db` under its peak. */
function ringS(y: Float32Array, db = -30) {
  const lim = peakOf(y) * Math.pow(10, db / 20);
  let last = 0;
  for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > lim) last = i;
  return last / RATE;
}
const attackCentroid = (y: Float32Array) => centroid(spectrum(y, RATE, 0, Math.round(0.012 * RATE)));

describe('starter kit sounds (rendered samples)', () => {
  it('every sound starts and ends at silence, stays in range, and gets louder with each strength', () => {
    for (const k of KIT_INSTS) {
      const pk = TIERS.map((t) => {
        const y = renderKit(k.id, t, 0, RATE);
        expect(y.every((v) => Number.isFinite(v))).toBe(true);
        expect(Math.abs(y[0])).toBeLessThan(0.02); // no click at the start
        expect(Math.abs(y[y.length - 1])).toBeLessThan(0.001);
        expect(y.length / RATE).toBeLessThan(0.6);
        return peakOf(y);
      });
      expect(pk[0]).toBeLessThan(pk[1]);
      expect(pk[1]).toBeLessThan(pk[2]);
      expect(pk[2]).toBeLessThanOrEqual(0.9);
      expect(pk[0]).toBeGreaterThan(0.1); // a soft hit is still heard
    }
  });

  it('drums and bells speak at once; the whistle takes a moment', () => {
    const peakAt = (y: Float32Array) => { const p = peakOf(y); return y.findIndex((v) => Math.abs(v) >= p * 0.9) / RATE; };
    for (const id of ['bass', 'lead', 'cowHi', 'cowLo'] as KitInst[]) expect(peakAt(renderKit(id, 2, 0, RATE))).toBeLessThan(0.015);
    const w = renderKit('whistle', 2, 0, RATE);
    expect(w.findIndex((v) => Math.abs(v) >= peakOf(w) * 0.5) / RATE).toBeGreaterThan(0.001);
  });

  it('the big drum is low and rings longest, the lead drum is higher and shorter', () => {
    const bass = renderKit('bass', 2, 0, RATE), lead = renderKit('lead', 2, 0, RATE);
    // the note each settles on (after the pitch has dropped)
    const note = (y: Float32Array) => peaks(spectrum(y, RATE, Math.round(0.06 * RATE), Math.round(0.2 * RATE)), 1)[0][0];
    expect(note(bass)).toBeGreaterThan(80);
    expect(note(bass)).toBeLessThan(110);
    expect(note(lead)).toBeGreaterThan(195);
    expect(note(lead)).toBeLessThan(250);
    expect(ringS(bass)).toBeGreaterThan(ringS(lead));
    expect(ringS(bass)).toBeGreaterThan(0.25);
    expect(ringS(lead)).toBeLessThan(0.33);
    // the skin tightens under the blow: the note starts sharp and falls
    const early = peaks(spectrum(lead, RATE, 0, Math.round(0.03 * RATE)), 1)[0][0];
    expect(early).toBeGreaterThan(note(lead) * 1.02);
    // there is more to it than one sine: the barrel and the upper modes are in the sound (a phone speaker needs them)
    const sp = spectrum(bass, RATE, 0, Math.round(0.1 * RATE));
    const above = sp.filter(([f]) => f > 140).reduce((a, [, m]) => a + m * m, 0), all = sp.reduce((a, [, m]) => a + m * m, 0);
    expect(above / all).toBeGreaterThan(0.12);
  });

  it('a harder hit is brighter, not just louder', () => {
    for (const id of ['bass', 'lead', 'cowHi', 'cowLo'] as KitInst[]) {
      expect(attackCentroid(renderKit(id, 2, 0, RATE)), id).toBeGreaterThan(attackCentroid(renderKit(id, 0, 0, RATE)) * 1.08);
    }
    // and a harder blown whistle is longer
    expect(renderKit('whistle', 2, 0, RATE).length).toBeGreaterThan(renderKit('whistle', 0, 0, RATE).length * 1.4);
  });

  it('the cowbells clang: their partials are not a harmonic series, and the low bell is lower and rings longer', () => {
    const hi = renderKit('cowHi', 1, 0, RATE), lo = renderKit('cowLo', 1, 0, RATE);
    const pk = peaks(spectrum(hi, RATE, 0, Math.round(0.15 * RATE)), 5).map(([f]) => f).sort((a, b) => a - b);
    const f0 = pk[0];
    expect(f0).toBeGreaterThan(480);
    expect(f0).toBeLessThan(560);
    const offHarmonic = pk.slice(1).filter((f) => { const r = f / f0; return Math.abs(r - Math.round(r)) > 0.08; });
    expect(offHarmonic.length).toBeGreaterThanOrEqual(2);
    const lowest = (y: Float32Array) => peaks(spectrum(y, RATE, 0, Math.round(0.15 * RATE)), 5).map(([f]) => f).sort((a, b) => a - b)[0];
    expect(lowest(lo)).toBeLessThan(f0 * 0.85);
    expect(ringS(lo)).toBeGreaterThan(ringS(hi));
    // bright metal: well above the drums
    expect(attackCentroid(hi)).toBeGreaterThan(900);
    expect(attackCentroid(hi)).toBeGreaterThan(attackCentroid(renderKit('lead', 1, 0, RATE)));
  });

  it('the whistle is a shrill, trilling tone', () => {
    const w = renderKit('whistle', 1, 0, RATE);
    const c = centroid(spectrum(w, RATE));
    expect(c).toBeGreaterThan(2600);
    expect(c).toBeLessThan(4200);
    // the pea: the loudness wobbles some thirty times a second
    const env: number[] = [];
    const hop = Math.round(RATE / 200);
    for (let i = Math.round(0.03 * RATE); i + hop < Math.round(0.15 * RATE); i += hop) { let m = 0; for (let k = 0; k < hop; k++) m += w[i + k] ** 2; env.push(Math.sqrt(m / hop)); }
    const mean = env.reduce((a, b) => a + b, 0) / env.length;
    let crossings = 0;
    for (let i = 1; i < env.length; i++) if ((env[i - 1] - mean) * (env[i] - mean) < 0) crossings++;
    const hz = crossings / 2 / (env.length / 200);
    expect(hz).toBeGreaterThan(20);
    expect(hz).toBeLessThan(55);
    expect(Math.max(...env) / Math.min(...env)).toBeGreaterThan(1.3);
  });

  it('no two takes are the same, and the same take is always the same', () => {
    for (const k of KIT_INSTS) {
      const a = renderKit(k.id, 1, 0, RATE), b = renderKit(k.id, 1, 1, RATE), c = renderKit(k.id, 1, 2, RATE);
      const diff = (x: Float32Array, y: Float32Array) => { let d = 0, e = 0; for (let i = 0; i < Math.min(x.length, y.length); i++) { d += (x[i] - y[i]) ** 2; e += x[i] ** 2; } return Math.sqrt(d / e); };
      expect(diff(a, b), k.id).toBeGreaterThan(0.05);
      expect(diff(b, c), k.id).toBeGreaterThan(0.05);
      expect(Array.from(renderKit(k.id, 1, 0, RATE).subarray(0, 200))).toEqual(Array.from(a.subarray(0, 200)));
      expect(Array.from(renderKit(k.id, 1, KIT_TAKES, RATE).subarray(0, 50))).toEqual(Array.from(a.subarray(0, 50))); // takes wrap round
    }
    expect([0.2, 0.35, 0.6, 0.7, 0.9, 1].map(tierOf)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(TIER_VEL).toEqual([0.35, 0.7, 1]);
  });

  it('still makes sense at a low sample rate (old phones, Bluetooth headsets)', () => {
    for (const k of KIT_INSTS) {
      const y = renderKit(k.id, 2, 0, 8000);
      expect(y.every((v) => Number.isFinite(v))).toBe(true);
      expect(peakOf(y)).toBeGreaterThan(0.1);
    }
  });
});

function fakeCtx() {
  const played: { t: number; rate: number; gain: number; buffer: unknown }[] = [];
  const param = (value = 1) => ({ value, setValueAtTime() {}, linearRampToValueAtTime() {} });
  const made: number[] = [];
  const ctx = {
    sampleRate: 22050, currentTime: 0, destination: {},
    createGain: () => ({ connect() {}, disconnect() {}, gain: param() }),
    createBufferSource: () => {
      const n = { buffer: null as unknown, playbackRate: param(), gainNode: null as null | { gain: { value: number } }, addEventListener() {}, stop() {},
        connect(g: { gain: { value: number } }) { n.gainNode = g; },
        start(t: number) { played.push({ t, rate: n.playbackRate.value, gain: n.gainNode!.gain.value, buffer: n.buffer }); } };
      return n;
    },
    createBuffer: (_c: number, len: number) => { made.push(len); const d = new Float32Array(len); return { length: len, getChannelData: () => d }; },
  };
  return { ctx: ctx as unknown as AudioContext, played, made };
}

describe('playing the kit', () => {
  it('a row of the same hit never repeats itself exactly: another take, a touch of pitch and loudness', () => {
    const { ctx, played } = fakeCtx();
    for (let i = 0; i < 16; i++) playKit(ctx, ctx.destination, 'cowHi', i * 0.1, 0.7);
    for (let i = 1; i < played.length; i++) expect(played[i].buffer).not.toBe(played[i - 1].buffer);
    expect(new Set(played.map((p) => p.rate.toFixed(5))).size).toBeGreaterThan(8);
    for (const p of played) {
      expect(Math.abs(p.rate - 1)).toBeLessThanOrEqual(0.02);
      expect(Math.abs(p.gain - 1)).toBeLessThanOrEqual(0.11);
    }
    // on time, exactly: the feel is in the sound, never in the timing
    expect(played.map((p) => p.t)).toEqual(Array.from({ length: 16 }, (_, i) => i * 0.1));
  });

  it('with fixed dice it is repeatable; strength picks the sound and scales it', () => {
    const run = () => { const f = fakeCtx(); let s = 1; const dice = () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; playKit(f.ctx, f.ctx.destination, 'bass', 1, 1, () => {}, dice); playKit(f.ctx, f.ctx.destination, 'bass', 2, 0.35, () => {}, dice); return f.played; };
    const a = run(), b = run();
    expect(a.map((p) => [p.rate, p.gain])).toEqual(b.map((p) => [p.rate, p.gain]));
    const f = fakeCtx();
    playKit(f.ctx, f.ctx.destination, 'lead', 0, 0.5, () => {}, () => 0.5); // between soft and normal: the normal sound, turned down
    expect(f.played[0].gain).toBeCloseTo(0.5 / 0.7, 6);
  });

  it('sounds are rendered once per context and warmed ahead of the first bar', async () => {
    const { ctx, made } = fakeCtx();
    warmKit(ctx, [{ inst: 'bass', vel: 1 }, { inst: 'bass', vel: 0.7 }, { inst: 'cowHi', vel: 0.7 }, { vel: 1 }]);
    await new Promise((r) => setTimeout(r, 400));
    expect(made.length).toBe(3 * KIT_TAKES);
    for (let i = 0; i < 12; i++) playKit(ctx, ctx.destination, 'bass', i, 1);
    expect(made.length).toBe(3 * KIT_TAKES); // nothing new had to be made
    const bus = new DrumBus(ctx, ctx.destination);
    bus.hit({ timeQ: 0, vel: 0.35, gm: 36, durQ: 0.25, inst: 'bass' }, 1, 0.5, 120);
    expect(made.length).toBe(3 * KIT_TAKES + 1);
    bus.stop();
    bus.dispose();
  });
});
