import { describe, it, expect } from 'vitest';
import { parseNotation, notationToMusicXml, mergeCorrections, parseKey, parseTime, parseClef, notatedBarQ, DIV } from '@/lib/omrNotation';
import { validateMusicXml, parseXml, partsOf, kids, kid, kidText, kidNum, pitchToMidi } from '@/lib/musicxml';
import { analyseAndRepair } from '@/lib/repair';
import { buildTimeline } from '@/lib/timeline';

const SAINTS = `Here is the reading.
\`\`\`
title: When the Saints
part: Trumpet 1
clef: treble
key: 2b
time: 4/4
tempo: 112
# page 1 system 1
0: r:q C4:q E4:q F4:q
1: |: G4:w~
2: G4:q Bn4:e. A4:s r:h
3: B4:q E5:q E5:h [1 :|
4: [2 R
5-8: R
9: time=3/4 C5:e/3 D5:e/3 E5:e/3 F#4:q F4:q
? 2: second note may be B4 or Bb4 (smudged)
\`\`\`
`;

function pitches(xml: string): (number | null)[][] {
  const doc = parseXml(xml);
  return kids(partsOf(doc)[0], 'measure').map((m) => kids(m, 'note').filter((n) => kid(n, 'pitch')).map((n) => pitchToMidi(kid(n, 'pitch')!)));
}

describe('header parsing', () => {
  it('key signatures in several spellings', () => {
    expect(parseKey('2b')).toBe(-2);
    expect(parseKey('3#')).toBe(3);
    expect(parseKey('-4')).toBe(-4);
    expect(parseKey('2 flats')).toBe(-2);
    expect(parseKey('1 sharp')).toBe(1);
    expect(parseKey('none')).toBe(0);
    expect(parseKey('0')).toBe(0);
    expect(parseKey('Bb major')).toBe(-2);
    expect(parseKey('E minor')).toBe(1);
    expect(parseKey('bbb')).toBe(-3);
    expect(parseKey('nine')).toBeNull();
  });
  it('time signatures and clefs', () => {
    expect(parseTime('6/8')).toEqual({ beats: 6, beatType: 8 });
    expect(parseTime('C')).toMatchObject({ beats: 4, beatType: 4, symbol: 'common' });
    expect(parseTime('cut')).toMatchObject({ beats: 2, beatType: 2, symbol: 'cut' });
    expect(parseTime('4/5')).toBeNull();
    expect(parseClef('Bass clef')).toBe('bass');
    expect(parseClef('treble')).toBe('treble');
    expect(parseClef('treble 8vb')).toBe('treble8vb');
    expect(parseClef('drum')).toBeNull();
  });
});

