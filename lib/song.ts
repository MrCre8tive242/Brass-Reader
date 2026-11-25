import { INSTRUMENT_IDS, isInstrumentId, type InstrumentId } from './instruments';
import {
  parseXml, serializeXml, partsOf, kids, kid, kidNum, kidText, summariseScore, extractPart, detectSourceInstrument, type XEl,
} from './musicxml';
import type { Timeline, TimelineEvent } from './timeline';

/** One instrument's sheet within a song: a single-part MusicXML as read, written for `instrument`. */
export interface SongPart { id: string; name: string; xml: string; instrument: InstrumentId }

/** The bits of a saved score the song model needs (kept structural so old records keep working). */
export interface SongSource {
  title?: string;
  sourceXml: string;
  sourceInstrument: InstrumentId;
  partIndex?: number | null;
  parts?: SongPart[];
}

/**
 * The parts of a song. Old records have one MusicXML (single-part, or several parts in one file): they are split
 * here, nothing in storage has to change. `my` (the player's own part) takes the saved "written for" instrument;
 * the others are detected from their clef.
 */
export function songPartsOf(s: SongSource, myIndex = 0): SongPart[] {
  if (s.parts?.length) {
    return s.parts.filter((p) => p && typeof p.xml === 'string').map((p) => ({ ...p, instrument: isInstrumentId(p.instrument) ? p.instrument : 'trumpet' }));
  }
  const summary = summariseScore(s.sourceXml);
  if (summary.parts.length <= 1) {
    return [{ id: 'p0', name: summary.parts[0]?.name || s.title || 'Part 1', xml: s.sourceXml, instrument: s.sourceInstrument }];
  }
  const my = typeof s.partIndex === 'number' ? s.partIndex : myIndex;
  return summary.parts.map((p) => {
    const xml = extractPart(s.sourceXml, p.index);
    return { id: `p${p.index}`, name: p.name, xml, instrument: p.index === my ? s.sourceInstrument : detectSourceInstrument(xml).id };
  });
}

/** Add the part(s) of `xml` (a scan or a file) to a song. Several parts in one file become several parts. */
export function addPartsTo(existing: SongPart[], xml: string, newId: () => string, instrument?: InstrumentId, only?: number): SongPart[] {
  const summary = summariseScore(xml);
  const out = existing.slice();
  const take = summary.parts.length <= 1 ? [0] : only !== undefined ? [only] : summary.parts.map((p) => p.index);
  for (const i of take) {
    const px = summary.parts.length <= 1 ? xml : extractPart(xml, i);
    const name = summary.parts[i]?.name || `Part ${out.length + 1}`;
    out.push({ id: newId(), name: uniqueName(name, out), xml: px, instrument: instrument ?? detectSourceInstrument(px).id });
  }
  return out;
}

