'use client';
import { useEffect, useRef, useState } from 'react';
import { KIT_INSTS, STARTERS, STARTER_LABEL, emptyPattern, resizePattern, stepBeat, type Feel, type Groove, type KitInst, type KitPattern } from '@/lib/groove';
import { newId } from '@/lib/library';
import type { StoredGroove } from '@/lib/grooveStore';
import NumField from './NumField';
import { useGroovePreview } from './useGroovePreview';

interface Props {
  getCtx: () => AudioContext | null;
  /** Groove being edited (a saved step pattern); absent for a new one. */
  existing?: StoredGroove;
  /** Pattern to start from (a starter, copied). */
  from?: { name: string; pattern: KitPattern; starter: boolean };
  onSave: (g: StoredGroove) => void;
  onCancel: () => void;
}

const LONG_PRESS_MS = 450;
const STATE_WORD = ['empty', 'soft', 'on', 'accent'];

function Cell({ label, value, beatNo, brush, now, onSet }: { label: string; value: number; /** The pattern is playing and is on this step. */ now: boolean; /** 1-based beat number on the first step of every beat. */ beatNo: number | null; brush: number; onSet: (v: number) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const long = useRef(false);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  return (
    <button
      type="button"
      className={`cell v${value}${beatNo ? ' beat' : ''}${now ? ' now' : ''}`}
      aria-label={`${label}: ${STATE_WORD[value]}`}
      aria-pressed={value > 0}
      data-v={value}
      onPointerDown={() => { long.current = false; clear(); timer.current = setTimeout(() => { long.current = true; onSet(value === 3 ? 2 : 3); }, LONG_PRESS_MS); }}
      onPointerUp={clear}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        if (long.current) { long.current = false; return; }
        // keyboard: Enter/Space toggle; with Shift, an accent
        onSet(e.detail === 0 && e.shiftKey ? 3 : value === brush ? 0 : brush);
      }}
      onKeyDown={(e) => { if (e.key === 'a') onSet(value === 3 ? 2 : 3); else if (e.key === 's') onSet(value === 1 ? 0 : 1); }}
    >
      {beatNo ? <span className="beatno" aria-hidden>{beatNo}</span> : null}
    </button>
  );
}

