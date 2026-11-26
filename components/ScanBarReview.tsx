'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cropScanPage, previewScanPage, type FileInput, type OmrResponse, type PageCrop } from '@/lib/omrClient';
import type { BarReadingContext } from '@/lib/omrPrompt';
import { barReadingContext, replaceReviewedBar, reviewBarXml } from '@/lib/scanReview';
import { buildTimeline } from '@/lib/timeline';
import { Player } from '@/lib/player';
import ScoreView from './ScoreView';

type Point = { x: number; y: number };
const clamp = (n: number) => Math.max(0, Math.min(1, n));

interface Props {
  xml: string;
  part: number;
  measure: number;
  label: string;
  files: FileInput[];
  pageCount: number;
  retry?: (image: string, context: BarReadingContext) => Promise<OmrResponse>;
  onApply: (xml: string) => void;
  onClose: () => void;
}

export default function ScanBarReview({ xml, part, measure, label, files, pageCount, retry, onApply, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const audio = useRef<Player | null>(null);
  const [page, setPage] = useState(0);
  const [photo, setPhoto] = useState('');
  const [photoError, setPhotoError] = useState('');
  const [corner, setCorner] = useState<Point | null>(null);
  const [cursor, setCursor] = useState<Point>({ x: 0.1, y: 0.1 });
  const [crop, setCrop] = useState<PageCrop | null>(null);
  const [cropped, setCropped] = useState('');
  const [proposal, setProposal] = useState('');
  const [audition, setAudition] = useState<'current' | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title = label === 'Pickup' ? 'Pickup bar' : `Bar ${label}`;
  const current = useMemo(() => reviewBarXml(xml, part, measure), [xml, part, measure]);
  const updated = useMemo(() => proposal ? reviewBarXml(proposal, part, measure) : '', [proposal, part, measure]);
  const context = barReadingContext(current);

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      if (audio.current) {
        audio.current.dispose();
        void audio.current.context.close().catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    let active = true;
    previewScanPage(files, page).then((image) => { if (active) setPhoto(image); })
      .catch(() => { if (active) setPhotoError('The original page could not be opened.'); });
    return () => { active = false; };
  }, [files, page]);

  useEffect(() => {
    if (!crop || !photo) return;
    let active = true;
    cropScanPage(photo, crop).then((image) => { if (active) setCropped(image); })
      .catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [crop, photo]);

  function clearCrop() {
    setCorner(null);
    setCrop(null);
    setCropped('');
    setProposal('');
    setError('');
  }

  function selectCorner(point: Point) {
    if (!corner) {
      clearCrop();
      setCorner(point);
      return;
    }
    setCrop({ x: Math.min(corner.x, point.x), y: Math.min(corner.y, point.y), width: Math.abs(corner.x - point.x), height: Math.abs(corner.y - point.y) });
    setCorner(null);
  }

  function moveCursor(e: KeyboardEvent<HTMLButtonElement>) {
    const step = e.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    setCursor((p) => ({ x: clamp(p.x + move[0]), y: clamp(p.y + move[1]) }));
  }

  async function tryReading() {
    if (!retry || !context || !cropped || busy) return;
    setError('');
    setProposal('');
    setBusy(true);
    try {
      const result = await retry(cropped, context);
      if (result.warnings.length || result.flags?.length) throw new Error('The reader is still unsure. Include the entire bar and try again.');
      setProposal(replaceReviewedBar(xml, part, measure, result.musicxml));
    } catch (e) {
      setError((e as Error).message || 'The bar could not be read.');
    } finally { setBusy(false); }
  }

  function hear(kind: 'current' | 'new', music: string) {
    try {
      const p = audio.current ??= new Player(new AudioContext());
      if (audition) p.pause();
      if (audition === kind) return;
      p.onState = (playing) => setAudition(playing ? kind : null);
      p.onBlocked = () => setError('The browser held the audio. Tap the play button again.');
      const timeline = buildTimeline(music);
      if (!timeline.events.length) { setError('This reading contains a rest.'); return; }
      p.setTimeline(timeline);
      p.setBpm(90);
      void p.play(1);
    } catch { setError('The audio preview could not start.'); }
  }

  return (
    <dialog ref={dialog} className="bar-review-dialog" aria-labelledby="bar-review-title" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <header className="bar-review-header">
        <h3 id="bar-review-title">Check {title.toLowerCase()}</h3>
        <button type="button" className="btn ghost" onClick={onClose}>Close</button>
      </header>
      <div className="bar-review-comparison">
        <section className="bar-review-source">
          <h4>Original page</h4>
          {pageCount > 1 && (
            <label className="picker-one">Page
              <select className="sel" value={page} disabled={busy} onChange={(e) => {
                setPhoto(''); setPhotoError(''); clearCrop(); setPage(Number(e.target.value));
              }}>
                {Array.from({ length: pageCount }, (_, i) => <option key={i} value={i}>Page {i + 1}</option>)}
              </select>
            </label>
          )}
          {photoError && <p role="alert">{photoError}</p>}
          {!photo && !photoError && <p role="status">Opening the original page…</p>}
          {photo && cropped ? (
            <>
              <img className="bar-review-cropped" src={cropped} alt={`Selected excerpt from original page ${page + 1}`} />
              <button type="button" className="btn ghost" onClick={clearCrop} disabled={busy}>Select again</button>
            </>
          ) : photo && (
            <>
              <p className="muted small" id="crop-instructions">{corner ? 'Select the opposite corner of the bar.' : 'Tap two opposite corners to select the bar. With a keyboard, use the arrow keys and Enter.'}</p>
              <button type="button" className="bar-review-image" aria-label="Select the bar on the original page" aria-describedby="crop-instructions"
                onKeyDown={moveCursor} onClick={(e) => {
                  if (e.detail === 0) { selectCorner(cursor); return; }
                  const rect = e.currentTarget.getBoundingClientRect();
                  selectCorner({ x: clamp((e.clientX - rect.left) / rect.width), y: clamp((e.clientY - rect.top) / rect.height) });
                }}>
                <img src={photo} alt={`Original page ${page + 1}`} />
                {corner && <span className="crop-point" style={{ left: `${corner.x * 100}%`, top: `${corner.y * 100}%` }} />}
                <span className="crop-cursor crop-point" style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }} />
              </button>
            </>
          )}
        </section>
        <section>
          <h4>Current reading</h4>
          <ScoreView xml={current} onSeekMeasure={() => {}} onError={setError} />
          <button type="button" className="btn ghost" onClick={() => hear('current', current)}>{audition === 'current' ? 'Stop preview' : 'Hear this bar'}</button>
          {updated && (
            <>
              <h4>New reading</h4>
              <ScoreView xml={updated} onSeekMeasure={() => {}} onError={setError} />
              <button type="button" className="btn ghost" onClick={() => hear('new', updated)}>{audition === 'new' ? 'Stop new preview' : 'Hear new reading'}</button>
            </>
          )}
        </section>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {busy && <p role="status">Reading the selected bar…</p>}
      <footer className="row bar-review-actions">
        {proposal ? (
          <>
            <button type="button" className="btn primary" onClick={() => onApply(proposal)}>Use new reading</button>
            <button type="button" className="btn ghost" onClick={onClose}>Keep current reading</button>
          </>
        ) : retry && context && label !== 'Pickup' && (
          <button type="button" className="btn primary" onClick={() => void tryReading()} disabled={busy || !cropped}>Retry this bar</button>
        )}
      </footer>
      {retry && context && cropped && !proposal && !busy && label !== 'Pickup' && <p className="muted small">Retrying sends the selected excerpt for one scan.</p>}
    </dialog>
  );
}
