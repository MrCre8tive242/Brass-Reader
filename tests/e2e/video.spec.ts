import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { seedScore, fixture, collectConsoleErrors } from './helpers';

const hasFfprobe = spawnSync('ffprobe', ['-version']).status === 0;

/** Duration in seconds written in the file's own header: MP4 `mvhd`, or WebM `Duration` in the Info element. */
function fileDuration(buf: Buffer): { kind: 'mp4' | 'webm'; seconds: number } | null {
  const i = buf.indexOf(Buffer.from('mvhd'));
  if (i > 0 && buf.indexOf(Buffer.from('ftyp')) >= 0 && buf.indexOf(Buffer.from('ftyp')) < 64) {
    const v = buf[i + 4];
    if (v === 1) return { kind: 'mp4', seconds: Number(buf.readBigUInt64BE(i + 24)) / buf.readUInt32BE(i + 20) };
    return { kind: 'mp4', seconds: buf.readUInt32BE(i + 20) / buf.readUInt32BE(i + 16) };
  }
  if (buf.readUInt32BE(0) === 0x1a45dfa3) {
    // Segment > Info: TimecodeScale (2AD7B1) and Duration (4489, float)
    const d = buf.indexOf(Buffer.from([0x44, 0x89]));
    const ts = buf.indexOf(Buffer.from([0x2a, 0xd7, 0xb1]));
    if (d < 0) return null;
    const size = buf[d + 2] & 0x7f;
    const val = size === 8 ? buf.readDoubleBE(d + 3) : buf.readFloatBE(d + 3);
    let scale = 1_000_000;
    if (ts >= 0) { const n = buf[ts + 3] & 0x7f; scale = Number(buf.readUIntBE(ts + 4, Math.min(n, 6))); }
    return { kind: 'webm', seconds: (val * scale) / 1e9 };
  }
  return null;
}

interface Info { kind: string; ext: string; mime: string; bytes: number; durationS: number; frames: number; name: string; format: string; engine: string | null; rms: number[] }
const info = (page: Page) => page.evaluate(() => (window as unknown as { __brVideo: Info }).__brVideo);

async function openDialog(page: Page, id: string, bpm: number, extra: Record<string, unknown> = {}, file = 'phase3-demo.musicxml') {
  await seedScore(page, id, 'Video Demo', fixture(file));
  if (Object.keys(extra).length) {
    await page.evaluate(async ({ id, extra }) => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('keyval-store');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('keyval', 'readwrite');
          const st = tx.objectStore('keyval');
          const get = st.get(`score:${id}`);
          get.onsuccess = () => { st.put({ ...get.result, ...extra }, `score:${id}`); };
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      });
    }, { id, extra });
  }
  await page.goto(`/score/${id}`);
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await page.getByLabel('BPM').fill(String(bpm));
  await page.getByLabel('BPM').blur();
  await page.getByTestId('download-video').click();
  await expect(page.getByTestId('video-dialog')).toBeVisible();
  // the dialog has found out what this browser can make
  await expect(page.getByTestId('video-route')).not.toHaveAttribute('data-route', '', { timeout: 15_000 });
}
async function makeIt(page: Page, timeout = 200_000) {
  await page.getByTestId('video-make').click();
  await expect(page.getByTestId('video-done')).toBeVisible({ timeout });
  return info(page);
}
async function saved(page: Page): Promise<Buffer> {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('video-save').click()]);
  return fs.readFileSync((await dl.path())!);
}
/** What a real player says is in the file. */
function probe(buf: Buffer, ext: string) {
  const f = test.info().outputPath(`probe.${ext}`);
  fs.writeFileSync(f, buf);
  const out = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,nb_frames,r_frame_rate,sample_rate,channels:format=duration', '-of', 'json', f]).stdout.toString());
  const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-']);
  return { streams: out.streams as Record<string, unknown>[], seconds: Number(out.format.duration), decodeErrors: dec.stderr.toString() };
}

