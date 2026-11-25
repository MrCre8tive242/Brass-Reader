import { describe, it, expect } from 'vitest';
import { fingeringFor, fingeringText } from '@/lib/fingering';
import { INSTRUMENTS, type InstrumentId } from '@/lib/instruments';
import { applyShifts, describeRange, outOfRange, shiftOctaves, writtenMidi } from '@/lib/range';
import { buildTimeline } from '@/lib/timeline';
import { notationToMusicXml, parseNotation } from '@/lib/omrNotation';

/** Fingering of a WRITTEN pitch on a transposing instrument (the lookup takes sounding pitch). */
const written = (inst: InstrumentId, w: number) => fingeringFor(inst, w + INSTRUMENTS[inst].writtenToConcert);

describe('trumpet valve chart (written pitch)', () => {
  const chart: [number, string][] = [
    [54, '1-2-3'], [55, '1-3'], [56, '2-3'], [57, '1-2'], [58, '1'], [59, '2'], [60, '0'], [61, '1-2-3'], [62, '1-3'], [63, '2-3'],
    [64, '1-2'], [65, '1'], [66, '2'], [67, '0'], [68, '2-3'], [69, '1-2'], [70, '1'], [71, '2'], [72, '0'], [73, '1-2'],
    [74, '1'], [75, '2'], [76, '0'], [77, '1'], [78, '2'], [79, '0'], [80, '2-3'], [81, '1-2'], [82, '1'], [83, '2'], [84, '0'],
  ];
  it.each(chart)('written %i is %s', (w, f) => { expect(written('trumpet', w)?.primary).toBe(f); });
  it('the third valve is offered as the alternate for 1-2', () => {
    expect(written('trumpet', 64)?.alternates).toContain('3');
    expect(written('trumpet', 69)?.alternates[0]).toBe('3');
    expect(written('trumpet', 60)?.alternates ?? []).not.toContain('3');
  });
  it('is looked up by WRITTEN pitch: a concert Bb3 is a written C4, open', () => {
    expect(fingeringFor('trumpet', 58)).toMatchObject({ primary: '0', kind: 'valves' });
    expect(fingeringFor('trumpet', 60)?.primary).toBe('1-3'); // concert C4 is written D4
  });
  it('mellophone uses the same chart on its written pitch', () => {
    expect(written('mellophone', 60)?.primary).toBe('0');
    expect(written('mellophone', 62)?.primary).toBe('1-3');
    expect(fingeringFor('mellophone', 60 - 7)?.primary).toBe('0'); // sounds a fifth below the written C
  });
  it('shows a dash outside the chart', () => {
    expect(written('trumpet', 53)).toBeNull();
    expect(written('trumpet', 85)).toBeNull();
    expect(fingeringText(null)).toBe('—');
  });
});

