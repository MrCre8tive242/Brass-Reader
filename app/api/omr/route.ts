import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { DEFAULT_OMR_MODEL, OMR_SYSTEM_PROMPT, userPrompt, retryPrompt } from '@/lib/omrPrompt';
import { runOmr, validateImages, MAX_BODY_BYTES, OmrTruncated, OmrUserError, type Engine, type OmrDeps } from '@/lib/omrCore';
import { PASSCODE_HEADER, RateLimiter, clientIp, passcodeOk, passcodeRequired, readBodyLimited } from '@/lib/omrGuard';

/** Output ceiling for one part (a 48-bar single line is well under this). Override with OMR_MAX_TOKENS (cap 32000). */
const MAX_TOKENS = Math.min(32000, Math.max(2000, Number(process.env.OMR_MAX_TOKENS) || 16000));
const BODY_LIMIT = Math.round(MAX_BODY_BYTES * 1.4);

// best-effort per-IP limit (in memory: per server instance). Defaults to 10 requests / 10 minutes.
const limiter = new RateLimiter(Number(process.env.OMR_RATE_LIMIT) || 10, (Number(process.env.OMR_RATE_WINDOW_MIN) || 10) * 60_000);
/** Exposed for tests. */
export const __limiter = limiter;

export const runtime = 'nodejs';
export const maxDuration = 300;

type ImageMedia = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

function imageBlocks(images: string[]): Anthropic.ImageBlockParam[] {
  return images.map((url) => {
    const m = url.match(/^data:(image\/[a-z]+);base64,(.*)$/s)!;
    const media = (m[1] === 'image/jpg' ? 'image/jpeg' : m[1]) as ImageMedia;
    return { type: 'image', source: { type: 'base64', media_type: media, data: m[2] } };
  });
}

async function callClaude(images: string[], retry?: { previous: string; error: string }): Promise<string> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: [...imageBlocks(images), { type: 'text', text: userPrompt(images.length) }] },
  ];
  if (retry) {
    messages.push({ role: 'assistant', content: retry.previous });
    messages.push({ role: 'user', content: retryPrompt(retry.error) });
  }
  let msg: Anthropic.Message;
  try {
    const stream = client.messages.stream({
      model: process.env.OMR_MODEL || DEFAULT_OMR_MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: OMR_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages,
    });
    msg = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.APIError && (e.status === 429 || e.status === 529)) {
      throw new OmrUserError('The reader is busy right now. Wait a minute and try again.');
    }
    throw e;
  }
  if (msg.stop_reason === 'refusal') throw new OmrUserError('The reader declined this image. Try another photo.');
  if (msg.stop_reason === 'max_tokens') throw new OmrTruncated();
  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

async function callAudiveris(images: string[]): Promise<{ musicxml: string; warnings?: string[] }> {
  const base = process.env.AUDIVERIS_URL!.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.OMR_TOKEN) headers['X-OMR-Token'] = process.env.OMR_TOKEN;
  const res = await fetch(`${base}/omr`, { method: 'POST', headers, body: JSON.stringify({ images }) });
  const json = (await res.json().catch(() => ({}))) as { musicxml?: string; warnings?: string[]; error?: string };
  if (!res.ok || !json.musicxml) throw new Error(json.error || `HTTP ${res.status}`);
  return { musicxml: json.musicxml, warnings: json.warnings };
}

/** What this deployment can do (no secrets): lets the UI hide buttons for readers that are not configured. */
export async function GET() {
  return NextResponse.json({ claude: !!process.env.ANTHROPIC_API_KEY, audiveris: !!process.env.AUDIVERIS_URL, passcode: passcodeRequired() });
}

function fail(status: number, error: string, code: string, headers?: Record<string, string>) {
  return NextResponse.json({ error, code }, { status, headers });
}

export async function POST(req: Request) {
  const rl = limiter.check(clientIp(req.headers));
  if (!rl.ok) {
    return fail(429, 'Too many scans from this connection. Please wait a few minutes and try again.', 'rate_limited',
      { 'Retry-After': String(rl.retryAfterS) });
  }
  if (!passcodeOk(req.headers.get(PASSCODE_HEADER))) {
    return fail(401, req.headers.get(PASSCODE_HEADER) ? 'That passcode is not right.' : 'A passcode is needed to use the reader.', 'unauthorized');
  }
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return fail(415, 'Send JSON (Content-Type: application/json).', 'bad_request');
  }
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > BODY_LIMIT) return fail(413, 'Images are too large (limit about 4 MB).', 'too_large');
  const raw = await readBodyLimited(req, BODY_LIMIT); // the header can lie or be absent (chunked): count real bytes
  if (!raw.ok) return fail(413, 'Images are too large (limit about 4 MB).', 'too_large');
  let body: unknown;
  try {
    body = JSON.parse(raw.text);
  } catch {
    return fail(400, 'Invalid JSON body.', 'bad_request');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Send a JSON object with an images array.', 'bad_request');
  const b = body as { images?: unknown; engine?: unknown };
  if (b.engine !== undefined && b.engine !== 'auto' && b.engine !== 'claude' && b.engine !== 'audiveris') {
    return fail(400, "Unknown engine (use 'auto', 'claude' or 'audiveris').", 'bad_request');
  }
  const bad = validateImages(b.images);
  if (bad) return fail(bad.includes('large') ? 413 : 400, bad, bad.includes('large') ? 'too_large' : 'bad_request');
  const engine: Engine = b.engine ?? 'auto';

  const deps: OmrDeps = {
    hasClaudeKey: !!process.env.ANTHROPIC_API_KEY,
    hasAudiveris: !!process.env.AUDIVERIS_URL,
    callClaude,
    callAudiveris,
  };
  const r = await runOmr(b.images as string[], engine, deps);
  if (!r.ok) return fail(r.status, r.error, r.code);
  return NextResponse.json({ musicxml: r.musicxml, engine: r.engine, warnings: r.warnings });
}
