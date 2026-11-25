import { describe, it, expect } from 'vitest';
import { DrumBus, playKit } from '@/lib/drums';
import { KIT_INSTS, starterGroove, grooveBarHits, type DrumHit } from '@/lib/groove';

function fakeCtx() {
  const started: { kind: string; t: number }[] = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = (kind: string) => ({ connect() {}, disconnect() {}, gain: param(), frequency: param(), detune: param(), playbackRate: param(), Q: param(), type: '', buffer: null as unknown,
    start(t: number) { started.push({ kind, t }); }, stop() {}, addEventListener() {} });
  const ctx = {
    sampleRate: 8000, currentTime: 0, destination: {},
    createGain: () => node('gain'), createOscillator: () => node('osc'), createBufferSource: () => node('src'), createBiquadFilter: () => node('filter'),
    createBuffer: (_c: number, n: number) => ({ length: n, getChannelData: () => new Float32Array(n) }),
  };
  return { ctx: ctx as unknown as AudioContext, started };
}

describe('starter kit sounds', () => {
  it('every instrument makes sound at the time it is told to', () => {
    for (const k of KIT_INSTS) {
      const { ctx, started } = fakeCtx();
      playKit(ctx, ctx.destination, k.id, 1.5, 0.8);
      expect(started.length).toBeGreaterThan(0);
      for (const s of started) expect(s.t).toBe(1.5);
    }
  });
  it('the bus plays kit hits and logs them; a recorded hit needs its audio', () => {
    const { ctx, started } = fakeCtx();
    const bus = new DrumBus(ctx, ctx.destination);
    const g = starterGroove('starter-a')!;
    const hits = grooveBarHits(g, 0);
    hits.slice(0, 3).forEach((h, i) => bus.hit(h, 2 + i, 0.5, 120, h.timeQ));
    expect(bus.log).toHaveLength(3);
    expect(started.length).toBeGreaterThan(3);
    const before = started.length;
    bus.hit({ timeQ: 0, vel: 1, gm: 38, durQ: 0.25, slice: 0 } as DrumHit, 5, 0.5, 120); // no source: silently nothing
    expect(started.length).toBe(before);
    bus.source = { groove: { id: 'x', name: 'x', kind: 'recorded', createdAt: 0, feel: 'straight', bpm: 120, bars: 1, slices: [{ beat: 0, start: 0.1, end: 0.3 }] }, buffer: { length: 10 } as unknown as AudioBuffer };
    bus.hit({ timeQ: 0, vel: 1, gm: 38, durQ: 0.25, slice: 0, maxQ: Infinity }, 5, 0.5, 120);
    expect(started.at(-1)).toEqual({ kind: 'src', t: 5 });
  });
});
