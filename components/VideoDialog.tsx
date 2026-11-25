'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import FingerStylePicker from './FingerStylePicker';
import { useModal } from './useModal';
import type { FingerStyle } from '@/lib/fingerStyle';
import { countInLead, estimateBytes, NO_LEAD, videoFileName, videoSeconds, VIDEO_TAIL_S, WARN_BYTES, type VideoOrientation, type VideoView } from '@/lib/videoPlan';
import type { VideoJob, VideoResult } from '@/lib/videoRender';
import { canShareFile, isApple, isIOS, saveWays, type Route, type SaveWays } from '@/lib/videoSupport';
import type { Timeline } from '@/lib/timeline';

export interface VideoChoices { view: VideoView; orientation: VideoOrientation; style: FingerStyle; drums: boolean; countIn: boolean; loopOnly: boolean }

interface Props {
  title: string;
  instrumentName: string;
  bpm: number;
  tl: Timeline;
  slide: boolean;
  /** The practice loop, if one is set: the video can be of just those bars. `words` is e.g. "bars 9-12". */
  loop?: { tl: Timeline; words: string } | null;
  /** A groove is chosen for this score: the drums can be part of the video. */
  hasDrums: boolean;
  initial: VideoChoices;
  /** Everything the video is made of, for the choices made here. */
  build: (c: VideoChoices) => VideoJob;
  /** Remember the view and fingering style the person picked. */
  onChoose?: (c: VideoChoices) => void;
  onClose: () => void;
}

const mb = (n: number) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${Math.max(1, Math.round(n / 1048576))} MB`);
const mmss = (s: number) => { const r = Math.max(0, Math.round(s)); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`; };

type Done = VideoResult & { url: string; name: string; file: File | null; ways: SaveWays; silent: boolean };

/** What the person is told about the file before it is made. */
function routeLine(route: Route | null, seconds: number): { text: string; warn?: boolean } {
  if (!route) return { text: 'Checking what this browser can make…' };
  if (route.kind === 'mp4' && route.audio === 'aac') return { text: 'You get an MP4 video. It plays on iPhone and Android and can go to Photos and WhatsApp.' };
  if (route.kind === 'mp4') return { text: 'You get an MP4 video (H.264 picture, Opus sound). It plays in browsers and on Android; on an iPhone the sound may be missing in some apps.' };
  if (route.kind === 'webm') return { text: 'This browser can only make a WebM video. It plays in Chrome, Firefox and on Android, but not in iPhone Photos. For an MP4, make the video on an iPhone or in Chrome on Android.', warn: true };
  if (route.kind === 'realtime') return { text: `This browser records the video while it plays, so it takes as long as the song (${mmss(seconds)}). Keep this page open and the screen on until it is done. You get ${route.ext === 'mp4' ? 'an MP4' : 'a WebM'} video.`, warn: true };
  return { text: 'This browser cannot make a video file. Try Safari on an iPhone, or Chrome on Android or a computer.', warn: true };
}

