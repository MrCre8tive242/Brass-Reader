import { validateMusicXml } from './musicxml';
import { extractXml, retryPrompt, fixBarsPrompt, cleanPartHint, NOT_MUSIC, type BarProblem, type OmrHints } from './omrPrompt';
import { analyseAndRepair, type RepairResult } from './repair';
import { parseNotation, notationToMusicXml, mergeCorrections, mergeStripReadings, barCount, type NScore } from './omrNotation';
import { isInstrumentId } from './instruments';

/** Thrown by `callClaude` when the model hit its output limit (the reading is cut off and cannot be used). */
export class OmrTruncated extends Error {
  constructor() { super('The reply was cut off at the output limit.'); }
}
/** An error whose message is safe to show to the user as is. Everything else is logged and replaced by a generic text. */
export class OmrUserError extends Error {}

export const GENERIC_READER_ERROR = 'The reader had a problem with this scan. Please try again in a moment.';
export const TOO_LONG_ERROR = 'This music is too long to read in one go. Try one or two pages at a time.';
export const UNUSABLE_ERROR = 'The reader could not turn this into valid music. A sharper, straighter photo usually helps.';

export type Engine = 'auto' | 'claude' | 'audiveris';

/** What the client sent, after validation. */
export interface OmrRequest {
  images: string[];
  /** How many images each page was cut into (top to bottom); absent = one image per page. */
  tiles?: number[];
  hints?: OmrHints;
  /** Set on the single-strip requests of a parallel reading: this image is part `index` of `count` of the piece (1-based). */
  part?: { index: number; count: number };
}

export interface OmrDeps {
  hasClaudeKey: boolean;
  hasAudiveris: boolean;
  /** Calls the model. `followUp` is set on the second attempt (a fresh request with extra instructions). */
  callClaude: (req: OmrRequest, followUp?: string) => Promise<string>;
  callAudiveris: (images: string[]) => Promise<{ musicxml: string; warnings?: string[] }>;
  /** Clock (tests). */
  now?: () => number;
}

/**
 * A second look is only started if the first reading came back within this time: the whole request must
 * finish inside the server's 300 s limit, and a usable reading with a few flagged bars beats a timeout.
 */
export const SECOND_LOOK_BUDGET_MS = 140_000;

/** A bar the reader itself was unsure about. `bar` is the printed bar label. */
export interface OmrFlag { bar: string; text: string }

export type OmrResult =
  | { ok: true; status: 200; musicxml: string; engine: 'claude' | 'audiveris'; warnings: string[]; flags: OmrFlag[] }
  | { ok: false; status: number; error: string; code: string };

/** Up to 6 pages, but only up to 3 are cut into strips (at most 4 each), so 12 images is the hard cap. */
export const MAX_IMAGES = 12;
/** Most strips of a piece that are read at the same time, one model call each. */
export const PARALLEL_MAX = 8;
/** Largest number of strips one page may be cut into. */
export const MAX_TILES = 4;
/** If the parallel reading failed after this long, there is no time left for the single-call fallback. */
export const FALLBACK_BUDGET_MS = 120_000;
export const MAX_PAGES = 6;
export const MAX_BODY_BYTES = 4_000_000;

export type ImageMedia = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** Real type of a base64 data URL from its first bytes (the declared type can be wrong), or null if it is not an image. */
export function sniffImage(dataUrl: string): ImageMedia | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  let head: Buffer;
  try { head = Buffer.from(dataUrl.slice(comma + 1, comma + 25), 'base64'); } catch { return null; }
  if (head.length < 12) return null;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (head.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  return null;
}

