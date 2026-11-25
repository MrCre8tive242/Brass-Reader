import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST, GET, __limiter } from '@/app/api/omr/route';
import { RateLimiter, passcodeOk, clientIp, readBodyLimited } from '@/lib/omrGuard';

const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/';
let n = 0;
function req(body: unknown, headers: Record<string, string> = {}, raw = false) {
  // every request gets its own client IP unless a test wants to share one
  return new Request('http://x/api/omr', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${++n % 250}-${n}`, ...headers },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

const saved = { ...process.env };
beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; delete process.env.AUDIVERIS_URL; delete process.env.APP_PASSCODE; __limiter.max = 10; });
afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

describe('/api/omr request validation', () => {
  it('400 JSON for a null body, arrays, scalars', async () => {
    for (const b of ['null', '[]', '"x"', '5']) {
      const r = await POST(req(b, {}, true));
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ code: 'bad_request' });
    }
  });
  it('400 for invalid JSON and unknown engines', async () => {
    expect((await POST(req('{nope', {}, true))).status).toBe(400);
    for (const engine of ['bogus', 5, null]) {
      const r = await POST(req({ images: [img], engine }));
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ code: 'bad_request' });
    }
  });
  it('valid engines pass validation (then 503 with no key)', async () => {
    for (const engine of ['auto', 'claude', undefined]) {
      expect((await POST(req({ images: [img], engine }))).status).toBe(503);
    }
    expect((await POST(req({ images: [img], engine: 'audiveris' }))).status).toBe(503);
  });
  it('415 for non-JSON content types (blocks cross-site text/plain posts)', async () => {
    const r = await POST(req(JSON.stringify({ images: [img] }), { 'content-type': 'text/plain' }, true));
    expect(r.status).toBe(415);
  });
  it('413 with one consistent code for oversize bodies, by header and by real size', async () => {
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(6_000_000);
    const a = await POST(req({ images: [big] }));
    expect(a.status).toBe(413);
    expect((await a.json()).code).toBe('too_large');
    // lying / missing content-length: the stream itself is counted
    const r = new Request('http://x/api/omr', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '10', 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ images: [big] }) });
    const b = await POST(r);
    expect(b.status).toBe(413);
    expect((await b.json()).code).toBe('too_large');
    // under the body cap but over the image total
    const c = await POST(req({ images: ['data:image/jpeg;base64,' + 'A'.repeat(4_100_000)] }));
    expect(c.status).toBe(413);
    expect((await c.json()).code).toBe('too_large');
  });
});

describe('/api/omr passcode', () => {
  it('is not required unless APP_PASSCODE is set', async () => {
    expect((await POST(req({ images: [img] }))).status).toBe(503);
    expect(await (await GET()).json()).toMatchObject({ passcode: false });
  });
  it('401 without or with a wrong passcode; passes with the right one', async () => {
    process.env.APP_PASSCODE = 'swordfish';
    expect(await (await GET()).json()).toMatchObject({ passcode: true });
    const none = await POST(req({ images: [img] }));
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ code: 'unauthorized' });
    const wrong = await POST(req({ images: [img] }, { 'X-App-Passcode': 'nope' }));
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error).toMatch(/not right/);
    expect((await POST(req({ images: [img] }, { 'X-App-Passcode': 'swordfish' }))).status).toBe(503); // reached the reader
  });
});

describe('/api/omr rate limit', () => {
  it('429 JSON with Retry-After after the per-IP limit', async () => {
    __limiter.max = 3;
    const h = { 'x-forwarded-for': '7.7.7.7' };
    for (let i = 0; i < 3; i++) expect((await POST(req({ images: [img] }, h))).status).toBe(503);
    const r = await POST(req({ images: [img] }, h));
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ code: 'rate_limited' });
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    // other clients are unaffected
    expect((await POST(req({ images: [img] }, { 'x-forwarded-for': '8.8.8.8' }))).status).toBe(503);
  });
});

describe('guards', () => {
  it('RateLimiter slides', () => {
    const l = new RateLimiter(2, 1000);
    expect(l.check('a', 0).ok).toBe(true);
    expect(l.check('a', 10).ok).toBe(true);
    const r = l.check('a', 20);
    expect(r.ok).toBe(false);
    expect(l.check('a', 1005).ok).toBe(true);
  });
  it('passcodeOk / clientIp', () => {
    expect(passcodeOk(null, {})).toBe(true);
    expect(passcodeOk('x', { APP_PASSCODE: 'x' })).toBe(true);
    expect(passcodeOk('y', { APP_PASSCODE: 'x' })).toBe(false);
    expect(passcodeOk(null, { APP_PASSCODE: 'x' })).toBe(false);
    expect(clientIp(new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('1.2.3.4');
    expect(clientIp(new Headers())).toBe('unknown');
  });
  it('readBodyLimited stops at the cap', async () => {
    const r = new Request('http://x', { method: 'POST', body: 'x'.repeat(1000) });
    expect(await readBodyLimited(r, 100)).toEqual({ ok: false });
    const r2 = new Request('http://x', { method: 'POST', body: 'hello' });
    expect(await readBodyLimited(r2, 100)).toEqual({ ok: true, text: 'hello' });
  });
});

import { buildContent } from '@/lib/omrMessage';

describe('/api/omr options', () => {
  it('400 for bad tiles or hints, before anything is sent to a reader', async () => {
    for (const extra of [{ tiles: [2] }, { tiles: 'x' }, { hints: { instrument: 'kazoo' } }, { hints: 'trumpet' }]) {
      const r = await POST(req({ images: [img], ...extra }));
      expect(r.status, JSON.stringify(extra)).toBe(400);
      expect(await r.json()).toMatchObject({ code: 'bad_request' });
    }
  });
  it('good tiles and hints pass validation (then 503 with no key)', async () => {
    expect((await POST(req({ images: [img, img], tiles: [2], hints: { instrument: 'trombone', part: 'Trombone 1' } }))).status).toBe(503);
  });
  it('more than 6 whole pages is refused, 6 pages cut in two is fine', async () => {
    expect((await POST(req({ images: Array(7).fill(img) }))).status).toBe(400);
    expect((await POST(req({ images: Array(12).fill(img), tiles: [2, 2, 2, 2, 2, 2] }))).status).toBe(503);
  });
  it('a file that is not an image is refused with 400', async () => {
    const r = await POST(req({ images: ['data:image/png;base64,' + Buffer.from('#!/bin/sh\necho hello world').toString('base64')] }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/not a readable picture/);
  });
});

describe('message content sent to the reader', () => {
  const png = 'data:image/jpeg;base64,' + Buffer.from('\x89PNG\r\n\x1a\n0000IHDR', 'latin1').toString('base64');
  it('labels every image, uses the real media type, and ends with the instructions', () => {
    const c = buildContent({ images: [img, png, img], tiles: [2, 1], hints: { instrument: 'trumpet' } });
    expect(c.map((b) => b.type)).toEqual(['text', 'image', 'text', 'image', 'text', 'image', 'text']);
    expect(c.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text.split('\n')[0])).toEqual([
      'Page 1 of 2, top part:', 'Page 1 of 2, bottom part:', 'Page 2 of 2:',
      'These are 2 consecutive pages of one piece. Read all of them into one transcription with continuous bar numbers.',
    ]);
    const imgs = c.filter((b) => b.type === 'image') as { source: { media_type: string; data: string }; cache_control?: unknown }[];
    expect(imgs.map((i) => i.source.media_type)).toEqual(['image/jpeg', 'image/png', 'image/jpeg']);
    expect(imgs[0].source.data).toBe(img.split(',')[1]);
    // one cache breakpoint, on the last image
    expect(imgs.map((i) => !!i.cache_control)).toEqual([false, false, true]);
    expect((c[6] as { text: string }).text).toMatch(/written for Bb Trumpet/);
  });
  it('a second look appends its instructions after an identical prefix (so the cache is hit)', () => {
    const a = buildContent({ images: [img] });
    const b = buildContent({ images: [img] }, 'LOOK AGAIN');
    expect(b.slice(0, a.length)).toEqual(a);
    expect(b[b.length - 1]).toEqual({ type: 'text', text: 'LOOK AGAIN' });
  });
});
