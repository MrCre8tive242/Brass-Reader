'use client';
import { useEffect, useState } from 'react';

interface Props { value: number; label: string; min: number; max: number; onCommit: (n: number) => void; /** Allow one decimal place (tempo). */ decimal?: boolean }

/** A number box that lets you type freely and applies the value (kept between min and max) on blur or Enter. */
export default function NumField({ value, label, min, max, onCommit, decimal }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (draft.trim() === '' || !Number.isFinite(n)) return;
    const v = Math.max(min, Math.min(max, decimal ? Math.round(n * 10) / 10 : Math.round(n)));
    if (v !== value) onCommit(v);
  };
  return (
    <input
      type="number" inputMode={decimal ? 'decimal' : 'numeric'} step={decimal ? 0.1 : 1} className="num" aria-label={label} min={min} max={max} value={draft ?? value}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); } }}
    />
  );
}
