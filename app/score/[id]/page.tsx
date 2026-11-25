'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ScoreView, { type ScoreViewHandle } from '@/components/ScoreView';
import TwoBarView, { type TwoBarHandle } from '@/components/TwoBarView';
import FingerStylePicker from '@/components/FingerStylePicker';
import VideoDialog, { type VideoChoices } from '@/components/VideoDialog';
import type { VideoJob } from '@/lib/videoRender';
import { DEFAULT_FINGER_STYLE, normalizeFingerStyle, type FingerStyle } from '@/lib/fingerStyle';
import Transport from '@/components/Transport';
import InstrumentPicker from '@/components/InstrumentPicker';
import Downloads from '@/components/Downloads';
import { getScore, updateScore, type SavedScore } from '@/lib/library';
import { onStorageProblem } from '@/lib/storage';
import { INSTRUMENTS, isInstrumentId, type InstrumentId } from '@/lib/instruments';
import { toConcert, fromConcert } from '@/lib/transpose';
import { buildTimeline, measureAt } from '@/lib/timeline';
import { toMidi } from '@/lib/midi';
import { detectSourceInstrument, summariseScore } from '@/lib/musicxml';
import { songPartsOf, fitBars, mergeScores, mergeTimelines, type SongPart } from '@/lib/song';
import { DEFAULT_MIX, normalizeMix, type MixState } from '@/lib/mixer';
import BandPanel from '@/components/BandPanel';
import PitchPanel from '@/components/PitchPanel';
import RecordPanel from '@/components/RecordPanel';
import { fingeringFor } from '@/lib/fingering';
import { addShift, applyShifts, describeRange, outOfRange, rangeLabel, type OctaveShift } from '@/lib/range';
import { MicSession } from '@/lib/micSession';
import { type NoteResult } from '@/lib/pitch';
import { offsetInBar } from '@/lib/timeline';
import type { NoteLabel, NoteMark } from '@/components/ScoreView';
import { AlertIcon, BackIcon } from '@/components/Icons';
import { analyseAndRepair } from '@/lib/repair';
import { Player } from '@/lib/player';
import PracticeSheet, { Section } from '@/components/PracticeSheet';
import LoopPanel from '@/components/LoopPanel';
import DrumsPanel from '@/components/DrumsPanel';
import GrooveStudio from '@/components/GrooveStudio';
import { DEFAULT_DRUMS, drumsAudible, feelFor, normalizeDrums, type DrumSettings } from '@/lib/drumSettings';
import { buildDrumEvents, starterGrooves, type Groove } from '@/lib/groove';
import { getGroove, listGrooves } from '@/lib/grooveStore';
import { LoopIcon } from '@/components/Icons';
import { DEFAULT_TRAINER, loopQ, normalizeLoop, normalizeTrainer, passLabel, type LoopRange, type Trainer } from '@/lib/loop';

const ZOOM_MIN = 0.6, ZOOM_MAX = 2.2, ZOOM_STEP = 0.15;

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

