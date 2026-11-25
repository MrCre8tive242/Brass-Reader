import { describe, it, expect } from 'vitest';
import { DEFAULT_DRUMS, normalizeDrums, drumsAudible, feelFor } from '@/lib/drumSettings';
import { starterGroove } from '@/lib/groove';
import { toMidi } from '@/lib/midi';
import { Midi } from '@tonejs/midi';
import { buildTimeline } from '@/lib/timeline';
import { notationToMusicXml, parseNotation } from '@/lib/omrNotation';
import { buildDrumEvents } from '@/lib/groove';

describe('drum settings', () => {
  it('repairs whatever was stored', () => {
    expect(normalizeDrums(undefined)).toEqual(DEFAULT_DRUMS);
    expect(normalizeDrums({ grooveId: 5 as unknown as string, volume: 9, feel: 'swing' as never, on: false })).toMatchObject({ grooveId: null, volume: 1, on: false });
    expect(normalizeDrums({ feel: 'triplet' }).feel).toBe('triplet');
  });
  it('is audible only with a groove, switched on, and not while recording unless kept', () => {
    const g = starterGroove('starter-a')!;
    expect(drumsAudible(DEFAULT_DRUMS, undefined, false)).toBe(false);
    expect(drumsAudible(DEFAULT_DRUMS, g, false)).toBe(true);
    expect(drumsAudible({ ...DEFAULT_DRUMS, on: false }, g, false)).toBe(false);
    expect(drumsAudible({ ...DEFAULT_DRUMS, inTakes: false }, g, true)).toBe(false);
    expect(drumsAudible({ ...DEFAULT_DRUMS, inTakes: true }, g, true)).toBe(true);
  });
  it('the score chooses the feel of a 16-step starter groove only', () => {
    const g = starterGroove('starter-a')!;
    expect(feelFor(DEFAULT_DRUMS, g)).toBe('straight');
    expect(feelFor({ ...DEFAULT_DRUMS, feel: 'triplet' }, g)).toBe('triplet');
    expect(feelFor({ ...DEFAULT_DRUMS, feel: 'triplet' }, { ...g, kind: 'recorded' })).toBe('straight');
  });
});

describe('MIDI drum track', () => {
  const tl = buildTimeline(notationToMusicXml(parseNotation('time: 4/4\n1: C5:w\n2: C5:w')).xml);
  it('goes on channel 10 with the General MIDI notes', () => {
    const ev = buildDrumEvents(tl, starterGroove('starter-a')!);
    const m = new Midi(toMidi(tl, 100, 56, 'x', undefined, ev));
    expect(m.tracks).toHaveLength(2);
    const d = m.tracks[1];
    expect(d.channel).toBe(9);
    expect(new Set(d.notes.map((n) => n.midi))).toEqual(new Set([36, 47, 56, 72]));
    expect(d.notes.length).toBe(ev.length);
    expect(d.notes[0].ticks).toBe(0);
  });
  it('without drums the file is as before', () => {
    expect(new Midi(toMidi(tl, 100, 56)).tracks).toHaveLength(1);
  });
});
