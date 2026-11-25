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

test('the full sheet writes fingerings in the chosen style: numbers, valve dots or both (one setting with the 2-bar view)', async ({ page }) => {
  const errs = collectConsoleErrors(page);
  await open(page, 'f4');
  await openPractice(page, 'fingerings');
  const pick = page.getByTestId('finger-style-practice');
  // default: both. Dots over every number
  await expect(pick.getByRole('radio', { name: 'Both', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('Show fingerings').check();
  await expect(page.getByTestId('status-fingerings')).toHaveText('Both');
  await expect(page.locator('text[data-finger]')).toHaveCount(8);
  await expect(page.locator('g[data-finger-icon]')).toHaveCount(8);
  await expect(page.locator('g[data-finger-icon] circle')).toHaveCount(24);
  // the dots sit over the number, both centred under the note
  const geo = await page.evaluate(() => {
    const t = document.querySelector('text[data-finger]')!.getBoundingClientRect();
    const i = document.querySelector('g[data-finger-icon]')!.getBoundingClientRect();
    const filled = [...document.querySelectorAll('g[data-finger-icon]')].map((g) => [...g.querySelectorAll('circle')].map((c) => ((c as SVGElement).style.fill !== 'none' ? 1 : 0)).join(''));
    return { dx: Math.abs((t.left + t.right) / 2 - (i.left + i.right) / 2), above: i.bottom <= t.bottom, filled };
  });
  expect(geo.dx).toBeLessThan(2);
  expect(geo.above).toBe(true);
  // A4 E4 C#5 G4 | C5 D5 F5 B4 on a trumpet: 1-2 1-2 1-2 0 | 0 1 1 2
  expect(geo.filled).toEqual(['110', '110', '110', '000', '000', '100', '100', '010']);

  await pick.getByRole('radio', { name: 'Numbers', exact: true }).click();
  await expect(page.locator('g[data-finger-icon]')).toHaveCount(0);
  await expect(page.locator('text[data-finger]')).toHaveCount(8);

  await pick.getByRole('radio', { name: 'Valve dots', exact: true }).click();
  await expect(page.locator('text[data-finger]')).toHaveCount(0);
  await expect(page.locator('g[data-finger-icon][data-finger]')).toHaveCount(8);
  await expect(page.getByTestId('status-fingerings')).toHaveText('Valve dots');

  await pick.getByRole('radio', { name: 'Off', exact: true }).click();
  await expect(page.locator('[data-finger]')).toHaveCount(0);
  await expect(page.getByLabel('Show fingerings')).toBeDisabled();
  await expect(page.getByTestId('status-fingerings')).toHaveCount(0);

  // remembered, and the same choice is there in the 2-bar view
  await pick.getByRole('radio', { name: 'Valve dots', exact: true }).click();
  await page.reload();
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect(page.locator('g[data-finger-icon][data-finger]')).toHaveCount(8);
  await page.getByRole('radio', { name: '2 bars' }).click();
  await expect(page.getByTestId('twobar')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect(page.getByTestId('twobar')).toHaveAttribute('data-style', 'dots');
  await expect(page.getByTestId('finger-style').getByRole('radio', { name: 'Valve dots', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(errs).toEqual([]);
});

test('tapping valve dots on the full sheet shows the other way to play the note', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('brass-reader:finger-style', 'dots'); localStorage.setItem('brass-reader:fingerings', '1'); });
  await open(page, 'f5');
  const first = page.locator('g[data-finger-icon]').first();
  const filled = () => first.locator('circle').evaluateAll((cs) => cs.map((c) => ((c as SVGElement).style.fill !== 'none' ? 1 : 0)).join(''));
  await first.scrollIntoViewIfNeeded();
  expect(await filled()).toBe('110'); // 1-2
  await first.click();
  expect(await filled()).toBe('001'); // the third valve alone
  await expect(page.getByTestId('bar-counter')).toHaveText('Bar 1 / 2'); // the tap did not move the music
  await first.click();
  expect(await filled()).toBe('110');
  // with both: the dots follow the number
  await openPractice(page, 'fingerings');
  await page.getByTestId('finger-style-practice').getByRole('radio', { name: 'Both', exact: true }).click();
  await page.getByRole('button', { name: 'Close practice tools' }).click();
  const num = page.locator('text[data-finger]').first();
  await num.scrollIntoViewIfNeeded();
  await num.click();
  await expect(num).toHaveText('3');
  expect(await filled()).toBe('001');
});

test('trombone on the full sheet: the slide icon over the position number', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('brass-reader:finger-style', 'both'); localStorage.setItem('brass-reader:fingerings', '1'); });
  await open(page, 'f6');
  await page.getByLabel('Play as').selectOption('trombone');
  await expect(page.locator('text[data-finger]')).toHaveCount(8);
  await expect(page.locator('g[data-finger-icon]')).toHaveCount(8);
  // a slide icon: a rail with seven ticks and one marker, no valve dots
  const icon = page.locator('g[data-finger-icon]').first();
  await expect(icon.locator('line')).toHaveCount(8);
  await expect(icon.locator('circle')).toHaveCount(1);
  await openPractice(page, 'fingerings');
  await expect(page.getByTestId('finger-style-practice').getByRole('radio', { name: 'Slide icon', exact: true })).toBeVisible();
  await expect(page.getByTestId('sec-fingerings')).toContainText('Slide positions');
});
