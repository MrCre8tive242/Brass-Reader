import { describe, it, expect } from 'vitest';
import { chooseRoute, realtimeRoute, routeWords, isApple, isIOS, saveWays, AVC_CODECS, type Probes, type VideoCfg, type AudioCfg } from '@/lib/videoSupport';

const O = { fps: 30, videoBps: 2_000_000, audioBps: 128_000 };

/** A browser described by what it can do. */
function browser(b: { avc?: boolean | string[]; vp9?: boolean; vp8?: boolean; aac?: boolean | number[]; opus?: boolean; rec?: string[]; apple?: boolean }): Probes & { asked: { v: VideoCfg[]; a: AudioCfg[] } } {
  const asked = { v: [] as VideoCfg[], a: [] as AudioCfg[] };
  return {
    asked,
    video: async (c) => {
      asked.v.push(c);
      if (c.codec.startsWith('avc1')) return Array.isArray(b.avc) ? b.avc.includes(c.codec) : !!b.avc;
      if (c.codec.startsWith('vp09')) return !!b.vp9;
      if (c.codec === 'vp8') return !!b.vp8;
      return false;
    },
    audio: async (c) => {
      asked.a.push(c);
      if (c.codec === 'mp4a.40.2') return Array.isArray(b.aac) ? b.aac.includes(c.sampleRate) : !!b.aac;
      if (c.codec === 'opus') return !!b.opus;
      return false;
    },
    recorder: (mime) => (b.rec ?? []).some((r) => mime === r || (r === 'video/mp4*' && mime.startsWith('video/mp4')) || (r === 'video/webm*' && mime.startsWith('video/webm'))),
    apple: !!b.apple,
  };
}

