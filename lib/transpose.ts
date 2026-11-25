import { INSTRUMENTS, concertRange, type InstrumentId } from './instruments';
import {
  parseXml, serializeXml, partsOf, kids, kid, kidNum, kidText, setKidText, removeKids,
  pitchToMidi, STEP_SEMI, STEPS, type XDoc, type XEl,
} from './musicxml';

/** A transposition interval: signed diatonic steps + signed semitones. */
export interface Interval { dia: number; chrom: number }

const BASE_CHROM = [0, 2, 4, 5, 7, 9, 11];
const BASE_FIFTHS = [0, 2, 4, -1, 1, 3, 5];

/** Change in key-signature fifths produced by transposing by this interval. */
export function intervalFifths(iv: Interval): number {
  const sign = iv.dia < 0 || (iv.dia === 0 && iv.chrom < 0) ? -1 : 1;
  const u = Math.abs(iv.dia);
  const c = sign * iv.chrom;
  const o = Math.floor(u / 7);
  const r = u % 7;
  const aug = c - 12 * o - BASE_CHROM[r];
  return sign * (BASE_FIFTHS[r] + 7 * aug);
}

function diaFromChrom(chrom: number): number {
  const up = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6];
  const s = chrom < 0 ? -1 : 1;
  const a = Math.abs(chrom);
  return s * (Math.floor(a / 12) * 7 + up[a % 12]);
}

function instrumentInterval(id: InstrumentId): Interval {
  const i = INSTRUMENTS[id];
  return { dia: i.diatonic, chrom: i.writtenToConcert };
}

function negate(iv: Interval): Interval { return { dia: -iv.dia, chrom: -iv.chrom }; }
function add(a: Interval, b: Interval): Interval { return { dia: a.dia + b.dia, chrom: a.chrom + b.chrom }; }

function readTransposeEl(t: XEl): Interval {
  const chrom = (kidNum(t, 'chromatic') ?? 0) + 12 * (kidNum(t, 'octave-change') ?? 0);
  const diaRaw = kidNum(t, 'diatonic');
  const oct = kidNum(t, 'octave-change') ?? 0;
  const chromOnly = kidNum(t, 'chromatic') ?? 0;
  const dia = diaRaw === null ? diaFromChrom(chromOnly) + 7 * oct : diaRaw + 7 * oct;
  return { dia, chrom };
}

