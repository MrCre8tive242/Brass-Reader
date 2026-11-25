import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { collectConsoleErrors, openPractice } from './helpers';
import { fakeMic, hzOf, toneWav } from './audio';
import { openDrone } from './pitchHelpers';

test.use({ launchOptions: fakeMic(toneWav('good', hzOf(70))) });

async function recordOne(page: import('@playwright/test').Page) {
  await openPractice(page, 'record');
  await page.getByRole('button', { name: 'Record my next play-through' }).click();
  await expect(page.getByRole('button', { name: 'Recording is on' })).toBeVisible();
  await page.getByRole('button', { name: 'Close practice tools' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await openPractice(page, 'record');
  await expect(page.getByTestId('rec-indicator')).toBeVisible();
  await page.waitForTimeout(1800);
  await page.getByRole('button', { name: 'Close practice tools' }).click();
  await page.getByRole('button', { name: 'Pause' }).click();
  await openPractice(page, 'record');
}

test.describe('C2. record yourself', () => {
  test('records during playback, saves a take per score, downloads it, deletes it', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await openDrone(page, 'rc1');
    await openPractice(page, 'record');
    await expect(page.getByTestId('no-takes')).toBeVisible();
    await recordOne(page);
    await expect(page.getByTestId('take-row')).toHaveCount(1);
    await expect(page.getByTestId('rec-indicator')).toBeHidden();
    await expect(page.getByTestId('take-row')).toContainText(/Take 1/);
    await expect(page.getByTestId('take-row')).toContainText(/from bar 1/);

    // kept after a reload, and only for this score
    await page.reload();
    await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
    await openPractice(page, 'record');
    await expect(page.getByTestId('take-row')).toHaveCount(1);

    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download take 1' }).click()]);
    expect(dl.suggestedFilename()).toMatch(/^Drone-take-1\.(webm|m4a|ogg)$/);
    const bytes = fs.statSync(await dl.path()).size;
    expect(bytes).toBeGreaterThan(2000);
    const head = fs.readFileSync(await dl.path()).subarray(0, 4).toString('hex');
    expect(head).toBe('1a45dfa3'); // EBML header: a real webm file

    await page.getByRole('button', { name: 'Delete take 1' }).click();
    await expect(page.getByTestId('take-row')).toHaveCount(0);
    expect(errs).toEqual([]);
  });

  test('plays a take alone, with the backing, or the original only', async ({ page }) => {
    await openDrone(page, 'rc2');
    await recordOne(page);
    await expect(page.getByTestId('take-row')).toHaveCount(1);
    // the record switch is still armed: turn it off so takes can be played
    await page.getByRole('button', { name: 'Recording is on' }).click();

    await page.getByLabel('You alone').check();
    await page.getByRole('button', { name: 'Play take 1' }).click();
    await expect(page.getByRole('button', { name: 'Stop take 1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible(); // the score is not playing
    await page.getByRole('button', { name: 'Stop take 1' }).click();
    await expect(page.getByRole('button', { name: 'Play take 1' })).toBeVisible();

    await page.getByLabel('You + backing').check();
    await page.getByRole('button', { name: 'Play take 1' }).click();
    await expect(page.getByRole('button', { name: 'Stop take 1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible(); // the backing plays with it
    await page.getByRole('button', { name: 'Stop take 1' }).click();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

    await page.getByLabel('Original only').check();
    await page.getByRole('button', { name: 'Play take 1' }).click();
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop take 1' }).click();
  });

  test('takes of one score do not show up in another', async ({ page }) => {
    await openDrone(page, 'rc3');
    await recordOne(page);
    await expect(page.getByTestId('take-row')).toHaveCount(1);
    await openDrone(page, 'rc4');
    await openPractice(page, 'record');
    await expect(page.getByTestId('no-takes')).toBeVisible();
  });
});

test.describe('C2. recording problems', () => {
  test('microphone blocked: a clear message and nothing is armed', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })) }, configurable: true });
    });
    await openDrone(page, 'rc5');
    await openPractice(page, 'record');
    await page.getByRole('button', { name: 'Record my next play-through' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'microphone is blocked' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record my next play-through' })).toBeVisible();
  });
});
