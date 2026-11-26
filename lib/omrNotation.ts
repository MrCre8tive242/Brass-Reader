/**
 * Compact line-per-bar reading format used between the vision model and the app.
 *
 * The model writes what is PRINTED (one bar per line, accidentals only where a sign is printed); this module
 * applies the key signature and same-bar accidental rules and builds MusicXML. Compared with asking for MusicXML
 * directly this is roughly ten times shorter (fast, no truncation), cannot be malformed XML, and every bar can be
 * checked and re-read on its own.
 *
 *   title: When the Saints
 *   part: Trumpet 1
 *   clef: treble
 *   key: 2b
 *   time: 4/4
 *   0: r:q C4:q E4:q F4:q
 *   1: |: G4:w~
 *   2: G4:q Bn4:e. A4:s r:h [1 :|
 *   3: [2 R ]
 *   4-11: R
 *   ? 2: second note may be B4 or Bb4 (smudged)
 */

import { parseXml, serializeXml, partsOf, kids, kid, kidText, kidNum } from './musicxml';

export type Acc = '' | '#' | 'b' | 'n' | 'x' | 'bb';
export interface NPitch { step: string; acc: Acc; octave: number }
export interface NItem {
  /** Empty = rest. */
  pitches: NPitch[];
  /** Quarter-note length of the printed note value (without dots / tuplet). */
  baseQ: number;
  type: string;
  dots: number;
  tuplet: { actual: number; normal: number } | null;
  tie: boolean;
  grace: boolean;
}
export interface NTime { beats: number; beatType: number; symbol?: 'common' | 'cut' }
export interface NBar {
  /** Bar label as the reader wrote it ("0", "12", "pickup"). */
  label: string;
  items: NItem[];
  fullRest: boolean;
  repeatStart: boolean;
  repeatEnd: boolean;
  times?: number;
  endingStart?: number[];
  endingStop: boolean;
  key?: number;
  time?: NTime;
  clef?: string;
  marks: string[];
  /** Tokens that could not be understood. */
  problems: string[];
  /** The bar's tokens as written (for retry prompts). */
  raw: string;
}
export interface NPart { name: string; clef: string; key: number; time: NTime; bars: NBar[] }
export interface NNote { bar: string; part: number; text: string }
export interface NScore {
  title: string;
  tempo: number | null;
  parts: NPart[];
  /** Places where the reader said it was unsure. */
  notes: NNote[];
  /** Lines that could not be understood at all. */
  problems: string[];
}

/** Written into the MusicXML so the app knows that <accidental> marks exactly the signs printed on the page. */
export const SOFTWARE = 'Brass Reader';
export const DIV = 5040; // divisions per quarter: every value down to dotted 32nds and 3/5/6/7-tuplets is an integer

const TYPES: Record<string, [number, string]> = {
  w: [4, 'whole'], h: [2, 'half'], q: [1, 'quarter'], e: [0.5, 'eighth'], s: [0.25, '16th'], t: [0.125, '32nd'],
  '1': [4, 'whole'], '2': [2, 'half'], '4': [1, 'quarter'], '8': [0.5, 'eighth'], '16': [0.25, '16th'], '32': [0.125, '32nd'],
};
/** n printed notes take the time of `normal` ordinary ones. */
const TUPLET_NORMAL: Record<number, number> = { 2: 3, 3: 2, 4: 3, 5: 4, 6: 4, 7: 4, 9: 8 };
const CLEFS: Record<string, { sign: string; line: number; oct?: number }> = {
  treble: { sign: 'G', line: 2 }, bass: { sign: 'F', line: 4 }, tenor: { sign: 'C', line: 4 }, alto: { sign: 'C', line: 3 },
  treble8vb: { sign: 'G', line: 2, oct: -1 }, treble8va: { sign: 'G', line: 2, oct: 1 }, bass8vb: { sign: 'F', line: 4, oct: -1 },
};
const MAJOR: Record<string, number> = { c: 0, g: 1, d: 2, a: 3, e: 4, b: 5, 'f#': 6, 'c#': 7, f: -1, bb: -2, eb: -3, ab: -4, db: -5, gb: -6, cb: -7 };
const MINOR: Record<string, number> = { a: 0, e: 1, b: 2, 'f#': 3, 'c#': 4, 'g#': 5, 'd#': 6, 'a#': 7, d: -1, g: -2, c: -3, f: -4, bb: -5, eb: -6, ab: -7 };
const SHARP_ORDER = 'FCGDAEB';
const ACC_ALTER: Record<string, number> = { '#': 1, b: -1, n: 0, x: 2, bb: -2 };
const ACC_NAME: Record<string, string> = { '#': 'sharp', b: 'flat', n: 'natural', x: 'double-sharp', bb: 'flat-flat' };