test.describe('Download video', () => {
  test.setTimeout(240_000);

  test('the dialog offers view, shape, fingering style, count-in and drums, with the tempo and instrument of the screen', async ({ page }) => {
    await openDialog(page, 'v0', 130);
    const d = page.getByTestId('video-dialog');
    await expect(d).toContainText('Bb Trumpet');
    await expect(d).toContainText('130 BPM');
    await expect(d.getByRole('radio', { name: '2 bars' })).toBeVisible();
    await expect(d.getByRole('radio', { name: 'Full sheet' })).toBeVisible();
    await expect(d.getByRole('radio', { name: /Portrait/ })).toHaveAttribute('aria-checked', 'true');
    await expect(d.getByRole('radio', { name: /Landscape/ })).toBeVisible();
    for (const s of ['Numbers', 'Valve dots', 'Both', 'Off']) await expect(d.getByRole('radio', { name: s, exact: true })).toBeVisible();
    await expect(d.getByRole('radio', { name: 'Both', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(d.getByLabel('Count-in bar')).toBeChecked();
    await expect(d.getByLabel('Include drums')).toBeDisabled(); // no groove chosen on this score
    await expect(d.getByLabel('Only the looped bars')).toHaveCount(0); // no loop set
    // what the file will be is said before it is made; the length follows the count-in
    await expect(page.getByTestId('video-route')).toContainText(/MP4|WebM/);
    const est = page.getByTestId('video-estimate');
    await expect(est).toContainText('MB');
    const withCount = await est.textContent();
    await d.getByLabel('Count-in bar').uncheck();
    await expect(est).not.toHaveText(withCount!);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('video-dialog')).toHaveCount(0);
  });

  for (const view of ['2 bars', 'Full sheet']) {
    test(`makes a video of the ${view} with a count-in, as long as the song, with sound all the way through`, async ({ page }) => {
      const errs = collectConsoleErrors(page);
      // 32 quarters at 240 = 8 s, a count-in bar of 1 s in front and a 1 s tail
      await openDialog(page, `v-${view.startsWith('2') ? 'two' : 'full'}`, 240);
      const d = page.getByTestId('video-dialog');
      await d.getByRole('radio', { name: view }).click();
      await d.getByTestId('video-make').click();
      await expect(page.getByTestId('video-progress')).toBeVisible();
      // the frames can be watched while it works
      await expect(page.getByTestId('video-preview').locator('canvas')).toBeVisible();
      await expect(page.getByTestId('video-done')).toBeVisible({ timeout: 200_000 });
      const v = await info(page);
      expect(['mp4', 'webm']).toContain(v.kind); // faster than real time in this browser
      expect(v.bytes).toBeGreaterThan(10_000);
      expect(v.durationS).toBeCloseTo(10, 1);
      expect(v.frames).toBe(300);
      expect(v.name).toBe(`Video Demo - Bb Trumpet - 240bpm.${v.ext}`);
      // sound in every second: clicks in the count-in, then the horn to the end (the tail rings out)
      expect(v.rms.length).toBeGreaterThanOrEqual(10);
      for (let s = 0; s < 9; s++) expect(v.rms[s], `second ${s}`).toBeGreaterThan(0.004);
      await expect(page.getByTestId('video-silent')).toHaveCount(0);
      await expect(page.getByTestId('video-player')).toBeVisible();
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('video-save').click()]);
      expect(dl.suggestedFilename()).toBe(v.name);
      const buf = fs.readFileSync((await dl.path())!);
      expect(buf.length).toBe(v.bytes);
      const dur = fileDuration(buf);
      expect(dur, 'header duration').toBeTruthy();
      expect(dur!.kind).toBe(v.ext);
      expect(dur!.seconds).toBeGreaterThan(9.8);
      expect(dur!.seconds).toBeLessThan(10.3);
      if (hasFfprobe) {
        const p = probe(buf, v.ext);
        const vs = p.streams.find((s) => s.width)!;
        expect(vs).toMatchObject({ width: 1080, height: 1920, r_frame_rate: '30/1' });
        if (v.ext === 'mp4') expect(vs).toMatchObject({ codec_name: 'h264', nb_frames: '300' });
        expect(p.streams.find((s) => s.sample_rate)).toMatchObject({ sample_rate: '48000', channels: 2 });
        expect(p.seconds).toBeGreaterThan(9.8);
        expect(p.seconds).toBeLessThan(10.3);
        expect(p.decodeErrors).toBe('');
      }
      // "Make another" brings the choices back
      await page.getByTestId('video-again').click();
      await expect(page.getByTestId('video-make')).toBeVisible();
      expect(errs).toEqual([]);
    });
  }

  test('landscape, no count-in, fingerings off: 1920x1080 and exactly the song plus its tail', async ({ page }) => {
    await openDialog(page, 'v-land', 240);
    const d = page.getByTestId('video-dialog');
    await d.getByRole('radio', { name: /Landscape/ }).click();
    await d.getByRole('radio', { name: 'Off', exact: true }).click();
    await d.getByLabel('Count-in bar').uncheck();
    await expect(page.getByTestId('video-route')).not.toHaveAttribute('data-route', '', { timeout: 15_000 });
    const v = await makeIt(page);
    expect(v.durationS).toBeCloseTo(9, 1);
    expect(v.frames).toBe(270);
    await expect(page.getByTestId('video-done')).toContainText('1920×1080');
    const buf = await saved(page);
    expect(fileDuration(buf)!.seconds).toBeGreaterThan(8.8);
    expect(fileDuration(buf)!.seconds).toBeLessThan(9.3);
  });

  test('with a practice loop set, the video can be of just those bars', async ({ page }) => {
    await openDialog(page, 'v-loop', 240, { loop: { from: 3, to: 4 } });
    const d = page.getByTestId('video-dialog');
    const only = d.getByLabel('Only the looped bars');
    await expect(only).not.toBeChecked(); // the whole tune unless asked
    await expect(d).toContainText('Only the looped bars 3-4');
    await expect(page.getByTestId('video-estimate')).toContainText('0:10 long');
    await only.check();
    // 2 bars at 240 = 2 s, a count-in bar of 1 s, 1 s tail
    await expect(page.getByTestId('video-estimate')).toContainText('0:04 long');
    await expect(d).toContainText('Video Demo, bars 3-4');
    const v = await makeIt(page);
    expect(v.durationS).toBeCloseTo(4, 1);
    expect(v.frames).toBe(120);
    expect(v.name).toBe(`Video Demo bars 3-4 - Bb Trumpet - 240bpm.${v.ext}`);
    for (let s = 0; s < 3; s++) expect(v.rms[s], `second ${s}`).toBeGreaterThan(0.004);
    const buf = await saved(page);
    expect(fileDuration(buf)!.seconds).toBeGreaterThan(3.8);
    expect(fileDuration(buf)!.seconds).toBeLessThan(4.3);
  });

  test('a browser without H.264 makes a WebM and says what that means', async ({ page }) => {
    await page.addInitScript(() => {
      const real = VideoEncoder.isConfigSupported.bind(VideoEncoder);
      VideoEncoder.isConfigSupported = (c: VideoEncoderConfig) => (c.codec.startsWith('avc1') ? Promise.resolve({ supported: false, config: c }) : real(c));
    });
    await openDialog(page, 'v-webm', 240);
    await expect(page.getByTestId('video-route')).toHaveAttribute('data-route', 'webm');
    await expect(page.getByTestId('video-route')).toContainText('not in iPhone Photos');
    const v = await makeIt(page);
    expect(v).toMatchObject({ kind: 'webm', ext: 'webm', mime: 'video/webm' });
    const buf = await saved(page);
    expect(buf.readUInt32BE(0)).toBe(0x1a45dfa3);
    expect(fileDuration(buf)!.seconds).toBeCloseTo(10, 0);
    if (hasFfprobe) {
      // written block by block with corrections at the start: a real player must still read it without a complaint
      const p = probe(buf, 'webm');
      expect(p.streams.find((s) => s.width)).toMatchObject({ codec_name: 'vp9', width: 1080, height: 1920 });
      expect(p.streams.find((s) => s.sample_rate)).toMatchObject({ codec_name: 'opus' });
      expect(p.decodeErrors).toBe('');
    }
    for (let s = 0; s < 9; s++) expect(v.rms[s], `second ${s}`).toBeGreaterThan(0.004);
  });

  test('a phone whose encoder only takes one shape is told which shape gives an MP4', async ({ page }) => {
    await page.addInitScript(() => {
      const real = VideoEncoder.isConfigSupported.bind(VideoEncoder);
      VideoEncoder.isConfigSupported = (c: VideoEncoderConfig) => (c.codec.startsWith('avc1') && c.height > c.width ? Promise.resolve({ supported: false, config: c }) : real(c));
    });
    await openDialog(page, 'v-shape', 240);
    await expect(page.getByTestId('video-route')).toHaveAttribute('data-route', 'webm');
    await expect(page.getByTestId('video-shape-tip')).toContainText('Landscape can be made as an MP4');
    await page.getByTestId('video-dialog').getByRole('radio', { name: /Landscape/ }).click();
    await expect(page.getByTestId('video-route')).toHaveAttribute('data-route', /^mp4-/);
    await expect(page.getByTestId('video-shape-tip')).toHaveCount(0);
  });

  test('a browser without WebCodecs records in real time and says so before and after', async ({ page }) => {
    await page.addInitScript(() => { delete (window as unknown as Record<string, unknown>).VideoEncoder; delete (window as unknown as Record<string, unknown>).AudioEncoder; });
    // a short tune (4 bars: 4 s at 240, a count-in bar of 1 s, 1 s tail), because this one really takes its time
    await openDialog(page, 'v-rt', 240, {}, 'scale.musicxml');
    await expect(page.getByTestId('video-route')).toHaveAttribute('data-route', /^realtime-/);
    await expect(page.getByTestId('video-route')).toContainText('takes as long as the song (0:06)');
    await page.getByTestId('video-make').click();
    await expect(page.getByTestId('video-progress')).toContainText(/real time/i, { timeout: 60_000 });
    await expect(page.getByTestId('video-done')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('video-done')).toHaveAttribute('data-kind', 'realtime');
    await expect(page.getByTestId('video-done')).toContainText('real time');
    const v = await info(page);
    expect(v.bytes).toBeGreaterThan(10_000);
    expect(v.durationS).toBeCloseTo(6, 0);
    for (let s = 0; s < 5; s++) expect(v.rms[s], `second ${s}`).toBeGreaterThan(0.004);
    const buf = await saved(page);
    expect(buf.length).toBeGreaterThan(10_000);
    if (hasFfprobe) {
      // really about as long as the song: recorded by the clock
      const p = probe(buf, v.ext);
      expect(p.seconds).toBeGreaterThan(5.5);
      expect(p.seconds).toBeLessThan(7.5);
      expect(p.streams.find((s) => s.width)).toMatchObject({ width: 1080, height: 1920 });
      expect(p.streams.some((s) => s.sample_rate)).toBe(true);
    }
  });

  test('when the quick way breaks half-way the video is still made, in real time', async ({ page }) => {
    await page.addInitScript(() => {
      const real = VideoEncoder.prototype.encode;
      let n = 0;
      VideoEncoder.prototype.encode = function (this: VideoEncoder, f: VideoFrame, o?: VideoEncoderEncodeOptions) {
        if (++n > 40) throw new DOMException('encoder gave up', 'EncodingError');
        return real.call(this, f, o);
      };
    });
    await openDialog(page, 'v-fall', 240, {}, 'scale.musicxml');
    const v = await makeIt(page);
    expect(v.kind).toBe('realtime');
    await expect(page.getByTestId('video-done')).toContainText('recorded in real time');
    await expect(page.getByTestId('video-done')).toContainText('quick way did not work');
    expect(v.bytes).toBeGreaterThan(10_000);
  });

  test('cancel stops it and nothing is saved', async ({ page }) => {
    await openDialog(page, 'v-cancel', 60); // 32 s of music: long enough to cancel
    await page.getByTestId('video-make').click();
    await expect(page.getByTestId('video-progress')).toBeVisible();
    await page.getByTestId('video-cancel').click();
    await expect(page.getByTestId('video-progress')).toHaveCount(0);
    await expect(page.getByTestId('video-done')).toHaveCount(0);
    await expect(page.getByTestId('video-make')).toBeVisible();
  });

  test('no signal and no saved samples: the video is made with the synth sound, and says so', async ({ page }) => {
    await page.route(/gleitz|midi-js-soundfonts|MusyngKite/i, (r) => r.abort());
    await openDialog(page, 'v-synth', 240);
    const v = await makeIt(page);
    expect(v.engine).toBe('synth');
    for (let s = 1; s < 9; s++) expect(v.rms[s], `second ${s}`).toBeGreaterThan(0.004);
    await expect(page.getByTestId('video-synth')).toContainText('simple synth sound');
  });

  test('a video with every part muted says that it has no sound', async ({ page }) => {
    await openDialog(page, 'v-mute', 240, { mix: { p0: { volume: 1, mute: true, solo: false } } });
    await page.getByTestId('video-dialog').getByLabel('Count-in bar').uncheck();
    await makeIt(page);
    await expect(page.getByTestId('video-silent')).toBeVisible();
  });
});

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';

