import { test, expect, type Page } from '@playwright/test';
import { collectConsoleErrors, openScore, openPractice } from './helpers';

/** A finger held on a bar (touch pointer events: a mouse drags instead). */
async function press(page: Page, hold: number, move = 0) {
  const b = (await page.getByTestId('bar-highlight').boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  const init = { pointerType: 'touch', button: 0, bubbles: true, isPrimary: true };
  await page.dispatchEvent('.score-inner', 'pointerdown', { ...init, clientX: x, clientY: y });
  await page.waitForTimeout(hold);
  if (move) await page.dispatchEvent('.score-inner', 'pointermove', { ...init, clientX: x + move, clientY: y });
  return { x, y, init };
}

test.describe('long-press loop: hint, feedback, a distinct frame, an explicit way out', () => {
  test('the tip is shown, a ring fills while you hold, then the loop is announced and can be exited', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await openScore(page, 'scale.musicxml', 'lf1');
    await expect(page.getByTestId('loop-hint')).toContainText('press and hold a bar');
    const { x, y, init } = await press(page, 300);
    await expect(page.getByTestId('hold-ring')).toBeVisible();
    await page.waitForTimeout(350);
    await expect(page.getByTestId('hold-ring')).toHaveCount(0);
    await page.dispatchEvent('.score-inner', 'pointerup', { ...init, clientX: x, clientY: y });
    await expect(page.getByTestId('toast')).toContainText('Looping bar 1');
    await expect(page.getByTestId('loop-chip')).toContainText('bar 1');
    await expect(page.getByTestId('loop-hint')).toHaveCount(0);
    // the loop frame is dashed and labelled, so it is not mistaken for the cursor bar
    const mark = page.getByTestId('loop-mark').first();
    await expect(mark).toHaveCSS('border-top-style', 'dashed');
    expect(await mark.evaluate((el) => getComputedStyle(el, '::before').content)).toContain('Loop');
    await page.getByRole('button', { name: 'Exit loop' }).click();
    await expect(page.getByTestId('loop-mark')).toHaveCount(0);
    await expect(page.getByTestId('loop-chip')).toHaveCount(0);
    expect(errs).toEqual([]);
  });

  test('a finger that moves (a scroll) cancels the hold and starts no loop', async ({ page }) => {
    await openScore(page, 'scale.musicxml', 'lf2');
    const { x, y, init } = await press(page, 250, 30);
    await expect(page.getByTestId('hold-ring')).toHaveCount(0);
    await page.waitForTimeout(400);
    await page.dispatchEvent('.score-inner', 'pointerup', { ...init, clientX: x + 30, clientY: y });
    await expect(page.getByTestId('loop-mark')).toHaveCount(0);
  });

  test('Next bar past the loop leaves it and says so; inside the loop it stays', async ({ page }) => {
    await openScore(page, 'scale.musicxml', 'lf3');
    await openPractice(page);
    await page.getByLabel('Loop to bar').fill('2');
    await page.getByLabel('Loop to bar').blur();
    await page.getByRole('button', { name: 'Loop these bars' }).click();
    await page.getByRole('button', { name: 'Close practice tools' }).click();
    await page.getByRole('button', { name: 'Next bar' }).click();
    await expect(page.getByTestId('bar-counter')).toHaveText('Bar 2 / 4');
    await expect(page.getByTestId('loop-mark')).toHaveCount(2);
    await expect(page.getByTestId('toast')).toHaveCount(0);
    await page.getByRole('button', { name: 'Next bar' }).click();
    await expect(page.getByTestId('bar-counter')).toHaveText('Bar 3 / 4');
    await expect(page.getByTestId('loop-mark')).toHaveCount(0);
    await expect(page.getByTestId('toast')).toContainText('Left the loop');
    // tapping a bar outside a loop does the same
    await openPractice(page);
    await page.getByRole('button', { name: 'Loop these bars' }).click();
    await page.getByRole('button', { name: 'Close practice tools' }).click();
    await expect(page.getByTestId('loop-mark')).toHaveCount(2);
    const host = (await page.locator('.score-host').boundingBox())!;
    const b = (await page.getByTestId('bar-highlight').boundingBox())!;
    await page.mouse.click(host.x + host.width * 0.9, b.y + b.height / 2);
    await expect(page.getByTestId('loop-mark')).toHaveCount(0);
    await expect(page.getByTestId('toast')).toContainText('Left the loop');
  });
});

test('after a speed-trainer run your own tempo comes back', async ({ page }) => {
  await openScore(page, 'scale.musicxml', 'lf4');
  await openPractice(page);
  await page.getByLabel('Loop to bar').fill('1');
  await page.getByLabel('Loop to bar').blur();
  await page.getByRole('button', { name: 'Loop these bars' }).click();
  await page.getByLabel('Speed trainer').check();
  await page.getByLabel('Trainer start BPM').fill('200');
  await page.getByLabel('Trainer start BPM').blur();
  await page.getByLabel('Trainer target BPM').fill('240');
  await page.getByLabel('Trainer target BPM').blur();
  await page.getByLabel('Trainer step BPM').fill('20');
  await page.getByLabel('Trainer step BPM').blur();
  await page.getByRole('button', { name: 'Close practice tools' }).click();
  await page.getByLabel('BPM', { exact: true }).fill('90');
  await page.getByLabel('BPM', { exact: true }).blur();
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByTestId('pass-label')).toContainText(/Pass [3-9]/, { timeout: 15_000 });
  await expect(page.getByLabel('BPM', { exact: true })).toHaveValue('240');
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByLabel('BPM', { exact: true })).toHaveValue('90');
});
