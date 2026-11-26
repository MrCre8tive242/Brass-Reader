'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { callOmr, prepareFiles, getPasscode, setPasscode, OmrError, type OmrFlag } from '@/lib/omrClient';
import { extractTitle, detectSourceInstrument, summariseScore, extractPart, keyName, type ScoreSummary } from '@/lib/musicxml';
import { canRekey, rekeyXml } from '@/lib/omrNotation';
import { newId, saveScore, getScore, type SavedScore } from '@/lib/library';
import { addPartsTo, songPartsOf } from '@/lib/song';
import { INSTRUMENT_IDS, INSTRUMENTS, type InstrumentId } from '@/lib/instruments';
import { AlertIcon, CameraIcon, CheckIcon, CloseIcon, FileIcon, RotateIcon } from './Icons';

interface Item { key: string; file: File; url: string | null; rotate: number }
interface Review {
  xml: string;
  engine: 'claude' | 'audiveris';
  warnings: string[];
  flags: OmrFlag[];
  summary: ScoreSummary;
  title: string;
  /** Chosen part, or 'all'. */
  part: number | 'all';
}

let keyCounter = 0;
/** Errors that happened before the reader ran (or that the free reader cannot fix): no "free reader" retry. */
const CLIENT_ERRORS = new Set(['client', 'too_large', 'xml', 'no_key', 'bad_request', 'network', 'unauthorized', 'rate_limited', 'not_music']);
const isMusicXml = (f: File) => /\.(musicxml|xml|mxl)$/i.test(f.name);

function titleFromName(name: string) {
  const t = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  // camera files are called IMG_1234 or a long number: not a title
  return !t || /^(img|image|dsc|pxl|photo|scan)?[\s\d]*$/i.test(t) ? 'Untitled score' : t;
}

