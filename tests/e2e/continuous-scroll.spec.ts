import { expect, test, type Page } from '@playwright/test';
import { fixture, openScore, seedScore } from './helpers';

async function openScroll(page: Page, file: string) {
  if (file === 'long') {
    const xml = fixture('two-pages.musicxml');
    const bars = xml.match(/<measure number="2">[\s\S]*?<\/measure>/)![0];
    const more = Array.from({ length: 24 }, (_, i) => bars.replace('number="2"', `number="${17 + i}"`));
    await seedScore(page, 'long', 'Long rehearsal', xml.replace('</part>', more.join('') + '</part>'));
    await page.goto('/score/long');
  } else await openScore(page, file);
  await page.getByRole('radio', { name: 'Continuous scroll' }).click();
  await expect(page.getByTestId('continuous-scroll')).toHaveAttribute('data-busy', '0');
}

test('fixed playhead, tempo-driven motion, pause and saved view', async ({ page }) => {
  await openScroll(page, 'two-pages.musicxml');
  const pane = page.locator('.tb-pane[data-active]');
  const cursor = page.getByTestId('tb-cursor');
  const line = (await cursor.boundingBox())!;
  const stage = (await page.locator('.tb-stage').boundingBox())!;
  expect(Math.abs(line.x + line.width / 2 - stage.x - stage.width * .30)).toBeLessThan(1);
  const distanceOverTime = async () => pane.evaluate(async el => {
    const start = performance.now();
    const left = el.getBoundingClientRect().left;
    await new Promise(r => setTimeout(r, 350));
    return (left - el.getBoundingClientRect().left) / (performance.now() - start);
  });
  await page.getByLabel('BPM').fill('60');
  await page.getByLabel('BPM').blur();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForTimeout(260);
  const slow = await distanceOverTime();
  await page.getByLabel('BPM').fill('120');
  await page.getByLabel('BPM').blur();
  await page.waitForTimeout(120);
  const fast = await distanceOverTime();
  expect(slow).toBeGreaterThan(0);
  expect(fast).toBeGreaterThan(slow * 1.35);
  expect((await cursor.boundingBox())!.x).toBeCloseTo(line.x, 1);
  await page.getByRole('button', { name: 'Pause' }).click();
  expect(await distanceOverTime()).toBe(0);
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Continuous scroll' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('continuous-scroll')).toHaveAttribute('data-busy', '0');
});

test('the downbeat stays aligned after a strip handoff and a repeated ending', async ({ page }) => {
  for (const [file, target, label] of [['long', 17, '17'], ['qa-repeats.musicxml', 4, '1']] as const) {
    await openScroll(page, file);
    for (let i = 1; i < target; i++) await page.getByRole('button', { name: 'Next bar' }).click();
    await expect(page.getByTestId('bar-counter')).toContainText('Bar ' + label + ' /');
    await expect.poll(() => page.locator('.tb-pane[data-active]').evaluate(el => {
      const playhead = document.querySelector('.scroll-score .tb-cursor')!.getBoundingClientRect();
      const x = playhead.left + playhead.width / 2;
      return [...el.querySelectorAll('[data-tb-finger][data-off="0"]')].some(f => {
        const origin = (f as SVGGraphicsElement).getScreenCTM();
        return origin && Math.abs(origin.e - x) < 1;
      });
    })).toBe(true);
    await expect(page.locator('.tb-stage')).toHaveAttribute('data-bars', new RegExp(file.startsWith('qa') ? '3\\+1\\+2\\+4' : '16\\+17\\+18'));
  }
});

test('a visible note moves smoothly across the change of strips during playback', async ({ page }) => {
  await openScroll(page, 'long');
  for (let i = 1; i < 8; i++) await page.getByRole('button', { name: 'Next bar' }).click();
  await page.getByLabel('BPM').fill('240');
  await page.getByLabel('BPM').blur();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const frames = await page.evaluate(async () => {
    const stage = document.querySelector<HTMLElement>('.scroll-score .tb-stage')!;
    const start = performance.now();
    const out: { x: number; y: number; t: number; strip: string }[] = [];
    while (performance.now() - start < 1450) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const strip = stage.dataset.bars!;
      const local = strip.split('+').indexOf('9') + 1;
      const note = stage.querySelector<SVGGraphicsElement>(`.tb-pane[data-active] [data-bar="${local}"][data-off="0"]`)!;
      const pos = note.getScreenCTM()!;
      out.push({ x: pos.e, y: pos.f, t: performance.now(), strip });
    }
    return out;
  });
  expect(new Set(frames.map(f => f.strip)).size).toBe(2);
  const seam = frames.findIndex((f, i) => i > 0 && f.strip !== frames[i - 1].strip);
  const before = frames[seam - 1], after = frames[seam];
  expect(after.x).toBeLessThanOrEqual(before.x + 1);
  expect(before.x - after.x).toBeLessThan((after.t - before.t) * 0.4 + 3);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
});

test('the sample opens directly in continuous scroll at phone sizes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/score/practice-sample?view=scroll');
  await expect(page.getByRole('radio', { name: 'Continuous scroll' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('continuous-scroll')).toHaveAttribute('data-busy', '0');
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(() => page.locator('.tb-pane[data-active]').getAttribute('data-zoom')).toBe('1.4');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(844);
});

test('a one-bar loop scrolls into another copy of the same bar', async ({ page }) => {
  await openScroll(page, 'scale.musicxml');
  const stage = page.locator('.tb-stage');
  const line = (await page.getByTestId('tb-cursor').boundingBox())!;
  const touch = { pointerType: 'touch', button: 0, clientX: line.x, clientY: line.y + line.height / 2 };
  await stage.dispatchEvent('pointerdown', touch);
  await expect(page.getByTestId('loop-chip')).toContainText('bar 1');
  await stage.dispatchEvent('pointerup', touch);
  await expect(stage).toHaveAttribute('data-bars', /^1(\+1)+$/);
  await page.getByLabel('BPM').fill('240');
  await page.getByLabel('BPM').blur();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByTestId('pass-label')).toContainText('Pass 2');
  await expect(page.getByTestId('bar-counter')).toContainText('Bar 1 /');
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: 'Exit loop' }).click();
  await expect(stage).toHaveAttribute('data-bars', '1+2+3+4');
});
