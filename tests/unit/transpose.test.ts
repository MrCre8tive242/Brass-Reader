import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { toConcert, fromConcert, autoOctave, intervalFifths, spellInKey } from '@/lib/transpose';
import { parseXml, partsOf, kids, kid, kidNum, kidText, pitchToMidi, validateMusicXml, extractTitle, readMusicXmlFile } from '@/lib/musicxml';
import { concertRange } from '@/lib/instruments';
import JSZip from 'jszip';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, '../fixtures', n), 'utf8');

function midis(xml: string): (number | null)[] {
  const doc = parseXml(xml);
  const out: (number | null)[] = [];
  for (const p of partsOf(doc)) for (const m of kids(p, 'measure')) for (const n of kids(m, 'note')) {
    const pit = kid(n, 'pitch');
    out.push(pit ? pitchToMidi(pit) : null);
  }
  return out;
}
function spelled(xml: string): string[] {
  const doc = parseXml(xml);
  const out: string[] = [];
  for (const p of partsOf(doc)) for (const m of kids(p, 'measure')) for (const n of kids(m, 'note')) {
    const pit = kid(n, 'pitch');
    if (pit) {
      const a = kidNum(pit, 'alter') ?? 0;
      out.push(`${kidText(pit, 'step')}${a > 0 ? '#'.repeat(a) : 'b'.repeat(-a)}${kidText(pit, 'octave')}`);
    }
  }
  return out;
}
function keys(xml: string): number[] {
  return Array.from(parseXml(xml).getElementsByTagName('fifths')).map((e) => Number(e.textContent));
}
function clefs(xml: string): string[] {
  return Array.from(parseXml(xml).getElementsByTagName('clef')).map((c) => `${kidText(c, 'sign')}${kidText(c, 'line')}`);
}

describe('intervalFifths', () => {
  it('matches known intervals', () => {
    expect(intervalFifths({ dia: -1, chrom: -2 })).toBe(-2);
    expect(intervalFifths({ dia: 1, chrom: 2 })).toBe(2);
    expect(intervalFifths({ dia: -4, chrom: -7 })).toBe(-1);
    expect(intervalFifths({ dia: 4, chrom: 7 })).toBe(1);
    expect(intervalFifths({ dia: 7, chrom: 12 })).toBe(0);
    expect(intervalFifths({ dia: -8, chrom: -14 })).toBe(-2);
  });
});

describe('spellInKey', () => {
  it('uses key spellings', () => {
    expect(spellInKey(70, -2)).toEqual({ step: 'B', alter: -1, octave: 4 });
    expect(spellInKey(66, 1)).toEqual({ step: 'F', alter: 1, octave: 4 });
    expect(spellInKey(61, 0)).toEqual({ step: 'C', alter: 1, octave: 4 });
    expect(spellInKey(61, -3)).toEqual({ step: 'D', alter: -1, octave: 4 });
  });
});

describe('toConcert', () => {
  it('Bb trumpet scale: C4 written -> Bb3 concert, key C -> Bb', () => {
    const c = toConcert(fx('scale.musicxml'), 'trumpet');
    expect(midis(c)[0]).toBe(58);
    expect(spelled(c).slice(0, 4)).toEqual(['Bb3', 'C4', 'D4', 'Eb4']);
    expect(keys(c)).toEqual([-2]);
  });
  it('honours <transpose> in the source instead of the assumed instrument', () => {
    const src = fx('scale.musicxml').replace('<clef>', '<transpose><diatonic>-4</diatonic><chromatic>-7</chromatic></transpose><clef>');
    const c = toConcert(src, 'trumpet');
    expect(midis(c)[0]).toBe(53); // F3
    expect(c).not.toContain('<transpose>');
    expect(keys(c)).toEqual([-1]);
  });
  it('mellophone: down a fifth', () => {
    const c = toConcert(fx('scale.musicxml'), 'mellophone');
    expect(spelled(c)[0]).toBe('F3');
    expect(keys(c)).toEqual([-1]);
  });
  it('handles accidentals and key signature (G major written, trumpet)', () => {
    const c = toConcert(fx('ties-dots.musicxml'), 'trumpet');
    expect(keys(c)).toEqual([-1]); // F major
    const names = spelled(c);
    // written G4 A4 B4 B4 C5 D5 E5 C#5 D5 F5(nat)  ->  F4 G4 A4 A4 Bb4 C5 D5 Bb4(C#->Bb? no: C#5-2 = B4) ...
    expect(names.slice(0, 3)).toEqual(['F4', 'G4', 'A4']);
    expect(names).toContain('B4');   // written C#5 -> concert B natural
    expect(names).toContain('Eb5');  // written F5 natural (not F#) -> Eb
    expect(names).not.toContain('E5');
  });
  it('strips written accidentals so the renderer recomputes them', () => {
    expect(toConcert(fx('ties-dots.musicxml'), 'trumpet')).not.toContain('<accidental>');
  });
  it('handles key and time changes', () => {
    const c = toConcert(fx('key-changes.musicxml'), 'trumpet');
    expect(keys(c)).toEqual([-2, 0, -3]);
    expect(c).toContain('<beats>3</beats>');
  });
  it('is identity for concert-pitch instruments', () => {
    expect(midis(toConcert(fx('scale.musicxml'), 'trombone'))).toEqual(midis(fx('scale.musicxml')));
  });
});