export function validateImages(images: unknown): string | null {
  if (!Array.isArray(images) || images.length === 0) return 'Send at least one image.';
  if (images.length > MAX_IMAGES) return `Too many pages (max ${MAX_PAGES}).`;
  for (const im of images) {
    if (typeof im !== 'string' || !/^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(im)) {
      return 'Images must be base64 data URLs (png, jpeg, webp or gif).';
    }
  }
  const total = (images as string[]).reduce((n, s) => n + s.length, 0);
  if (total > MAX_BODY_BYTES) return 'Images are too large (limit about 4 MB in total).';
  for (const im of images as string[]) {
    if (!sniffImage(im) || !/^[A-Za-z0-9+/]+={0,2}$/.test(im.slice(im.indexOf(',') + 1))) return 'One of the images is not a readable picture.';
  }
  return null;
}

/** Validate the optional parts of the request body. Returns an error text, or the cleaned values. */
export function readOptions(body: { tiles?: unknown; hints?: unknown }, imageCount: number): string | { tiles?: number[]; hints: OmrHints } {
  let tiles: number[] | undefined;
  if (body.tiles !== undefined) {
    if (!Array.isArray(body.tiles) || body.tiles.length > MAX_PAGES || body.tiles.some((n) => !Number.isInteger(n) || n < 1 || n > MAX_TILES)
      || (body.tiles as number[]).reduce((a, n) => a + n, 0) !== imageCount) return 'tiles must list how many images each page has.';
    tiles = body.tiles as number[];
  } else if (imageCount > MAX_PAGES) return `Too many pages (max ${MAX_PAGES}).`;
  const hints: OmrHints = {};
  if (body.hints !== undefined) {
    if (!body.hints || typeof body.hints !== 'object' || Array.isArray(body.hints)) return 'hints must be an object.';
    const h = body.hints as { instrument?: unknown; part?: unknown };
    if (h.instrument !== undefined && h.instrument !== null) {
      if (!isInstrumentId(h.instrument)) return 'Unknown instrument in hints.';
      hints.instrument = h.instrument;
    }
    if (h.part !== undefined && h.part !== null) {
      if (typeof h.part !== 'string' || h.part.length > 200) return 'hints.part must be a short text.';
      const part = cleanPartHint(h.part);
      if (part) hints.part = part;
    }
  }
  return { tiles, hints };
}

type Reading =
  | { kind: 'notation'; score: NScore; text: string }
  | { kind: 'xml'; xml: string }
  | { kind: 'not_music'; reason: string }
  | { kind: 'invalid'; error: string };

/** Work out what a reply is: the text format, MusicXML (older readers), a "not music" answer, or unusable. */
export function interpretReply(raw: string): Reading {
  const text = raw.replace(/\r/g, '').trim();
  const nm = text.match(new RegExp(`^\\W*${NOT_MUSIC}\\b[\\s:.,-]*([^\\n]*)`));
  if (nm) return { kind: 'not_music', reason: nm[1].replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) };
  if (text.includes('<score-partwise')) return { kind: 'xml', xml: extractXml(text) };
  const score = parseNotation(text);
  if (barCount(score) === 0) return { kind: 'invalid', error: 'no bar lines were found in the reply' };
  return { kind: 'notation', score, text: text.replace(/^```[a-z]*\n?|```$/gm, '').trim().slice(0, 60_000) };
}

interface Evaluated {
  xml: string;
  warnings: string[];
  flags: OmrFlag[];
  /** Bars worth a second look by the reader. */
  problems: BarProblem[];
}

const fmtQ = (n: number) => String(Math.round(n * 100) / 100);

function sumProblem(i: RepairResult['issues'][number]): string {
  return i.kind === 'empty'
    ? 'the bar is empty'
    : `the values add up to ${fmtQ(i.haveQ)} quarter notes, but the time signature needs ${fmtQ(i.wantQ)}`;
}

