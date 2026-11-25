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
});
