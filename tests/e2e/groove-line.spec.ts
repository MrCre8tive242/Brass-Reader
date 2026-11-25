import { test, expect, type Page } from '@playwright/test';
import { collectConsoleErrors, openPractice } from './helpers';
import { fakeMic, lineWav } from './audio';
import { openDrone } from './pitchHelpers';

// a drum line at 80 BPM: the tempo that is easily heard as 160
const BPM = 80;
test.use({ launchOptions: fakeMic(lineWav(BPM)) });

async function stored(page: Page) {
  return page.evaluate(async () => new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const open = indexedDB.open('keyval-store');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const st = open.result.transaction('keyval').objectStore('keyval');
      const out: Record<string, unknown>[] = [];
      const cur = st.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { open.result.close(); resolve(out); return; }
        if (String(c.key).startsWith('groove:')) { const { audio, ...rest } = c.value as Record<string, unknown>; void audio; out.push(rest); }
        c.continue();
      };
    };
  }));
}

test('a quiet, human drum line: tempo to the count-in octave, half/double, more/fewer hits, saved with lead-ins and brought up to level', async ({ page }) => {
  const errs = collectConsoleErrors(page);
  await openDrone(page, 'gl1');
  await openPractice(page, 'drums');
  await page.getByRole('button', { name: 'Grooves…' }).click();
  await page.getByRole('button', { name: 'Record your drum line' }).click();
  await page.getByLabel('Click tempo').fill(String(BPM));
  await page.getByLabel('Click tempo').blur();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByTestId('rec-state')).toContainText('Recording', { timeout: 8000 });
  await page.waitForTimeout(8500);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByTestId('groove-review')).toBeVisible({ timeout: 20_000 });

  // the count-in said 80: the line is read as 80, not 160
  const tempo = page.getByLabel('Tempo BPM');
  const bpm = Number(await tempo.inputValue());
  expect(Math.abs(bpm - BPM)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('detected')).toContainText('Detected');
  const hits = async () => Number((await page.getByTestId('hits-found').textContent())!.match(/\d+/)![0]);
  const inLoop = async () => Number((await page.getByTestId('slice-count').textContent())!.match(/\d+/)![0]);
  const n0 = await hits();
  // 8.5 s is nearly three bars of this line (14 hits to the bar), plus whatever was heard under the count-in
  expect(n0).toBeGreaterThan(30);
  expect(n0).toBeLessThan(80);

  // one tap fixes an octave either way and keeps the same stretch of the recording as the loop
  const before = await inLoop();
  const bars = () => page.getByRole('group', { name: 'Bars in the loop' }).locator('button[aria-pressed="true"]');
  await expect(bars()).toHaveText('2');
  await page.getByRole('button', { name: 'Double the tempo' }).click();
  expect(Math.abs(Number(await tempo.inputValue()) - 2 * bpm)).toBeLessThan(0.2);
  await expect(bars()).toHaveText('4');
  expect(await inLoop()).toBe(before);
  await page.getByRole('button', { name: 'Half the tempo' }).click();
  expect(Math.abs(Number(await tempo.inputValue()) - bpm)).toBeLessThan(0.2);
  await expect(bars()).toHaveText('2');

  // a finer or coarser ear
  await page.getByRole('button', { name: 'Find fewer hits' }).click();
  await page.getByRole('button', { name: 'Find fewer hits' }).click();
  await expect.poll(hits).toBeLessThan(n0);
  await page.getByRole('button', { name: 'Find more hits' }).click();
  await page.getByRole('button', { name: 'Find more hits' }).click();
  await expect.poll(hits).toBe(n0);

  await page.getByRole('button', { name: 'Hear the loop' }).click();
  await expect(page.getByRole('button', { name: 'Stop the loop' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop the loop' }).click();
  await page.getByLabel('Groove name').fill('Quiet line');
  await page.getByRole('button', { name: 'Save groove' }).click();
  await expect(page.getByTestId('groove-row')).toHaveCount(1);

  const [g] = await stored(page);
  const slices = g.slices as { beat: number; start: number; end: number; pre?: number }[];
  expect(g.v).toBe(2);
  expect(slices.length).toBeGreaterThan(4);
  for (const s of slices) { expect(s.pre).toBeGreaterThan(0.005); expect(s.end).toBeGreaterThan(s.start + s.pre!); }
  // neighbours overlap (they cross-fade): no gap between one hit and the next
  for (let i = 1; i < slices.length; i++) expect(slices[i - 1].end).toBeGreaterThan(slices[i].start);
  expect((g.onsetStarts as number[]).length).toBe((g.onsets as number[]).length);
  // the recording peaks around 0.3 of full scale: it is brought up about threefold
  expect(g.gain as number).toBeGreaterThan(1.8);
  expect(g.gain as number).toBeLessThan(6);
  expect(errs).toEqual([]);
});