describe('bass clef instruments are looked up by concert pitch', () => {
  it('trombone slide positions 1-7', () => {
    const pos: [number, string][] = [[58, '1'], [57, '2'], [56, '3'], [55, '4'], [54, '5'], [53, '1'], [52, '2'], [47, '7'], [46, '1'], [40, '7'], [70, '1'], [69, '2'], [68, '3'], [62, '1'], [64, '2']];
    for (const [m, p] of pos) expect(fingeringFor('trombone', m), `midi ${m}`).toMatchObject({ kind: 'slide', primary: p });
    expect(fingeringFor('trombone', 62)?.alternates).toContain('4'); // D4 in 4th
  });
  it('trombone positions are always 1 to 7 across the whole range', () => {
    for (let m = 40; m <= 70; m++) {
      const f = fingeringFor('trombone', m)!;
      expect(f, `midi ${m}`).not.toBeNull();
      for (const p of [f.primary, ...f.alternates]) expect(Number(p)).toBeGreaterThanOrEqual(1), expect(Number(p)).toBeLessThanOrEqual(7);
    }
  });
  it('baritone: 3 valves, Bb open', () => {
    expect(fingeringFor('baritone', 58)).toMatchObject({ kind: 'valves', primary: '0' });
    expect(fingeringFor('baritone', 57)?.primary).toBe('2');
    expect(fingeringFor('baritone', 40)?.primary).toBe('1-2-3');
    expect(fingeringFor('baritone', 39)).toBeNull();
    expect(fingeringFor('baritone', 71)).toBeNull();
  });
  it('sousaphone BBb: low E to F3', () => {
    expect(fingeringFor('sousaphone', 34)?.primary).toBe('0'); // Bb1
    expect(fingeringFor('sousaphone', 28)?.primary).toBe('1-2-3'); // E1
    expect(fingeringFor('sousaphone', 46)?.primary).toBe('0'); // Bb2
    expect(fingeringFor('sousaphone', 53)?.primary).toBe('0'); // F3
    expect(fingeringFor('sousaphone', 27)).toBeNull();
    expect(fingeringFor('sousaphone', 54)).toBeNull();
  });
  it('every note of every chart has a fingering and none is invented', () => {
    for (const id of ['trumpet', 'mellophone', 'baritone', 'trombone', 'sousaphone'] as InstrumentId[]) {
      const [lo, hi] = INSTRUMENTS[id].writtenRange;
      for (let w = lo; w <= hi; w++) expect(written(id, w), `${id} ${w}`).not.toBeNull();
      expect(written(id, lo - 1)).toBeNull();
    }
  });
});

describe('range warnings', () => {
  const xml = notationToMusicXml(parseNotation('time: 4/4\n1: C5:q E5:q G5:q C6:q\n2: E6:q G6:q C7:q C4:q\n3: C3:w')).xml;
  const tl = buildTimeline(xml);
  it('flags written notes above or below the instrument range', () => {
    const issues = outOfRange(tl.events, 'trumpet'); // written range F#3..C6 (54..84); the score is read as written pitch with no transpose
    // events are SOUNDING pitch: notes above C6 sounding are written 2 above
    expect(issues.map((i) => i.dir)).toContain('high');
    expect(issues.map((i) => i.dir)).toContain('low');
    expect(writtenMidi('trumpet', 70)).toBe(72);
  });
  it('the same note can be fine on one instrument and out of range on another', () => {
    const ev = [{ midi: 36, measure: 1 }];
    expect(outOfRange(ev, 'trumpet')).toHaveLength(1);
    expect(outOfRange(ev, 'trombone')).toHaveLength(1);
    expect(outOfRange([{ midi: 45, measure: 1 }], 'trombone')).toHaveLength(0);
    expect(outOfRange(ev, 'sousaphone')).toHaveLength(0);
    expect(outOfRange([{ midi: 60, measure: 1 }], 'sousaphone')[0].dir).toBe('high');
  });
  it('describes what is wrong in words', () => {
    expect(describeRange([])).toBe('');
    expect(describeRange([{ index: 0, measure: 5, dir: 'high', written: 90 }, { index: 1, measure: 6, dir: 'high', written: 91 }])).toBe('2 notes out of range: 2 too high (bars 5, 6)');
  });
  it('drops a passage an octave without touching the rest', () => {
    const down = shiftOctaves(xml, 2, 2, -1);
    const a = buildTimeline(xml).events, b = buildTimeline(down).events;
    expect(b).toHaveLength(a.length);
    a.forEach((e, i) => expect(b[i].midi).toBe(e.measure === 2 ? e.midi - 12 : e.midi));
    expect(shiftOctaves(xml, 1, 3, 0)).toBe(xml);
    const up = shiftOctaves(xml, 3, 3, 1);
    expect(buildTimeline(up).events.at(-1)!.midi).toBe(buildTimeline(xml).events.at(-1)!.midi + 12);
  });
  it('saved shifts apply only for the instrument they were made for', () => {
    const shifts = [{ from: 2, to: 2, octaves: -1, target: 'trumpet' as const }];
    expect(applyShifts(xml, shifts, 'trombone')).toBe(xml);
    expect(applyShifts(xml, shifts, 'trumpet')).not.toBe(xml);
    expect(applyShifts(xml, undefined, 'trumpet')).toBe(xml);
  });
});
