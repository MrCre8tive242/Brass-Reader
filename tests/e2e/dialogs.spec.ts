import { test, expect, type Page } from '@playwright/test';
import { collectConsoleErrors, openScore, openPractice } from './helpers';
import { emptyPattern, makeGrooveFile, type Groove } from '../../lib/groove';

const sheet = (page: Page) => page.getByTestId('practice-sheet');
const inSheet = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('[data-testid="practice-sheet"]'));

test.describe('keyboard: Space keeps its job on controls', () => {
  test('Space on a button, a summary and a step cell does not start the music', async ({ page }) => {
    await openScore(page, 'scale.musicxml', 'kb1');
    await openPractice(page);
    // a summary: Space opens it, playback stays off
    const sum = page.getByTestId('sec-band').locator('summary');
    await sum.focus();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('sec-band')).toHaveAttribute('open', '');
    // one tool at a time: opening Band folded Loop away (its header still says what it is doing)
    await expect(page.getByTestId('sec-loop')).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('status-loop')).toHaveText('Off');
    await openPractice(page, 'loop');
    await expect(page.getByTestId('sec-band')).not.toHaveAttribute('open', '');
    // the "Loop these bars" button: Space presses it
    await page.getByRole('button', { name: 'Loop these bars' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('loop-mark').first()).toBeVisible();
    // the header and the shortcut say so
    await expect(page.getByTestId('status-loop')).toHaveText('Bars 1–2');
    await expect(page.getByTestId('practice-sheet').getByRole('link', { name: /Loop/ })).toHaveClass(/live/);
    await page.getByRole('button', { name: 'Close practice tools' }).click();
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  });
});

test.describe('the practice drawer is a real dialog', () => {
  test('focus goes in, Tab stays in, the page behind is inert, Escape closes and focus comes back', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await openScore(page, 'scale.musicxml', 'dlg1');
    const opener = page.getByRole('button', { name: 'Practice', exact: true });
    await expect(opener).toHaveText('Practice');
    await expect(opener).toHaveAttribute('aria-controls', 'practice-sheet');
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page)).toHaveAttribute('aria-modal', 'true');
    expect(await inSheet(page)).toBe(true);
    await expect(page.locator('.topbar')).toHaveAttribute('inert', '');
    await expect(page.locator('main.page')).toHaveAttribute('inert', '');
    // Tab many times: focus is only ever in the drawer or the transport
    for (let i = 0; i < 45; i++) {
      await page.keyboard.press('Tab');
      const where = await page.evaluate(() => {
        const a = document.activeElement;
        return a?.closest('[data-testid="practice-sheet"]') ? 'sheet' : a?.closest('.transport') ? 'transport' : (a?.tagName ?? 'none');
      });
      expect(['sheet', 'transport']).toContain(where);
    }
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toBeHidden();
    await expect(page.locator('.topbar')).not.toHaveAttribute('inert', '');
    await expect(opener).toBeFocused();
    expect(errs).toEqual([]);
  });

  test('the Loop section is first and open, and a section chip opens and shows another one', async ({ page }) => {
    await openScore(page, 'scale.musicxml', 'dlg2');
    await openPractice(page);
    const titles = await sheet(page).locator('.psec > summary').allTextContents();
    expect(titles[0]).toMatch(/Loop/);
    // in the order a rehearsal uses them
    expect((await sheet(page).locator('.psec-title').allTextContents()).map((t) => t.split(' ')[0])).toEqual(['Loop', 'Drums', 'Pitch', 'Record', 'Band', 'Fingerings', 'Range']);
    await expect(page.getByTestId('sec-loop')).toHaveAttribute('open', '');
    await sheet(page).getByRole('link', { name: 'Drums' }).click();
    await expect(page.getByTestId('sec-drums')).toHaveAttribute('open', '');
    await expect(page.getByLabel('Groove', { exact: true })).toBeInViewport();
    // nothing to set until a groove is chosen; then its controls appear and the header names it
    await expect(page.getByTestId('status-drums')).toHaveText('None');
    await expect(page.getByLabel('Drums on')).toHaveCount(0);
    await expect(page.getByTestId('drums-none')).toBeVisible();
    await page.getByLabel('Groove', { exact: true }).selectOption({ label: 'Starter B · Interlock (starter, not traditional)' });
    await expect(page.getByLabel('Drums on')).toBeChecked();
    await expect(page.getByTestId('status-drums')).toHaveText('B · Interlock');
    await page.getByLabel('Drums on').uncheck();
    await expect(page.getByTestId('status-drums')).toHaveText('B · Interlock · muted');
  });

  test('the Grooves studio is a dialog: focus in, Escape closes it, focus returns to the button that opened it', async ({ page }) => {
    await openScore(page, 'scale.musicxml', 'dlg3');
    await openPractice(page, 'drums');
    const open = page.getByTestId('open-studio');
    await open.focus();
    await page.keyboard.press('Enter');
    const studio = page.getByTestId('groove-studio');
    await expect(studio).toBeVisible();
    await expect(studio).toHaveAttribute('aria-modal', 'true');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="groove-studio"]'))).toBe(true);
    await expect(page.locator('.sheet')).toHaveAttribute('inert', '');
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="groove-studio"]'))).toBe(true);
    }
    // Escape inside a sub-view goes back to the list, then closes the studio
    await page.getByRole('button', { name: 'New step pattern' }).click();
    await expect(page.getByTestId('kit-editor')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('kit-editor')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(studio).toBeHidden();
    await expect(open).toBeFocused();
    // the drawer is still a dialog: its page is still inert
    await expect(page.locator('main.page')).toHaveAttribute('inert', '');
  });
});

