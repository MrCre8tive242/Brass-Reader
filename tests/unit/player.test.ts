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

// ---- metronome and count-in follow the music ----
import { beatLengthQ, countInClicks } from '@/lib/player';
import { notationToMusicXml, parseNotation } from '@/lib/omrNotation';
import { unlockAudio, releaseAudio, isIos, silentWav } from '@/lib/audioUnlock';

const tlOf = (t: string) => buildTimeline(notationToMusicXml(parseNotation(t)).xml);

describe('beats', () => {
  it('compound time is felt in dotted quarters', () => {
    expect(beatLengthQ({ beats: 6, beatType: 8 })).toBe(1.5);
    expect(beatLengthQ({ beats: 12, beatType: 8 })).toBe(1.5);
    expect(beatLengthQ({ beats: 3, beatType: 8 })).toBe(0.5);
    expect(beatLengthQ({ beats: 4, beatType: 4 })).toBe(1);
    expect(beatLengthQ({ beats: 2, beatType: 2 })).toBe(2);
    const c = buildClicks(tlOf('time: 6/8\n1: C5:q. C5:q.\n2: C5:h.'));
    expect(c.map((x) => [x.timeQ, x.accent])).toEqual([[0, true], [1.5, false], [3, true], [4.5, false]]);
  });
  it('a pickup bar clicks on the beat without a false downbeat', () => {
    const c = buildClicks(tlOf('time: 4/4\n0: G4:e A4:q\n1: C5:w'));
    // pickup of 1.5 beats: starts half a beat before beat 4
    expect(c.map((x) => [x.timeQ, x.accent])).toEqual([[0.5, false], [1.5, true], [2.5, false], [3.5, false], [4.5, false]]);
  });
});

describe('count-in', () => {
  it('is one bar of beats with an accent on one', () => {
    const tl = tlOf('time: 3/4\n1: C5:h.\n2: C5:h.');
    expect(countInClicks(tl, 2)).toEqual([{ offsetQ: -3, accent: true }, { offsetQ: -2, accent: false }, { offsetQ: -1, accent: false }]);
  });
  it('before a pickup it counts up to the pickup: "1 2 3" then the pickup on 4', () => {
    const tl = tlOf('time: 4/4\n0: G4:q\n1: C5:w');
    expect(countInClicks(tl, 1)).toEqual([{ offsetQ: -3, accent: true }, { offsetQ: -2, accent: false }, { offsetQ: -1, accent: false }]);
  });
  it('a long pickup gets a whole extra bar so there are at least two clicks', () => {
    const tl = tlOf('time: 4/4\n0: G4:h.\n1: C5:w');
    expect(countInClicks(tl, 1).map((c) => [c.offsetQ, c.accent])).toEqual([[-5, true], [-4, false], [-3, false], [-2, false], [-1, true]]);
  });
  it('6/8 counts two', () => {
    const tl = tlOf('time: 6/8\n1: C5:h.\n2: C5:h.');
    expect(countInClicks(tl, 1).map((c) => c.offsetQ)).toEqual([-3, -1.5]);
  });
});

