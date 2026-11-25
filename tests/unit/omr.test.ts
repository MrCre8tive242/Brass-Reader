import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runOmr, validateImages, type OmrDeps } from '@/lib/omrCore';
import { extractXml } from '@/lib/omrPrompt';

const good = fs.readFileSync(path.join(__dirname, '../fixtures/scale.musicxml'), 'utf8');
const img = 'data:image/jpeg;base64,AAAA';

function deps(over: Partial<OmrDeps> = {}): OmrDeps {
  return {
    hasClaudeKey: true,
    hasAudiveris: false,
    callClaude: vi.fn(async () => good),
    callAudiveris: vi.fn(async () => ({ musicxml: good })),
    ...over,
  };
}

describe('extractXml', () => {
  it('strips fences and chatter', () => {
    expect(extractXml('Here you go:\n```xml\n' + good + '\n```\nDone')).toBe(extractXml(good));
    expect(extractXml('blah ' + good + ' trailing').startsWith('<?xml')).toBe(true);
    expect(extractXml(good).endsWith('</score-partwise>')).toBe(true);
  });
});

describe('validateImages', () => {
  it('accepts data urls and rejects junk', () => {
    expect(validateImages([img])).toBeNull();
    expect(validateImages([])).toMatch(/at least one/);
    expect(validateImages(['http://x/y.png'])).toMatch(/data URLs/);
    expect(validateImages(Array(7).fill(img))).toMatch(/Too many/);
    expect(validateImages(['data:image/png;base64,' + 'A'.repeat(4_100_000)])).toMatch(/too large/);
  });
});

describe('runOmr', () => {
  it('returns 503 with a clear message when no key and no audiveris', async () => {
    const r = await runOmr([img], 'auto', deps({ hasClaudeKey: false }));
    expect(r).toMatchObject({ ok: false, status: 503, code: 'no_key' });
    expect((r as { error: string }).error).toContain('ANTHROPIC_API_KEY');
  });
  it('explicit claude without key is 503', async () => {
    expect(await runOmr([img], 'claude', deps({ hasClaudeKey: false, hasAudiveris: true }))).toMatchObject({ status: 503 });
  });
  it('explicit audiveris without URL is 503', async () => {
    expect(await runOmr([img], 'audiveris', deps())).toMatchObject({ status: 503, code: 'no_audiveris' });
  });
  it('happy path uses claude once', async () => {
    const d = deps();
    const r = await runOmr([img], 'auto', d);
    expect(r).toMatchObject({ ok: true, engine: 'claude' });
    expect(d.callClaude).toHaveBeenCalledTimes(1);
  });
  it('retries once with the parse error, then succeeds', async () => {
    const calls: unknown[] = [];
    const d = deps({
      callClaude: vi.fn(async (_i, retry) => { calls.push(retry); return retry ? good : '<score-partwise><oops'; }),
    });
    const r = await runOmr([img], 'auto', d);
    expect(r).toMatchObject({ ok: true, engine: 'claude' });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ previous: '<score-partwise><oops' });
    expect((calls[1] as { error: string }).error).toMatch(/XML|Not MusicXML/);
  });
  it('falls back to audiveris when claude keeps failing', async () => {
    const d = deps({ hasAudiveris: true, callClaude: vi.fn(async () => 'garbage') });
    const r = await runOmr([img], 'auto', d);
    expect(d.callClaude).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ ok: true, engine: 'audiveris' });
    expect((r as { warnings: string[] }).warnings[0]).toMatch(/valid music/);
  });
  it('falls back when claude throws', async () => {
    const d = deps({ hasAudiveris: true, callClaude: vi.fn(async () => { throw new Error('529 overloaded'); }) });
    expect(await runOmr([img], 'auto', d)).toMatchObject({ ok: true, engine: 'audiveris' });
  });
  it('502 when claude fails and there is no fallback', async () => {
    const d = deps({ callClaude: vi.fn(async () => '<x/>') });
    expect(await runOmr([img], 'auto', d)).toMatchObject({ ok: false, status: 502, code: 'reader_failed' });
  });
  it('rejects audiveris output that is not a score', async () => {
    const d = deps({ hasAudiveris: true, hasClaudeKey: false, callAudiveris: vi.fn(async () => ({ musicxml: '<score-partwise/>' })) });
    expect(await runOmr([img], 'audiveris', d)).toMatchObject({ ok: false, status: 502 });
  });
  it('uses audiveris directly when no key but URL set', async () => {
    const d = deps({ hasClaudeKey: false, hasAudiveris: true });
    const r = await runOmr([img], 'auto', d);
    expect(r).toMatchObject({ ok: true, engine: 'audiveris' });
    expect(d.callClaude).not.toHaveBeenCalled();
  });
});

import { fitToBudget, SHRINK_STEPS, OmrError } from '@/lib/omrClient';
import { parseXml } from '@/lib/musicxml';

