'use client';
import { useEffect, useRef, useState } from 'react';
import FingerStylePicker from './FingerStylePicker';
import { useModal } from './useModal';
import type { FingerStyle } from '@/lib/fingerStyle';
import { estimateBytes, videoFileName, videoSeconds, VIDEO_TAIL_S, WARN_BYTES, type VideoOrientation, type VideoView } from '@/lib/videoPlan';
import type { VideoJob, VideoResult } from '@/lib/videoRender';
import type { Timeline } from '@/lib/timeline';

export interface VideoChoices { view: VideoView; orientation: VideoOrientation; style: FingerStyle; drums: boolean }

interface Props {
  title: string;
  instrumentName: string;
  bpm: number;
  tl: Timeline;
  slide: boolean;
  /** A groove is chosen for this score: the drums can be part of the video. */
  hasDrums: boolean;
  initial: VideoChoices;
  /** Everything the video is made of, for the choices made here. */
  build: (c: VideoChoices) => VideoJob;
  /** Remember the view and fingering style the person picked. */
  onChoose?: (c: VideoChoices) => void;
  onClose: () => void;
}

const mb = (n: number) => `${Math.max(1, Math.round(n / 1048576))} MB`;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export default function VideoDialog({ title, instrumentName, bpm, tl, slide, hasDrums, initial, build, onChoose, onClose }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [c, setC] = useState<VideoChoices>(initial);
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [prog, setProg] = useState<{ f: number; label: string }>({ f: 0, label: '' });
  const [res, setRes] = useState<(VideoResult & { url: string; name: string }) | null>(null);
  const [err, setErr] = useState('');
  const ctl = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  const close = () => { ctl.current?.abort(); onClose(); };
  useModal({ open: true, ref: root, onClose: close, inert: ['.topbar', 'main.page', '.sheet', '.transport'], returnTo: '[data-testid="download-video"]' });
  useEffect(() => () => { ctl.current?.abort(); if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const seconds = videoSeconds(tl, bpm);
  const bytes = estimateBytes(seconds);
  const set = (p: Partial<VideoChoices>) => { const n = { ...c, ...p }; setC(n); onChoose?.(n); };

  async function make() {
    setPhase('busy'); setErr(''); setProg({ f: 0, label: 'Starting' });
    const ac = new AbortController();
    ctl.current = ac;
    try {
      const { makeVideo, VideoCancelled } = await import('@/lib/videoRender');
      try {
        const out = await makeVideo(build(c), { signal: ac.signal, onProgress: (f, label) => setProg({ f, label }) });
        const url = URL.createObjectURL(out.blob);
        urlRef.current = url;
        const name = videoFileName(title, instrumentName, bpm, out.ext);
        setRes({ ...out, url, name });
        (window as unknown as Record<string, unknown>).__brVideo = { kind: out.kind, ext: out.ext, mime: out.mime, bytes: out.bytes, durationS: out.durationS, frames: out.frames, name };
        setPhase('done');
      } catch (e) {
        if (e instanceof VideoCancelled || ac.signal.aborted) { setPhase('idle'); return; }
        throw e;
      }
    } catch (e) {
      setErr((e as Error).message || 'The video could not be made.');
      setPhase('error');
    }
  }
  const cancel = () => { ctl.current?.abort(); };

  const busy = phase === 'busy';
  return (
    <div className="vdlg-back" data-testid="video-backdrop">
      <div className="vdlg" ref={root} role="dialog" aria-modal="true" aria-labelledby="vdlg-title" data-testid="video-dialog">
        <div className="vdlg-head">
          <h2 id="vdlg-title" data-autofocus tabIndex={-1}>Download video</h2>
          <button type="button" className="iconbtn" aria-label="Close" onClick={close}>✕</button>
        </div>
        <div className="vdlg-body">
          <p className="muted small">{title} · {instrumentName} · {Math.round(bpm)} BPM · {mmss(seconds - VIDEO_TAIL_S)}. Tempo and instrument are the ones set on the score screen.</p>
          <div className="seg-wrap">
            <span className="seg-label">View</span>
            <div className="seg" role="radiogroup" aria-label="Video view" data-testid="video-view">
              <button type="button" role="radio" aria-checked={c.view === 'twobar'} className={c.view === 'twobar' ? 'on' : ''} disabled={busy} onClick={() => set({ view: 'twobar' })}>2 bars</button>
              <button type="button" role="radio" aria-checked={c.view === 'full'} className={c.view === 'full' ? 'on' : ''} disabled={busy} onClick={() => set({ view: 'full' })}>Full sheet</button>
            </div>
          </div>
          <div className="seg-wrap">
            <span className="seg-label">Shape</span>
            <div className="seg" role="radiogroup" aria-label="Video shape" data-testid="video-orientation">
              <button type="button" role="radio" aria-checked={c.orientation === 'portrait'} className={c.orientation === 'portrait' ? 'on' : ''} disabled={busy} onClick={() => set({ orientation: 'portrait' })}>Portrait 1080×1920</button>
              <button type="button" role="radio" aria-checked={c.orientation === 'landscape'} className={c.orientation === 'landscape' ? 'on' : ''} disabled={busy} onClick={() => set({ orientation: 'landscape' })}>Landscape 1920×1080</button>
            </div>
          </div>
          <fieldset className="vdlg-fs" disabled={busy}>
            <FingerStylePicker value={c.style} onChange={(s) => set({ style: s })} label={slide ? 'Slide positions' : 'Fingerings'} slide={slide} testId="video-finger-style" />
          </fieldset>
          <label className="chk wide">
            <input type="checkbox" checked={c.drums && hasDrums} disabled={busy || !hasDrums} onChange={(e) => set({ drums: e.target.checked })} aria-label="Include drums" /> Include drums{!hasDrums ? ' (none chosen for this score)' : ''}
          </label>
          <p className="muted small" data-testid="video-estimate">About {mb(bytes)}{bytes > WARN_BYTES ? '. That is a lot for a phone: it may run out of memory. Try the 2-bar view or a shorter song.' : '.'}</p>

          {busy && (
            <div className="vprog" data-testid="video-progress">
              <div className="vbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(prog.f * 100)}><i style={{ width: `${Math.round(prog.f * 100)}%` }} /></div>
              <p className="small" role="status">{prog.label}… {Math.round(prog.f * 100)}%</p>
            </div>
          )}
          {phase === 'error' && <p className="error" role="alert" data-testid="video-error">{err}</p>}
          {phase === 'done' && res && (
            <div className="vdone" data-testid="video-done" data-kind={res.kind} data-ext={res.ext} data-bytes={res.bytes} data-duration={res.durationS.toFixed(2)}>
              <p><strong>Your video is ready.</strong> {res.format}. {mb(res.bytes)}, {mmss(res.durationS)}, {res.width}×{res.height}.</p>
              <a className="btn primary" href={res.url} download={res.name} data-testid="video-save">Save {res.name}</a>
            </div>
          )}
        </div>
        <div className="vdlg-foot">
          {busy
            ? <button type="button" className="btn" onClick={cancel} data-testid="video-cancel">Cancel</button>
            : <button type="button" className="btn primary" onClick={make} data-testid="video-make">{phase === 'done' ? 'Make it again' : 'Make video'}</button>}
          <button type="button" className="btn ghost" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