describe('Player and the audio clock', () => {
  beforeEach(() => { vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {}); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const tl = () => tlOf('time: 4/4\n1: C5:w\n2: D5:w');

  it('does not start, and says so, when the browser keeps the audio blocked', async () => {
    const ctx = fakeCtx();
    (ctx as unknown as { state: string }).state = 'suspended';
    const p = new Player(ctx);
    p.setTimeline(tl());
    const blocked = vi.fn();
    p.onBlocked = blocked;
    expect(await p.play()).toBe(false);
    expect(p.isPlaying).toBe(false);
    expect(blocked).toHaveBeenCalledTimes(1);
  });
  it('resumes a suspended context from the Play gesture', async () => {
    const ctx = fakeCtx();
    const c = ctx as unknown as { state: string; resume: () => Promise<void> };
    c.state = 'suspended';
    c.resume = async () => { c.state = 'running'; };
    const p = new Player(ctx);
    p.setTimeline(tl());
    expect(await p.play()).toBe(true);
    expect(p.isPlaying).toBe(true);
    p.dispose();
  });
  it('pauses when the phone interrupts the audio (call, lock screen)', async () => {
    const ctx = fakeCtx();
    let onState: (() => void) | undefined;
    (ctx as unknown as { addEventListener: (t: string, f: () => void) => void }).addEventListener = (_t, f) => { onState = f; };
    const p = new Player(ctx);
    p.setTimeline(tl());
    await p.play();
    ctx.currentTime = 1;
    (ctx as unknown as { state: string }).state = 'interrupted';
    onState!();
    expect(p.isPlaying).toBe(false);
  });
  it('draws the cursor where the sound is, behind the scheduling clock by the output delay', async () => {
    const ctx = fakeCtx();
    (ctx as unknown as { outputLatency: number; baseLatency: number }).outputLatency = 0.2;
    (ctx as unknown as { baseLatency: number }).baseLatency = 0.05;
    let frame: (() => void) | undefined;
    vi.stubGlobal('requestAnimationFrame', (f: () => void) => { frame = f; return 1; });
    const p = new Player(ctx);
    p.setTimeline(tl());
    p.setBpm(120);
    const seen: number[] = [];
    p.onPosition = (q) => seen.push(q);
    await p.play();
    ctx.currentTime = 0.06 + 1; // 2 quarters scheduled
    frame!();
    expect(p.outputDelay()).toBeCloseTo(0.25);
    expect(seen[seen.length - 1]).toBeCloseTo(1.5, 5); // 0.25 s = half a quarter behind
    expect(p.currentQ()).toBeCloseTo(2, 5);
    p.dispose();
  });
  it('count-in clicks happen before the first note and the position waits', async () => {
    const ctx = fakeCtx();
    const p = new Player(ctx);
    p.setTimeline(tl());
    p.setBpm(60);
    p.countIn = true;
    const clicks: number[] = [];
    (p as unknown as { click: (t: number) => void }).click = (t) => clicks.push(t);
    const starts: number[] = [];
    (p as unknown as { voice: unknown }).voice = { start: (n: { time: number }) => starts.push(n.time), stop() {} };
    await p.play();
    for (let t = 0; t <= 5; t += 0.2) { ctx.currentTime = t; (p as unknown as { tick(): void }).tick(); if (t < 4) expect(p.currentQ()).toBe(0); }
    expect(clicks.slice(0, 4).map((x) => Math.round((x - 0.06) * 100) / 100)).toEqual([0, 1, 2, 3]);
    expect(starts[0]).toBeCloseTo(4.06, 2);
    p.dispose();
  });
});

describe('unlockAudio', () => {
  afterEach(() => { vi.unstubAllGlobals(); releaseAudio(); });
  const ctxWithBuffers = () => {
    const started: number[] = [];
    const ctx = { destination: {}, createBuffer: () => ({}), createBufferSource: () => ({ connect() {}, start: (t: number) => started.push(t), buffer: null }) } as unknown as AudioContext;
    return { ctx, started };
  };
  it('recognises iPhones and iPads (including iPad "desktop" mode)', () => {
    expect(isIos({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 })).toBe(false);
    expect(isIos({ userAgent: 'Mozilla/5.0 (Linux; Android 14)', maxTouchPoints: 5 })).toBe(false);
  });
  it('marks the page as media playback where the browser supports it (silent switch no longer mutes)', () => {
    const session = { type: 'auto' };
    vi.stubGlobal('navigator', { userAgent: 'iPhone', maxTouchPoints: 5, audioSession: session });
    const made: string[] = [];
    vi.stubGlobal('document', { createElement: (t: string) => { made.push(t); return {}; } });
    const { ctx, started } = ctxWithBuffers();
    unlockAudio(ctx);
    unlockAudio(ctx);
    expect(session.type).toBe('playback');
    expect(started).toEqual([0]); // primed once per context
    expect(made).toEqual([]); // no silent loop needed
  });
  it('falls back to a silent looping audio element on older iPhones, and stops it on release', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)', maxTouchPoints: 5 });
    const el = { loop: false, src: '', preload: '', attrs: {} as Record<string, string>, plays: 0, pauses: 0, setAttribute(k: string, v: string) { this.attrs[k] = v; }, play() { this.plays++; return Promise.resolve(); }, pause() { this.pauses++; } };
    vi.stubGlobal('document', { createElement: () => el });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:silence' });
    unlockAudio(ctxWithBuffers().ctx);
    expect(el).toMatchObject({ loop: true, src: 'blob:silence', plays: 1 });
    expect(el.attrs).toHaveProperty('playsinline');
    releaseAudio();
    expect(el.pauses).toBe(1);
  });
  it('does nothing special on other devices', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14)', maxTouchPoints: 5 });
    const made: string[] = [];
    vi.stubGlobal('document', { createElement: (t: string) => { made.push(t); return {}; } });
    unlockAudio(ctxWithBuffers().ctx);
    expect(made).toEqual([]);
  });
  it('the silent clip is a valid little WAV file', () => {
    const w = silentWav(0.5, 8000);
    expect(String.fromCharCode(...w.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...w.slice(8, 12))).toBe('WAVE');
    expect(w.length).toBe(44 + 4000);
    expect(new DataView(w.buffer).getUint32(40, true)).toBe(4000);
    expect(new Set(w.slice(44))).toEqual(new Set([128]));
  });
});

