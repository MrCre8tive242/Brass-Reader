import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, collectConsoleErrors } from './helpers';

const fixtures = path.join(__dirname, '../fixtures');

async function stubOmr(page: Page, status = 200) {
  const seen: { images: string[]; engine: string }[] = [];
  await page.route('**/api/omr', async (route) => {
    seen.push(route.request().postDataJSON());
    if (status === 200) {
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ musicxml: fixture('scale.musicxml'), engine: 'claude', warnings: [] }) });
    } else {
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: 'The reader is not set up: add ANTHROPIC_API_KEY in Vercel (Project Settings, Environment Variables).', code: 'no_key' }) });
    }
  });
  return seen;
}

test('uploading a MusicXML file saves it and opens the player', async ({ page }) => {
  const errs = collectConsoleErrors(page);
  await page.goto('/');
  await expect(page.getByTestId('empty-library')).toBeVisible();
  await page.getByTestId('xml-input').setInputFiles(path.join(fixtures, 'ties-dots.musicxml'));
  await page.waitForURL(/\/score\//);
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect(page.getByTestId('bar-counter')).toHaveText('Bar 1 / 4');
  await expect(page.locator('h1.title')).toHaveText('Ties and Dots');
  await page.goBack();
  await expect(page.getByRole('link', { name: /Ties and Dots/ })).toBeVisible();
  expect(errs).toEqual([]);
});

test('uploading a .mxl container works', async ({ page }) => {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="s.xml"/></rootfiles></container>');
  zip.file('s.xml', fixture('key-changes.musicxml'));
  const buffer = Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
  await page.goto('/');
  await page.getByTestId('xml-input').setInputFiles({ name: 'piece.mxl', mimeType: 'application/vnd.recordare.musicxml', buffer });
  await page.waitForURL(/\/score\//);
  await expect(page.getByTestId('bar-counter')).toHaveText('Bar 1 / 6', { timeout: 30_000 });
});

test('a PDF is rasterised, sent to the (stubbed) reader, saved and opened', async ({ page }) => {
  const errs = collectConsoleErrors(page);
  const seen = await stubOmr(page);
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(path.join(fixtures, 'sample-scan.pdf'));
  await expect(page.getByTestId('thumbs')).toBeVisible();
  await page.getByLabel('Scan is written for').selectOption('mellophone');
  await page.getByRole('button', { name: 'Read PDF' }).click();
  await page.waitForURL(/\/score\//, { timeout: 60_000 });
  expect(seen).toHaveLength(1);
  expect(seen[0].images).toHaveLength(2); // the fixture has two pages
  for (const im of seen[0].images) {
    expect(im.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(im.length).toBeGreaterThan(5000);
  }
  await expect(page.getByTestId('bar-counter')).toHaveText('Bar 1 / 4', { timeout: 30_000 });
  await expect(page.getByLabel('Written for')).toHaveValue('mellophone');
  expect(errs).toEqual([]);
});

test('photos are downscaled to at most 2000px and can be reordered/removed', async ({ page }) => {
  const seen = await stubOmr(page);
  await page.goto('/');
  const png = async (w: number, h: number) => {
    const data = await page.evaluate(({ w, h }) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = '#000'; g.fillRect(10, 10, 50, 50);
      return c.toDataURL('image/png').split(',')[1];
    }, { w, h });
    return Buffer.from(data, 'base64');
  };
  await page.getByTestId('file-input').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: await png(3000, 1500) },
    { name: 'b.png', mimeType: 'image/png', buffer: await png(800, 600) },
  ]);
  await expect(page.locator('.thumb')).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove page 2' }).click();
  await expect(page.locator('.thumb')).toHaveCount(1);
  await page.getByRole('button', { name: 'Read 1 page' }).click();
  await page.waitForURL(/\/score\//, { timeout: 30_000 });
  expect(seen[0].images).toHaveLength(1);
  const dims = await page.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  }, seen[0].images[0]);
  expect(dims).toEqual([2000, 1000]);
});

test('reader errors show a clear message with fallbacks', async ({ page }) => {
  await stubOmr(page, 503);
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(fs.readFileSync(path.join(fixtures, 'sample-scan.pdf')).subarray(0, 0)) });
  // a zero-byte "png" cannot be decoded: expect a friendly error, not a crash
  await page.getByRole('button', { name: /Read 1 page/ }).click();
  await expect(page.getByTestId('upload-error')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open MusicXML instead' })).toBeVisible();
});

test('503 no-key error is shown verbatim', async ({ page }) => {
  await stubOmr(page, 503);
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(path.join(fixtures, 'sample-scan.pdf'));
  await page.getByRole('button', { name: 'Read PDF' }).click();
  await expect(page.getByTestId('upload-error')).toContainText('ANTHROPIC_API_KEY');
  await expect(page.getByRole('button', { name: 'Try free reader' })).toHaveCount(0);
});
