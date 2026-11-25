'use client';
import { useEffect, useRef, useState } from 'react';
import { NextIcon, PauseIcon, PlayIcon, PrevIcon } from './Icons';

interface Props {
  playing: boolean;
  measure: number;
  measureCount: number;
  /** Printed bar label ("Pickup" or a number) and the last printed bar number; default to measure/measureCount. */
  barLabel?: string;
  barTotal?: number;
  /** "Pass 3 · 85 → 120 BPM" while a practice loop is set. */
  passLabel?: string;
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
  const rootRef = useRef<HTMLDivElement>(null);
  // publish the real height so the page can leave room for it (it changes with orientation)
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty('--transport-h', `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); document.documentElement.style.removeProperty('--transport-h'); };
  }, []);

  // press and hold - / + to run through tempos quickly
  const hold = useRef<{ t?: ReturnType<typeof setTimeout>; i?: ReturnType<typeof setInterval> }>({});
  const bpmRef = useRef(p.bpm);
  bpmRef.current = p.bpm;
  const stopHold = () => { clearTimeout(hold.current.t); clearInterval(hold.current.i); hold.current = {}; };
  const startHold = (d: number) => {
    stopHold();
    hold.current.t = setTimeout(() => {
      hold.current.i = setInterval(() => { const v = clampBpm(bpmRef.current + d * 2); if (v !== bpmRef.current) p.onBpm(v); }, 90);
    }, 450);
  };
  useEffect(() => stopHold, []);

  const pickup = p.barLabel === 'Pickup';
  return (
    <div className="transport" role="group" aria-label="Playback controls" ref={rootRef}>
      {p.passLabel && <p className="passline" data-testid="pass-label" role="status">{p.passLabel}</p>}
      <div className="row main">
        <div className="barcount" data-testid="bar-counter" aria-live="off">
          {pickup ? 'Pickup' : `Bar ${p.barLabel ?? p.measure} / ${p.barTotal ?? p.measureCount}`}
        </div>
        <div className="cluster">
          <button type="button" className="tbtn" onClick={p.onPrev} aria-label="Previous bar" disabled={!p.ready}><PrevIcon /></button>
          <button type="button" className="tbtn play" onClick={p.onPlayPause} aria-label={p.playing ? 'Pause' : 'Play'} disabled={!p.ready}>
            {p.playing ? <PauseIcon size={34} /> : <PlayIcon size={34} />}
          </button>
          <button type="button" className="tbtn" onClick={p.onNext} aria-label="Next bar" disabled={!p.ready}><NextIcon /></button>
        </div>
        <button type="button" className="tbtn sm tap" onClick={tap} aria-label="Tap tempo">Tap</button>
      </div>
      <div className="row opts">
        <div className="bpm">
          <button type="button" className="tbtn sm" onClick={() => step(-1)} onPointerDown={() => startHold(-1)} onPointerUp={stopHold} onPointerLeave={stopHold} onPointerCancel={stopHold} aria-label="Slower">−</button>
          <label className="bpmfield">
            <input
              type="number" inputMode="numeric" min={30} max={240} value={draft ?? p.bpm} aria-label="BPM"
              onFocus={(e) => e.target.select()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); } }}
            />
            <span aria-hidden>BPM</span>
          </label>
          <button type="button" className="tbtn sm" onClick={() => step(1)} onPointerDown={() => startHold(1)} onPointerUp={stopHold} onPointerLeave={stopHold} onPointerCancel={stopHold} aria-label="Faster">+</button>
        </div>
        <label className="chk"><input type="checkbox" checked={p.metronome} onChange={(e) => p.onMetronome(e.target.checked)} /> Click</label>
        <label className="chk"><input type="checkbox" checked={p.countIn} onChange={(e) => p.onCountIn(e.target.checked)} /> Count-in</label>
      </div>
    </div>
  );
}