/** Events of my part (all of them for a single part). */
function myEvents(tl: { events: { part?: number; timeQ: number; durQ: number; midi: number; measure: number }[] }, myIdx: number) {
  return tl.events.filter((e) => e.part === undefined || e.part === myIdx);
}

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
  useEffect(() => mic.subscribe(setMicLive), [mic]);
  const [fingerings, setFingerings] = useState(false);
  const [rangeOn, setRangeOn] = useState(true);
  const [shifts, setShifts] = useState<OctaveShift[]>([]);
  const [pitchOn, setPitchOn] = useState(false);
  const [pitchResults, setPitchResults] = useState<(NoteResult | undefined)[]>([]);
  const [checksOpen, setChecksOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [drums, setDrums] = useState<DrumSettings>(DEFAULT_DRUMS);
  const [saved, setSaved] = useState<Groove[]>([]);
  const [drumBuf, setDrumBuf] = useState<{ id: string; buffer: AudioBuffer | null; failed?: boolean } | null>(null);
  const [recBusy, setRecBusy] = useState(false);
  const [micLive, setMicLive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [loopHintSeen, setLoopHintSeen] = useState(true);
  /** The tempo you set yourself, kept while the speed trainer drives the player's tempo, and put back when it stops. */
  const trainerBase = useRef<number | null>(null);
  const bpmNow = useRef(100);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const player = useRef<Player | null>(null);
  const view = useRef<ScoreViewHandle>(null);
  const bars = useRef<TwoBarHandle>(null);
  const [viewMode, setViewMode] = useState<'full' | 'twobar'>('full');
  const [videoOpen, setVideoOpen] = useState(false);
  const [fingerStyle, setFingerStyle] = useState<FingerStyle>(DEFAULT_FINGER_STYLE);
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
        setShifts(s.octaveShifts ?? []);
        if (s.loop) setLoopDraft(s.loop);
        setTrainer(normalizeTrainer(s.trainer));
        setDrums(normalizeDrums(s.drums));
        setViewMode(s.view === 'twobar' ? 'twobar' : 'full');
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
      const mineXml = applyShifts(fromConcert(concert, target), shifts, target, myPart.id);
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
      return { xml: full && ordered.length > 1 ? exportXml : mineXml, mineXml, exportXml, tl, err: null as string | null, warnings };
    } catch (e) {
      return { xml: '', mineXml: '', exportXml: '', tl: null, err: (e as Error).message, warnings: [] as string[] };
    }
  }, [score, repair, myPart, myIdx, parts, source, target, full, shifts]);

  // player lifecycle
  useEffect(() => {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    const p = new Player(ctx);
    p.onState = (v) => {
      setPlaying(v);
      if (v) setBlocked(false);
      // the speed trainer changed the tempo while it ran: when the music stops, the tempo you chose comes back
      else if (trainerBase.current !== null) { setBpm(trainerBase.current); trainerBase.current = null; }
    };
    p.onBlocked = () => setBlocked(true);
    // a loop pass became audible: show it, and follow the speed trainer's tempo (the player already runs at it)
    p.onPass = (n, b) => {
      setPass({ n, bpm: b });
      if (trainerBase.current === null) trainerBase.current = bpmNow.current;
      setBpm(b);
    };
    p.onPosition = (q, m, off) => {
      view.current?.setPosition(q, m, off);
      bars.current?.setPosition(q, m, off);
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

  bpmNow.current = bpm;
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
  const say = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  // a setting that could not be stored (the device is full): say so once, keep going
  useEffect(() => onStorageProblem(say), [say]);
  useEffect(() => { setLoopHintSeen(lsGet('brass-reader:loop-hint') === '1'); }, []);
  const pickLoop = useCallback((from: number, to: number) => {
    const n = normalizeLoop({ from, to }, measureCountRef.current);
    if (!n) return;
    changeLoop(n);
    if (!player.current?.isPlaying) player.current?.seek(n.from);
    lsSet('brass-reader:loop-hint', '1'); setLoopHintSeen(true);
    say(n.from === n.to ? `Looping bar ${n.from}. Exit the loop above the score, or in Practice.` : `Looping bars ${n.from} to ${n.to}. Exit the loop above the score, or in Practice.`);
  }, [changeLoop, say]);
  // opening the drawer: keep the bar being played in view above it
  useEffect(() => {
    if (!practiceOpen) return;
    const t = setTimeout(() => { view.current?.ensureVisible(); bars.current?.ensureVisible(); }, 120);
    return () => clearTimeout(t);
  }, [practiceOpen]);
  const loopRef = useRef<LoopRange | null>(null);
  loopRef.current = loop;
  /** A seek or next/previous bar that lands outside the practice loop leaves the loop (and says so), instead of silently ignoring it. */
  const leaveLoopIfOutside = useCallback((m: number) => {
    const l = normalizeLoop(loopRef.current, measureCountRef.current);
    if (!l || (m >= l.from && m <= l.to)) return;
    changeLoop(null);
    say(`Left the loop (bars ${l.from}–${l.to}): you moved to bar ${m}. Press and hold a bar to loop again.`);
  }, [changeLoop, say]);
  const seekGuarded = useCallback((m: number) => { player.current?.seek(m); leaveLoopIfOutside(m); }, [leaveLoopIfOutside]);
  // persist only on user changes (writing from an effect would overwrite the stored value with the default before it is read)
  const changeBpm = useCallback((n: number) => { trainerBase.current = null; setBpm(n); lsSet(`bpm:${id}`, String(n)); }, [id]);
  useEffect(() => { if (player.current) player.current.metronome = metronome; }, [metronome]);
  useEffect(() => { if (player.current) player.current.countIn = countIn; }, [countIn]);
  // click and count-in are habits, not per-score settings: remember them
  useEffect(() => { setMetronome(lsGet('brass-reader:click') === '1'); setCountIn(lsGet('brass-reader:countin') === '1'); }, []);
  const changeMetronome = useCallback((v: boolean) => { setMetronome(v); lsSet('brass-reader:click', v ? '1' : '0'); }, []);
  const changeCountIn = useCallback((v: boolean) => { setCountIn(v); lsSet('brass-reader:countin', v ? '1' : '0'); }, []);

  const tlNow = derived?.tl ?? null;

  // ---- drums: the chosen groove becomes hits on the score's beat grid, played by the player's clock ----
  const refreshGrooves = useCallback(() => {
    listGrooves().then((l) => setSaved(l.map(({ audio, ...g }) => { void audio; return g; }))).catch(() => setSaved([]));
  }, []);
  useEffect(refreshGrooves, [refreshGrooves]);
  const allGrooves = useMemo(() => [...saved, ...starterGrooves()], [saved]);
  const groove = allGrooves.find((g) => g.id === drums.grooveId);
  const grooveKey = groove ? `${groove.id}:${groove.kind}:${groove.bpm ?? ''}:${groove.quantize ?? ''}:${groove.bars ?? ''}:${groove.feel}:${groove.slices?.length ?? ''}` : '';
  // a recorded groove's sound: decode its audio once per change
  useEffect(() => {
    let alive = true;
    const g = groove;
    if (!g || g.kind !== 'recorded') { setDrumBuf(null); return; }
    const ctx = player.current?.context;
    setDrumBuf({ id: g.id, buffer: null });
    getGroove(g.id).then(async (st) => {
      if (!st?.audio || !ctx) throw new Error('no audio');
      const buffer = await ctx.decodeAudioData(await st.audio.arrayBuffer());
      if (alive) setDrumBuf({ id: g.id, buffer });
    }).catch(() => { if (alive) setDrumBuf({ id: g.id, buffer: null, failed: true }); });
    return () => { alive = false; };
  }, [grooveKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const drumFeel = groove ? feelFor(drums, groove) : 'straight';
  const drumEvents = useMemo(() => (groove && tlNow ? buildDrumEvents(tlNow, groove, drumFeel) : []), [groove, tlNow, drumFeel]);
  const drumStatus = groove?.kind === 'recorded' && drumBuf?.id === groove.id ? (drumBuf.failed ? 'The recording of this groove could not be opened, so it is silent.' : drumBuf.buffer ? null : 'Loading the recording…') : null;
  useEffect(() => {
    const buffer = groove && drumBuf?.id === groove.id ? drumBuf.buffer : null;
    player.current?.setDrums(drumEvents, groove ? { groove, buffer } : null);
  }, [drumEvents, groove, drumBuf]);
  useEffect(() => {
    player.current?.setDrumsEnabled(drumsAudible(drums, groove, recBusy));
    player.current?.setDrumsVolume(drums.volume);
  }, [drums, groove, recBusy, derived]);
  const changeDrums = useCallback((patch: Partial<DrumSettings>) => {
    setDrums((d) => { const next = normalizeDrums({ ...d, ...patch }); void updateScore(id, { drums: next }); return next; });
  }, [id]);
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
  // notes outside the comfortable range of the instrument being played (written pitch)
  const rangeIssues = useMemo(() => (tlNow ? outOfRange(myEvents(tlNow, myIdx), target) : []), [tlNow, myIdx, target]);
  const rangeMarks = useMemo<NoteMark[]>(() => {
    if (!rangeOn || !tlNow || !rangeIssues.length) return [];
    const ev = myEvents(tlNow, myIdx);
    return rangeIssues.map((i) => ({ measure: ev[i.index].measure, offQ: offsetInBar(tlNow, ev[i.index].timeQ), kind: 'range' as const }));
  }, [rangeOn, tlNow, rangeIssues, myIdx]);
  // pitch-check colours win over the range colour on the same note
  const marks = useMemo(() => [...rangeMarks, ...pitchMarks], [rangeMarks, pitchMarks]);
  const loopNorm = normalizeLoop(loop, tlNow?.measureCount ?? 0);
  const inLoop = loopNorm ? rangeIssues.filter((i) => { const m = myEvents(tlNow!, myIdx)[i.index].measure; return m >= loopNorm.from && m <= loopNorm.to; }) : [];
  const moveLoop = (octaves: number) => {
    if (!loopNorm || !myPart) return;
    const next = addShift(shifts, { from: loopNorm.from, to: loopNorm.to, octaves, target, part: myPart.id });
    setShifts(next);
    void updateScore(id, { octaveShifts: next });
  };
  const clearShifts = () => { setShifts([]); void updateScore(id, { octaveShifts: [] }); };
  const myShifts = shifts.filter((s) => s.target === target && s.part === myPart?.id);
  useEffect(() => { setRangeOn(lsGet('brass-reader:range') !== '0'); }, []);
  const changeRangeOn = (v: boolean) => { setRangeOn(v); lsSet('brass-reader:range', v ? '1' : '0'); };
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
  useEffect(() => { setFingerStyle(normalizeFingerStyle(lsGet('brass-reader:finger-style'))); }, []);
  const changeFingerStyle = useCallback((v: FingerStyle) => { setFingerStyle(v); lsSet('brass-reader:finger-style', v); }, []);
  const changeView = useCallback((v: 'full' | 'twobar') => { setViewMode(v); void updateScore(id, { view: v }); }, [id]);
  const measureCount = tlNow?.measureCount ?? 0;
  const measureCountRef = useRef(0);
  measureCountRef.current = measureCount;

  /** A view that was just drawn (first time, or after switching) is moved to where the music is. */
  const resyncView = useCallback(() => {
    const p = player.current;
    const tl = derived?.tl;
    if (!p || !tl) return;
    const q = p.currentQ();
    const m = measureAt(tl, q);
    view.current?.setPosition(q, m, offsetInBar(tl, q));
    bars.current?.setPosition(q, m, offsetInBar(tl, q));
  }, [derived]);
  const playPause = useCallback(() => {
    const p = player.current;
    if (!p) return;
    if (p.isPlaying) p.pause(); else void p.play();
  }, []);
  const seekTo = useCallback((m: number) => {
    seekGuarded(m);
    setChecksOpen(false);
  }, [seekGuarded]);
  const goBar = useCallback((delta: number) => {
    const p = player.current;
    if (!p || !p.measureCount) return;
    p.stepBar(delta);
    leaveLoopIfOutside(p.measure);
  }, [leaveLoopIfOutside]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      // typing or sliding in a form control keeps its own keys
      if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
      // the Grooves studio is a screen of its own: nothing behind it reacts to the keyboard
      if (document.querySelector('[data-testid="groove-studio"]')) return;
      // Space presses a button, opens a summary, follows a link, toggles a step: only play when focus is not on one
      const onControl = !!t?.closest?.('button, summary, a, [role="button"], [role="checkbox"], [role="switch"], [role="slider"], [role="tab"], [role="menuitem"]');
      if (e.code === 'Space') { if (onControl) return; e.preventDefault(); playPause(); }
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
  // what each practice tool is doing right now: shown on its folded header and as a dot on its shortcut
  const drumsLive = !!groove && drums.on;
  const fingerWord = target === 'trombone' ? 'Slide' : 'Fingering';
  const loopNow = normalizeLoop(loop, measureCount);
  const loopStatus = loopNow
    ? `${loopNow.from === loopNow.to ? `Bar ${loopNow.from}` : `Bars ${loopNow.from}–${loopNow.to}`}${trainer?.enabled ? ` · ${trainer.start}→${trainer.target} BPM` : ''}`
    : 'Off';
  const drumStatusLine = groove ? (drums.on ? groove.name.replace(/^Starter /, '') : `${groove.name.replace(/^Starter /, '')} · muted`) : 'None';
  // in the order a rehearsal uses them
  const practiceTabs = [
    { id: 'loop', label: 'Loop', on: !!loopNow }, { id: 'drums', label: 'Drums', on: drumsLive }, { id: 'pitch', label: 'Pitch', on: pitchOn },
    { id: 'record', label: 'Record', on: recBusy }, { id: 'band', label: 'Band' },
    { id: 'fingerings', label: fingerWord, on: fingerings }, { id: 'range', label: 'Range', on: rangeOn && rangeIssues.length > 0 },
  ];
  const loopShown = normalizeLoop(loop, measureCount);

  return (
    <div className="player-page">
      <header className="topbar">
        <Link href="/" className="back" aria-label="Back to library"><BackIcon /></Link>
        <h1 className="title">{score.title}</h1>
        <button type="button" className="practice-btn" aria-expanded={practiceOpen} aria-controls="practice-sheet" aria-haspopup="dialog" onClick={() => setPracticeOpen((o) => !o)}><LoopIcon size={22} /><span>Practice</span></button>
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
        {loopShown
          ? (
            <div className="loopchip" role="group" aria-label="Practice loop" data-testid="loop-chip">
              <span><strong>Loop</strong> {loopShown.from === loopShown.to ? `bar ${loopShown.from}` : `bars ${loopShown.from}–${loopShown.to}`}{trainer.enabled ? ' with speed trainer' : ''}</span>
              <button type="button" className="btn sm ghost" onClick={() => changeLoop(null)}>Exit loop</button>
            </div>
          )
          : !loopHintSeen && derived && !derived.err && <p className="muted small loophint" data-testid="loop-hint">Tip: press and hold a bar to loop it (drag with a mouse). More loop tools are in Practice.</p>}
        {derived && !derived.err && viewMode === 'twobar' && derived.tl && (
          <TwoBarView
            ref={bars}
            xml={derived.mineXml}
            tl={derived.tl}
            loopQ={loopNorm ? loopQ(derived.tl, loopNorm) : null}
            loop={loopNorm}
            instrument={target}
            style={fingerStyle}
            myIdx={myIdx}
            flagged={flagged}
            marks={marks}
            getQ={() => player.current?.currentQ() ?? 0}
            onLoopSelect={pickLoop}
            onSeekMeasure={seekGuarded}
            onReady={() => { setScoreReady(true); resyncView(); }}
            onError={setError}
          />
        )}
        {derived && !derived.err && viewMode === 'full' && (
          <ScoreView
            ref={view}
            xml={derived.xml}
            zoom={zoom}
            flagged={flagged}
            marks={marks}
            labels={fingerLabels}
            loop={normalizeLoop(loop, measureCount)}
            onLoopSelect={pickLoop}
            onSeekMeasure={seekGuarded}
            onReady={() => { setScoreReady(true); resyncView(); }}
            onError={setError}
          />
        )}
        {derived && !derived.err && (
          <div className="viewbar" data-testid="viewbar">
            <div className="seg-wrap">
              <span className="seg-label">View</span>
              <div className="seg" role="radiogroup" aria-label="View" data-testid="view-toggle">
                <button type="button" role="radio" aria-checked={viewMode === 'full'} className={viewMode === 'full' ? 'on' : ''} onClick={() => changeView('full')}>Full sheet</button>
                <button type="button" role="radio" aria-checked={viewMode === 'twobar'} className={viewMode === 'twobar' ? 'on' : ''} onClick={() => changeView('twobar')}>2 bars</button>
              </div>
            </div>
            {viewMode === 'twobar' && <FingerStylePicker value={fingerStyle} onChange={changeFingerStyle} label={fingerWord === 'Slide' ? 'Slide' : 'Fingerings'} slide={target === 'trombone'} />}
          </div>
        )}
        <p className="disclaimer">Reading is automatic and can make mistakes. Check the notes against your sheet.</p>
        <Downloads
          title={score.title}
          getMidi={() => toMidi(derived!.tl!, bpm, INSTRUMENTS[target].program, score.title, parts.map((p, i) => ({ name: p.name, program: INSTRUMENTS[i === myIdx ? target : p.instrument].program })), drums.inMidi && groove && drums.on ? drumEvents : undefined)}
          getXml={() => derived!.exportXml}
          onVideo={derived?.tl && !derived.err ? () => setVideoOpen(true) : undefined}
        />
      </main>
      <PracticeSheet open={practiceOpen} onClose={() => setPracticeOpen(false)} tabs={practiceTabs}>
        <Section id="loop" title="Loop and speed trainer" open status={loopStatus} live={!!loopNow}>
          <LoopPanel measureCount={measureCount} loop={normalizeLoop(loop, measureCount)} draft={loopDraft} trainer={trainer} onDraft={setLoopDraft} onLoop={changeLoop} onTrainer={changeTrainer} />
        </Section>
        <Section id="drums" title="Drums" status={drumStatusLine} live={drumsLive}>
          <DrumsPanel settings={drums} grooves={allGrooves} status={drumStatus} onChange={changeDrums} onOpenStudio={() => setStudioOpen(true)} />
        </Section>
        <Section id="pitch" title="Pitch check" status={pitchOn ? (playing ? 'Listening' : 'On') : 'Off'} live={pitchOn}>
          <PitchPanel
            getPlayer={getPlayer} session={mic} notes={myNotes} playing={playing} enabled={pitchOn}
            onEnabled={(v) => { setPitchOn(v); if (!v) setPitchResults([]); }}
            onResults={setPitchResults} onLoopBar={(m) => pickLoop(m, m)}
            partName={INSTRUMENTS[target].name} writtenToConcert={INSTRUMENTS[target].writtenToConcert} drawerOpen={practiceOpen}
          />
        </Section>
        <Section id="record" title="Record yourself" status={recBusy ? 'Armed' : undefined} live={recBusy}>
          <RecordPanel scoreId={id} title={score.title} getPlayer={getPlayer} session={mic} playing={playing} onTempo={setBpm} onBusy={setRecBusy} />
        </Section>
        <Section id="band" title={parts.length > 1 ? `Band (${parts.length} parts)` : 'Band'}>
          <BandPanel
            parts={parts} myIdx={myIdx} mix={mix} full={full} scoreId={id} warnings={derived?.warnings ?? []}
            onMix={onMix} onMy={(i) => onPart(String(i))} onFull={onFull} onInstrument={onPartInstrument}
          />
        </Section>
        <Section id="fingerings" title={INSTRUMENTS[target].id === 'trombone' ? 'Slide positions' : 'Fingerings'} status={fingerings ? 'Shown' : undefined} live={fingerings}>
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
        <Section id="range" title={rangeIssues.length ? `Range (${rangeIssues.length} out of range)` : 'Range'} status={rangeOn ? 'Shown' : undefined} live={rangeOn && rangeIssues.length > 0}>
          <label className="chk wide">
            <input type="checkbox" checked={rangeOn} onChange={(e) => changeRangeOn(e.target.checked)} aria-label="Highlight notes out of range" /> Highlight notes out of range
          </label>
          <p className="small" data-testid="range-summary">
            {rangeIssues.length
              ? <>{describeRange(rangeIssues.map((i) => ({ ...i, measure: myEvents(tlNow!, myIdx)[i.index].measure })))}. Comfortable range for {INSTRUMENTS[target].name}: {rangeLabel(target)}.</>
              : <>Every note is inside the comfortable range for {INSTRUMENTS[target].name} ({rangeLabel(target)}).</>}
          </p>
          {loopNorm
            ? (
              <div className="prow">
                <button type="button" className="btn sm" onClick={() => moveLoop(-1)}>Drop bars {loopNorm.from}–{loopNorm.to} an octave (8vb)</button>
                <button type="button" className="btn sm" onClick={() => moveLoop(1)}>Raise bars {loopNorm.from}–{loopNorm.to} an octave (8va)</button>
                {inLoop.length > 0 && <span className="muted small" data-testid="range-offer">{inLoop.length} out-of-range note{inLoop.length > 1 ? 's' : ''} in the loop.</span>}
              </div>
            )
            : <p className="muted small">Loop the bars you want to move (in Loop and speed trainer), then drop or raise them an octave here.</p>}
          {myShifts.length > 0 && (
            <div className="prow">
              <span className="muted small" data-testid="range-moves">Moved: {myShifts.map((s) => `bars ${s.from}–${s.to} ${s.octaves > 0 ? '+' : ''}${s.octaves} oct`).join(', ')}</span>
              <button type="button" className="btn sm ghost" onClick={clearShifts}>Undo octave moves</button>
            </div>
          )}
        </Section>
      </PracticeSheet>
      {videoOpen && derived?.tl && (
        <VideoDialog
          title={score.title}
          instrumentName={INSTRUMENTS[target].name}
          bpm={bpm}
          tl={derived.tl}
          slide={target === 'trombone'}
          hasDrums={!!groove}
          initial={{ view: viewMode === 'twobar' ? 'twobar' : 'full', orientation: 'portrait', style: fingerStyle, drums: drums.on }}
          onChoose={(c) => changeFingerStyle(c.style)}
          onClose={() => setVideoOpen(false)}
          build={(c: VideoChoices): VideoJob => ({
            title: score.title, instrumentName: INSTRUMENTS[target].name, bpm, xml: derived.mineXml, tl: derived.tl!, myIdx, instrument: target,
            view: c.view, orientation: c.orientation, style: c.style,
            audio: {
              tl: derived.tl!, bpm,
              partInstruments: parts.map((p, i) => (i === myIdx ? target : p.instrument)),
              mix: parts.map((p) => mix[p.id] ?? DEFAULT_MIX),
              drumHits: drumEvents, drumSource: groove ? { groove, buffer: drumBuf?.id === groove.id ? drumBuf.buffer : null } : null,
              drumsOn: !!groove && c.drums, drumsVolume: drums.volume,
            },
          })}
        />
      )}
      {studioOpen && <GrooveStudio getCtx={() => player.current?.context ?? null} clickBpm={bpm} onClose={() => setStudioOpen(false)} onChanged={refreshGrooves} />}
      {toast && <p className="toast" role="status" data-testid="toast">{toast}</p>}
      <Transport
        playing={playing}
        measure={measure}
        measureCount={measureCount}
        barLabel={tlNow?.barLabels[measure - 1]}
        barTotal={tlNow?.barTotal}
        passLabel={loop && pass ? passLabel(pass.n, pass.bpm, trainer) : undefined}
        micLive={micLive}
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