/** Turn a reading into MusicXML and list what is doubtful about it. Returns null if it holds no music. */
export function evaluate(r: Extract<Reading, { kind: 'notation' | 'xml' }>): Evaluated | null {
  if (r.kind === 'xml') {
    if (!validateMusicXml(r.xml).ok) return null;
    const rep = analyseAndRepair(r.xml);
    return { xml: rep.xml, warnings: rep.warnings, flags: [], problems: rep.issues.map((i) => ({ label: i.label, what: sumProblem(i) })) };
  }
  const conv = notationToMusicXml(r.score);
  if (!validateMusicXml(conv.xml).ok) return null;
  const rep = analyseAndRepair(conv.xml);
  const many = r.score.parts.length > 1;
  const problems: BarProblem[] = rep.issues.map((i) => {
    const part = r.score.parts[i.part];
    return { part: many ? part?.name || `part ${i.part + 1}` : undefined, label: i.label, raw: part?.bars[i.measure - 1]?.raw, what: sumProblem(i) };
  });
  const warnings = [...conv.warnings, ...rep.warnings];
  r.score.parts.forEach((part, pi) => part.bars.forEach((b) => {
    if (!b.problems.length) return;
    const label = b.label === '0' ? 'Pickup' : b.label;
    problems.push({ part: many ? part.name || `part ${pi + 1}` : undefined, label: b.label, raw: b.raw, what: b.problems.join('; ') });
    warnings.push(`${label === 'Pickup' ? 'The pickup bar' : `Bar ${label}`} may be incomplete (part of it could not be read).`);
  }));
  const flags: OmrFlag[] = [];
  for (const n of r.score.notes) {
    const label = n.bar === '0' ? 'Pickup' : n.bar;
    flags.push({ bar: label, text: n.text });
    warnings.push(label ? `${label === 'Pickup' ? 'Pickup bar' : `Bar ${label}`}: the reader was not sure${n.text ? ` (${n.text.replace(/[.\s]+$/, '')})` : ''}.` : `The reader noted: ${n.text}`);
  }
  return { xml: rep.xml, warnings, flags, problems };
}

type ClaudeResult =
  | { xml: string; warnings: string[]; flags: OmrFlag[] }
  | { error: string; truncated?: boolean; notMusic?: boolean };

function describeFailure(stage: string, e: unknown): ClaudeResult {
  if (e instanceof OmrTruncated) return { error: TOO_LONG_ERROR, truncated: true };
  if (e instanceof OmrUserError) return { error: e.message };
  console.error(`[omr] ${stage}:`, e); // details stay on the server
  return { error: GENERIC_READER_ERROR };
}

function notMusic(reason: string): ClaudeResult {
  return { error: `That picture does not look like sheet music${reason ? ` (${reason.replace(/[.\s]+$/, '')})` : ''}. Try another photo.`, notMusic: true };
}

/** Whether a request is read as separate strips at the same time (not when the player asked for one part of several instruments). */
export function canReadInParallel(req: OmrRequest): boolean {
  return req.images.length >= 2 && req.images.length <= PARALLEL_MAX && !req.hints?.part && !req.part;
}

/**
 * Read every strip with its own model call at the same time and join the replies into one reading.
 * Null when any call fails or any reply is unusable (the caller then reads everything in one call).
 */
async function readInParallel(req: OmrRequest, deps: OmrDeps): Promise<string | null> {
  const count = req.images.length;
  const replies = await Promise.all(req.images.map((image, i) =>
    deps.callClaude({ images: [image], tiles: [1], hints: req.hints, part: { index: i + 1, count } })));
  const texts: string[] = [];
  for (const raw of replies) {
    const r = interpretReply(raw);
    if (r.kind !== 'notation') return null;
    texts.push(r.text);
  }
  return mergeStripReadings(texts);
}

