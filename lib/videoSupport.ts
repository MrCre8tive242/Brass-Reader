/**
 * Which way this browser can make the video file, and how the finished file is best handed to the person.
 * Everything here is decided from a few yes/no questions about the browser (`Probes`), so it can be tested without one.
 */

export interface VideoCfg { codec: string; width: number; height: number; framerate: number; bitrate: number; avc?: { format: 'avc' } }
export interface AudioCfg { codec: string; sampleRate: number; numberOfChannels: number; bitrate: number }

export type Route =
  /** H.264 picture in an MP4, made faster than real time. `audio` says which sound codec is inside. */
  | { kind: 'mp4'; audio: 'aac' | 'opus'; v: VideoCfg; a: AudioCfg }
  /** VP9 / VP8 + Opus in a WebM, made faster than real time. */
  | { kind: 'webm'; vcodec: 'V_VP9' | 'V_VP8'; v: VideoCfg; a: AudioCfg }
  /** Recorded while it plays (as long as the song). */
  | { kind: 'realtime'; mime: string; ext: 'mp4' | 'webm' }
  | { kind: 'none' };

export interface Probes {
  /** Can a picture be encoded this way without playing it? (WebCodecs VideoEncoder) */
  video: (c: VideoCfg) => Promise<boolean>;
  /** Can sound be encoded this way without playing it? (WebCodecs AudioEncoder) */
  audio: (c: AudioCfg) => Promise<boolean>;
  /** Can the browser record a playing canvas to this type? (MediaRecorder + canvas.captureStream) */
  recorder: (mime: string) => boolean;
  /** iPhone, iPad or a Mac: Photos and the share sheet want MP4 there, and WebM is of little use. */
  apple: boolean;
}

/**
 * H.264 settings to try, most widely playable first. Level 4.0 is the lowest that holds 1080p at 30 pictures a second;
 * some encoders only take the level they would pick themselves, hence the higher ones.
 */
export const AVC_CODECS = ['avc1.640028', 'avc1.64002A', 'avc1.4D4028', 'avc1.42E028', 'avc1.640032', 'avc1.4D0032', 'avc1.420032'];
/** MediaRecorder types, MP4 first. */
export const RECORDER_MP4 = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
export const RECORDER_WEBM = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export interface RouteOptions { fps: number; videoBps: number; audioBps: number }

/**
 * The best way to make a `width` x `height` video here.
 *
 * 1. MP4 with H.264 + AAC, faster than real time: plays everywhere, saves to Photos, WhatsApp takes it.
 * 2. On Apple devices without an AAC encoder (iPhones before iOS 26 have no AudioEncoder at all): record in real time
 *    with MediaRecorder, which makes a proper MP4 (H.264 + AAC) there. Slow, but a file Photos accepts.
 * 3. MP4 with H.264 + Opus, faster than real time (e.g. Chrome on Linux). Plays in browsers and on Android.
 * 4. WebM (VP9 / VP8 + Opus), faster than real time.
 * 5. Real-time recording, MP4 if the browser can, else WebM.
 */
export async function chooseRoute(width: number, height: number, p: Probes, o: RouteOptions): Promise<Route> {
  const base = { width, height, framerate: o.fps, bitrate: o.videoBps };
  let avc: VideoCfg | null = null;
  for (const codec of AVC_CODECS) {
    const v: VideoCfg = { ...base, codec, avc: { format: 'avc' } };
    if (await p.video(v)) { avc = v; break; }
  }
  const audioOf = async (codec: string, rates: number[]): Promise<AudioCfg | null> => {
    for (const sampleRate of rates) {
      const a: AudioCfg = { codec, sampleRate, numberOfChannels: 2, bitrate: o.audioBps };
      if (await p.audio(a)) return a;
    }
    return null;
  };
  const mp4Rec = RECORDER_MP4.find((t) => p.recorder(t));
  const webmRec = RECORDER_WEBM.find((t) => p.recorder(t));
  if (avc) {
    const aac = await audioOf('mp4a.40.2', [48000, 44100]);
    if (aac) return { kind: 'mp4', audio: 'aac', v: avc, a: aac };
  }
  if (p.apple && mp4Rec) return { kind: 'realtime', mime: mp4Rec, ext: 'mp4' };
  const opus = await audioOf('opus', [48000]);
  if (avc && opus) return { kind: 'mp4', audio: 'opus', v: avc, a: opus };
  if (opus) {
    for (const [codec, vcodec] of [['vp09.00.40.08', 'V_VP9'], ['vp8', 'V_VP8']] as const) {
      const v: VideoCfg = { ...base, codec };
      if (await p.video(v)) return { kind: 'webm', vcodec, v, a: opus };
    }
  }
  if (mp4Rec) return { kind: 'realtime', mime: mp4Rec, ext: 'mp4' };
  if (webmRec) return { kind: 'realtime', mime: webmRec, ext: 'webm' };
  return { kind: 'none' };
}

