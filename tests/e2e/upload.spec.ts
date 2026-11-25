import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, collectConsoleErrors } from './helpers';

const fixtures = path.join(__dirname, '../fixtures');

async function stubOmr(page: Page, status = 200) {
  const seen: { images: string[]; engine: string }[] = [];
  await page.route('**/api/omr', async (route) => {
    if (route.request().method() === 'GET') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claude: true, audiveris: false }) }); return; }
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

/** Minimal PDF with `n` pages, each a full-page DeviceGray noise image (incompressible, like a bad photo scan). */
function noisyPdf(n: number, w: number, h: number): Buffer {
  const zlib = require('node:zlib') as typeof import('node:zlib'); // eslint-disable-line @typescript-eslint/no-require-imports
  const crypto = require('node:crypto') as typeof import('node:crypto'); // eslint-disable-line @typescript-eslint/no-require-imports
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (b: Buffer | string) => { const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b; parts.push(buf); len += buf.length; };
  const obj = (id: number, body: Buffer | string) => { offsets[id] = len; push(`${id} 0 obj\n`); push(body); push('\nendobj\n'); };
  push('%PDF-1.4\n');
  const kidsRefs: string[] = [];
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  for (let i = 0; i < n; i++) {
    const page = 3 + i * 3, content = page + 1, image = page + 2;
    kidsRefs.push(`${page} 0 R`);
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /XObject << /Im0 ${image} 0 R >> >> >>`);
    const cs = '612 0 0 792 0 0 cm /Im0 Do';
    obj(content, `<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`);
    const data = zlib.deflateSync(crypto.randomBytes(w * h), { level: 1 });
    obj(image, Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream')]));
  }
  obj(2, `<< /Type /Pages /Kids [${kidsRefs.join(' ')}] /Count ${n} >>`);
  const xref = len;
  const total = 3 + n * 3;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return Buffer.concat(parts);
}

test('a large noisy 6-page PDF is shrunk until it fits and is not blocked', async ({ page }) => {
  test.setTimeout(120_000);
  const seen = await stubOmr(page);
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'big.pdf', mimeType: 'application/pdf', buffer: noisyPdf(6, 1400, 1800) });
  await page.getByRole('button', { name: 'Read PDF' }).click();
  await page.waitForURL(/\/score\//, { timeout: 100_000 });
  expect(seen).toHaveLength(1);
  expect(seen[0].images).toHaveLength(6);
  const total = seen[0].images.reduce((n, s) => n + s.length, 0);
  expect(total).toBeLessThanOrEqual(3_800_000);
});

test('client-side errors do not offer the free reader', async ({ page }) => {
  await page.route('**/api/omr', (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claude: true, audiveris: true }) })
    : route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Both readers failed.', code: 'reader_failed' }) }));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.getByRole('button', { name: /Read 1 page|Read PDF/ }).click();
  await expect(page.getByTestId('upload-error')).toContainText('Unsupported file');
  await expect(page.getByRole('button', { name: 'Try free reader' })).toHaveCount(0);
  // a genuine reader failure does offer it (free reader configured)
  await page.getByTestId('file-input').setInputFiles({ name: 'a.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(path.join(fixtures, 'sample-scan.pdf')) });
  await page.getByRole('button', { name: /Remove page 1/ }).click();
  await page.getByRole('button', { name: 'Read PDF' }).click();
  await expect(page.getByTestId('upload-error')).toContainText('Both readers failed');
  await expect(page.getByRole('button', { name: 'Try free reader' })).toBeVisible();
});

test('passcode: asked once, stored, wrong one gives a clear error and asks again', async ({ page }) => {
  const sent: (string | undefined)[] = [];
  await page.route('**/api/omr', async (route) => {
    const r = route.request();
    if (r.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claude: true, audiveris: false, passcode: true }) });
    const pc = r.headers()['x-app-passcode'];
    sent.push(pc);
    if (pc !== 'swordfish') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'That passcode is not right.', code: 'unauthorized' }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ musicxml: fixture('scale.musicxml'), engine: 'claude', warnings: [] }) });
  });
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(path.join(fixtures, 'sample-scan.pdf'));
  await page.getByRole('button', { name: 'Read PDF' }).click();
  await expect(page.getByTestId('upload-error')).toContainText('Enter the passcode first');
  await page.getByTestId('passcode-input').fill('wrong');
  await page.getByRole('button', { name: 'Read PDF' }).click();
  await expect(page.getByTestId('upload-error')).toContainText('not right');
  await expect(page.getByTestId('passcode-input')).toBeVisible(); // asked again
  await expect(page.getByRole('button', { name: 'Try free reader' })).toHaveCount(0);
  await page.getByTestId('passcode-input').fill('swordfish');
  await page.getByRole('button', { name: 'Read PDF' }).click();
  await page.waitForURL(/\/score\//, { timeout: 30_000 });
  expect(sent).toEqual(['wrong', 'swordfish']);
  // stored: a second scan does not ask
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(path.join(fixtures, 'sample-scan.pdf'));
  await expect(page.getByTestId('passcode-input')).toHaveCount(0);
  await page.getByRole('button', { name: 'Read PDF' }).click();
  await page.waitForURL(/\/score\//, { timeout: 30_000 });
  expect(sent[sent.length - 1]).toBe('swordfish');
});
