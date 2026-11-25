import { expect, type Page } from '@playwright/test';
import { seedScore, openPractice } from './helpers';
import { notationToMusicXml, parseNotation } from '../../lib/omrNotation';

// four whole notes: written C5 on a Bb trumpet sounds Bb4 (MIDI 70)
export const DRONE = notationToMusicXml(parseNotation('title: Drone\ntime: 4/4\nclef: treble\n1: C5:w\n2: C5:w\n3: C5:w\n4: C5:w')).xml;

export async function openDrone(page: Page, id: string) {
  await seedScore(page, id, 'Drone', DRONE);
  await page.goto(`/score/${id}`);
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
}
/** Switch the pitch check on, play the four bars to the end at 240 BPM, and leave the pitch section open. */
export async function runCheck(page: Page) {
  await openPractice(page, 'pitch');
  await page.getByRole('button', { name: 'Start pitch check' }).click();
  await expect(page.getByRole('button', { name: 'Stop pitch check' })).toBeVisible();
  await page.getByRole('button', { name: 'Close practice tools' }).click();
  await page.getByLabel('BPM', { exact: true }).fill('240');
  await page.getByLabel('BPM', { exact: true }).blur();
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible({ timeout: 15_000 }); // plays to the end and stops
  await openPractice(page, 'pitch');
}
