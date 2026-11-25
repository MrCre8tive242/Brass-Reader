import { test, expect } from '@playwright/test';
import { openPractice } from './helpers';
import { fakeMic, hzOf, toneWav } from './audio';
import { openDrone } from './pitchHelpers';

test.use({ launchOptions: fakeMic(toneWav('good', hzOf(70))) });

test('a "Mic on" light shows whenever the microphone is open; it closes when paused with the drawer shut', async ({ page }) => {
  await openDrone(page, 'ml1');
  const light = page.getByTestId('mic-live');
  await expect(light).toHaveCount(0);
  await openPractice(page, 'pitch');
  await page.getByRole('button', { name: 'Start pitch check' }).click();
  await expect(light).toBeVisible();
  await expect(page.getByTestId('pitch-heard')).toContainText('Hearing');
  // drawer shut and paused: the microphone is let go (and the light goes out) although the check stays on
  await page.getByRole('button', { name: 'Close practice tools' }).click();
  await expect(light).toHaveCount(0);
  // opening the drawer opens it again
  await openPractice(page);
  await expect(light).toBeVisible();
  await page.getByRole('button', { name: 'Close practice tools' }).click();
  await expect(light).toHaveCount(0);
  // playing opens it, and the first notes are not marked missed
  await page.getByLabel('BPM', { exact: true }).fill('240');
  await page.getByLabel('BPM', { exact: true }).blur();
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(light).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible({ timeout: 15_000 });
  await expect(light).toHaveCount(0);
  await expect(page.locator('[data-mark="red"]')).toHaveCount(0);
  await openPractice(page, 'pitch');
  await page.getByRole('button', { name: 'Stop pitch check' }).click();
  await expect(light).toHaveCount(0);
});

test('the pitch readout names the written note and shows the concert note in small text', async ({ page }) => {
  await openDrone(page, 'ml2');
  await openPractice(page, 'pitch');
  await page.getByRole('button', { name: 'Start pitch check' }).click();
  const heard = page.getByTestId('pitch-heard');
  await expect(heard).toContainText(/Hearing C5/, { timeout: 10_000 }); // the part asks for written C5; the trumpet sounds Bb4
  await expect(heard.locator('small')).toHaveText(/sounds Bb4/);
});
