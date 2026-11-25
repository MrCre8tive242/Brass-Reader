'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { unlockAudio } from '@/lib/audioUnlock';
import { micErrorMessage } from '@/lib/pitch';
import { MAX_RECORD_S, startPcmRecorder, type PcmRecorder } from '@/lib/pcmRecorder';
import { analyzeRecording, type Analysis } from '@/lib/grooveAnalyze';
import { bpmFromTaps, buildSlices, detectOnsets, encodeWav, loopSeconds, peakLevel, recordingLevel } from '@/lib/grooveAnalysis';
import { SLICE_VERSION, type Feel, type Groove } from '@/lib/groove';
import { newId } from '@/lib/library';
import type { StoredGroove } from '@/lib/grooveStore';
import { AlertIcon, MicIcon } from './Icons';
import NumField from './NumField';
import Waveform from './Waveform';
import { useGroovePreview } from './useGroovePreview';

interface RecordProps {
  getCtx: () => AudioContext | null;
  clickBpm: number;
  onDone: (rec: { samples: Float32Array; rate: number; analysis: Analysis }) => void;
  onCancel: () => void;
}

/** "1 Record, 2 Check tempo, 3 Save": where the player is in making a groove. */
export function RecorderSteps({ current }: { current: 1 | 2 | 3 }) {
  const steps = ['Record', 'Check tempo', 'Save'];
  return (
    <ol className="steps" aria-label="Steps to make a groove" data-testid="rec-steps">
      {steps.map((w, i) => (
        <li key={w} className={i + 1 === current ? 'cur' : i + 1 < current ? 'done' : ''} aria-current={i + 1 === current ? 'step' : undefined}>
          <span className="n" aria-hidden>{i + 1}</span> {w}
        </li>
      ))}
    </ol>
  );
}

function click(ctx: AudioContext, t: number, accent: boolean) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = accent ? 1500 : 1000;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.6, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g); g.connect(ctx.destination);
  o.start(t); o.stop(t + 0.06);
}

type Phase = 'idle' | 'counting' | 'recording' | 'analysing';

