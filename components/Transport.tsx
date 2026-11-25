'use client';
import { useRef } from 'react';

interface Props {
  playing: boolean;
  measure: number;
  measureCount: number;
  bpm: number;
  metronome: boolean;
  countIn: boolean;
  ready: boolean;
  onPlayPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  onBpm: (n: number) => void;
  onMetronome: (v: boolean) => void;
  onCountIn: (v: boolean) => void;
}

const clampBpm = (n: number) => Math.max(30, Math.min(240, Math.round(n)));

export default function Transport(p: Props) {
  const taps = useRef<number[]>([]);
  const tap = () => {
    const now = performance.now();
    const t = taps.current.filter((x) => now - x < 2500);
    t.push(now);
    taps.current = t;
    if (t.length >= 2) {
      const avg = (t[t.length - 1] - t[0]) / (t.length - 1);
      p.onBpm(clampBpm(60000 / avg));
    }
  };
  return (
    <div className="transport" role="group" aria-label="Playback controls">
      <div className="row main">
        <button type="button" className="tbtn" onClick={p.onPrev} aria-label="Previous bar" disabled={!p.ready}>⏮</button>
        <button type="button" className="tbtn play" onClick={p.onPlayPause} aria-label={p.playing ? 'Pause' : 'Play'} disabled={!p.ready}>
          {p.playing ? '⏸' : '▶'}
        </button>
        <button type="button" className="tbtn" onClick={p.onNext} aria-label="Next bar" disabled={!p.ready}>⏭</button>
        <div className="barcount" data-testid="bar-counter" aria-live="off">Bar {p.measure} / {p.measureCount}</div>
      </div>
      <div className="row opts">
        <div className="bpm">
          <button type="button" className="tbtn sm" onClick={() => p.onBpm(clampBpm(p.bpm - 1))} aria-label="Slower">−</button>
          <input
            type="number" inputMode="numeric" min={30} max={240} value={p.bpm} aria-label="BPM"
            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0) p.onBpm(clampBpm(n)); }}
          />
          <button type="button" className="tbtn sm" onClick={() => p.onBpm(clampBpm(p.bpm + 1))} aria-label="Faster">+</button>
          <button type="button" className="tbtn sm tap" onClick={tap}>Tap</button>
        </div>
        <label className="chk"><input type="checkbox" checked={p.metronome} onChange={(e) => p.onMetronome(e.target.checked)} /> Click</label>
        <label className="chk"><input type="checkbox" checked={p.countIn} onChange={(e) => p.onCountIn(e.target.checked)} /> Count-in</label>
      </div>
    </div>
  );
}
