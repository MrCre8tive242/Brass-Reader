'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteGroove, listGrooves, renameGroove, saveGroove, type StoredGroove } from '@/lib/grooveStore';
import { STARTER_LABEL, grooveBars, makeGrooveFile, parseGrooveFile, starterGrooves, type KitPattern } from '@/lib/groove';
import { newId } from '@/lib/library';
import type { Analysis } from '@/lib/grooveAnalyze';
import { AlertIcon, BackIcon, MicIcon, TrashIcon } from './Icons';
import { GrooveRecorder, GrooveReview } from './GrooveRecorder';
import KitEditor from './KitEditor';
import { useGroovePreview } from './useGroovePreview';

interface Props {
  getCtx: () => AudioContext | null;
  /** Tempo of the score on screen: the default click tempo for recording. */
  clickBpm: number;
  onClose: () => void;
  /** The list of grooves changed (saved, renamed, deleted, imported). */
  onChanged: () => void;
}

type View =
  | { k: 'list' }
  | { k: 'record' }
  | { k: 'kit'; existing?: StoredGroove; from?: { name: string; pattern: KitPattern; starter: boolean } }
  | { k: 'review'; samples: Float32Array; rate: number; analysis: Analysis; existing?: StoredGroove };

function download(data: BlobPart, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const meta = (g: StoredGroove) =>
  g.kind === 'recorded' ? `Recorded · ${Math.round((g.bpm ?? 0) * 10) / 10} BPM · ${g.bars} bar${g.bars === 1 ? '' : 's'} · ${g.slices?.length ?? 0} hits`
    : `Step pattern · ${g.pattern?.steps} steps · ${grooveBars(g)} bar${grooveBars(g) === 1 ? '' : 's'}`;

/** Full-screen place to record, listen to, edit, share and delete the grooves kept on this device. */
export default function GrooveStudio({ getCtx, clickBpm, onClose, onChanged }: Props) {
  const [view, setView] = useState<View>({ k: 'list' });
  const [items, setItems] = useState<StoredGroove[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const buffers = useRef(new Map<string, AudioBuffer>());
  const preview = useGroovePreview(getCtx);

  const refresh = useCallback(() => { listGrooves().then(setItems).catch(() => setError('Could not read the saved grooves (the browser is not letting the app open its storage).')); }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => { if (!preview.playing) setPreviewId(null); }, [preview.playing]);

  async function decode(g: StoredGroove): Promise<AudioBuffer | null> {
    if (g.kind !== 'recorded' || !g.audio) return null;
    const hit = buffers.current.get(g.id);
    if (hit) return hit;
    const ctx = getCtx();
    if (!ctx) return null;
    const b = await ctx.decodeAudioData(await g.audio.arrayBuffer());
    buffers.current.set(g.id, b);
    return b;
  }

  async function togglePreview(g: StoredGroove) {
    if (previewId === g.id) { preview.stop(); return; }
    setError(null);
    try {
      const buf = await decode(g);
      setPreviewId(g.id);
      preview.play(g, buf, g.kind === 'recorded' ? g.bpm ?? 100 : 110);
    } catch { setError('That recording could not be played.'); }
  }

  async function edit(g: StoredGroove) {
    preview.stop();
    setError(null);
    try {
      const buf = await decode(g);
      if (!buf) return;
      setView({
        k: 'review', samples: new Float32Array(buf.getChannelData(0)), rate: buf.sampleRate, existing: g,
        analysis: { onsets: g.onsets ?? [], detected: null, downbeatS: g.downbeatS ?? 0, bars: ([1, 2, 4].includes(g.bars ?? 1) ? g.bars : 1) as 1 | 2 | 4 },
      });
    } catch { setError('That recording could not be opened.'); }
  }

  async function exportOne(g: StoredGroove) {
    try {
      const audio = g.audio ? { mime: g.audio.type || 'audio/wav', bytes: new Uint8Array(await g.audio.arrayBuffer()) } : undefined;
      const slug = g.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'groove';
      download(makeGrooveFile(g, audio), 'application/json', `${slug}.groove.json`);
    } catch { setError('Could not make the file.'); }
  }

  async function importFile(f: File | undefined) {
    if (!f) return;
    setError(null); setNotice(null);
    try {
      const { groove, audio } = parseGrooveFile(await f.text());
      const g: StoredGroove = { ...groove, id: newId(), ...(audio ? { audio: new Blob([audio.bytes as BlobPart], { type: audio.mime }) } : {}) };
      await saveGroove(g);
      refresh(); onChanged();
      setNotice(`Added “${g.name}”.`);
    } catch (e) { setError((e as Error).message); }
  }

  async function remove(g: StoredGroove) {
    if (previewId === g.id) preview.stop();
    await deleteGroove(g.id);
    buffers.current.delete(g.id);
    setConfirmDel(null);
    refresh(); onChanged();
  }

  async function saved(g: StoredGroove) {
    try { await saveGroove(g); } catch { setError('Could not save the groove (the browser is not letting the app store it).'); return; }
    buffers.current.delete(g.id);
    refresh(); onChanged();
    setNotice(`Saved “${g.name}”.`);
    setView({ k: 'list' });
  }

  const title = view.k === 'list' ? 'Grooves' : view.k === 'record' ? 'Record your drum line' : view.k === 'kit' ? 'Step pattern' : view.existing ? 'Edit groove' : 'Your recording';

  return (
    <div className="studio" role="dialog" aria-label="Grooves" data-testid="groove-studio">
      <header className="studio-head">
        <button type="button" className="tbtn" onClick={() => { if (view.k === 'list') { preview.stop(); onClose(); } else { preview.stop(); setView({ k: 'list' }); } }} aria-label={view.k === 'list' ? 'Close grooves' : 'Back to grooves'}><BackIcon size={22} /></button>
        <h2>{title}</h2>
      </header>
      <div className="studio-body">
        {error && <p className="error" role="alert"><AlertIcon size={18} /> {error}</p>}
        {notice && view.k === 'list' && <p className="okline" role="status" data-testid="studio-notice">{notice}</p>}
        {view.k === 'record' && (
          <GrooveRecorder getCtx={getCtx} clickBpm={clickBpm} onCancel={() => setView({ k: 'list' })} onDone={(r) => setView({ k: 'review', ...r })} />
        )}
        {view.k === 'kit' && (
          <KitEditor getCtx={getCtx} existing={view.existing} from={view.from} onSave={saved} onCancel={() => setView({ k: 'list' })} />
        )}
        {view.k === 'review' && (
          <GrooveReview getCtx={getCtx} samples={view.samples} rate={view.rate} analysis={view.analysis} existing={view.existing} onSave={saved} onCancel={() => setView({ k: 'list' })} />
        )}
        {view.k === 'list' && (
          <>
            <div className="prow">
              <button type="button" className="btn primary" onClick={() => { setNotice(null); setView({ k: 'record' }); }}><MicIcon size={20} /> Record your drum line</button>
              <button type="button" className="btn" onClick={() => { setNotice(null); setView({ k: 'kit' }); }}>New step pattern</button>
              <label className="btn" role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') (e.currentTarget.querySelector('input') as HTMLInputElement)?.click(); }}>
                Import a groove file
                <input type="file" accept=".json,application/json" className="sr-only" aria-label="Import a groove file" onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
            </div>
            <p className="muted small">Grooves stay on this device. Export one to send it to the band: the file holds the recording too.</p>
            <h3 className="sec">Starter patterns</h3>
            <div data-testid="starter-list">
              <p className="starter-note">{STARTER_LABEL}</p>
              <ul className="grooves">
                {starterGrooves().map((g) => (
                  <li key={g.id} className="groove" data-testid="starter-row">
                    <div className="ginfo"><strong>{g.name}</strong><span className="muted small">{meta(g)}</span></div>
                    <div className="gbtns">
                      <button type="button" className="btn sm" onClick={() => togglePreview(g)} aria-label={`${previewId === g.id ? 'Stop' : 'Play'} ${g.name}`}>{previewId === g.id ? 'Stop' : 'Play'}</button>
                      <button type="button" className="btn sm" onClick={() => { preview.stop(); setView({ k: 'kit', from: { name: g.name.replace(/^Starter /, ''), pattern: g.pattern!, starter: true } }); }} aria-label={`Edit a copy of ${g.name}`}>Edit a copy</button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <h3 className="sec">Your grooves</h3>
            {items.length === 0
              ? <p className="muted" data-testid="no-grooves">No grooves yet. Record your drummers, then play along.</p>
              : (
                <ul className="grooves">
                  {items.map((g) => (
                    <li key={g.id} className="groove" data-testid="groove-row">
                      <div className="ginfo">
                        {renaming?.id === g.id
                          ? (
                            <form className="prow" onSubmit={(e) => { e.preventDefault(); void renameGroove(g.id, renaming.text).then(() => { setRenaming(null); refresh(); onChanged(); }); }}>
                              <input className="txt" value={renaming.text} maxLength={60} autoFocus onChange={(e) => setRenaming({ id: g.id, text: e.target.value })} aria-label="New name" />
                              <button type="submit" className="btn sm primary">Save name</button>
                            </form>
                          )
                          : <strong data-testid="groove-name">{g.name}</strong>}
                        <span className="muted small">{meta(g)}</span>
                      </div>
                      <div className="gbtns">
                        <button type="button" className="btn sm" onClick={() => togglePreview(g)} aria-label={`${previewId === g.id ? 'Stop' : 'Play'} ${g.name}`}>{previewId === g.id ? 'Stop' : 'Play'}</button>
                        <button type="button" className="btn sm" onClick={() => (g.kind === 'recorded' ? edit(g) : setView({ k: 'kit', existing: g }))} aria-label={`Edit ${g.name}`}>Edit</button>
                        <button type="button" className="btn sm ghost" onClick={() => setRenaming({ id: g.id, text: g.name })} aria-label={`Rename ${g.name}`}>Rename</button>
                        <button type="button" className="btn sm ghost" onClick={() => exportOne(g)} aria-label={`Export ${g.name}`}>Export</button>
                        {confirmDel === g.id
                          ? <button type="button" className="btn sm danger" onClick={() => remove(g)} aria-label={`Really delete ${g.name}`}>Delete it?</button>
                          : <button type="button" className="btn sm ghost" onClick={() => setConfirmDel(g.id)} aria-label={`Delete ${g.name}`}><TrashIcon size={18} /></button>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
          </>
        )}
      </div>
    </div>
  );
}