/** The real-time way for this browser (what is used when the fast way fails half-way), or null. */
export function realtimeRoute(p: Pick<Probes, 'recorder'>): Extract<Route, { kind: 'realtime' }> | null {
  const mp4 = RECORDER_MP4.find((t) => p.recorder(t));
  if (mp4) return { kind: 'realtime', mime: mp4, ext: 'mp4' };
  const webm = RECORDER_WEBM.find((t) => p.recorder(t));
  return webm ? { kind: 'realtime', mime: webm, ext: 'webm' } : null;
}

/** Plain words for what the file will be. */
export function routeWords(r: Route): string {
  if (r.kind === 'mp4') return r.audio === 'aac' ? 'MP4 (H.264 + AAC)' : 'MP4 (H.264 picture, Opus sound)';
  if (r.kind === 'webm') return `WebM (${r.vcodec === 'V_VP9' ? 'VP9' : 'VP8'} + Opus)`;
  if (r.kind === 'realtime') return `${r.ext === 'mp4' ? 'MP4' : 'WebM'}, recorded in real time`;
  return 'no video';
}

export function isApple(ua: string, platform = '', touchPoints = 0): boolean {
  return /iPhone|iPad|iPod|Macintosh/i.test(ua) || (platform === 'MacIntel' && touchPoints > 1);
}
/** A phone or tablet from Apple (an iPad says it is a Mac, but has a touch screen). */
export function isIOS(ua: string, platform = '', touchPoints = 0): boolean {
  return /iPhone|iPad|iPod/i.test(ua) || ((platform === 'MacIntel' || /Macintosh/i.test(ua)) && touchPoints > 1);
}

/** The questions, asked of the browser the page runs in. */
export function browserProbes(): Probes {
  const g = globalThis as unknown as Record<string, unknown>;
  const has = (n: string) => typeof g[n] !== 'undefined';
  const codecs = has('VideoEncoder') && has('VideoFrame');
  const sound = codecs && has('AudioEncoder') && has('AudioData');
  const nav = typeof navigator !== 'undefined' ? navigator : ({ userAgent: '', platform: '', maxTouchPoints: 0 } as Navigator);
  const canCapture = typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function' && has('MediaRecorder');
  return {
    video: async (c) => { if (!codecs) return false; try { return !!(await VideoEncoder.isConfigSupported(c as VideoEncoderConfig)).supported; } catch { return false; } },
    audio: async (c) => { if (!sound) return false; try { return !!(await AudioEncoder.isConfigSupported(c as AudioEncoderConfig)).supported; } catch { return false; } },
    recorder: (mime) => { if (!canCapture) return false; try { return MediaRecorder.isTypeSupported(mime); } catch { return false; } },
    apple: isApple(nav.userAgent ?? '', nav.platform ?? '', nav.maxTouchPoints ?? 0),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// handing the file over
// ---------------------------------------------------------------------------------------------------------------

export interface SaveWays {
  /** The share sheet can take the file (iPhone: "Save Video" puts it in Photos; WhatsApp is in the same sheet). */
  share: boolean;
  /** Which button is the big one. */
  primary: 'share' | 'download';
}

/**
 * How to offer the finished file. On an iPhone or iPad the share sheet is the way into Photos and WhatsApp, so it comes
 * first; everywhere else a plain download does, with sharing as a second button where the browser can.
 */
export function saveWays(canShareFile: boolean, ios: boolean, touch: boolean): SaveWays {
  if (!canShareFile) return { share: false, primary: 'download' };
  return { share: true, primary: ios || touch ? 'share' : 'download' };
}

/** Can the share sheet take this file? (Asks the browser; false when it cannot say.) */
export function canShareFile(file: File): boolean {
  try {
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
    return typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
  } catch { return false; }
}
