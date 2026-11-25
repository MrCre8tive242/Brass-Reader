import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildClicks, barLengthQ } from '@/lib/player';
import { buildTimeline } from '@/lib/timeline';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, '../fixtures', n), 'utf8');

describe('player helpers', () => {
  it('builds clicks following the time signature', () => {
    const tl = buildTimeline(fx('key-changes.musicxml'));
    const clicks = buildClicks(tl);
    // bars: 4,4,3,3,4,4 beats
    expect(clicks).toHaveLength(22);
    expect(clicks.filter((c) => c.accent)).toHaveLength(6);
    expect(clicks[8].timeQ).toBe(8); // bar 3 downbeat
    expect(clicks[8].accent).toBe(true);
  });
  it('measures bar length', () => {
    const tl = buildTimeline(fx('key-changes.musicxml'));
    expect(barLengthQ(tl, 1)).toBe(4);
    expect(barLengthQ(tl, 3)).toBe(3);
    expect(barLengthQ(tl, 6)).toBe(4);
  });
});

// ---- held notes survive restarts (BPM / instrument change while playing) ----
import { vi, beforeEach, afterEach } from 'vitest';
import { Player } from '@/lib/player';
import type { Timeline } from '@/lib/timeline';

function fakeCtx() {
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} }, frequency: { value: 0 }, start() {}, stop() {}, type: '' });
  return { currentTime: 0, state: 'running', destination: {}, resume: async () => {}, createGain: node, createOscillator: node, createBiquadFilter: node } as unknown as AudioContext & { currentTime: number };
}

describe('Player restarts keep held notes sounding', () => {
  beforeEach(() => { vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {}); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function setup() {
    const ctx = fakeCtx();
    const p = new Player(ctx);
    const starts: { note: number; time: number; duration: number }[] = [];
    let stops = 0;
    (p as unknown as { voice: unknown }).voice = { start: (n: { note: number; time: number; duration: number }) => starts.push(n), stop: () => { stops++; } };
    // one whole-note chord (C4+E4+G4) in bar 1, a quarter in bar 2
    const tl: Timeline = {
      events: [
        { timeQ: 0, durQ: 4, midi: 60, measure: 1 }, { timeQ: 0, durQ: 4, midi: 64, measure: 1 }, { timeQ: 0, durQ: 4, midi: 67, measure: 1 },
        { timeQ: 4, durQ: 1, midi: 72, measure: 2 },
      ],
      measureStartsQ: [0, 4], totalQ: 8, timeSigs: [{ measure: 1, beats: 4, beatType: 4 }],
      order: [1, 2], measureCount: 2, barLabels: ['1', '2'], barTotal: 2, hasRepeats: false,
    };
    p.setTimeline(tl);
    return { ctx, p, starts, stops: () => stops };
  }

  it('BPM change re-attacks the sounding chord with its remaining duration', async () => {
    const { ctx, p, starts } = setup();
    p.setBpm(60);
    await p.play();
    ctx.currentTime = 0.06 + 1.5; // 1.5 quarters in
    (p as unknown as { tick(): void }).tick();
    expect(starts).toHaveLength(3);
    starts.length = 0;
    p.setBpm(120);
    // chord is re-attacked immediately; 2.5 quarters remain at 120 bpm = 1.25 s * 0.97
    expect(starts.map((s) => s.note).sort()).toEqual([60, 64, 67]);
    for (const s of starts) {
      expect(s.time).toBeCloseTo(ctx.currentTime, 3);
      expect(s.duration).toBeCloseTo(2.5 * 0.5 * 0.97, 2);
    }
    // position did not move and no startup lead was added
    expect(p.currentQ()).toBeCloseTo(1.5, 2);
    p.dispose();
  });

  it('rapid BPM changes do not accumulate delay', async () => {
    const { ctx, p } = setup();
    p.setBpm(60);
    await p.play();
    ctx.currentTime = 1.06;
    for (let b = 61; b < 71; b++) p.setBpm(b);
    expect(p.currentQ()).toBeCloseTo(1.0, 1);
    p.dispose();
  });

  it('notes that have already ended are not re-attacked', async () => {
    const { ctx, p, starts } = setup();
    p.setBpm(60);
    await p.play();
    ctx.currentTime = 0.06 + 4.5;
    (p as unknown as { tick(): void }).tick();
    starts.length = 0;
    p.setBpm(90);
    expect(starts.map((s) => s.note)).toEqual([72]); // only the quarter that is sounding
    p.dispose();
  });
});
