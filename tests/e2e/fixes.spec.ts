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

for (const [inst, file] of [['trumpet', 'qa-timesig.musicxml'], ['trombone', 'qa-timesig.musicxml'], ['trombone', 'qa-twoparts.musicxml']] as const) {
  test(`bar highlight covers the whole staff for every bar (${inst}, ${file})`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await openScore(page, file, 'hl-' + inst);
    if (inst !== 'trumpet') await page.getByLabel('Play as').selectOption(inst);
    await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0');
    await page.waitForTimeout(500);
    const count = Number((await bar(page).textContent())!.match(/\/ (\d+)/)![1]);
    for (let i = 1; i <= count; i++) {
      const r = await page.evaluate(() => {
        const h = document.querySelector('[data-testid="bar-highlight"]') as HTMLElement;
        const c = document.querySelector('img[id^="cursorImg"]') as HTMLElement;
        const a = h.getBoundingClientRect(), b = c.getBoundingClientRect();
        return { hl: [a.left, a.top, a.right, a.bottom], cur: [b.left, b.top, b.right, b.bottom], shown: getComputedStyle(h).display, shadow: getComputedStyle(h).boxShadow };
      });
      expect(r.shown).toBe('block');
      expect(r.shadow).not.toBe('none');
      expect(r.hl[1]).toBeLessThanOrEqual(r.cur[1] + 1); // top covers the cursor
      expect(r.hl[3]).toBeGreaterThanOrEqual(r.cur[3] - 1);
      expect(r.hl[3] - r.hl[1]).toBeGreaterThanOrEqual(r.cur[3] - r.cur[1]); // at least staff height
      expect(r.cur[0]).toBeGreaterThanOrEqual(r.hl[0] - 2);
      expect(r.cur[2]).toBeLessThanOrEqual(r.hl[2] + 2);
      if (i < count) await page.getByRole('button', { name: 'Next bar' }).click();
    }
  });
}

test('BPM field takes free typing, clamps on blur/Enter, and persists across reload', async ({ page }) => {
  await openScore(page, 'scale.musicxml', 'bpm1');
  const bpm = page.getByLabel('BPM');
  await bpm.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('90', { delay: 60 });
  await expect(bpm).toHaveValue('90');
  await page.keyboard.press('Enter');
  await expect(bpm).toHaveValue('90');
  // clear and type again: intermediate states are not clamped
  await bpm.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await expect(bpm).toHaveValue('');
  await page.keyboard.type('150', { delay: 60 });
  await expect(bpm).toHaveValue('150');
  await bpm.blur();
  await expect(bpm).toHaveValue('150');
  // out of range clamps only on commit
  await bpm.fill('999');
  await expect(bpm).toHaveValue('999');
  await bpm.press('Enter');
  await expect(bpm).toHaveValue('240');
  await bpm.fill('5');
  await bpm.blur();
  await expect(bpm).toHaveValue('30');
  await bpm.fill('133');
  await bpm.blur();
  await page.reload();
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect(page.getByLabel('BPM')).toHaveValue('133');
  await page.reload();
  await expect(page.getByLabel('BPM')).toHaveValue('133'); // survives a second reload too
});

