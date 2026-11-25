import { validateMusicXml } from './musicxml';
import { extractXml, retryPrompt } from './omrPrompt';

/** Thrown by `callClaude` when the model hit its output limit (the XML is cut off and cannot be used). */
export class OmrTruncated extends Error {
  constructor() { super('The reply was cut off at the output limit.'); }
}
/** An error whose message is safe to show to the user as is. Everything else is logged and replaced by a generic text. */
export class OmrUserError extends Error {}

export const GENERIC_READER_ERROR = 'The reader had a problem with this scan. Please try again in a moment.';
export const TOO_LONG_ERROR = 'This music is too long to read in one go. Try one or two pages at a time.';

export type Engine = 'auto' | 'claude' | 'audiveris';

export interface OmrDeps {
  hasClaudeKey: boolean;
  hasAudiveris: boolean;
  /** Calls the model. `retryError` set on the second attempt together with the previous reply. */
  callClaude: (images: string[], retry?: { previous: string; error: string }) => Promise<string>;
  callAudiveris: (images: string[]) => Promise<{ musicxml: string; warnings?: string[] }>;
}

export type OmrResult =
  | { ok: true; status: 200; musicxml: string; engine: 'claude' | 'audiveris'; warnings: string[] }
  | { ok: false; status: number; error: string; code: string };

export const MAX_IMAGES = 6;
export const MAX_BODY_BYTES = 4_000_000;

export function validateImages(images: unknown): string | null {
  if (!Array.isArray(images) || images.length === 0) return 'Send at least one image.';
  if (images.length > MAX_IMAGES) return `Too many pages (max ${MAX_IMAGES}).`;
  for (const im of images) {
    if (typeof im !== 'string' || !/^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(im)) {
      return 'Images must be base64 data URLs (png, jpeg, webp or gif).';
    }
  }
  const total = (images as string[]).reduce((n, s) => n + s.length, 0);
  if (total > MAX_BODY_BYTES) return 'Images are too large (limit about 4 MB in total).';
  return null;
}

type ClaudeResult = { xml: string } | { error: string; truncated?: boolean };

function describeFailure(stage: string, e: unknown): ClaudeResult {
  if (e instanceof OmrTruncated) return { error: TOO_LONG_ERROR, truncated: true };
  if (e instanceof OmrUserError) return { error: e.message };
  console.error(`[omr] ${stage}:`, e); // details stay on the server
  return { error: GENERIC_READER_ERROR };
}

async function viaClaude(images: string[], deps: OmrDeps): Promise<ClaudeResult> {
  let raw: string;
  try {
    raw = await deps.callClaude(images);
  } catch (e) {
    return describeFailure('claude request failed', e);
  }
  let xml = extractXml(raw);
  let v = validateMusicXml(xml);
  if (v.ok) return { xml };
  const firstError = v.error ?? 'invalid MusicXML';
  try {
    raw = await deps.callClaude(images, { previous: raw, error: firstError });
  } catch (e) {
    return describeFailure('claude retry failed', e);
  }
  xml = extractXml(raw);
  v = validateMusicXml(xml);
  if (v.ok) return { xml };
  console.error('[omr] claude returned unusable MusicXML:', v.error);
  return { error: 'The reader could not turn this into valid music. A sharper, straighter photo usually helps.' };
}

export async function runOmr(images: string[], engine: Engine, deps: OmrDeps): Promise<OmrResult> {
  const warnings: string[] = [];
  const wantClaude = engine === 'claude' || engine === 'auto';
  const wantAudiveris = engine === 'audiveris' || engine === 'auto';

  if (engine === 'claude' && !deps.hasClaudeKey) {
    return { ok: false, status: 503, code: 'no_key', error: 'The reader is not set up: add ANTHROPIC_API_KEY in Vercel (Project Settings, Environment Variables).' };
  }
  if (engine === 'audiveris' && !deps.hasAudiveris) {
    return { ok: false, status: 503, code: 'no_audiveris', error: 'The free reader is not set up (AUDIVERIS_URL is not configured).' };
  }
  if (engine === 'auto' && !deps.hasClaudeKey && !deps.hasAudiveris) {
    return { ok: false, status: 503, code: 'no_key', error: 'The reader is not set up: add ANTHROPIC_API_KEY in Vercel (Project Settings, Environment Variables).' };
  }

  let claudeError: string | null = null;
  if (wantClaude && deps.hasClaudeKey) {
    const r = await viaClaude(images, deps);
    if ('xml' in r) return { ok: true, status: 200, musicxml: r.xml, engine: 'claude', warnings };
    claudeError = r.error;
    warnings.push(r.error);
    if ('truncated' in r && r.truncated && !(wantAudiveris && deps.hasAudiveris)) {
      return { ok: false, status: 422, code: 'too_long', error: r.error };
    }
  } else if (engine === 'auto') {
    warnings.push('No ANTHROPIC_API_KEY configured; using the free reader.');
  }

  if (wantAudiveris && deps.hasAudiveris) {
    try {
      const a = await deps.callAudiveris(images);
      const v = validateMusicXml(a.musicxml);
      if (!v.ok) throw new Error(v.error);
      return { ok: true, status: 200, musicxml: a.musicxml, engine: 'audiveris', warnings: [...warnings, ...(a.warnings ?? [])] };
    } catch (e) {
      console.error('[omr] free reader failed:', e);
      return { ok: false, status: 502, code: 'reader_failed', error: `${claudeError ? 'Both readers failed. ' + claudeError + ' ' : 'The free reader could not read this. '}Try a sharper photo or open a MusicXML file.` };
    }
  }
  return { ok: false, status: 502, code: 'reader_failed', error: claudeError ?? 'Reader failed.' };
}

export { retryPrompt };
