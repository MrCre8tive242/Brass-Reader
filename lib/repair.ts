import {
  parseXml, serializeXml, partsOf, kids, kid, kidNum, kidText, type XDoc, type XEl,
} from './musicxml';
import { readFlow } from './timeline';

/** A bar whose length does not match the time signature (the most common optical-reading error). */
export interface BarIssue {
  /** 1-based written bar index. */
  measure: number;
  /** 0-based index of the part the problem was found in. */
  part: number;
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
 * bars marked implicit, a bar that completes the pickup before a repeat sign / Fine / D.C., and the two halves
 * of a bar split by a repeat sign. Empty bars and short single-voice bars are padded with rests (so the cursor and the
 * timeline agree); everything else is only flagged.
 */
export function analyseAndRepair(xml: string): RepairResult {
  let doc: XDoc;
  try { doc = parseXml(xml); } catch { return { xml, issues: [], warnings: [] }; }
  const parts = partsOf(doc);
  const { labels, flow } = readFlow(parts);
  const issues = new Map<number, BarIssue>();
  let changed = false;

  parts.forEach((part, pi) => {
    const measures = kids(part, 'measure');
    let divisions = 1;
    let beats = 0, beatType = 0;
    // pass 1: what every bar holds
    const info = measures.map((m) => {
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
      const known = !!beats && !!beatType;
      return {
        m, known, divisions, notes, multiVoice, lastVoice,
        wantQ: known ? (4 * beats) / beatType : 0,
        haveQ: maxPos / divisions,
        empty: notes === 0 && !m.getElementsByTagName('forward').length,
      };
    });
    const shortBy = (i: number) => (info[i] && info[i].known && !info[i].empty ? info[i].wantQ - info[i].haveQ : 0);
    const pickupQ = info.length && shortBy(0) > TOL ? info[0].haveQ : 0;

    // pass 2: decide
    info.forEach((b, mi) => {
      if (!b.known) return;
      const { m, wantQ, haveQ } = b;
      const isFirst = mi === 0, isLast = mi === measures.length - 1;
      const implicit = m.getAttribute('implicit') === 'yes';
      let kind: BarIssue['kind'] | null = null;
      if (b.empty) kind = 'empty';
      else if (haveQ > wantQ + TOL) kind = 'long';
      else if (haveQ < wantQ - TOL && !(isFirst || isLast || implicit)) {
        const f = flow[mi] ?? {};
        // a bar that completes the pickup (before a repeat sign, Fine, D.C./D.S.) is short on purpose
        const completesPickup = pickupQ > 0 && Math.abs(haveQ + pickupQ - wantQ) < TOL
          && !!(f.backward || f.fine || f.dacapo || f.dalsegno || f.tocoda);
        // a bar split in two by a repeat sign: the two halves add up
        const g = flow[mi + 1] ?? {}, h = flow[mi - 1] ?? {};
        const splitNext = (f.backward || g.forward) && shortBy(mi + 1) > TOL && Math.abs(haveQ + info[mi + 1].haveQ - wantQ) < TOL;
        const splitPrev = mi > 0 && (h.backward || f.forward) && shortBy(mi - 1) > TOL && Math.abs(haveQ + info[mi - 1].haveQ - wantQ) < TOL;
        if (!completesPickup && !splitNext && !splitPrev) kind = 'short';
      }
      if (!kind) return;
      let repaired = false;
      if (kind === 'empty') {
        m.appendChild(makeRest(doc, Math.round(wantQ * b.divisions), null, '1', true));
        repaired = true;
      } else if (kind === 'short' && !b.multiVoice) {
        let left = wantQ - haveQ;
        for (const [q, type] of SIZES) {
          while (left >= q - 1e-6) {
            m.appendChild(makeRest(doc, Math.max(1, Math.round(q * b.divisions)), type, b.lastVoice));
            left -= q;
          }
        }
        repaired = true;
      }
      if (repaired) changed = true;
      const prev = issues.get(mi + 1);
      if (!prev) issues.set(mi + 1, { measure: mi + 1, part: pi, label: labels[mi] ?? String(mi + 1), kind, haveQ, wantQ, repaired });
    });
  });

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
