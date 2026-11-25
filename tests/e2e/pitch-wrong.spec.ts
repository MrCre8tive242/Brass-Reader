import { test, expect } from '@playwright/test';
import { fakeMic, hzOf, toneWav } from './audio';
import { openDrone, runCheck } from './pitchHelpers';

// the microphone plays G4: a wrong note for every bar
test.use({ launchOptions: fakeMic(toneWav('bad', hzOf(67))) });

test('C1. wrong notes are red, the worst bars are listed and one is looped on tap', async ({ page }) => {
  await openDrone(page, 'pc3');
  await runCheck(page);
  await expect(page.locator('[data-mark="red"]')).toHaveCount(4);
  await expect(page.getByTestId('pitch-pct')).toHaveText('0%');
  await expect(page.getByTestId('worst-bar').first()).toContainText('Bar 1');
  await page.getByTestId('worst-bar').first().click();
  await expect(page.getByTestId('loop-mark')).toHaveCount(1);
});
