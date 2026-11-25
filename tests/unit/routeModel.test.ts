/**
 * Plumbing only: the SDK is replaced by a fake, so these tests show what the route SENDS and how it treats
 * each kind of reply. They say nothing about how well a real model reads music.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const calls: Record<string, unknown>[] = [];
let next: Array<() => unknown> = [];

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error { status?: number; constructor(status?: number, m = 'api error') { super(m); this.status = status; } }
  class RateLimitError extends APIError { constructor() { super(429, 'rate limited'); } }
  class AuthenticationError extends APIError { constructor() { super(401, 'invalid x-api-key sk-ant-SECRET'); } }
  class PermissionDeniedError extends APIError { constructor() { super(403); } }
  class APIConnectionError extends APIError { constructor() { super(undefined, 'connection'); } }
  class Anthropic {
    static APIError = APIError; static RateLimitError = RateLimitError; static AuthenticationError = AuthenticationError;
    static PermissionDeniedError = PermissionDeniedError; static APIConnectionError = APIConnectionError;
    messages = {
      stream: (params: Record<string, unknown>) => {
        calls.push(params);
        const f = next.shift();
        return { finalMessage: async () => { if (!f) throw new Error('no reply queued'); return f(); } };
      },
    };
  }
  return { default: Anthropic };
});

import Anthropic from '@anthropic-ai/sdk';
import { POST, __limiter, __daily } from '@/app/api/omr/route';
import { OMR_SYSTEM_PROMPT } from '@/lib/omrPrompt';
import { buildTimeline } from '@/lib/timeline';

const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/';
let n = 0;
const req = (body: unknown) => new Request('http://x/api/omr', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${++n}.1` }, body: JSON.stringify(body) });
const msg = (text: string, stop_reason = 'end_turn') => () => ({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }], stop_reason, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } });
const good = 'title: Tune\nclef: treble\nkey: 1b\ntime: 4/4\n1: F4:q G4:q A4:q B4:q\n2: C5:w';

const saved = { ...process.env };
beforeEach(() => {
  calls.length = 0; next = [];
  process.env.ANTHROPIC_API_KEY = 'test-key'; delete process.env.AUDIVERIS_URL; delete process.env.APP_PASSCODE; delete process.env.OMR_MODEL; delete process.env.OMR_EFFORT;
  __limiter.max = 1000; __daily.max = 100000;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

describe('/api/omr with a (fake) model', () => {
  it('sends one streamed request: default model, cached system prompt, labelled images, hints, no sampling or thinking parameters', async () => {
    next = [msg(good)];
    const r = await POST(req({ images: [img, img], tiles: [2], hints: { instrument: 'trombone', part: 'Trombone 1' } }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ engine: 'claude', warnings: [], flags: [] });
    expect(buildTimeline(j.musicxml).events.map((e: { midi: number }) => e.midi)).toEqual([65, 67, 69, 70, 72]);
    expect(calls).toHaveLength(1);
    const p = calls[0] as { model: string; max_tokens: number; system: { text: string; cache_control?: unknown }[]; messages: { role: string; content: { type: string; text?: string }[] }[] };
    expect(p.model).toBe('claude-sonnet-5-5');
    expect(p.max_tokens).toBe(32000);
    expect(p.system).toEqual([{ type: 'text', text: OMR_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0].role).toBe('user');
    expect(p.messages[0].content.map((b) => b.type)).toEqual(['text', 'image', 'text', 'image', 'text']);
    expect(p.messages[0].content[0].text).toBe('The page, top part:');
    expect(p.messages[0].content[4].text).toMatch(/written for Trombone[\s\S]*only needs the part for "Trombone 1"/);
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking', 'output_config', 'tool_choice']) expect(p).not.toHaveProperty(k);
  });
  it('OMR_MODEL and OMR_EFFORT are passed through; an unknown effort is ignored', async () => {
    process.env.OMR_MODEL = 'some-other-model';
    process.env.OMR_EFFORT = 'xhigh';
    next = [msg(good), msg(good)];
    await POST(req({ images: [img] }));
    expect(calls[0]).toMatchObject({ model: 'some-other-model', output_config: { effort: 'xhigh' } });
    process.env.OMR_EFFORT = 'ludicrous';
    await POST(req({ images: [img] }));
    expect(calls[1]).not.toHaveProperty('output_config');
  });
  it('a second look is a fresh single-turn request with the same images plus the bars to fix (no replayed assistant turn)', async () => {
    next = [msg(good.replace('2: C5:w', '2: C5:h\n3: C5:w')), msg('2: C5:h A4:h')];
    const r = await POST(req({ images: [img] }));
    const j = await r.json();
    expect(j.warnings).toEqual([]);
    expect(calls).toHaveLength(2);
    const [a, b] = calls as { messages: { role: string; content: { type: string; text?: string }[] }[] }[];
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0].content.slice(0, a.messages[0].content.length)).toEqual(a.messages[0].content);
    expect(b.messages[0].content.at(-1)!.text).toMatch(/bar 2 \(read as: C5:h\)/);
  });
  it('a cut-off reply is "too long", a refusal and a busy API are said plainly, and nothing secret leaks', async () => {
    next = [msg('1: C4:q', 'max_tokens')];
    let r = await POST(req({ images: [img] }));
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ code: 'too_long' });

    next = [msg('', 'refusal')];
    r = await POST(req({ images: [img] }));
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/declined this image/);

    next = [() => { throw new (Anthropic as unknown as { RateLimitError: new () => Error }).RateLimitError(); }];
    r = await POST(req({ images: [img] }));
    expect((await r.json()).error).toMatch(/busy right now/);

    next = [() => { throw new (Anthropic as unknown as { AuthenticationError: new () => Error }).AuthenticationError(); }];
    r = await POST(req({ images: [img] }));
    const body = JSON.stringify(await r.json());
    expect(body).toMatch(/API key was rejected/);
    expect(body).not.toMatch(/sk-ant|x-api-key/);

    next = [() => { throw new Error('socket hang up at 10.1.2.3 req_abc'); }];
    r = await POST(req({ images: [img] }));
    expect(JSON.stringify(await r.json())).not.toMatch(/socket|10\.1\.2\.3|req_abc/);
  });
  it('"not music" comes back as 422 not_music', async () => {
    next = [msg('NOT_MUSIC: a photo of a drum.')];
    const r = await POST(req({ images: [img] }));
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'That picture does not look like sheet music (a photo of a drum). Try another photo.', code: 'not_music' });
  });
  it('a model that answers in MusicXML is still accepted', async () => {
    const xml = (await import('node:fs')).readFileSync(new URL('../fixtures/scale.musicxml', import.meta.url), 'utf8');
    next = [msg('```xml\n' + xml + '\n```')];
    const r = await POST(req({ images: [img] }));
    expect(r.status).toBe(200);
    expect((await r.json()).musicxml).toContain('<score-partwise');
  });
});
