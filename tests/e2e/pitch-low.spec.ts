import { test, expect } from '@playwright/test';
import { collectConsoleErrors, openPractice, seedScore } from './helpers';
import { fakeMic, hzOf, lowBrassWav } from './audio';
import { notationToMusicXml, parseNotation } from '../../lib/omrNotation';

// a sousaphone holding its low Bb1 (58 Hz) into a phone: almost nothing of the note itself reaches the microphone
test.use({ launchOptions: fakeMic(lowBrassWav('sousa', hzOf(34))) });

const LOW = notationToMusicXml(parseNotation('title: Low drone\ntime: 4/4\nclef: bass\n1: Bb1:w\n2: Bb1:w\n3: Bb1:w\n4: Bb1:w')).xml;

test('C1. a sousaphone low Bb through a phone microphone is heard in its own octave and judged green', async ({ page }) => {
  const errs = collectConsoleErrors(page);
  await seedScore(page, 'low1', 'Low drone', LOW, 'sousaphone');
  await page.goto('/score/low1');
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await openPractice(page, 'pitch');
  await page.getByRole('button', { name: 'Start pitch check' }).click();
  // the readout names the note in the octave it is played in, within a few cents
  await expect(page.getByTestId('pitch-heard')).toContainText(/Hearing Bb1 [+-]\d\b/, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Close practice tools' }).click();
  await page.getByLabel('BPM', { exact: true }).fill('200');
  await page.getByLabel('BPM', { exact: true }).blur();
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-mark="green"]')).toHaveCount(4);
  await expect(page.locator('[data-mark="red"]')).toHaveCount(0);
  await openPractice(page, 'pitch');
  await expect(page.getByTestId('pitch-pct')).toHaveText('100%');
  expect(errs).toEqual([]);
});
