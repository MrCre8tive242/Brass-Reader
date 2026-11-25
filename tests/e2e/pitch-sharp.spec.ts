import { test, expect } from '@playwright/test';
import { fakeMic, hzOf, toneWav } from './audio';
import { openDrone, runCheck } from './pitchHelpers';

// 35 cents sharp of Bb4
test.use({ launchOptions: fakeMic(toneWav('sharp', hzOf(70.35))) });

test('C1. a slightly sharp note is yellow with an up arrow', async ({ page }) => {
  await openDrone(page, 'pc4');
  await runCheck(page);
  await expect(page.locator('[data-mark="yellow"]')).toHaveCount(4);
  await expect(page.locator('text[data-arrow="up"]')).toHaveCount(4);
});