/** At most two model calls per scan: the reading, then one second look (targeted at the bars that fail the check). */
async function viaClaude(req: OmrRequest, deps: OmrDeps): Promise<ClaudeResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  let raw: string | null = null;
  if (canReadInParallel(req)) {
    try {
      raw = await readInParallel(req, deps);
    } catch (e) {
      console.error('[omr] reading the strips at once failed:', e);
      if (now() - t0 > FALLBACK_BUDGET_MS) return describeFailure('claude request failed', e);
    }
    if (raw === null) {
      if (now() - t0 > FALLBACK_BUDGET_MS) return { error: UNUSABLE_ERROR };
      console.info('[omr] strips could not be joined: reading everything in one call');
    }
  }
  if (raw === null) {
    try {
      raw = await deps.callClaude(req);
    } catch (e) {
      return describeFailure('claude request failed', e);
    }
  }
  let reading = interpretReply(raw);
  if (reading.kind === 'not_music') return notMusic(reading.reason);
  let first = reading.kind === 'invalid' ? null : evaluate(reading);
  if (!first) {
    // nothing usable: one full second attempt
    const why = reading.kind === 'invalid' ? reading.error : 'it contained no notes';
    try {
      raw = await deps.callClaude(req, retryPrompt(why));
    } catch (e) {
      return describeFailure('claude retry failed', e);
    }
    reading = interpretReply(raw);
    if (reading.kind === 'not_music') return notMusic(reading.reason);
    first = reading.kind === 'invalid' ? null : evaluate(reading);
    if (!first) {
      console.error('[omr] claude returned an unusable reading twice');
      return { error: UNUSABLE_ERROR };
    }
    return first;
  }
  if (first.problems.length === 0) return first;
  if (now() - t0 > SECOND_LOOK_BUDGET_MS) {
    console.info('[omr] first reading was slow: skipping the second look');
    return first;
  }

  // some bars fail the check: ask for a second look at exactly those bars
  let best = first;
  try {
    if (reading.kind === 'notation') {
      const fix = await deps.callClaude(req, fixBarsPrompt(reading.text, first.problems));
      // the reply holds only corrected lines (and maybe a corrected header): merge them into the first reading
      const merged: NScore = structuredClone(reading.score);
      const changed = fix.includes('<score-partwise') ? 0 : mergeCorrections(merged, fix);
      const second = changed || /^\s*(time|key|clef)\s*[:=]/im.test(fix) ? evaluate({ kind: 'notation', score: merged, text: reading.text }) : null;
      if (second && second.problems.length <= first.problems.length) best = second;
    } else {
      const bars = first.problems.map((p) => p.label).join(', ');
      const raw2 = await deps.callClaude(req, retryPrompt(`bars ${bars} do not add up to the time signature. Re-read those bars against the image and check every note value, dot, rest and tie`));
      const again = interpretReply(raw2);
      const second = again.kind === 'notation' || again.kind === 'xml' ? evaluate(again) : null;
      if (second && second.problems.length <= first.problems.length) best = second;
    }
  } catch (e) {
    // the first reading was usable: keep it (padded) and flag the bars rather than failing the scan
    console.error('[omr] claude second look failed:', e);
  }
  return best;
}

export async function runOmr(req: OmrRequest, engine: Engine, deps: OmrDeps): Promise<OmrResult> {
  const images = req.images;
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
    const r = await viaClaude(req, deps);
    if ('xml' in r) return { ok: true, status: 200, musicxml: r.xml, engine: 'claude', warnings: [...warnings, ...r.warnings], flags: r.flags };
    if (r.notMusic) return { ok: false, status: 422, code: 'not_music', error: r.error };
    claudeError = r.error;
    warnings.push(r.error);
    if (r.truncated && !(wantAudiveris && deps.hasAudiveris)) {
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
      const rep = analyseAndRepair(a.musicxml);
      return { ok: true, status: 200, musicxml: rep.xml, engine: 'audiveris', warnings: [...warnings, ...(a.warnings ?? []), ...rep.warnings], flags: [] };
    } catch (e) {
      console.error('[omr] free reader failed:', e);
      return { ok: false, status: 502, code: 'reader_failed', error: `${claudeError ? 'Both readers failed. ' + claudeError + ' ' : 'The free reader could not read this. '}Try a sharper photo or open a MusicXML file.` };
    }
  }
  return { ok: false, status: 502, code: 'reader_failed', error: claudeError ?? 'Reader failed.' };
}

export { retryPrompt };