describe('how the video file is made', () => {
  it('a current iPhone (H.264 and AAC encoders): MP4 with AAC, faster than real time', async () => {
    const r = await chooseRoute(1080, 1920, browser({ avc: true, aac: true, opus: true, rec: ['video/mp4*'], apple: true }), O);
    expect(r).toMatchObject({ kind: 'mp4', audio: 'aac' });
    if (r.kind !== 'mp4') throw new Error('route');
    expect(r.v).toMatchObject({ codec: AVC_CODECS[0], width: 1080, height: 1920, framerate: 30, bitrate: 2_000_000, avc: { format: 'avc' } });
    expect(r.a).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 });
    expect(routeWords(r)).toBe('MP4 (H.264 + AAC)');
  });

  it('an iPhone before iOS 26 (no sound encoder): real-time MP4, never WebM', async () => {
    const r = await chooseRoute(1080, 1920, browser({ avc: true, rec: ['video/mp4*'], apple: true }), O);
    expect(r).toEqual({ kind: 'realtime', mime: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4' });
    expect(routeWords(r)).toBe('MP4, recorded in real time');
  });

  it('an Apple device with Opus but no AAC encoder still gets the MP4 that Photos takes', async () => {
    const r = await chooseRoute(1080, 1920, browser({ avc: true, opus: true, vp9: true, rec: ['video/mp4'], apple: true }), O);
    expect(r).toEqual({ kind: 'realtime', mime: 'video/mp4', ext: 'mp4' });
    // and without a recorder: H.264 + Opus in an MP4 rather than WebM
    const r2 = await chooseRoute(1080, 1920, browser({ avc: true, opus: true, vp9: true, apple: true }), O);
    expect(r2).toMatchObject({ kind: 'mp4', audio: 'opus' });
  });

  it('AAC only at 44.1 kHz is used at 44.1 kHz', async () => {
    const r = await chooseRoute(1920, 1080, browser({ avc: true, aac: [44100] }), O);
    expect(r).toMatchObject({ kind: 'mp4', audio: 'aac', a: { sampleRate: 44100 } });
  });

  it('an encoder that only takes another H.264 level is found', async () => {
    const b = browser({ avc: ['avc1.4D0032'], aac: true });
    const r = await chooseRoute(1080, 1920, b, O);
    expect(r).toMatchObject({ kind: 'mp4', v: { codec: 'avc1.4D0032' } });
    expect(b.asked.v.map((v) => v.codec)).toEqual(AVC_CODECS.slice(0, AVC_CODECS.indexOf('avc1.4D0032') + 1));
  });

  it('Chrome on Linux (H.264 but no AAC): MP4 with Opus sound', async () => {
    const r = await chooseRoute(1080, 1920, browser({ avc: true, vp9: true, vp8: true, opus: true, rec: ['video/mp4', 'video/webm*'] }), O);
    expect(r).toMatchObject({ kind: 'mp4', audio: 'opus', a: { codec: 'opus', sampleRate: 48000 } });
    expect(routeWords(r)).toBe('MP4 (H.264 picture, Opus sound)');
  });

  it('no H.264 at all: WebM, VP9 before VP8', async () => {
    expect(await chooseRoute(1080, 1920, browser({ vp9: true, vp8: true, opus: true, rec: ['video/webm*'] }), O)).toMatchObject({ kind: 'webm', vcodec: 'V_VP9' });
    const r = await chooseRoute(1080, 1920, browser({ vp8: true, opus: true }), O);
    expect(r).toMatchObject({ kind: 'webm', vcodec: 'V_VP8' });
    expect(routeWords(r)).toBe('WebM (VP8 + Opus)');
  });

  it('no WebCodecs: recorded in real time, MP4 if the browser can', async () => {
    expect(await chooseRoute(1080, 1920, browser({ rec: ['video/mp4', 'video/webm*'] }), O)).toEqual({ kind: 'realtime', mime: 'video/mp4', ext: 'mp4' });
    expect(await chooseRoute(1080, 1920, browser({ rec: ['video/webm*'] }), O)).toEqual({ kind: 'realtime', mime: 'video/webm;codecs=vp9,opus', ext: 'webm' });
    expect(await chooseRoute(1080, 1920, browser({}), O)).toEqual({ kind: 'none' });
  });

  it('the real-time way stands by for when the quick way fails', () => {
    expect(realtimeRoute(browser({ rec: ['video/mp4'] }))).toEqual({ kind: 'realtime', mime: 'video/mp4', ext: 'mp4' });
    expect(realtimeRoute(browser({ rec: ['video/webm'] }))).toEqual({ kind: 'realtime', mime: 'video/webm', ext: 'webm' });
    expect(realtimeRoute(browser({}))).toBeNull();
  });
});

describe('which device', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
  const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
  it('tells Apple devices and iPhones/iPads apart from the rest', () => {
    expect(isApple(iphone)).toBe(true);
    expect(isIOS(iphone)).toBe(true);
    expect(isApple(ipad, 'MacIntel', 5)).toBe(true);
    expect(isIOS(ipad, 'MacIntel', 5)).toBe(true); // an iPad says it is a Mac, but has a touch screen
    expect(isIOS(ipad, 'MacIntel', 0)).toBe(false); // a real Mac
    expect(isApple(ipad, 'MacIntel', 0)).toBe(true);
    expect(isApple(android, 'Linux armv81', 5)).toBe(false);
    expect(isIOS(android, 'Linux armv81', 5)).toBe(false);
  });
});

describe('handing the file over', () => {
  it('iPhone: the share sheet first (Save Video puts it in Photos), download second', () => {
    expect(saveWays(true, true, true)).toEqual({ share: true, primary: 'share' });
  });
  it('Android phone: share first too', () => {
    expect(saveWays(true, false, true)).toEqual({ share: true, primary: 'share' });
  });
  it('computer that can share: download first, share offered', () => {
    expect(saveWays(true, false, false)).toEqual({ share: true, primary: 'download' });
  });
  it('no file sharing: just the download', () => {
    expect(saveWays(false, true, true)).toEqual({ share: false, primary: 'download' });
    expect(saveWays(false, false, false)).toEqual({ share: false, primary: 'download' });
  });
});
