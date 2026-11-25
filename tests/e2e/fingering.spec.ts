import { test, expect, type Page } from '@playwright/test';
import { seedScore, openPractice, collectConsoleErrors } from './helpers';
import { notationToMusicXml, parseNotation } from '../../lib/omrNotation';

// written trumpet pitches: A4 E4 C#5 G4 (1-2, 1-2, 1-2, open)
const XML = notationToMusicXml(parseNotation('title: Valves\ntime: 4/4\nclef: treble\n1: A4:q E4:q C#5:q G4:q\n2: C5:q D5:q F5:q B4:q')).xml;

async function open(page: Page, id: string) {
  await seedScore(page, id, 'Valves', XML);
  await page.goto(`/score/${id}`);
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
}
const labels = (page: Page) => page.locator('text[data-finger]').evaluateAll((els) => els.map((e) => e.textContent));

test('C3. fingerings: off by default, valves under every note, remembered', async ({ page }) => {
  const errs = collectConsoleErrors(page);
  await open(page, 'f1');
  await expect(page.locator('text[data-finger]')).toHaveCount(0);
  await openPractice(page, 'fingerings');
  await page.getByLabel('Show fingerings').check();
  await expect(page.locator('text[data-finger]')).toHaveCount(8);
  expect(await labels(page)).toEqual(['1-2', '1-2', '1-2', '0', '0', '1', '1', '2']);
  await expect(page.getByTestId('finger-help')).toContainText('written pitch');
  await page.reload();
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect(page.locator('text[data-finger]')).toHaveCount(8);
  await openPractice(page, 'fingerings');
  await page.getByLabel('Show fingerings').uncheck();
  await expect(page.locator('text[data-finger]')).toHaveCount(0);
  expect(errs).toEqual([]);
});

test('C3. tapping a fingering shows the alternate and does not move the cursor', async ({ page }) => {
  await open(page, 'f2');
  await openPractice(page, 'fingerings');
  await page.getByLabel('Show fingerings').check();
  await page.getByRole('button', { name: 'Close practice tools' }).click();
  const first = page.locator('text[data-finger]').first();
  await first.scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Next bar' }).click();
  await expect(page.getByTestId('bar-counter')).toHaveText('Bar 2 / 2');
  await first.click();
  await expect(first).toHaveText('3'); // the third valve alone for 1-2
  await expect(page.getByTestId('bar-counter')).toHaveText('Bar 2 / 2');
  await first.click();
  await expect(first).toHaveText('1-2');
});

test('C3. the chart follows the instrument: trombone slide positions, baritone and sousaphone valves', async ({ page }) => {
  await open(page, 'f3');
  await openPractice(page, 'fingerings');
  await page.getByLabel('Show fingerings').check();
  await page.getByRole('button', { name: 'Close practice tools' }).click();
  await page.getByLabel('Play as').selectOption('trombone');
  await expect(page.locator('text[data-finger]')).toHaveCount(8);
  for (const t of await labels(page)) expect(t).toMatch(/^([1-7]|—)$/);
  await page.getByLabel('Play as').selectOption('sousaphone');
  await expect(page.locator('text[data-finger]')).toHaveCount(8);
  for (const t of await labels(page)) expect(t).toMatch(/^(0|[123](-[23])*|—)$/);
  await page.getByLabel('Play as').selectOption('baritone');
  await expect(page.locator('text[data-finger]')).toHaveCount(8);
  for (const t of await labels(page)) expect(t).toMatch(/^(0|[123](-[23])*|—)$/);
  await openPractice(page, 'fingerings');
  await expect(page.getByTestId('finger-help')).toContainText('concert pitch');
});
