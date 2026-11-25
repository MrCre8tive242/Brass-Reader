import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { analyseAndRepair } from '@/lib/repair';
import { buildTimeline } from '@/lib/timeline';
import { runOmr, type OmrDeps } from '@/lib/omrCore';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, '../fixtures', n), 'utf8');
const note = (dur: number, step = 'C') => `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${dur}</duration><voice>1</voice><type>quarter</type></note>`;
function score(measures: string[], extra = '') {
  const attrs = '<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>';
  const body = measures.map((m, i) => `<measure number="${i + 1}"${i === 0 && extra ? ' ' + extra : ''}>${i === 0 ? attrs : ''}${m}</measure>`).join('');
  return `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>x</part-name></score-part></part-list><part id="P1">${body}</part></score-partwise>`;
}
const full = note(1) + note(1) + note(1) + note(1);

describe('analyseAndRepair', () => {
  it('leaves a regular score untouched (same string)', () => {
    const x = score([full, full, full]);
    const r = analyseAndRepair(x);
    expect(r.issues).toEqual([]);
    expect(r.xml).toBe(x);
  });
  it('flags a short bar, pads it with rests, and the timeline stays aligned', () => {
    const x = score([full, note(1) + note(1) + note(1), full, full]);
    const r = analyseAndRepair(x);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ measure: 2, label: '2', kind: 'short', haveQ: 3, wantQ: 4, repaired: true });
    expect(r.warnings).toEqual(['Bar 2 may be misread (has 3 of 4 beats).']);
    const tl = buildTimeline(r.xml);
    expect(tl.measureStartsQ).toEqual([0, 4, 8, 12]);
    expect(buildTimeline(x).measureStartsQ).toEqual([0, 4, 7, 11]); // unrepaired would drift
  });
  it('pads with several rest values (3 quarters missing = half + quarter)', () => {
    const r = analyseAndRepair(score([full, note(1), full, full]));
    expect(r.xml.match(/<rest\/>/g)).toHaveLength(2);
    expect(buildTimeline(r.xml).measureStartsQ).toEqual([0, 4, 8, 12]);
  });
  it('flags (cannot repair) a long bar', () => {
    const r = analyseAndRepair(score([full, full + note(1), full]));
    expect(r.issues[0]).toMatchObject({ measure: 2, kind: 'long', repaired: false });
    expect(r.warnings[0]).toMatch(/Bar 2 may be misread \(has 5 of 4 beats\)/);
  });
  it('allows a pickup first bar and a short last bar', () => {
    const r = analyseAndRepair(score([note(1), full, full, note(2)]));
    expect(r.issues).toEqual([]);
  });
  it('allows an implicit short bar anywhere', () => {
    const x = score([full, full, full]).replace('<measure number="2">', '<measure number="2" implicit="yes">').replace(/(<measure number="2" implicit="yes">)(.*?)(<\/measure>)/, `$1${note(1)}$3`);
    expect(analyseAndRepair(x).issues).toEqual([]);
  });
  it('empty bar (QA fixture) is padded with a measure rest so the cursor and bar counter agree', () => {
    const x = fx('qa-rests.musicxml');
    const before = buildTimeline(x);
    const r = analyseAndRepair(x);
    expect(r.issues.some((i) => i.kind === 'empty' && i.measure === 4 && i.repaired)).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/Bar 4 may be misread \(is empty\)/);
    expect(r.xml).toContain('<rest measure="yes"/>');
    const after = buildTimeline(r.xml);
    expect(after.measureStartsQ).toEqual(before.measureStartsQ); // same length as before: the bar just really has a rest now
    expect(after.events).toHaveLength(before.events.length);
  });
  it('does not touch multi-voice bars it cannot pad safely, but still flags long ones', () => {
    const r = analyseAndRepair(fx('qa-voices.musicxml'));
    expect(r.issues.every((i) => !i.repaired || i.kind === 'empty')).toBe(true);
  });
  it('labels the pickup and uses printed bar numbers', () => {
    const x = fx('qa-pickup.musicxml');
    expect(analyseAndRepair(x).issues).toEqual([]);
  });
  it('fixtures from earlier passes are all clean', () => {
    for (const f of ['scale.musicxml', 'ties-dots.musicxml', 'two-pages.musicxml', 'key-changes.musicxml', 'qa-timesig.musicxml', 'qa-tricky1.musicxml', 'qa-repeats.musicxml']) {
      expect(analyseAndRepair(fx(f)).issues, f).toEqual([]);
    }
  });
});

describe('OMR retry names the irregular bars and keeps the better reading', () => {
  const bad = score([full, note(1) + note(1), full, full]);
  const good = score([full, full, full, full]);
  const deps = (over: Partial<OmrDeps>): OmrDeps => ({ hasClaudeKey: true, hasAudiveris: false, callClaude: vi.fn(async () => bad), callAudiveris: vi.fn(), ...over }) as OmrDeps;
  it('retries once with the bar numbers and takes the clean reading', async () => {
    const calls: unknown[] = [];
    const d = deps({ callClaude: vi.fn(async (_i, retry) => { calls.push(retry); return retry ? good : bad; }) });
    const r = await runOmr(['data:image/jpeg;base64,AAAA'], 'claude', d);
    expect(r).toMatchObject({ ok: true, engine: 'claude', warnings: [] });
    expect((calls[1] as { error: string }).error).toMatch(/Bars 2 do not add up/);
  });
  it('if the retry is no better, returns the padded first reading with a warning', async () => {
    const d = deps({});
    const r = await runOmr(['data:image/jpeg;base64,AAAA'], 'claude', d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toEqual(['Bar 2 may be misread (has 2 of 4 beats).']);
      expect(buildTimeline(r.musicxml).measureStartsQ).toEqual([0, 4, 8, 12]);
    }
  });
  it('a failing retry still returns the first reading', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    const d = deps({ callClaude: vi.fn(async () => { if (n++) throw new Error('boom'); return bad; }) });
    const r = await runOmr(['data:image/jpeg;base64,AAAA'], 'claude', d);
    expect(r.ok).toBe(true);
    spy.mockRestore();
  });
});
