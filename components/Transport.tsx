'use client';
import { useRef, useState } from 'react';

interface Props {
  playing: boolean;
  measure: number;
  measureCount: number;
  /** Printed bar label ("Pickup" or a number) and the last printed bar number; default to measure/measureCount. */
  barLabel?: string;
  barTotal?: number;
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
  // free typing: the field keeps its own text; the value is clamped to 30-240 on blur / Enter only
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return p.bpm;
    const n = Number(draft);
    setDraft(null);
    if (draft.trim() === '' || !Number.isFinite(n)) return p.bpm;
    const v = clampBpm(n);
    if (v !== p.bpm) p.onBpm(v);
    return v;
  };
  const step = (d: number) => { const base = commit(); p.onBpm(clampBpm(base + d)); };
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
        <div className="barcount" data-testid="bar-counter" aria-live="off">
          {p.barLabel === 'Pickup' ? 'Pickup' : `Bar ${p.barLabel ?? p.measure} / ${p.barTotal ?? p.measureCount}`}
        </div>
      </div>
      <div className="row opts">
        <div className="bpm">
          <button type="button" className="tbtn sm" onClick={() => step(-1)} aria-label="Slower">−</button>
          <input
            type="number" inputMode="numeric" min={30} max={240} value={draft ?? p.bpm} aria-label="BPM"
            onFocus={(e) => e.target.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); } }}
          />
          <button type="button" className="tbtn sm" onClick={() => step(1)} aria-label="Faster">+</button>
          <button type="button" className="tbtn sm tap" onClick={tap}>Tap</button>
        </div>
        <label className="chk"><input type="checkbox" checked={p.metronome} onChange={(e) => p.onMetronome(e.target.checked)} /> Click</label>
        <label className="chk"><input type="checkbox" checked={p.countIn} onChange={(e) => p.onCountIn(e.target.checked)} /> Count-in</label>
      </div>
    </div>
  );
}
