import {
  parseXml, serializeXml, partsOf, kids, kid, kidNum, kidText, type XDoc, type XEl,
} from './musicxml';
import { readFlow } from './timeline';

/** A bar whose length does not match the time signature (the most common optical-reading error). */
export interface BarIssue {
  /** 1-based written bar index. */
  measure: number;
  /** Printed label ("Pickup", "7"). */
  label: string;
  kind: 'empty' | 'short' | 'long';
  haveQ: number;
  wantQ: number;
  /** True if the bar was padded with rests so playback and cursor stay in step. */
  repaired: boolean;
}

export interface RepairResult {
  /** The (possibly repaired) MusicXML. Identical to the input when nothing was changed. */
  xml: string;
  issues: BarIssue[];
  /** Human readable, e.g. "Bar 7 may be misread (3 of 4 beats)". */
  warnings: string[];
}

const TOL = 0.02; // quarters
const SIZES: Array<[number, string]> = [[4, 'whole'], [2, 'half'], [1, 'quarter'], [0.5, 'eighth'], [0.25, '16th'], [0.125, '32nd']];

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function makeRest(doc: XDoc, durDiv: number, type: string | null, voice: string, measureRest = false): XEl {
  const note = doc.createElement('note');
  const rest = doc.createElement('rest');
  if (measureRest) rest.setAttribute('measure', 'yes');
  note.appendChild(rest);
  const d = doc.createElement('duration'); d.textContent = String(durDiv); note.appendChild(d);
  const v = doc.createElement('voice'); v.textContent = voice; note.appendChild(v);
  if (type) { const t = doc.createElement('type'); t.textContent = type; note.appendChild(t); }
  return note;
}

/**
 * Check every bar against the time signature. Allowed to be short: the first bar (pickup), the last bar,
 * and bars marked implicit. Empty bars and short single-voice bars are padded with rests (so the cursor and the
 * timeline agree); everything else is only flagged.
 */
export function analyseAndRepair(xml: string): RepairResult {
  let doc: XDoc;
  try { doc = parseXml(xml); } catch { return { xml, issues: [], warnings: [] }; }
  const parts = partsOf(doc);
  const { labels } = readFlow(parts);
  const issues = new Map<number, BarIssue>();
  let changed = false;

  for (const part of parts) {
    const measures = kids(part, 'measure');
    let divisions = 1;
    let beats = 0, beatType = 0;
    measures.forEach((m, mi) => {
      let pos = 0, maxPos = 0, lastStart = 0, notes = 0, multiVoice = false;
      let lastVoice = '1';
      for (const el of kids(m)) {
        if (el.nodeName === 'attributes') {
          const d = kidNum(el, 'divisions'); if (d && d > 0) divisions = d;
          const t = kid(el, 'time');
          if (t && !t.getAttribute('symbol')?.includes('senza')) {
            let b = 0;
            for (const x of (kidText(t, 'beats') ?? '').split('+')) b += parseInt(x, 10) || 0;
            const bt = kidNum(t, 'beat-type');
            if (b && bt) { beats = b; beatType = bt; }
          }
        } else if (el.nodeName === 'backup') { pos -= kidNum(el, 'duration') ?? 0; multiVoice = true; }
        else if (el.nodeName === 'forward') { pos += kidNum(el, 'duration') ?? 0; maxPos = Math.max(maxPos, pos); multiVoice = true; }
        else if (el.nodeName === 'note') {
          if (kid(el, 'grace')) continue;
          notes++;
          const v = kidText(el, 'voice'); if (v) lastVoice = v;
          const isChord = !!kid(el, 'chord');
          const dur = kidNum(el, 'duration') ?? 0;
          const start = isChord ? lastStart : pos;
          if (!isChord) { lastStart = pos; pos += dur; }
          maxPos = Math.max(maxPos, pos, start + dur);
        }
      }
      if (!beats || !beatType) return;
      const wantQ = (4 * beats) / beatType;
      const haveQ = maxPos / divisions;
      const isFirst = mi === 0, isLast = mi === measures.length - 1;
      const implicit = m.getAttribute('implicit') === 'yes';
      let kind: BarIssue['kind'] | null = null;
      if (notes === 0 && !m.getElementsByTagName('forward').length) kind = 'empty';
      else if (haveQ > wantQ + TOL) kind = 'long';
      else if (haveQ < wantQ - TOL && !(isFirst || isLast || implicit)) kind = 'short';
      if (!kind) return;
      let repaired = false;
      if (kind === 'empty') {
        m.appendChild(makeRest(doc, Math.round(wantQ * divisions), null, '1', true));
        repaired = true;
      } else if (kind === 'short' && !multiVoice) {
        let left = wantQ - haveQ;
        for (const [q, type] of SIZES) {
          while (left >= q - 1e-6) {
            m.appendChild(makeRest(doc, Math.max(1, Math.round(q * divisions)), type, lastVoice));
            left -= q;
          }
        }
        repaired = true;
      }
      if (repaired) changed = true;
      const prev = issues.get(mi + 1);
      if (!prev) issues.set(mi + 1, { measure: mi + 1, label: labels[mi] ?? String(mi + 1), kind, haveQ, wantQ, repaired });
    });
  }

  const list = [...issues.values()].sort((a, b) => a.measure - b.measure);
  const warnings = list.map((i) => {
    const unitQ = beatsUnit(doc);
    const what = i.kind === 'empty' ? 'is empty' : `has ${fmt(i.haveQ / unitQ)} of ${fmt(i.wantQ / unitQ)} beats`;
    return `Bar ${i.label} may be misread (${what}).`;
  });
  return { xml: changed ? serializeXml(doc) : xml, issues: list, warnings };
}

/** Quarter length of one beat in the first time signature (for messages only). */
function beatsUnit(doc: XDoc): number {
  const t = doc.getElementsByTagName('time')[0] as XEl | undefined;
  const bt = t ? kidNum(t, 'beat-type') : null;
  return bt ? 4 / bt : 1;
}
