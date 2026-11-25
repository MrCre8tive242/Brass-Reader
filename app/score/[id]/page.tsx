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
import { detectSourceInstrument, summariseScore } from '@/lib/musicxml';
import { songPartsOf, fitBars, mergeScores, mergeTimelines, type SongPart } from '@/lib/song';
import { DEFAULT_MIX, normalizeMix, type MixState } from '@/lib/mixer';
import BandPanel from '@/components/BandPanel';
import PitchPanel from '@/components/PitchPanel';
import RecordPanel from '@/components/RecordPanel';
import { fingeringFor } from '@/lib/fingering';
import { MicSession } from '@/lib/micSession';
import { type NoteResult } from '@/lib/pitch';
import { offsetInBar } from '@/lib/timeline';
import type { NoteLabel, NoteMark } from '@/components/ScoreView';
import { AlertIcon, BackIcon } from '@/components/Icons';
import { analyseAndRepair } from '@/lib/repair';
import { Player } from '@/lib/player';
import PracticeSheet, { Section } from '@/components/PracticeSheet';
import LoopPanel from '@/components/LoopPanel';
import { LoopIcon } from '@/components/Icons';
import { DEFAULT_TRAINER, loopQ, normalizeLoop, normalizeTrainer, passLabel, type LoopRange, type Trainer } from '@/lib/loop';

const ZOOM_MIN = 0.6, ZOOM_MAX = 2.2, ZOOM_STEP = 0.15;

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

