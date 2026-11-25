import { test, expect, type Page } from '@playwright/test';
import { openScore } from './helpers';

/** Sample the line's x many times while playing: it must glide (many small steps forward), not jump note to note. */
async function sample(page: Page, sel: string, ms = 1600) {
  return page.evaluate(async ({ sel, ms }) => {
    const out: { x: number; bar: string }[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) out.push({ x: el.getBoundingClientRect().left, bar: document.querySelector('[data-testid="bar-counter"]')?.textContent ?? '' });
    }
    return out;
  }, { sel, ms });
}

function check(s: { x: number; bar: string }[]) {
  const distinct = new Set(s.map((p) => Math.round(p.x * 10))).size;
  expect(distinct).toBeGreaterThan(20);
  // inside one bar the line only moves forward, in small steps
  for (let i = 1; i < s.length; i++) {
    if (s[i].bar !== s[i - 1].bar) continue;
    expect(s[i].x).toBeGreaterThanOrEqual(s[i - 1].x - 0.5);
    expect(s[i].x - s[i - 1].x).toBeLessThan(40);
  }
}

test('full sheet: the moving line glides between notes', async ({ page }) => {
  await openScore(page);
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(300);
  check(await sample(page, 'img[id^="cursorImg"]'));
});

test('2 bars: the moving line glides between notes', async ({ page }) => {
  await openScore(page);
  await page.getByRole('radio', { name: '2 bars' }).click();
  await expect(page.getByTestId('twobar')).toBeVisible();
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(300);
  check(await sample(page, '[data-testid="tb-cursor"]'));
});
