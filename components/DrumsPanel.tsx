'use client';
import { STARTER_LABEL, type Feel, type Groove } from '@/lib/groove';
import { feelFor, type DrumSettings } from '@/lib/drumSettings';

interface Props {
  settings: DrumSettings;
  grooves: Groove[];
  /** Why the recording of the chosen groove is not ready (loading or failed). */
  status: string | null;
  onChange: (patch: Partial<DrumSettings>) => void;
  onOpenStudio: () => void;
}

/** The "Drums" section of the practice drawer: pick a groove and set how it plays under this score. */
export default function DrumsPanel({ settings, grooves, status, onChange, onOpenStudio }: Props) {
  const g = grooves.find((x) => x.id === settings.grooveId);
  const mine = grooves.filter((x) => !x.starter);
  const starters = grooves.filter((x) => x.starter);
  return (
    <div className="drumspanel">
      <label className="field">
        <span className="plabel">Groove</span>
        <select className="sel txt" aria-label="Groove" value={g ? g.id : ''} onChange={(e) => onChange({ grooveId: e.target.value || null })}>
          <option value="">None</option>
          {mine.length > 0 && <optgroup label="Your grooves">{mine.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>}
          <optgroup label="Starter patterns">{starters.map((x) => <option key={x.id} value={x.id}>{x.name} (starter, not traditional)</option>)}</optgroup>
        </select>
      </label>
      {g?.starter && <p className="starter-note" data-testid="drums-starter-label">{STARTER_LABEL}</p>}
      {status && <p className="muted small" role="status" data-testid="drums-status">{status}</p>}
      <label className="chk wide">
        <input type="checkbox" checked={settings.on} onChange={(e) => onChange({ on: e.target.checked })} aria-label="Drums on" /> Drums on
      </label>
      <div className="prow">
        <label className="plabel" htmlFor="drumvol">Drums volume</label>
        <input id="drumvol" type="range" min={0} max={100} value={Math.round(settings.volume * 100)} className="grow" aria-label="Drums volume" onChange={(e) => onChange({ volume: Number(e.target.value) / 100 })} />
      </div>
      {g?.kind === 'kit' && g.pattern?.steps === 16 && (
        <div className="prow" role="group" aria-label="Drum feel">
          <span className="plabel">Feel</span>
          {(['straight', 'triplet'] as Feel[]).map((f) => (
            <button key={f} type="button" className={`btn sm${feelFor(settings, g) === f ? ' on' : ''}`} aria-pressed={feelFor(settings, g) === f} onClick={() => onChange({ feel: f })}>{f === 'straight' ? 'Straight' : 'Triplet'}</button>
          ))}
        </div>
      )}
      {g?.kind === 'recorded' && <p className="muted small">Recorded at {Math.round((g.bpm ?? 0) * 10) / 10} BPM. At other tempos each hit is played again on the beat grid, so the sound stays real.</p>}
      <label className="chk wide">
        <input type="checkbox" checked={settings.inTakes} onChange={(e) => onChange({ inTakes: e.target.checked })} aria-label="Drums while recording" /> Keep the drums while recording and in take replays
      </label>
      <label className="chk wide">
        <input type="checkbox" checked={settings.inMidi} onChange={(e) => onChange({ inMidi: e.target.checked })} aria-label="Drum track in MIDI" /> Add a drum track to the MIDI download
      </label>
      <div className="prow">
        <button type="button" className="btn sm primary" onClick={onOpenStudio}>Grooves…</button>
      </div>
      <p className="muted small">The drums start on beat one of bar one (after the count-in) and follow the tempo, seeking and the loop. They are never part of the pitch check or Mute my part.</p>
    </div>
  );
}