describe('parseNotation', () => {
  const s = parseNotation(SAINTS);
  it('reads headers, ignores chatter, fences and comments', () => {
    expect(s.title).toBe('When the Saints');
    expect(s.tempo).toBe(112);
    expect(s.parts).toHaveLength(1);
    expect(s.parts[0]).toMatchObject({ name: 'Trumpet 1', clef: 'treble', key: -2, time: { beats: 4, beatType: 4 } });
    expect(s.problems).toEqual(['could not read the line "Here is the reading."']);
  });
  it('one bar per line, a multi-bar rest expands to one bar each', () => {
    expect(s.parts[0].bars.map((b) => b.label)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(s.parts[0].bars[5]).toMatchObject({ fullRest: true });
    expect(s.parts[0].bars[8]).toMatchObject({ fullRest: true });
  });
  it('repeats, endings, in-bar changes and uncertain notes', () => {
    const b = s.parts[0].bars;
    expect(b[1].repeatStart).toBe(true);
    expect(b[3]).toMatchObject({ repeatEnd: true, endingStart: [1] });
    expect(b[4].endingStart).toEqual([2]);
    expect(b[9].time).toEqual({ beats: 3, beatType: 4 });
    expect(s.notes).toEqual([{ bar: '2', part: 0, text: 'second note may be B4 or Bb4 (smudged)' }]);
  });
  it('bar lengths', () => {
    const p = s.parts[0];
    expect(notatedBarQ(p.bars[0], p.time)).toBe(4);
    expect(notatedBarQ(p.bars[2], p.time)).toBeCloseTo(4);
    expect(notatedBarQ(p.bars[9], { beats: 3, beatType: 4 })).toBeCloseTo(3);
  });
  it('collects tokens it cannot read instead of throwing', () => {
    const x = parseNotation('1: C4:q wat D4:q E4:zz\nnonsense line\n2: R');
    expect(x.parts[0].bars[0].problems).toEqual(['could not read "wat"', 'could not read "E4:zz"']);
    expect(x.parts[0].bars[0].items).toHaveLength(2);
    expect(x.problems).toHaveLength(1);
    expect(parseNotation('').parts).toEqual([]);
    expect(parseNotation('<html>no</html>').parts).toEqual([]);
  });
  it('tolerates numeric durations, a loose tie and stuck bar lines', () => {
    const x = parseNotation('1: C4:4 D4/8 E4:8 ~ E4:2|');
    const it = x.parts[0].bars[0].items;
    expect(it.map((i) => i.type)).toEqual(['quarter', 'eighth', 'eighth', 'half']);
    expect(it[2].tie).toBe(true);
    expect(x.parts[0].bars[0].problems).toEqual([]);
  });
  it('several parts and header changes between bars', () => {
    const x = parseNotation('part: Tpt\nclef: treble\nkey: 1#\n1: G4:w\nkey: 1b\n2: F4:w\npart: Tbn\nclef: bass\n1: G2:w\n2: F2:w');
    expect(x.parts.map((p) => [p.name, p.clef, p.key, p.bars.length])).toEqual([['Tpt', 'treble', 1, 2], ['Tbn', 'bass', 0, 2]]);
    expect(x.parts[0].bars[1].key).toBe(-1);
  });
  it('a `:|:` ends one repeat and starts the next', () => {
    const x = parseNotation('1: |: C4:w\n2: C4:w :|:\n3: D4:w\n4: D4:w :|x3');
    const b = x.parts[0].bars;
    expect([b[0].repeatStart, b[1].repeatEnd, b[2].repeatStart, b[3].repeatEnd, b[3].times]).toEqual([true, true, true, true, 3]);
  });
});

describe('notationToMusicXml', () => {
  const s = parseNotation(SAINTS);
  const { xml, warnings } = notationToMusicXml(s);
  it('is valid MusicXML and every bar adds up', () => {
    expect(validateMusicXml(xml)).toMatchObject({ ok: true, measureCount: 10 });
    expect(analyseAndRepair(xml).issues).toEqual([]);
    expect(warnings).toEqual([]);
  });
  it('applies the key signature, printed accidentals within the bar, and naturals', () => {
    const p = pitches(xml);
    expect(p[0]).toEqual([60, 64 - 1, 65]); // E is flat in 2 flats
    expect(p[2]).toEqual([67, 71, 69]); // Bn4 is B natural
    expect(p[3]).toEqual([70, 75, 75]); // B and E flat again in the next bar
    expect(p[9]).toEqual([72, 74, 75, 66, 66]); // F#4 then F4 with no sign: the sharp carries to the end of the bar
  });
  it('accidentals carry to the end of the bar only (same line or space)', () => {
    const x = notationToMusicXml(parseNotation('key: 0\ntime: 4/4\n1: F#4:q F4:q F5:q Fn4:q\n2: F4:w')).xml;
    expect(pitches(x)).toEqual([[66, 66, 77, 65], [65]]);
  });
  it('writes <accidental> only where a sign was printed', () => {
    expect(xml.match(/<accidental>/g)).toHaveLength(2);
    expect(xml).toContain('<accidental>natural</accidental>');
  });
  it('pickup bar, printed numbers, tempo, title and attributes', () => {
    expect(xml).toContain('<measure number="0" implicit="yes">');
    expect(xml).toContain('<work-title>When the Saints</work-title>');
    expect(xml).toContain(`<divisions>${DIV}</divisions><key><fifths>-2</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef>`);
    expect(xml).toContain('<sound tempo="112"/>');
    const tl = buildTimeline(xml);
    expect(tl.barLabels[0]).toBe('Pickup');
    expect(tl.barTotal).toBe(9);
  });
  it('ties join the same pitch and play as one note; repeats and endings unroll', () => {
    const tl = buildTimeline(xml);
    expect(tl.order).toEqual([1, 2, 3, 4, 2, 3, 5, 6, 7, 8, 9, 10]);
    const g = tl.events.find((e) => e.measure === 2)!;
    expect(g.durQ).toBeCloseTo(5); // whole tied to a quarter
  });
  it('a "tie" to a different pitch was a slur and is dropped', () => {
    const x = notationToMusicXml(parseNotation('1: C4:h~ D4:h')).xml;
    expect(x).not.toContain('<tie');
  });
  it('a note tied over the barline keeps its accidental', () => {
    const x = notationToMusicXml(parseNotation('key: 0\n1: r:h. F#4:q~\n2: F4:q F4:q r:h')).xml;
    expect(pitches(x)).toEqual([[66], [66, 65]]);
    expect(buildTimeline(x).events.map((e) => [e.midi, e.durQ])).toEqual([[66, 2], [65, 1]]);
  });
  it('triplets, dots, chords, grace notes and bass clef', () => {
    const x = notationToMusicXml(parseNotation('clef: bass\nkey: 3b\ntime: 6/8\n1: E3:g E3+G3+B3:q. D3:e/2 D3:e/2')).xml;
    expect(validateMusicXml(x).ok).toBe(true);
    expect(analyseAndRepair(x).issues).toEqual([]);
    expect(x).toContain('<clef><sign>F</sign><line>4</line></clef>');
    expect(x).toContain('<grace/>');
    expect((x.match(/<chord\/>/g) ?? []).length).toBe(2);
    expect(x).toContain('<tuplet type="start"/>');
    expect(x).toContain('<tuplet type="stop"/>');
    const tl = buildTimeline(x);
    expect(tl.events.filter((e) => e.timeQ === 0).map((e) => e.midi).sort()).toEqual([51, 55, 58]); // Eb G Bb
  });
  it('cut time, common time and treble 8vb', () => {
    const x = notationToMusicXml(parseNotation('clef: treble8vb\ntime: cut\n1: C4:h C4:h\n2: time=C C4:w')).xml;
    expect(x).toContain('<time symbol="cut"><beats>2</beats><beat-type>2</beat-type></time>');
    expect(x).toContain('<clef-octave-change>-1</clef-octave-change>');
    expect(x).toContain('<time symbol="common">');
  });
  it('D.S. al Coda with segno, to-coda and coda marks follows the jumps', () => {
    const x = notationToMusicXml(parseNotation('1: C4:w\n2: segno D4:w\n3: E4:w tocoda\n4: F4:w ds.coda\n5: coda G4:w')).xml;
    expect(buildTimeline(x).order).toEqual([1, 2, 3, 4, 2, 3, 5]);
    const y = notationToMusicXml(parseNotation('1: C4:w\n2: D4:w fine\n3: E4:w D.C.al.Fine')).xml;
    expect(buildTimeline(y).order).toEqual([1, 2, 3, 1, 2]);
  });
  it('a second ending with an explicit end, and one without', () => {
    const a = notationToMusicXml(parseNotation('1: |: C4:w\n2: [1 D4:w :|\n3: [2 E4:w\n4: F4:w ]\n5: |: G4:w\n6: A4:w :|')).xml;
    expect(buildTimeline(a).order).toEqual([1, 2, 1, 3, 4, 5, 6, 5, 6]);
    const b = notationToMusicXml(parseNotation('1: |: C4:w\n2: [1 D4:w :|\n3: [2 E4:w\n4: |: G4:w\n5: A4:w :|')).xml;
    expect(buildTimeline(b).order).toEqual([1, 2, 1, 3, 4, 5, 4, 5]);
  });
  it('several parts: one <part> each, the shorter one is padded and reported', () => {
    const r = notationToMusicXml(parseNotation('part: Tpt\n1: C5:w\n2: D5:w\npart: Tbn\nclef: bass\n1: C3:w'));
    const doc = parseXml(r.xml);
    expect(partsOf(doc)).toHaveLength(2);
    expect(kids(partsOf(doc)[1], 'measure')).toHaveLength(2);
    expect(r.warnings.join(' ')).toMatch(/Tbn has 1 bars/);
    expect(kidText(kids(kid(doc.documentElement, 'part-list')!, 'score-part')[1], 'part-name')).toBe('Tbn');
  });
  it('reports missing and out-of-order bar numbers', () => {
    expect(notationToMusicXml(parseNotation('1: C4:w\n2: C4:w\n4: C4:w')).warnings.join(' ')).toMatch(/Bar 3 may be missing/);
    const r = notationToMusicXml(parseNotation('1: C4:w\n2: C4:w\n1: C4:w'));
    expect(r.warnings.join(' ')).toMatch(/renumbered/);
    expect(buildTimeline(r.xml).barLabels).toEqual(['1', '2', '3']);
  });
  it('escapes text that goes into the XML', () => {
    const r = notationToMusicXml(parseNotation('title: Rock & Roll "live"\npart: A&B\n1: C4:w'));
    expect(validateMusicXml(r.xml).ok).toBe(true);
    expect(r.xml).toContain('Rock &amp; Roll');
  });
  it('durations are integers for every supported value', () => {
    const x = notationToMusicXml(parseNotation('time: 4/4\n1: C4:t. C4:s/5 C4:e/7 C4:q/6 C4:h..')).xml;
    const doc = parseXml(x);
    for (const n of kids(kids(partsOf(doc)[0], 'measure')[0], 'note')) expect(Number.isInteger(kidNum(n, 'duration'))).toBe(true);
  });
});

describe('mergeCorrections', () => {
  it('replaces only the bars that were sent back', () => {
    const base = parseNotation('time: 4/4\n1: E4:w\n2: C4:q D4:q\n3: F4:h');
    expect(analyseAndRepair(notationToMusicXml(base).xml).issues.map((i) => i.label)).toEqual(['2']);
    const n = mergeCorrections(base, 'Sure:\n2: C4:q D4:q E4:h\n9: C4:w');
    expect(n).toBe(1);
    expect(base.parts[0].bars[1].items).toHaveLength(3);
    expect(base.parts[0].bars).toHaveLength(3);
    expect(analyseAndRepair(notationToMusicXml(base).xml).issues).toEqual([]);
  });
  it('a corrected time signature replaces the header', () => {
    const base = parseNotation('time: 4/4\n1: C4:h.\n2: D4:h.\n3: E4:h.');
    expect(analyseAndRepair(notationToMusicXml(base).xml).issues).toHaveLength(1); // first and last bar may be short
    mergeCorrections(base, 'time: 3/4');
    expect(base.parts[0].time).toEqual({ beats: 3, beatType: 4 });
    expect(analyseAndRepair(notationToMusicXml(base).xml).issues).toEqual([]);
  });
  it('matches parts by name', () => {
    const base = parseNotation('part: Tpt\n1: C5:h\npart: Tbn\nclef: bass\n1: C3:h\n2: C3:w');
    mergeCorrections(base, 'part: Tbn\n1: C3:w');
    expect(base.parts[1].bars[0].items[0].type).toBe('whole');
    expect(base.parts[0].bars[0].items[0].type).toBe('half');
  });
});

import { summariseScore, extractPart } from '@/lib/musicxml';
import fs from 'node:fs';
import path from 'node:path';

describe('score summary and part picking', () => {
  const two = notationToMusicXml(parseNotation('title: Duet\ntempo: 96\npart: Trumpet 1\nclef: treble\nkey: 2b\ntime: 3/4\n1: C5:h.\n2: D5:h.\npart: Trombone\nclef: bass\nkey: 0\n1: C3:h.\n2: R')).xml;
  it('summarises title, tempo and every part', () => {
    expect(summariseScore(two)).toEqual({
      title: 'Duet', tempo: 96,
      parts: [
        { index: 0, name: 'Trumpet 1', clef: 'treble', key: '2 flats', fifths: -2, time: '3/4', bars: 2, notes: 2 },
        { index: 1, name: 'Trombone', clef: 'bass', key: 'no sharps or flats', fifths: 0, time: '3/4', bars: 2, notes: 1 },
      ],
    });
  });
  it('keeps one part, valid and playable, and leaves single-part scores alone', () => {
    const tbn = extractPart(two, 1);
    expect(summariseScore(tbn).parts.map((p) => p.name)).toEqual(['Trombone']);
    expect(validateMusicXml(tbn).ok).toBe(true);
    expect(buildTimeline(tbn).events.map((e) => e.midi)).toEqual([48]);
    expect(buildTimeline(extractPart(two, 0)).events.map((e) => e.midi)).toEqual([72, 74]);
    const one = extractPart(tbn, 0);
    expect(one).toBe(tbn);
    expect(extractPart(two, 9)).toBe(two);
  });
  it('works on a hand-made two-part file and never throws on junk', () => {
    const f = fs.readFileSync(path.join(__dirname, '../fixtures/qa-twoparts.musicxml'), 'utf8');
    const s = summariseScore(f);
    expect(s.parts).toHaveLength(2);
    expect(buildTimeline(extractPart(f, 1)).events.length).toBeLessThan(buildTimeline(f).events.length);
    expect(summariseScore('<nope').parts).toEqual([]);
    expect(extractPart('<nope', 0)).toBe('<nope');
  });
});

describe('several parts share the time signature', () => {
  it('a later part inherits the time, and a change written in the first part applies to all', () => {
    const x = notationToMusicXml(parseNotation('part: A\ntime: 3/4\n1: C5:h.\n2: time=2/4 C5:h\npart: B\nclef: bass\n1: C3:h.\n2: C3:h')).xml;
    expect(analyseAndRepair(x).issues).toEqual([]);
    expect(summariseScore(x).parts.map((p) => p.time)).toEqual(['3/4', '3/4']);
  });
});

import JSZip from 'jszip';
import { readMusicXmlFile, unzipMxl, MAX_XML_BYTES } from '@/lib/musicxml';

describe('opening files safely', () => {
  it('refuses an .mxl whose score unpacks to something enormous (zip bomb)', async () => {
    const zip = new JSZip();
    zip.file('score.xml', new Uint8Array(MAX_XML_BYTES + 1000)); // zeros: a few kB zipped
    const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    expect(data.length).toBeLessThan(200_000);
    await expect(unzipMxl(data)).rejects.toThrow(/too large/);
  });
  it('refuses a plain file that is far too large, and still opens a normal .mxl', async () => {
    await expect(readMusicXmlFile(new Uint8Array(MAX_XML_BYTES + 1), 'big.musicxml')).rejects.toThrow(/too large/);
    const zip = new JSZip();
    zip.file('s.musicxml', notationToMusicXml(parseNotation('1: C4:w')).xml);
    const xml = await readMusicXmlFile(await zip.generateAsync({ type: 'uint8array' }), 'ok.mxl');
    expect(validateMusicXml(xml).ok).toBe(true);
  });
});

import { rekeyXml, canRekey } from '@/lib/omrNotation';

describe('correcting a miscounted key signature', () => {
  const body = '\ntime: 4/4\n0: F4:q\n1: B4:q En5:q F#4:q F4:q\n2: B4:h~ B4:q E5:q\n3: r:h. Bb4:q~\n4: B4:q B4:q A4:g E5+B4:h\n5: key=0 B4:w';
  const conv = (key: string) => notationToMusicXml(parseNotation(`key: ${key}${body}`)).xml;
  it('re-derives every pitch exactly as if the reader had written the right key', () => {
    for (const [from, to, fifths] of [['2b', '3b', -3], ['3b', '1#', 1], ['0', '2b', -2], ['2#', '0', 0]] as const) {
      const fixed = rekeyXml(conv(from), fifths);
      expect(pitches(fixed), `${from} -> ${to}`).toEqual(pitches(conv(to)));
      expect(summariseScore(fixed).parts[0].key).toBe(summariseScore(conv(to)).parts[0].key);
      expect(validateMusicXml(fixed).ok).toBe(true);
    }
  });
  it('printed accidentals, in-bar carry, ties over the barline and a later key change are respected', () => {
    const p = pitches(rekeyXml(conv('0'), -2));
    expect(p[0]).toEqual([65]);
    expect(p[1]).toEqual([70, 76, 66, 66]); // Bb from the key, E natural printed, F# printed and carried
    expect(p[2]).toEqual([70, 70, 75]);
    expect(p[3]).toEqual([70]); // printed flat
    expect(p[4]).toEqual([70, 70, 69, 75, 70]); // tied-in Bb, then the key's Bb; grace A; chord Eb + Bb
    expect(p[5]).toEqual([71]); // after "key=0" nothing is touched
  });
  it('only touches readings made by this app, and can be limited to one part', () => {
    const foreign = fs.readFileSync(path.join(__dirname, '../fixtures/scale.musicxml'), 'utf8');
    expect(canRekey(foreign)).toBe(false);
    expect(rekeyXml(foreign, -3)).toBe(foreign);
    expect(rekeyXml(conv('0'), 9)).toBe(conv('0'));
    const two = notationToMusicXml(parseNotation('part: A\nkey: 0\n1: B4:w\npart: B\nclef: bass\nkey: 0\n1: B2:w')).xml;
    const doc = parseXml(rekeyXml(two, -1, 1));
    const firsts = partsOf(doc).map((pt) => pitchToMidi(kid(kids(kids(pt, 'measure')[0], 'note')[0], 'pitch')!));
    expect(firsts).toEqual([71, 46]);
  });
});