test.describe('Download video on an iPhone (pretended: Safari\'s answers, this browser\'s encoders)', () => {
  test.setTimeout(240_000);
  test.use({ userAgent: IPHONE, viewport: { width: 390, height: 844 }, hasTouch: true });

  /** The share sheet: takes files, and notes what it was given. */
  const fakeShare = () => {
    const w = window as unknown as { __shared: { name: string; type: string; size: number; title?: string }[] };
    w.__shared = [];
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d: { files?: File[] }) => !!d.files?.length && d.files.every((f) => f.type === 'video/mp4') });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (d: { files: File[]; title?: string }) => { for (const f of d.files) w.__shared.push({ name: f.name, type: f.type, size: f.size, title: d.title }); } });
  };

  test('current iPhone: an MP4 (H.264 + AAC) made faster than real time, saved through the share sheet', async ({ page }) => {
    await page.addInitScript(fakeShare);
    await page.addInitScript(() => {
      // Safari 26 has an AAC encoder; this browser does not, so its Opus encoder stands in behind the same answers
      const real = AudioEncoder.isConfigSupported.bind(AudioEncoder);
      AudioEncoder.isConfigSupported = (c: AudioEncoderConfig) => (c.codec.startsWith('mp4a') ? Promise.resolve({ supported: true, config: c }) : real(c));
      const conf = AudioEncoder.prototype.configure;
      AudioEncoder.prototype.configure = function (this: AudioEncoder, c: AudioEncoderConfig) { return conf.call(this, c.codec.startsWith('mp4a') ? { ...c, codec: 'opus' } : c); };
      // a phone only lets sound start from a tap: note whether an AudioContext was made while the button was pressed
      const w = window as unknown as { __ctxInTap: boolean[] };
      w.__ctxInTap = [];
      const AC = window.AudioContext;
      window.AudioContext = class extends AC { constructor(o?: AudioContextOptions) { super(o); w.__ctxInTap.push(navigator.userActivation?.isActive ?? false); } } as typeof AudioContext;
    });
    await openDialog(page, 'v-ios', 240);
    await expect(page.getByTestId('video-route')).toHaveAttribute('data-route', 'mp4-aac');
    await expect(page.getByTestId('video-route')).toContainText('Photos and WhatsApp');
    const before = await page.evaluate(() => (window as unknown as { __ctxInTap: boolean[] }).__ctxInTap.length);
    const v = await makeIt(page);
    expect(v).toMatchObject({ kind: 'mp4', ext: 'mp4', mime: 'video/mp4', format: 'MP4 (H.264 + AAC)' });
    expect(v.durationS).toBeCloseTo(10, 1);
    // the stand-by for the real-time way was made inside the tap
    const made = await page.evaluate(() => (window as unknown as { __ctxInTap: boolean[] }).__ctxInTap);
    expect(made.length).toBeGreaterThan(before);
    expect(made[before]).toBe(true);
    // the big button is the share sheet; the download is still there
    const share = page.getByTestId('video-share');
    await expect(share).toHaveText('Save to Photos or share');
    await expect(share).toHaveClass(/primary/);
    await expect(page.getByTestId('video-save')).toHaveText('Download file');
    await expect(page.getByTestId('video-save')).not.toHaveClass(/primary/);
    await expect(page.getByTestId('video-done')).toContainText('Save Video');
    await share.tap();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared.length)).toBe(1);
    const shared = await page.evaluate(() => (window as unknown as { __shared: { name: string; type: string; size: number }[] }).__shared[0]);
    expect(shared).toMatchObject({ name: 'Video Demo - Bb Trumpet - 240bpm.mp4', type: 'video/mp4', size: v.bytes });
    // the file itself: an MP4 with the right length, H.264 picture and a sound track marked as AAC
    const buf = await saved(page);
    expect(buf.toString('latin1', 4, 8)).toBe('ftyp');
    expect(fileDuration(buf)).toMatchObject({ kind: 'mp4' });
    expect(fileDuration(buf)!.seconds).toBeCloseTo(10, 0);
    expect(buf.includes(Buffer.from('avc1'))).toBe(true);
    expect(buf.includes(Buffer.from('mp4a'))).toBe(true);
  });

  test('iPhone before iOS 26 (no sound encoder): recorded in real time as MP4, the sound started by the tap', async ({ page }) => {
    await page.addInitScript(fakeShare);
    await page.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).AudioEncoder;
      const w = window as unknown as { __ctxInTap: boolean[] };
      w.__ctxInTap = [];
      const AC = window.AudioContext;
      window.AudioContext = class extends AC { constructor(o?: AudioContextOptions) { super(o); w.__ctxInTap.push(navigator.userActivation?.isActive ?? false); } } as typeof AudioContext;
    });
    await openDialog(page, 'v-ios-old', 240, {}, 'scale.musicxml');
    await expect(page.getByTestId('video-route')).toHaveAttribute('data-route', 'realtime-mp4');
    await expect(page.getByTestId('video-route')).toContainText('Keep this page open');
    const before = await page.evaluate(() => (window as unknown as { __ctxInTap: boolean[] }).__ctxInTap.length);
    await page.getByTestId('video-make').tap();
    await expect(page.getByTestId('video-done')).toBeVisible({ timeout: 120_000 });
    const v = await info(page);
    expect(v).toMatchObject({ kind: 'realtime', ext: 'mp4', mime: 'video/mp4' });
    const made = await page.evaluate(() => (window as unknown as { __ctxInTap: boolean[] }).__ctxInTap);
    expect(made.slice(before)).toEqual([true]); // one context, made in the tap, used for the recording
    await expect(page.getByTestId('video-share')).toHaveText('Save to Photos or share');
    for (let s = 0; s < 5; s++) expect(v.rms[s], `second ${s}`).toBeGreaterThan(0.004);
  });

  test('sharing that fails says to use the download', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(navigator, 'share', { configurable: true, value: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })) });
    });
    await openDialog(page, 'v-ios-share', 240, {}, 'scale.musicxml');
    await makeIt(page);
    await page.getByTestId('video-share').tap();
    await expect(page.getByTestId('video-dialog')).toContainText('Use "Download file" instead');
    await expect(page.getByTestId('video-save')).toBeVisible();
  });
});

