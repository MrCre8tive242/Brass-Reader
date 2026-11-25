import { test, expect } from '@playwright/test';
import { collectConsoleErrors, openPractice } from './helpers';
import { fakeMic, hzOf, toneWav } from './audio';
import { openDrone as open, runCheck } from './pitchHelpers';

// Chromium's fake microphone plays a steady Bb4 (the note the part asks for)
test.use({ launchOptions: fakeMic(toneWav('good', hzOf(70))) });

test.describe('C1. pitch check with a real (fake-device) microphone: the right note', () => {
    test('hears the note, marks every note green and reports 100 %', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await open(page, 'pc1');
    await openPractice(page, 'pitch');
    await expect(page.getByTestId('pitch-heard')).toBeHidden();
    await page.getByRole('button', { name: 'Start pitch check' }).click();
    await expect(page.getByTestId('pitch-heard')).toContainText(/Hearing C5/, { timeout: 10_000 }); // written C5 on a Bb trumpet; it sounds Bb4
    await expect(page.getByTestId('pitch-heard')).toContainText('sounds Bb4');
    await page.getByRole('button', { name: 'Close practice tools' }).click();
    await page.getByLabel('BPM', { exact: true }).fill('240');
    await page.getByLabel('BPM', { exact: true }).blur();
    await page.getByRole('button', { name: 'Play' }).click();
    // while it plays, notes turn green as they pass
    await expect(page.locator('[data-mark="green"]').first()).toBeAttached({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-mark="green"]')).toHaveCount(4);
    await expect(page.locator('[data-mark="red"]')).toHaveCount(0);
    await openPractice(page, 'pitch');
    await expect(page.getByTestId('pitch-pct')).toHaveText('100%');
    await expect(page.getByTestId('worst-bar')).toHaveCount(0);
    expect(errs).toEqual([]);
  });

  test('stopping the check removes the colours', async ({ page }) => {
    await open(page, 'pc2');
    await runCheck(page);
    await expect(page.locator('[data-mark]')).toHaveCount(4);
    await page.getByRole('button', { name: 'Stop pitch check' }).click();
    await expect(page.locator('[data-mark]')).toHaveCount(0);
  });
});

test.describe('C1. pitch check: microphone problems', () => {
  test('permission denied shows a clear message', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) }, configurable: true });
    });
    await open(page, 'pc5');
    await openPractice(page, 'pitch');
    await page.getByRole('button', { name: 'Start pitch check' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'microphone is blocked' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start pitch check' })).toBeVisible();
  });
  test('a browser without microphone support says so', async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); });
    await open(page, 'pc6');
    await openPractice(page, 'pitch');
    await page.getByRole('button', { name: 'Start pitch check' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'cannot use the microphone' })).toBeVisible();
  });
});
