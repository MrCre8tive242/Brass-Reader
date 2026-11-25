import { test, expect } from '@playwright/test';
import { seedScore, fixture, collectConsoleErrors } from './helpers';

async function openScore(page: import('@playwright/test').Page, file = 'scale.musicxml', id = 't1') {
  await seedScore(page, id, 'Test Scale', fixture(file));
  await page.goto(`/score/${id}`);
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect(page.locator('.score-host svg').first()).toBeVisible();
}
const bar = (page: import('@playwright/test').Page) => page.getByTestId('bar-counter');

test('opens a fixture, plays with moving cursor, pause/seek/bpm', async ({ page }) => {
  const errs = collectConsoleErrors(page);
  await openScore(page);
  await expect(bar(page)).toHaveText('Bar 1 / 4');
  await expect(page.locator('img[id^="cursorImg"]')).toHaveCount(1);
  const x0 = await page.locator('img[id^="cursorImg"]').evaluate((e) => e.getBoundingClientRect().left);

  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(bar(page)).toHaveText('Bar 2 / 4', { timeout: 6000 });
  const x1 = await page.locator('img[id^="cursorImg"]').evaluate((e) => e.getBoundingClientRect().left);
  expect(x1).not.toBe(x0);

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  const held = await bar(page).textContent();
  await page.waitForTimeout(700);
  expect(await bar(page).textContent()).toBe(held);

  await page.getByRole('button', { name: 'Next bar' }).click();
  await expect(bar(page)).toHaveText('Bar 3 / 4');
  await page.getByRole('button', { name: 'Previous bar' }).click();
  await page.getByRole('button', { name: 'Previous bar' }).click();
  await expect(bar(page)).toHaveText('Bar 1 / 4');

  // keyboard
  await page.keyboard.press('ArrowRight');
  await expect(bar(page)).toHaveText('Bar 2 / 4');

  // BPM
  await page.getByLabel('BPM').fill('180');
  await expect(page.getByLabel('BPM')).toHaveValue('180');
  await page.getByRole('button', { name: 'Faster' }).click();
  await expect(page.getByLabel('BPM')).toHaveValue('181');

  // seek by tapping a bar
  const hlBefore = await page.getByTestId('bar-highlight').boundingBox();
  const host = await page.locator('.score-host').boundingBox();
  expect(hlBefore).toBeTruthy();
  await page.mouse.click(host!.x + host!.width - 30, host!.y + hlBefore!.y - host!.y + hlBefore!.height / 2);
  const txt = await bar(page).textContent();
  expect(txt).not.toBe('Bar 2 / 4');
  expect(errs).toEqual([]);
});

test('plays through to the end and stops', async ({ page }) => {
  await openScore(page);
  await page.getByLabel('BPM').fill('240');
  await page.getByLabel('BPM').blur();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible({ timeout: 8000 });
  await expect(bar(page)).toHaveText('Bar 1 / 4');
});

test('instrument switch changes written part (clef, key) and downloads', async ({ page }) => {
  const errs = collectConsoleErrors(page);
  await openScore(page);
  await page.getByLabel('Play as').selectOption('trombone');
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0');
  await expect(page.locator('.score-host svg').first()).toBeVisible();

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download MusicXML' }).click()]);
  const xml = (await import('node:fs')).readFileSync((await dl.path())!, 'utf8');
  expect(xml).toContain('<sign>F</sign>');
  expect(xml).toContain('<fifths>-2</fifths>');

  const [midi] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download MIDI' }).click()]);
  const bytes = (await import('node:fs')).readFileSync((await midi.path())!);
  expect(bytes.subarray(0, 4).toString()).toBe('MThd');

  await page.getByLabel('Play as').selectOption('sousaphone');
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0');
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(bar(page)).toHaveText(/Bar [2-4] \/ 4/, { timeout: 6000 });
  expect(errs).toEqual([]);
});