/** "2b", "3#", "-2", "2 flats", "none", "Bb major", "g minor" -> fifths (-7..7), or null. */
export function parseKey(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/♭/g, 'b').replace(/♯/g, '#');
  if (t === '' ) return null;
  if (/^(0|none|no sharps or flats|c|c major|a minor|am)$/.test(t)) return 0;
  let m = t.match(/^([+-]?\d)$/);
  if (m) return clampKey(Number(m[1]));
  m = t.match(/^(\d)\s*(b|#|flats?|sharps?)$/);
  if (m) return clampKey(Number(m[1]) * (m[2].startsWith('b') || m[2].startsWith('f') ? -1 : 1));
  m = t.match(/^(b{1,7}|#{1,7})$/);
  if (m) return clampKey(m[1].length * (m[1][0] === 'b' ? -1 : 1));
  m = t.match(/^([a-g](?:b|#)?)\s*(major|maj|minor|min|m)?$/);
  if (m) {
    const minor = m[2] === 'minor' || m[2] === 'min' || m[2] === 'm';
    const v = (minor ? MINOR : MAJOR)[m[1]];
    return v === undefined ? null : v;
  }
  return null;
}
function clampKey(n: number): number | null { return Number.isFinite(n) && n >= -7 && n <= 7 ? n : null; }

/** "4/4", "C", "cut", "6/8", "2/2" -> time, or null. */
export function parseTime(s: string): NTime | null {
  const t = s.trim().toLowerCase();
  if (t === 'c' || t === 'common') return { beats: 4, beatType: 4, symbol: 'common' };
  if (t === 'cut' || t === 'c|' || t === 'alla breve') return { beats: 2, beatType: 2, symbol: 'cut' };
  const m = t.match(/^(\d{1,2})\s*\/\s*(\d{1,2})$/);
  if (!m) return null;
  const beats = Number(m[1]), beatType = Number(m[2]);
  if (beats < 1 || beats > 32 || ![1, 2, 4, 8, 16, 32].includes(beatType)) return null;
  return { beats, beatType };
}

export function parseClef(s: string): string | null {
  const t = s.trim().toLowerCase().replace(/[\s_-]+/g, '').replace(/clef$/, '');
  if (t in CLEFS) return t;
  if (t === 'g' || t === 'g2') return 'treble';
  if (t === 'f' || t === 'f4') return 'bass';
  if (t === 'c4') return 'tenor';
  if (t === 'c' || t === 'c3') return 'alto';
  return null;
}

const NOTE_RE = /^((?:[A-G](?:##|bb|#|b|n|x)?\d)(?:\+[A-G](?:##|bb|#|b|n|x)?\d)*|r|z)[:/]?(32|16|[whqestg1248])(\.{0,2})(?:\/(\d))?(~?)$/;
const PITCH_RE = /([A-G])(##|bb|#|b|n|x)?(\d)/g;

function newBar(label: string): NBar {
  return { label, items: [], fullRest: false, repeatStart: false, repeatEnd: false, endingStop: false, marks: [], problems: [], raw: '' };
}

function markOf(tok: string): string | null {
  const t = tok.toLowerCase().replace(/[.\s_-]/g, '');
  if (t === 'segno' || t === 'coda' || t === 'fine' || t === 'tocoda') return t;
  const m = t.match(/^(dc|ds)(?:al)?(fine|coda)?$/);
  return m ? (m[2] ? `${m[1]}.${m[2]}` : m[1]) : null;
}

/** Parse the tokens of one bar. `startNext` = the bar ended with `:|:`, so the next bar starts a repeat. */
function parseBarTokens(label: string, text: string): { bar: NBar; rests: number; startNext: boolean } {
  const bar = newBar(label);
  bar.raw = text.trim();
  let rests = 1;
  let startNext = false;
  const toks = text.replace(/:\|:/g, ' :|: ').split(/\s+/).filter(Boolean);
  for (let tok of toks) {
    if (tok === '|' || tok === '||' || tok === '|]') continue;
    if ((tok === '~' || tok === '-') && bar.items.length) { const last = bar.items[bar.items.length - 1]; last.tie = last.pitches.length > 0; continue; }
    if (/^\|+:$/.test(tok)) { bar.repeatStart = true; continue; }
    if (/[^:|]\|+$/.test(tok)) tok = tok.replace(/\|+$/, ''); // a bar line stuck to the last note
    if (tok === ':|:') { bar.repeatEnd = true; startNext = true; continue; }
    let m = tok.match(/^:\|+(?:x?(\d))?$/);
    if (m) { bar.repeatEnd = true; if (m[1] && Number(m[1]) > 2) bar.times = Number(m[1]); continue; }
    m = tok.match(/^\[(\d(?:[,-]\d)*)\.?$/);
    if (m) {
      const nums: number[] = [];
      for (const p of m[1].split(',')) {
        const r = p.split('-').map(Number);
        for (let k = r[0]; k <= (r[1] ?? r[0]) && nums.length < 9; k++) nums.push(k);
      }
      bar.endingStart = nums;
      continue;
    }
    if (tok === ']') { bar.endingStop = true; continue; }
    m = tok.match(/^(key|time|clef)=(.+)$/i);
    if (m) {
      const k = m[1].toLowerCase();
      if (k === 'key') { const v = parseKey(m[2]); if (v === null) bar.problems.push(`unknown key "${m[2]}"`); else bar.key = v; }
      else if (k === 'time') { const v = parseTime(m[2]); if (!v) bar.problems.push(`unknown time "${m[2]}"`); else bar.time = v; }
      else { const v = parseClef(m[2]); if (!v) bar.problems.push(`unknown clef "${m[2]}"`); else bar.clef = v; }
      continue;
    }
    m = tok.match(/^R(?:[*x](\d{1,3}))?$/);
    if (m) { bar.fullRest = true; if (m[1]) rests = Math.max(1, Math.min(200, Number(m[1]))); continue; }
    const mark = markOf(tok);
    if (mark) { bar.marks.push(mark); continue; }
    m = tok.match(NOTE_RE);
    if (m) {
      const grace = m[2] === 'g';
      const [baseQ, type] = grace ? [0.5, 'eighth'] : TYPES[m[2]];
      const pitches: NPitch[] = [];
      if (m[1] !== 'r' && m[1] !== 'z') {
        for (const p of m[1].matchAll(PITCH_RE)) pitches.push({ step: p[1], acc: (p[2] === '##' ? 'x' : p[2] ?? '') as Acc, octave: Number(p[3]) });
      }
      const n = m[4] ? Number(m[4]) : 0;
      const tuplet = n && TUPLET_NORMAL[n] ? { actual: n, normal: TUPLET_NORMAL[n] } : null;
      if (n && !tuplet) bar.problems.push(`unknown tuplet "${tok}"`);
      if (grace && pitches.length === 0) continue;
      bar.items.push({ pitches, baseQ, type, dots: m[3].length, tuplet, tie: m[5] === '~' && pitches.length > 0, grace });
      continue;
    }
    bar.problems.push(`could not read "${tok.slice(0, 16)}"`);
  }
  if (bar.fullRest && bar.items.length) bar.fullRest = false; // notes win over a stray R
  return { bar, rests, startNext };
}

function cleanText(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Parse a reading. Never throws: unknown lines and tokens are collected in `problems`. */
export function parseNotation(text: string): NScore {
  const score: NScore = { title: '', tempo: null, parts: [], notes: [], problems: [] };
  let part: NPart | null = null;
  let pendingStart = false;
  let pendingAttr: { clef?: string; key?: number; time?: NTime } = {};
  const ensure = (): NPart => {
    if (!part) {
      // every part of a score shares the time signature; clef and key are per instrument
      const prev = score.parts[score.parts.length - 1];
      part = { name: '', clef: 'treble', key: 0, time: prev ? { ...prev.time } : { beats: 4, beatType: 4 }, bars: [] };
      score.parts.push(part);
    }
    return part;
  };
  for (const rawLine of text.replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('```') || line.startsWith('//')) continue;
    let m = line.match(/^\?\s*(pickup|\d{1,4})\s*[:.)-]?\s*(.*)$/i);
    if (m) {
      if (score.notes.length < 24) score.notes.push({ bar: m[1].toLowerCase() === 'pickup' ? '0' : String(Number(m[1])), part: Math.max(0, score.parts.length - 1), text: cleanText(m[2], 140) });
      continue;
    }
    if (line.startsWith('?')) {
      if (score.notes.length < 24) score.notes.push({ bar: '', part: Math.max(0, score.parts.length - 1), text: cleanText(line.slice(1), 140) });
      continue;
    }
    m = line.match(/^(title|part|clef|key|time|tempo)\s*[:=]\s*(.*)$/i);
    if (m) {
      const k = m[1].toLowerCase(), v = m[2].trim();
      if (k === 'title') { if (!score.title) score.title = cleanText(v, 120); }
      else if (k === 'tempo') { const n = parseInt(v.replace(/^\D+/, ''), 10); if (n >= 20 && n <= 400) score.tempo = n; }
      else if (k === 'part') {
        if (part && (part as NPart).bars.length > 0) { part = null; pendingStart = false; }
        ensure().name = cleanText(v, 60);
      } else {
        const p = ensure();
        const target = p.bars.length === 0 ? null : p.bars.length; // header after bars = change at the next bar
        if (k === 'clef') { const c = parseClef(v); if (!c) score.problems.push(`unknown clef "${cleanText(v, 20)}"`); else if (target === null) p.clef = c; else pendingAttr.clef = c; }
        else if (k === 'key') { const c = parseKey(v); if (c === null) score.problems.push(`unknown key "${cleanText(v, 20)}"`); else if (target === null) p.key = c; else pendingAttr.key = c; }
        else { const c = parseTime(v); if (!c) score.problems.push(`unknown time "${cleanText(v, 20)}"`); else if (target === null) p.time = c; else pendingAttr.time = c; }
      }
      continue;
    }
    m = line.match(/^(?:bar\s*)?(pickup|\d{1,4})(?:\s*-\s*(\d{1,4}))?\s*:\s*(.*)$/i);
    if (m) {
      const p = ensure();
      const first = m[1].toLowerCase() === 'pickup' ? 0 : Number(m[1]);
      const { bar, rests, startNext } = parseBarTokens(String(first), m[3]);
      if (pendingStart) { bar.repeatStart = true; pendingStart = false; }
      if (pendingAttr.clef && !bar.clef) bar.clef = pendingAttr.clef;
      if (pendingAttr.key !== undefined && bar.key === undefined) bar.key = pendingAttr.key;
      if (pendingAttr.time && !bar.time) bar.time = pendingAttr.time;
      pendingAttr = {};
      const span = m[2] ? Number(m[2]) - first + 1 : rests;
      if (bar.fullRest && span > 1 && span <= 200) {
        for (let i = 0; i < span; i++) {
          const b: NBar = { ...bar, label: String(first + i), marks: i === 0 ? bar.marks : [], repeatStart: i === 0 && bar.repeatStart, repeatEnd: i === span - 1 && bar.repeatEnd, endingStart: i === 0 ? bar.endingStart : undefined, endingStop: i === span - 1 && bar.endingStop, key: i === 0 ? bar.key : undefined, time: i === 0 ? bar.time : undefined, clef: i === 0 ? bar.clef : undefined, problems: i === 0 ? bar.problems : [] };
          p.bars.push(b);
        }
      } else {
        if (m[2]) bar.problems.push('a range of bars must be a rest (R)');
        p.bars.push(bar);
      }
      pendingStart = startNext;
      continue;
    }
    if (score.problems.length < 12) score.problems.push(`could not read the line "${cleanText(line, 40)}"`);
  }
  return score;
}

export function barCount(score: NScore): number {
  return score.parts.reduce((n, p) => Math.max(n, p.bars.length), 0);
}

// ---------------------------------------------------------------- MusicXML

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function keyAlter(fifths: number, step: string): number {
  if (fifths > 0) return SHARP_ORDER.slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return SHARP_ORDER.split('').reverse().join('').slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}

function itemDiv(it: NItem): number {
  let q = it.baseQ;
  if (it.dots === 1) q *= 1.5; else if (it.dots === 2) q *= 1.75;
  if (it.tuplet) q = (q * it.tuplet.normal) / it.tuplet.actual;
  return Math.round(q * DIV);
}

/** Length in quarters of what is written in a bar (grace notes excluded). */
export function notatedBarQ(bar: NBar, time: NTime): number {
  if (bar.fullRest) return (4 * time.beats) / time.beatType;
  return bar.items.reduce((n, it) => n + (it.grace ? 0 : itemDiv(it)), 0) / DIV;
}

function attributesXml(first: boolean, key: number | undefined, time: NTime | undefined, clef: string | undefined): string {
  if (!first && key === undefined && !time && !clef) return '';
  let s = '<attributes>';
  if (first) s += `<divisions>${DIV}</divisions>`;
  if (key !== undefined) s += `<key><fifths>${key}</fifths></key>`;
  if (time) s += `<time${time.symbol ? ` symbol="${time.symbol}"` : ''}><beats>${time.beats}</beats><beat-type>${time.beatType}</beat-type></time>`;
  if (clef && CLEFS[clef]) {
    const c = CLEFS[clef];
    s += `<clef><sign>${c.sign}</sign><line>${c.line}</line>${c.oct ? `<clef-octave-change>${c.oct}</clef-octave-change>` : ''}</clef>`;
  }
  return s + '</attributes>';
}

const WORDS: Record<string, [string, string]> = {
  fine: ['Fine', 'fine="yes"'], tocoda: ['To Coda', 'tocoda="coda"'],
  dc: ['D.C.', 'dacapo="yes"'], 'dc.fine': ['D.C. al Fine', 'dacapo="yes"'], 'dc.coda': ['D.C. al Coda', 'dacapo="yes"'],
  ds: ['D.S.', 'dalsegno="segno"'], 'ds.fine': ['D.S. al Fine', 'dalsegno="segno"'], 'ds.coda': ['D.S. al Coda', 'dalsegno="segno"'],
};

function markXml(mark: string): string {
  if (mark === 'segno') return '<direction placement="above"><direction-type><segno/></direction-type><sound segno="segno"/></direction>';
  if (mark === 'coda') return '<direction placement="above"><direction-type><coda/></direction-type><sound coda="coda"/></direction>';
  const w = WORDS[mark];
  return w ? `<direction placement="above"><direction-type><words>${w[0]}</words></direction-type><sound ${w[1]}/></direction>` : '';
}

/** True if the bar labels can be used as printed bar numbers (integers, strictly increasing). */
function labelsUsable(bars: NBar[]): boolean {
  let prev = -1;
  for (const b of bars) {
    const n = Number(b.label);
    if (!Number.isInteger(n) || n <= prev) return false;
    prev = n;
  }
  return true;
}

export interface ConvertResult {
  xml: string;
  /** Things worth telling the player (already phrased for them). */
  warnings: string[];
}

/** Build MusicXML (score-partwise 4.0) from a parsed reading. */
export function notationToMusicXml(score: NScore): ConvertResult {
  const warnings: string[] = [];
  const total = barCount(score);
  const lead = score.parts[0];
  const usable = !!lead && labelsUsable(lead.bars);
  if (lead && !usable && lead.bars.length > 1) warnings.push('The bar numbers did not run in order, so bars were renumbered from the start.');
  if (lead && usable) {
    const nums = lead.bars.map((b) => Number(b.label));
    const missing: number[] = [];
    for (let i = 1; i < nums.length; i++) for (let k = nums[i - 1] + 1; k < nums[i] && missing.length < 8; k++) missing.push(k);
    if (missing.length) warnings.push(`Bar${missing.length > 1 ? 's' : ''} ${missing.join(', ')} may be missing from the reading.`);
  }

  let out = '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0">';
  if (score.title) out += `<work><work-title>${esc(score.title)}</work-title></work>`;
  out += `<identification><encoding><software>${SOFTWARE}</software></encoding></identification>`;
  out += '<part-list>';
  score.parts.forEach((p, i) => { out += `<score-part id="P${i + 1}"><part-name>${esc(p.name || (score.parts.length > 1 ? `Part ${i + 1}` : 'Part'))}</part-name></score-part>`; });
  out += '</part-list>';

  score.parts.forEach((p, pi) => {
    if (p.bars.length < total) warnings.push(`${p.name || `Part ${pi + 1}`} has ${p.bars.length} bars but another part has ${total}; rests were added at the end.`);
    out += `\n<part id="P${pi + 1}">`;
    let key = p.key;
    let time = p.time;
    let endingOpen: number[] | null = null;
    let tied = new Map<string, number>(); // step+octave -> alter of notes tied into the next note
    const pickup = lead.bars[0] && Number(lead.bars[0].label) === 0;
    for (let bi = 0; bi < total; bi++) {
      const bar = p.bars[bi] ?? { ...newBar(''), fullRest: true };
      const src = lead.bars[bi];
      const number = usable && src ? src.label : String(bi + (pickup ? 0 : 1));
      const first = bi === 0;
      // a time change written only in the first part applies to all of them
      const barTime = bar.time ?? (pi > 0 && !first ? src?.time : undefined);
      if (bar.key !== undefined) key = bar.key;
      if (barTime) time = barTime;
      out += `\n<measure number="${number}"${first && pickup ? ' implicit="yes"' : ''}>`;
      out += attributesXml(first, first ? key : bar.key, first ? time : barTime, first ? (bar.clef ?? p.clef) : bar.clef);
      if (first && pi === 0 && score.tempo) {
        out += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${score.tempo}</per-minute></metronome></direction-type><sound tempo="${score.tempo}"/></direction>`;
      }
      // left barline: repeat start and/or ending start
      const startEnding = bar.endingStart?.length ? bar.endingStart : null;
      if (startEnding && endingOpen) endingOpen = null; // a new bracket closes the previous one (its stop was emitted below)
      if (bar.repeatStart || startEnding) {
        out += '<barline location="left">';
        if (bar.repeatStart) out += '<bar-style>heavy-light</bar-style>';
        if (startEnding) out += `<ending number="${startEnding.join(', ')}" type="start"/>`;
        if (bar.repeatStart) out += '<repeat direction="forward"/>';
        out += '</barline>';
        if (startEnding) endingOpen = startEnding;
      }
      for (const mk of bar.marks) if (mk === 'segno' || mk === 'coda') out += markXml(mk);

      // notes
      const state = new Map<string, number>();
      let nextTied = new Map<string, number>();
      let tupletLeft = 0; // divisions left in the open tuplet group
      if (bar.fullRest || bar.items.length === 0) {
        out += `<note><rest measure="yes"/><duration>${Math.round(((4 * time.beats) / time.beatType) * DIV)}</duration><voice>1</voice></note>`;
        tied = new Map();
      } else {
        bar.items.forEach((it, ii) => {
          const dur = itemDiv(it);
          let tupletNote = '';
          if (it.tuplet && !it.grace) {
            if (tupletLeft <= 0) {
              tupletLeft = Math.round(it.baseQ * DIV * it.tuplet.normal);
              tupletNote = 'start';
            }
            tupletLeft -= dur;
            const nxt = bar.items[ii + 1];
            if (tupletLeft <= 1 || !nxt || !nxt.tuplet) { tupletNote = tupletNote === 'start' ? '' : 'stop'; tupletLeft = 0; }
          }
          const head = (inner: string, chord: boolean, extra: string, nots: string) =>
            `<note>${it.grace ? '<grace/>' : ''}${chord ? '<chord/>' : ''}${inner}${it.grace ? '' : `<duration>${dur}</duration>`}${extra}<voice>1</voice><type>${it.type}</type>${'<dot/>'.repeat(it.dots)}`
            + '%ACC%'
            + (it.tuplet ? `<time-modification><actual-notes>${it.tuplet.actual}</actual-notes><normal-notes>${it.tuplet.normal}</normal-notes></time-modification>` : '')
            + (nots ? `<notations>${nots}</notations>` : '') + '</note>';
          if (it.pitches.length === 0) {
            out += head('<rest/>', false, '', tupletNote ? `<tuplet type="${tupletNote}"/>` : '').replace('%ACC%', '');
            if (!it.grace) tied = new Map();
            return;
          }
          it.pitches.forEach((pt, ci) => {
            const id = `${pt.step}${pt.octave}`;
            let alter: number;
            const cameTied = !it.grace && tied.has(id);
            if (pt.acc) { alter = ACC_ALTER[pt.acc]; state.set(id, alter); }
            else if (cameTied && !state.has(id)) alter = tied.get(id)!; // a tied note keeps its pitch across the barline
            else alter = state.get(id) ?? keyAlter(key, pt.step);
            const stop = cameTied && tied.get(id) === alter;
            // only a tie to the SAME pitch is a tie; anything else was a slur
            const nxt = bar.items.slice(ii + 1).find((x) => !x.grace) ?? (bi + 1 < total ? (p.bars[bi + 1]?.items ?? []).find((x) => !x.grace) : undefined);
            const start = it.tie && !it.grace && !!nxt && nxt.pitches.some((q) => q.step === pt.step && q.octave === pt.octave);
            if (start) nextTied.set(id, alter);
            const ties = `${stop ? '<tie type="stop"/>' : ''}${start ? '<tie type="start"/>' : ''}`;
            const nots = `${stop ? '<tied type="stop"/>' : ''}${start ? '<tied type="start"/>' : ''}${ci === 0 && tupletNote ? `<tuplet type="${tupletNote}"/>` : ''}`;
            const pitch = `<pitch><step>${pt.step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${pt.octave}</octave></pitch>`;
            out += head(pitch, ci > 0, ties, nots).replace('%ACC%', pt.acc ? `<accidental>${ACC_NAME[pt.acc]}</accidental>` : '');
          });
          if (!it.grace) { tied = nextTied; nextTied = new Map(); }
        });
      }
      for (const mk of bar.marks) if (mk !== 'segno' && mk !== 'coda') out += markXml(mk);

      // right barline: repeat end and/or ending stop
      const nextStarts = !!p.bars[bi + 1]?.endingStart?.length;
      const lastEnding = endingOpen && !p.bars.slice(bi + 1).some((b) => b.endingStart?.length);
      let stopType = '';
      if (endingOpen) {
        if (bar.repeatEnd || nextStarts) stopType = 'stop';
        else if (bar.endingStop) stopType = 'discontinue';
        // the last bracket with no explicit end: assume it covers the bar it starts on
        else if (lastEnding && startEnding && !p.bars.slice(bi + 1).some((b) => b.endingStop)) stopType = 'discontinue';
        else if (bi === total - 1) stopType = 'discontinue';
      }
      if (bar.repeatEnd || stopType) {
        out += '<barline location="right">';
        if (bar.repeatEnd) out += '<bar-style>light-heavy</bar-style>';
        if (stopType) out += `<ending number="${endingOpen!.join(', ')}" type="${stopType}"/>`;
        if (bar.repeatEnd) out += `<repeat direction="backward"${bar.times ? ` times="${bar.times}"` : ''}/>`;
        out += '</barline>';
        if (stopType) endingOpen = null;
      }
      out += '</measure>';
    }
    out += '\n</part>';
  });
  out += '\n</score-partwise>';
  return { xml: out, warnings };
}

// ---------------------------------------------------------------- corrections

/**
 * Merge a reply that contains only corrected bar lines into an earlier reading. Bars are matched by part
 * (by position) and bar label. Header lines in the correction (time/key/clef) replace the part's header.
 * Returns the number of bars replaced.
 */
export function mergeCorrections(base: NScore, fixText: string): number {
  const fix = parseNotation(fixText);
  let replaced = 0;
  fix.parts.forEach((fp, i) => {
    const byName = fp.name ? base.parts.findIndex((p) => p.name && p.name.toLowerCase() === fp.name.toLowerCase()) : -1;
    const target = base.parts[byName >= 0 ? byName : Math.min(i, base.parts.length - 1)];
    if (!target) return;
    const hdr = headerSeen(fixText);
    if (hdr.time) target.time = fp.time;
    if (hdr.key) target.key = fp.key;
    if (hdr.clef) target.clef = fp.clef;
    for (const b of fp.bars) {
      const idx = target.bars.findIndex((x) => x.label === b.label);
      if (idx < 0) continue;
      target.bars[idx] = b;
      replaced++;
    }
  });
  for (const n of fix.notes) if (base.notes.length < 24 && !base.notes.some((x) => x.bar === n.bar && x.text === n.text)) base.notes.push(n);
  return replaced;
}

function headerSeen(text: string): { time: boolean; key: boolean; clef: boolean } {
  return { time: /^\s*time\s*[:=]/im.test(text), key: /^\s*key\s*[:=]/im.test(text), clef: /^\s*clef\s*[:=]/im.test(text) };
}

// ---------------------------------------------------------------- key signature correction

/** True if this MusicXML was built by `notationToMusicXml` (so its key signature can be corrected safely). */
export function canRekey(xml: string): boolean {
  return xml.includes(`<software>${SOFTWARE}</software>`);
}

/**
 * Change the opening key signature of a reading and re-derive every pitch from it, as if the reader had counted
 * the sharps or flats correctly: notes with a printed accidental keep it, an accidental still lasts to the end
 * of its bar, tied notes keep their pitch, and everything else follows the new key. Sections after a later
 * key change inside the piece are left alone. `part` limits the change to one part (0-based).
 */
export function rekeyXml(xml: string, fifths: number, part?: number): string {
  if (!canRekey(xml) || !Number.isInteger(fifths) || fifths < -7 || fifths > 7) return xml;
  const doc = parseXml(xml);
  partsOf(doc).forEach((p, pi) => {
    if (part !== undefined && pi !== part) return;
    let first = true;
    let active = true; // false once a later key change is reached
    let prevTied = new Map<string, number>(); // ties started by the previous note (or chord)
    let curTied = new Map<string, number>(); // ties started by the note (or chord) being read
    for (const m of kids(p, 'measure')) {
      const state = new Map<string, number>();
      for (const el of kids(m)) {
        if (el.nodeName === 'attributes') {
          const k = kid(el, 'key');
          if (k && first) { const f = kid(k, 'fifths'); if (f) f.textContent = String(fifths); first = false; }
          else if (k) active = false;
          continue;
        }
        if (el.nodeName !== 'note' || !active) continue;
        const grace = !!kid(el, 'grace');
        if (!grace && !kid(el, 'chord')) { prevTied = curTied; curTied = new Map(); }
        const pitch = kid(el, 'pitch');
        if (!pitch) continue;
        const step = kidText(pitch, 'step') ?? 'C';
        const id = `${step}${kidText(pitch, 'octave')}`;
        const printed = kidText(el, 'accidental');
        const ties = kids(el, 'tie').map((t) => t.getAttribute('type'));
        let alter: number;
        if (printed) {
          const sym = Object.keys(ACC_NAME).find((k) => ACC_NAME[k] === printed);
          alter = sym ? ACC_ALTER[sym] : kidNum(pitch, 'alter') ?? 0;
          state.set(id, alter);
        } else if (!grace && ties.includes('stop') && prevTied.has(id) && !state.has(id)) alter = prevTied.get(id)!;
        else alter = state.get(id) ?? keyAlter(fifths, step);
        const a = kid(pitch, 'alter');
        if (alter) {
          if (a) a.textContent = String(alter);
          else { const n = doc.createElement('alter'); n.textContent = String(alter); pitch.insertBefore(n, kid(pitch, 'octave')); }
        } else if (a) pitch.removeChild(a);
        if (!grace && ties.includes('start')) curTied.set(id, alter);
      }
    }
  });
  return serializeXml(doc);
}

// ---------------------------------------------------------------- strips read separately

const BAR_LINE = /^(\s*(?:bar\s*)?)(pickup|\d{1,4})(\s*-\s*)?(\d{1,4})?(\s*:.*)$/i;
const FLAG_LINE = /^(\s*\?\s*)(pickup|\d{1,4})(.*)$/i;
const HEADER_LINE = /^\s*(title|part|clef|key|time|tempo)\s*[:=]\s*(.*)$/i;

/** The key, time and clef in force at the end of a part (header values, then the changes written in its bars). */
function endState(p: NPart): { clef: string; key: number; time: NTime } {
  const st = { clef: p.clef, key: p.key, time: p.time };
  for (const b of p.bars) { if (b.clef) st.clef = b.clef; if (b.key !== undefined) st.key = b.key; if (b.time) st.time = b.time; }
  return st;
}

const sameTime = (a: NTime, b: NTime) => a.beats === b.beats && a.beatType === b.beatType;

/**
 * Join the readings of several strips of one piece (each read on its own, numbering its bars from 1) into one
 * reading in the same text format. The header (title, part name, tempo, starting clef/key/time) comes from the first strip.
 * Later strips: bars are renumbered to continue, title/part/tempo lines are dropped, and a clef/key/time line is
 * kept only if it differs from what is in force (it then applies from that strip's first bar); a strip that does not
 * print a time signature (the usual case below the first system) keeps the one in force. Flag lines ("? 4: ...")
 * move with their bars. Repeats, endings and signs are bar tokens and pass through untouched.
 * Returns null if the strips cannot be joined safely (a reading with several parts, or with no bars).
 */
export function mergeStripReadings(texts: string[]): string | null {
  if (texts.length === 0) return null;
  const out: string[] = [];
  let state: { clef: string; key: number; time: NTime } | null = null;
  let offset = 0; // highest bar number so far
  for (let k = 0; k < texts.length; k++) {
    const text = texts[k].replace(/\r/g, '').replace(/^```[a-z]*\n?|```$/gm, '').trim();
    const score = parseNotation(text);
    if (score.parts.length !== 1 || score.parts[0].bars.length === 0) return null;
    const part = score.parts[0];
    const labels = part.bars.map((b) => Number(b.label));
    const last = Math.max(...labels);
    if (k === 0) {
      out.push(text);
      state = endState(part);
      offset = last;
      continue;
    }
    // a pickup does not exist after the first strip: its bar becomes an ordinary one and the rest follow it
    const shift = offset + (labels.includes(0) ? 1 : 0);
    const headerChanges: string[] = [];
    const seen = { clef: false, key: false, time: false };
    const body: string[] = [];
    let inBars = false;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      const q = line.match(FLAG_LINE);
      if (q && line.startsWith('?')) {
        const n = q[2].toLowerCase() === 'pickup' ? 0 : Number(q[2]);
        body.push(`${q[1]}${n + shift}${q[3]}`);
        continue;
      }
      if (line.startsWith('?')) { body.push(line); continue; }
      const hm = line.match(HEADER_LINE);
      if (hm) {
        const key = hm[1].toLowerCase();
        if (inBars) { if (key === 'clef' || key === 'key' || key === 'time') body.push(line); continue; }
        if (key === 'clef') { seen.clef = true; const c = parseClef(hm[2]); if (c && c !== state!.clef) headerChanges.push(`clef: ${c}`); }
        else if (key === 'key') { seen.key = true; const c = parseKey(hm[2]); if (c !== null && c !== state!.key) headerChanges.push(`key: ${c === 0 ? '0' : c > 0 ? `${c}#` : `${-c}b`}`); }
        else if (key === 'time') { seen.time = true; const c = parseTime(hm[2]); if (c && !sameTime(c, state!.time)) headerChanges.push(`time: ${c.beats}/${c.beatType}`); }
        continue; // title, part name and tempo belong to the first strip
      }
      const bm = line.match(BAR_LINE);
      if (bm) {
        inBars = true;
        const a = bm[2].toLowerCase() === 'pickup' ? 0 : Number(bm[2]);
        const range = bm[3] && bm[4] ? `${bm[3].replace(/\s+/g, '')}${Number(bm[4]) + shift}` : '';
        body.push(`${a + shift}${range}${bm[5]}`);
        continue;
      }
      if (inBars) body.push(line);
    }
    out.push(...headerChanges, ...body);
    const e = endState(part);
    // what a strip does not print stays as it was
    state = { clef: seen.clef || part.bars.some((b) => b.clef) ? e.clef : state!.clef, key: seen.key || part.bars.some((b) => b.key !== undefined) ? e.key : state!.key, time: seen.time || part.bars.some((b) => b.time) ? e.time : state!.time };
    offset = last + shift;
  }
  return out.join('\n');
}