export default function ScorePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [score, setScore] = useState<SavedScore | null | undefined>(undefined);
  const [parts, setParts] = useState<SongPart[]>([]);
  const [myIdx, setMyIdx] = useState(0);
  const [full, setFull] = useState(false);
  const [mix, setMix] = useState<Record<string, MixState>>({});
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
  const [error, setError] = useState<string | null>(null);
  const [practiceOpen, setPracticeOpen] = useState(false);
  const [loop, setLoop] = useState<LoopRange | null>(null);
  const [loopDraft, setLoopDraft] = useState<LoopRange>({ from: 1, to: 2 });
  const [trainer, setTrainer] = useState<Trainer>(DEFAULT_TRAINER);
  const [pass, setPass] = useState<{ n: number; bpm: number } | null>(null);
  const mic = useMemo(() => new MicSession(), []);
  const [fingerings, setFingerings] = useState(false);
  const [pitchOn, setPitchOn] = useState(false);
  const [pitchResults, setPitchResults] = useState<(NoteResult | undefined)[]>([]);
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
        const my = typeof s.partIndex === 'number' ? s.partIndex : (s.myPart ?? 0);
        const list = songPartsOf(s, my);
        setParts(list);
        setMyIdx(Math.max(0, Math.min(list.length - 1, my)));
        // a many-part file saved before ensembles shows every staff together, as it always did
        setFull(list.length > 1 && typeof s.partIndex !== 'number');
        setMix(Object.fromEntries(Object.entries(s.mix ?? {}).map(([k, v]) => [k, normalizeMix(v)])));
        const t = lsGet(`target:${id}`);
        setTarget(isInstrumentId(t) ? t : (list[my]?.instrument ?? s.sourceInstrument));
        const b = Number(lsGet(`bpm:${id}`));
        // the tempo you last used wins; otherwise the metronome mark printed on the music, if it was read
        const printed = summariseScore(s.sourceXml).tempo;
        if (b >= 30 && b <= 240) setBpm(b);
        else if (printed && printed >= 30 && printed <= 240) setBpm(printed);
        setLoop(s.loop ?? null);
        if (s.loop) setLoopDraft(s.loop);
        setTrainer(normalizeTrainer(s.trainer));
      }
    }).catch(() => alive && setScore(null));
    return () => { alive = false; };
  }, [id]);

  // the band: one sheet per instrument. "my part" is shown (or all stacked) and the rest play along.
  const myPart = parts[myIdx];
  const source: InstrumentId = myPart?.instrument ?? 'trumpet';
  const partXml = myPart?.xml ?? null;

  // bars that do not add up to the time signature: padded with rests (so cursor and audio agree) and flagged
  const repair = useMemo(() => (partXml ? analyseAndRepair(partXml) : null), [partXml]);

  const derived = useMemo(() => {
    if (!score || !repair || !myPart) return null;
    try {
      const concert = toConcert(repair.xml, source);
      const mineXml = fromConcert(concert, target);
      const tlMine = buildTimeline(mineXml);
      const n = tlMine.measureCount;
      const warnings: string[] = [];
      const others: { index: number; name: string; xml: string; tl: ReturnType<typeof buildTimeline> }[] = [];
      parts.forEach((p, i) => {
        if (i === myIdx) return;
        try {
          const c = toConcert(analyseAndRepair(p.xml).xml, p.instrument);
          const fit = fitBars(fromConcert(c, p.instrument), n);
          if (fit.added) warnings.push(`${p.name} has ${fit.bars - fit.added} bars but ${myPart.name} has ${n}: ${fit.added} bar${fit.added > 1 ? 's' : ''} of rests added at the end.`);
          if (fit.removed) warnings.push(`${p.name} has ${fit.bars + fit.removed} bars but ${myPart.name} has ${n}: the extra ${fit.removed} bar${fit.removed > 1 ? 's' : ''} will not play.`);
          others.push({ index: i, name: p.name, xml: fit.xml, tl: buildTimeline(fit.xml) });
        } catch (e) {
          warnings.push(`${p.name} could not be read (${(e as Error).message}); it will be silent.`);
        }
      });
      const tl = others.length ? mergeTimelines(tlMine, myIdx, others.map((o) => ({ index: o.index, tl: o.tl }))) : tlMine;
      const ordered = [{ xml: mineXml, name: myPart.name }, ...others.map((o) => ({ xml: o.xml, name: o.name }))];
      const exportXml = ordered.length > 1 ? mergeScores(ordered) : mineXml;
      return { xml: full && ordered.length > 1 ? exportXml : mineXml, exportXml, tl, err: null as string | null, warnings };
    } catch (e) {
      return { xml: '', exportXml: '', tl: null, err: (e as Error).message, warnings: [] as string[] };
    }
  }, [score, repair, myPart, myIdx, parts, source, target, full]);

  // player lifecycle
  useEffect(() => {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    const p = new Player(ctx);
    p.onState = (v) => { setPlaying(v); if (v) setBlocked(false); };
    p.onBlocked = () => setBlocked(true);
    // a loop pass became audible: show it, and follow the speed trainer's tempo (the player already runs at it)
    p.onPass = (n, b) => { setPass({ n, bpm: b }); setBpm(b); };
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

  // every part plays with its own instrument's sound; my part uses the "Play as" instrument
  const soundKey = parts.map((p, i) => (i === myIdx ? target : p.instrument)).join(',');
  useEffect(() => {
    const p = player.current;
    if (!p || !soundKey) return;
    let alive = true;
    setEngine('loading');
    p.loadParts(soundKey.split(',') as InstrumentId[]).then((e) => { if (alive) setEngine(e); }).catch(() => { if (alive) setEngine('synth'); });
    return () => { alive = false; };
  }, [soundKey, loadTry]);
  // while the pitch check listens, my own part is silent (only the others and the click play); this is not saved
  useEffect(() => {
    player.current?.setMix(parts.map((p, i) => {
      const m = mix[p.id] ?? DEFAULT_MIX;
      return pitchOn && i === myIdx ? { ...m, mute: true, solo: false } : m;
    }));
  }, [parts, mix, pitchOn, myIdx]);
  const getPlayer = useCallback(() => player.current, []);

  useEffect(() => {
    if (derived?.tl && player.current) {
      player.current.setTimeline(derived.tl);
      if (measureRef.current > derived.tl.measureCount) { measureRef.current = 1; setMeasure(1); }
    }
  }, [derived]);

  useEffect(() => { player.current?.setBpm(bpm); }, [bpm]);
  // practice loop + trainer reach the player (after the timeline, so the bars map onto it)
  useEffect(() => {
    const p = player.current;
    const tl = derived?.tl;
    if (!p) return;
    const n = tl ? normalizeLoop(loop, tl.measureCount) : null;
    p.setLoop(tl && n ? loopQ(tl, n) : null);
    p.setTrainer(n ? trainer : null);
    if (!n) setPass(null);
  }, [derived, loop, trainer]);
  const changeLoop = useCallback((r: LoopRange | null) => {
    setLoop(r);
    if (r) setLoopDraft(r);
    setPass(null);
    void updateScore(id, { loop: r });
  }, [id]);
  const changeTrainer = useCallback((t: Trainer) => { setTrainer(t); void updateScore(id, { trainer: t }); }, [id]);
  // picking bars on the score: loop them and park the cursor at the start
  const pickLoop = useCallback((from: number, to: number) => {
    const n = normalizeLoop({ from, to }, measureCountRef.current);
    if (!n) return;
    changeLoop(n);
    if (!player.current?.isPlaying) player.current?.seek(n.from);
  }, [changeLoop]);
  // persist only on user changes (writing from an effect would overwrite the stored value with the default before it is read)
  const changeBpm = useCallback((n: number) => { setBpm(n); lsSet(`bpm:${id}`, String(n)); }, [id]);
  useEffect(() => { if (player.current) player.current.metronome = metronome; }, [metronome]);
  useEffect(() => { if (player.current) player.current.countIn = countIn; }, [countIn]);
  // click and count-in are habits, not per-score settings: remember them
  useEffect(() => { setMetronome(lsGet('brass-reader:click') === '1'); setCountIn(lsGet('brass-reader:countin') === '1'); }, []);
  const changeMetronome = useCallback((v: boolean) => { setMetronome(v); lsSet('brass-reader:click', v ? '1' : '0'); }, []);
  const changeCountIn = useCallback((v: boolean) => { setCountIn(v); lsSet('brass-reader:countin', v ? '1' : '0'); }, []);

  const tlNow = derived?.tl ?? null;
  // the notes of my part at their sounding pitch: what the pitch check listens for
  const myNotes = useMemo(() => (tlNow ? tlNow.events.filter((e) => e.part === undefined || e.part === myIdx).map((e) => ({ timeQ: e.timeQ, durQ: e.durQ, midi: e.midi, measure: e.measure })) : []), [tlNow, myIdx]);
  const pitchMarks = useMemo<NoteMark[]>(() => {
    if (!tlNow || !pitchOn) return [];
    const out: NoteMark[] = [];
    pitchResults.forEach((r, i) => {
      const n = myNotes[i];
      if (!r || !n) return;
      out.push({ measure: n.measure, offQ: offsetInBar(tlNow, n.timeQ), kind: r.status, arrow: r.reason === 'sharp' ? 'up' : r.reason === 'flat' ? 'down' : undefined });
    });
    return out;
  }, [tlNow, pitchOn, pitchResults, myNotes]);
  const marks = pitchMarks;
  // valves / slide positions under my notes (looked up by what the instrument is playing)
  const fingerLabels = useMemo<NoteLabel[] | undefined>(() => {
    if (!fingerings || !tlNow) return undefined;
    const out: NoteLabel[] = [];
    for (const e of tlNow.events) {
      if (e.part !== undefined && e.part !== myIdx) continue;
      const f = fingeringFor(target, e.midi);
      out.push({ measure: e.measure, offQ: offsetInBar(tlNow, e.timeQ), text: f ? f.primary : '—', alts: f?.alternates });
    }
    return out;
  }, [fingerings, tlNow, myIdx, target]);
  useEffect(() => { setFingerings(lsGet('brass-reader:fingerings') === '1'); }, []);
  const changeFingerings = (v: boolean) => { setFingerings(v); lsSet('brass-reader:fingerings', v ? '1' : '0'); };
  const measureCount = tlNow?.measureCount ?? 0;
  const measureCountRef = useRef(0);
  measureCountRef.current = measureCount;

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

  /** Save the band: the parts (when there are several or they were saved before), which one is mine, and what mine is written for. */
  const saveBand = useCallback((nextParts: SongPart[], my: number, isFull: boolean, extra: Partial<SavedScore> = {}) => {
    const patch: Partial<SavedScore> = { myPart: my, partIndex: isFull ? null : my, sourceInstrument: nextParts[my]?.instrument ?? 'trumpet', ...extra };
    if (nextParts.length > 1 || score?.parts) patch.parts = nextParts;
    // keep the in-memory record in step so later saves start from what is stored
    setScore((s) => (s ? { ...s, ...patch } : s));
    void updateScore(id, patch);
  }, [id, score?.parts]);
  const onSource = (ins: InstrumentId) => {
    const next = parts.map((p, i) => (i === myIdx ? { ...p, instrument: ins } : p));
    setParts(next);
    saveBand(next, myIdx, full, { sourceAuto: false });
  };
  const onPart = (v: string) => {
    if (v === 'all') { setFull(true); saveBand(parts, myIdx, true); return; }
    const n = Number(v);
    setMyIdx(n); setFull(false);
    saveBand(parts, n, false);
    // the part you play follows its own sheet unless you chose a sound by hand
    const ins = parts[n]?.instrument;
    if (ins && lsGet(`target:${id}`) === null) setTarget(ins);
  };
  const onFull = (v: boolean) => { setFull(v); saveBand(parts, myIdx, v); };
  const onMix = (partId: string, patch: Partial<MixState>) => {
    setMix((m) => {
      const next = { ...m, [partId]: normalizeMix({ ...(m[partId] ?? DEFAULT_MIX), ...patch }) };
      void updateScore(id, { mix: next });
      return next;
    });
  };
  const onPartInstrument = (i: number, ins: InstrumentId) => {
    const next = parts.map((p, k) => (k === i ? { ...p, instrument: ins } : p));
    setParts(next);
    saveBand(next, myIdx, full, i === myIdx ? { sourceAuto: false } : {});
  };
  const myMuted = !!myPart && !!mix[myPart.id]?.mute;
  const toggleMuteMine = () => { if (myPart) onMix(myPart.id, { mute: !myMuted }); };
  const onTarget = (t: InstrumentId) => { setTarget(t); lsSet(`target:${id}`, t); };

  const sourceHint = useMemo(() => {
    if (!partXml || !myPart) return undefined;
    const d = detectSourceInstrument(partXml);
    return d.id === source
      ? `Detected from the music (${d.reason}). Change "Written for" if this part is for another instrument.`
      : `The music looks like ${INSTRUMENTS[d.id].name} (${d.reason}), but you chose ${INSTRUMENTS[source].name}.`;
  }, [partXml, source]);

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
  const many = parts.length > 1;

  return (
    <div className="player-page">
      <header className="topbar">
        <Link href="/" className="back" aria-label="Back to library"><BackIcon /></Link>
        <h1 className="title">{score.title}</h1>
        <button type="button" className="practice-btn" aria-label="Practice" aria-expanded={practiceOpen} onClick={() => setPracticeOpen((o) => !o)}><LoopIcon size={24} /></button>
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
            <select className="sel" aria-label="Part" value={full ? 'all' : String(myIdx)} onChange={(e) => onPart(e.target.value)}>
              {parts.map((p, i) => <option key={p.id} value={i}>{p.name}{INSTRUMENTS[p.instrument].clef === 'bass' ? ' (bass clef)' : ''}</option>)}
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
          {many && (
            <button type="button" className={`linkbtn mutemine${myMuted ? ' on' : ''}`} aria-pressed={myMuted} onClick={toggleMuteMine}>
              {myMuted ? 'Unmute my part' : 'Mute my part'}
            </button>
          )}
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
            marks={marks}
            labels={fingerLabels}
            loop={normalizeLoop(loop, measureCount)}
            onLoopSelect={pickLoop}
            onSeekMeasure={(m) => player.current?.seek(m)}
            onReady={() => setScoreReady(true)}
            onError={setError}
          />
        )}
        <p className="disclaimer">Reading is automatic and can make mistakes. Check the notes against your sheet.</p>
        <Downloads
          title={score.title}
          getMidi={() => toMidi(derived!.tl!, bpm, INSTRUMENTS[target].program, score.title, parts.map((p, i) => ({ name: p.name, program: INSTRUMENTS[i === myIdx ? target : p.instrument].program })))}
          getXml={() => derived!.exportXml}
        />
      </main>
      <PracticeSheet open={practiceOpen} onClose={() => setPracticeOpen(false)}>
        <Section id="band" title={parts.length > 1 ? `Band (${parts.length} parts)` : 'Band'}>
          <BandPanel
            parts={parts} myIdx={myIdx} mix={mix} full={full} scoreId={id} warnings={derived?.warnings ?? []}
            onMix={onMix} onMy={(i) => onPart(String(i))} onFull={onFull} onInstrument={onPartInstrument}
          />
        </Section>
        <Section id="fingerings" title={INSTRUMENTS[target].id === 'trombone' ? 'Slide positions' : 'Fingerings'}>
          <label className="chk wide">
            <input type="checkbox" checked={fingerings} onChange={(e) => changeFingerings(e.target.checked)} aria-label="Show fingerings" /> Show {target === 'trombone' ? 'slide positions' : 'fingerings'} under the notes
          </label>
          <p className="muted small" data-testid="finger-help">
            {target === 'trombone'
              ? 'Slide positions 1 to 7 (1 = in). The usual position is shown; tap one for another way to play the note.'
              : `Valves 1, 2, 3 (0 = open). The usual fingering is shown; tap one for another way to play the note. ${target === 'trumpet' || target === 'mellophone' ? 'Looked up by the written pitch.' : 'Looked up by the concert pitch.'}`}
            {' '}A dash means the note is outside the chart.
          </p>
        </Section>
        <Section id="pitch" title="Pitch check (microphone)">
          <PitchPanel
            getPlayer={getPlayer} session={mic} notes={myNotes} playing={playing} enabled={pitchOn}
            onEnabled={(v) => { setPitchOn(v); if (!v) setPitchResults([]); }}
            onResults={setPitchResults} onLoopBar={(m) => pickLoop(m, m)}
            partName={INSTRUMENTS[target].name}
          />
        </Section>
        <Section id="record" title="Record yourself">
          <RecordPanel scoreId={id} title={score.title} getPlayer={getPlayer} session={mic} playing={playing} onTempo={setBpm} />
        </Section>
        <Section id="loop" title="Loop and speed trainer" open>
          <LoopPanel measureCount={measureCount} loop={normalizeLoop(loop, measureCount)} draft={loopDraft} trainer={trainer} onDraft={setLoopDraft} onLoop={changeLoop} onTrainer={changeTrainer} />
        </Section>
      </PracticeSheet>
      <Transport
        playing={playing}
        measure={measure}
        measureCount={measureCount}
        barLabel={tlNow?.barLabels[measure - 1]}
        barTotal={tlNow?.barTotal}
        passLabel={loop && pass ? passLabel(pass.n, pass.bpm, trainer) : undefined}
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
