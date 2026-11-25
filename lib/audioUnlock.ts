/**
 * Getting sound out of a phone browser.
 *
 * - Browsers only start audio from inside a tap/click/key handler: `unlockAudio` must be called there.
 * - iPhone/iPad: Web Audio is treated as "ambient" sound and is silenced by the ring/silent switch. Safari 16.4+
 *   lets a page declare itself media playback (`navigator.audioSession.type = 'playback'`); on older versions
 *   the same effect comes from a silent looping <audio> element playing next to the Web Audio graph.
 */

type AudioSessionNav = Navigator & { audioSession?: { type: string } };

export function isIos(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (!nav) return false;
  const ua = nav.userAgent ?? '';
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
}

/** Half a second of silence as an 8-bit mono WAV. */
export function silentWav(seconds = 0.5, rate = 8000): Uint8Array {
  const n = Math.round(seconds * rate);
  const b = new Uint8Array(44 + n);
  const v = new DataView(b.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  b.fill(128, 44);
  return b;
}

let loop: HTMLAudioElement | null = null;
const primed = new WeakSet<object>();

/** Call synchronously inside a user gesture, before `ctx.resume()`. Safe to call every time Play is pressed. */
export function unlockAudio(ctx: AudioContext): void {
  const nav = (typeof navigator === 'undefined' ? undefined : navigator) as AudioSessionNav | undefined;
  let session = false;
  try {
    if (nav?.audioSession) { session = true; if (nav.audioSession.type !== 'playback') nav.audioSession.type = 'playback'; }
  } catch { /* not allowed: fall back to the loop below */ session = false; }
  if (!primed.has(ctx)) {
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
      primed.add(ctx);
    } catch { /* ignore */ }
  }
  if (!session && isIos(nav) && typeof document !== 'undefined') {
    try {
      if (!loop) {
        loop = document.createElement('audio');
        loop.setAttribute('playsinline', '');
        loop.loop = true;
        loop.preload = 'auto';
        loop.src = URL.createObjectURL(new Blob([silentWav() as BlobPart], { type: 'audio/wav' }));
      }
      void loop.play().catch(() => {});
    } catch { /* ignore */ }
  }
}

/** Stop the silent loop (when playback pauses), so the phone does not show a "now playing" item for nothing. */
export function releaseAudio(): void {
  try { loop?.pause(); } catch { /* ignore */ }
}
