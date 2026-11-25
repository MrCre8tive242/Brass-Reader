import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Player } from '@/lib/player';
import { buildTimeline } from '@/lib/timeline';
import { notationToMusicXml, parseNotation } from '@/lib/omrNotation';
import { DEFAULT_TRAINER, loopQ, normalizeLoop, normalizeTrainer, passLabel, trainerBpm, type Trainer } from '@/lib/loop';

const tlOf = (t: string) => buildTimeline(notationToMusicXml(parseNotation(t)).xml);
const FOUR = 'time: 4/4\n1: C5:q D5:q E5:q F5:q\n2: G5:q A5:q B5:q C6:q\n3: C6:w\n4: F6:w';

function fakeCtx() {
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} }, frequency: { value: 0 }, start() {}, stop() {}, type: '' });
  return { currentTime: 0, state: 'running', destination: {}, resume: async () => {}, createGain: node, createOscillator: node, createBiquadFilter: node } as unknown as AudioContext & { currentTime: number };
}

describe('loop helpers', () => {
  it('normalises ranges', () => {
    expect(normalizeLoop({ from: 5, to: 2 }, 8)).toEqual({ from: 2, to: 5 });
    expect(normalizeLoop({ from: 0, to: 99 }, 8)).toEqual({ from: 1, to: 8 });
    expect(normalizeLoop(null, 8)).toBeNull();
    expect(normalizeLoop({ from: 1, to: 2 }, 0)).toBeNull();
  });
  it('turns bars into a time range', () => {
    const tl = tlOf(FOUR);
    expect(loopQ(tl, { from: 2, to: 3 })).toEqual({ startQ: 4, endQ: 12 });
    expect(loopQ(tl, { from: 4, to: 4 })).toEqual({ startQ: 12, endQ: 16 });
    expect(loopQ(tl, { from: 1, to: 4 })).toEqual({ startQ: 0, endQ: 16 });
  });
  it('trainer steps up every M passes and stops at the target', () => {
    const t: Trainer = { enabled: true, start: 80, target: 95, step: 5, every: 2 };
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((p) => trainerBpm(t, p))).toEqual([80, 80, 85, 85, 90, 90, 95, 95, 95]);
    expect(trainerBpm({ ...t, every: 1, step: 7 }, 4)).toBe(95);
    expect(trainerBpm({ enabled: true, start: 120, target: 100, step: 10, every: 1 }, 5)).toBe(100); // slowing down works too
  });
  it('defaults are step 5 every 1 pass and bad input is repaired', () => {
    expect(DEFAULT_TRAINER.step).toBe(5);
    expect(DEFAULT_TRAINER.every).toBe(1);
    expect(normalizeTrainer({ start: 5, target: 999, step: 0, every: -3 })).toMatchObject({ start: 30, target: 240, step: 1, every: 1 });
    expect(normalizeTrainer(undefined).enabled).toBe(false);
  });
  it('labels the pass', () => {
    const t = { ...DEFAULT_TRAINER, enabled: true, target: 120 };
    expect(passLabel(3, 85, t)).toBe('Pass 3 · 85 → 120 BPM');
    expect(passLabel(2, 100, null)).toBe('Pass 2 · 100 BPM');
  });
});

describe('Player loop', () => {
  beforeEach(() => { vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {}); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function setup() {
    const ctx = fakeCtx();
    const p = new Player(ctx);
    const starts: { note: number; time: number; duration: number }[] = [];
    (p as unknown as { voice: unknown }).voice = { start: (n: { note: number; time: number; duration: number }) => starts.push(n), stop() {} };
    const tl = tlOf(FOUR);
    p.setTimeline(tl);
    p.setBpm(60);
    const tick = () => (p as unknown as { tick(): void }).tick();
    const run = (to: number, dt = 0.05) => { for (let t = ctx.currentTime; t <= to + 1e-9; t += dt) { ctx.currentTime = t; tick(); } };
    return { ctx, p, tl, starts, run };
  }

  it('wraps with no gap: the first note of the next pass starts exactly when the loop ends', async () => {
    const { p, tl, starts, run } = setup();
    p.setLoop(loopQ(tl, { from: 1, to: 2 }));
    await p.play();
    run(9);
    const c4 = starts.filter((s) => s.note === 72).map((s) => s.time); // C5, first note of bar 1
    expect(c4.length).toBeGreaterThanOrEqual(2);
    // 8 quarters at 60 BPM = 8 s per pass, begins 0.06 s after play
    expect(c4[0]).toBeCloseTo(0.06, 3);
    expect(c4[1]).toBeCloseTo(8.06, 3);
    // nothing from bar 3 or 4 (whole C6 and F6) was ever scheduled
    expect(starts.some((s) => s.note === 89)).toBe(false);
    expect(starts.some((s) => s.duration > 1.2 && s.note === 84)).toBe(false);
    p.dispose();
  });

  it('keeps the cursor inside the loop across the wrap', async () => {
    const { ctx, p, tl, run } = setup();
    p.setLoop(loopQ(tl, { from: 2, to: 2 }));
    await p.play();
    const seen: number[] = [];
    for (let t = 0; t < 11; t += 0.1) { ctx.currentTime = t; (p as unknown as { tick(): void }).tick(); seen.push(p.currentQ()); }
    void run;
    expect(Math.min(...seen.slice(2))).toBeGreaterThanOrEqual(4 - 1e-6);
    expect(Math.max(...seen)).toBeLessThanOrEqual(8 + 1e-6);
    // it really went round more than once
    const drops = seen.filter((q, i) => i > 0 && q < seen[i - 1] - 1).length;
    expect(drops).toBeGreaterThanOrEqual(2);
    p.dispose();
  });

  it('steps the tempo up at the wrap and reports the pass', async () => {
    const { ctx, p, tl, run } = setup();
    const passes: [number, number][] = [];
    let frame: (() => void) | undefined;
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => { frame = f; return 1; });
    p.onPass = (n, b) => passes.push([n, b]);
    p.setLoop(loopQ(tl, { from: 1, to: 1 })); // 4 quarters
    p.setTrainer({ enabled: true, start: 60, target: 90, step: 15, every: 1 });
    await p.play();
    expect(passes[0]).toEqual([1, 60]);
    for (let t = 0; t <= 12; t += 0.05) { ctx.currentTime = t; (p as unknown as { tick(): void }).tick(); frame?.(); }
    void run;
    expect(passes.slice(0, 3)).toEqual([[1, 60], [2, 75], [3, 90]]);
    // pass 2 lasts 4 quarters at 75 BPM = 3.2 s: pass 1 ends at 4.06, pass 2 at 7.26
    expect(p.currentBpm).toBe(90);
    p.dispose();
  });

  it('count-in happens only before the first pass', async () => {
    const { ctx, p, tl } = setup();
    p.countIn = true;
    const clicks: number[] = [];
    (p as unknown as { click: (t: number) => void }).click = (t) => clicks.push(t);
    p.setLoop(loopQ(tl, { from: 1, to: 1 }));
    await p.play();
    for (let t = 0; t <= 14; t += 0.05) { ctx.currentTime = t; (p as unknown as { tick(): void }).tick(); }
    expect(clicks).toHaveLength(4); // one bar of count-in, metronome off
    p.dispose();
  });

  it('plays on to the end when the start is outside the loop after a seek', async () => {
    const { p, tl } = setup();
    p.setLoop(loopQ(tl, { from: 1, to: 1 }));
    await p.play();
    p.seek(3);
    expect((p as unknown as { loopActive: boolean }).loopActive).toBe(false);
    p.dispose();
  });
});
