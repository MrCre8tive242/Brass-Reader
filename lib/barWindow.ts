import { slotAt, type Timeline } from './timeline';
import { parseXml, serializeXml, partsOf, kids, kid, type XEl, type XDoc } from './musicxml';

const EPS = 1e-6;

/** The bars the 2-bar view shows while one played bar is sounding. */
export interface BarWindow {
  /** Played bar (index into the timeline's play order) that is sounding. */
  slot: number;
  /** WRITTEN bars (1-based) on screen: the bar being played, then the one that is played next (if any). */
  bars: number[];
  /** Played bars the two drawn bars belong to. */
  slots: number[];
  /** Same bars = same drawing: used to reuse a drawn window. */
  key: string;
}

export type Loop = { startQ: number; endQ: number } | null | undefined;

/** The played bar that follows `slot`, or null after the last one. At the end of a practice loop the next bar is the loop's first. */
export function nextSlotOf(tl: Timeline, slot: number, loop?: Loop): number | null {
  const n = tl.measureStartsQ.length;
  if (slot < 0 || slot >= n) return null;
  const start = tl.measureStartsQ[slot];
  const end = slot + 1 < n ? tl.measureStartsQ[slot + 1] : tl.totalQ;
  if (loop && start >= loop.startQ - EPS && start < loop.endQ - EPS && end >= loop.endQ - EPS) return slotAt(tl, loop.startQ);
  return slot + 1 < n ? slot + 1 : null;
}

/** The played bar before `slot` (the loop's last bar before its first), or null before the first one. */
export function prevSlotOf(tl: Timeline, slot: number, loop?: Loop): number | null {
  if (slot <= 0) return null;
  if (loop && Math.abs(tl.measureStartsQ[slot] - loop.startQ) < EPS) return slotAt(tl, loop.endQ - 1e-3);
  return slot - 1;
}

/** What the 2-bar view shows while played bar `slot` sounds: that bar and the next one. The last bar is shown alone. */
export function windowOfSlot(tl: Timeline, slot: number, loop?: Loop): BarWindow {
  const s = Math.max(0, Math.min(tl.measureStartsQ.length - 1, slot));
  const slots = [s];
  const next = nextSlotOf(tl, s, loop);
  if (next !== null) slots.push(next);
  const bars = slots.map((i) => tl.order[i] ?? 1);
  return { slot: s, bars, slots, key: bars.join('+') };
}

/** The window for quarter-note position `q` (play order), and how far into the sounding bar it is. */
export function windowAt(tl: Timeline, q: number, loop?: Loop): BarWindow & { offQ: number } {
  const slot = slotAt(tl, q);
  return { ...windowOfSlot(tl, slot, loop), offQ: Math.max(0, q - (tl.measureStartsQ[slot] ?? 0)) };
}

// ---------------------------------------------------------------------------------------------------------------
// A MusicXML made of just the bars of a window
// ---------------------------------------------------------------------------------------------------------------

/** Order the children of <attributes> must come in. */
const ATTR_ORDER = ['divisions', 'key', 'time', 'staves', 'clef', 'transpose'];

function catOf(el: XEl): string | null {
  if (el.nodeName === 'clef') return `clef:${el.getAttribute('number') ?? '1'}`;
  return ATTR_ORDER.includes(el.nodeName) ? el.nodeName : null;
}
const ser = (el: XEl) => (el as unknown as { toString(): string }).toString();

/** <attributes> that come before the first note of the bar (those later in the bar are kept where they are). */
function leadingAttributes(m: XEl): XEl[] {
  const out: XEl[] = [];
  for (const el of kids(m)) {
    if (el.nodeName === 'note' || el.nodeName === 'forward' || el.nodeName === 'backup') break;
    if (el.nodeName === 'attributes') out.push(el);
  }
  return out;
}

type State = Map<string, XEl>;
function apply(state: State, attrs: XEl[]): State {
  const next = new Map(state);
  for (const a of attrs) for (const c of kids(a)) { const k = catOf(c); if (k) next.set(k, c); }
  return next;
}

