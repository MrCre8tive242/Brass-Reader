'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DrumBus } from '@/lib/drums';
import { grooveBars, grooveBarHits, type Feel, type Groove, type KitInst } from '@/lib/groove';

const LOOKAHEAD_S = 0.25;
const TICK_MS = 60;

interface Running {
  g: Groove;
  buffer: AudioBuffer | null;
  bpm: number;
  feel?: Feel;
  /** Context time of the start of bar 1 (moved when the tempo changes, so the place in the bar is kept). */
  t0: number;
  /** Everything before this many quarters from `t0` has been handed to the audio clock. */
  doneQ: number;
  /** Context time at which it stops by itself. */
  until: number;
}

/**
 * Hear a groove on its own, on its own channel. It goes round and round until it is stopped (or `maxS` seconds have
 * passed), and it follows changes while it plays: `play` again with an edited pattern or another tempo carries on
 * from the same place in the bar instead of starting over.
 */
export function useGroovePreview(getCtx: () => AudioContext | null, maxS = 45) {
  const bus = useRef<DrumBus | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const run = useRef<Running | null>(null);
  const [playing, setPlaying] = useState(false);

  const stop = useCallback(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    run.current = null;
    bus.current?.stop();
    setPlaying(false);
  }, []);
  useEffect(() => () => { stop(); bus.current?.dispose(); bus.current = null; }, [stop]);

  const getBus = useCallback(() => {
    const ctx = getCtx();
    if (!ctx) return null;
    if (!bus.current) bus.current = new DrumBus(ctx, ctx.destination, '__brPreviewLog');
    return { ctx, bus: bus.current };
  }, [getCtx]);

  const tick = useCallback(() => {
    const r = run.current, b = getBus();
    if (!r || !b) return;
    const now = b.ctx.currentTime;
    if (now >= r.until) { stop(); return; }
    const spq = 60 / r.bpm, bars = grooveBars(r.g);
    const endQ = (Math.min(now + LOOKAHEAD_S, r.until) - r.t0) / spq;
    b.bus.source = { groove: r.g, buffer: r.buffer };
    for (let bar = Math.max(0, Math.floor(r.doneQ / 4)); bar * 4 < endQ; bar++) {
      for (const h of grooveBarHits(r.g, ((bar % bars) + bars) % bars, r.feel)) {
        const q = bar * 4 + h.timeQ;
        if (q < r.doneQ - 1e-9 || q >= endQ) continue;
        b.bus.hit(h, Math.max(now, r.t0 + q * spq), spq, r.bpm, q);
      }
    }
    r.doneQ = endQ;
  }, [getBus, stop]);

  const play = useCallback((g: Groove, buffer: AudioBuffer | null, bpm: number, feel?: Feel) => {
    const b = getBus();
    if (!b || !(bpm > 0)) return;
    void b.ctx.resume?.();
    const now = b.ctx.currentTime;
    let r = run.current;
    // another groove: start it from the top
    if (r && r.g.id !== g.id) { b.bus.stop(); run.current = null; r = null; if (timer.current) { clearInterval(timer.current); timer.current = null; } }
    if (r) {
      // already going: take the changes in from here on, without losing the place
      const posQ = ((now - r.t0) * r.bpm) / 60;
      const aheadQ = r.doneQ - posQ; // what is already on its way keeps its old timing
      run.current = { ...r, g, buffer, bpm, feel, t0: now - (posQ * 60) / bpm, doneQ: posQ + (aheadQ * bpm) / r.bpm };
      return;
    }
    run.current = { g, buffer, bpm, feel, t0: now + 0.1, doneQ: 0, until: now + 0.1 + maxS };
    setPlaying(true);
    tick();
    timer.current = setInterval(tick, TICK_MS);
  }, [getBus, tick, maxS]);

  /** One kit sound, now (what a step will sound like when it is tapped in). */
  const tap = useCallback((inst: KitInst, vel: number) => {
    const b = getBus();
    if (!b) return;
    void b.ctx.resume?.();
    b.bus.tap(inst, vel);
  }, [getBus]);

  /** Where in the groove the sound is now, in quarters from the start of bar 1 of the loop; null when it is not playing. */
  const position = useCallback((): number | null => {
    const r = run.current, ctx = getCtx();
    if (!r || !ctx) return null;
    const late = (Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0) + (Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0);
    const q = ((ctx.currentTime - late - r.t0) * r.bpm) / 60;
    if (q < 0) return null;
    const len = grooveBars(r.g) * 4;
    return q % len;
  }, [getCtx]);

  return { playing, play, stop, tap, position };
}