test.describe('the drawer on a phone turned sideways', () => {
  for (const [w, h] of [[812, 375], [568, 320]] as const) {
    test(`${w}x${h}: a side panel with room to read, the transport is not covered`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await openScore(page, 'scale.musicxml', `land${w}`);
      await openPractice(page);
      const s = (await sheet(page).boundingBox())!;
      const t = (await page.locator('.transport').boundingBox())!;
      expect(s.y + s.height).toBeLessThanOrEqual(t.y + 1);
      expect(s.x + s.width).toBeGreaterThanOrEqual(w - 1);
      expect(s.width).toBeLessThan(w * 0.7); // the score stays visible beside it
      const body = (await page.locator('.sheet-body').boundingBox())!;
      expect(body.height).toBeGreaterThanOrEqual(h === 320 ? 190 : 220);
      // the first section header (Loop) is fully inside the panel
      const first = (await sheet(page).locator('.psec > summary').first().boundingBox())!;
      expect(first.y).toBeGreaterThanOrEqual(s.y);
      expect(first.y + first.height).toBeLessThanOrEqual(s.y + s.height);
    });
  }
});

test.describe('nothing is clipped and every control is at least 48 px', () => {
  for (const w of [320, 390]) {
    test(`${w} px wide: drawer with every section open`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 800 });
      await openScore(page, 'scale.musicxml', `clip${w}`);
      await openPractice(page);
      await page.evaluate(() => document.querySelectorAll('details.psec').forEach((d) => { (d as HTMLDetailsElement).open = true; }));
      const bad = await page.evaluate(() => {
        const out: string[] = [];
        const sheet = document.querySelector('[data-testid="practice-sheet"]')!;
        for (const el of Array.from(sheet.querySelectorAll<HTMLElement>('*'))) {
          if (!el.getClientRects().length) continue;
          const cs = getComputedStyle(el);
          if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
          if (['SELECT', 'INPUT', 'OPTION', 'OPTGROUP', 'svg', 'path'].includes(el.tagName)) continue;
          if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && cs.display !== 'inline') out.push(`${el.tagName}.${el.className}: ${el.scrollWidth} > ${el.clientWidth} "${(el.textContent ?? '').slice(0, 40)}"`);
        }
        const r = sheet.getBoundingClientRect();
        if (r.right > window.innerWidth + 1) out.push('sheet wider than the screen');
        return out;
      });
      expect(bad).toEqual([]);
      const small = await page.evaluate(() => {
        const out: string[] = [];
        const sheet = document.querySelector('[data-testid="practice-sheet"]')!;
        const targets = sheet.querySelectorAll<HTMLElement>('button, a[href], summary, select, label.chk, input[type="number"], input[type="range"], input[type="text"]');
        for (const el of Array.from(targets)) {
          if (!el.getClientRects().length) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 47.5 || r.height < 47.5) out.push(`${el.tagName} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        return out;
      });
      expect(small).toEqual([]);
    });
  }

  test('320 px wide: the top bar fits and the Practice button shows its word', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openScore(page, 'scale.musicxml', 'clip3');
    const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(over).toBe(false);
    const b = (await page.getByRole('button', { name: 'Practice', exact: true }).boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(48);
    await expect(page.getByRole('button', { name: 'Practice', exact: true })).toHaveText('Practice');
  });
});

test.describe('step editor', () => {
  test('beat numbers, a touch way to set a soft step, steps at least 48 px wide, visible empty cells in the light theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 320, height: 700 });
    await openScore(page, 'scale.musicxml', 'kit1');
    await openPractice(page, 'drums');
    await page.getByTestId('open-studio').click();
    await page.getByRole('button', { name: 'New step pattern' }).click();
    const kit = page.getByTestId('kit-editor');
    await expect(kit.getByTestId('legend')).toContainText('soft');
    // beat numbers 1-4 are drawn on the first cell of each beat
    const nums = await kit.locator('[role="group"][aria-label^="Bass drum"] .beatno').allTextContents();
    expect(nums).toEqual(['1', '2', '3', '4']);
    const cells = kit.locator('[role="group"][aria-label^="Bass drum"] .cell');
    expect(await cells.count()).toBe(16);
    for (let i = 0; i < 16; i++) { const r = (await cells.nth(i).boundingBox())!; expect(r.width).toBeGreaterThanOrEqual(47.5); expect(r.height).toBeGreaterThanOrEqual(47.5); }
    // the empty cell has a border you can see against the page
    const contrast = await cells.nth(1).evaluate((el) => {
      const cs = getComputedStyle(el);
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = (c: number[]) => c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
      const page = rgb(getComputedStyle(document.body).backgroundColor);
      const a = lum(rgb(cs.borderTopColor)), b = lum(page);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(2.5);
    // soft by touch: choose Soft, tap a step
    await kit.getByRole('button', { name: 'Soft', exact: true }).click();
    await cells.nth(1).click();
    await expect(cells.nth(1)).toHaveAttribute('data-v', '1');
    await kit.getByRole('button', { name: 'Normal', exact: true }).click();
    await cells.nth(2).click();
    await expect(cells.nth(2)).toHaveAttribute('data-v', '2');
    await cells.nth(1).click(); // normal over soft
    await expect(cells.nth(1)).toHaveAttribute('data-v', '2');
    await cells.nth(1).click(); // same again clears
    await expect(cells.nth(1)).toHaveAttribute('data-v', '0');
  });
});

test.describe('Grooves studio: nothing clipped, every control 48 px', () => {
  for (const w of [320, 390]) {
    test(`${w} px wide: list and step editor`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 800 });
      await openScore(page, 'scale.musicxml', `stu${w}`);
      await openPractice(page, 'drums');
      await page.getByTestId('open-studio').click();
      const file = makeGrooveFile({ id: 'x', name: 'A fairly long groove name from the band', kind: 'kit', createdAt: 1, feel: 'straight', pattern: emptyPattern(16, 1) } as Groove);
      await page.getByLabel('Import a groove file').setInputFiles({ name: 'g.groove.json', mimeType: 'application/json', buffer: Buffer.from(file) });
      await expect(page.getByTestId('groove-row')).toHaveCount(1);
      const audit = () => page.evaluate(() => {
        const out: string[] = [];
        const root = document.querySelector('[data-testid="groove-studio"]')!;
        for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
          if (!el.getClientRects().length) continue;
          const cs = getComputedStyle(el);
          if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
          if (['SELECT', 'INPUT', 'OPTION', 'svg', 'path'].includes(el.tagName)) continue;
          if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && cs.display !== 'inline') out.push(`clip ${el.tagName}.${el.className} ${el.scrollWidth}>${el.clientWidth} "${(el.textContent ?? '').slice(0, 30)}"`);
        }
        for (const el of Array.from(root.querySelectorAll<HTMLElement>('button, a[href], select, label.btn, input[type="number"], input[type="text"], input[type="range"]'))) {
          if (!el.getClientRects().length || el.classList.contains('sr-only')) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 47.5 || r.height < 47.5) out.push(`small ${el.tagName} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        return out;
      });
      expect(await audit()).toEqual([]);
      await page.getByRole('button', { name: 'New step pattern' }).click();
      await expect(page.getByTestId('kit-editor')).toBeVisible();
      expect(await audit()).toEqual([]);
    });
  }
});