const FLAT_PC: Array<[string, number]> = [
  ['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0],
];
const SHARP_PC: Array<[string, number]> = [
  ['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0],
];

/** Spell a MIDI note as step/alter/octave, preferring the notes of the key given by `fifths`. */
export function spellInKey(midi: number, fifths: number): { step: string; alter: number; octave: number } {
  const pc = ((midi % 12) + 12) % 12;
  // scale degrees of the major key with `fifths` sharps (negative = flats)
  const order = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const alters: Record<string, number> = {};
  for (let i = 0; i < 7; i++) alters[order[i]] = 0;
  if (fifths > 0) for (let i = 0; i < Math.min(fifths, 7); i++) alters[order[i]] = 1;
  if (fifths < 0) for (let i = 0; i < Math.min(-fifths, 7); i++) alters[order[6 - i]] = -1;
  let best: [string, number] | null = null;
  for (const s of STEPS) {
    if ((((STEP_SEMI[s] + alters[s]) % 12) + 12) % 12 === pc) { best = [s, alters[s]]; break; }
  }
  if (!best) best = (fifths >= 0 ? SHARP_PC : FLAT_PC)[pc];
  const [step, alter] = best;
  // octave: choose so that (octave+1)*12 + STEP_SEMI + alter == midi
  const octave = Math.round((midi - STEP_SEMI[step] - alter) / 12) - 1;
  return { step, alter, octave };
}

function wrapFifths(f: number): number {
  while (f > 7) f -= 12;
  while (f < -7) f += 12;
  return f;
}

/** Transpose one <pitch> element in place. `keyFifths` is the (already transposed) current key. */
function keyAlter(step: string, fifths: number): number {
  const order = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const i = order.indexOf(step);
  if (fifths > 0) return i < fifths ? 1 : 0;
  if (fifths < 0) return 6 - i < -fifths ? -1 : 0;
  return 0;
}

function transposePitch(doc: XDoc, pitch: XEl, iv: Interval, keyFifths: number, respellAll = false): void {
  const step = kidText(pitch, 'step');
  const oct = kidNum(pitch, 'octave');
  if (!step || !(step in STEP_SEMI) || oct === null) return;
  const midi = pitchToMidi(pitch)!;
  const newMidi = midi + iv.chrom;
  const d = oct * 7 + STEPS.indexOf(step) + iv.dia;
  const newStepIdx = ((d % 7) + 7) % 7;
  const newOct = Math.floor(d / 7);
  const newStep = STEPS[newStepIdx];
  let alter = newMidi - ((newOct + 1) * 12 + STEP_SEMI[newStep]);
  let out = { step: newStep, alter, octave: newOct };
  // re-spell when: the key signature was wrapped to its enharmonic (so notes and key agree), double accidentals,
  // or an unfriendly E#/B#/Fb/Cb that the key signature does not itself contain (-> F, C, E, B)
  const odd = (['E', 'B'].includes(newStep) && alter === 1) || (['F', 'C'].includes(newStep) && alter === -1);
  if (respellAll || Math.abs(alter) > 1 || (odd && keyAlter(newStep, keyFifths) !== alter)) out = spellInKey(newMidi, keyFifths);
  alter = out.alter;
  setKidText(doc, pitch, 'step', out.step);
  removeKids(pitch, 'alter');
  if (alter !== 0) setKidText(doc, pitch, 'alter', alter, ['octave']);
  setKidText(doc, pitch, 'octave', out.octave);
}

function transposeKey(keyEl: XEl, iv: Interval): { fifths: number; wrapped: boolean } | null {
  const f = kidNum(keyEl, 'fifths');
  if (f === null) return null;
  const raw = f + intervalFifths(iv);
  const nf = wrapFifths(raw);
  kid(keyEl, 'fifths')!.textContent = String(nf);
  return { fifths: nf, wrapped: nf !== raw };
}

interface RunOpts {
  /** Interval to apply when a part has no <transpose> element. */
  defaultInterval: Interval;
  /** Honour and strip <transpose> elements (source files marked up as transposing parts). */
  honourTranspose: boolean;
}

function transposeDoc(doc: XDoc, opts: RunOpts): void {
  for (const part of partsOf(doc)) {
    let iv = opts.defaultInterval;
    let fifths = 0;
    let wrapped = false; // key signature was rewritten to its enharmonic: spell every note in the new key
    for (const measure of kids(part, 'measure')) {
      for (const el of kids(measure)) {
        if (el.nodeName === 'attributes') {
          if (opts.honourTranspose) {
            const t = kid(el, 'transpose');
            if (t) { iv = readTransposeEl(t); el.removeChild(t); }
          }
          for (const k of kids(el, 'key')) {
            const r = transposeKey(k, iv);
            if (r) { fifths = r.fifths; wrapped = r.wrapped; }
          }
        } else if (el.nodeName === 'note') {
          const p = kid(el, 'pitch');
          if (p) {
            transposePitch(doc, p, iv, fifths, wrapped);
            removeKids(el, 'accidental'); // renderer recomputes accidentals against the new key
          }
        }
      }
    }
  }
}

/** Interpret `xml` as written for `from` and return concert-pitch MusicXML (no <transpose>). */
export function toConcert(xml: string, from: InstrumentId): string {
  const doc = parseXml(xml);
  transposeDoc(doc, { defaultInterval: instrumentInterval(from), honourTranspose: true });
  for (const part of partsOf(doc)) {
    for (const att of Array.from(part.getElementsByTagName('attributes'))) {
      const t = kid(att as XEl, 'transpose');
      if (t) att.removeChild(t);
    }
  }
  return serializeXml(doc);
}

function concertMidis(doc: XDoc): number[] {
  const out: number[] = [];
  for (const part of partsOf(doc)) {
    for (const m of kids(part, 'measure')) {
      for (const n of kids(m, 'note')) {
        const p = kid(n, 'pitch');
        if (!p) continue;
        const midi = pitchToMidi(p);
        if (midi !== null) out.push(midi);
      }
    }
  }
  return out;
}

/** Median concert pitch bass-clef brass should sit around: D3 is the middle line of the bass staff. */
const BASS_CLEF_TARGET_MEDIAN = 50;

function chooseOctave(midis: number[], to: InstrumentId): number {
  if (midis.length === 0) return 0;
  const [lo, hi] = concertRange(to);
  const sorted = [...midis].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const center = (lo + hi) / 2;
  const bassBrass = INSTRUMENTS[to].clef === 'bass' && to !== 'sousaphone';
  let best = 0;
  let bestScore: number[] | null = null;
  for (let k = -2; k <= 2; k++) {
    let count = 0;
    for (const m of midis) { const s = m + 12 * k; if (s >= lo && s <= hi) count++; }
    const shifted = median + 12 * k;
    // 1. maximise notes in range
    // 2. bass-clef brass: keep the median near D3 so the part stays on the staff, not on ledger lines
    //    (others: smallest shift first), then closeness to the centre of the range
    const score = bassBrass
      ? [-count, Math.abs(shifted - BASS_CLEF_TARGET_MEDIAN), Math.abs(k)]
      : [-count, Math.abs(k), Math.abs(shifted - center)];
    let better = !bestScore;
    if (bestScore) for (let i = 0; i < score.length; i++) { if (score[i] !== bestScore[i]) { better = score[i] < bestScore[i]; break; } }
    if (better) { bestScore = score; best = k; }
  }
  return best;
}

/** Octave shift (-2..2) that fits the concert-pitch score into the instrument's comfortable range. */
export function autoOctave(concertXml: string, to: InstrumentId): number {
  return chooseOctave(concertMidis(parseXml(concertXml)), to);
}

function setClefs(doc: XDoc, part: XEl, kind: 'treble' | 'bass'): void {
  const sign = kind === 'bass' ? 'F' : 'G';
  const line = kind === 'bass' ? 4 : 2;
  const measures = kids(part, 'measure');
  let found = false;
  for (const att of Array.from(part.getElementsByTagName('attributes')) as XEl[]) {
    for (const clef of kids(att, 'clef')) {
      found = true;
      setKidText(doc, clef, 'sign', sign, ['line']);
      setKidText(doc, clef, 'line', line);
      removeKids(clef, 'clef-octave-change');
    }
  }
  if (!found && measures.length) {
    let att = kid(measures[0], 'attributes');
    if (!att) {
      att = doc.createElement('attributes');
      measures[0].insertBefore(att, measures[0].firstChild);
    }
    const clef = doc.createElement('clef');
    const s = doc.createElement('sign'); s.textContent = sign; clef.appendChild(s);
    const l = doc.createElement('line'); l.textContent = String(line); clef.appendChild(l);
    let ref: XEl | null = null;
    for (const b of ['staff-details', 'transpose', 'directive', 'measure-style']) { ref = kid(att, b); if (ref) break; }
    if (ref) att.insertBefore(clef, ref); else att.appendChild(clef);
  }
}

function setPartTranspose(doc: XDoc, part: XEl, iv: Interval): void {
  const measures = kids(part, 'measure');
  if (!measures.length) return;
  const att = kid(measures[0], 'attributes');
  if (!att) return;
  for (const a of Array.from(part.getElementsByTagName('attributes')) as XEl[]) removeKids(a, 'transpose');
  if (iv.chrom === 0 && iv.dia === 0) return;
  const t = doc.createElement('transpose');
  const d = doc.createElement('diatonic'); d.textContent = String(iv.dia);
  const c = doc.createElement('chromatic'); c.textContent = String(iv.chrom);
  t.appendChild(d); t.appendChild(c);
  let ref: XEl | null = null;
  for (const b of ['directive', 'measure-style']) { ref = kid(att, b); if (ref) break; }
  if (ref) att.insertBefore(t, ref); else att.appendChild(t);
}

/**
 * Convert concert-pitch MusicXML into the written part for `to`: transposed, octave-adjusted,
 * clef swapped, and tagged with a <transpose> element so the sounding pitch is recoverable.
 */
export function fromConcert(concertXml: string, to: InstrumentId): string {
  const doc = parseXml(concertXml);
  const k = chooseOctave(concertMidis(doc), to);
  const inst = INSTRUMENTS[to];
  // sounding = concert + 12k ; written = sounding - instrument offset
  const iv: Interval = add(negate(instrumentInterval(to)), { dia: 7 * k, chrom: 12 * k });
  transposeDoc(doc, { defaultInterval: iv, honourTranspose: false });
  // transposeDoc applies intervalFifths(iv) to key; octave shifts contribute 0 so this is exactly -instrument fifths.
  for (const part of partsOf(doc)) {
    setClefs(doc, part, inst.clef);
    setPartTranspose(doc, part, instrumentInterval(to));
  }
  for (const sp of Array.from(doc.getElementsByTagName('score-part')) as XEl[]) {
    setKidText(doc, sp, 'part-name', inst.name, ['part-name-display', 'part-abbreviation', 'score-instrument']);
  }
  return serializeXml(doc);
}
