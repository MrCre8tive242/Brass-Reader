import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { DEFAULT_OMR_MODEL, OMR_SYSTEM_PROMPT } from '@/lib/omrPrompt';
import { buildContent } from '@/lib/omrMessage';
import { runOmr, validateImages, readOptions, MAX_BODY_BYTES, OmrTruncated, OmrUserError, type Engine, type OmrDeps, type OmrRequest } from '@/lib/omrCore';
import { PASSCODE_HEADER, RateLimiter, clientIp, passcodeOk, passcodeRequired, readBodyLimited } from '@/lib/omrGuard';

/**
 * Output ceiling per call. It covers the model's reasoning as well as the reading itself (a page of a brass
 * part is roughly 1-3 thousand tokens of text). Override with OMR_MAX_TOKENS (4000-64000).
 */
const MAX_TOKENS = Math.min(64000, Math.max(4000, Number(process.env.OMR_MAX_TOKENS) || 32000));
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];
const BODY_LIMIT = Math.round(MAX_BODY_BYTES * 1.4);

// best-effort per-IP limit (in memory: per server instance). Defaults to 10 requests / 10 minutes.
const limiter = new RateLimiter(Number(process.env.OMR_RATE_LIMIT) || 10, (Number(process.env.OMR_RATE_WINDOW_MIN) || 10) * 60_000);
/** Exposed for tests. */
export const __limiter = limiter;

export const runtime = 'nodejs';
export const maxDuration = 300;

async function callClaude(req: OmrRequest, followUp?: string): Promise<string> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const effort = EFFORTS.find((e) => e === process.env.OMR_EFFORT) as Effort | undefined;
  let msg: Anthropic.Message;
  try {
    const stream = client.messages.stream({
      model: process.env.OMR_MODEL || DEFAULT_OMR_MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: OMR_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildContent(req, followUp) }],
      ...(effort ? { output_config: { effort } } : {}),
    });
    msg = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError || (e instanceof Anthropic.APIError && e.status === 529)) {
      throw new OmrUserError('The reader is busy right now. Wait a minute and try again.');
    }
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      console.error('[omr] the API key was rejected:', e.status);
      throw new OmrUserError('The reader is not set up correctly (the API key was rejected). Tell the person who runs this app.');
    }
    if (e instanceof Anthropic.APIConnectionError) {
      throw new OmrUserError('The reader could not be reached. Check the connection and try again.');
    }
    throw e;
  }
  const u = msg.usage;
  console.info(`[omr] ${followUp ? 'second look' : 'reading'}: in ${u.input_tokens}, cached ${u.cache_read_input_tokens ?? 0}, out ${u.output_tokens}, stop ${msg.stop_reason}`);
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
  const b = body as { images?: unknown; engine?: unknown; tiles?: unknown; hints?: unknown };
  if (b.engine !== undefined && b.engine !== 'auto' && b.engine !== 'claude' && b.engine !== 'audiveris') {
    return fail(400, "Unknown engine (use 'auto', 'claude' or 'audiveris').", 'bad_request');
  }
  const bad = validateImages(b.images);
  if (bad) return fail(bad.includes('large') ? 413 : 400, bad, bad.includes('large') ? 'too_large' : 'bad_request');
  const opts = readOptions(b, (b.images as string[]).length);
  if (typeof opts === 'string') return fail(400, opts, 'bad_request');
  const engine: Engine = b.engine ?? 'auto';

  const deps: OmrDeps = {
    hasClaudeKey: !!process.env.ANTHROPIC_API_KEY,
    hasAudiveris: !!process.env.AUDIVERIS_URL,
    callClaude,
    callAudiveris,
  };
  const r = await runOmr({ images: b.images as string[], tiles: opts.tiles, hints: opts.hints }, engine, deps);
  if (!r.ok) return fail(r.status, r.error, r.code);
  return NextResponse.json({ musicxml: r.musicxml, engine: r.engine, warnings: r.warnings, flags: r.flags });
}
