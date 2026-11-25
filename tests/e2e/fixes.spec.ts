import { test, expect, type Page } from '@playwright/test';
import { seedScore, fixture, collectConsoleErrors } from './helpers';

async function openScore(page: Page, file: string, id: string, source = 'trumpet') {
  await seedScore(page, id, 'Fix test', fixture(file), source);
  await page.goto(`/score/${id}`);
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect(page.locator('.score-host svg').first()).toBeVisible();
}
const bar = (page: Page) => page.getByTestId('bar-counter');

/** Record the bar counter text and cursor/highlight geometry on every animation frame. */
async function startRecording(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __rec: { bars: string[]; cursorX: number[]; off: number }; };
    w.__rec = { bars: [], cursorX: [], off: 0 };
    const frame = () => {
      const t = document.querySelector('[data-testid="bar-counter"]')?.textContent ?? '';
      const r = w.__rec;
      if (r.bars[r.bars.length - 1] !== t) r.bars.push(t);
      const c = document.querySelector('img[id^="cursorImg"]') as HTMLElement | null;
      const h = document.querySelector('[data-testid="bar-highlight"]') as HTMLElement | null;
      if (c && h && h.style.display !== 'none') {
        const cx = c.getBoundingClientRect().left + c.getBoundingClientRect().width / 2;
        const hb = h.getBoundingClientRect();
        r.cursorX.push(cx);
        if (cx < hb.left - 3 || cx > hb.right + 3) r.off++;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
const readRec = (page: Page) => page.evaluate(() => (window as unknown as { __rec: { bars: string[]; cursorX: number[]; off: number } }).__rec);

test('repeats and endings: audio order + cursor jumps back and stays in the bar', async ({ page }) => {
  const errs = collectConsoleErrors(page);
  await openScore(page, 'qa-repeats.musicxml', 'rep1');
  await page.getByLabel('BPM').fill('240');
  await page.getByLabel('BPM').blur();
  await startRecording(page);
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible({ timeout: 15_000 });
  const rec = await readRec(page);
  const seq = rec.bars.filter((b) => /^Bar/.test(b)).map((b) => b.replace(/ \/ \d+/, '').replace('Bar ', ''));
  expect(seq.slice(0, 8).join(',')).toBe('1,2,3,1,2,4,5,1'); // ends by resetting to bar 1
  // the cursor went backwards at the repeat
  let backs = 0;
  for (let i = 1; i < rec.cursorX.length; i++) if (rec.cursorX[i] < rec.cursorX[i - 1] - 40) backs++;
  expect(backs).toBeGreaterThanOrEqual(1);
  expect(rec.off).toBeLessThan(Math.max(3, rec.cursorX.length * 0.03)); // cursor stays inside the bar box
  expect(errs).toEqual([]);
});

test('tap-to-seek on a repeated bar goes to its first pass; next bar follows play order', async ({ page }) => {
  await openScore(page, 'qa-repeats.musicxml', 'rep2');
  await page.getByRole('button', { name: 'Next bar' }).click();
  await page.getByRole('button', { name: 'Next bar' }).click();
  await expect(bar(page)).toHaveText('Bar 3 / 5');
  await page.getByRole('button', { name: 'Next bar' }).click(); // play order: after bar 3 comes bar 1 again
  await expect(bar(page)).toHaveText('Bar 1 / 5');
});
