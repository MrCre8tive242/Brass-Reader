import { describe, it, expect, vi } from 'vitest';
import { planStrips, inkProfile, type Gray } from '@/lib/imagePrep';
import { mergeStripReadings, parseNotation } from '@/lib/omrNotation';
import { runOmr, readOptions, MAX_IMAGES, type OmrDeps, type OmrRequest } from '@/lib/omrCore';
import { pageLabels, partPrompt, partLabel } from '@/lib/omrPrompt';
import { buildContent } from '@/lib/omrMessage';
import { drawScale, STRIP_WIDTH } from '@/lib/omrClient';

// a staff here: staff lines every 9 rows over 37 rows (5 lines); the in-between rows hold only a few note rows
function staffProfile(h: number, tops: number[], _height = 40, extra: [number, number][] = []): Float32Array {
  const p = new Float32Array(h);
  for (const t of tops) for (let i = 0; i < 5; i++) for (let k = 0; k < 2; k++) p[t + i * 9 + k] = 0.9;
  for (const [a, b] of extra) for (let y = a; y < b; y++) p[y] = 0.2;
  return p;
}
const systemsAt = (n: number, first = 40, pitch = 110) => Array.from({ length: n }, (_, i) => first + i * pitch);

describe('planStrips', () => {
  it('6 systems become 3 strips of two, cut in the middle of the gaps', () => {
    const tops = systemsAt(6); // each staff is 38 rows tall, 70 rows of gap
    const rows = planStrips(staffProfile(900, tops));
    expect(rows).toHaveLength(2);
    // between system 2 and 3 (ends 40+140+38=218.. next starts 320) and between 4 and 5
    expect(rows[0]).toBeGreaterThan(tops[1] + 38); expect(rows[0]).toBeLessThan(tops[2]);
    expect(rows[1]).toBeGreaterThan(tops[3] + 38); expect(rows[1]).toBeLessThan(tops[4]);
  });
  it('one or two systems stay whole', () => {
    expect(planStrips(staffProfile(400, systemsAt(1)))).toEqual([]);
    expect(planStrips(staffProfile(400, systemsAt(2)))).toEqual([]);
    expect(planStrips(new Float32Array(500))).toEqual([]); // a blank page
  });
  it('never cuts inside a system: the blank rows between staff lines are not gaps', () => {
    const tops = systemsAt(8, 30, 100);
    const rows = planStrips(staffProfile(1000, tops));
    for (const r of rows) {
      const inside = tops.some((t) => r >= t && r <= t + 38);
      expect(inside).toBe(false);
    }
    expect(rows).toHaveLength(3); // 8 systems: 4 strips
  });
  it('3 systems make 2 strips, 5 systems 3, and at most 4 strips for any number', () => {
    expect(planStrips(staffProfile(600, systemsAt(3)))).toHaveLength(1);
    expect(planStrips(staffProfile(800, systemsAt(5)))).toHaveLength(2);
    expect(planStrips(staffProfile(2200, systemsAt(14, 40, 110)))).toHaveLength(3);
  });
  it('keeps a ledger-line note that reaches into the gap with its system', () => {
    const tops = systemsAt(4);
    // high notes on ledger lines above system 3 fill the rows right above its staff
    const rows = planStrips(staffProfile(700, tops, 40, [[tops[2] - 30, tops[2] - 4]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBeLessThan(tops[2] - 30);
    expect(rows[0]).toBeGreaterThan(tops[1] + 38);
  });
  it('a title above the first system is not a system of its own', () => {
    // title text (20 rows of ink) 70 rows above the music; 4 systems of music
    const tops = systemsAt(4, 140);
    const p = staffProfile(800, tops, 40, [[30, 52]]);
    const rows = planStrips(p);
    expect(rows).toHaveLength(1); // 4 systems -> 2 strips; the title joined the first system
    expect(rows[0]).toBeGreaterThan(tops[1] + 38);
    expect(rows[0]).toBeLessThan(tops[2]);
  });
  it('dense music (notes fill every space of the staff) and tight gaps still cut', () => {
    const p = new Float32Array(1000);
    for (let i = 0; i < 6; i++) for (let y = 20 + i * 150; y < 20 + i * 150 + 120; y++) p[y] = 0.4; // 120 rows of ink, 30 blank
    expect(planStrips(p)).toHaveLength(2);
  });
  it('a tilted page (ink in every row) is sent whole', () => {
    const p = new Float32Array(800).fill(0.3);
    expect(planStrips(p)).toEqual([]);
  });
  it('works from real pixels (inkProfile) and ignores a dark table edge', () => {
    const w = 300, h = 900;
    const g: Gray = { data: new Uint8ClampedArray(w * h).fill(255), w, h };
    for (const t of systemsAt(6, 40, 110)) for (let i = 0; i < 5; i++) for (let x = 20; x < 280; x++) g.data[(t + i * 9) * w + x] = 0;
    for (let y = 0; y < h; y++) g.data[y * w + 2] = 0;
    expect(planStrips(inkProfile(g))).toHaveLength(2);
  });
});

describe('strip size', () => {
  it('scales every strip to about 2000 px wide, up as well as down, within the cap', () => {
    expect(drawScale(1272, 400, true, 2200) * 1272).toBeCloseTo(STRIP_WIDTH, 0);
    expect(drawScale(3000, 400, true, 2200) * 3000).toBeCloseTo(STRIP_WIDTH, 0);
    expect(drawScale(1272, 400, true, 1000)).toBeCloseTo(1000 / 1272, 5); // the payload budget still wins
    expect(drawScale(300, 100, true, 2200)).toBe(3); // tiny pictures are not blown up without limit
    expect(drawScale(1272, 400, false, 2200)).toBe(1); // unzoomed pages are only ever shrunk
  });
});

describe('tiles and labels', () => {
  it('accepts up to 4 images per page, 12 in all', () => {
    expect(MAX_IMAGES).toBe(12);
    expect(readOptions({ tiles: [4, 4, 4] }, 12)).toEqual({ tiles: [4, 4, 4], hints: {} });
    expect(readOptions({ tiles: [3] }, 3)).toEqual({ tiles: [3], hints: {} });
    expect(readOptions({ tiles: [5] }, 5)).toMatch(/tiles/);
    expect(readOptions({ tiles: [0, 1] }, 1)).toMatch(/tiles/);
  });
  it('labels strips "part k of n from the top"', () => {
    expect(pageLabels(3, [3])).toEqual(['The page, part 1 of 3 from the top:', 'The page, part 2 of 3 from the top:', 'The page, part 3 of 3 from the top:']);
    expect(pageLabels(4, [4])[3]).toBe('The page, part 4 of 4 from the top:');
  });
  it('a strip request carries its own label and prompt', () => {
    const c = buildContent({ images: ['data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/'], tiles: [1], part: { index: 2, count: 3 } });
    expect(c[0]).toEqual({ type: 'text', text: partLabel(2, 3) });
    const text = (c[c.length - 1] as { text: string }).text;
    expect(text).toMatch(/part 2 of 3/);
    expect(text).toMatch(/from 1/);
    expect(text).toMatch(/leave out the title/);
    expect(partPrompt(1, 3)).toMatch(/pickup bar \(bar 0\)/);
    expect(partPrompt(1, 3)).not.toMatch(/leave out the title/);
  });
});

const S1 = `title: Dense Etude
part: Baritone
clef: bass
key: 2b
time: 4/4
tempo: 100
# page 1 system 1
0: F3:q
1: |: B3:q D4:e C4:e B3:h
2: C4:w~
? 2: the first note may be a natural
# page 1 system 2
3: C4:q r:q r:h :|`;
const S2 = `clef: bass
key: 2b
# system 3
1: D3:w
2: E3:w
? 2: smudged
3: R`;
const S3 = `clef: bass
key: 3b
time: 3/4
1: F3:h.
2-3: R
4: |: G3:h. :|
? 3: unclear`;

describe('mergeStripReadings', () => {
  it('renumbers bars continuously, keeps the header of part 1 and moves the flags with their bars', () => {
    const m = mergeStripReadings([S1, S2])!;
    const s = parseNotation(m);
    expect(s.title).toBe('Dense Etude');
    expect(s.tempo).toBe(100);
    expect(s.parts).toHaveLength(1);
    expect(s.parts[0].name).toBe('Baritone');
    expect(s.parts[0].bars.map((b) => b.label)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(s.notes.map((n) => n.bar)).toEqual(['2', '5']); // "? 2: smudged" of part 2 is now bar 5
    expect(s.parts[0].bars[4].raw).toBe('D3:w');
    expect(s.parts[0].bars[4].key).toBeUndefined(); // same key: no change written
    expect(s.parts[0].bars[0].time).toBeUndefined();
  });
  it('keeps a key or time change at the bar where the next part starts, and ranges and repeats', () => {
    const m = mergeStripReadings([S1, S2, S3])!;
    const s = parseNotation(m);
    const bars = s.parts[0].bars;
    expect(bars.map((b) => b.label)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    const b7 = bars[7]; // first bar of strip 3
    expect(b7.label).toBe('7');
    expect(b7.key).toBe(-3);
    expect(b7.time).toEqual({ beats: 3, beatType: 4 });
    expect(bars[8].fullRest && bars[9].fullRest).toBe(true); // "2-3: R" became 8-9
    expect(bars[10].repeatStart && bars[10].repeatEnd).toBe(true);
    expect(s.notes.map((n) => n.bar)).toEqual(['2', '5', '9']);
    expect(bars[1].repeatStart).toBe(true);
    expect(bars[3].repeatEnd).toBe(true);
  });
  it('a pickup written by a later part is just an ordinary bar; title, part name and tempo of later parts are dropped', () => {
    const later = 'title: Other\npart: Tuba\ntempo: 200\nclef: bass\nkey: 2b\n0: C3:q\n1: D3:w';
    const s = parseNotation(mergeStripReadings([S1, later])!);
    expect(s.title).toBe('Dense Etude');
    expect(s.tempo).toBe(100);
    expect(s.parts[0].name).toBe('Baritone');
    expect(s.parts[0].bars.map((b) => b.label)).toEqual(['0', '1', '2', '3', '4', '5']);
  });
  it('a change of clef is kept; a missing time line leaves the time in force', () => {
    const later = 'clef: treble\nkey: 2b\n1: F4:w';
    const s = parseNotation(mergeStripReadings([S1, later])!);
    const b = s.parts[0].bars[4];
    expect(b.clef).toBe('treble');
    expect(b.time).toBeUndefined();
  });
  it('refuses a reading with several parts or no bars', () => {
    expect(mergeStripReadings([S1, 'part: A\n1: C4:w\npart: B\n1: C3:w'])).toBeNull();
    expect(mergeStripReadings([S1, 'clef: bass'])).toBeNull();
    expect(mergeStripReadings([])).toBeNull();
  });
});

// ------------------------------------------------------------------ the parallel reading

const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/';
const R1 = 'title: T\nclef: bass\nkey: 0\ntime: 4/4\n1: C3:q D3:q E3:q F3:q\n2: G3:w';
const R2 = 'clef: bass\nkey: 0\n1: A3:w\n2: B3:h C4:h';
const R3 = 'clef: bass\nkey: 0\n1: C4:q C4:q C4:h\n2: R';

function mkDeps(call: OmrDeps['callClaude']): OmrDeps {
  return { hasClaudeKey: true, hasAudiveris: false, callClaude: vi.fn(call), callAudiveris: vi.fn(async () => ({ musicxml: '' })) };
}
const req3: OmrRequest = { images: [img, img, img], tiles: [3] };

describe('runOmr with strips', () => {
  it('reads every strip at the same time, joins them, and keeps one second look at most', async () => {
    let running = 0, peak = 0;
    const replies = [R1, R2, R3];
    const d = mkDeps(async (r) => {
      if (!r.part) throw new Error('unexpected single call');
      running++; peak = Math.max(peak, running);
      await new Promise((res) => setTimeout(res, 20));
      running--;
      expect(r.images).toHaveLength(1);
      expect(r.part.count).toBe(3);
      return replies[r.part.index - 1];
    });
    const out = await runOmr(req3, 'claude', d);
    expect(peak).toBe(3);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.engine).toBe('claude');
      expect((out.musicxml.match(/<measure /g) ?? []).length).toBe(6);
    }
    expect(d.callClaude).toHaveBeenCalledTimes(3); // all bars add up: no second look
  });
  it('falls back to one call with all images when a strip fails', async () => {
    const d = mkDeps(async (r) => {
      if (r.part) { if (r.part.index === 2) throw new Error('boom'); return R1; }
      return `${R1}\n3: A3:w\n4: B3:w`;
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await runOmr(req3, 'claude', d);
    spy.mockRestore();
    expect(out.ok).toBe(true);
    const calls = (d.callClaude as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.filter((c) => !c[0].part)).toHaveLength(1);
    expect(calls.find((c) => !c[0].part)![0].images).toHaveLength(3);
  });
  it('falls back when a strip comes back unusable', async () => {
    const d = mkDeps(async (r) => (r.part ? (r.part.index === 3 ? 'sorry, cannot read' : R1) : R1));
    const out = await runOmr(req3, 'claude', d);
    expect(out.ok).toBe(true);
    expect((d.callClaude as ReturnType<typeof vi.fn>).mock.calls.filter((c) => !c[0].part)).toHaveLength(1);
  });
  it('a second look on problem bars uses the merged reading and all the images', async () => {
    const bad = 'title: T\nclef: bass\nkey: 0\ntime: 4/4\n1: C3:w\n2: C3:q D3:q E3:q\n3: G3:w';
    const seen: { req: OmrRequest; followUp?: string }[] = [];
    const d = mkDeps(async (r, f) => {
      seen.push({ req: r, followUp: f });
      if (r.part) return r.part.index === 1 ? bad : R2;
      return '2: C3:q D3:q E3:q F3:q';
    });
    const out = await runOmr({ images: [img, img], tiles: [2] }, 'claude', d);
    expect(out.ok).toBe(true);
    const second = seen.find((s) => !s.req.part)!;
    expect(second.req.images).toHaveLength(2);
    expect(second.followUp).toContain('<reading>');
    expect(second.followUp).toContain('2: C3:q D3:q E3:q');
    expect(second.followUp).toContain('4: A3:w'); // the merged, renumbered second strip
  });
  it('a single image is read in one call', async () => {
    const d = mkDeps(async (r) => { expect(r.part).toBeUndefined(); return R1; });
    const out = await runOmr({ images: [img], tiles: [1] }, 'claude', d);
    expect(out.ok).toBe(true);
    expect(d.callClaude).toHaveBeenCalledTimes(1);
  });
  it('a request that names one part of several instruments is not split', async () => {
    const d = mkDeps(async (r) => { expect(r.part).toBeUndefined(); expect(r.images).toHaveLength(3); return R1; });
    const out = await runOmr({ ...req3, hints: { part: 'Trombone 2' } }, 'claude', d);
    expect(out.ok).toBe(true);
    expect(d.callClaude).toHaveBeenCalledTimes(1);
  });
  it('more than 8 images are read in one call', async () => {
    const d = mkDeps(async (r) => { expect(r.part).toBeUndefined(); return R1; });
    const out = await runOmr({ images: Array(9).fill(img), tiles: [3, 3, 3] }, 'claude', d);
    expect(out.ok).toBe(true);
    expect(d.callClaude).toHaveBeenCalledTimes(1);
  });
  it('NOT_MUSIC on a strip falls back to the whole-request reading, which gives the final answer', async () => {
    const d = mkDeps(async (r) => (r.part ? 'NOT_MUSIC a photo of a cat' : 'NOT_MUSIC a photo of a cat'));
    const out = await runOmr(req3, 'claude', d);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('not_music');
  });
});

describe('planStrips: a title with a wide gap under it', () => {
  it('never becomes a strip of its own', () => {
    // title (text, light ink) at 0..40, wide gap, then 6 systems of 5 staff lines each, gaps of 40
    const h = 1000; const p = new Float32Array(h);
    for (let y = 10; y < 40; y++) p[y] = 0.12;
    let y0 = 160;
    const sys: number[] = [];
    for (let s = 0; s < 6; s++) { sys.push(y0); for (let l = 0; l < 5; l++) { p[y0 + l * 10] = 0.95; for (let k = 1; k < 10 && l < 4; k++) p[y0 + l * 10 + k] = 0.05; } y0 += 40 + 40 + 40; }
    const cuts = planStrips(p.subarray(0, Math.min(h, y0)));
    expect(cuts.length).toBeGreaterThan(0);
    expect(cuts[0]).toBeGreaterThan(sys[0]); // the first cut is below the first staff, not under the title
  });
});
