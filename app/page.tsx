'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { deleteScore, listScores, type SavedScore } from '@/lib/library';
import { lastPracticedId, practiceBar, PRACTICE_SAMPLE_ID } from '@/lib/practiceProgress';
import { INSTRUMENTS } from '@/lib/instruments';
import Uploader from '@/components/Uploader';
import { BrandMark, ChevronIcon, MusicIcon, LibraryIcon, PlayIcon, TrashIcon } from '@/components/Icons';

function when(ts: number): string {
  const d = new Date(ts);
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days < 1 && new Date().getDate() === d.getDate()) return 'today';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function Home() {
  const [scores, setScores] = useState<SavedScore[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [addTo, setAddTo] = useState<string | undefined>(undefined);
  const [lastPlayed, setLastPlayed] = useState<string | null>(null);
  useEffect(() => { try { setAddTo(new URLSearchParams(window.location.search).get('addTo') ?? undefined); } catch { /* ignore */ } }, []);
  const refresh = () => listScores().then((s) => { setScores(s); setLastPlayed(lastPracticedId()); setFailed(false); }).catch(() => { setScores([]); setFailed(true); });
  useEffect(() => { refresh(); }, []);
  const resume = scores?.find((s) => s.id === lastPlayed);

  return (
    <main className="page home">
      <header className="library-header">
        <div className="brand-lockup"><BrandMark size={38} /><h1 className="brand">Brass Reader</h1></div>
        <a className="library-shortcut" href="#your-music"><LibraryIcon size={18} /> Your music</a>
      </header>

      {!addTo && (
        <section className="sample-cover" aria-labelledby="sample-title">
          <div className="cover-copy">
            <p className="cover-meta">Trumpet <span>·</span> 8 bars <span>·</span> 76 BPM</p>
            <h2 id="sample-title">Bay Street<br /><em>Warm-Up</em></h2>
            <p className="cover-description">Play along with fingerings and a Junkanoo drum groove.</p>
            <Link href={`/score/${PRACTICE_SAMPLE_ID}`} className="btn cover-play"><PlayIcon size={16} /> Try a sample</Link>
          </div>
        </section>
      )}

      {!addTo && resume && (
        <Link href={`/score/${resume.id}?resume=1`} className="libitem continue-practice">
          <span className="score-icon"><PlayIcon size={17} /></span>
          <span className="libtext">
            <strong>Continue practice</strong>
            <span className="muted small">{resume.title} · {practiceBar(resume.id)}</span>
          </span>
          <ChevronIcon size={20} className="chev" />
        </Link>
      )}

      <div className="home-grid">
        <section className="home-card import-card" aria-labelledby="add-title">
          <h2 className="sec" id="add-title">Add music</h2>
          <p className="section-intro">Scan a sheet or import a file to practice on five brass instruments.</p>
          <Uploader addTo={addTo} />
        </section>

        <section className="home-card collection-card" id="your-music" aria-labelledby="collection-title">
          <h2 className="sec" id="collection-title">Your music</h2>
          <p className="section-intro">Scores saved on this device.</p>
          {scores === null && <p className="muted loading-line"><span className="spinner" aria-hidden /> Loading your music…</p>}
          {failed && <p className="error" role="alert">This browser is not letting the app save music (private browsing can do that). You can still scan and play, but scores will not be kept.</p>}
          {scores?.length === 0 && !failed && (
            <div className="empty" data-testid="empty-library">
              <span className="empty-icon"><MusicIcon size={26} /></span>
              <strong>No scores yet.</strong>
              <p className="muted small">Your first score will appear here after you open it.</p>
            </div>
          )}
          <ul className="library">
            {scores?.map((s) => (
              <li key={s.id}>
                <Link href={`/score/${s.id}`} className="libitem">
                  <span className="score-icon"><MusicIcon size={20} /></span>
                  <span className="libtext">
                    <strong>{s.title}</strong>
                    <span className="muted small">{INSTRUMENTS[s.sourceInstrument]?.name ?? 'Score'} · {s.origin === 'musicxml' ? 'file' : 'scan'} · {when(s.createdAt)}</span>
                  </span>
                  <ChevronIcon size={20} className="chev" />
                </Link>
                {confirm === s.id ? (
                  <span className="confirm" role="group" aria-label={`Delete ${s.title}?`}>
                    <button type="button" className="btn danger" onClick={async () => { await deleteScore(s.id); setConfirm(null); refresh(); }}>Delete</button>
                    <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>Keep</button>
                  </span>
                ) : (
                  <button type="button" className="iconbtn" aria-label={`Delete ${s.title}`} onClick={() => setConfirm(s.id)}><TrashIcon size={20} /></button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