describe('fromConcert', () => {
  it('trumpet -> concert -> trombone lands in bass clef with correct key and in-range octave', () => {
    const concert = toConcert(fx('scale.musicxml'), 'trumpet');
    const k = autoOctave(concert, 'trombone');
    const out = fromConcert(concert, 'trombone');
    expect(clefs(out)).toEqual(['F4']);
    expect(keys(out)).toEqual([-2]); // Bb major
    const [lo, hi] = concertRange('trombone');
    const ms = midis(out).filter((m): m is number => m !== null);
    expect(ms.every((m) => m >= lo && m <= hi)).toBe(true);
    expect(ms[0]).toBe(58 + 12 * k);
    expect(out).not.toContain('<transpose>');
  });
  it('sousaphone drops into its low range', () => {
    const concert = toConcert(fx('scale.musicxml'), 'trumpet');
    expect(autoOctave(concert, 'sousaphone')).toBe(-1); // the range now reaches F4, so one octave down is enough
    const ms = midis(fromConcert(concert, 'sousaphone')).filter((m): m is number => m !== null);
    expect(Math.max(...ms)).toBeLessThanOrEqual(65);
    expect(Math.min(...ms)).toBeGreaterThanOrEqual(28);
  });
  it('round trip trumpet -> concert -> trumpet gives identical pitches and keys', () => {
    for (const f of ['scale.musicxml', 'ties-dots.musicxml', 'key-changes.musicxml', 'two-pages.musicxml']) {
      const src = fx(f);
      const back = fromConcert(toConcert(src, 'trumpet'), 'trumpet');
      expect(midis(back)).toEqual(midis(src));
      expect(keys(back)).toEqual(keys(src));
      expect(clefs(back)).toEqual(['G2']);
      // spelling too, except accidentals that the source marks as courtesy
      expect(spelled(back)).toEqual(spelled(src));
    }
  });
  it('round trip works for mellophone as well', () => {
    const src = fx('ties-dots.musicxml');
    const back = fromConcert(toConcert(src, 'mellophone'), 'mellophone');
    expect(spelled(back)).toEqual(spelled(src));
    expect(keys(back)).toEqual(keys(src));
  });
  it('adds <transpose> for transposing instruments only', () => {
    const concert = toConcert(fx('scale.musicxml'), 'trumpet');
    const tr = fromConcert(concert, 'trumpet');
    expect(tr).toContain('<chromatic>-2</chromatic>');
    expect(fromConcert(concert, 'trombone')).not.toContain('<transpose>');
  });
  it('swaps clef when the source had no clef at all', () => {
    const src = fx('scale.musicxml').replace(/<clef>[\s\S]*?<\/clef>/, '');
    expect(clefs(fromConcert(toConcert(src, 'trumpet'), 'trombone'))).toEqual(['F4']);
  });
  it('sets the part name', () => {
    expect(fromConcert(toConcert(fx('scale.musicxml'), 'trumpet'), 'baritone')).toContain('<part-name>Baritone (bass clef)</part-name>');
  });
  it('respells extreme keys instead of producing 8+ sharps', () => {
    // written C# major (7 sharps) for trombone -> mellophone-less: shift via trumpet-> fine; use concert -> mellophone
    const src = fx('scale.musicxml').replace('<fifths>0</fifths>', '<fifths>-7</fifths>');
    const out = fromConcert(src, 'trumpet'); // concert Cb major -> written Db major? up M2 => +2 -> -5
    expect(keys(out)).toEqual([-5]);
    const src2 = fx('scale.musicxml').replace('<fifths>0</fifths>', '<fifths>6</fifths>');
    const out2 = toConcert(src2, 'trumpet'); // F# major written -> E major
    expect(keys(out2)).toEqual([4]);
    const src3 = fx('scale.musicxml').replace('<fifths>0</fifths>', '<fifths>-6</fifths>');
    const out3 = toConcert(src3, 'trumpet'); // Gb -> Fb = -8 -> wraps to +4 (E)
    expect(keys(out3)).toEqual([4]);
  });
});

