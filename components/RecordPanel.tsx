'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Player } from '@/lib/player';
import type { MicSession } from '@/lib/micSession';
import type { Mic } from '@/lib/pitchMic';
import { micErrorMessage } from '@/lib/pitch';
import { MAX_TAKES, deleteTake, listTakes, pickRecorderMime, saveTake, takeExtension, type Take } from '@/lib/takes';
import { newId } from '@/lib/library';
import { AlertIcon, MicIcon } from './Icons';

type Mode = 'you' | 'both' | 'original';

interface Props {
  scoreId: string;
  title: string;
  getPlayer: () => Player | null;
  session: MicSession;
  playing: boolean;
  /** Set the tempo shown in the transport (a take is replayed at the tempo it was made at). */
  onTempo: (bpm: number) => void;
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export default function RecordPanel({ scoreId, title, getPlayer, session, playing, onTempo }: Props) {
  const [armed, setArmed] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [takes, setTakes] = useState<Take[]>([]);
  const [mode, setMode] = useState<Mode>('both');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const mic = useRef<Mic | null>(null);
  const armedRef = useRef(false);
  armedRef.current = armed;
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioUrl = useRef<string | null>(null);

  const refresh = useCallback(() => { listTakes(scoreId).then(setTakes).catch(() => setTakes([])); }, [scoreId]);
  useEffect(refresh, [refresh]);

  async function arm() {
    if (armed) { session.release(); mic.current = null; setArmed(false); return; }
    const p = getPlayer();
    if (!p) return;
    if (typeof MediaRecorder === 'undefined') { setError('This browser cannot record audio.'); return; }
    stopTake();
    setError(null);
    try { mic.current = await session.acquire(p.context); setArmed(true); } catch (e) { setError(micErrorMessage(e)); }
  }
  useEffect(() => () => { if (armedRef.current) session.release(); stopAudio(); }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // record while the music plays: starts with Play (count-in included), stops at Pause or the end
  useEffect(() => {
    const m = mic.current, p = getPlayer();
    if (!armed || !playing || !m || !p) return;
    const mime = pickRecorderMime((t) => MediaRecorder.isTypeSupported(t));
    let rec: MediaRecorder;
    try { rec = new MediaRecorder(m.stream, mime ? { mimeType: mime } : undefined); } catch (e) { setError(micErrorMessage(e)); return; }
    const chunks: Blob[] = [];
    const meta = { startMeasure: p.measure, bpm: p.currentBpm, countIn: p.countIn, offsetS: m.latencyS };
    const t0 = performance.now();
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const durationS = (performance.now() - t0) / 1000;
      setRecording(false);
      if (durationS < 0.4 || !chunks.length) return;
      const type = rec.mimeType || mime || 'audio/webm';
      void saveTake({ id: newId(), scoreId, createdAt: Date.now(), mime: type, blob: new Blob(chunks, { type }), durationS, ...meta })
        .then(setTakes).catch(() => setError('Could not save the take (the browser is not letting the app store it).'));
    };
    rec.start(250);
    setRecording(true);
    return () => { if (rec.state !== 'inactive') rec.stop(); };
  }, [armed, playing, getPlayer, scoreId]);

  function stopAudio() {
    audio.current?.pause();
    audio.current = null;
    if (audioUrl.current) { URL.revokeObjectURL(audioUrl.current); audioUrl.current = null; }
  }
  function stopTake() {
    stopAudio();
    if (playingId) getPlayer()?.pause();
    setPlayingId(null);
  }
  // the music ending (or Pause in the transport) ends a take played with the backing
  useEffect(() => { if (!playing && playingId && mode !== 'you') { stopAudio(); setPlayingId(null); } }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  async function playTake(t: Take) {
    if (playingId === t.id) { stopTake(); return; }
    stopTake();
    const p = getPlayer();
    setError(null);
    if (mode !== 'you' && p) {
      onTempo(t.bpm);
      p.setBpm(t.bpm);
      p.seek(t.startMeasure);
      const wasCount = p.countIn;
      p.countIn = t.countIn;
      await p.play();
      p.countIn = wasCount;
    }
    if (mode !== 'original') {
      const url = URL.createObjectURL(t.blob);
      audioUrl.current = url;
      const a = new Audio(url);
      audio.current = a;
      // the recording lags what was played by the microphone's delay: skip that much so the two line up
      try { a.currentTime = mode === 'both' ? t.offsetS : 0; } catch { /* not seekable yet */ }
      a.onended = () => { setPlayingId(null); if (mode === 'you') stopAudio(); };
      try { await a.play(); } catch { setError('The recording could not be played.'); stopTake(); return; }
    }
    setPlayingId(t.id);
  }

  function download(t: Take, n: number) {
    const url = URL.createObjectURL(t.blob);
    const a = document.createElement('a');
    const base = (title || 'score').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'score';
    a.href = url; a.download = `${base}-take-${n}.${takeExtension(t.mime)}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function remove(t: Take) {
    if (playingId === t.id) stopTake();
    await deleteTake(scoreId, t.id);
    refresh();
  }

  return (
    <div className="recpanel">
      <p className="muted small tip">Use headphones so the recording hears you and not the backing. Takes stay on this device (the newest {MAX_TAKES} are kept).</p>
      {error && <p className="error" role="alert"><AlertIcon size={18} /> {error}</p>}
      <div className="prow">
        <button type="button" className={`btn sm${armed ? ' on' : ''}`} onClick={arm} aria-pressed={armed}>
          <MicIcon size={20} /> {armed ? 'Recording is on' : 'Record my next play-through'}
        </button>
        {recording && <span className="recdot" data-testid="rec-indicator" role="status">Recording…</span>}
      </div>
      {armed && !recording && <p className="muted small">Press Play. Recording starts with the music (and the count-in) and stops at Pause.</p>}
      <fieldset className="modes">
        <legend className="muted small">Play a take</legend>
        {([['you', 'You alone'], ['both', 'You + backing'], ['original', 'Original only']] as [Mode, string][]).map(([v, l]) => (
          <label key={v} className="chk"><input type="radio" name="takemode" checked={mode === v} onChange={() => setMode(v)} /> {l}</label>
        ))}
      </fieldset>
      {takes.length === 0 ? <p className="muted small" data-testid="no-takes">No takes yet.</p> : (
        <ul className="takes">
          {takes.map((t, i) => {
            const n = takes.length - i;
            return (
              <li key={t.id} data-testid="take-row" className="take">
                <span className="takeinfo"><strong>Take {n}</strong> <span className="muted small">{fmtTime(t.durationS)} · from bar {t.startMeasure} · {t.bpm} BPM</span></span>
                <span className="takebtns">
                  <button type="button" className="btn sm" onClick={() => playTake(t)} aria-label={`${playingId === t.id ? 'Stop' : 'Play'} take ${n}`} disabled={armed}>{playingId === t.id ? 'Stop' : 'Play'}</button>
                  <button type="button" className="btn sm ghost" onClick={() => download(t, n)} aria-label={`Download take ${n}`}>Save</button>
                  <button type="button" className="btn sm ghost" onClick={() => remove(t)} aria-label={`Delete take ${n}`}>Delete</button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
