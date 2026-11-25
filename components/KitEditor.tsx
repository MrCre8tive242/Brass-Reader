'use client';
import { useEffect, useRef, useState } from 'react';
import { KIT_INSTS, STARTERS, STARTER_LABEL, emptyPattern, resizePattern, type Feel, type Groove, type KitInst, type KitPattern } from '@/lib/groove';
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

function Cell({ label, value, beatStart, onSet }: { label: string; value: number; beatStart: boolean; onSet: (v: number) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const long = useRef(false);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  return (
    <button
      type="button"
      className={`cell v${value}${beatStart ? ' beat' : ''}`}
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
        onSet(e.detail === 0 && e.shiftKey ? 3 : value > 0 ? 0 : 2);
      }}
      onKeyDown={(e) => { if (e.key === 'a') onSet(value === 3 ? 2 : 3); else if (e.key === 's') onSet(value === 1 ? 0 : 1); }}
    />
  );
}

/** The step-grid editor for the starter kit: one row per instrument, tap a step to switch it, press and hold for an accent. */
export default function KitEditor({ getCtx, existing, from, onSave, onCancel }: Props) {
  const [pattern, setPattern] = useState<KitPattern>(existing?.pattern ?? from?.pattern ?? emptyPattern(16, 1));
  const [name, setName] = useState(existing?.name ?? (from ? `My ${from.name}` : 'My step pattern'));
  const [feel, setFeel] = useState<Feel>(existing?.feel ?? 'straight');
  const [bpm, setBpm] = useState(110);
  const [starter, setStarter] = useState(!!from?.starter);
  const preview = useGroovePreview(getCtx);

  const groove: Groove = { id: existing?.id ?? 'preview', name, kind: 'kit', createdAt: existing?.createdAt ?? Date.now(), feel, pattern };
  const playing = preview.playing;
  const play = () => preview.play(groove, null, bpm, feel);
  // keep what is heard in step with what is on screen
  const sig = JSON.stringify([pattern, feel, bpm]);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } if (playing) play(); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (inst: KitInst, i: number, v: number) => setPattern((p) => ({ ...p, tracks: { ...p.tracks, [inst]: p.tracks[inst].map((x, k) => (k === i ? v : x)) } }));
  const perRow = pattern.steps === 16 ? 8 : 6;

  return (
    <div className="kit" data-testid="kit-editor">
      {starter && <p className="starter-note" data-testid="starter-label">{STARTER_LABEL}</p>}
      <div className="prow" role="group" aria-label="Steps per bar">
        <span className="plabel">Steps per bar</span>
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
      <p className="muted small">Tap a step to switch it on or off. Press and hold for an accent (tap again off, hold again for normal).</p>
      {Array.from({ length: pattern.bars }, (_, b) => (
        <div key={b} className="kitbar" data-testid="kit-bar">
          {pattern.bars > 1 && <h3 className="kitbar-h">Bar {b + 1}</h3>}
          {KIT_INSTS.map((k) => (
            <div key={k.id} className="kitrow" role="group" aria-label={`${k.label}${pattern.bars > 1 ? `, bar ${b + 1}` : ''}`}>
              <span className="kitlabel">{k.label}</span>
              <div className="cells" style={{ gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` }}>
                {Array.from({ length: pattern.steps }, (_, i) => {
                  const idx = b * pattern.steps + i;
                  const per = pattern.steps === 16 ? 4 : 3;
                  return <Cell key={i} label={`${k.label}${pattern.bars > 1 ? ` bar ${b + 1}` : ''} step ${i + 1}`} value={pattern.tracks[k.id][idx]} beatStart={i % per === 0} onSet={(v) => set(k.id, idx, v)} />;
                })}
              </div>
            </div>
          ))}
        </div>
      ))}
      <div className="prow">
        <span className="plabel">Tempo</span>
        <NumField value={bpm} label="Preview tempo BPM" min={40} max={240} onCommit={setBpm} />
        <button type="button" className="btn" onClick={() => (playing ? preview.stop() : play())} aria-label={playing ? 'Stop the pattern' : 'Hear the pattern'}>{playing ? 'Stop' : 'Hear the pattern'}</button>
        <button type="button" className="btn ghost sm" onClick={() => setPattern((p) => emptyPattern(p.steps, p.bars))}>Clear all</button>
      </div>
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