describe('autoOctave', () => {
  it('keeps in-range music unshifted', () => {
    expect(autoOctave(toConcert(fx('scale.musicxml'), 'trumpet'), 'trumpet')).toBe(0);
  });
  it('lifts a very low part for trumpet', () => {
    const low = fx('scale.musicxml').replace(/<octave>4<\/octave>/g, '<octave>2</octave>');
    expect(autoOctave(low, 'trumpet')).toBeGreaterThan(0);
  });
});

describe('musicxml helpers', () => {
  it('validates and extracts title', () => {
    expect(validateMusicXml(fx('scale.musicxml'))).toMatchObject({ ok: true, noteCount: 16, measureCount: 4 });
    expect(extractTitle(fx('scale.musicxml'))).toBe('Simple Scale');
    expect(validateMusicXml('<foo/>').ok).toBe(false);
    expect(validateMusicXml('<score-partwise><part id="P1"><measure number="1"/></part></score-partwise>').ok).toBe(false);
    expect(validateMusicXml('not xml <<<').ok).toBe(false);
  });
  it('reads .mxl containers', async () => {
    const zip = new JSZip();
    zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>');
    zip.file('score.xml', fx('scale.musicxml'));
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const xml = await readMusicXmlFile(bytes, 'x.mxl');
    expect(validateMusicXml(xml).ok).toBe(true);
  });
});

import { detectSourceInstrument } from '@/lib/musicxml';
import fsx from 'node:fs';
import pathx from 'node:path';

describe('detectSourceInstrument', () => {
  const f = (n: string) => fsx.readFileSync(pathx.join(__dirname, '../fixtures', n), 'utf8');
  it('bass clef -> trombone (concert), treble -> trumpet', () => {
    expect(detectSourceInstrument(f('bass-part.musicxml')).id).toBe('trombone');
    expect(detectSourceInstrument(f('scale.musicxml')).id).toBe('trumpet');
  });
  it('a <transpose> element wins over the clef', () => {
    const xml = f('scale.musicxml');
    const tr = (c: number) => xml.replace('</attributes>', `<transpose><diatonic>0</diatonic><chromatic>${c}</chromatic></transpose></attributes>`);
    expect(detectSourceInstrument(tr(-2)).id).toBe('trumpet');
    expect(detectSourceInstrument(tr(-7)).id).toBe('mellophone');
  });
  it('survives rubbish', () => {
    expect(detectSourceInstrument('nope').id).toBe('trumpet');
  });
});

// ---- refinement: auto-octave on the staff, sharp-key wrap, friendly spelling ----
import { buildTimeline } from '@/lib/timeline';

