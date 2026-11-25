'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { callOmr, prepareFiles, getPasscode, setPasscode, OmrError } from '@/lib/omrClient';
import { extractTitle, detectSourceInstrument } from '@/lib/musicxml';
import { newId, saveScore } from '@/lib/library';
import { INSTRUMENT_IDS, INSTRUMENTS, type InstrumentId } from '@/lib/instruments';

interface Item { key: string; file: File; url: string | null }

let keyCounter = 0;
/** Errors that happened before the reader ran (or that the free reader cannot fix): no "free reader" retry. */
const CLIENT_ERRORS = new Set(['client', 'too_large', 'xml', 'no_key', 'bad_request', 'network', 'unauthorized', 'rate_limited']);
const isMusicXml = (f: File) => /\.(musicxml|xml|mxl)$/i.test(f.name);

function titleFromName(name: string) {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled score';
}

export default function Uploader() {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [source, setSource] = useState<InstrumentId | 'auto'>('auto');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code: string } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [caps, setCaps] = useState<{ audiveris: boolean; passcode: boolean } | null>(null);
  const [passcode, setPass] = useState('');
  const [hasStored, setHasStored] = useState(true);
  const xmlInput = useRef<HTMLInputElement>(null);
  const urls = useRef<string[]>([]);

  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);
  useEffect(() => { setHasStored(!!getPasscode()); }, []);
  useEffect(() => {
    fetch('/api/omr').then((r) => r.json()).then((j) => setCaps({ audiveris: !!j.audiveris, passcode: !!j.passcode })).catch(() => {});
  }, []);

  async function saveAndOpen(xml: string, fallbackTitle: string, origin: 'scan' | 'musicxml') {
    const t = extractTitle(xml);
    const title = t === 'Untitled score' ? fallbackTitle : t;
    const id = newId();
    const sourceInstrument = source === 'auto' ? detectSourceInstrument(xml).id : source;
    await saveScore({ id, title, sourceXml: xml, sourceInstrument, sourceAuto: source === 'auto', createdAt: Date.now(), origin });
    router.push(`/score/${id}`);
  }

  async function openXmlFile(file: File) {
    setError(null); setBusy('Opening MusicXML…');
    try {
  
      const p = await prepareFiles([file]);
      if (p.kind !== 'musicxml') throw new OmrError('That is not a MusicXML file.');
      await saveAndOpen(p.xml, titleFromName(file.name), 'musicxml');
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
    setError(null);
    const next: Item[] = files.map((file) => {
      const url = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      if (url) urls.current.push(url);
      return { key: `f${keyCounter++}`, file, url };
    });
    setItems((cur) => [...cur, ...next]);
  }

  function move(i: number, d: number) {
    setItems((cur) => {
      const j = i + d;
      if (j < 0 || j >= cur.length) return cur;
      const copy = cur.slice();
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }

  async function read(engine: 'auto' | 'audiveris' = 'auto') {
    setError(null); setWarnings([]);
    if (caps?.passcode && !hasStored) {
      if (!passcode.trim()) { setError({ message: 'Enter the passcode first.', code: 'unauthorized' }); return; }
      setPasscode(passcode.trim()); setHasStored(true);
    }
    try {
      setBusy('Preparing pages…');
      const p = await prepareFiles(items.map((i) => i.file));
      if (p.kind === 'musicxml') { await saveAndOpen(p.xml, titleFromName(items[0].file.name), 'musicxml'); return; }
      setBusy(engine === 'audiveris' ? 'Reading with the free reader…' : 'Reading the music… this can take a minute');
      const r = await callOmr(p.images, engine);
      setWarnings(r.warnings);
      await saveAndOpen(r.musicxml, titleFromName(items[0].file.name), 'scan');
    } catch (e) {
      const err = e as OmrError;
      if (err.code === 'unauthorized') { setHasStored(false); setPass(''); }
      setError({ message: err.message || 'Reading failed.', code: err.code ?? 'error' });
      setBusy(null);
    }
  }

  const hasPdfOnly = items.length > 0 && items.every((i) => !i.url);

  return (
    <section className="uploader" aria-label="Add music">
      <h2>Add music</h2>
      <div className="actions">
        <label className="btn primary">
          Take photo
          <input className="sr-only" type="file" accept="image/*" capture="environment" data-testid="photo-input"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        </label>
        <label className="btn">
          Photos or PDF
          <input className="sr-only" type="file" multiple accept="image/*,application/pdf,.pdf" data-testid="file-input"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        </label>
        <label className="btn">
          Open MusicXML
          <input ref={xmlInput} className="sr-only" type="file" accept=".musicxml,.xml,.mxl" data-testid="xml-input"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        </label>
      </div>

      {items.length > 0 && (
        <>
          <div className="thumbs" data-testid="thumbs">
            {items.map((it, i) => (
              <div className="thumb" key={it.key}>
                {it.url ? <img src={it.url} alt={`Page ${i + 1}`} /> : <div className="pdfbox" aria-label={`PDF ${it.file.name}`}>PDF<br />{it.file.name.slice(0, 14)}</div>}
                <div className="tb">
                  <button type="button" onClick={() => move(i, -1)} aria-label={`Move page ${i + 1} earlier`}>‹</button>
                  <button type="button" onClick={() => setItems((c) => c.filter((x) => x.key !== it.key))} aria-label={`Remove page ${i + 1}`}>×</button>
                  <button type="button" onClick={() => move(i, 1)} aria-label={`Move page ${i + 1} later`}>›</button>
                </div>
              </div>
            ))}
          </div>
          <label className="picker-one">
            <span className="muted small">This music is written for</span>
            <select value={source} onChange={(e) => setSource(e.target.value as InstrumentId | 'auto')} aria-label="Scan is written for" className="sel">
              <option value="auto">Detect from the music (bass clef = trombone, treble = trumpet)</option>
              {INSTRUMENT_IDS.map((id) => <option key={id} value={id}>{INSTRUMENTS[id].name}</option>)}
            </select>
          </label>
          {caps?.passcode && !hasStored && (
            <label className="picker-one">
              <span className="muted small">Passcode (ask the person who runs this app)</span>
              <input className="sel" type="password" autoComplete="off" value={passcode} onChange={(e) => setPass(e.target.value)} aria-label="Passcode" data-testid="passcode-input" />
            </label>
          )}
          <button type="button" className="btn primary" disabled={!!busy} onClick={() => read('auto')}>
            {hasPdfOnly ? 'Read PDF' : `Read ${items.length} page${items.length > 1 ? 's' : ''}`}
          </button>
          <p className="muted small">Up to 6 pages. Photos are shrunk on your device before sending.</p>
        </>
      )}

      {busy && <p role="status" className="muted" data-testid="busy">{busy}</p>}
      {error && (
        <div className="error" role="alert" data-testid="upload-error">
          <p>{error.message}</p>
          {items.length > 0 && caps?.audiveris && error.code !== 'no_audiveris' && !CLIENT_ERRORS.has(error.code) && (
            <button type="button" className="btn" onClick={() => read('audiveris')}>Try free reader</button>
          )}{' '}
          <button type="button" className="btn" onClick={() => xmlInput.current?.click()}>Open MusicXML instead</button>
        </div>
      )}
      {warnings.length > 0 && <p className="muted small">{warnings.join(' ')}</p>}
      <p className="disclaimer">Reading is automatic. Check the notes against your sheet.</p>
    </section>
  );
}
