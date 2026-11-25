'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DrumBus } from '@/lib/drums';
import { grooveBars, grooveBarHits, type Feel, type Groove } from '@/lib/groove';

/** Hear a groove on its own: loops it a few times at a tempo, on its own channel. */
export function useGroovePreview(getCtx: () => AudioContext | null) {
  const bus = useRef<DrumBus | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [playing, setPlaying] = useState(false);

  const stop = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    bus.current?.stop();
    setPlaying(false);
  }, []);
  useEffect(() => () => { stop(); bus.current?.dispose(); bus.current = null; }, [stop]);

  const play = useCallback((g: Groove, buffer: AudioBuffer | null, bpm: number, feel?: Feel) => {
    const ctx = getCtx();
    if (!ctx) return;
    stop();
    void ctx.resume?.();
    if (!bus.current) bus.current = new DrumBus(ctx, ctx.destination);
    const b = bus.current;
    b.source = { groove: g, buffer };
    const spq = 60 / bpm;
    const bars = grooveBars(g);
    const cycles = Math.max(2, Math.ceil(10 / (bars * 4 * spq)));
    const t0 = ctx.currentTime + 0.1;
    for (let c = 0; c < cycles; c++) {
      for (let bar = 0; bar < bars; bar++) {
        for (const h of grooveBarHits(g, bar, feel)) {
          const q = (c * bars + bar) * 4 + h.timeQ;
          b.hit(h, t0 + q * spq, spq, bpm, q);
        }
      }
    }
    setPlaying(true);
    timer.current = setTimeout(() => { setPlaying(false); timer.current = null; }, (cycles * bars * 4 * spq + 0.6) * 1000);
  }, [getCtx, stop]);

  return { playing, play, stop };
}
