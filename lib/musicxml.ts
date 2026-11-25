import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import JSZip from 'jszip';

// xmldom's Document/Element types are structurally compatible with the DOM lib types we use.
export type XDoc = Document;
export type XEl = Element;

export class MusicXmlError extends Error {}

export function parseXml(xml: string): XDoc {
  const clean = xml.replace(/^﻿/, '').trim();
  let doc: XDoc;
  try {
    doc = new DOMParser({
      onError: (level: string, msg: string) => {
        if (level === 'error' || level === 'fatalError') throw new MusicXmlError(`XML parse error: ${msg}`);
      },
    }).parseFromString(clean, 'text/xml') as unknown as XDoc;
  } catch (e) {
    // xmldom wraps errors thrown from onError ("Reporting fatalError ... caused Error: ..."): keep the useful part
    const m = (e as Error).message.match(/(?:caused Error: )?XML parse error: (.*)$/s);
    throw new MusicXmlError(m ? `That file is not valid MusicXML (${m[1].trim()}).` : (e as Error).message);
  }
  const root = doc.documentElement;
  if (!root) throw new MusicXmlError('XML parse error: empty document');
  if (root.nodeName === 'score-timewise') throw new MusicXmlError('score-timewise MusicXML is not supported; export as partwise');
  if (root.nodeName !== 'score-partwise') throw new MusicXmlError(`Not MusicXML: root element is <${root.nodeName}>`);
  return doc;
}

