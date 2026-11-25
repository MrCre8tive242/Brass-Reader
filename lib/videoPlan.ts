import { windowAt, type BarWindow } from './barWindow';
import { slotAt, type Timeline } from './timeline';
import { countInClicks } from './player';

export type VideoView = 'twobar' | 'full';
export type VideoOrientation = 'portrait' | 'landscape';

export const VIDEO_FPS = 30;
/** Seconds of the last bar's sound dying away that the video keeps showing. */
export const VIDEO_TAIL_S = 1;

export function videoSize(o: VideoOrientation): { width: number; height: number } {
  return o === 'portrait' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

/** Length of the music at `bpm`, seconds (no count-in, no tail). */
export function songSeconds(tl: Timeline, bpm: number): number {
  return (tl.totalQ * 60) / Math.max(1, bpm);
}

/** A count-in before the music: how long it is and when its clicks come (seconds from the start of the video). */
export interface Lead {
  seconds: number;
  /** `n` is the beat that is counted ("1", "2", ...). */
  clicks: { t: number; accent: boolean; n: number }[];
}
export const NO_LEAD: Lead = { seconds: 0, clicks: [] };

/**
 * The player's count-in as the start of a video: one bar of clicks (before a pickup the count runs up to the pickup),
 * numbered the way a band leader counts them.
 */
export function countInLead(tl: Timeline, bpm: number): Lead {
  const raw = countInClicks(tl, tl.order[0] ?? 1);
  if (!raw.length) return NO_LEAD;
  const spq = 60 / Math.max(1, bpm);
  const leadQ = -raw[0].offsetQ;
  const firstAccent = raw.findIndex((c) => c.accent);
  const perBar = raw.filter((c) => c.accent).length > 1 ? raw.findIndex((c, i) => i > firstAccent && c.accent) - firstAccent : raw.length;
  let n = firstAccent > 0 ? perBar - firstAccent : 0;
  const clicks = raw.map((c) => { n = c.accent ? 1 : n + 1; return { t: (leadQ + c.offsetQ) * spq, accent: c.accent, n }; });
  return { seconds: leadQ * spq, clicks };
}

/** Length of the video: a count-in (if any), the music and a short tail. */
export function videoSeconds(tl: Timeline, bpm: number, lead: Lead = NO_LEAD): number {
  return lead.seconds + songSeconds(tl, bpm) + VIDEO_TAIL_S;
}

export function frameCount(seconds: number, fps = VIDEO_FPS): number {
  return Math.max(1, Math.ceil(seconds * fps));
}

/** What frame `k` shows: the time, the position in the music (quarters, play order), the sounding bar and the bar pair. */
export interface FramePos {
  t: number;
  q: number;
  slot: number;
  /** Written bar sounding. */
  bar: number;
  /** Quarters into the sounding bar. */
  offQ: number;
  win: BarWindow;
  /** After the last note: the last bar is held. */
  ended: boolean;
  /** During the count-in: which click was the last one (index into `beats`) and the numbers counted (the first bars wait on screen). */
  count?: { i: number; beats: number[] };
}

export function framePos(tl: Timeline, bpm: number, k: number, fps = VIDEO_FPS, lead: Lead = NO_LEAD): FramePos {
  const t = k / fps;
  if (t < lead.seconds - 1e-9) {
    const w = windowAt(tl, 0, null);
    let i = -1;
    lead.clicks.forEach((c, j) => { if (c.t <= t + 1e-9) i = j; });
    return { t, q: 0, slot: 0, bar: tl.order[0] ?? 1, offQ: 0, win: w, ended: false, count: { i, beats: lead.clicks.map((c) => c.n) } };
  }
  const rawQ = ((t - lead.seconds) * bpm) / 60;
  const ended = rawQ >= tl.totalQ - 1e-9;
  // at and after the end the last bar stays on screen with the line at its end
  const q = ended ? Math.max(0, tl.totalQ - 1e-4) : rawQ;
  const w = windowAt(tl, q, null);
  return { t, q, slot: slotAt(tl, q), bar: tl.order[w.slot] ?? 1, offQ: w.offQ, win: w, ended };
}

/** `<title> - <instrument> - <bpm>bpm.<ext>`, safe as a file name on phones and computers. */
export function videoFileName(title: string, instrument: string, bpm: number, ext: string): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').replace(/\s+/g, ' ').trim();
  const t = clean(title).replace(/^\.+/, '') || 'score';
  const i = clean(instrument) || 'brass';
  return `${t.slice(0, 80).trim()} - ${i} - ${Math.round(bpm)}bpm.${ext}`;
}

/** Rough size of the file in bytes. */
export function estimateBytes(seconds: number, videoBps = VIDEO_BPS, audioBps = AUDIO_BPS): number {
  return Math.round(((videoBps + audioBps) * seconds) / 8);
}
export const VIDEO_BPS = 2_000_000;
export const AUDIO_BPS = 128_000;
/** Above this a phone may run out of memory holding the file. */
export const WARN_BYTES = 200 * 1024 * 1024;
