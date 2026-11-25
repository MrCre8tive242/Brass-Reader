import { test, expect, type Page } from '@playwright/test';
import { seedScore, fixture, collectConsoleErrors, openPractice } from './helpers';

const stage = (page: Page) => page.getByTestId('twobar');
const bars = (page: Page) => page.locator('.tb-stage');
const active = (page: Page) => page.locator('.tb-pane[data-active]');
const fingers = (page: Page) => active(page).locator('[data-tb-finger]');

async function open2(page: Page, file = 'phase3-demo.musicxml', id = 'tb1', inst = 'trumpet') {
  await seedScore(page, id, 'Two Bar Demo', fixture(file), inst);
  await page.goto(`/score/${id}`);
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await page.getByRole('radio', { name: '2 bars' }).click();
  await expect(stage(page)).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect(active(page)).toHaveCount(1);
}
const style = (page: Page, name: string) => page.getByRole('radio', { name, exact: true }).click();
/** x of every drawn note (from the drawing) and x of every fingering group: they must be the same, note by note. */
async function noteVsFinger(page: Page) {
  return active(page).evaluate((pane) => {
    const notes = JSON.parse(pane.getAttribute('data-notes') ?? '[]') as [number, number, number][];
    const fs = [...pane.querySelectorAll('[data-tb-finger]')].map((g) => ({
      bar: Number(g.getAttribute('data-bar')), off: Number(g.getAttribute('data-off')),
      x: Number((g.getAttribute('transform') ?? '').match(/translate\(([-\d.]+)/)?.[1]),
    }));
    return { notes, fs };
  });
}

for (const vp of [{ width: 375, height: 812 }, { width: 844, height: 390 }]) {
  test.describe(`2-bar view at ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test('switching on shows the first two bars with a fingering under every note, in all four styles', async ({ page }) => {
      const errs = collectConsoleErrors(page);
      await open2(page);
      await expect(bars(page)).toHaveAttribute('data-bars', '1+2');
      // default style: both. 8 eighths in bar 1; bar 2 = quarter, rest, half: 2 notes
      await expect(fingers(page)).toHaveCount(10);
      expect(await fingers(page).first().getAttribute('data-tb-finger')).toBe('1-2');
      await expect(page.getByRole('radio', { name: 'Both', exact: true })).toHaveAttribute('aria-checked', 'true');
      await expect(active(page).locator('.tb-fing circle.dot').first()).toBeVisible();
      await expect(active(page).locator('.tb-fing text.num').first()).toBeVisible();
      // each fingering sits at the x of its note
      const { notes, fs } = await noteVsFinger(page);
      expect(fs).toHaveLength(notes.length);
      for (const f of fs) {
        const n = notes.find((q) => q[0] === f.bar && Math.abs(q[1] - f.off) < 1e-3)!;
        expect(n, `note for finger ${JSON.stringify(f)}`).toBeTruthy();
        expect(Math.abs(n[2] - f.x)).toBeLessThan(1.5);
      }
      // the written fingerings of bar 1: E F# G A B C D E on a trumpet
      const texts = await fingers(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-tb-finger')));
      expect(texts).toEqual(['1-2', '2', '0', '1-2', '2', '0', '1', '0', '0', '1-2']);

      await style(page, 'Numbers');
      await expect(active(page).locator('.tb-fing circle')).toHaveCount(0);
      await expect(active(page).locator('.tb-fing text.num')).toHaveCount(10);
      await style(page, 'Valve dots');
      await expect(active(page).locator('.tb-fing text.num')).toHaveCount(0);
      await expect(active(page).locator('.tb-fing circle.dot')).toHaveCount(30);
      await expect(active(page).locator('.tb-fing circle.dot.on')).toHaveCount(2 + 1 + 0 + 2 + 1 + 0 + 1 + 0 + 0 + 2);
      await style(page, 'Off');
      await expect(fingers(page)).toHaveCount(0);
      // the choice is remembered
      await page.reload();
      await expect(stage(page)).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
      await expect(page.getByRole('radio', { name: 'Off', exact: true })).toHaveAttribute('aria-checked', 'true');
      await style(page, 'Both');
      await expect(fingers(page)).toHaveCount(10);
      expect(errs).toEqual([]);
    });

    test('nothing overflows the screen, the notation is large, the fingerings are inside the card', async ({ page }) => {
      await open2(page);
      const m = await page.evaluate(() => {
        const r = (e: Element) => e.getBoundingClientRect();
        const card = r(document.querySelector('[data-testid="twobar"]')!);
        const pane = document.querySelector('.tb-pane[data-active]')!;
        const svg = r(pane.querySelector('.tb-host svg')!);
        const fing = r(pane.querySelector('.tb-fing')!);
        const items = [...pane.querySelectorAll('[data-tb-finger]')].map((g) => r(g));
        return {
          scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, card: [card.left, card.right], svgW: svg.width,
          fingBottom: fing.bottom, cardBottom: card.bottom, itemRight: Math.max(...items.map((i) => i.right)), itemLeft: Math.min(...items.map((i) => i.left)),
          space: Number(pane.querySelector('.tb-fing')!.getAttribute('data-fs')),
        };
      });
      expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
      expect(m.card[0]).toBeGreaterThanOrEqual(0);
      expect(m.card[1]).toBeLessThanOrEqual(m.innerW);
      expect(m.itemLeft).toBeGreaterThanOrEqual(m.card[0]);
      expect(m.itemRight).toBeLessThanOrEqual(m.card[1]);
      expect(m.fingBottom).toBeLessThanOrEqual(m.cardBottom + 1);
      // fills the card's width
      expect(m.svgW).toBeGreaterThan((m.card[1] - m.card[0]) * 0.9);
      // fingering text is big enough to read
      expect(m.space).toBeGreaterThanOrEqual(10);
    });

    test('playing moves the line, and the view advances one bar when the next bar starts', async ({ page }) => {
      const errs = collectConsoleErrors(page);
      await open2(page);
      await page.getByLabel('BPM').fill('240');
      await page.getByLabel('BPM').blur();
      const x0 = await page.getByTestId('tb-cursor').evaluate((e) => (e as HTMLElement).style.transform);
      await page.getByRole('button', { name: 'Play' }).click();
      // 240 bpm: a bar is a second. First the cursor moves inside bars 1+2 ...
      await expect.poll(async () => page.getByTestId('tb-cursor').evaluate((e) => (e as HTMLElement).style.transform), { timeout: 5000 }).not.toBe(x0);
      // ... then the window is 2+3, then 3+4
      await expect(bars(page)).toHaveAttribute('data-bars', '2+3', { timeout: 5000 });
      await expect(page.getByTestId('bar-counter')).toContainText('Bar 2');
      await expect(bars(page)).toHaveAttribute('data-bars', '3+4', { timeout: 5000 });
      // the highlighted bar is always the first of the two (the one being played)
      const hl = await active(page).getByTestId('bar-highlight').boundingBox();
      const pane = await active(page).locator('.tb-host').boundingBox();
      expect(hl).toBeTruthy();
      expect(hl!.x - pane!.x).toBeLessThan(10);
      await page.getByRole('button', { name: 'Pause' }).click();
      expect(errs).toEqual([]);
    });

    test('next bar, previous bar, tapping a bar, and the last bar alone', async ({ page }) => {
      await open2(page);
      await page.getByRole('button', { name: 'Next bar' }).click();
      await expect(bars(page)).toHaveAttribute('data-bars', '2+3');
      await page.getByRole('button', { name: 'Next bar' }).click();
      await expect(bars(page)).toHaveAttribute('data-bars', '3+4');
      await page.getByRole('button', { name: 'Previous bar' }).click();
      await expect(bars(page)).toHaveAttribute('data-bars', '2+3');
      // tap the second drawn bar: it becomes the bar being played
      const boxes = JSON.parse((await active(page).getAttribute('data-boxes'))!) as number[][];
      const stg = (await bars(page).boundingBox())!;
      const b2 = boxes[1];
      await page.mouse.click(stg.x + b2[0] + b2[2] / 2, stg.y + b2[1] + Math.min(b2[3] / 2, 50));
      await expect(bars(page)).toHaveAttribute('data-bars', '3+4');
      await expect(page.getByTestId('bar-counter')).toContainText('Bar 3');
      // far end: the last bar is shown alone
      for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Next bar' }).click();
      await expect(bars(page)).toHaveAttribute('data-bars', '8');
      await expect(page.getByTestId('bar-counter')).toContainText('Bar 8');
      await expect(fingers(page)).toHaveCount(1);
    });

    test('the choice of view is remembered per score; back to the full sheet works', async ({ page }) => {
      await open2(page, 'phase3-demo.musicxml', 'tb2');
      await page.reload();
      await expect(stage(page)).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
      await page.getByRole('radio', { name: 'Full sheet' }).click();
      await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
      await expect(stage(page)).toHaveCount(0);
      await page.reload();
      await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
      await expect(page.getByRole('radio', { name: 'Full sheet' })).toHaveAttribute('aria-checked', 'true');
    });
  });
}

test.describe('2-bar view: the played order', () => {
  test('repeats: after bar 3 the next bar shown is bar 1 again; pickup bar is named', async ({ page }) => {
    await open2(page, 'qa-repeats.musicxml', 'tb3');
    await expect(bars(page)).toHaveAttribute('data-bars', '1+2');
    await page.getByRole('button', { name: 'Next bar' }).click();
    await page.getByRole('button', { name: 'Next bar' }).click();
    await expect(bars(page)).toHaveAttribute('data-bars', '3+1'); // plays 1 2 3 1 2 4 5
    await page.getByRole('button', { name: 'Next bar' }).click();
    await expect(bars(page)).toHaveAttribute('data-bars', '1+2');
    await page.getByRole('button', { name: 'Next bar' }).click();
    await expect(bars(page)).toHaveAttribute('data-bars', '2+4');
  });

  test('a pickup bar is drawn and called Pickup, the first full bar follows', async ({ page }) => {
    await open2(page, 'qa-pickup.musicxml', 'tb4');
    await expect(bars(page)).toHaveAttribute('data-bars', '1+2');
    await expect(active(page).locator('.tb-fing text.lbl').first()).toHaveText('Pickup');
    await page.getByRole('button', { name: 'Next bar' }).click();
    await expect(bars(page)).toHaveAttribute('data-bars', '2+3');
    await expect(active(page).locator('.tb-fing text.lbl').first()).toHaveText('Bar 1');
  });

  test('a practice loop: the bar after its last one is its first', async ({ page }) => {
    await open2(page, 'phase3-demo.musicxml', 'tb5');
    // long-press bar 2 (touch) to loop it, then go there
    const b = (await bars(page).boundingBox())!;
    await page.getByRole('button', { name: 'Next bar' }).click();
    await expect(bars(page)).toHaveAttribute('data-bars', '2+3');
    const init = { pointerType: 'touch', button: 0, bubbles: true, isPrimary: true };
    const hl = (await active(page).getByTestId('bar-highlight').boundingBox())!;
    const x = hl.x + hl.width / 2, y = hl.y + hl.height / 2;
    await page.dispatchEvent('.tb-stage', 'pointerdown', { ...init, clientX: x, clientY: y });
    await page.waitForTimeout(650);
    await page.dispatchEvent('.tb-stage', 'pointerup', { ...init, clientX: x, clientY: y });
    await expect(page.getByTestId('loop-chip')).toContainText('bar 2');
    // looping one bar: that bar twice
    await expect(bars(page)).toHaveAttribute('data-bars', '2+2');
    expect(b.width).toBeGreaterThan(0);
    await expect(active(page).getByTestId('loop-mark').first()).toBeVisible();
    await page.getByRole('button', { name: 'Exit loop' }).click();
    await expect(bars(page)).toHaveAttribute('data-bars', '2+3');
  });

  test('range warnings colour the notes in the 2-bar view too', async ({ page }) => {
    await open2(page, 'phase3-demo.musicxml', 'tb7');
    await page.getByLabel('Play as').selectOption('baritone');
    await expect(fingers(page)).toHaveCount(10);
    // loop bar 1 and raise it two octaves: the notes leave the comfortable range
    const init = { pointerType: 'touch', button: 0, bubbles: true, isPrimary: true };
    const hl = (await active(page).getByTestId('bar-highlight').boundingBox())!;
    const x = hl.x + hl.width / 2, y = hl.y + hl.height / 2;
    await page.dispatchEvent('.tb-stage', 'pointerdown', { ...init, clientX: x, clientY: y });
    await page.waitForTimeout(650);
    await page.dispatchEvent('.tb-stage', 'pointerup', { ...init, clientX: x, clientY: y });
    await expect(page.getByTestId('loop-chip')).toBeVisible();
    await openPractice(page, 'range');
    await page.getByRole('button', { name: /Raise bars 1–1 an octave/ }).click();
    await page.getByRole('button', { name: /Raise bars 1–1 an octave/ }).click();
    await page.getByRole('button', { name: 'Close practice tools' }).click();
    const purple = () => active(page).locator('.tb-host path').evaluateAll((els) => els.filter((e) => (e as SVGElement).style.fill === 'rgb(138, 43, 226)').length);
    await expect.poll(purple, { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test('the instrument changes the fingering under the same notes: trombone slide positions', async ({ page }) => {
    await open2(page, 'phase3-demo.musicxml', 'tb6');
    await page.getByLabel('Play as').selectOption('trombone');
    await expect(fingers(page)).toHaveCount(10);
    // positions 1-7 only; the slide icon (rail marker) is drawn in "Both"
    const texts = await fingers(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-tb-finger')));
    for (const t of texts) expect(t).toMatch(/^[1-7—]$/);
    await expect(active(page).locator('.tb-fing circle.dot').first()).toBeVisible(); // the marker
    await expect(page.getByRole('radio', { name: 'Slide icon' })).toBeVisible();
  });
});