test('"Written for" is detected from the clef on upload and can be overridden', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('xml-input').setInputFiles(`${__dirname}/../fixtures/bass-part.musicxml`);
  await page.waitForURL(/\/score\//);
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect(page.getByLabel('Written for')).toHaveValue('trombone');
  await expect(page.getByTestId('source-hint')).toContainText('bass clef');
  await expect(page.getByLabel('Play as')).toHaveValue('trombone');
  await page.getByLabel('Written for').selectOption('trumpet');
  await expect(page.getByTestId('source-hint')).toContainText('looks like Trombone');
  await page.waitForTimeout(400); // let the library write finish
  await page.reload();
  await expect(page.getByLabel('Written for')).toHaveValue('trumpet'); // override persists

  await page.goto('/');
  await page.getByTestId('xml-input').setInputFiles(`${__dirname}/../fixtures/scale.musicxml`);
  await page.waitForURL(/\/score\//);
  await expect(page.getByLabel('Written for')).toHaveValue('trumpet');
});

test('irregular bars are padded, flagged in the UI, and the cursor stays inside the bar (empty bar fixture)', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await openScore(page, 'qa-rests.musicxml', 'rests1');
  const warn = page.getByTestId('bar-warnings');
  await expect(warn).toContainText('Bar 4 may be misread');
  const count = Number((await bar(page).textContent())!.match(/\/ (\d+)/)![1]);
  for (let i = 1; i <= count; i++) {
    const r = await page.evaluate(() => {
      const h = document.querySelector('[data-testid="bar-highlight"]')!.getBoundingClientRect();
      const c = document.querySelector('img[id^="cursorImg"]')!.getBoundingClientRect();
      return { dl: c.left - h.left, dr: h.right - c.right };
    });
    expect(r.dl, `bar ${i}`).toBeGreaterThanOrEqual(-3);
    expect(r.dr, `bar ${i}`).toBeGreaterThanOrEqual(-3);
    if (i < count) await page.getByRole('button', { name: 'Next bar' }).click();
  }
});

test('a regular score shows no bar warning', async ({ page }) => {
  await openScore(page, 'scale.musicxml', 'ok1');
  await expect(page.getByTestId('bar-warnings')).toHaveCount(0);
});

// ---------------- UX ----------------
const rect = async (page: Page, sel: string) => page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; });

test('portrait 375: transport is at most 2 rows, Play is centred and the largest, targets >= 48px', async ({ page }) => {
  await openScore(page, 'scale.musicxml', 'ux1');
  const t = await rect(page, '.transport');
  expect(t.h).toBeLessThanOrEqual(48 * 2 + 64 - 48 + 8 + 12 + 8 + 4); // two rows: 64 + 48 + gaps/padding
  const rows = await page.evaluate(() => {
    const ys = new Set<number>();
    document.querySelectorAll('.transport button, .transport input, .transport label').forEach((e) => ys.add(Math.round(e.getBoundingClientRect().top / 20)));
    return ys.size;
  });
  expect(rows).toBeLessThanOrEqual(3); // tops cluster into two bands (row 1 play is taller so its top differs slightly)
  const play = await rect(page, 'button[aria-label="Play"]');
  expect(Math.abs(play.x + play.w / 2 - 375 / 2)).toBeLessThan(3);
  for (const sel of ['button[aria-label="Previous bar"]', 'button[aria-label="Next bar"]', 'button[aria-label="Slower"]', 'button[aria-label="Faster"]', 'button[aria-label="Tap tempo"]']) {
    const r = await rect(page, sel);
    expect(r.h, sel).toBeGreaterThanOrEqual(47.5);
    expect(r.w, sel).toBeGreaterThanOrEqual(47.5);
    expect(play.w * play.h, sel).toBeGreaterThan(r.w * r.h);
  }
  for (const sel of ['.chk:nth-of-type(1)', 'label.chk >> nth=1', 'input[aria-label="BPM"]', '.zoom button']) {
    expect((await rect(page, sel)).h, sel).toBeGreaterThanOrEqual(47.5);
  }
  // no horizontal overflow, transport stays inside the viewport
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(t.r).toBeLessThanOrEqual(375.5);
  // every transport control fits inside 375 wide
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.transport *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5).length);
  expect(overflow).toBe(0);
});

test('also fits at 360px wide', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openScore(page, 'scale.musicxml', 'ux1b');
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.transport *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 0.5).length);
  expect(overflow).toBe(0);
  expect((await rect(page, '.transport')).h).toBeLessThanOrEqual(150);
});

test('landscape phone shows the score on load; transport is a slim bar', async ({ page }) => {
  await page.setViewportSize({ width: 812, height: 375 });
  await openScore(page, 'scale.musicxml', 'ux2');
  const t = await rect(page, '.transport');
  expect(t.h).toBeLessThanOrEqual(80);
  const sc = await rect(page, '.score');
  expect(sc.y).toBeLessThan(150);
  const visible = Math.min(sc.b, t.y) - Math.max(sc.y, 0);
  expect(visible).toBeGreaterThan(150); // a good chunk of the score is on screen without scrolling
  const staff = await rect(page, '.score-host svg');
  expect(staff.y + 60).toBeLessThan(t.y);
});

