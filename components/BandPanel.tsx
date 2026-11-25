'use client';
import Link from 'next/link';
import { INSTRUMENT_IDS, INSTRUMENTS, type InstrumentId } from '@/lib/instruments';
import { DEFAULT_MIX, type MixState } from '@/lib/mixer';
import type { SongPart } from '@/lib/song';
import { AlertIcon } from './Icons';

interface Props {
  parts: SongPart[];
  myIdx: number;
  mix: Record<string, MixState>;
  full: boolean;
  scoreId: string;
  warnings: string[];
  onMix: (partId: string, patch: Partial<MixState>) => void;
  onMy: (index: number) => void;
  onFull: (v: boolean) => void;
  onInstrument: (index: number, id: InstrumentId) => void;
}

export default function BandPanel({ parts, myIdx, mix, full, scoreId, warnings, onMix, onMy, onFull, onInstrument }: Props) {
  const many = parts.length > 1;
  return (
    <div className="band">
      {warnings.map((w, i) => <p key={i} className="warnline" role="status" data-testid="align-warning"><AlertIcon size={18} /> {w}</p>)}
      {many && (
        <label className="chk wide">
          <input type="checkbox" checked={full} onChange={(e) => onFull(e.target.checked)} aria-label="Show full score" /> Show full score (all staves stacked)
        </label>
      )}
      <ul className="mixer">
        {parts.map((p, i) => {
          const m = mix[p.id] ?? DEFAULT_MIX;
          return (
            <li key={p.id} className={`mixrow${i === myIdx ? ' mine' : ''}`} data-testid="mix-row">
              <div className="mixname">
                <strong>{p.name}</strong>
                {i === myIdx ? <span className="badge">my part</span> : many && <button type="button" className="linkbtn" onClick={() => onMy(i)}>make this my part</button>}
              </div>
              <select className="sel" value={p.instrument} aria-label={`Instrument for ${p.name}`} onChange={(e) => onInstrument(i, e.target.value as InstrumentId)}>
                {INSTRUMENT_IDS.map((id) => <option key={id} value={id}>{INSTRUMENTS[id].name}</option>)}
              </select>
              <div className="mixctl">
                <button type="button" className={`tbtn sm${m.mute ? ' on' : ''}`} aria-pressed={m.mute} aria-label={`Mute ${p.name}`} onClick={() => onMix(p.id, { mute: !m.mute })}>M</button>
                <button type="button" className={`tbtn sm${m.solo ? ' on' : ''}`} aria-pressed={m.solo} aria-label={`Solo ${p.name}`} onClick={() => onMix(p.id, { solo: !m.solo })}>S</button>
                <input type="range" min={0} max={100} value={Math.round(m.volume * 100)} aria-label={`Volume ${p.name}`} onChange={(e) => onMix(p.id, { volume: Number(e.target.value) / 100 })} />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="prow">
        <Link href={`/?addTo=${encodeURIComponent(scoreId)}`} className="btn sm">Add a part (scan or MusicXML)</Link>
      </p>
      <p className="muted small">Scan another instrument&apos;s sheet, or open a MusicXML file with several parts, and it joins this song. Parts line up by bar; a shorter part gets rests at the end.</p>
    </div>
  );
}
