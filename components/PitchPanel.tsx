'use client';
import { useEffect, useRef, useState } from 'react';
import type { Player } from '@/lib/player';
import type { MicSession } from '@/lib/micSession';
import type { Mic } from '@/lib/pitchMic';
import { noteLabel, noteName } from '@/lib/pitchMic';
import { MIN_CLARITY, PitchRun, micErrorMessage, summarise, type ExpectedNote, type NoteResult, type RunSummary } from '@/lib/pitch';
import { AlertIcon, MicIcon } from './Icons';

interface Props {
  getPlayer: () => Player | null;
  session: MicSession;
  /** Notes of my part, in time order, at their SOUNDING pitch. */
  notes: ExpectedNote[];
  playing: boolean;
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  /** Verdicts so far, by note index (undefined = not judged yet). */
  onResults: (r: (NoteResult | undefined)[]) => void;
  /** Loop one bar (from the summary). */
  onLoopBar: (measure: number) => void;
  /** Label of my part's sounding instrument for the tip, e.g. "Bb Trumpet". */
  partName: string;
  /** Semitones from the player's written pitch to sounding pitch (-2 on a Bb trumpet): the readout names the WRITTEN note. */
  writtenToConcert: number;
  /** The practice drawer is open: the microphone stays open while it is, or while the music plays. */
  drawerOpen: boolean;
}

const TICK_MS = 30;

export default function PitchPanel({ getPlayer, session, notes, playing, enabled, onEnabled, onResults, onLoopBar, partName, writtenToConcert, drawerOpen }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** "Bb3 +5" as the player reads it (written pitch) and, for a transposing instrument, the note that really sounds. */
  const [heard, setHeard] = useState<{ written: string; concert: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const mic = useRef<Mic | null>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const heardRef = useRef('');
  const shiftRef = useRef(writtenToConcert);
  shiftRef.current = writtenToConcert;
  const cb = useRef({ onResults });
  cb.current = { onResults };

  async function toggle() {
    if (enabled) {
      if (mic.current) session.release();
      mic.current = null; setReady(false);
      onEnabled(false); setHeard(null); heardRef.current = '';
      return;
    }
    const p = getPlayer();
    if (!p) return;
    setBusy(true); setError(null);
    try {
      mic.current = await session.acquire(p.context);
      setReady(true);
      onEnabled(true);
    } catch (e) {
      setError(micErrorMessage(e));
    } finally { setBusy(false); }
  }
  // leaving the page lets go of the microphone
  useEffect(() => () => { if (mic.current) { session.release(); mic.current = null; } }, [session]);

  // the check stays on, but the microphone is only open while the drawer is open or the music plays
  const wantMic = enabled && (playing || drawerOpen);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    if (wantMic && !mic.current) {
      const p = getPlayer();
      if (p) {
        session.acquire(p.context).then((m) => {
          if (cancelled) { session.release(); return; }
          mic.current = m; setReady(true);
        }).catch((e) => { if (!cancelled) { setError(micErrorMessage(e)); onEnabled(false); } });
      }
    } else if (!wantMic && mic.current) {
      session.release(); mic.current = null; setReady(false); setHeard(null); heardRef.current = '';
    }
    return () => { cancelled = true; };
  }, [wantMic, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // listen while the check is on; judge notes while the music plays
  useEffect(() => {
    if (!enabled || !ready) return;
    const run = playing ? new PitchRun(notesRef.current) : null;
    if (run) { setSummary(null); cb.current.onResults([]); }
    const id = setInterval(() => {
      const m = mic.current, p = getPlayer();
      if (!m || !p) return;
      const r = m.read();
      const sh = shiftRef.current;
      const label = r && r.clarity >= MIN_CLARITY ? noteLabel(r.midi - sh) : '';
      if (label !== heardRef.current) {
        heardRef.current = label;
        setHeard(label ? { written: label, concert: sh !== 0 && r ? noteName(r.midi) : '' } : null);
      }
      if (!run) return;
      // what is heard now was played for the moment a little ago: cursor delay + microphone delay
      const q = p.currentQ() - ((p.outputDelay() + m.latencyS) * p.currentBpm) / 60;
      const done = run.push(q, r && r.clarity >= MIN_CLARITY ? { midi: r.midi, clarity: r.clarity } : null);
      if (done.length) cb.current.onResults(run.results.slice());
    }, TICK_MS);
    return () => {
      clearInterval(id);
      if (run) {
        run.finish();
        cb.current.onResults(run.results.slice());
        setSummary(summarise(run.notes, run.results));
      }
    };
  }, [enabled, ready, playing, getPlayer]);

  return (
    <div className="pitchpanel">
      <p className="muted small tip">
        <strong>Headphones work best.</strong> The microphone listens to {partName} while the music plays; with a speaker it can also hear the backing.
        Your own part is muted while the check is on, so only the other parts (and the click) play. The microphone is only open while the music plays or this drawer is open.
      </p>
      {error && <p className="error" role="alert"><AlertIcon size={18} /> {error}</p>}
      <div className="prow">
        <button type="button" className={`btn sm${enabled ? ' on' : ''}`} onClick={toggle} disabled={busy} aria-pressed={enabled}>
          <MicIcon size={20} /> {enabled ? 'Stop pitch check' : busy ? 'Starting…' : 'Start pitch check'}
        </button>
        {enabled && (
          <span className="heard" data-testid="pitch-heard" aria-live="off">
            {!ready ? 'Microphone closed' : heard ? <>Hearing {heard.written}{heard.concert && <small className="concert"> (sounds {heard.concert})</small>}</> : 'Listening…'}
          </span>
        )}
      </div>
      {enabled && !playing && !summary && <p className="muted small">Press Play and play your part. Green = in tune, yellow = a little sharp or flat, red = wrong note or missed.</p>}
      {summary && (
        <div className="psummary" data-testid="pitch-summary" role="status">
          {summary.pct === null
            ? <p>No notes were judged. Play a few bars with the check on.</p>
            : (
              <>
                <p><strong data-testid="pitch-pct">{summary.pct}%</strong> of notes in tune <span className="muted small">({summary.green} green, {summary.yellow} yellow, {summary.red} red)</span></p>
                {summary.worstBars.length > 0 && (
                  <div className="prow">
                    <span className="muted small">Most misses:</span>
                    {summary.worstBars.map((b) => (
                      <button key={b.measure} type="button" className="btn sm ghost" onClick={() => onLoopBar(b.measure)} data-testid="worst-bar">
                        Bar {b.measure} · {b.misses} of {b.notes}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
        </div>
      )}
    </div>
  );
}