export function serializeXml(doc: XDoc): string {
  const body = new XMLSerializer().serializeToString(doc as never);
  return body.startsWith('<?xml') ? body : `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

/** Direct element children, optionally filtered by tag name. */
export function kids(el: XEl, name?: string): XEl[] {
  const out: XEl[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || (n as XEl).nodeName === name)) out.push(n as XEl);
  }
  return out;
}

export function kid(el: XEl, name: string): XEl | null {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as XEl).nodeName === name) return n as XEl;
  }
  return null;
}

export function kidText(el: XEl, name: string): string | null {
  const k = kid(el, name);
  return k ? (k.textContent ?? '').trim() : null;
}

export function kidNum(el: XEl, name: string): number | null {
  const t = kidText(el, name);
  if (t === null || t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function setKidText(doc: XDoc, el: XEl, name: string, value: string | number, before?: string[]): XEl {
  let k = kid(el, name);
  if (!k) {
    k = doc.createElement(name);
    let ref: XEl | null = null;
    if (before) for (const b of before) { ref = kid(el, b); if (ref) break; }
    if (ref) el.insertBefore(k, ref); else el.appendChild(k);
  }
  k.textContent = String(value);
  return k;
}

export function removeKids(el: XEl, name: string): void {
  for (const k of kids(el, name)) el.removeChild(k);
}

export function partsOf(doc: XDoc): XEl[] {
  return kids(doc.documentElement, 'part');
}

export const STEP_SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

export function pitchToMidi(pitch: XEl): number | null {
  const step = kidText(pitch, 'step');
  const oct = kidNum(pitch, 'octave');
  if (!step || !(step in STEP_SEMI) || oct === null) return null;
  const alter = kidNum(pitch, 'alter') ?? 0;
  return (oct + 1) * 12 + STEP_SEMI[step] + Math.round(alter);
}

export function extractTitle(xml: string): string {
  try {
    const doc = parseXml(xml);
    const root = doc.documentElement;
    const work = kid(root, 'work');
    const wt = work ? kidText(work, 'work-title') : null;
    if (wt) return wt;
    const mt = kidText(root, 'movement-title');
    if (mt) return mt;
    const credits = kids(root, 'credit');
    for (const c of credits) {
      const words = kid(c, 'credit-words');
      if (words?.textContent?.trim()) return words.textContent.trim();
    }
  } catch { /* fall through */ }
  return 'Untitled score';
}

export interface Validation { ok: boolean; error?: string; noteCount: number; measureCount: number }

export function validateMusicXml(xml: string): Validation {
  try {
    const doc = parseXml(xml);
    const parts = partsOf(doc);
    if (parts.length === 0) return { ok: false, error: 'No <part> found', noteCount: 0, measureCount: 0 };
    let noteCount = 0;
    let measureCount = 0;
    for (const p of parts) {
      for (const m of kids(p, 'measure')) {
        measureCount++;
        for (const n of kids(m, 'note')) {
          if (kid(n, 'pitch')) noteCount++;
        }
      }
    }
    if (noteCount < 1) return { ok: false, error: 'No pitched <note> elements found', noteCount, measureCount };
    return { ok: true, noteCount, measureCount };
  } catch (e) {
    return { ok: false, error: (e as Error).message, noteCount: 0, measureCount: 0 };
  }
}

/** Decode bytes as text, handling UTF-8 and UTF-16 BOMs. */
export function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes).replace(/^﻿/, '');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes).replace(/^﻿/, '');
  return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
}

/** Largest score text the app will open (a long band score is a few MB). */
export const MAX_XML_BYTES = 30_000_000;

/** Extract the main score XML from a compressed .mxl container. */
export async function unzipMxl(data: ArrayBuffer | Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  let path: string | undefined;
  const container = zip.file('META-INF/container.xml');
  if (container) {
    const cdoc = new DOMParser().parseFromString(await container.async('string'), 'text/xml');
    const rf = cdoc.getElementsByTagName('rootfile')[0];
    path = rf?.getAttribute('full-path') ?? undefined;
  }
  if (!path || !zip.file(path)) {
    path = Object.keys(zip.files).find((n) => /\.(xml|musicxml)$/i.test(n) && !n.startsWith('META-INF/'));
  }
  if (!path) throw new MusicXmlError('Could not find a score inside the .mxl file');
  // a tiny archive can unpack to gigabytes: check the declared size before unpacking
  const declared = (zip.file(path) as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (typeof declared === 'number' && declared > MAX_XML_BYTES) throw new MusicXmlError('That score is too large to open.');
  const bytes = await zip.file(path)!.async('uint8array');
  if (bytes.length > MAX_XML_BYTES) throw new MusicXmlError('That score is too large to open.');
  return decodeXmlBytes(bytes);
}

/** Read an uploaded MusicXML file (.musicxml, .xml or .mxl) into an XML string. */
export async function readMusicXmlFile(bytes: Uint8Array, filename: string): Promise<string> {
  if (bytes.length > MAX_XML_BYTES) throw new MusicXmlError('That file is too large to open.');
  const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  const xml = isZip || /\.mxl$/i.test(filename) ? await unzipMxl(bytes) : decodeXmlBytes(bytes);
  const v = validateMusicXml(xml);
  if (!v.ok) throw new MusicXmlError(v.error ?? 'Invalid MusicXML');
  return xml;
}

export interface DetectedSource { id: 'trumpet' | 'mellophone' | 'trombone'; reason: string }

/**
 * Guess which instrument a part is written for: a <transpose> element wins (Bb = -2 -> trumpet,
 * F = -7 -> mellophone), otherwise the clef: bass (or tenor/alto) -> trombone (concert pitch), treble -> trumpet.
 */
export function detectSourceInstrument(xml: string): DetectedSource {
  try {
    const doc = parseXml(xml);
    const part = partsOf(doc)[0];
    if (part) {
      for (const att of Array.from(part.getElementsByTagName('attributes')) as XEl[]) {
        const t = kid(att, 'transpose');
        if (t) {
          const c = (kidNum(t, 'chromatic') ?? 0) + 12 * (kidNum(t, 'octave-change') ?? 0);
          if (c === -2) return { id: 'trumpet', reason: 'Bb transposition marked in the file' };
          if (c === -7) return { id: 'mellophone', reason: 'F transposition marked in the file' };
        }
        const clef = kid(att, 'clef');
        if (clef) {
          const sign = kidText(clef, 'sign');
          if (sign === 'F') return { id: 'trombone', reason: 'bass clef, concert pitch' };
          if (sign === 'C') return { id: 'trombone', reason: 'tenor/alto clef, concert pitch' };
          if (sign === 'G') return { id: 'trumpet', reason: 'treble clef' };
        }
      }
    }
  } catch { /* fall through */ }
  return { id: 'trumpet', reason: 'no clef found, assuming treble' };
}

export interface PartSummary {
  index: number;
  name: string;
  /** "treble", "bass", "tenor", "alto" or "" if the part has no clef. */
  clef: string;
  /** e.g. "2 flats", "1 sharp", "no sharps or flats". */
  key: string;
  /** e.g. "4/4". */
  time: string;
  bars: number;
  notes: number;
}
export interface ScoreSummary { title: string; parts: PartSummary[]; tempo: number | null }

const CLEF_NAMES: Record<string, string> = { G2: 'treble', F4: 'bass', C4: 'tenor', C3: 'alto' };

export function keyName(fifths: number): string {
  if (!fifths) return 'no sharps or flats';
  const n = Math.abs(fifths);
  return `${n} ${fifths < 0 ? 'flat' : 'sharp'}${n > 1 ? 's' : ''}`;
}

/** What a score holds, for the "check the reading" step and the part picker. Never throws. */
export function summariseScore(xml: string): ScoreSummary {
  const out: ScoreSummary = { title: extractTitle(xml), parts: [], tempo: null };
  let doc: XDoc;
  try { doc = parseXml(xml); } catch { return out; }
  const names = new Map<string, string>();
  const list = kid(doc.documentElement, 'part-list');
  if (list) for (const sp of kids(list, 'score-part')) names.set(sp.getAttribute('id') ?? '', kidText(sp, 'part-name') ?? '');
  partsOf(doc).forEach((part, index) => {
    let clef = '', key = '', time = '', notes = 0;
    const measures = kids(part, 'measure');
    for (const m of measures) {
      for (const el of kids(m)) {
        if (el.nodeName === 'attributes') {
          const c = kid(el, 'clef');
          if (c && !clef) clef = CLEF_NAMES[`${kidText(c, 'sign')}${kidText(c, 'line') ?? ''}`] ?? (kidText(c, 'sign') === 'G' ? 'treble' : kidText(c, 'sign') === 'F' ? 'bass' : '');
          const k = kid(el, 'key');
          if (k && !key) key = keyName(kidNum(k, 'fifths') ?? 0);
          const t = kid(el, 'time');
          if (t && !time && kidText(t, 'beats')) time = `${kidText(t, 'beats')}/${kidText(t, 'beat-type')}`;
        } else if (el.nodeName === 'note') { if (kid(el, 'pitch')) notes++; }
        else if (out.tempo === null && (el.nodeName === 'direction' || el.nodeName === 'sound')) {
          const s = el.nodeName === 'sound' ? el : kid(el, 'sound');
          const t = s ? Number(s.getAttribute('tempo')) : NaN;
          if (t >= 20 && t <= 400) out.tempo = Math.round(t);
        }
      }
    }
    const raw = (names.get(part.getAttribute('id') ?? '') ?? '').trim();
    const name = !raw || /^(part|music|musicxml part|voice)$/i.test(raw) ? `Part ${index + 1}` : raw;
    out.parts.push({ index, name, clef, key, time, bars: measures.length, notes });
  });
  return out;
}

/** The score with only part `index` kept (0-based). Returns the input unchanged if there is nothing to remove. */
export function extractPart(xml: string, index: number): string {
  let doc: XDoc;
  try { doc = parseXml(xml); } catch { return xml; }
  const parts = partsOf(doc);
  if (parts.length < 2 || index < 0 || index >= parts.length) return xml;
  const keepId = parts[index].getAttribute('id');
  parts.forEach((p, i) => { if (i !== index) doc.documentElement.removeChild(p); });
  const list = kid(doc.documentElement, 'part-list');
  if (list) {
    for (const el of kids(list)) {
      if (el.nodeName === 'score-part' ? el.getAttribute('id') !== keepId : true) list.removeChild(el); // also drops part-group brackets
    }
  }
  return serializeXml(doc);
}
