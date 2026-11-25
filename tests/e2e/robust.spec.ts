import { test, expect, type Page } from '@playwright/test';
import { collectConsoleErrors, openPractice } from './helpers';
import { fakeMic, hzOf, toneWav } from './audio';
import { openDrone } from './pitchHelpers';

test.use({ launchOptions: fakeMic(toneWav('good', hzOf(70))) });

/** From now on the browser refuses to store anything whose key starts with one of `prefixes` ("no room left"). */
async function fillTheDisk(page: Page, prefixes: string[]) {
  await page.evaluate((prefixes) => {
    const put = IDBObjectStore.prototype.put;
    (window as unknown as { __realPut: typeof put }).__realPut = put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (prefixes.some((p) => String(key).startsWith(p))) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return put.call(this, value, key);
    };
  }, prefixes);
}

test.describe('when the device is full', () => {
  test('a pattern that cannot be saved stays on screen with a plain message, and saves once there is room', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await openDrone(page, 'full1');
    await openPractice(page, 'drums');
    await page.getByRole('button', { name: 'Grooves…' }).click();
    await page.getByRole('button', { name: 'New step pattern' }).click();
    await page.getByRole('button', { name: 'Bass drum step 1: empty', exact: true }).click();
    await page.getByLabel('Pattern name').fill('Kept');
    await fillTheDisk(page, ['groove:']);
    await page.getByRole('button', { name: 'Save as my groove' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'no room left on this device to keep the groove' })).toBeVisible();
    // nothing was thrown away: the editor is still there with the step and the name
    await expect(page.getByTestId('kit-editor')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bass drum step 1: on', exact: true })).toBeVisible();
    await expect(page.getByLabel('Pattern name')).toHaveValue('Kept');
    // room again (the player deleted something): the same button now saves
    await page.evaluate(() => { IDBObjectStore.prototype.put = (window as unknown as { __realPut: typeof IDBObjectStore.prototype.put }).__realPut; });
    await page.getByRole('button', { name: 'Save as my groove' }).click();
    await expect(page.getByTestId('groove-row')).toHaveCount(1);
    await expect(page.getByTestId('groove-name')).toHaveText('Kept');
    await expect(page.getByTestId('groove-studio').getByRole('alert')).toHaveCount(0);
    expect(errs).toEqual([]);
  });

  test('practice settings that cannot be stored still work, and the player is told once', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await openDrone(page, 'full2');
    await fillTheDisk(page, ['score:']);
    await openPractice(page, 'loop');
    await page.getByRole('button', { name: 'Loop these bars' }).click();
    await expect(page.getByTestId('loop-mark').first()).toBeVisible(); // the loop works for now
    await expect(page.getByTestId('toast').filter({ hasText: 'no room left on this device to keep your settings' })).toBeVisible();
    // more settings: no second message on top, no error
    await openPractice(page, 'drums');
    await page.getByLabel('Groove', { exact: true }).selectOption({ index: 1 });
    await expect(page.getByLabel('Drums on')).toBeChecked();
    await expect(page.getByTestId('toast')).toHaveCount(1);
    expect(errs).toEqual([]);
  });

  test('a take that cannot be stored says so', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await openDrone(page, 'full3');
    await fillTheDisk(page, ['take:']);
    await openPractice(page, 'record');
    await page.getByRole('button', { name: 'Record my next play-through' }).click();
    await page.getByRole('button', { name: 'Close practice tools' }).click();
    await page.getByLabel('BPM', { exact: true }).fill('240');
    await page.getByLabel('BPM', { exact: true }).blur();
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible({ timeout: 15_000 });
    await openPractice(page, 'record');
    await expect(page.getByRole('alert').filter({ hasText: 'no room left on this device to keep the take' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('no-takes')).toBeVisible();
    expect(errs).toEqual([]);
  });
});

