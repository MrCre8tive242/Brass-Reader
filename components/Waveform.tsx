'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  samples: Float32Array;
  rate: number;
  onsets: number[];
  downbeatS: number;
  /** Length of the chosen loop and of one bar, seconds (for the shading and bar lines). */
  loopS: number;
  barS: number;
  onDownbeat: (s: number) => void;
}

const H = 120;

/** The recording as a picture, with the hits marked and a downbeat marker you drag (it snaps to a nearby hit). */
export default function Waveform({ samples, rate, onsets, downbeatS, loopS, barS, onDownbeat }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(320);
  const dur = samples.length / rate;
  const drag = useRef(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(120, Math.floor(el.clientWidth))));
    ro.observe(el);
    setW(Math.max(120, Math.floor(el.clientWidth)));
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = w * dpr; c.height = H * dpr;
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(c);
    const col = (n: string, fb: string) => css.getPropertyValue(n).trim() || fb;
    g.clearRect(0, 0, w, H);
    const x = (t: number) => (t / dur) * w;
    // the loop
    g.fillStyle = col('--accent', '#e0a030') + '26';
    g.fillRect(x(downbeatS), 0, Math.max(1, x(Math.min(dur, downbeatS + loopS)) - x(downbeatS)), H);
    // the wave
    g.fillStyle = col('--muted', '#8a8f99');
    const per = samples.length / w;
    for (let i = 0; i < w; i++) {
      let lo = 0, hi = 0;
      const a = Math.floor(i * per), b = Math.min(samples.length, Math.floor((i + 1) * per) + 1);
      for (let k = a; k < b; k += Math.max(1, Math.floor((b - a) / 40))) { const v = samples[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
      const top = H / 2 - hi * (H / 2 - 4), bot = H / 2 - lo * (H / 2 - 4);
      g.fillRect(i, top, 1, Math.max(1, bot - top));
    }
    // hits
    g.fillStyle = col('--text', '#ddd');
    for (const t of onsets) g.fillRect(Math.round(x(t)), H - 10, 1, 10);
    // bar lines
    g.strokeStyle = col('--accent', '#e0a030');
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    for (let t = downbeatS + barS; t < Math.min(dur, downbeatS + loopS) - 1e-6; t += barS) { g.beginPath(); g.moveTo(x(t) + 0.5, 0); g.lineTo(x(t) + 0.5, H); g.stroke(); }
    g.setLineDash([]);
    // the downbeat marker
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(x(downbeatS), 0); g.lineTo(x(downbeatS), H); g.stroke();
    g.fillStyle = col('--accent', '#e0a030');
    g.beginPath(); g.moveTo(x(downbeatS) - 9, 0); g.lineTo(x(downbeatS) + 9, 0); g.lineTo(x(downbeatS), 14); g.fill();
  }, [samples, rate, onsets, downbeatS, loopS, barS, w, dur]);

  const at = useCallback((e: React.PointerEvent) => {
    const r = cv.current!.getBoundingClientRect();
    let t = ((e.clientX - r.left) / r.width) * dur;
    t = Math.max(0, Math.min(dur, t));
    return t;
  }, [dur]);
  const snap = (t: number) => {
    let best = t, d = 0.025;
    for (const o of onsets) if (Math.abs(o - t) < d) { d = Math.abs(o - t); best = o; }
    return best;
  };

  return (
    <div ref={box} className="wave" data-testid="waveform">
      <canvas
        ref={cv} style={{ width: '100%', height: H, touchAction: 'none' }} role="img"
        aria-label={`Recording, ${dur.toFixed(1)} seconds. The downbeat marker is at ${downbeatS.toFixed(2)} seconds.`}
        onPointerDown={(e) => { drag.current = true; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); onDownbeat(at(e)); }}
        onPointerMove={(e) => { if (drag.current) onDownbeat(at(e)); }}
        onPointerUp={(e) => { if (drag.current) { drag.current = false; onDownbeat(snap(at(e))); } }}
        onPointerCancel={() => { drag.current = false; }}
      />
    </div>
  );
}
