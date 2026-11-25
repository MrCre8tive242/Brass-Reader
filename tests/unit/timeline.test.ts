import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Midi } from '@tonejs/midi';
import { buildTimeline, measureAt, sliceTimeline } from '@/lib/timeline';
import { loopQ } from '@/lib/loop';
import { framePos } from '@/lib/videoPlan';
import { buildDrumEvents, starterGroove } from '@/lib/groove';
import { toMidi } from '@/lib/midi';
import { toConcert, fromConcert } from '@/lib/transpose';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, '../fixtures', n), 'utf8');

describe('buildTimeline', () => {
  it('reads a simple scale (written pitches, no transpose element)', () => {
    const tl = buildTimeline(fx('scale.musicxml'));
    expect(tl.events).toHaveLength(16);
    expect(tl.measureStartsQ).toEqual([0, 4, 8, 12]);
    expect(tl.totalQ).toBe(16);
    expect(tl.events[0]).toMatchObject({ timeQ: 0, durQ: 1, midi: 60, measure: 1 });
    expect(tl.events[15]).toMatchObject({ timeQ: 15, midi: 60, measure: 4 });
    expect(tl.timeSigs).toEqual([{ measure: 1, beats: 4, beatType: 4 }]);
  });

  it('merges ties, handles dots and tuplets and rests', () => {
    const tl = buildTimeline(fx('ties-dots.musicxml'));
    const ev = tl.events;
    expect(ev[0]).toMatchObject({ timeQ: 0, durQ: 1.5, midi: 67 });
    expect(ev[1]).toMatchObject({ timeQ: 1.5, durQ: 0.5, midi: 69 });
    // B4 half in bar 1 tied to half in bar 2 -> one 4-quarter note
    expect(ev[2]).toMatchObject({ timeQ: 2, durQ: 4, midi: 71, measure: 1 });
    // triplet eighths start at bar 2 beat 3 (q=6) and last 1/3 quarter each
    expect(ev[3].timeQ).toBeCloseTo(6);
    expect(ev[3].durQ).toBeCloseTo(1 / 3);
    expect(ev[4].timeQ).toBeCloseTo(6 + 1 / 3);
    expect(ev[5].timeQ).toBeCloseTo(6 + 2 / 3);
    // quarter rest at q=7; bar 3 starts at 8
    expect(tl.measureStartsQ).toEqual([0, 4, 8, 12]);
    expect(ev[6]).toMatchObject({ timeQ: 8, midi: 73 }); // C#5
    expect(ev.find((e) => e.timeQ === 10)!.midi).toBe(77); // F natural 5
    expect(ev).toHaveLength(10); // 3 + 3 triplets + 3 + whole note
    expect(tl.totalQ).toBe(16);
  });

  it('handles multi-measure, many bars', () => {
    const tl = buildTimeline(fx('two-pages.musicxml'));
    expect(tl.measureStartsQ).toHaveLength(16);
    expect(tl.events).toHaveLength(64);
    expect(measureAt(tl, 0)).toBe(1);
    expect(measureAt(tl, 35.9)).toBe(9);
    expect(measureAt(tl, 36)).toBe(10);
    expect(measureAt(tl, 9999)).toBe(16);
  });

  it('handles time-signature changes', () => {
    const tl = buildTimeline(fx('key-changes.musicxml'));
    expect(tl.timeSigs).toEqual([
      { measure: 1, beats: 4, beatType: 4 },
      { measure: 3, beats: 3, beatType: 4 },
      { measure: 5, beats: 4, beatType: 4 },
    ]);
    expect(tl.measureStartsQ).toEqual([0, 4, 8, 11, 14, 18]);
    expect(tl.totalQ).toBe(22);
  });

  it('applies <transpose> so midi is sounding pitch', () => {
    const tl = buildTimeline(fromConcert(toConcert(fx('scale.musicxml'), 'trumpet'), 'trumpet'));
    expect(tl.events[0].midi).toBe(58); // written C4 -> sounding Bb3
    const tl2 = buildTimeline(fromConcert(toConcert(fx('scale.musicxml'), 'trumpet'), 'mellophone'));
    expect(tl2.events[0].midi).toBe(58);
  });

  it('sounding pitch follows an octave-shifted instrument part', () => {
    const concert = toConcert(fx('scale.musicxml'), 'trumpet');
    const sousa = buildTimeline(fromConcert(concert, 'sousaphone'));
    expect(sousa.events[0].midi).toBe(58 - 12);
    expect(sousa.events.length).toBe(16);
  });

  it('plays chords and backup voices together', () => {
    const xml = `<score-partwise><part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list><part id="P1">
<measure number="1"><attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
<note><pitch><step>C</step><octave>4</octave></pitch><duration>8</duration></note>
<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>8</duration></note>
<backup><duration>8</duration></backup>
<note><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration></note>
<note><rest/><duration>4</duration></note>
</measure></part></score-partwise>`;
    const tl = buildTimeline(xml);
    expect(tl.events.map((e) => [e.timeQ, e.durQ, e.midi])).toEqual([[0, 2, 55], [0, 4, 60], [0, 4, 64]]);
    expect(tl.totalQ).toBe(4);
  });

  it('does not merge a tie onto an unrelated pitch', () => {
    const xml = `<score-partwise><part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list><part id="P1">
<measure number="1"><attributes><divisions>1</divisions></attributes>
<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><tie type="start"/></note>
<note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><tie type="stop"/></note></measure></part></score-partwise>`;
    expect(buildTimeline(xml).events).toHaveLength(2);
  });
});

