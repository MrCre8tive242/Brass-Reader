import { test, expect } from '@playwright/test';
import { collectConsoleErrors, openScore, openPractice } from './helpers';
import { emptyPattern, makeGrooveFile, type Groove } from '../../lib/groove';

const open = async (page: import('@playwright/test').Page, id: string) => {
  await openScore(page, 'scale.musicxml', id);
  await openPractice(page, 'drums');
  await page.getByTestId('open-studio').click();
  await expect(page.getByTestId('groove-studio')).toBeVisible();
};
const kitFile = (name: string) => makeGrooveFile({ id: 'x', name, kind: 'kit', createdAt: 1, feel: 'straight', pattern: emptyPattern(16, 1) } as Groove);
const importIt = (page: import('@playwright/test').Page, name: string, text: string) =>
  page.getByLabel('Import a groove file').setInputFiles({ name: `${name}.groove.json`, mimeType: 'application/json', buffer: Buffer.from(text) });

test('a groove whose recording is garbage shows an error on its row when you press Play', async ({ page }) => {
  const errs = collectConsoleErrors(page);
  await open(page, 'gp1');
  const bad = JSON.stringify({ format: 'brass-reader-groove', version: 1, groove: { kind: 'recorded', name: 'Garbled', bpm: 100, bars: 1, durationS: 2, slices: [{ beat: 0, start: 0, end: 0.1 }] }, audio: { mime: 'audio/wav', base64: 'AAAAAAAAAAAAAAAAAAAA' } });
  await importIt(page, 'Garbled', bad);
  await expect(page.getByTestId('groove-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Play Garbled' }).click();
  await expect(page.getByTestId('preview-error')).toContainText('could not be played');
  expect(errs.filter((e) => !/decode/i.test(e))).toEqual([]);
});

test('Export uses the share sheet with the file where the phone has one, and says what it did', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __shared?: { name: string; type: string; size: number }[] };
    Object.defineProperty(navigator, 'canShare', { value: (d: ShareData) => !!d.files?.length, configurable: true });
    Object.defineProperty(navigator, 'share', { value: async (d: ShareData) => { w.__shared = (d.files ?? []).map((f) => ({ name: f.name, type: f.type, size: f.size })); }, configurable: true });
  });
  await open(page, 'gp2');
  await importIt(page, 'Mine', kitFile('Mine'));
  await expect(page.getByTestId('groove-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Export Mine' }).click();
  await expect(page.getByTestId('studio-notice')).toContainText('Shared Mine.groove.json');
  const shared = await page.evaluate(() => (window as unknown as { __shared?: unknown[] }).__shared);
  expect(shared).toMatchObject([{ name: 'Mine.groove.json', type: 'application/json' }]);
});

test('Export downloads the file when there is no share sheet, and names it', async ({ page }) => {
  await open(page, 'gp3');
  await importIt(page, 'Mine', kitFile('Mine'));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export Mine' }).click()]);
  expect(dl.suggestedFilename()).toBe('Mine.groove.json');
  await expect(page.getByTestId('studio-notice')).toContainText('Saved Mine.groove.json');
});

test('your own grooves are listed before the starter patterns; the recorder is a three-step flow', async ({ page }) => {
  await open(page, 'gp4');
  // nothing of your own yet: starters first
  const order = () => page.getByTestId('groove-studio').locator('h3.sec').allTextContents();
  expect((await order()).slice(0, 2)).toEqual(['Built in', 'Starter patterns']);
  await expect(page.getByTestId('builtin-row')).toHaveCount(1);
  await expect(page.getByTestId('builtin-row')).toContainText('Junkanoo');
  await importIt(page, 'Mine', kitFile('Mine'));
  await expect(page.getByTestId('groove-row')).toHaveCount(1);
  expect(await order()).toEqual(['Your grooves', 'Built in', 'Starter patterns']);
  await page.getByRole('button', { name: 'Record your drum line' }).click();
  const steps = page.getByTestId('rec-steps');
  await expect(steps).toContainText('1 Record');
  await expect(steps).toContainText('2 Check tempo');
  await expect(steps).toContainText('3 Save');
  await expect(steps.locator('[aria-current="step"]')).toHaveText(/Record/);
});
