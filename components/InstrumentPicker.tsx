'use client';
import { INSTRUMENT_IDS, INSTRUMENTS, type InstrumentId } from '@/lib/instruments';

interface Props {
  source: InstrumentId;
  target: InstrumentId;
  onSource: (id: InstrumentId) => void;
  onTarget: (id: InstrumentId) => void;
  /** Small note under the pickers, e.g. what the source instrument was detected from. */
  hint?: string;
}

export default function InstrumentPicker({ source, target, onSource, onTarget, hint }: Props) {
  return (
    <>
    <div className="picker">
      <label>
        <span>Written for</span>
        <select value={source} onChange={(e) => onSource(e.target.value as InstrumentId)} aria-label="Written for">
          {INSTRUMENT_IDS.map((id) => <option key={id} value={id}>{INSTRUMENTS[id].name}</option>)}
        </select>
      </label>
      <label>
        <span>Play as</span>
        <select value={target} onChange={(e) => onTarget(e.target.value as InstrumentId)} aria-label="Play as">
          {INSTRUMENT_IDS.map((id) => <option key={id} value={id}>{INSTRUMENTS[id].name}</option>)}
        </select>
      </label>
    </div>
    {hint && <p className="muted small picker-hint" data-testid="source-hint">{hint}</p>}
    </>
  );
}
