import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { seedScore, fixture, collectConsoleErrors } from './helpers';

/** Duration in seconds written in the file's own header: MP4 `mvhd`, or WebM `Duration` in the Info element. */
export function fileDuration(buf: Buffer): { kind: 'mp4' | 'webm'; seconds: number } | null {
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

async function openDialog(page: Page, id: string, bpm: number) {
  await seedScore(page, id, 'Video Demo', fixture('phase3-demo.musicxml'));
  await page.goto(`/score/${id}`);
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await page.getByLabel('BPM').fill(String(bpm));
  await page.getByLabel('BPM').blur();
  await page.getByTestId('download-video').click();
  await expect(page.getByTestId('video-dialog')).toBeVisible();
}

test.describe('Download video', () => {
  test.setTimeout(240_000);

  test('the dialog offers view, shape, fingering style and drums, with the tempo and instrument of the screen', async ({ page }) => {
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
    await expect(d.getByLabel('Include drums')).toBeDisabled(); // no groove chosen on this score
    await expect(page.getByTestId('video-estimate')).toContainText('MB');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('video-dialog')).toHaveCount(0);
  });

  for (const view of ['2 bars', 'Full sheet']) {
    test(`makes a video of the ${view} that is about as long as the song`, async ({ page }) => {
      const errs = collectConsoleErrors(page);
      await openDialog(page, `v-${view.startsWith('2') ? 'two' : 'full'}`, 240); // 32 quarters at 240 = 8 s, plus the 1 s tail
      const d = page.getByTestId('video-dialog');
      await d.getByRole('radio', { name: view }).click();
      await d.getByTestId('video-make').click();
      await expect(page.getByTestId('video-progress')).toBeVisible();
      await expect(page.getByTestId('video-done')).toBeVisible({ timeout: 200_000 });
      const info = await page.evaluate(() => (window as unknown as { __brVideo: { kind: string; ext: string; bytes: number; durationS: number; name: string } }).__brVideo);
      expect(info.bytes).toBeGreaterThan(10_000);
      expect(info.durationS).toBeGreaterThan(8.5);
      expect(info.durationS).toBeLessThan(9.6);
      expect(info.name).toBe(`Video Demo - Bb Trumpet - 240bpm.${info.ext}`);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('video-save').click()]);
      expect(dl.suggestedFilename()).toBe(info.name);
      const file = await dl.path();
      const buf = fs.readFileSync(file!);
      expect(buf.length).toBe(info.bytes > 0 && info.kind !== 'realtime' ? info.bytes : buf.length);
      expect(buf.length).toBeGreaterThan(10_000);
      const dur = fileDuration(buf);
      if (info.kind !== 'realtime') {
        // MP4 / WebM made offline carry their length in the header: the song (8 s) and the tail (1 s)
        expect(dur, 'header duration').toBeTruthy();
        expect(dur!.seconds).toBeGreaterThan(8.5);
        expect(dur!.seconds).toBeLessThan(9.6);
      }
      expect(errs).toEqual([]);
    });
  }

  test('a browser without WebCodecs records in real time and says so', async ({ page }) => {
    await page.addInitScript(() => { delete (window as unknown as Record<string, unknown>).VideoEncoder; delete (window as unknown as Record<string, unknown>).AudioEncoder; });
    await openDialog(page, 'v-rt', 240);
    await page.getByTestId('video-make').click();
    await expect(page.getByTestId('video-progress')).toContainText(/real time|Making the sound|ready/i, { timeout: 60_000 });
    await expect(page.getByTestId('video-done')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('video-done')).toHaveAttribute('data-kind', 'realtime');
    await expect(page.getByTestId('video-done')).toContainText('real time');
    const info = await page.evaluate(() => (window as unknown as { __brVideo: { bytes: number; durationS: number } }).__brVideo);
    expect(info.bytes).toBeGreaterThan(10_000);
    expect(info.durationS).toBeCloseTo(9, 0);
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
});
