import { describe, expect, it } from 'vitest';
import { kids, parseXml, partsOf } from '../../lib/musicxml';
import { readOptions } from '../../lib/omrCore';
import { notationToMusicXml, parseNotation } from '../../lib/omrNotation';
import { barReadingContext, barsToReview, replaceReviewedBar, reviewBarXml, warningBar } from '../../lib/scanReview';
import { buildTimeline } from '../../lib/timeline';

const score = (bars: string) => notationToMusicXml(parseNotation(`clef: treble\nkey: 0\ntime: 4/4\n${bars}`)).xml;

describe('single-bar scan review', () => {
  it('replaces the selected bar and keeps its printed number, repeat and neighbouring notes', () => {
    const original = score('5: C4:w\n6: |: D4:w\n7: E4:w :|');
    const updated = replaceReviewedBar(original, 0, 2, score('1: G4:h A4:h'));
    expect(barsToReview(updated, 0, ['6'])).toEqual([{ label: '6', measure: 2 }]);
    const timeline = buildTimeline(updated);
    expect(timeline.order).toEqual([1, 2, 3, 2, 3]);
    expect(timeline.events.map((note) => note.midi)).toEqual([60, 67, 69, 64, 67, 69, 64]);
  });

  it('uses the effective signatures and leaves the other staff unchanged', () => {
    const original = score('part: Trumpet\n1: C4:w\n2: key=2b B4:w\npart: Trombone\nclef: bass\nkey: 0\ntime: 4/4\n1: C3:w\n2: F3:w');
    const context = barReadingContext(reviewBarXml(original, 0, 2));
    expect(context).toEqual({ clef: 'treble', fifths: -2, beats: 4, beatType: 4 });
    const reading = score('1: key=2b A4:w');
    const updated = replaceReviewedBar(original, 0, 2, reading);
    expect(kids(partsOf(parseXml(updated))[1], 'measure').map(String)).toEqual(kids(partsOf(parseXml(original))[1], 'measure').map(String));
  });

  it('rejects multiple measures, incomplete bars, signature changes and cross-bar ties', () => {
    const original = score('1: C4:w\n2: D4:w\n3: E4:w');
    expect(() => replaceReviewedBar(original, 0, 2, score('1: A4:w\n2: B4:w'))).toThrow(/one bar or staff/);
    expect(() => replaceReviewedBar(original, 0, 2, score('1: A4:q'))).toThrow(/complete bar/);
    expect(() => replaceReviewedBar(original, 0, 2, score('1: key=1b A4:w'))).toThrow(/clef, key or time/);
    expect(() => replaceReviewedBar(score('1: C4:w~\n2: C4:w\n3: E4:w'), 0, 2, score('1: A4:w'))).toThrow(/cross-bar tie/);
  });

  it('limits crop requests to one image with validated context', () => {
    const context = { clef: 'treble', fifths: 0, beats: 4, beatType: 4 };
    expect(readOptions({ hints: { bar: context } }, 1)).toEqual({ tiles: undefined, hints: { bar: context } });
    expect(typeof readOptions({ hints: { bar: context } }, 2)).toBe('string');
    expect(typeof readOptions({ hints: { bar: { ...context, fifths: 8 } } }, 1)).toBe('string');
    expect(warningBar('Bar 7: the reader was not sure.')).toBe('7');
    expect(warningBar('Bars 7, 8 may be missing from the reading.')).toBeUndefined();
  });
});