// ---- the drums ride on the same clock ----
import { buildDrumEvents, starterGroove } from '@/lib/groove';

describe('Player drums', () => {
  beforeEach(() => { vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {}); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function setup(text = 'time: 4/4\n1: C5:w\n2: C5:w\n3: C5:w\n4: C5:w') {
    const ctx = fakeCtx();
    const p = new Player(ctx);
    (p as unknown as { voice: unknown }).voice = { start() {}, stop() {} };
    const tl = tlOf(text);
    p.setTimeline(tl);
    const hits: { q: number; when: number; bpm: number }[] = [];
    p.drums.hit = (h, when, _spq, bpm) => { hits.push({ q: h.timeQ, when, bpm }); };
    p.setDrums(buildDrumEvents(tl, starterGroove('starter-a')!), null);
    p.setDrumsEnabled(true);
    const tick = () => (p as unknown as { tick(): void }).tick();
    /** Run the clock forward to `to` seconds in 0.1 s steps, scheduling as the timer would. */
    const run = (to: number) => { while (ctx.currentTime < to - 1e-9) { ctx.currentTime = Math.min(to, ctx.currentTime + 0.1); tick(); } };
    return { ctx, p, hits, tick, run, tl };
  }

  it('hits land on the beat grid at the tempo, and start on the downbeat of bar 1', async () => {
    const { p, hits, run } = setup();
    p.setBpm(120);
    await p.play();
    run(3);
    expect(hits[0].q).toBe(0);
    expect(hits[0].when).toBeCloseTo(0.06, 3);
    for (const h of hits) expect(h.when).toBeCloseTo(0.06 + (h.q * 60) / 120, 3);
    expect(hits.at(-1)!.q).toBeGreaterThan(5);
    p.dispose();
  });

  it('waits for the count-in and plays nothing before bar 1', async () => {
    const { p, hits, run } = setup();
    p.setBpm(60);
    p.countIn = true;
    await p.play();
    run(3.7);
    expect(hits).toHaveLength(0);
    run(4.1);
    expect(hits[0].q).toBe(0);
    expect(hits[0].when).toBeCloseTo(4.06, 3);
    p.dispose();
  });

  it('follows a tempo change: the later hits are on the new grid', async () => {
    const { p, hits, run } = setup();
    p.setBpm(60);
    await p.play();
    run(2.06);
    p.setBpm(120);
    hits.length = 0;
    run(3);
    expect(hits.length).toBeGreaterThan(0);
    // position was q=2 at t=2.06; at 120 BPM a hit at q lands at 2.06 + (q-2)/2
    for (const h of hits) expect(h.when).toBeCloseTo(2.06 + (h.q - 2) / 2, 2);
    p.dispose();
  });

  it('seeking moves the drums with the score', async () => {
    const { p, hits, run } = setup();
    p.setBpm(60);
    await p.play();
    hits.length = 0;
    p.seek(3);
    run(0.5);
    expect(hits[0].q).toBe(8); // bar 3 starts at quarter 8
    p.dispose();
  });

  it('a loop brings the groove back to the loop start at every pass, with no gap', async () => {
    const { p, hits, run } = setup();
    p.setBpm(60);
    p.setLoop({ startQ: 4, endQ: 8 });
    await p.play(2);
    run(14);
    const downbeats = [...new Set(hits.filter((h) => h.q === 4).map((h) => Math.round(h.when * 1000) / 1000))];
    expect(downbeats.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < downbeats.length; i++) expect(downbeats[i] - downbeats[i - 1]).toBeCloseTo(4, 2);
    p.dispose();
  });

  it('off means silent but keeps the place', async () => {
    const { p, hits, run } = setup();
    p.setDrumsEnabled(false);
    p.setBpm(60);
    await p.play();
    run(2);
    expect(hits).toHaveLength(0);
    p.setDrumsEnabled(true);
    run(3);
    expect(hits.length).toBeGreaterThan(0);
    expect(Math.min(...hits.map((h) => h.q))).toBeGreaterThan(2);
    p.dispose();
  });
});