function uniqueName(name: string, parts: SongPart[]): string {
  const taken = new Set(parts.map((p) => p.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`;
}

export interface FitResult { xml: string; bars: number; added: number; removed: number }

/** Number of bars (measures) in the first part of a single-part score. */
export function barCount(xml: string): number {
  const p = partsOf(parseXml(xml))[0];
  return p ? kids(p, 'measure').length : 0;
}

/**
 * Make a single-part score exactly `n` bars long: missing bars at the end are whole-bar rests, extra bars are cut.
 * Parts are lined up by bar position (bar 1 with bar 1, and so on).
 */
export function fitBars(xml: string, n: number): FitResult {
  const doc = parseXml(xml);
  const part = partsOf(doc)[0];
  if (!part) return { xml, bars: 0, added: 0, removed: 0 };
  const measures = kids(part, 'measure');
  const have = measures.length;
  if (have === n) return { xml, bars: have, added: 0, removed: 0 };
  if (have > n) {
    for (let i = n; i < have; i++) part.removeChild(measures[i]);
    return { xml: serializeXml(doc), bars: n, added: 0, removed: have - n };
  }
  // length of a full bar in divisions, from the last divisions / time signature written
  let divisions = 1, beats = 4, beatType = 4;
  for (const m of measures) for (const a of kids(m, 'attributes')) {
    const d = kidNum(a, 'divisions'); if (d && d > 0) divisions = d;
    const t = kid(a, 'time');
    if (t) { const b = Number(kidText(t, 'beats')); const bt = kidNum(t, 'beat-type'); if (b > 0 && bt) { beats = b; beatType = bt; } }
  }
  const dur = Math.max(1, Math.round((divisions * 4 * beats) / beatType));
  for (let i = have; i < n; i++) {
    const m = doc.createElement('measure');
    m.setAttribute('number', String(i + 1));
    const note = doc.createElement('note');
    const rest = doc.createElement('rest');
    rest.setAttribute('measure', 'yes');
    const d = doc.createElement('duration'); d.appendChild(doc.createTextNode(String(dur)));
    const v = doc.createElement('voice'); v.appendChild(doc.createTextNode('1'));
    note.appendChild(rest); note.appendChild(d); note.appendChild(v);
    m.appendChild(note);
    part.appendChild(m);
  }
  return { xml: serializeXml(doc), bars: n, added: n - have, removed: 0 };
}

/** One MusicXML holding every part, in the given order (the first one supplies title and layout). */
export function mergeScores(items: { xml: string; name: string }[]): string {
  if (items.length === 1) return items[0].xml;
  const base = parseXml(items[0].xml);
  const root = base.documentElement;
  for (const p of partsOf(base)) root.removeChild(p);
  let list = kid(root, 'part-list');
  if (list) for (const c of kids(list)) list.removeChild(c);
  else {
    list = base.createElement('part-list');
    const firstPart = kids(root)[0];
    // part-list belongs before the first <part>
    root.insertBefore(list, firstPart ?? null);
  }
  items.forEach((it, i) => {
    const doc = i === 0 ? parseXml(items[0].xml) : parseXml(it.xml);
    const part = partsOf(doc)[0];
    if (!part) return;
    const id = `P${i + 1}`;
    const sp = base.createElement('score-part');
    sp.setAttribute('id', id);
    const pn = base.createElement('part-name');
    pn.appendChild(base.createTextNode(it.name));
    sp.appendChild(pn);
    list!.appendChild(sp);
    const imported = base.importNode(part as never, true) as XEl;
    imported.setAttribute('id', id);
    root.appendChild(imported);
  });
  return serializeXml(base);
}

export interface MergeInput { index: number; tl: Timeline }

/**
 * One timeline for the whole band. `master` (the player's own part) decides the bars, the repeats and the
 * time; every other part's notes are placed bar by bar (same bar position, same distance into the bar). A part
 * that has no bar there is silent; notes carry `part` (index into the song's part list).
 */
export function mergeTimelines(master: Timeline, masterIndex: number, others: MergeInput[]): Timeline {
  const events: TimelineEvent[] = master.events.map((e) => ({ ...e, part: masterIndex }));
  for (const o of others) {
    const tl = o.tl;
    // events of this part grouped by the played bar they start in
    const bySlot: TimelineEvent[][] = tl.measureStartsQ.map(() => []);
    let slot = 0;
    for (const e of tl.events) {
      while (slot + 1 < tl.measureStartsQ.length && tl.measureStartsQ[slot + 1] <= e.timeQ + 1e-6) slot++;
      bySlot[slot].push(e);
    }
    // played bars of this part for each written bar, in order of play
    const slotsOf = new Map<number, number[]>();
    tl.order.forEach((w, s) => { const l = slotsOf.get(w) ?? []; l.push(s); slotsOf.set(w, l); });
    const seen = new Map<number, number>();
    master.order.forEach((w, ms) => {
      const k = seen.get(w) ?? 0;
      seen.set(w, k + 1);
      const list = slotsOf.get(w);
      const ps = list ? list[Math.min(k, list.length - 1)] : undefined;
      if (ps === undefined) return;
      const from = tl.measureStartsQ[ps];
      for (const e of bySlot[ps]) {
        events.push({ timeQ: master.measureStartsQ[ms] + (e.timeQ - from), durQ: e.durQ, midi: e.midi, measure: w, part: o.index });
      }
    });
  }
  events.sort((a, b) => a.timeQ - b.timeQ || a.midi - b.midi);
  return { ...master, events };
}

export { INSTRUMENT_IDS };
