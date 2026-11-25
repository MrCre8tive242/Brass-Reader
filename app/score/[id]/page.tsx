'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ScoreView, { type ScoreViewHandle } from '@/components/ScoreView';
import Transport from '@/components/Transport';
import InstrumentPicker from '@/components/InstrumentPicker';
import Downloads from '@/components/Downloads';
import { getScore, updateScore, type SavedScore } from '@/lib/library';
import { INSTRUMENTS, isInstrumentId, type InstrumentId } from '@/lib/instruments';
import { toConcert, fromConcert } from '@/lib/transpose';
import { buildTimeline } from '@/lib/timeline';
import { toMidi } from '@/lib/midi';
import { Player } from '@/lib/player';

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

export default function ScorePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [score, setScore] = useState<SavedScore | null | undefined>(undefined);
  const [source, setSource] = useState<InstrumentId>('trumpet');
  const [target, setTarget] = useState<InstrumentId>('trumpet');
  const [bpm, setBpm] = useState(100);
  const [metronome, setMetronome] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [measure, setMeasure] = useState(1);
  const [scoreReady, setScoreReady] = useState(false);
  const [engine, setEngine] = useState<string>('loading');
  const [error, setError] = useState<string | null>(null);
  const player = useRef<Player | null>(null);
  const view = useRef<ScoreViewHandle>(null);
  const measureRef = useRef(1);

  useEffect(() => {
    let alive = true;
    getScore(id).then((s) => {
      if (!alive) return;
      setScore(s ?? null);
      if (s) {
        setSource(s.sourceInstrument);
        const t = lsGet(`target:${id}`);
        setTarget(isInstrumentId(t) ? t : s.sourceInstrument);
        const b = Number(lsGet(`bpm:${id}`));
        if (b >= 30 && b <= 240) setBpm(b);
      }
    }).catch(() => alive && setScore(null));
    return () => { alive = false; };
  }, [id]);

  const derived = useMemo(() => {
    if (!score) return null;
    try {
      const concert = toConcert(score.sourceXml, source);
      const xml = fromConcert(concert, target);
      return { xml, tl: buildTimeline(xml), err: null as string | null };
    } catch (e) {
      return { xml: '', tl: null, err: (e as Error).message };
    }
  }, [score, source, target]);

  // player lifecycle
  useEffect(() => {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const p = new Player(new AC());
    p.onState = setPlaying;
    p.onPosition = (q, m) => {
      view.current?.setPosition(q, m);
      if (m !== measureRef.current) { measureRef.current = m; setMeasure(m); }
    };
    player.current = p;
    return () => { p.dispose(); player.current = null; try { void (p as unknown as { ctx: AudioContext }).ctx.close(); } catch { /* ignore */ } };
  }, []);

  useEffect(() => {
    const p = player.current;
    if (!p) return;
    setEngine('loading');
    p.load(target).then((e) => setEngine(e)).catch(() => setEngine('synth'));
  }, [target]);

  useEffect(() => {
    if (derived?.tl && player.current) {
      player.current.setTimeline(derived.tl);
      if (measureRef.current > derived.tl.measureStartsQ.length) { measureRef.current = 1; setMeasure(1); }
    }
  }, [derived]);

  useEffect(() => { player.current?.setBpm(bpm); lsSet(`bpm:${id}`, String(bpm)); }, [bpm, id]);
  useEffect(() => { if (player.current) player.current.metronome = metronome; }, [metronome]);
  useEffect(() => { if (player.current) player.current.countIn = countIn; }, [countIn]);

  const measureCount = derived?.tl?.measureStartsQ.length ?? 0;

  const playPause = useCallback(() => {
    const p = player.current;
    if (!p) return;
    if (p.isPlaying) p.pause(); else void p.play();
  }, []);
  const goBar = useCallback((delta: number) => {
    const p = player.current;
    if (!p || !p.measureCount) return;
    p.seek(Math.max(1, Math.min(p.measureCount, p.measure + delta)));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') { e.preventDefault(); playPause(); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); goBar(-1); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); goBar(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playPause, goBar]);

  const onSource = (s: InstrumentId) => { setSource(s); void updateScore(id, { sourceInstrument: s }); };
  const onTarget = (t: InstrumentId) => { setTarget(t); lsSet(`target:${id}`, t); };

  if (score === undefined) return <main className="page"><p className="muted">Loading…</p></main>;
  if (score === null) {
    return <main className="page"><p>That score is not in your library on this device.</p><Link href="/" className="btn">Back to library</Link></main>;
  }

  return (
    <div className="player-page">
      <header className="topbar">
        <Link href="/" className="back" aria-label="Back to library">‹</Link>
        <h1 className="title">{score.title}</h1>
      </header>
      <main className="page">
        <InstrumentPicker source={source} target={target} onSource={onSource} onTarget={onTarget} />
        <p className="muted small" data-testid="engine-status">
          {engine === 'loading' ? 'Loading sounds…' : engine === 'soundfont' ? `Sound: ${INSTRUMENTS[target].name} samples` : 'Sound: simple synth (samples unavailable offline)'}
        </p>
        {(error || derived?.err) && <p className="error" role="alert">{error || derived?.err}</p>}
        {derived && !derived.err && (
          <ScoreView
            ref={view}
            xml={derived.xml}
            onSeekMeasure={(m) => player.current?.seek(m)}
            onReady={() => setScoreReady(true)}
            onError={setError}
          />
        )}
        <p className="disclaimer">Reading is automatic. Check the notes against your sheet.</p>
        <Downloads
          title={score.title}
          getMidi={() => toMidi(derived!.tl!, bpm, INSTRUMENTS[target].program, score.title)}
          getXml={() => derived!.xml}
        />
      </main>
      <Transport
        playing={playing}
        measure={measure}
        measureCount={measureCount}
        bpm={bpm}
        metronome={metronome}
        countIn={countIn}
        ready={scoreReady && measureCount > 0}
        onPlayPause={playPause}
        onPrev={() => goBar(-1)}
        onNext={() => goBar(1)}
        onBpm={setBpm}
        onMetronome={setMetronome}
        onCountIn={setCountIn}
      />
    </div>
  );
}
