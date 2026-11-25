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
  const bytes = await zip.file(path)!.async('uint8array');
  return decodeXmlBytes(bytes);
}

/** Read an uploaded MusicXML file (.musicxml, .xml or .mxl) into an XML string. */
export async function readMusicXmlFile(bytes: Uint8Array, filename: string): Promise<string> {
  const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  const xml = isZip || /\.mxl$/i.test(filename) ? await unzipMxl(bytes) : decodeXmlBytes(bytes);
  const v = validateMusicXml(xml);
  if (!v.ok) throw new MusicXmlError(v.error ?? 'Invalid MusicXML');
  return xml;
}