/** The step-grid editor for the starter kit: one row per instrument, tap a step to switch it, press and hold for an accent. */
export default function KitEditor({ getCtx, existing, from, onSave, onCancel }: Props) {
  const [pattern, setPattern] = useState<KitPattern>(existing?.pattern ?? from?.pattern ?? emptyPattern(16, 1));
  const [name, setName] = useState(existing?.name ?? (from ? `My ${from.name}` : 'My step pattern'));
  const [feel, setFeel] = useState<Feel>(existing?.feel ?? 'straight');
  const [bpm, setBpm] = useState(110);
  const [starter, setStarter] = useState(!!from?.starter);
  /** What a tap puts on a step: soft, normal or accent (press and hold on a step is an accent, too). */
  const [brush, setBrush] = useState(2);
  const preview = useGroovePreview(getCtx, 300);

  const groove: Groove = { id: existing?.id ?? 'preview', name, kind: 'kit', createdAt: existing?.createdAt ?? Date.now(), feel, pattern };
  const playing = preview.playing;
  const play = () => preview.play(groove, null, bpm, feel);
  // keep what is heard in step with what is on screen
  const sig = JSON.stringify([pattern, feel, bpm]);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } if (playing) play(); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  // the step that is sounding, while the pattern plays
  const { position } = preview;
  const [nowStep, setNowStep] = useState(-1);
  const patRef = useRef({ pattern, feel });
  patRef.current = { pattern, feel };
  useEffect(() => {
    if (!playing) { setNowStep(-1); return; }
    let raf = 0;
    const frame = () => {
      const q = position();
      const { pattern: p, feel: f } = patRef.current;
      let step = -1;
      if (q !== null) {
        const bar = Math.floor(q / 4), inBar = q - bar * 4;
        // the last step whose time has come (steps are uneven with a swing)
        let i = 0;
        while (i + 1 < p.steps && stepBeat(i + 1, p.steps, f) <= inBar + 1e-6) i++;
        step = (bar % p.bars) * p.steps + i;
      }
      setNowStep((s) => (s === step ? s : step));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, position]);

  const set = (inst: KitInst, i: number, v: number) => {
    // hear what was just put down (the loop will play it anyway when it is running)
    if (v > 0 && !playing) preview.tap(inst, [0, 0.35, 0.7, 1][v]);
    setPattern((p) => ({ ...p, tracks: { ...p.tracks, [inst]: p.tracks[inst].map((x, k) => (k === i ? v : x)) } }));
  };
  const per = pattern.steps === 16 ? 4 : 3;

  return (
    <div className="kit" data-testid="kit-editor">
      {starter && <p className="starter-note" data-testid="starter-label">{STARTER_LABEL}</p>}
      <div className="kitopts">
        <div className="prow" role="group" aria-label="Steps per bar">
          <span className="plabel">Steps</span>
          <button type="button" className={`btn sm${pattern.steps === 16 ? ' on' : ''}`} aria-pressed={pattern.steps === 16} onClick={() => setPattern((p) => resizePattern(p, 16, p.bars))}>16 (straight)</button>
          <button type="button" className={`btn sm${pattern.steps === 12 ? ' on' : ''}`} aria-pressed={pattern.steps === 12} onClick={() => setPattern((p) => resizePattern(p, 12, p.bars))}>12 (triplet)</button>
        </div>
        <div className="prow" role="group" aria-label="Bars">
          <span className="plabel">Bars</span>
          {([1, 2] as const).map((n) => <button key={n} type="button" className={`btn sm${pattern.bars === n ? ' on' : ''}`} aria-pressed={pattern.bars === n} onClick={() => setPattern((p) => resizePattern(p, p.steps, n))}>{n}</button>)}
        </div>
        {pattern.steps === 16 && (
          <div className="prow" role="group" aria-label="Feel">
            <span className="plabel">Feel</span>
            {(['straight', 'triplet'] as Feel[]).map((f) => <button key={f} type="button" className={`btn sm${feel === f ? ' on' : ''}`} aria-pressed={feel === f} onClick={() => setFeel(f)}>{f === 'straight' ? 'Straight' : 'Triplet swing'}</button>)}
          </div>
        )}
      </div>
      <div className="prow" role="group" aria-label="What a tap puts on a step" data-testid="brush">
        <span className="plabel">A tap is</span>
        {([[1, 'Soft'], [2, 'Normal'], [3, 'Accent']] as const).map(([v, w]) => (
          <button key={v} type="button" className={`btn sm brush${brush === v ? ' on' : ''}`} aria-pressed={brush === v} onClick={() => setBrush(v)}>
            <span className={`swatch v${v}`} aria-hidden /> {w}
          </button>
        ))}
      </div>
      <p className="muted small legend" data-testid="legend">
        <span><span className="swatch v0" aria-hidden /> empty</span> <span><span className="swatch v1" aria-hidden /> soft</span> <span><span className="swatch v2" aria-hidden /> normal</span> <span><span className="swatch v3" aria-hidden /> accent</span>.
        {' '}Tap a step to fill it, again to clear it; hold for an accent. Swipe sideways for the rest of the bar.
      </p>
      <div className="prow sticky-bar top">
        <span className="plabel">Tempo</span>
        <NumField value={bpm} label="Preview tempo BPM" min={40} max={240} onCommit={setBpm} />
        <button type="button" className="btn" onClick={() => (playing ? preview.stop() : play())} aria-label={playing ? 'Stop the pattern' : 'Hear the pattern'}>{playing ? 'Stop' : 'Play'}</button>
        <button type="button" className="btn ghost sm" onClick={() => setPattern((p) => emptyPattern(p.steps, p.bars))}>Clear all</button>
      </div>
      {Array.from({ length: pattern.bars }, (_, b) => (
        <div key={b} className="kitbar" data-testid="kit-bar">
          {pattern.bars > 1 && <h3 className="kitbar-h">Bar {b + 1}</h3>}
          {/* one grid: an instrument per line, a step per column, so you can see how the parts lock together */}
          <div className="kitgrid">
            {KIT_INSTS.map((k) => (
              <div key={k.id} className="kitrow" role="group" aria-label={`${k.label}${pattern.bars > 1 ? `, bar ${b + 1}` : ''}`}>
                <span className="kitlabel">{k.label}</span>
                <div className="cells" style={{ gridTemplateColumns: `repeat(${pattern.steps}, 48px)` }}>
                  {Array.from({ length: pattern.steps }, (_, i) => {
                    const idx = b * pattern.steps + i;
                    return <Cell key={i} label={`${k.label}${pattern.bars > 1 ? ` bar ${b + 1}` : ''} step ${i + 1}`} value={pattern.tracks[k.id][idx]} beatNo={i % per === 0 ? i / per + 1 : null} brush={brush} now={idx === nowStep} onSet={(v) => set(k.id, idx, v)} />;
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <label className="field">
        <span className="plabel">Start from a starter pattern</span>
        <select className="sel txt" aria-label="Start from a starter pattern" value="" onChange={(e) => {
          const s = STARTERS.find((x) => x.id === e.target.value);
          if (s) { setPattern(s.pattern); setName(`My ${s.name}`); setStarter(true); }
        }}>
          <option value="">Choose…</option>
          {STARTERS.map((s) => <option key={s.id} value={s.id}>{s.name} (starter)</option>)}
        </select>
      </label>
      <label className="field">
        <span className="plabel">Name</span>
        <input type="text" className="txt" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="Pattern name" />
      </label>
      <div className="prow">
        <button type="button" className="btn primary" onClick={() => { preview.stop(); onSave({ ...groove, id: existing?.id ?? newId(), name: name.trim() || 'My step pattern', createdAt: existing?.createdAt ?? Date.now() }); }}>Save as my groove</button>
        <button type="button" className="btn ghost" onClick={() => { preview.stop(); onCancel(); }}>{existing ? 'Close' : 'Cancel'}</button>
      </div>
    </div>
  );
}