describe('fitToBudget (large PDFs / photos)', () => {
  // fake encoder: size grows with pixel area and quality
  const enc = (s: { px: number }, edge: number, q: number) => 'x'.repeat(Math.round((Math.min(edge, s.px) / 2000) ** 2 * q * 700_000));
  it('keeps full quality when it fits', () => {
    const out = fitToBudget([{ px: 2000 }, { px: 2000 }], enc, 3_800_000);
    expect(out.reduce((n, x) => n + x.length, 0)).toBeLessThanOrEqual(3_800_000);
    expect(out[0].length).toBe(Math.round(0.85 * 700_000));
  });
  it('shrinks progressively until six big pages fit', () => {
    const six = Array.from({ length: 6 }, () => ({ px: 2200 }));
    const out = fitToBudget(six, enc, 3_800_000);
    const total = out.reduce((n, x) => n + x.length, 0);
    expect(total).toBeLessThanOrEqual(3_800_000);
    expect(total).toBeGreaterThan(1_000_000); // not shrunk more than needed
    expect(out).toHaveLength(6);
  });
  it('gives up with a too_large error that is not a reader failure', () => {
    try { fitToBudget([{ px: 2000 }], () => 'x'.repeat(5_000_000)); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(OmrError); expect((e as OmrError).code).toBe('too_large'); }
  });
  it('ladder only goes down', () => {
    for (let i = 1; i < SHRINK_STEPS.length; i++) {
      expect(SHRINK_STEPS[i][0]).toBeLessThanOrEqual(SHRINK_STEPS[i - 1][0]);
      expect(SHRINK_STEPS[i][1]).toBeLessThanOrEqual(SHRINK_STEPS[i - 1][1]);
    }
  });
});

describe('XML parse errors', () => {
  it('do not leak the xmldom wrapper text', () => {
    expect(() => parseXml('')).toThrow(/not valid MusicXML/);
    try { parseXml(''); } catch (e) { expect((e as Error).message).not.toMatch(/Reporting|caused Error/); }
  });
});

import { OmrTruncated, OmrUserError, GENERIC_READER_ERROR } from '@/lib/omrCore';

describe('runOmr error handling', () => {
  it('does not leak SDK error text and logs it server-side', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps({ callClaude: vi.fn(async () => { throw new Error('401 invalid x-api-key sk-ant-SECRET req_123'); }) });
    const r = await runOmr([img], 'auto', d);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(r)).not.toMatch(/sk-ant|req_123|x-api-key/);
    expect((r as { error: string }).error).toContain(GENERIC_READER_ERROR);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
  it('shows OmrUserError messages as they are', async () => {
    const d = deps({ callClaude: vi.fn(async () => { throw new OmrUserError('The reader is busy right now.'); }) });
    expect(await runOmr([img], 'auto', d)).toMatchObject({ error: expect.stringContaining('busy') });
  });
  it('truncated output gives a clear too_long error without a pointless retry', async () => {
    const d = deps({ callClaude: vi.fn(async () => { throw new OmrTruncated(); }) });
    const r = await runOmr([img], 'auto', d);
    expect(r).toMatchObject({ ok: false, status: 422, code: 'too_long' });
    expect((r as { error: string }).error).toMatch(/too long/);
    expect(d.callClaude).toHaveBeenCalledTimes(1);
  });
  it('truncated output still falls back to the free reader when configured', async () => {
    const d = deps({ hasAudiveris: true, callClaude: vi.fn(async () => { throw new OmrTruncated(); }) });
    const r = await runOmr([img], 'auto', d);
    expect(r).toMatchObject({ ok: true, engine: 'audiveris' });
    expect((r as { warnings: string[] }).warnings[0]).toMatch(/too long/);
  });
});

import { OMR_SYSTEM_PROMPT, userPrompt } from '@/lib/omrPrompt';

describe('OMR prompt', () => {
  it('asks for WRITTEN pitches and has no contradictory "sounding" wording', () => {
    expect(OMR_SYSTEM_PROMPT).toMatch(/WRITTEN pitches exactly as printed/);
    expect(OMR_SYSTEM_PROMPT).not.toMatch(/sounding/i);
    expect(OMR_SYSTEM_PROMPT).toMatch(/effective alteration of the note AS WRITTEN/);
  });
  it('encodes repeats/endings instead of skipping them', () => {
    expect(OMR_SYSTEM_PROMPT).not.toMatch(/skip repeat/i);
    expect(OMR_SYSTEM_PROMPT).toMatch(/repeat direction="forward"/);
    expect(OMR_SYSTEM_PROMPT).toMatch(/<ending number=/);
    expect(OMR_SYSTEM_PROMPT).toMatch(/dalsegno/);
    expect(OMR_SYSTEM_PROMPT).toMatch(/dacapo/);
  });
  it('covers the missing items from the QA review', () => {
    for (const needle of ['clef-octave-change', 'symbol="cut"', 'symbol="common"', '<grace/>', 'NOT a tie', 'type="start|stop"', 'implicit="yes"', 'measure="yes"', 'top to bottom', 'perspective', 'exactly as printed']) {
      expect(OMR_SYSTEM_PROMPT, needle).toContain(needle);
    }
  });
  it('the example in the prompt is itself valid, bar-correct MusicXML with a repeat', async () => {
    const ex = OMR_SYSTEM_PROMPT.slice(OMR_SYSTEM_PROMPT.lastIndexOf('<?xml'));
    const { validateMusicXml } = await import('@/lib/musicxml');
    const { analyseAndRepair } = await import('@/lib/repair');
    const { buildTimeline } = await import('@/lib/timeline');
    expect(validateMusicXml(ex).ok).toBe(true);
    expect(analyseAndRepair(ex).issues).toEqual([]);
    expect(buildTimeline(ex).order).toEqual([1, 2, 1, 2]);
  });
  it('user prompts ask for exactness and bar checks', () => {
    expect(userPrompt(1)).toMatch(/exactly as printed/);
    expect(userPrompt(3)).toMatch(/consecutive pages/);
  });
});