test('leaving the score with everything running lets go of the microphone, the sound and the clocks', async ({ page }) => {
  const errs = collectConsoleErrors(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __ctxs: AudioContext[]; __streams: MediaStream[]; __ticks: number };
    w.__ctxs = []; w.__streams = []; w.__ticks = 0;
    const Real = window.AudioContext;
    window.AudioContext = class extends Real { constructor(o?: AudioContextOptions) { super(o); w.__ctxs.push(this); } } as typeof AudioContext;
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); w.__streams.push(s); return s; };
    // every timer the page starts from now on is counted while it is alive
    const live = new Set<number>();
    const si = window.setInterval, ci = window.clearInterval;
    window.setInterval = ((fn: TimerHandler, ms?: number, ...a: unknown[]) => { const id = si(fn, ms, ...a); live.add(id); return id; }) as typeof window.setInterval;
    window.clearInterval = ((id?: number) => { if (id !== undefined) live.delete(id); ci(id); }) as typeof window.clearInterval;
    (w as unknown as { __intervals: () => number }).__intervals = () => live.size;
  });
  await openDrone(page, 'leak1');
  const baseline = await page.evaluate(() => (window as unknown as { __intervals: () => number }).__intervals());
  // drums, pitch check, a recording armed, the step editor playing a pattern
  await openPractice(page, 'drums');
  await page.getByLabel('Groove', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Grooves…' }).click();
  await page.getByRole('button', { name: 'New step pattern' }).click();
  await page.getByRole('button', { name: 'Bass drum step 1: empty', exact: true }).click();
  await page.getByRole('button', { name: 'Hear the pattern' }).click();
  await expect(page.locator('.cell.now').first()).toBeVisible();
  await page.keyboard.press('Escape'); // back to the list: the pattern stops
  await page.keyboard.press('Escape'); // studio closed
  await expect(page.getByTestId('groove-studio')).toBeHidden();
  await openPractice(page, 'pitch');
  await page.getByRole('button', { name: 'Start pitch check' }).click();
  await expect(page.getByTestId('pitch-heard')).toContainText('Hearing', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Close practice tools' }).click();
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(1200);
  const during = await page.evaluate(() => {
    const w = window as unknown as { __ctxs: AudioContext[]; __streams: MediaStream[]; __intervals: () => number; __brDrumLog: unknown[]; __brPreviewLog: unknown[] };
    return { running: w.__ctxs.filter((c) => c.state === 'running').length, liveTracks: w.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length, intervals: w.__intervals(), drums: w.__brDrumLog.length, preview: w.__brPreviewLog.length };
  });
  expect(during.running).toBe(1); // one audio context for everything
  expect(during.liveTracks).toBe(1); // one microphone, shared
  expect(during.drums).toBeGreaterThan(3);
  expect(during.intervals).toBeGreaterThan(baseline);

  // leave while it all plays (a link inside the app: the page is not reloaded)
  await page.getByRole('link', { name: 'Back to library' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => {
    const w = window as unknown as { __ctxs: AudioContext[]; __streams: MediaStream[]; __intervals: () => number; __brDrumLog: unknown[]; __brPreviewLog: unknown[] };
    return { open: w.__ctxs.filter((c) => c.state !== 'closed').length, liveTracks: w.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length, intervals: w.__intervals(), drums: w.__brDrumLog.length, preview: w.__brPreviewLog.length };
  });
  expect(after.open).toBe(0);
  expect(after.liveTracks).toBe(0);
  expect(after.intervals).toBeLessThanOrEqual(baseline);
  await page.waitForTimeout(800);
  const later = await page.evaluate(() => { const w = window as unknown as { __brDrumLog: unknown[]; __brPreviewLog: unknown[] }; return { drums: w.__brDrumLog.length, preview: w.__brPreviewLog.length }; });
  expect(later.drums).toBe(after.drums); // nothing is still scheduling hits
  expect(later.preview).toBe(after.preview);
  expect(errs).toEqual([]);
});
