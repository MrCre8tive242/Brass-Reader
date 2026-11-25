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
import { detectSourceInstrument, summariseScore, extractPart } from '@/lib/musicxml';
import { AlertIcon, BackIcon } from '@/components/Icons';
import { analyseAndRepair } from '@/lib/repair';
import { Player } from '@/lib/player';

const ZOOM_MIN = 0.6, ZOOM_MAX = 2.2, ZOOM_STEP = 0.15;

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

export default function ScorePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [score, setScore] = useState<SavedScore | null | undefined>(undefined);
  const [source, setSource] = useState<InstrumentId>('trumpet');
  const [target, setTarget] = useState<InstrumentId>('trumpet');
  const [bpm, setBpm] = useState(100);
  const [zoom, setZoom] = useState(1);
  const [metronome, setMetronome] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [measure, setMeasure] = useState(1);
  const [scoreReady, setScoreReady] = useState(false);
  const [engine, setEngine] = useState<string>('loading');
  const [loadTry, setLoadTry] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [part, setPart] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checksOpen, setChecksOpen] = useState(false);
  const player = useRef<Player | null>(null);
  const view = useRef<ScoreViewHandle>(null);
  const measureRef = useRef(1);

  useEffect(() => {
    const z = Number(lsGet('brass-reader:zoom'));
    if (z >= ZOOM_MIN && z <= ZOOM_MAX) setZoom(z);
  }, []);
  const changeZoom = useCallback((d: number) => {
    setZoom((z) => { const n = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z + d)) * 100) / 100; lsSet('brass-reader:zoom', String(n)); return n; });
  }, []);

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
        // the tempo you last used wins; otherwise the metronome mark printed on the music, if it was read
        const printed = summariseScore(s.sourceXml).tempo;
        if (b >= 30 && b <= 240) setBpm(b);
        else if (printed && printed >= 30 && printed <= 240) setBpm(printed);
        setPart(typeof s.partIndex === 'number' ? s.partIndex : null);
      }
    }).catch(() => alive && setScore(null));
    return () => { alive = false; };
  }, [id]);

  // a score with several instruments: show and play one part (or all of them together)
  const summary = useMemo(() => (score ? summariseScore(score.sourceXml) : null), [score]);
  const partXml = useMemo(() => {
    if (!score) return null;
    return part !== null && summary && summary.parts.length > 1 ? extractPart(score.sourceXml, part) : score.sourceXml;
  }, [score, summary, part]);

  // bars that do not add up to the time signature: padded with rests (so cursor and audio agree) and flagged
  const repair = useMemo(() => (partXml ? analyseAndRepair(partXml) : null), [partXml]);

  const derived = useMemo(() => {
    if (!score || !repair) return null;
    try {
      const concert = toConcert(repair.xml, source);
      const xml = fromConcert(concert, target);
      return { xml, tl: buildTimeline(xml), err: null as string | null };
    } catch (e) {
      return { xml: '', tl: null, err: (e as Error).message };
    }
  }, [score, repair, source, target]);

  // player lifecycle
  useEffect(() => {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    const p = new Player(ctx);
    p.onState = (v) => { setPlaying(v); if (v) setBlocked(false); };
    p.onBlocked = () => setBlocked(true);
    p.onPosition = (q, m, off) => {
      view.current?.setPosition(q, m, off);
      if (m !== measureRef.current) { measureRef.current = m; setMeasure(m); }
    };
    player.current = p;
    // leaving the tab or locking the phone stops the music (the phone suspends the audio anyway)
    const onHide = () => { if (document.hidden) p.pause(); };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      p.dispose();
      player.current = null;
      try { void ctx.close(); } catch { /* ignore */ }
    };
  }, []);

  // keep the screen on while the score is open (a phone on a music stand must not dim mid-tune)
  useEffect(() => {
    type Lock = { release: () => Promise<void> };
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<Lock> } }).wakeLock;
    if (!wl) return;
    let lock: Lock | null = null;
    let gone = false;
    const get = () => { if (!document.hidden) wl.request('screen').then((l) => { if (gone) void l.release(); else lock = l; }).catch(() => {}); };
    get();
    document.addEventListener('visibilitychange', get);
    return () => { gone = true; document.removeEventListener('visibilitychange', get); void lock?.release().catch(() => {}); };
  }, []);

  useEffect(() => {
    const p = player.current;
    if (!p) return;
    let alive = true;
    setEngine('loading');
    p.load(target).then((e) => { if (alive) setEngine(e); }).catch(() => { if (alive) setEngine('synth'); });
    return () => { alive = false; };
  }, [target, loadTry]);

  useEffect(() => {
    if (derived?.tl && player.current) {
      player.current.setTimeline(derived.tl);
      if (measureRef.current > derived.tl.measureCount) { measureRef.current = 1; setMeasure(1); }
    }
  }, [derived]);

  useEffect(() => { player.current?.setBpm(bpm); }, [bpm]);
  // persist only on user changes (writing from an effect would overwrite the stored value with the default before it is read)
  const changeBpm = useCallback((n: number) => { setBpm(n); lsSet(`bpm:${id}`, String(n)); }, [id]);
  useEffect(() => { if (player.current) player.current.metronome = metronome; }, [metronome]);
  useEffect(() => { if (player.current) player.current.countIn = countIn; }, [countIn]);
  // click and count-in are habits, not per-score settings: remember them
  useEffect(() => { setMetronome(lsGet('brass-reader:click') === '1'); setCountIn(lsGet('brass-reader:countin') === '1'); }, []);
  const changeMetronome = useCallback((v: boolean) => { setMetronome(v); lsSet('brass-reader:click', v ? '1' : '0'); }, []);
  const changeCountIn = useCallback((v: boolean) => { setCountIn(v); lsSet('brass-reader:countin', v ? '1' : '0'); }, []);

  const tlNow = derived?.tl ?? null;
  const measureCount = tlNow?.measureCount ?? 0;

  const playPause = useCallback(() => {
    const p = player.current;
    if (!p) return;
    if (p.isPlaying) p.pause(); else void p.play();
  }, []);
  const seekTo = useCallback((m: number) => {
    player.current?.seek(m);
    setChecksOpen(false);
  }, []);
  const goBar = useCallback((delta: number) => {
    const p = player.current;
    if (!p || !p.measureCount) return;
    p.stepBar(delta);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // typing / toggling in a form control must not start playback
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.code === 'Space') { e.preventDefault(); playPause(); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); goBar(-1); }
      else if (e.code === 'ArrowRight') { e.preventDefault(); goBar(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playPause, goBar]);

  const onSource = (s: InstrumentId) => { setSource(s); void updateScore(id, { sourceInstrument: s, sourceAuto: false }); };
  const onPart = (v: string) => {
    const n = v === 'all' ? null : Number(v);
    setPart(n);
    const patch: Partial<SavedScore> = { partIndex: n };
    // an auto-detected "written for" follows the part (trumpet line vs trombone line)
    if (score?.sourceAuto !== false && score) {
      const d = detectSourceInstrument(n === null ? score.sourceXml : extractPart(score.sourceXml, n)).id;
      setSource(d);
      patch.sourceInstrument = d;
    }
    void updateScore(id, patch);
  };
  const onTarget = (t: InstrumentId) => { setTarget(t); lsSet(`target:${id}`, t); };

  const sourceHint = partXml ? (() => {
    const d = detectSourceInstrument(partXml);
    return d.id === source
      ? `Detected from the music (${d.reason}). Change "Written for" if this part is for another instrument.`
      : `The music looks like ${INSTRUMENTS[d.id].name} (${d.reason}), but you chose ${INSTRUMENTS[source].name}.`;
  })() : undefined;

  // everything worth checking against the paper, each with the bar to jump to
  const checks = useMemo(() => {
    const out: { measure: number | null; text: string }[] = [];
    if (!repair) return out;
    repair.issues.forEach((i, k) => out.push({ measure: i.measure, text: repair.warnings[k] ?? `Bar ${i.label} may be misread.` }));
    const labels = tlNow?.barLabels ?? [];
    for (const f of score?.flags ?? []) {
      const idx = labels.indexOf(f.bar);
      const where = f.bar === 'Pickup' ? 'Pickup bar' : f.bar ? `Bar ${f.bar}` : 'Note from the reader';
      out.push({ measure: idx >= 0 ? idx + 1 : null, text: `${where}: the reader was not sure${f.text ? ` (${f.text.replace(/[.\s]+$/, '')})` : ''}.` });
    }
    return out;
  }, [repair, score, tlNow]);
  const flagged = useMemo(() => [...new Set(checks.map((c) => c.measure).filter((m): m is number => m !== null))], [checks]);

  if (score === undefined) return <main className="page"><p className="muted loading-line"><span className="spinner" aria-hidden /> Opening the score…</p></main>;
  if (score === null) {
    return (
      <main className="page empty-state">
        <h1>Score not found</h1>
        <p className="muted">That score is not in the library on this device. Scores are saved on the phone or computer where they were scanned.</p>
        <Link href="/" className="btn primary">Back to library</Link>
      </main>
    );
  }
  const many = !!summary && summary.parts.length > 1;

  return (
    <div className="player-page">
      <header className="topbar">
        <Link href="/" className="back" aria-label="Back to library"><BackIcon /></Link>
        <h1 className="title">{score.title}</h1>
        <div className="zoom" role="group" aria-label="Score size">
          <button type="button" onClick={() => changeZoom(-ZOOM_STEP)} aria-label="Zoom out" disabled={zoom <= ZOOM_MIN}>A−</button>
          <button type="button" onClick={() => changeZoom(ZOOM_STEP)} aria-label="Zoom in" disabled={zoom >= ZOOM_MAX}>A+</button>
        </div>
      </header>
      <main className="page">
        <InstrumentPicker source={source} target={target} onSource={onSource} onTarget={onTarget} hint={sourceHint} />
        {many && (
          <label className="picker-one partpick">
            <span className="muted small">Part</span>
            <select className="sel" aria-label="Part" value={part === null ? 'all' : String(part)} onChange={(e) => onPart(e.target.value)}>
              {summary!.parts.map((p) => <option key={p.index} value={p.index}>{p.name}{p.clef ? ` (${p.clef} clef)` : ''}</option>)}
              <option value="all">All parts together</option>
            </select>
          </label>
        )}
        <div className="statusrow">
          <p className={`pill ${engine}`} data-testid="engine-status" role="status">
            {engine === 'loading' && <><span className="spinner sm" aria-hidden /> Loading {INSTRUMENTS[target].name} sound…</>}
            {engine === 'soundfont' && <>Sound: {INSTRUMENTS[target].name} samples</>}
            {engine !== 'loading' && engine !== 'soundfont' && <>Sound: simple synth (samples unavailable offline)</>}
          </p>
          {engine !== 'loading' && engine !== 'soundfont' && (
            <button type="button" className="linkbtn" onClick={() => setLoadTry((n) => n + 1)}>Try loading again</button>
          )}
          <details className="nosound">
            <summary>No sound?</summary>
            <p className="muted small">Turn the volume up with the side buttons. On an iPhone, also flip the ring/silent switch off silent, or use headphones or a speaker. If it still stays quiet, tap Pause, then Play again.</p>
          </details>
        </div>
        {blocked && <p className="warnline" role="alert"><AlertIcon size={18} /> Your phone has not let the sound start yet. Tap Play once more.</p>}
        {(error || derived?.err) && <p className="error" role="alert">{error || derived?.err}</p>}
        {checks.length > 0 && (
          <details className="warn" data-testid="bar-warnings" open={checksOpen} onToggle={(e) => setChecksOpen((e.target as HTMLDetailsElement).open)}>
            <summary><AlertIcon size={18} /> <strong>{checks.length === 1 ? '1 bar to check' : `${checks.length} bars to check`}</strong> against your sheet</summary>
            <ul>
              {checks.slice(0, 12).map((c, i) => (
                <li key={i}>
                  {c.measure !== null
                    ? <button type="button" className="linkbtn" onClick={() => seekTo(c.measure!)}>{c.text}</button>
                    : c.text}
                </li>
              ))}
              {checks.length > 12 && <li>and {checks.length - 12} more.</li>}
            </ul>
            <p className="muted small">Tap a line to jump to that bar. Flagged bars are marked on the score.</p>
          </details>
        )}
        {derived && !derived.err && (
          <ScoreView
            ref={view}
            xml={derived.xml}
            zoom={zoom}
            flagged={flagged}
            onSeekMeasure={(m) => player.current?.seek(m)}
            onReady={() => setScoreReady(true)}
            onError={setError}
          />
        )}
        <p className="disclaimer">Reading is automatic and can make mistakes. Check the notes against your sheet.</p>
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
        barLabel={tlNow?.barLabels[measure - 1]}
        barTotal={tlNow?.barTotal}
        bpm={bpm}
        metronome={metronome}
        countIn={countIn}
        ready={scoreReady && measureCount > 0}
        onPlayPause={playPause}
        onPrev={() => goBar(-1)}
        onNext={() => goBar(1)}
        onBpm={changeBpm}
        onMetronome={changeMetronome}
        onCountIn={changeCountIn}
      />
    </div>
  );
}