export default function VideoDialog({ title, instrumentName, bpm, tl: wholeTl, loop, slide, hasDrums, initial, build, onChoose, onClose }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [c, setC] = useState<VideoChoices>(initial);
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [prog, setProg] = useState<{ f: number; label: string; left: number | null }>({ f: 0, label: '', left: null });
  const [res, setRes] = useState<Done | null>(null);
  const [err, setErr] = useState('');
  const [shareMsg, setShareMsg] = useState('');
  const [routes, setRoutes] = useState<Record<VideoOrientation, Route> | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  const preview = useRef<HTMLDivElement>(null);
  const live = useRef<AudioContext | null>(null);
  const close = () => { ctl.current?.abort(); onClose(); };
  useModal({ open: true, ref: root, onClose: close, inert: ['.topbar', 'main.page', '.sheet', '.transport'], returnTo: '[data-testid="download-video"]' });
  useEffect(() => () => {
    ctl.current?.abort();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    try { void live.current?.close(); } catch { /* ignore */ }
  }, []);

  // what this browser can make, known before the button is tapped (the real-time way needs sound started by that tap)
  useEffect(() => {
    let off = false;
    const none: Route = { kind: 'none' };
    void import('@/lib/videoRender').then(async (m) => {
      // for checking the sound from outside (tests): the pieces it is made in must join without a seam
      const w = window as unknown as Record<string, unknown>;
      if (w.__brTest) w.__brVideoLib = m;
      return { portrait: await m.videoRoute('portrait'), landscape: await m.videoRoute('landscape') };
    }).then((r) => { if (!off) setRoutes(r); }, () => { if (!off) setRoutes({ portrait: none, landscape: none }); });
    return () => { off = true; };
  }, []);
  const route = routes ? routes[c.orientation] : null;
  // a phone's encoder may take one shape and not the other
  const other: VideoOrientation = c.orientation === 'portrait' ? 'landscape' : 'portrait';
  const otherIsMp4 = !!routes && route?.kind !== 'mp4' && routes[other].kind === 'mp4';

  const loopOnly = !!loop && c.loopOnly;
  const tl = loopOnly ? loop!.tl : wholeTl;
  const lead = useMemo(() => (c.countIn ? countInLead(tl, bpm) : NO_LEAD), [c.countIn, tl, bpm]);
  const seconds = videoSeconds(tl, bpm, lead);
  const bytes = estimateBytes(seconds);
  const set = (p: Partial<VideoChoices>) => { const n = { ...c, ...p }; setC(n); onChoose?.(n); };
  const info = routeLine(route, seconds);
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    if (w.__brTest) w.__brVideoJob = () => build(c);
  });

  async function make() {
    if (!route || route.kind === 'none') return;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    const ios = isIOS(nav.userAgent ?? '', nav.platform ?? '', nav.maxTouchPoints ?? 0);
    // sound for the real-time way has to be started by this very tap (also kept ready on Apple devices in case the quick way fails)
    const apple = isApple(nav.userAgent ?? '', nav.platform ?? '', nav.maxTouchPoints ?? 0);
    if ((route.kind === 'realtime' || apple) && (!live.current || live.current.state === 'closed')) {
      try {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        live.current = new AC();
        void live.current.resume().catch(() => {});
      } catch { live.current = null; }
    }
    setPhase('busy'); setErr(''); setShareMsg(''); setProg({ f: 0, label: 'Starting', left: null });
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    setRes(null);
    const ac = new AbortController();
    ctl.current = ac;
    // keep the screen awake while it works
    let lock: { release: () => Promise<void> } | null = null;
    try { lock = (await nav.wakeLock?.request('screen')) ?? null; } catch { lock = null; }
    const started = performance.now();
    try {
      const { makeVideo, VideoCancelled } = await import('@/lib/videoRender');
      try {
        const out = await makeVideo(build(c), {
          signal: ac.signal, route, liveCtx: live.current,
          onProgress: (f, label) => {
            const el = (performance.now() - started) / 1000;
            setProg({ f, label, left: f > 0.1 && el > 2 ? (el * (1 - f)) / f : null });
          },
          onCanvas: (canvas) => { const box = preview.current; if (box) { box.textContent = ''; box.appendChild(canvas); } },
        });
        const url = URL.createObjectURL(out.blob);
        urlRef.current = url;
        const name = videoFileName(title, instrumentName, bpm, out.ext, loopOnly ? loop!.words : '');
        let file: File | null = null;
        try { file = new File([out.blob], name, { type: out.mime }); } catch { file = null; }
        const touch = (nav.maxTouchPoints ?? 0) > 0;
        const ways = saveWays(!!file && canShareFile(file), ios, touch);
        const silent = out.audio.rms.length > 0 && out.audio.rms.every((v) => v < 1e-4);
        setRes({ ...out, url, name, file, ways, silent });
        (window as unknown as Record<string, unknown>).__brVideo = {
          kind: out.kind, ext: out.ext, mime: out.mime, bytes: out.bytes, durationS: out.durationS, frames: out.frames, name,
          format: out.format, engine: out.audio.engine, rms: out.audio.rms, makeS: (performance.now() - started) / 1000,
        };
        setPhase('done');
      } catch (e) {
        if (e instanceof VideoCancelled || ac.signal.aborted) { setPhase('idle'); return; }
        throw e;
      }
    } catch (e) {
      setErr((e as Error).message || 'The video could not be made.');
      setPhase('error');
    } finally {
      try { await lock?.release(); } catch { /* ignore */ }
      if (preview.current) preview.current.textContent = '';
    }
  }
  const cancel = () => { ctl.current?.abort(); };

  /** The share sheet (on an iPhone: "Save Video" puts it in Photos; WhatsApp is in the same list). Runs inside the tap. */
  function share() {
    if (!res?.file) return;
    setShareMsg('');
    const nav = navigator as Navigator & { share?: (d: { files: File[]; title?: string }) => Promise<void> };
    try {
      void nav.share?.({ files: [res.file], title: res.name.replace(/\.\w+$/, '') }).catch((e: Error) => {
        if (e?.name !== 'AbortError') setShareMsg('Sharing did not work here. Use "Download file" instead.');
      });
    } catch { setShareMsg('Sharing did not work here. Use "Download file" instead.'); }
  }

  const busy = phase === 'busy';
  const cannot = route?.kind === 'none';
  return (
    <div className="vdlg-back" data-testid="video-backdrop">
      <div className="vdlg" ref={root} role="dialog" aria-modal="true" aria-labelledby="vdlg-title" data-testid="video-dialog">
        <div className="vdlg-head">
          <h2 id="vdlg-title" data-autofocus tabIndex={-1}>Download video</h2>
          <button type="button" className="iconbtn" aria-label="Close" onClick={close}>✕</button>
        </div>
        <div className="vdlg-body">
          <p className="muted small">{title}{loopOnly ? `, ${loop!.words}` : ''} · {instrumentName} · {Math.round(bpm)} BPM · {mmss(seconds - VIDEO_TAIL_S - lead.seconds)}. Tempo and instrument are the ones set on the score screen.</p>
          {!busy && phase !== 'done' && (
            <>
              <div className="seg-wrap">
                <span className="seg-label">View</span>
                <div className="seg" role="radiogroup" aria-label="Video view" data-testid="video-view">
                  <button type="button" role="radio" aria-checked={c.view === 'twobar'} className={c.view === 'twobar' ? 'on' : ''} onClick={() => set({ view: 'twobar' })}>2 bars</button>
                  <button type="button" role="radio" aria-checked={c.view === 'full'} className={c.view === 'full' ? 'on' : ''} onClick={() => set({ view: 'full' })}>Full sheet</button>
                </div>
              </div>
              <div className="seg-wrap">
                <span className="seg-label">Shape</span>
                <div className="seg" role="radiogroup" aria-label="Video shape" data-testid="video-orientation">
                  <button type="button" role="radio" aria-checked={c.orientation === 'portrait'} className={c.orientation === 'portrait' ? 'on' : ''} onClick={() => set({ orientation: 'portrait' })}>Portrait 1080×1920</button>
                  <button type="button" role="radio" aria-checked={c.orientation === 'landscape'} className={c.orientation === 'landscape' ? 'on' : ''} onClick={() => set({ orientation: 'landscape' })}>Landscape 1920×1080</button>
                </div>
              </div>
              <FingerStylePicker value={c.style} onChange={(s) => set({ style: s })} label={slide ? 'Slide positions' : 'Fingerings'} slide={slide} testId="video-finger-style" />
              <div className="vdlg-checks">
                {loop && (
                  <label className="chk wide">
                    <input type="checkbox" checked={c.loopOnly} onChange={(e) => set({ loopOnly: e.target.checked })} aria-label="Only the looped bars" /> Only the looped {loop.words}
                  </label>
                )}
                <label className="chk wide">
                  <input type="checkbox" checked={c.countIn} onChange={(e) => set({ countIn: e.target.checked })} aria-label="Count-in bar" /> Count-in bar before the music
                </label>
                <label className="chk wide">
                  <input type="checkbox" checked={c.drums && hasDrums} disabled={!hasDrums} onChange={(e) => set({ drums: e.target.checked })} aria-label="Include drums" /> Include drums{!hasDrums ? ' (none chosen for this score)' : ''}
                </label>
              </div>
              <p className={`small ${info.warn ? 'vnote' : 'muted'}`} data-testid="video-route" data-route={route ? (route.kind === 'mp4' ? `mp4-${route.audio}` : route.kind === 'realtime' ? `realtime-${route.ext}` : route.kind) : ''}>{info.text}</p>
              {otherIsMp4 && <p className="muted small" data-testid="video-shape-tip">Tip: {other === 'landscape' ? 'Landscape' : 'Portrait'} can be made as an MP4 on this device, and faster.</p>}
              {!cannot && <p className="muted small" data-testid="video-estimate">{mmss(seconds)} long, up to about {mb(bytes)}{bytes > WARN_BYTES ? '. That is a lot for a phone: it may run out of memory. Try a faster tempo or a shorter song.' : '.'}</p>}
            </>
          )}

          <div className="vprev" ref={preview} data-testid="video-preview" hidden={!busy} aria-hidden="true" />
          {busy && (
            <div className="vprog" data-testid="video-progress">
              <div className="vbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(prog.f * 100)}><i style={{ width: `${Math.round(prog.f * 100)}%` }} /></div>
              <p className="small" role="status">{prog.label}… {Math.round(prog.f * 100)}%{prog.left !== null && route?.kind !== 'realtime' ? `, about ${mmss(prog.left)} left` : ''}</p>
              <p className="muted small">Keep this page open until it is done.</p>
            </div>
          )}
          {phase === 'error' && <p className="error" role="alert" data-testid="video-error">{err}</p>}
          {phase === 'done' && res && (
            <div className="vdone" data-testid="video-done" data-kind={res.kind} data-ext={res.ext} data-bytes={res.bytes} data-duration={res.durationS.toFixed(2)}>
              <p><strong>Your video is ready.</strong> {res.format}. {mb(res.bytes)}, {mmss(res.durationS)}, {res.width}×{res.height}.</p>
              {res.note && <p className="small vnote">{res.note}</p>}
              {res.audio.engine === 'synth' && !res.silent && <p className="small vnote" data-testid="video-synth">The horn samples could not be loaded, so this video has the simple synth sound. Open the score once with a signal (the samples are then kept on the phone) and make it again.</p>}
              {res.silent && <p className="small vnote" data-testid="video-silent">This video has no sound: every part is muted in Band, and there are no drums.</p>}
              <div className="vsave">
                {res.ways.share && (
                  <button type="button" className={`btn${res.ways.primary === 'share' ? ' primary' : ''}`} onClick={share} data-testid="video-share">{res.ext === 'mp4' ? 'Save to Photos or share' : 'Share'}</button>
                )}
                <a className={`btn${res.ways.primary === 'download' ? ' primary' : ''}`} href={res.url} download={res.name} data-testid="video-save">{res.ways.share ? 'Download file' : `Save ${res.name}`}</a>
              </div>
              {res.ways.share && res.ways.primary === 'share' && res.ext === 'mp4' && <p className="muted small">Tap “Save to Photos or share”, then “Save Video” to keep it in Photos, or pick WhatsApp to send it. “Download file” puts it in the Files app.</p>}
              {shareMsg && <p className="small vnote" role="status">{shareMsg}</p>}
              <video className="vplay" src={res.url} controls playsInline preload="metadata" data-testid="video-player" />
              {res.ways.share && <p className="muted small vname">{res.name}</p>}
            </div>
          )}
        </div>
        <div className="vdlg-foot">
          {busy && <button type="button" className="btn" onClick={cancel} data-testid="video-cancel">Cancel</button>}
          {!busy && phase !== 'done' && <button type="button" className="btn primary" onClick={make} disabled={!route || cannot} data-testid="video-make">Make video</button>}
          {!busy && phase === 'done' && <button type="button" className="btn" onClick={() => { setPhase('idle'); }} data-testid="video-again">Make another</button>}
          <button type="button" className="btn ghost" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