/** Concert-pitch XML from "C4 D4 ..." style tokens in the given key. */
function concertScore(tokens: string[], fifths: number): string {
  const notes = tokens.map((t) => {
    const m = t.match(/^([A-G])(#{1,2}|b{1,2})?(\d)$/)!;
    const alter = m[2] ? (m[2][0] === '#' ? m[2].length : -m[2].length) : 0;
    return `<note><pitch><step>${m[1]}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${m[3]}</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>`;
  });
  const bars: string[] = [];
  for (let i = 0; i < notes.length; i += 4) bars.push(`<measure number="${i / 4 + 1}">${i === 0 ? `<attributes><divisions>1</divisions><key><fifths>${fifths}</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>` : ''}${notes.slice(i, i + 4).join('')}</measure>`);
  return `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>X</part-name></score-part></part-list><part id="P1">${bars.join('')}</part></score-partwise>`;
}

describe('bass-clef brass octave placement', () => {
  it('trumpet C4-C5 -> trombone sits on the staff (median near D3), not on ledger lines above', () => {
    const concert = toConcert(fx('scale.musicxml'), 'trumpet'); // Bb3..Bb4
    expect(autoOctave(concert, 'trombone')).toBe(-1);
    const out = fromConcert(concert, 'trombone');
    const sounding = buildTimeline(out).events.map((e) => e.midi).sort((a, b) => a - b);
    const median = sounding[Math.floor(sounding.length / 2)];
    expect(Math.abs(median - 50)).toBeLessThanOrEqual(3);
    const [lo, hi] = concertRange('trombone');
    for (const m of sounding) { expect(m).toBeGreaterThanOrEqual(lo); expect(m).toBeLessThanOrEqual(hi); }
  });
  it('already-low parts are not pushed up', () => {
    const low = concertScore(['D3', 'F3', 'A3', 'D3', 'E3', 'G3', 'B3', 'E3'], 0);
    expect(autoOctave(low, 'trombone')).toBe(0);
  });
  it('trumpet keeps its smallest-shift behaviour', () => {
    expect(autoOctave(toConcert(fx('scale.musicxml'), 'trumpet'), 'trumpet')).toBe(0);
  });
});

describe('key wrap and spelling', () => {
  it('concert F# major -> trumpet is Ab major with flat spelling (key and notes agree)', () => {
    const xml = concertScore(['F#4', 'G#4', 'A#4', 'B4', 'C#5', 'D#5', 'E#5', 'F#5'], 6);
    const out = fromConcert(xml, 'trumpet');
    expect(keys(out)[0]).toBe(-4);
    expect(spelled(out)).toEqual(['Ab4', 'Bb4', 'C5', 'Db5', 'Eb5', 'F5', 'G5', 'Ab5']);
  });
  it('concert C# major -> trumpet is Eb major with flat spelling', () => {
    const xml = concertScore(['C#4', 'D#4', 'E#4', 'F#4', 'G#4', 'A#4', 'B#4', 'C#5'], 7);
    const out = fromConcert(xml, 'trumpet');
    expect(keys(out)[0]).toBe(-3);
    expect(spelled(out)).toEqual(['Eb4', 'F4', 'G4', 'Ab4', 'Bb4', 'C5', 'D5', 'Eb5']);
  });
  it('pitches are unchanged by re-spelling', () => {
    const xml = concertScore(['F#4', 'G#4', 'A#4', 'B4', 'C#5', 'D#5', 'E#5', 'F#5'], 6);
    const out = fromConcert(xml, 'trumpet');
    const k = autoOctave(xml, 'trumpet');
    expect(midis(out)).toEqual(midis(xml).map((m) => (m ?? 0) + 2 + 12 * k));
  });
  it('chromatic notes outside the key avoid E#/B#: concert C major chromatic -> trumpet', () => {
    const xml = concertScore(['C4', 'C#4', 'D4', 'D#4', 'E4', 'F4', 'F#4', 'G4'], 0);
    const out = spelled(fromConcert(xml, 'trumpet'));
    expect(out.some((n) => /^[EB]#/.test(n))).toBe(false);
    expect(out).toContain('F4'); // the written E# is spelled F natural
  });
  it('keeps E#/Fb when the key signature itself contains them', () => {
    const xml = concertScore(['C#4', 'D#4', 'E#4', 'F#4'], 7);
    const out = spelled(toConcert(xml.replace('<fifths>7</fifths>', '<fifths>7</fifths>'), 'trombone'));
    expect(out).toContain('E#4');
  });
  it('a key that needs no wrapping is left as printed', () => {
    const out = fromConcert(concertScore(['F#4', 'G#4', 'A#4', 'B4'], 6), 'trombone');
    expect(keys(out)[0]).toBe(6);
    expect(spelled(out).slice(0, 2).map((n) => n.slice(0, 2))).toEqual(['F#', 'G#']);
  });
});
