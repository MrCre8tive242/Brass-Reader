import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { DEFAULT_OMR_MODEL, OMR_SYSTEM_PROMPT, userPrompt, retryPrompt } from '@/lib/omrPrompt';
import { runOmr, validateImages, MAX_BODY_BYTES, type Engine, type OmrDeps } from '@/lib/omrCore';

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
  const stream = client.messages.stream({
    model: process.env.OMR_MODEL || DEFAULT_OMR_MODEL,
    max_tokens: 64000,
    system: OMR_SYSTEM_PROMPT,
    messages,
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('the model declined this request');
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
  return NextResponse.json({ claude: !!process.env.ANTHROPIC_API_KEY, audiveris: !!process.env.AUDIVERIS_URL });
}

export async function POST(req: Request) {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES * 1.4) {
    return NextResponse.json({ error: 'Images are too large (limit about 4 MB).', code: 'too_large' }, { status: 413 });
  }
  let body: { images?: unknown; engine?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.', code: 'bad_request' }, { status: 400 });
  }
  const bad = validateImages(body.images);
  if (bad) return NextResponse.json({ error: bad, code: 'bad_request' }, { status: bad.includes('large') ? 413 : 400 });
  const engine: Engine = body.engine === 'claude' || body.engine === 'audiveris' ? body.engine : 'auto';

  const deps: OmrDeps = {
    hasClaudeKey: !!process.env.ANTHROPIC_API_KEY,
    hasAudiveris: !!process.env.AUDIVERIS_URL,
    callClaude,
    callAudiveris,
  };
  const r = await runOmr(body.images as string[], engine, deps);
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
  return NextResponse.json({ musicxml: r.musicxml, engine: r.engine, warnings: r.warnings });
}