/** Record the drummers: count-in click, level meter, up to 30 seconds. */
export function GrooveRecorder({ getCtx, clickBpm, onDone, onCancel }: RecordProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [tempo, setTempo] = useState(Math.round(clickBpm));
  const [countIn, setCountIn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [secs, setSecs] = useState(0);
  const rec = useRef<PcmRecorder | null>(null);
  const meter = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  const countInS = useRef<number | null>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  useEffect(() => () => { cancelAnimationFrame(raf.current); rec.current?.cancel(); }, []);

  async function stop() {
    const r = rec.current;
    if (!r || phaseRef.current === 'analysing' || phaseRef.current === 'idle') return;
    rec.current = null;
    cancelAnimationFrame(raf.current);
    setPhase('analysing');
    const ctx = getCtx()!;
    const { samples, rate } = await r.stop();
    if (samples.length < rate * 1.5) { setError('That was too short to work with. Record at least a couple of seconds of the drums.'); setPhase('idle'); return; }
    try {
      const analysis = await analyzeRecording(ctx, samples, rate, { countInS: countInS.current, clickBpm: tempo });
      onDone({ samples, rate, analysis });
    } catch (e) {
      setError(`Could not read the recording: ${(e as Error).message}`);
      setPhase('idle');
    }
  }

  async function start() {
    const ctx = getCtx();
    if (!ctx) return;
    setError(null);
    unlockAudio(ctx);
    try { await ctx.resume(); } catch { /* ignore */ }
    try {
      rec.current = await startPcmRecorder(ctx, () => { void stop(); });
    } catch (e) { setError(micErrorMessage(e)); return; }
    const r = rec.current;
    const beat = 60 / tempo;
    if (countIn) {
      const t0 = ctx.currentTime + 0.15;
      for (let k = 0; k < 4; k++) click(ctx, t0 + k * beat, k === 0);
      // where bar 1 starts in the recording: the clicks reach the players a little late (the speaker's own delay)
      countInS.current = r.elapsed() + (t0 - ctx.currentTime) + 4 * beat + (Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0);
      setPhase('counting');
      setTimeout(() => { if (phaseRef.current === 'counting') setPhase('recording'); }, (0.15 + 4 * beat) * 1000);
    } else { countInS.current = null; setPhase('recording'); }
    let last = 0;
    const frame = (now: number) => {
      if (!rec.current) return;
      if (meter.current) {
        const lv = rec.current.level();
        meter.current.style.width = `${Math.round(lv * 100)}%`;
        meter.current.parentElement?.setAttribute('data-level', lv.toFixed(2));
      }
      if (now - last > 250) { last = now; setSecs(rec.current.elapsed()); }
      raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
  }

  const busy = phase !== 'idle';
  return (
    <div className="grec" data-testid="groove-recorder">
      <RecorderSteps current={1} />
      <p className="muted small">Put the phone near the drums. Use headphones for the count-in click so the microphone does not hear it. Record a few bars of the drum line (one to four is plenty). Next you pick how many bars make the loop. The longest recording is {MAX_RECORD_S} seconds.</p>
      {error && <p className="error" role="alert"><AlertIcon size={18} /> {error}</p>}
      <div className="prow">
        <span className="plabel">Click tempo</span>
        <NumField value={tempo} label="Click tempo" min={40} max={240} onCommit={setTempo} />
        <label className="chk"><input type="checkbox" checked={countIn} disabled={busy} onChange={(e) => setCountIn(e.target.checked)} aria-label="Count-in click" /> Count-in click</label>
      </div>
      <div className="meter" role="meter" aria-label="Level" aria-valuemin={0} aria-valuemax={1} data-testid="level-meter" data-level="0"><div ref={meter} className="meter-bar" /></div>
      <p className="recstate" role="status" data-testid="rec-state">
        {phase === 'idle' && 'Ready.'}
        {phase === 'counting' && 'Count-in… get ready.'}
        {phase === 'recording' && <span className="recdot">Recording {secs.toFixed(1)} s</span>}
        {phase === 'analysing' && 'Listening to the recording…'}
      </p>
      <div className="prow">
        {phase === 'idle'
          ? <button type="button" className="btn primary" onClick={start}><MicIcon size={20} /> Start recording</button>
          : <button type="button" className="btn primary" onClick={stop} disabled={phase === 'analysing'}>Stop recording</button>}
        <button type="button" className="btn ghost" onClick={() => { rec.current?.cancel(); rec.current = null; cancelAnimationFrame(raf.current); onCancel(); }}>Cancel</button>
      </div>
    </div>
  );
}

interface ReviewProps {
  getCtx: () => AudioContext | null;
  samples: Float32Array;
  rate: number;
  analysis: Analysis;
  /** Present when an existing groove is being edited. */
  existing?: StoredGroove;
  wav?: Blob;
  onSave: (g: StoredGroove) => void;
  onCancel: () => void;
}

/** Tempo, bar count, downbeat and quantize for a recording; hear the loop; save it. */
export function GrooveReview({ getCtx, samples, rate, analysis, existing, wav, onSave, onCancel }: ReviewProps) {
  const dur = samples.length / rate;
  const [bpm, setBpm] = useState(existing?.bpm ?? analysis.detected?.bpm ?? 100);
  const [bars, setBars] = useState<number>(existing?.bars ?? analysis.bars);
  const [down, setDown] = useState(existing?.downbeatS ?? analysis.downbeatS);
  const [quant, setQuant] = useState(existing?.quantize ?? 0);
  const [feel, setFeel] = useState<Feel>(existing?.feel ?? 'straight');
  const [name, setName] = useState(existing?.name ?? `Drum line ${new Date().toLocaleDateString()}`);
  const taps = useRef<number[]>([]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // "More hits" / "Fewer hits" listens again with a finer or coarser ear; until then the hits are the ones found (or saved) before
  const [sens, setSens] = useState<number | null>(null);
  const found = useMemo(() => {
    if (sens === null) return { times: analysis.onsets, starts: analysis.starts };
    const o = detectOnsets(samples, rate, sens);
    return { times: o.times, starts: o.starts };
  }, [sens, analysis.onsets, analysis.starts, samples, rate]);
  const slices = useMemo(() => buildSlices(found.times, dur, down, bpm, bars, found.starts), [found, dur, down, bpm, bars]);
  // a quiet phone recording is brought up so the drums sit with the horns (and a clipped one is left alone)
  const gain = useMemo(() => {
    const peak = peakLevel(samples, rate, down, down + loopSeconds(bars, bpm));
    return peak > 0.01 ? Math.round(Math.max(0.5, Math.min(8, 0.9 / peak)) * 100) / 100 : 1;
  }, [samples, rate, down, bars, bpm]);
  const groove = useMemo<Groove>(() => ({
    id: existing?.id ?? 'preview', name, kind: 'recorded', createdAt: existing?.createdAt ?? Date.now(), bpm, bars, feel, quantize: quant,
    downbeatS: down, onsets: found.times, ...(found.starts ? { onsetStarts: found.starts } : {}), slices, durationS: dur, gain, v: SLICE_VERSION,
  }), [existing, name, bpm, bars, feel, quant, down, found, slices, dur, gain]);

  const buffer = useMemo(() => {
    const ctx = getCtx();
    if (!ctx) return null;
    const b = ctx.createBuffer(1, samples.length, rate);
    b.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    return b;
  }, [getCtx, samples, rate]);
  const preview = useGroovePreview(getCtx);

  const heard = useMemo(() => recordingLevel(samples).verdict, [samples]);
  const barS = loopSeconds(1, bpm);
  const fits = Math.floor(((dur - down) / barS) + 0.12);
  const tooLong = bars > Math.max(1, fits);

  function tap() {
    const now = performance.now() / 1000;
    taps.current = [...taps.current.filter((t) => now - t < 2.5), now];
    const b = bpmFromTaps(taps.current);
    if (b && b >= 30 && b <= 300) setBpm(b);
  }
  /** The tempo was heard an octave out (80 for 160 or the other way): fix it and keep the same stretch of the recording as the loop. */
  function octave(up: boolean) {
    const b = up ? bpm * 2 : bpm / 2;
    if (b < 30 || b > 300) return;
    setBpm(Math.round(b * 10) / 10);
    setBars((n) => (up ? Math.min(4, n * 2) : Math.max(1, n / 2)));
  }
  const nudge = (ms: number) => setDown((d) => Math.max(0, Math.min(dur, Math.round((d + ms / 1000) * 1000) / 1000)));

  function save() {
    const g: StoredGroove = {
      ...groove, id: existing?.id ?? newId(), name: name.trim() || 'Drum line',
      audio: existing?.audio ?? new Blob([wav ? wav : (encodeWav(samples, rate) as BlobPart)], { type: 'audio/wav' }),
    };
    onSave(g);
  }

  return (
    <div className="grec" data-testid="groove-review">
      <RecorderSteps current={2} />
      <h3 className="stephead"><span className="n" aria-hidden>2</span> Check the tempo and the downbeat</h3>
      {found.times.length === 0 && <p className="error" role="alert"><AlertIcon size={18} /> No drum hits were found. Move the phone closer, or record again louder.</p>}
      {heard === 'hot' && <p className="muted small" data-testid="level-note">The drums overloaded the microphone. The groove still works, but it will sound cleaner recorded from a few steps further back.</p>}
      {heard === 'quiet' && found.times.length > 0 && <p className="muted small" data-testid="level-note">That was very quiet. It has been turned up, but a recording from closer to the drums will sound better.</p>}
      <Waveform samples={samples} rate={rate} onsets={found.times} downbeatS={down} loopS={loopSeconds(bars, bpm)} barS={barS} onDownbeat={(s) => setDown(Math.round(s * 1000) / 1000)} />
      <div className="prow">
        <span className="plabel">Downbeat (beat 1)</span>
        <button type="button" className="btn sm" onClick={() => nudge(-10)} aria-label="Move the downbeat 10 milliseconds earlier">−10 ms</button>
        <button type="button" className="btn sm" onClick={() => nudge(10)} aria-label="Move the downbeat 10 milliseconds later">+10 ms</button>
        <span className="muted small" data-testid="downbeat-readout">{down.toFixed(3)} s</span>
      </div>
      <p className="muted small">Drag the marker on the picture (it snaps to a hit) so it sits on the first beat of the bar.</p>
      <div className="prow">
        <span className="plabel">Tempo</span>
        <NumField value={Math.round(bpm * 10) / 10} label="Tempo BPM" min={30} max={300} decimal onCommit={setBpm} />
        <button type="button" className="btn sm" onClick={() => octave(false)} disabled={bpm / 2 < 30} aria-label="Half the tempo">½×</button>
        <button type="button" className="btn sm" onClick={() => octave(true)} disabled={bpm * 2 > 300} aria-label="Double the tempo">2×</button>
        <button type="button" className="btn sm" onClick={tap}>Tap tempo</button>
        {analysis.detected && <button type="button" className="linkbtn" onClick={() => setBpm(analysis.detected!.bpm)} data-testid="detected">Detected {analysis.detected.bpm} BPM</button>}
      </div>
      <div className="prow" role="group" aria-label="Bars in the loop">
        <span className="plabel">Bars</span>
        {[1, 2, 4].map((n) => <button key={n} type="button" className={`btn sm${bars === n ? ' on' : ''}`} aria-pressed={bars === n} onClick={() => setBars(n)}>{n}</button>)}
        {tooLong && <span className="muted small">The recording after the downbeat is shorter than {bars} bars.</span>}
      </div>
      <div className="prow" role="group" aria-label="Hits found">
        <span className="plabel">Hits found</span>
        <button type="button" className="btn sm" onClick={() => setSens((v) => Math.max(0.35, (v ?? 1) / 1.5))} disabled={(sens ?? 1) <= 0.36} aria-label="Find fewer hits">Fewer</button>
        <button type="button" className="btn sm" onClick={() => setSens((v) => Math.min(3.4, (v ?? 1) * 1.5))} disabled={(sens ?? 1) >= 3.3} aria-label="Find more hits">More</button>
        <span className="muted small" data-testid="hits-found">{found.times.length} in the recording</span>
      </div>
      <div className="prow">
        <label className="plabel" htmlFor="quant">Tighten the timing {Math.round(quant * 100)}%</label>
        <input id="quant" type="range" min={0} max={100} value={Math.round(quant * 100)} onChange={(e) => setQuant(Number(e.target.value) / 100)} aria-label="Quantize" className="grow" />
      </div>
      <div className="prow" role="group" aria-label="Snap to">
        <span className="plabel">Snap hits to</span>
        {(['straight', 'triplet'] as Feel[]).map((f) => <button key={f} type="button" className={`btn sm${feel === f ? ' on' : ''}`} aria-pressed={feel === f} onClick={() => setFeel(f)}>{f === 'straight' ? 'Sixteenths' : 'Triplets'}</button>)}
      </div>
      <p className="muted small">0% keeps the drummers&apos; own feel. 100% puts every hit exactly on the grid.</p>
      <h3 className="stephead"><span className="n" aria-hidden>3</span> Name it and save</h3>
      <label className="field">
        <span className="plabel">Name</span>
        <input type="text" className="txt" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="Groove name" />
      </label>
      <div className="prow sticky-bar" data-testid="review-bar">
        <button type="button" className="btn" onClick={() => (preview.playing ? preview.stop() : preview.play(groove, buffer, bpm))} aria-label={preview.playing ? 'Stop the loop' : 'Hear the loop'}>{preview.playing ? 'Stop' : 'Hear the loop'}</button>
        <button type="button" className="btn primary" onClick={() => { preview.stop(); save(); }} disabled={slices.length === 0}>Save groove</button>
        <button type="button" className={`btn ghost${confirmDiscard ? ' danger' : ''}`} onClick={() => { preview.stop(); if (existing || confirmDiscard) onCancel(); else setConfirmDiscard(true); }}>{existing ? 'Close' : confirmDiscard ? 'Really discard?' : 'Discard'}</button>
        <span className="muted small" data-testid="slice-count">{slices.length} hits in the loop</span>
      </div>
    </div>
  );
}
