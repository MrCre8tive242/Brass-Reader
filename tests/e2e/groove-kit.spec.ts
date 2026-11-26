import { test, expect, type Page } from '@playwright/test';
import { collectConsoleErrors, openPractice } from './helpers';
import { openDrone } from './pitchHelpers';

const LABEL = 'Starter pattern — not a traditional rhythm. Fix it by ear.';

async function openStudio(page: Page) {
  await openPractice(page, 'drums');
  await page.getByRole('button', { name: 'Grooves…' }).click();
  await expect(page.getByTestId('groove-studio')).toBeVisible();
}

async function hold(page: Page, label: string) {
  const b = page.getByRole('button', { name: label, exact: true });
  const box = (await b.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
}

test.describe('D2. starter kit', () => {
  test('the built-in Junkanoo groove: no starter warning, plays, copies, and is picked under the score', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await openDrone(page, 'kitj');
    await openStudio(page);
    const row = page.getByTestId('builtin-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Junkanoo');
    await expect(row).not.toContainText(LABEL);
    await page.getByRole('button', { name: 'Play Junkanoo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop Junkanoo', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stop Junkanoo', exact: true }).click();
    await page.getByRole('button', { name: 'Edit a copy of Junkanoo', exact: true }).click();
    await expect(page.getByTestId('kit-editor')).toBeVisible();
    await expect(page.getByTestId('starter-label')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cymbals step 3: accent', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deep bass drum step 1: accent', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tum tum high step 3: on', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to grooves' }).click();
    await page.getByRole('button', { name: 'Close grooves' }).click();
    await page.getByLabel('Groove', { exact: true }).selectOption({ label: 'Junkanoo' });
    await expect(page.getByTestId('drums-starter-label')).toHaveCount(0);
    await expect(page.getByLabel('Drums on')).toBeChecked();
    expect(errs).toEqual([]);
  });

  test('starter patterns carry the label and can be copied and edited', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await openDrone(page, 'kit1');
    await openStudio(page);
    await expect(page.getByTestId('starter-list')).toContainText(LABEL);
    await expect(page.getByTestId('starter-row')).toHaveCount(3);
    await expect(page.getByTestId('starter-row').first()).toContainText('Starter A · Pulse');
    // a starter plays
    await page.getByRole('button', { name: 'Play Starter A · Pulse' }).click();
    await expect(page.getByRole('button', { name: 'Stop Starter A · Pulse' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop Starter A · Pulse' }).click();
    // a copy opens in the editor, with the label, filled in as pattern A
    await page.getByRole('button', { name: 'Edit a copy of Starter A · Pulse' }).click();
    await expect(page.getByTestId('kit-editor')).toBeVisible();
    await expect(page.getByTestId('starter-label')).toHaveText(LABEL);
    await expect(page.getByRole('button', { name: 'Bass drum step 1: accent', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bass drum step 2: empty', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Bass drum step 2: empty', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Bass drum step 2: on', exact: true })).toBeVisible();
    await page.getByLabel('Pattern name').fill('Band version');
    await page.getByRole('button', { name: 'Save as my groove' }).click();
    await expect(page.getByTestId('groove-row')).toHaveCount(1);
    await expect(page.getByTestId('groove-name')).toHaveText('Band version');
    expect(errs).toEqual([]);
  });

  test('step grid: tap toggles, long-press accents, 12 steps, 2 bars, hear it, save, edit again', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await openDrone(page, 'kit2');
    await openStudio(page);
    await page.getByRole('button', { name: 'New step pattern' }).click();
    await expect(page.getByTestId('kit-editor')).toBeVisible();
    await expect(page.getByTestId('starter-label')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Lead drum step 1: empty', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Lead drum step 1: empty', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Lead drum step 1: on', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Lead drum step 1: on', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Lead drum step 1: empty', exact: true })).toBeVisible();
    await hold(page, 'Lead drum step 5: empty');
    await expect(page.getByRole('button', { name: 'Lead drum step 5: accent', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cowbell high step 3: empty', exact: true }).click();
    await page.getByRole('button', { name: 'Whistle step 16: empty', exact: true }).click();

    // 12 steps: the hits that fit stay (step 5 yes, 16 gone), two bars shows two grids
    await page.getByRole('button', { name: '12 (triplet)' }).click();
    await expect(page.getByRole('button', { name: 'Lead drum step 12: empty', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Lead drum step 13/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Lead drum step 5: accent', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '2', exact: true }).click();
    await expect(page.getByTestId('kit-bar')).toHaveCount(2);
    await page.getByRole('button', { name: 'Lead drum bar 2 step 1: empty', exact: true }).click();

    await page.getByRole('button', { name: 'Hear the pattern' }).click();
    await expect(page.getByRole('button', { name: 'Stop the pattern' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop the pattern' }).click();

    await page.getByLabel('Pattern name').fill('Mine 12');
    await page.getByRole('button', { name: 'Save as my groove' }).click();
    await expect(page.getByTestId('groove-row')).toContainText('Step pattern · 12 steps · 2 bars');

    // kept, and opens again with the same hits
    await page.reload();
    await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
    await openStudio(page);
    await page.getByRole('button', { name: 'Edit Mine 12' }).click();
    await expect(page.getByRole('button', { name: 'Lead drum bar 1 step 5: accent', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lead drum bar 2 step 1: on', exact: true })).toBeVisible();
    expect(errs).toEqual([]);
  });

  test('the editor is an instrument: a tap sounds its step, the pattern goes round with a playhead and takes edits without starting over', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await openDrone(page, 'kit3');
    await openStudio(page);
    await page.getByRole('button', { name: 'New step pattern' }).click();
    type Entry = { t: number; q: number; inst?: string };
    const log = () => page.evaluate(() => ((window as unknown as { __brPreviewLog?: Entry[] }).__brPreviewLog ?? []).map((e) => ({ ...e })));

    // putting a step down plays its sound once; clearing it is silent
    await page.getByRole('button', { name: 'Cowbell high step 1: empty', exact: true }).click();
    await expect.poll(async () => (await log()).length).toBe(1);
    expect((await log())[0]).toMatchObject({ inst: 'cowHi', q: -1 });
    await page.getByRole('button', { name: 'Cowbell high step 1: on', exact: true }).click();
    await page.getByRole('button', { name: 'Bass drum step 1: empty', exact: true }).click();
    await expect.poll(async () => (await log()).length).toBe(2);

    // it loops (more than the two bars a one-shot would give) and shows where it is
    await page.getByLabel('Preview tempo BPM').fill('200');
    await page.getByLabel('Preview tempo BPM').blur();
    await page.getByRole('button', { name: 'Hear the pattern' }).click();
    await expect(page.locator('.cell.now').first()).toBeVisible();
    await expect(page.locator('.cell.now')).toHaveCount(9); // one step of every instrument
    const col = async () => page.locator('.kitrow').first().locator('.cell').evaluateAll((els) => els.findIndex((e) => e.classList.contains('now')));
    const seen = new Set<number>();
    for (let i = 0; i < 25; i++) { seen.add(await col()); await page.waitForTimeout(60); }
    expect(seen.size).toBeGreaterThan(4);

    // an edit while it plays is heard on the next round, and the loop does not start over
    const before = (await log()).filter((e) => e.q >= 0);
    await page.getByRole('button', { name: 'Lead drum step 9: empty', exact: true }).click();
    await page.waitForTimeout(2600); // two bars at 200 BPM
    const after = (await log()).filter((e) => e.q >= 0);
    const lead = after.filter((e) => e.inst === 'lead');
    expect(lead.length).toBeGreaterThanOrEqual(1);
    expect(lead.every((e) => Math.abs((e.q % 4) - 2) < 1e-6)).toBe(true);
    // the bass drum kept coming every bar, exactly 1.2 s apart at 200 BPM, through the edit
    const bass = after.filter((e) => e.inst === 'bass').map((e) => e.t);
    expect(bass.length).toBeGreaterThan(before.filter((e) => e.inst === 'bass').length);
    for (let i = 1; i < bass.length; i++) expect(Math.abs(bass[i] - bass[i - 1] - 1.2)).toBeLessThan(0.005);
    // the tap is not doubled while the loop plays
    expect((await log()).filter((e) => e.q === -1)).toHaveLength(2);

    await page.getByRole('button', { name: 'Stop the pattern' }).click();
    await expect(page.locator('.cell.now')).toHaveCount(0);
    expect(errs).toEqual([]);
  });
});
