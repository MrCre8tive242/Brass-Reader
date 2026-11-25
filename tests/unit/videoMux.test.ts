import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VideoMux } from '@/lib/videoMux';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const buf = async (b: Blob) => Buffer.from(await b.arrayBuffer());

/** The boxes at the top level of an MP4: name and size. */
function topBoxes(b: Buffer): { name: string; size: number }[] {
  const out: { name: string; size: number }[] = [];
  for (let i = 0; i + 8 <= b.length;) {
    let size = b.readUInt32BE(i);
    const name = b.toString('latin1', i + 4, i + 8);
    if (size === 1) size = Number(b.readBigUInt64BE(i + 8));
    if (size < 8) break;
    out.push({ name, size });
    i += size;
  }
  return out;
}
function mvhdSeconds(b: Buffer): number {
  const i = b.indexOf(Buffer.from('mvhd'));
  return b[i + 4] === 1 ? Number(b.readBigUInt64BE(i + 24)) / b.readUInt32BE(i + 20) : b.readUInt32BE(i + 20) / b.readUInt32BE(i + 16);
}

describe('writing the video file', () => {
  it('an MP4 is written block by block and comes out whole: ftyp, the media, then the index, with the right length', async () => {
    const m = new VideoMux({ container: 'mp4', video: 'avc', audio: 'aac', width: 1080, height: 1920, fps: 30, sampleRate: 48000, channels: 2 });
    expect(m.mime).toBe('video/mp4');
    const avcC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xee]);
    // 3 seconds; pictures big enough that the file spans several blocks (1 MB each)
    for (let k = 0; k < 90; k++) {
      const data = new Uint8Array(k % 30 === 0 ? 120_000 : 30_000).fill(k + 1);
      m.addVideoRaw(data, k % 30 === 0, Math.round((k / 30) * 1e6), Math.round(1e6 / 30), k === 0 ? { decoderConfig: { codec: 'avc1.640028', description: avcC } } : undefined);
      // the sound that belongs to this picture: 1024 frames a piece at 48 kHz
      while (m.audioChunks * 1024 < ((k + 1) / 30) * 48000) m.addAudioRaw(new Uint8Array(300).fill(7), Math.round(((m.audioChunks * 1024) / 48000) * 1e6), Math.round((1024 / 48000) * 1e6));
    }
    expect(m.videoChunks).toBe(90);
    expect(m.bytes).toBeGreaterThan(2_000_000); // most of it has already left the muxer
    const file = await buf(m.finish());
    const boxes = topBoxes(file);
    expect(boxes.map((b) => b.name)).toEqual(['ftyp', 'mdat', 'moov']);
    expect(boxes.reduce((s, b) => s + b.size, 0)).toBe(file.length);
    expect(file.length).toBeGreaterThan(90 * 30_000);
    expect(mvhdSeconds(file)).toBeCloseTo(3, 1);
    // a sound track with no description from the encoder still gets one (AAC-LC, 48 kHz, stereo)
    expect(file.includes(Buffer.from('mp4a'))).toBe(true);
    expect(file.includes(Buffer.from('avc1'))).toBe(true);
    expect(file.includes(Buffer.from([0x11, 0x90]))).toBe(true);
  });

  it('H.264 with Opus sound goes into an MP4 too', async () => {
    const m = new VideoMux({ container: 'mp4', video: 'avc', audio: 'opus', width: 1920, height: 1080, fps: 30, sampleRate: 48000, channels: 2 });
    for (let k = 0; k < 30; k++) m.addVideoRaw(new Uint8Array(500).fill(1), k === 0, Math.round((k / 30) * 1e6), Math.round(1e6 / 30), k === 0 ? { decoderConfig: { codec: 'avc1.640028', description: new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe0, 0]) } } : undefined);
    for (let k = 0; k < 50; k++) m.addAudioRaw(new Uint8Array(160).fill(2), k * 20_000, 20_000);
    const file = await buf(m.finish());
    expect(file.includes(Buffer.from('Opus'))).toBe(true);
    expect(file.includes(Buffer.from('dOps'))).toBe(true);
    expect(mvhdSeconds(file)).toBeCloseTo(1, 1);
  });

  it('a WebM is written the same way', async () => {
    const m = new VideoMux({ container: 'webm', video: 'V_VP9', audio: 'opus', width: 1080, height: 1920, fps: 30, sampleRate: 48000, channels: 2 });
    expect(m.mime).toBe('video/webm');
    for (let k = 0; k < 60; k++) {
      m.addVideoRaw(new Uint8Array(40_000).fill(3), k % 30 === 0, Math.round((k / 30) * 1e6), Math.round(1e6 / 30));
      m.addAudioRaw(new Uint8Array(160).fill(2), Math.round((k / 30) * 1e6), 20_000);
    }
    const file = await buf(m.finish());
    expect(file.readUInt32BE(0)).toBe(0x1a45dfa3);
    expect(file.length).toBeGreaterThan(60 * 40_000);
    expect(file.includes(Buffer.from('V_VP9'))).toBe(true);
    expect(file.includes(Buffer.from('A_OPUS'))).toBe(true);
  });

  it('says no to what the containers cannot hold here', () => {
    expect(() => new VideoMux({ container: 'webm', video: 'avc', audio: 'opus', width: 2, height: 2, fps: 30, sampleRate: 48000, channels: 2 })).toThrow();
    expect(() => new VideoMux({ container: 'mp4', video: 'V_VP9', audio: 'aac', width: 2, height: 2, fps: 30, sampleRate: 48000, channels: 2 })).toThrow();
  });

  // The file an iPhone gets, checked with a real player: H.264 and AAC made by ffmpeg, put together by our code.
  it.skipIf(!hasFfmpeg)('real H.264 + AAC streams come out as an MP4 that ffmpeg plays without a complaint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-mux-'));
    try {
      const h264 = path.join(dir, 'v.h264'), aac = path.join(dir, 'a.aac'), out = path.join(dir, 'out.mp4');
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-profile:v', 'high', '-bf', '0', '-g', '60', '-x264-params', 'aud=1:slices=1', '-f', 'h264', h264]);
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-f', 'adts', aac]);
      // H.264: split at the start codes into units, and at every "access unit delimiter" (type 9) into pictures
      const v = fs.readFileSync(h264);
      const nals: Buffer[] = [];
      let from = -1;
      for (let i = 0; i + 3 <= v.length; i++) {
        if (v[i] === 0 && v[i + 1] === 0 && v[i + 2] === 1) {
          if (from >= 0) nals.push(v.subarray(from, i > 0 && v[i - 1] === 0 ? i - 1 : i));
          from = i + 3;
          i += 2;
        }
      }
      if (from >= 0) nals.push(v.subarray(from));
      const sps = nals.find((n) => (n[0] & 31) === 7)!, pps = nals.find((n) => (n[0] & 31) === 8)!;
      const avcC = Buffer.concat([Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 255]), sps, Buffer.from([1, pps.length >> 8, pps.length & 255]), pps, Buffer.from([0xfd, 0xf8, 0xf8, 0])]);
      const pictures: { data: Buffer; key: boolean }[] = [];
      let cur: Buffer[] = [], key = false;
      const close = () => { if (cur.length) pictures.push({ data: Buffer.concat(cur), key }); cur = []; key = false; };
      for (const n of nals) {
        const t = n[0] & 31;
        if (t === 9) { close(); continue; }
        if (t === 7 || t === 8) continue; // they live in the file's header
        if (t === 5) key = true;
        const len = Buffer.alloc(4); len.writeUInt32BE(n.length);
        cur.push(len, n);
      }
      close();
      expect(pictures.length).toBe(90);
      // AAC: strip the 7 byte ADTS header of each frame
      const a = fs.readFileSync(aac);
      const frames: Buffer[] = [];
      for (let i = 0; i + 7 <= a.length;) {
        const len = ((a[i + 3] & 3) << 11) | (a[i + 4] << 3) | (a[i + 5] >> 5);
        const head = a[i + 1] & 1 ? 7 : 9;
        frames.push(a.subarray(i + head, i + len));
        i += len;
      }
      const m = new VideoMux({ container: 'mp4', video: 'avc', audio: 'aac', width: 540, height: 960, fps: 30, sampleRate: 48000, channels: 2 });
      let ai = 0;
      pictures.forEach((p, k) => {
        m.addVideoRaw(new Uint8Array(p.data), p.key, Math.round((k / 30) * 1e6), Math.round(1e6 / 30), k === 0 ? { decoderConfig: { codec: 'avc1.640028', description: new Uint8Array(avcC) } } : undefined);
        for (; ai < frames.length && (ai * 1024) / 48000 <= (k + 1) / 30; ai++) m.addAudioRaw(new Uint8Array(frames[ai]), Math.round(((ai * 1024) / 48000) * 1e6), Math.round((1024 / 48000) * 1e6));
      });
      for (; ai < frames.length; ai++) m.addAudioRaw(new Uint8Array(frames[ai]), Math.round(((ai * 1024) / 48000) * 1e6), Math.round((1024 / 48000) * 1e6));
      fs.writeFileSync(out, await buf(m.finish()));
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,profile,width,height,nb_frames,sample_rate,channels:format=duration', '-of', 'json', out]).toString());
      const vs = probe.streams.find((s: { codec_name: string }) => s.codec_name === 'h264');
      const as = probe.streams.find((s: { codec_name: string }) => s.codec_name === 'aac');
      expect(vs).toMatchObject({ profile: 'High', width: 540, height: 960, nb_frames: '90' });
      expect(as).toMatchObject({ sample_rate: '48000', channels: 2 });
      expect(Number(probe.format.duration)).toBeGreaterThan(2.95);
      expect(Number(probe.format.duration)).toBeLessThan(3.1);
      // decode every picture and all the sound: any damage is reported on stderr
      const dec = spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-i', out, '-f', 'null', '-']);
      expect(dec.stderr.toString()).toBe('');
      expect(dec.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
