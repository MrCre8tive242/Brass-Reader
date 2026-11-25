'use client';
import { normalizeLoop, normalizeTrainer, type LoopRange, type Trainer } from '@/lib/loop';
import NumField from './NumField';

interface Props {
  measureCount: number;
  loop: LoopRange | null;
  /** Last range typed or picked, kept while no loop is set. */
  draft: LoopRange;
  trainer: Trainer;
  onDraft: (r: LoopRange) => void;
  onLoop: (r: LoopRange | null) => void;
  onTrainer: (t: Trainer) => void;
}

export default function LoopPanel({ measureCount, loop, draft, trainer, onDraft, onLoop, onTrainer }: Props) {
  const from = loop?.from ?? draft.from;
  const to = loop?.to ?? draft.to;
  const set = (a: number, b: number) => {
    const n = normalizeLoop({ from: a, to: b }, measureCount);
    if (!n) return;
    onDraft(n);
    if (loop) onLoop(n);
  };
  const t = trainer;
  const upd = (patch: Partial<Trainer>) => onTrainer(normalizeTrainer({ ...t, ...patch }));
  return (
    <div className="looppanel">
      <div className="prow">
        <span className="plabel">Loop bars</span>
        <NumField value={from} label="Loop from bar" min={1} max={measureCount} onCommit={(n) => set(n, Math.max(n, to))} />
        <span aria-hidden>–</span>
        <NumField value={to} label="Loop to bar" min={1} max={measureCount} onCommit={(n) => set(Math.min(from, n), n)} />
        {loop
          ? <button type="button" className="btn sm ghost" onClick={() => onLoop(null)}>Clear loop</button>
          : <button type="button" className="btn sm" onClick={() => onLoop(normalizeLoop({ from, to }, measureCount))}>Loop these bars</button>}
      </div>
      <p className="muted small">Or press and hold a bar on the score (drag with a mouse) to pick the bars. The count-in only plays before the first pass.</p>
      <label className="chk wide">
        <input type="checkbox" checked={t.enabled} onChange={(e) => upd({ enabled: e.target.checked })} aria-label="Speed trainer" /> Speed trainer
      </label>
      {t.enabled && (
        <div className="trainer">
          <label>Start BPM <NumField value={t.start} label="Trainer start BPM" min={30} max={240} onCommit={(n) => upd({ start: n })} /></label>
          <label>Target BPM <NumField value={t.target} label="Trainer target BPM" min={30} max={240} onCommit={(n) => upd({ target: n })} /></label>
          <label>Add BPM <NumField value={t.step} label="Trainer step BPM" min={1} max={60} onCommit={(n) => upd({ step: n })} /></label>
          <label>Every (passes) <NumField value={t.every} label="Trainer every passes" min={1} max={32} onCommit={(n) => upd({ every: n })} /></label>
          {!loop && <p className="muted small">The trainer works while a loop is set.</p>}
        </div>
      )}
    </div>
  );
}
