import { test, expect, type Page } from '@playwright/test';
import { seedScore, openPractice, collectConsoleErrors } from './helpers';
import { notationToMusicXml, parseNotation } from '../../lib/omrNotation';

// bar 2 is four octave-and-a-bit above the rest: out of range for a trumpet (written F#3 to C6)
const XML = notationToMusicXml(parseNotation('title: Range\ntime: 4/4\nclef: treble\n1: C4:q D4:q E4:q F4:q\n2: C7:q D7:q E7:q C7:q\n3: C4:w\n4: G4:w')).xml;

async function open(page: Page, id: string) {
  await seedScore(page, id, 'Range', XML);
  await page.goto(`/score/${id}`);
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
}
const summary = (page: Page) => page.getByTestId('range-summary');

test('E. out-of-range notes are highlighted and described', async ({ page }) => {
  const errs = collectConsoleErrors(page);
  await open(page, 'r1');
  await expect(page.locator('[data-mark="range"]')).toHaveCount(4);
  await openPractice(page, 'range');
  await expect(summary(page)).toContainText('4 notes out of range: 4 too high (bar 2)');
  await expect(summary(page)).toContainText('F#3 to C6');
  await page.getByLabel('Highlight notes out of range').uncheck();
  await expect(page.locator('[data-mark="range"]')).toHaveCount(0);
  await page.getByLabel('Highlight notes out of range').check();
  await expect(page.locator('[data-mark="range"]')).toHaveCount(4);
  expect(errs).toEqual([]);
});

test('E. a different instrument has a different range', async ({ page }) => {
  await open(page, 'r2');
  await page.getByRole('button', { name: 'Practice' }).click();
  await page.getByRole('button', { name: 'Close practice tools' }).click();
  await page.getByLabel('Play as').selectOption('sousaphone');
  await openPractice(page, 'range');
  await expect(summary(page)).toContainText('E1 to F4');
});

test('E. drop a looped passage an octave, step by step, undo it, and it is remembered', async ({ page }) => {
  await open(page, 'r3');
  await openPractice(page, 'loop');
  await page.getByLabel('Loop from bar').fill('2');
  await page.getByLabel('Loop to bar').fill('2');
  await page.getByLabel('Loop to bar').blur();
  await page.getByRole('button', { name: 'Loop these bars' }).click();
  await openPractice(page, 'range');
  await expect(page.getByTestId('range-offer')).toContainText('4 out-of-range notes in the loop');
  const drop = page.getByRole('button', { name: /Drop bars 2–2 an octave/ });
  await drop.click();
  await expect(summary(page)).toContainText('2 notes out of range'); // D6 and E6 are still too high
  await expect(page.getByTestId('range-moves')).toContainText('bars 2–2 -1 oct');
  await expect(page.locator('[data-mark="range"]')).toHaveCount(2);
  // the saved move survives a reload
  await page.reload();
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect(page.locator('[data-mark="range"]')).toHaveCount(2);
  await openPractice(page, 'range');
  await page.getByRole('button', { name: /Drop bars 2–2 an octave/ }).click();
  await expect(summary(page)).toContainText('Every note is inside the comfortable range');
  await expect(page.locator('[data-mark="range"]')).toHaveCount(0);
  // 8va brings it back up by one
  await page.getByRole('button', { name: /Raise bars 2–2 an octave/ }).click();
  await expect(page.locator('[data-mark="range"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo octave moves' }).click();
  await expect(page.locator('[data-mark="range"]')).toHaveCount(4);
  await expect(page.getByTestId('range-moves')).toHaveCount(0);
});

test('E. the move changes what is heard and downloaded, not just the picture', async ({ page }) => {
  await open(page, 'r4');
  await openPractice(page, 'loop');
  await page.getByLabel('Loop from bar').fill('2');
  await page.getByLabel('Loop to bar').fill('2');
  await page.getByLabel('Loop to bar').blur();
  await page.getByRole('button', { name: 'Loop these bars' }).click();
  await openPractice(page, 'range');
  await page.getByRole('button', { name: /Drop bars 2–2 an octave/ }).click();
  await page.getByRole('button', { name: /Drop bars 2–2 an octave/ }).click();
  await page.getByRole('button', { name: 'Close practice tools' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download MusicXML' }).click()]);
  const text = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  // bar 2 was C7 D7 E7 C7; two octaves down they are C5 D5 E5 C5
  const bar2 = text.split('<measure number="2"')[1].split('</measure>')[0];
  expect([...bar2.matchAll(/<octave>(\d)<\/octave>/g)].map((m) => m[1])).toEqual(['5', '5', '5', '5']);
});