export default function Uploader({ addTo }: { addTo?: string }) {
  const router = useRouter();
  // adding another instrument's sheet to a song that is already in the library
  const [target, setTarget] = useState<SavedScore | null>(null);
  useEffect(() => { if (addTo) getScore(addTo).then((s) => setTarget(s ?? null)).catch(() => setTarget(null)); }, [addTo]);
  const [items, setItems] = useState<Item[]>([]);
  const [source, setSource] = useState<InstrumentId | 'auto'>('auto');
  const [partHint, setPartHint] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<{ message: string; code: string } | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [caps, setCaps] = useState<{ audiveris: boolean; passcode: boolean } | null>(null);
  const [passcode, setPass] = useState('');
  const [hasStored, setHasStored] = useState(true);
  const xmlInput = useRef<HTMLInputElement>(null);
  const urls = useRef<string[]>([]);
  const reviewRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);
  useEffect(() => { setHasStored(!!getPasscode()); }, []);
  useEffect(() => {
    fetch('/api/omr').then((r) => r.json()).then((j) => setCaps({ audiveris: !!j.audiveris, passcode: !!j.passcode })).catch(() => {});
  }, []);
  // seconds counter while the reader works, so a long read does not look frozen
  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    const t0 = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);
  useEffect(() => { if (review) reviewRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [review]);

  async function save(xml: string, title: string, origin: 'scan' | 'musicxml', extra: { flags?: OmrFlag[]; partIndex?: number | null } = {}) {
    if (addTo) {
      const song = target ?? (await getScore(addTo));
      if (!song) throw new Error('That song is not in the library on this device.');
      const my = typeof song.partIndex === 'number' ? song.partIndex : (song.myPart ?? 0);
      const parts = addPartsTo(songPartsOf(song, my), xml, newId, source === 'auto' ? undefined : source, typeof extra.partIndex === 'number' ? extra.partIndex : undefined);
      // the song now has several parts: my part stays shown (not the stacked score) until asked for
      await saveScore({ ...song, parts, myPart: my, partIndex: my });
      router.push(`/score/${song.id}`);
      return;
    }
    // a file with several instruments opens on the first part (the band plays along); "All" is asked for explicitly
    if (extra.partIndex === undefined && summariseScore(xml).parts.length > 1) extra = { ...extra, partIndex: 0 };
    const id = newId();
    const chosen = typeof extra.partIndex === 'number' ? extractPart(xml, extra.partIndex) : xml;
    const sourceInstrument = source === 'auto' ? detectSourceInstrument(chosen).id : source;
    await saveScore({ id, title, sourceXml: xml, sourceInstrument, sourceAuto: source === 'auto', createdAt: Date.now(), origin, ...extra });
    router.push(`/score/${id}`);
  }

  async function openXmlFile(file: File) {
    setError(null); setReview(null); setBusy('Opening the file…');
    try {
      const p = await prepareFiles([file]);
      if (p.kind !== 'musicxml') throw new OmrError('That is not a MusicXML file.');
      const t = extractTitle(p.xml);
      await save(p.xml, t === 'Untitled score' ? titleFromName(file.name) : t, 'musicxml');
    } catch (e) {
      setError({ message: (e as Error).message || 'Could not open that file.', code: 'xml' });
      setBusy(null);
    }
  }

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    const xml = files.find(isMusicXml);
    if (xml) { void openXmlFile(xml); return; }
    setError(null); setReview(null);
    const next: Item[] = files.map((file) => {
      const url = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      if (url) urls.current.push(url);
      return { key: `f${keyCounter++}`, file, url, rotate: 0 };
    });
    setItems((cur) => [...cur, ...next]);
  }

  // any change to the pages makes an earlier reading stale
  function move(i: number, d: number) {
    setReview(null);
    setItems((cur) => {
      const j = i + d;
      if (j < 0 || j >= cur.length) return cur;
      const copy = cur.slice();
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }
  const rotate = (key: string) => { setReview(null); setItems((cur) => cur.map((x) => (x.key === key ? { ...x, rotate: (x.rotate + 1) % 4 } : x))); };
  const remove = (key: string) => { setItems((c) => c.filter((x) => x.key !== key)); setReview(null); };

  async function read(engine: 'auto' | 'audiveris' = 'auto') {
    setError(null); setReview(null);
    if (caps?.passcode && !hasStored) {
      if (!passcode.trim()) { setError({ message: 'Enter the passcode first.', code: 'unauthorized' }); return; }
      setPasscode(passcode.trim()); setHasStored(true);
    }
    try {
      setBusy('Preparing the pages…');
      const p = await prepareFiles(items.map((i) => ({ file: i.file, rotate: i.rotate })), setBusy);
      if (p.kind === 'musicxml') { await save(p.xml, titleFromName(items[0].file.name), 'musicxml'); return; }
      const several = p.images.length >= 2 && p.images.length <= 8 && !partHint.trim();
      setBusy(engine === 'audiveris' ? 'Reading with the free reader…' : several ? `Reading ${p.images.length} parts of the page at once…` : 'Reading the music…');
      const hints = { instrument: source === 'auto' ? undefined : source, part: partHint.trim() || undefined };
      const r = await callOmr({ images: p.images, tiles: p.tiles, hints }, engine);
      const summary = summariseScore(r.musicxml);
      const t = summary.title === 'Untitled score' ? titleFromName(items[0].file.name) : summary.title;
      setReview({ xml: r.musicxml, engine: r.engine, warnings: r.warnings ?? [], flags: r.flags ?? [], summary, title: t, part: 0 });
      setBusy(null);
    } catch (e) {
      const err = e as OmrError;
      if (err.code === 'unauthorized') { setHasStored(false); setPass(''); }
      setError({ message: err.message || 'Reading failed.', code: err.code ?? 'error' });
      setBusy(null);
    }
  }

  async function openReviewed() {
    if (!review) return;
    setBusy('Opening the score…');
    try {
      await save(review.xml, review.title.trim() || 'Untitled score', 'scan', { flags: review.flags, partIndex: review.summary.parts.length > 1 && review.part !== 'all' ? review.part : null });
    } catch (e) {
      setError({ message: (e as Error).message || 'Could not save the score.', code: 'client' });
      setBusy(null);
    }
  }

  const hasPdfOnly = items.length > 0 && items.every((i) => !i.url);
  const shown = review ? (review.part === 'all' ? review.summary.parts[0] : review.summary.parts[review.part]) : undefined;
  const mismatch = useMemo(() => {
    if (!shown || source === 'auto' || !shown.clef) return null;
    const want = INSTRUMENTS[source].clef;
    const got = shown.clef === 'treble' ? 'treble' : 'bass';
    return want === got ? null : `The page is in ${shown.clef} clef, but ${INSTRUMENTS[source].name} normally reads ${want} clef. Check "Written for".`;
  }, [shown, source]);
  const thin = !!shown && (shown.notes < 4 || shown.bars < 2);

  return (
    <section className="uploader" aria-label="Add music">
      {addTo && (
        <p className="addto" data-testid="add-to-banner">
          Adding a part to <strong>{target?.title ?? 'this song'}</strong>. Scan the other instrument&apos;s sheet, or open a MusicXML file; it joins the band. <a href="/">Cancel</a>
        </p>
      )}
      <div className="actions">
        <label className="btn primary big">
          <CameraIcon /> Take a photo
          <input className="sr-only" type="file" accept="image/*" capture="environment" data-testid="photo-input"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        </label>
        <label className="btn">
          <FileIcon size={20} /> Photos or PDF
          <input className="sr-only" type="file" multiple accept="image/*,application/pdf,.pdf" data-testid="file-input"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        </label>
        <label className="btn">
          Open MusicXML
          <input ref={xmlInput} className="sr-only" type="file" accept=".musicxml,.xml,.mxl" data-testid="xml-input"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        </label>
      </div>
      {items.length === 0 && !busy && !error && (
        <p className="muted small tip">Lay the page flat in good light, fill the frame, and keep the phone straight above it. One page per photo.</p>
      )}

      {items.length > 0 && (
        <>
          <div className="thumbs" data-testid="thumbs">
            {items.map((it, i) => (
              <div className="thumb" key={it.key}>
                <div className="frame">
                  {it.url
                    ? <img src={it.url} alt={`Page ${i + 1}`} className={it.rotate % 2 ? 'side' : ''} style={{ transform: `rotate(${it.rotate * 90}deg)` }} />
                    : <div className="pdfbox" aria-label={`PDF ${it.file.name}`}><FileIcon size={28} />PDF<span>{it.file.name.slice(0, 18)}</span></div>}
                  <span className="pageno">{i + 1}</span>
                  {it.url && <button type="button" className="rot" onClick={() => rotate(it.key)} aria-label={`Rotate page ${i + 1}`}><RotateIcon size={20} /></button>}
                </div>
                <div className="tb">
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move page ${i + 1} earlier`}>‹</button>
                  <button type="button" onClick={() => remove(it.key)} aria-label={`Remove page ${i + 1}`}><CloseIcon size={18} /></button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label={`Move page ${i + 1} later`}>›</button>
                </div>
              </div>
            ))}
          </div>
          <label className="picker-one">
            <span className="muted small">This music is written for (if unsure, leave it: bass clef is read as trombone, treble as trumpet)</span>
            <select value={source} onChange={(e) => setSource(e.target.value as InstrumentId | 'auto')} aria-label="Scan is written for" className="sel">
              <option value="auto">Detect from the music</option>
              {INSTRUMENT_IDS.map((id) => <option key={id} value={id}>{INSTRUMENTS[id].name}</option>)}
            </select>
          </label>
          <details className="more">
            <summary>The page shows several instruments</summary>
            <label className="picker-one">
              <span className="muted small">Only read this part (the name printed at the staff, for example Trumpet 2). Leave empty to read them all and choose afterwards.</span>
              <input className="sel" type="text" maxLength={40} value={partHint} onChange={(e) => setPartHint(e.target.value)} aria-label="Only read this part" placeholder="Trumpet 2" autoComplete="off" />
            </label>
          </details>
          {caps?.passcode && !hasStored && (
            <label className="picker-one">
              <span className="muted small">Passcode (ask the person who runs this app)</span>
              <input className="sel" type="password" autoComplete="off" value={passcode} onChange={(e) => setPass(e.target.value)} aria-label="Passcode" data-testid="passcode-input" />
            </label>
          )}
          {!review && (
            <button type="button" className="btn primary big" disabled={!!busy} onClick={() => read('auto')}>
              {hasPdfOnly ? 'Read PDF' : `Read ${items.length} page${items.length > 1 ? 's' : ''}`}
            </button>
          )}
          {!review && !busy && <p className="muted small">Up to 6 pages. Sideways photo? Turn it with the round arrow. Photos are cleaned up and shrunk on your phone before they are sent.</p>}
        </>
      )}

      {busy && (
        <div role="status" className="busy" data-testid="busy">
          <span className="spinner" aria-hidden />
          <span>{busy}{elapsed >= 3 ? ` ${elapsed} s` : ''}</span>
          {busy.startsWith('Reading') && !busy.includes('free reader') && <span className="muted small">Usually 20 to 60 seconds. Keep this screen open.</span>}
        </div>
      )}
      {error && (
        <div className="error" role="alert" data-testid="upload-error">
          <p>{error.message}</p>
          <div className="row">
            {items.length > 0 && !CLIENT_ERRORS.has(error.code) && error.code !== 'no_audiveris' && (
              <button type="button" className="btn" onClick={() => read('auto')}>Try again</button>
            )}
            {items.length > 0 && caps?.audiveris && error.code !== 'no_audiveris' && !CLIENT_ERRORS.has(error.code) && (
              <button type="button" className="btn" onClick={() => read('audiveris')}>Try free reader</button>
            )}
            <button type="button" className="btn" onClick={() => xmlInput.current?.click()}>Open MusicXML instead</button>
          </div>
        </div>
      )}

      {review && shown && (
        <div className="review" ref={reviewRef} data-testid="review" role="group" aria-label="Check the reading">
          <h3>Check the reading</h3>
          <label className="picker-one">
            <span className="muted small">Title</span>
            <input className="sel" type="text" value={review.title} maxLength={120} onChange={(e) => setReview({ ...review, title: e.target.value })} aria-label="Title" />
          </label>
          {review.summary.parts.length > 1 && (
            <label className="picker-one">
              <span className="muted small">{review.summary.parts.length} parts were found. Which one is yours?</span>
              <select className="sel" aria-label="Your part" value={String(review.part)} onChange={(e) => setReview({ ...review, part: e.target.value === 'all' ? 'all' : Number(e.target.value) })}>
                {review.summary.parts.map((p) => <option key={p.index} value={p.index}>{p.name}{p.clef ? ` (${p.clef} clef)` : ''}</option>)}
                <option value="all">All parts together</option>
              </select>
            </label>
          )}
          <dl className="facts" data-testid="review-facts">
            <div><dt>Clef</dt><dd>{shown.clef || 'not found'}</dd></div>
            <div><dt>Key</dt><dd>{shown.key ? shown.key.replace('no sharps or flats', 'none') : 'not found'}</dd></div>
            <div><dt>Time</dt><dd>{shown.time || 'not found'}</dd></div>
            <div><dt>Bars</dt><dd>{shown.bars}</dd></div>
          </dl>
          <p className="muted small">Compare these with the top of your page. If the clef or time is wrong, every note will be off: read it again.</p>
          {canRekey(review.xml) && shown.fifths !== null && (
            <label className="picker-one">
              <span className="muted small">Key signature not what your page shows? Choose the right one and the notes are corrected, no new scan needed.</span>
              <select className="sel" aria-label="Key signature" value={shown.fifths}
                onChange={(e) => {
                  const xml = rekeyXml(review.xml, Number(e.target.value), review.part === 'all' ? undefined : review.part);
                  setReview({ ...review, xml, summary: summariseScore(xml) });
                }}>
                {Array.from({ length: 15 }, (_, i) => i - 7).map((f) => <option key={f} value={f}>{keyName(f)}</option>)}
              </select>
            </label>
          )}
          {mismatch && <p className="warnline"><AlertIcon size={18} /> {mismatch}</p>}
          {thin && <p className="warnline"><AlertIcon size={18} /> Very little music was found. Make sure the photo is sharp and shows the whole page.</p>}
          {review.warnings.length > 0 ? (
            <div className="warn" data-testid="review-warnings">
              <strong>{review.warnings.length === 1 ? '1 thing to check' : `${review.warnings.length} things to check`} against your sheet</strong>
              <ul>
                {review.warnings.slice(0, 8).map((w, i) => <li key={i}>{w}</li>)}
                {review.warnings.length > 8 && <li>and {review.warnings.length - 8} more (they are listed again on the score).</li>}
              </ul>
            </div>
          ) : (
            <p className="okline" data-testid="review-ok"><CheckIcon size={18} /> Every bar adds up. Still check the notes against your sheet.</p>
          )}
          <div className="row">
            <button type="button" className="btn primary big" onClick={openReviewed} disabled={!!busy}>Open score</button>
            <button type="button" className="btn" onClick={() => read('auto')} disabled={!!busy}>Read again</button>
          </div>
          <p className="muted small">Read by {review.engine === 'claude' ? 'the main reader' : 'the free reader'}. Reading again uses another scan.</p>
        </div>
      )}
      <p className="disclaimer">Reading is automatic and can make mistakes. Check the notes against your sheet.</p>
    </section>
  );
}
