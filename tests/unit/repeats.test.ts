import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Midi } from '@tonejs/midi';
import { buildTimeline, unrollMeasures, firstQ, measureAt, slotAt, type MeasureFlow } from '@/lib/timeline';
import { toMidi } from '@/lib/midi';
import { buildClicks, barLengthQ } from '@/lib/player';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, '../fixtures', n), 'utf8');

/** n quarter-note bars in 4/4; `extra[i]` is raw XML put into measure i+1 before the note. */
function score(n: number, extra: Record<number, string> = {}, tail: Record<number, string> = {}, numbers?: string[]): string {
  let m = '';
  for (let i = 1; i <= n; i++) {
    const att = i === 1 ? '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' : '';
    m += `<measure number="${numbers ? numbers[i - 1] : i}">${att}${extra[i] ?? ''}<note><pitch><step>C</step><octave>${3 + i}</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>${tail[i] ?? ''}</measure>`;
  }
  return `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>X</part-name></score-part></part-list><part id="P1">${m}</part></score-partwise>`;
}
const fwd = '<barline location="left"><repeat direction="forward"/></barline>';
const back = '<barline location="right"><repeat direction="backward"/></barline>';
const snd = (a: string) => `<direction><sound ${a}/></direction>`;

describe('unrollMeasures', () => {
  it('plain repeat', () => {
    const f: MeasureFlow[] = [{ forward: true }, {}, { backward: true }, {}];
    expect(unrollMeasures(f)).toEqual([0, 1, 2, 0, 1, 2, 3]);
  });
  it('backward repeat without forward goes to the start; times=3', () => {
    expect(unrollMeasures([{}, { backward: true, times: 3 }, {}])).toEqual([0, 1, 0, 1, 0, 1, 2]);
  });
  it('voltas', () => {
    const f: MeasureFlow[] = [{ forward: true }, {}, { endings: [1], backward: true }, { endings: [2] }, {}];
    expect(unrollMeasures(f)).toEqual([0, 1, 2, 0, 1, 3, 4]);
  });
  it('two sequential repeat sections', () => {
    const f: MeasureFlow[] = [{ forward: true }, { backward: true }, { forward: true }, { backward: true }];
    expect(unrollMeasures(f)).toEqual([0, 1, 0, 1, 2, 3, 2, 3]);
  });
  it('a second backward repeat repeats only the bars after the first', () => {
    expect(unrollMeasures([{}, { backward: true }, { backward: true }, {}])).toEqual([0, 1, 0, 1, 2, 2, 3]);
  });
  it('D.C. al Fine', () => {
    const f: MeasureFlow[] = [{}, { fine: true }, {}, { dacapo: true }];
    expect(unrollMeasures(f)).toEqual([0, 1, 2, 3, 0, 1]);
  });
  it('D.S. al Coda', () => {
    const f: MeasureFlow[] = [{}, { segno: 's' }, { tocoda: 'c' }, { dalsegno: 's' }, { coda: 'c' }];
    expect(unrollMeasures(f)).toEqual([0, 1, 2, 3, 1, 2, 4]);
  });
  it('D.C. ignores repeats on the second pass and takes the last ending', () => {
    const f: MeasureFlow[] = [{ forward: true }, { endings: [1], backward: true }, { endings: [2] }, { dacapo: true }];
    expect(unrollMeasures(f)).toEqual([0, 1, 0, 2, 3, 0, 2, 3]);
  });
  it('never loops forever', () => {
    expect(unrollMeasures([{ dalsegno: 'x', segno: 'x' }]).length).toBeLessThan(10);
  });
});

describe('buildTimeline with repeats', () => {
  it('unrolls the repeats+voltas fixture (1 2 3 | 1 2 4 5)', () => {
    const tl = buildTimeline(fx('qa-repeats.musicxml'));
    expect(tl.order).toEqual([1, 2, 3, 1, 2, 4, 5]);
    expect(tl.hasRepeats).toBe(true);
    expect(tl.measureCount).toBe(5);
    expect(tl.measureStartsQ).toEqual([0, 4, 8, 12, 16, 20, 24]);
    expect(tl.totalQ).toBe(28);
    expect(tl.events).toHaveLength(28);
    // written bar kept on events, play-order time
    const second = tl.events.filter((e) => e.timeQ >= 12 && e.timeQ < 16);
    expect(second.map((e) => e.measure)).toEqual([1, 1, 1, 1]);
    expect(second[0].midi).toBe(60);
    expect(tl.events.find((e) => e.timeQ === 20)!.measure).toBe(4);
    expect(measureAt(tl, 13)).toBe(1);
    expect(measureAt(tl, 21)).toBe(4);
    expect(slotAt(tl, 21)).toBe(5);
  });

  it('first-pass seek and no-repeat scores are unchanged', () => {
    const tl = buildTimeline(fx('qa-repeats.musicxml'));
    expect(firstQ(tl, 1)).toBe(0);
    expect(firstQ(tl, 4)).toBe(20);
    expect(firstQ(tl, 5)).toBe(24);
    const plain = buildTimeline(fx('scale.musicxml'));
    expect(plain.hasRepeats).toBe(false);
    expect(plain.order).toEqual([1, 2, 3, 4]);
  });

  it('MIDI export uses the unrolled order', () => {
    const tl = buildTimeline(fx('qa-repeats.musicxml'));
    const m = new Midi(toMidi(tl, 120, 56));
    expect(m.tracks[0].notes).toHaveLength(28);
    expect(m.tracks[0].notes[12].ticks).toBe(12 * 480);
    expect(m.tracks[0].notes[12].midi).toBe(60);
  });

  it('clicks and bar length follow play order', () => {
    const tl = buildTimeline(fx('qa-repeats.musicxml'));
    expect(buildClicks(tl)).toHaveLength(28);
    expect(barLengthQ(tl, 4)).toBe(4);
  });

  it('D.C. al Fine via <sound> attributes', () => {
    const xml = score(4, { 2: snd('fine="yes"'), 4: snd('dacapo="yes"') });
    expect(buildTimeline(xml).order).toEqual([1, 2, 3, 4, 1, 2]);
  });

  it('D.S. al Coda via <sound> attributes', () => {
    const xml = score(5, { 2: snd('segno="s"'), 3: snd('tocoda="c"'), 4: snd('dalsegno="s"'), 5: snd('coda="c"') });
    expect(buildTimeline(xml).order).toEqual([1, 2, 3, 4, 2, 3, 5]);
  });
});

describe('bar labels', () => {
  it('labels an implicit pickup and uses printed numbers', () => {
    const tl = buildTimeline(fx('qa-pickup.musicxml'));
    expect(tl.barLabels[0]).toBe('Pickup');
    expect(tl.barLabels[1]).toBe('1');
    expect(tl.barTotal).toBe(tl.measureCount - 1);
  });
  it('plain scores count 1..n', () => {
    const tl = buildTimeline(fx('scale.musicxml'));
    expect(tl.barLabels).toEqual(['1', '2', '3', '4']);
    expect(tl.barTotal).toBe(4);
  });
});