test('zoom -/+ resizes the score, persists, and is limited', async ({ page }) => {
  await openScore(page, 'two-pages.musicxml', 'ux3');
  const h0 = (await rect(page, '.score-host svg')).h;
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => (await rect(page, '.score-host svg')).h, { timeout: 8000 }).toBeGreaterThan(h0 * 1.2);
  expect(await page.evaluate(() => localStorage.getItem('brass-reader:zoom'))).toBe('1.3');
  await page.reload();
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect.poll(async () => (await rect(page, '.score-host svg')).h).toBeGreaterThan(h0 * 1.2);
  for (let i = 0; i < 12; i++) await page.getByRole('button', { name: 'Zoom out' }).click({ force: true, trial: false }).catch(() => {});
  await expect(page.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
});

test('rotating while the cursor is deep in the score re-scrolls to the cursor', async ({ page }) => {
  await openScore(page, 'two-pages.musicxml', 'ux4');
  for (let i = 0; i < 14; i++) await page.getByRole('button', { name: 'Next bar' }).click();
  await page.waitForTimeout(600);
  await page.setViewportSize({ width: 812, height: 375 });
  await expect.poll(async () => {
    const c = await rect(page, 'img[id^="cursorImg"]');
    const tr = await rect(page, '.transport');
    const hd = await rect(page, '.topbar');
    return c.y >= hd.b - 1 && c.b <= tr.y + 1;
  }, { timeout: 8000 }).toBe(true);
});

test('Space on a checkbox or input does not toggle playback; Space elsewhere does', async ({ page }) => {
  await openScore(page, 'scale.musicxml', 'ux5');
  await page.getByLabel('Click').focus();
  await page.keyboard.press('Space');
  await expect(page.getByLabel('Click')).toBeChecked();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  await page.getByLabel('Count-in').focus();
  await page.keyboard.press('Space');
  await expect(page.getByLabel('Count-in')).toBeChecked();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  await page.getByLabel('BPM').focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 400 } });
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
});

test('upload buttons show a focus ring; page-reorder targets are 48px; favicon exists; viewport-fit=cover', async ({ page }) => {
  const favicon: number[] = [];
  page.on('response', (r) => { if (/favicon|icon\.svg|\/icon/.test(r.url())) favicon.push(r.status()); });
  await page.goto('/');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab'); // skip to the first upload button's hidden input
  const ring = await page.evaluate(() => {
    const el = document.activeElement?.closest('label.btn') as HTMLElement | null;
    return el ? getComputedStyle(el).outlineStyle + ' ' + getComputedStyle(el).outlineWidth : 'none';
  });
  expect(ring).toMatch(/solid 3px/);
  await page.getByTestId('file-input').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
  for (const name of ['Move page 1 earlier', 'Remove page 1', 'Move page 1 later']) {
    const r = await page.getByRole('button', { name }).boundingBox();
    expect(r!.width).toBeGreaterThanOrEqual(47.5);
    expect(r!.height).toBeGreaterThanOrEqual(47.5);
  }
  expect(await page.locator('meta[name="viewport"]').getAttribute('content')).toContain('viewport-fit=cover');
  expect(await page.locator('link[rel~="icon"]').count()).toBeGreaterThan(0);
  expect(favicon.every((s) => s < 400)).toBe(true);
});

test('a pickup bar is labelled "Pickup", then Bar 1 (printed numbers)', async ({ page }) => {
  await openScore(page, 'qa-pickup.musicxml', 'pick1');
  await expect(bar(page)).toHaveText('Pickup');
  await page.getByRole('button', { name: 'Next bar' }).click();
  await expect(bar(page)).toHaveText(/^Bar 1 \/ \d+$/);
});