describe('toMidi', () => {
  it('round-trips through @tonejs/midi with right note count, tempo, program', () => {
    const tl = buildTimeline(fx('ties-dots.musicxml'));
    const bytes = toMidi(tl, 132, 56);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const m = new Midi(bytes);
    expect(m.header.tempos[0].bpm).toBeCloseTo(132, 0);
    expect(m.tracks).toHaveLength(1);
    expect(m.tracks[0].notes).toHaveLength(tl.events.length);
    expect(m.tracks[0].instrument.number).toBe(56);
    expect(m.tracks[0].notes[0].midi).toBe(67);
    expect(m.tracks[0].notes[2].durationTicks).toBe(4 * 480); // tied
    expect(m.header.timeSignatures[0].timeSignature).toEqual([4, 4]);
  });
  it('writes time signature changes at the right ticks', () => {
    const tl = buildTimeline(fx('key-changes.musicxml'));
    const m = new Midi(toMidi(tl, 100, 57));
    const ts = m.header.timeSignatures;
    expect(ts.map((t) => t.timeSignature)).toEqual([[4, 4], [3, 4], [4, 4]]);
    expect(ts.map((t) => t.ticks)).toEqual([0, 8 * 480, 14 * 480]);
  });
  it('uses concert pitch from a transposed part', () => {
    const tl = buildTimeline(fromConcert(toConcert(fx('scale.musicxml'), 'trumpet'), 'trumpet'));
    const m = new Midi(toMidi(tl, 100, 56));
    expect(m.tracks[0].notes[0].midi).toBe(58);
  });
});

describe('a part of a tune as a tune of its own (a video of the practice loop)', () => {
  const tl = buildTimeline(fx('scale.musicxml')); // 4 bars of 4 quarters

  it('bars 2-3: starts at 0, keeps the written bar numbers, holds only their notes', () => {
    const lq = loopQ(tl, { from: 2, to: 3 })!;
    const part = sliceTimeline(tl, lq.startQ, lq.endQ);
    expect(part.totalQ).toBe(8);
    expect(part.measureStartsQ).toEqual([0, 4]);
    expect(part.order).toEqual([2, 3]);
    expect(part.measureCount).toBe(tl.measureCount);
    expect(part.barLabels).toEqual(tl.barLabels);
    expect(part.events.length).toBe(tl.events.filter((e) => e.measure === 2 || e.measure === 3).length);
    expect(part.events.every((e) => e.measure === 2 || e.measure === 3)).toBe(true);
    expect(Math.min(...part.events.map((e) => e.timeQ))).toBe(0);
    expect(Math.max(...part.events.map((e) => e.timeQ + e.durQ))).toBeLessThanOrEqual(8);
    // the pitches are the ones of those bars, in order
    expect(part.events.map((e) => e.midi)).toEqual(tl.events.filter((e) => e.measure === 2 || e.measure === 3).map((e) => e.midi));
    expect(tl.totalQ).toBe(16); // the tune itself is untouched
  });

  it('the video frames of it show bar 2 with bar 3, then bar 3 alone', () => {
    const lq = loopQ(tl, { from: 2, to: 3 })!;
    const part = sliceTimeline(tl, lq.startQ, lq.endQ);
    expect(framePos(part, 120, 0)).toMatchObject({ bar: 2, slot: 0 });
    expect(framePos(part, 120, 0).win.bars).toEqual([2, 3]);
    expect(framePos(part, 120, 60)).toMatchObject({ bar: 3, slot: 1 });
    expect(framePos(part, 120, 60).win.bars).toEqual([3]);
    expect(framePos(part, 120, 121)).toMatchObject({ bar: 3, ended: true });
  });

  it('with repeats it is the played bars between the two points', () => {
    const r = buildTimeline(fx('qa-repeats.musicxml')); // plays 1 2 3 1 2 4 5
    const part = sliceTimeline(r, r.measureStartsQ[2], r.measureStartsQ[5]);
    expect(part.order).toEqual([3, 1, 2]);
    expect(part.totalQ).toBe(12);
    expect(part.hasRepeats).toBe(true);
  });

  it('a note running past the end is cut there; nothing outside is taken', () => {
    const cut = sliceTimeline(tl, 4, 6);
    expect(cut.order).toEqual([2]);
    expect(cut.totalQ).toBe(2);
    for (const e of cut.events) expect(e.timeQ + e.durQ).toBeLessThanOrEqual(2 + 1e-9);
    expect(sliceTimeline(tl, 100, 200)).toBe(tl); // nothing there: the whole tune
  });

  it('the drums start with it', () => {
    const lq = loopQ(tl, { from: 3, to: 4 })!;
    const part = sliceTimeline(tl, lq.startQ, lq.endQ);
    const hits = buildDrumEvents(part, starterGroove('starter-a')!);
    expect(hits.length).toBeGreaterThan(8);
    expect(hits[0].timeQ).toBe(0);
    expect(Math.max(...hits.map((h) => h.timeQ))).toBeLessThan(8);
  });
});
