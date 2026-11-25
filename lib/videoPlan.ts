import { windowAt, type BarWindow } from './barWindow';
import { slotAt, type Timeline } from './timeline';

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

/** Length of the video: the music and a short tail. */
export function videoSeconds(tl: Timeline, bpm: number): number {
  return songSeconds(tl, bpm) + VIDEO_TAIL_S;
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
}

export function framePos(tl: Timeline, bpm: number, k: number, fps = VIDEO_FPS): FramePos {
  const t = k / fps;
  const rawQ = (t * bpm) / 60;
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
export const VIDEO_BPS = 2_500_000;
export const AUDIO_BPS = 128_000;
/** Above this a phone may run out of memory holding the file. */
export const WARN_BYTES = 200 * 1024 * 1024;
