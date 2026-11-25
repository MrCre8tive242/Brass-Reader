import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Midi } from '@tonejs/midi';
import { addPartsTo, barCount, fitBars, mergeScores, mergeTimelines, songPartsOf } from '@/lib/song';
import { buildTimeline } from '@/lib/timeline';
import { summariseScore, validateMusicXml } from '@/lib/musicxml';
import { notationToMusicXml, parseNotation } from '@/lib/omrNotation';
import { partGain, normalizeMix } from '@/lib/mixer';
import { toMidi } from '@/lib/midi';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, '../fixtures', n), 'utf8');
const xmlOf = (t: string) => notationToMusicXml(parseNotation(t)).xml;
const TRUMPET = 'part: Trumpet\nclef: treble\ntime: 4/4\n1: C5:w\n2: D5:w\n3: E5:w\n4: F5:w';
const BASS8 = 'part: Bass\nclef: bass\ntime: 4/4\n1: C3:w\n2: D3:w';

describe('song parts', () => {
  it('a single-part record becomes one part with the saved instrument', () => {
    const parts = songPartsOf({ sourceXml: fx('scale.musicxml'), sourceInstrument: 'mellophone', title: 'Scale' });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ id: 'p0', instrument: 'mellophone' });
  });
  it('an old multi-part record is split; "my" part keeps the saved instrument, others are detected from the clef', () => {
    const parts = songPartsOf({ sourceXml: fx('qa-twoparts.musicxml'), sourceInstrument: 'trumpet', partIndex: null });
    expect(parts.map((p) => p.instrument)).toEqual(['trumpet', 'trombone']);
    expect(parts.every((p) => summariseScore(p.xml).parts.length === 1)).toBe(true);
    const mine1 = songPartsOf({ sourceXml: fx('qa-twoparts.musicxml'), sourceInstrument: 'baritone', partIndex: 1 });
    expect(mine1.map((p) => p.instrument)).toEqual(['trumpet', 'baritone']);
  });
  it('stored parts win over the old fields', () => {
    const stored = [{ id: 'a', name: 'A', xml: fx('scale.musicxml'), instrument: 'trombone' as const }];
    expect(songPartsOf({ sourceXml: 'ignored', sourceInstrument: 'trumpet', parts: stored })).toEqual(stored);
  });
  it('adding a multi-part file adds all its parts; a single part adds one; names stay unique', () => {
    let n = 0;
    const id = () => `n${n++}`;
    const base = songPartsOf({ sourceXml: fx('scale.musicxml'), sourceInstrument: 'trumpet', title: 'Scale' });
    const two = addPartsTo(base, fx('qa-twoparts.musicxml'), id);
    expect(two).toHaveLength(3);
    expect(two[2].instrument).toBe('trombone');
    const one = addPartsTo(two, fx('scale.musicxml'), id, 'sousaphone');
    expect(one).toHaveLength(4);
    expect(one[3].instrument).toBe('sousaphone');
    expect(new Set(one.map((p) => p.name)).size).toBe(4);
    expect(addPartsTo(base, fx('qa-twoparts.musicxml'), id, undefined, 1)).toHaveLength(2);
  });
});

describe('aligning parts by bar', () => {
  it('pads a short part with whole-bar rests', () => {
    const r = fitBars(xmlOf(BASS8), 4);
    expect(r).toMatchObject({ bars: 4, added: 2, removed: 0 });
    expect(barCount(r.xml)).toBe(4);
    expect(validateMusicXml(r.xml).ok).toBe(true);
    const tl = buildTimeline(r.xml);
    expect(tl.totalQ).toBe(16); // rest bars last a full bar
    expect(tl.events).toHaveLength(2);
  });
  it('cuts a long part and leaves an equal one alone', () => {
    const x = xmlOf(TRUMPET);
    expect(fitBars(x, 2)).toMatchObject({ bars: 2, removed: 2 });
    expect(barCount(fitBars(x, 2).xml)).toBe(2);
    expect(fitBars(x, 4).xml).toBe(x);
  });
  it('padding follows the time signature in force', () => {
    const r = fitBars(xmlOf('time: 3/4\n1: C5:h.\n2: D5:h.'), 3);
    expect(buildTimeline(r.xml).totalQ).toBe(9);
  });
});

