'use client';
import { useCallback } from 'react';

interface Props {
  title: string;
  getMidi: () => Uint8Array;
  getXml: () => string;
}

function save(data: BlobPart, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function Downloads({ title, getMidi, getXml }: Props) {
  const base = (title || 'score').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'score';
  const midi = useCallback(() => save(getMidi() as BlobPart, 'audio/midi', `${base}.mid`), [getMidi, base]);
  const xml = useCallback(() => save(getXml(), 'application/vnd.recordare.musicxml+xml', `${base}.musicxml`), [getXml, base]);
  return (
    <div className="downloads">
      <button type="button" className="btn" onClick={midi}>Download MIDI</button>
      <button type="button" className="btn" onClick={xml}>Download MusicXML</button>
    </div>
  );
}
