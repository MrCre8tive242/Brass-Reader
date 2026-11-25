'use client';

interface Props {
  onOpenStudio: () => void;
}

/** The "Drums" section of the practice drawer. */
export default function DrumsPanel({ onOpenStudio }: Props) {
  return (
    <div className="drumspanel">
      <p className="muted small">Record your own drummers and keep their grooves on this device.</p>
      <div className="prow">
        <button type="button" className="btn sm primary" onClick={onOpenStudio}>Grooves…</button>
      </div>
    </div>
  );
}