/** Tie and slur ends without their other end inside the window are removed (they would point at nothing). */
function dropDanglingSpanners(doc: XDoc, measures: XEl[]) {
  const notes: XEl[] = [];
  for (const m of measures) for (const n of kids(m, 'note')) notes.push(n);
  // ties, matched by pitch and voice
  const pitchKey = (n: XEl) => {
    const p = kid(n, 'pitch');
    if (!p) return '';
    const t = (name: string) => kid(p, name)?.textContent ?? '';
    return `${kid(n, 'voice')?.textContent ?? '1'}:${t('step')}${t('alter')}${t('octave')}`;
  };
  const tieEls = (n: XEl, type: string) => {
    const out: XEl[] = [];
    for (const t of kids(n, 'tie')) if (t.getAttribute('type') === type) out.push(t);
    const nots = kid(n, 'notations');
    if (nots) for (const t of kids(nots, 'tied')) if (t.getAttribute('type') === type) out.push(t);
    return out;
  };
  const open = new Map<string, XEl>();
  for (const n of notes) {
    const k = pitchKey(n);
    if (!k) continue;
    const stops = tieEls(n, 'stop');
    if (stops.length) {
      if (open.has(k)) open.delete(k);
      else for (const e of stops) e.parentNode?.removeChild(e);
    }
    if (tieEls(n, 'start').length) open.set(k, n);
  }
  for (const n of open.values()) for (const e of tieEls(n, 'start')) e.parentNode?.removeChild(e);
  // slurs, matched by number
  const slurs: { el: XEl; type: string; num: string }[] = [];
  for (const n of notes) {
    const nots = kid(n, 'notations');
    if (nots) for (const s of kids(nots, 'slur')) slurs.push({ el: s, type: s.getAttribute('type') ?? '', num: s.getAttribute('number') ?? '1' });
  }
  const openSlur = new Map<string, XEl>();
  for (const s of slurs) {
    if (s.type === 'start') openSlur.set(s.num, s.el);
    else if (s.type === 'stop') { if (openSlur.has(s.num)) openSlur.delete(s.num); else s.el.parentNode?.removeChild(s.el); }
  }
  for (const el of openSlur.values()) el.parentNode?.removeChild(el);
  void doc;
}

/** Marks that reach across bars and would point outside the window. */
const SPANNING = ['wedge', 'octave-shift', 'bracket', 'dashes', 'pedal'];

export interface WindowXml {
  xml: string;
  /** Draw the time signature (the first bar of the piece, or a bar where it changes). */
  showTime: boolean;
}

/**
 * A single-part MusicXML holding only the written bars `bars` (in this order, a bar may appear twice), with the clef, key,
 * time and transposition that were in effect there. `xml` is the (single part) score the timeline was built from.
 */
export function buildWindowXml(xml: string, bars: number[]): WindowXml {
  const doc = parseXml(xml);
  const parts = partsOf(doc);
  const part = parts[0];
  const all = kids(part, 'measure');
  // drop everything that is not my part, and anything that would draw a title
  const root = doc.documentElement;
  for (let i = 1; i < parts.length; i++) root.removeChild(parts[i]);
  const list = kid(root, 'part-list');
  if (list) {
    const keep = part.getAttribute('id');
    for (const sp of kids(list, 'score-part')) if (sp.getAttribute('id') !== keep) list.removeChild(sp);
    for (const g of kids(list, 'part-group')) list.removeChild(g);
  }
  for (const n of ['credit', 'defaults', 'movement-title']) for (const el of kids(root, n)) root.removeChild(el);
  const work = kid(root, 'work');
  if (work) root.removeChild(work);

  // what was in effect at the start and the end of every written bar
  const startEff: State[] = [];
  const endEff: State[] = [];
  let st: State = new Map();
  for (const m of all) {
    st = apply(st, leadingAttributes(m));
    startEff.push(st);
    const later = kids(m, 'attributes').filter((a) => !leadingAttributes(m).includes(a));
    st = apply(st, later);
    endEff.push(st);
  }

  const picked: XEl[] = [];
  let showTime = false;
  bars.forEach((b, j) => {
    const src = all[Math.max(0, Math.min(all.length - 1, b - 1))];
    const idx = all.indexOf(src);
    const m = src.cloneNode(true) as XEl;
    const own = leadingAttributes(m);
    for (const a of own) m.removeChild(a);
    const eff = startEff[idx];
    const prev = j === 0 ? new Map<string, XEl>() : endEff[all.indexOf(all[Math.max(0, Math.min(all.length - 1, bars[j - 1] - 1))])];
    const order = [...eff.keys()].sort((a, b2) => ATTR_ORDER.indexOf(a.split(':')[0]) - ATTR_ORDER.indexOf(b2.split(':')[0]) || a.localeCompare(b2));
    const emit = order.filter((k) => j === 0 || !prev.has(k) || ser(prev.get(k)!) !== ser(eff.get(k)!));
    if (emit.length) {
      const a = doc.createElement('attributes');
      for (const k of emit) a.appendChild(eff.get(k)!.cloneNode(true));
      m.insertBefore(a, m.firstChild);
    }
    if (emit.includes('time') && (j > 0 || own.some((x) => !!kid(x, 'time')))) showTime = true;
    if (kids(m, 'attributes').some((x) => !!kid(x, 'time')) && j > 0) showTime = true;
    if (idx === 0 && j === 0) showTime = true;
    // layout hints of the written score do not apply to a 2-bar excerpt
    for (const p of kids(m, 'print')) m.removeChild(p);
    for (const bl of kids(m, 'barline')) for (const e of kids(bl, 'ending')) bl.removeChild(e);
    for (const d of kids(m, 'direction')) {
      for (const t of kids(d, 'direction-type')) if (SPANNING.some((n) => !!kid(t, n))) d.removeChild(t);
      if (!kids(d, 'direction-type').length) m.removeChild(d);
    }
    m.setAttribute('number', String(j + 1));
    m.removeAttribute('width');
    picked.push(m);
  });
  for (const m of all) part.removeChild(m);
  for (const m of picked) part.appendChild(m);
  dropDanglingSpanners(doc, picked);
  return { xml: serializeXml(doc), showTime };
}
