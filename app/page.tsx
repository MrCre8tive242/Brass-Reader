'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { deleteScore, listScores, type SavedScore } from '@/lib/library';
import { INSTRUMENTS } from '@/lib/instruments';
import Uploader from '@/components/Uploader';

export default function Home() {
  const [scores, setScores] = useState<SavedScore[] | null>(null);
  const refresh = () => listScores().then(setScores).catch(() => setScores([]));
  useEffect(() => { refresh(); }, []);

  return (
    <main className="page">
      <h1 className="brand">Brass Reader</h1>
      <p className="muted">Scan your sheet music, hear it, and play your part on any brass instrument.</p>

      <Uploader />

      <h2>Library</h2>
      {scores === null && <p className="muted">Loading…</p>}
      {scores?.length === 0 && <p className="muted" data-testid="empty-library">No scores yet. Scan music or open a MusicXML file above.</p>}
      <ul className="library">
        {scores?.map((s) => (
          <li key={s.id}>
            <Link href={`/score/${s.id}`} className="libitem">
              <strong>{s.title}</strong>
              <span className="muted small">{INSTRUMENTS[s.sourceInstrument].name} · {new Date(s.createdAt).toLocaleDateString()}</span>
            </Link>
            <button type="button" className="btn ghost" aria-label={`Delete ${s.title}`} onClick={async () => { if (confirm(`Delete "${s.title}"?`)) { await deleteScore(s.id); refresh(); } }}>Delete</button>
          </li>
        ))}
      </ul>
    </main>
  );
}
