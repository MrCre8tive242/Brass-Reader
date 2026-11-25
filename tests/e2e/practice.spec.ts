import { test, expect, type Page } from '@playwright/test';
import { collectConsoleErrors, openScore, openPractice } from './helpers';

const bar = (page: Page) => page.getByTestId('bar-counter');

test.describe('A. loop and speed trainer', () => {
  test('loop bars from the practice sheet: shaded, seamless wrap, cursor stays inside, saved per score', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await openScore(page);
    await openPractice(page);
    await page.getByLabel('Loop from bar').fill('1');
    await page.getByLabel('Loop to bar').fill('2');
    await page.getByLabel('Loop to bar').blur();
    await page.getByRole('button', { name: 'Loop these bars' }).click();
    await expect(page.getByTestId('loop-mark')).toHaveCount(2);
    await page.getByRole('button', { name: 'Close practice tools' }).click();

    await page.getByLabel('BPM').fill('240');
    await page.getByLabel('BPM').blur();
    await page.getByRole('button', { name: 'Play' }).click();
    // 2 bars at 240 BPM = 2 s per pass: watch for ~5 s, the counter must never leave bars 1-2
    const seen = new Set<string>();
    const t0 = Date.now();
    while (Date.now() - t0 < 5200) { seen.add((await bar(page).textContent()) ?? ''); await page.waitForTimeout(60); }
    expect([...seen].sort()).toEqual(['Bar 1 / 4', 'Bar 2 / 4']);
    await expect(page.getByTestId('pass-label')).toContainText(/Pass [3-9] · 240 BPM/);
    await page.getByRole('button', { name: 'Pause' }).click();

    // saved with the score
    await page.reload();
    await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
    await expect(page.getByTestId('loop-mark')).toHaveCount(2);
    expect(errs).toEqual([]);
  });

  test('drag across bars on the score picks a loop; clear removes it', async ({ page }) => {
    await openScore(page, 'scale.musicxml', 'p2');
    const b = await page.getByTestId('bar-highlight').boundingBox();
    const host = await page.locator('.score-host').boundingBox();
    // all four bars of the fixture sit on the first system: pick from bar 1 to bar 3 by x position
    const y = b!.y + b!.height / 2;
    const w = host!.width;
    await page.mouse.move(host!.x + 20, y);
    await page.mouse.down();
    await page.mouse.move(host!.x + w * 0.45, y, { steps: 6 });
    await page.mouse.move(host!.x + w * 0.62, y, { steps: 6 });
    await page.mouse.up();
    const n = await page.getByTestId('loop-mark').count();
    expect(n).toBeGreaterThanOrEqual(2);
    await expect(bar(page)).toHaveText('Bar 1 / 4'); // the drag did not count as a tap-to-seek on the last bar
    await openPractice(page);
    await expect(page.getByLabel('Loop from bar')).toHaveValue('1');
    await expect(page.getByLabel('Loop to bar')).toHaveValue(String(n));
    await page.getByRole('button', { name: 'Clear loop' }).click();
    await expect(page.getByTestId('loop-mark')).toHaveCount(0);
  });

  test('long press on a bar loops that bar', async ({ page }) => {
    await openScore(page, 'scale.musicxml', 'p3');
    const b = await page.getByTestId('bar-highlight').boundingBox();
    await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await expect(page.getByTestId('loop-mark')).toHaveCount(1);
  });

  test('speed trainer steps the tempo up and shows the pass', async ({ page }) => {
    await openScore(page, 'scale.musicxml', 'p4');
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
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.getByTestId('pass-label')).toHaveText('Pass 1 · 200 → 240 BPM');
    await expect(page.getByTestId('pass-label')).toHaveText('Pass 2 · 220 → 240 BPM', { timeout: 6000 });
    await expect(page.getByTestId('pass-label')).toHaveText('Pass 3 · 240 → 240 BPM', { timeout: 6000 });
    await expect(page.getByLabel('BPM')).toHaveValue('240');
    await page.getByRole('button', { name: 'Pause' }).click();
  });
});
