import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { collectConsoleErrors, openPractice } from './helpers';
import { fakeMic, drumWav } from './audio';
import { openDrone } from './pitchHelpers';

const BPM = 112;
test.use({ launchOptions: fakeMic(drumWav(BPM)) });

export async function openStudio(page: Page) {
  await openPractice(page, 'drums');
  await page.getByRole('button', { name: 'Grooves…' }).click();
  await expect(page.getByTestId('groove-studio')).toBeVisible();
}

/** Record about `ms` of the fake drummers and land on the review screen. */
export async function recordLine(page: Page, ms = 7500) {
  await page.getByRole('button', { name: 'Record your drum line' }).click();
  await page.getByLabel('Click tempo').fill('240');
  await page.getByLabel('Click tempo').blur();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByTestId('rec-state')).toContainText('Recording', { timeout: 5000 });
  await page.waitForTimeout(ms);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByTestId('groove-review')).toBeVisible({ timeout: 20_000 });
}

test.describe('D1. record your drum line', () => {
  test('records the fake drummers, finds the tempo, saves, renames, exports, imports, deletes', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await openDrone(page, 'dr1');
    await openStudio(page);
    await expect(page.getByTestId('no-grooves')).toBeVisible();

    await page.getByRole('button', { name: 'Record your drum line' }).click();
    await page.getByLabel('Click tempo').fill('240');
    await page.getByLabel('Click tempo').blur();
    await page.getByRole('button', { name: 'Start recording' }).click();
    // the level meter moves while the "drummers" play
    await expect(page.getByTestId('rec-state')).toContainText('Recording', { timeout: 5000 });
    let max = 0;
    for (let i = 0; i < 12; i++) { max = Math.max(max, Number(await page.getByTestId('level-meter').getAttribute('data-level'))); await page.waitForTimeout(150); }
    expect(max).toBeGreaterThan(0.05);
    await page.waitForTimeout(5500);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByTestId('groove-review')).toBeVisible({ timeout: 20_000 });

    // tempo found within 2 BPM
    const bpm = Number(await page.getByLabel('Tempo BPM').inputValue());
    expect(Math.abs(bpm - BPM)).toBeLessThanOrEqual(2);
    await expect(page.getByTestId('detected')).toContainText('Detected');
    expect(Number((await page.getByTestId('slice-count').textContent())!.match(/\d+/)![0])).toBeGreaterThan(6);

    // downbeat nudging
    const d0 = parseFloat((await page.getByTestId('downbeat-readout').textContent())!);
    await page.getByRole('button', { name: /10 milliseconds later/ }).click();
    expect(parseFloat((await page.getByTestId('downbeat-readout').textContent())!)).toBeCloseTo(d0 + 0.01, 2);
    // dragging the marker on the picture moves it
    const box = (await page.getByTestId('waveform').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + 60);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.3, box.y + 60); await page.mouse.up();
    const d1 = parseFloat((await page.getByTestId('downbeat-readout').textContent())!);
    expect(Math.abs(d1 - d0)).toBeGreaterThan(0.2);
    await page.getByRole('button', { name: '2', exact: true }).click();
    await page.getByLabel('Quantize').fill('50');
    await page.getByRole('button', { name: 'Hear the loop' }).click();
    await expect(page.getByRole('button', { name: 'Stop the loop' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop the loop' }).click();

    await page.getByLabel('Groove name').fill('Test drummers');
    await page.getByRole('button', { name: 'Save groove' }).click();
    await expect(page.getByTestId('groove-row')).toHaveCount(1);
    await expect(page.getByTestId('groove-name')).toHaveText('Test drummers');

    // kept after a reload
    await page.reload();
    await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
    await openStudio(page);
    await expect(page.getByTestId('groove-row')).toHaveCount(1);

    // rename
    await page.getByRole('button', { name: 'Rename Test drummers' }).click();
    await page.getByLabel('New name').fill('Band line');
    await page.getByRole('button', { name: 'Save name' }).click();
    await expect(page.getByTestId('groove-name')).toHaveText('Band line');

    // play in the studio, edit, close
    await page.getByRole('button', { name: 'Play Band line' }).click();
    await expect(page.getByRole('button', { name: 'Stop Band line' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop Band line' }).click();
    await page.getByRole('button', { name: 'Edit Band line' }).click();
    await expect(page.getByTestId('groove-review')).toBeVisible();
    await expect(page.getByLabel('Tempo BPM')).toHaveValue(String(bpm));
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    // export a file and import it again
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export Band line' }).click()]);
    expect(dl.suggestedFilename()).toBe('Band-line.groove.json');
    const text = fs.readFileSync(await dl.path(), 'utf8');
    const file = JSON.parse(text);
    expect(file.format).toBe('brass-reader-groove');
    expect(file.audio.base64.length).toBeGreaterThan(10_000);
    await page.getByLabel('Import a groove file').setInputFiles({ name: 'Band-line.groove.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await expect(page.getByTestId('groove-row')).toHaveCount(2);
    await page.getByLabel('Import a groove file').setInputFiles({ name: 'bad.groove.json', mimeType: 'application/json', buffer: Buffer.from('{"nope":1}') });
    await expect(page.getByRole('alert').filter({ hasText: 'groove file' })).toBeVisible();

    // delete (asks twice)
    await page.getByRole('button', { name: 'Delete Band line' }).first().click();
    await page.getByRole('button', { name: 'Really delete Band line' }).click();
    await expect(page.getByTestId('groove-row')).toHaveCount(1);
    expect(errs).toEqual([]);
  });

  test('microphone blocked: a clear message', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })) }, configurable: true });
    });
    await openDrone(page, 'dr2');
    await openStudio(page);
    await page.getByRole('button', { name: 'Record your drum line' }).click();
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'microphone is blocked' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start recording' })).toBeVisible();
  });
});