describe('ensemble timeline and export', () => {
  const mine = xmlOf(TRUMPET);
  const other = fitBars(xmlOf(BASS8), 4).xml;
  it('puts every part on the same bars, tagged with its part number', () => {
    const m = mergeTimelines(buildTimeline(mine), 0, [{ index: 1, tl: buildTimeline(other) }]);
    expect(m.events.filter((e) => e.part === 0)).toHaveLength(4);
    const bass = m.events.filter((e) => e.part === 1);
    expect(bass.map((e) => [e.timeQ, e.measure])).toEqual([[0, 1], [4, 2]]);
    expect(m.totalQ).toBe(16);
    expect(m.events.map((e) => e.timeQ)).toEqual([...m.events.map((e) => e.timeQ)].sort((a, b) => a - b));
  });
  it('is inaudible-safe for a part with fewer bars (no events, no crash)', () => {
    const m = mergeTimelines(buildTimeline(mine), 0, [{ index: 1, tl: buildTimeline(xmlOf(BASS8)) }]);
    expect(m.events.filter((e) => e.part === 1)).toHaveLength(2);
  });
  it('merged MusicXML has one part per instrument and is valid', () => {
    const merged = mergeScores([{ xml: mine, name: 'Trumpet' }, { xml: other, name: 'Bass' }]);
    const s = summariseScore(merged);
    expect(s.parts.map((p) => p.name)).toEqual(['Trumpet', 'Bass']);
    expect(s.parts.map((p) => p.clef)).toEqual(['treble', 'bass']);
    expect(validateMusicXml(merged).ok).toBe(true);
    expect(buildTimeline(merged).events).toHaveLength(6);
  });
  it('MIDI export has one track per part with that part\'s notes', () => {
    const m = mergeTimelines(buildTimeline(mine), 0, [{ index: 1, tl: buildTimeline(other) }]);
    const bytes = toMidi(m, 100, 56, 'Song', [{ name: 'Trumpet', program: 56 }, { name: 'Bass', program: 58 }]);
    const back = new Midi(bytes);
    expect(back.tracks).toHaveLength(2);
    expect(back.tracks.map((t) => t.name)).toEqual(['Trumpet', 'Bass']);
    expect(back.tracks.map((t) => t.notes.length)).toEqual([4, 2]);
    expect(back.tracks[1].instrument.number).toBe(58);
    // a single part still writes one track
    expect(new Midi(toMidi(buildTimeline(mine), 100, 56)).tracks).toHaveLength(1);
  });
});

describe('mixer', () => {
  const v = (volume = 1, mute = false, solo = false) => ({ volume, mute, solo });
  it('mute silences, volume scales, solo silences the rest', () => {
    expect(partGain([v(), v(0.5), v(1, true)], 0)).toBe(1);
    expect(partGain([v(), v(0.5), v(1, true)], 1)).toBe(0.5);
    expect(partGain([v(), v(0.5), v(1, true)], 2)).toBe(0);
    expect(partGain([v(), v(1, false, true), v()], 0)).toBe(0);
    expect(partGain([v(), v(0.4, false, true), v()], 1)).toBe(0.4);
    expect(partGain([], 3)).toBe(1);
  });
  it('mute and solo together: solo wins for that part only if it is soloed', () => {
    expect(partGain([v(1, true, true), v()], 0)).toBe(1);
    expect(partGain([v(1, true, true), v()], 1)).toBe(0);
  });
  it('repairs odd saved values', () => {
    expect(normalizeMix({ volume: 7 })).toEqual({ volume: 1, mute: false, solo: false });
    expect(normalizeMix(undefined).volume).toBe(1);
  });
});

import { vi, beforeEach, afterEach } from 'vitest';
import { Player } from '@/lib/player';

describe('Player plays each part with its own sound, mix applied', () => {
  beforeEach(() => { vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {}); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} }, frequency: { value: 0 }, start() {}, stop() {}, type: '' });
  const ctx = () => ({ currentTime: 0, state: 'running', destination: {}, resume: async () => {}, createGain: node, createOscillator: node, createBiquadFilter: node } as unknown as AudioContext & { currentTime: number });

  async function run(mix: { volume: number; mute: boolean; solo: boolean }[]) {
    const c = ctx();
    const p = new Player(c);
    const got: { who: number; note: number; velocity: number }[] = [];
    const voice = (who: number) => ({ start: (n: { note: number; velocity: number }) => got.push({ who, note: n.note, velocity: n.velocity }), stop() {} });
    (p as unknown as { partVoices: unknown[] }).partVoices = [voice(0), voice(1)];
    const mine = buildTimeline(xmlOf(TRUMPET));
    p.setTimeline(mergeTimelines(mine, 0, [{ index: 1, tl: buildTimeline(fitBars(xmlOf(BASS8), 4).xml) }]));
    p.setMix(mix);
    await p.play();
    for (let t = 0; t < 2; t += 0.1) { c.currentTime = t; (p as unknown as { tick(): void }).tick(); }
    p.dispose();
    return got;
  }
  const mx = (volume = 1, mute = false, solo = false) => ({ volume, mute, solo });

  it('routes notes to the voice of their part', async () => {
    const got = await run([mx(), mx()]);
    expect(got.filter((g) => g.who === 0).map((g) => g.note)).toEqual([72]);
    expect(got.filter((g) => g.who === 1).map((g) => g.note)).toEqual([48]);
  });
  it('mute my part is one flag: only the backing sounds', async () => {
    const got = await run([mx(1, true), mx()]);
    expect(got.map((g) => g.who)).toEqual([1]);
  });
  it('volume scales the velocity and solo silences the others', async () => {
    const half = await run([mx(0.5), mx()]);
    expect(half.find((g) => g.who === 0)!.velocity).toBeCloseTo(0.4);
    expect(half.find((g) => g.who === 1)!.velocity).toBeCloseTo(0.8);
    const solo = await run([mx(), mx(1, false, true)]);
    expect(solo.map((g) => g.who)).toEqual([1]);
  });
});
