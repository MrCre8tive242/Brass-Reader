import { createHash, timingSafeEqual } from 'node:crypto';

/** Server-side guards for /api/omr: optional shared passcode, best-effort rate limit, bounded body read. */

export const PASSCODE_HEADER = 'x-app-passcode';

/** True if `APP_PASSCODE` is set (then every POST must carry a matching X-App-Passcode header). */
export function passcodeRequired(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.APP_PASSCODE;
}

function digest(s: string): Buffer { return createHash('sha256').update(s).digest(); }

export function passcodeOk(provided: string | null, env: Record<string, string | undefined> = process.env): boolean {
  const want = env.APP_PASSCODE;
  if (!want) return true;
  if (!provided) return false;
  return timingSafeEqual(digest(provided), digest(want));
}

export function clientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim() || 'unknown';
  return headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * In-memory sliding-window limiter. Best effort only: on serverless every instance has its own memory,
 * so this slows down abuse but is not a hard cap (use a platform firewall / KV for that).
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(public max = 10, public windowMs = 10 * 60_000) {}

  check(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterS: number } {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
    return { ok: true };
  }
}

/** Read a request body as text, stopping as soon as it exceeds `maxBytes` (also covers chunked bodies). */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!req.body) return { ok: true, text: '' };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } return { ok: false }; }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return { ok: true, text: new TextDecoder().decode(buf) };
}