test.describe('The sound of a video', () => {
  test.setTimeout(120_000);

  test('is made in pieces that join without a seam (horn and kit drums), and louder than the bare mix', async ({ page }) => {
    await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__brTest = true; });
    await openDialog(page, 'v-seam', 133, { drums: { grooveId: 'starter-c', on: true, volume: 0.6, inTakes: true, inMidi: false } });
    await expect(page.getByTestId('video-dialog').getByLabel('Include drums')).toBeChecked();
    await page.waitForFunction(() => { const w = window as unknown as Record<string, unknown>; return !!w.__brVideoLib && !!w.__brVideoJob; });
    const r = await page.evaluate(async () => {
      type Chan = [Float32Array, Float32Array];
      interface Renderer { segments: { start: number; end: number; from: number }[]; render(i: number): Promise<Chan>; makeup: number; engine: string | null }
      const w = window as unknown as {
        __brVideoLib: { renderWhole(job: unknown, s: number): Promise<Chan>; AudioRenderer: new (job: unknown, s: number, rate?: number, seg?: number) => Renderer };
        __brVideoJob: () => { audio: { drumsOn: boolean; drumHits: unknown[]; mix: unknown[] } };
      };
      const job = w.__brVideoJob();
      const secs = 15;
      const whole = await w.__brVideoLib.renderWhole(job.audio, secs);
      const pieces = new w.__brVideoLib.AudioRenderer(job.audio, secs, 48000, 2.5);
      let pos = 0, diff = 0, peak = 0;
      for (let i = 0; i < pieces.segments.length; i++) {
        const [l, rr] = await pieces.render(i);
        for (let k = 0; k < l.length; k++) {
          diff = Math.max(diff, Math.abs(l[k] - whole[0][pos + k]), Math.abs(rr[k] - whole[1][pos + k]));
          peak = Math.max(peak, Math.abs(whole[0][pos + k]));
        }
        pos += l.length;
      }
      // the horn alone is turned up; nothing clips
      const solo = new w.__brVideoLib.AudioRenderer({ ...job.audio, drumsOn: false }, secs);
      return { n: pieces.segments.length, frames: pos, total: whole[0].length, diff, peak, drums: job.audio.drumsOn, hits: job.audio.drumHits.length, makeup: pieces.makeup, soloMakeup: solo.makeup };
    });
    expect(r.drums).toBe(true);
    expect(r.hits).toBeGreaterThan(50);
    expect(r.n).toBe(6);
    expect(r.frames).toBe(r.total);
    expect(r.peak).toBeGreaterThan(0.2);
    expect(r.peak).toBeLessThanOrEqual(1);
    expect(r.diff).toBeLessThan(1e-4);
    expect(r.soloMakeup).toBeGreaterThan(2);
    expect(r.makeup).toBeLessThan(r.soloMakeup);
  });
});
