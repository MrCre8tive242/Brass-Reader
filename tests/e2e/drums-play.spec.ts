import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { Midi } from '@tonejs/midi';
import { collectConsoleErrors, openPractice, openScore } from './helpers';
import { fakeMic, drumWav } from './audio';
import { openDrone } from './pitchHelpers';

const BPM = 112;
test.use({ launchOptions: fakeMic(drumWav(BPM)) });

type Entry = { t: number; q: number; inst?: string; slice?: number };
const readLog = (page: Page) => page.evaluate(() => ((window as unknown as { __brDrumLog: Entry[] }).__brDrumLog ?? []).map((e) => ({ ...e })));
const clearLog = (page: Page) => page.evaluate(() => { const l = (window as unknown as { __brDrumLog: Entry[] }).__brDrumLog; l.length = 0; });

/** Consecutive hits sit exactly where the beat grid at `bpm` says (in seconds on the audio clock). */
function expectOnGrid(log: Entry[], bpm: number, tol = 0.02) {
  let checked = 0;
  for (let i = 1; i < log.length; i++) {
    const dq = log[i].q - log[i - 1].q;
    if (dq <= 0 || dq > 4) continue;
    expect(Math.abs(log[i].t - log[i - 1].t - (dq * 60) / bpm)).toBeLessThan(tol);
    checked++;
  }
  expect(checked).toBeGreaterThan(2);
}

async function chooseGroove(page: Page, label: string | RegExp) {
  await openPractice(page, 'drums');
  const sel = page.getByLabel('Groove', { exact: true });
  const opts = await sel.locator('option').allTextContents();
  const hit = opts.find((o) => (typeof label === 'string' ? o === label : label.test(o)))!;
  expect(hit).toBeTruthy();
  await sel.selectOption({ label: hit });
}
const setBpm = async (page: Page, n: number) => { await page.getByLabel('BPM', { exact: true }).fill(String(n)); await page.getByLabel('BPM', { exact: true }).blur(); };
const closeDrawer = (page: Page) => page.getByRole('button', { name: 'Close practice tools' }).click();

test.describe('D3. drums under the score', () => {
  test('a starter pattern: labelled, starts on beat one, stays on the grid through a tempo change and a bar jump', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await openDrone(page, 'dp1');
    await chooseGroove(page, /Starter A/);
    await expect(page.getByTestId('drums-starter-label')).toHaveText('Starter pattern — not a traditional rhythm. Fix it by ear.');
    await closeDrawer(page);
    await setBpm(page, 200);
    await clearLog(page);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForTimeout(1500);
    let log = await readLog(page);
    expect(log.length).toBeGreaterThan(5);
    expect(log[0].q).toBe(0);
    expectOnGrid(log, 200);

    // tempo change while playing: the hits after it are on the new grid
    await setBpm(page, 120);
    await page.waitForTimeout(600);
    await clearLog(page);
    await page.waitForTimeout(1500);
    log = await readLog(page);
    expectOnGrid(log, 120);

    // jump to the next bar: the next hit is on a bar line of the score
    await clearLog(page);
    await page.getByRole('button', { name: 'Next bar' }).click();
    await page.waitForTimeout(500);
    log = await readLog(page);
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].q % 4).toBe(0);
    await page.getByRole('button', { name: 'Pause' }).click();
    expect(errs).toEqual([]);
  });

  test('the choice is kept for the score; no groove or switched off means no hits', async ({ page }) => {
    await openDrone(page, 'dp2');
    await chooseGroove(page, 'Starter B · Interlock (starter, not traditional)');
    await page.getByLabel('Drums on').uncheck();
    await closeDrawer(page);
    await setBpm(page, 240);
    await clearLog(page);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForTimeout(800);
    expect(await readLog(page)).toHaveLength(0);
    await page.getByRole('button', { name: 'Pause' }).click();
    // switch on mid-way: they come in
    await openPractice(page, 'drums');
    await page.getByLabel('Drums on').check();
    await closeDrawer(page);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForTimeout(800);
    expect((await readLog(page)).length).toBeGreaterThan(3);
    await page.getByRole('button', { name: 'Pause' }).click();
    // kept after a reload
    await page.reload();
    await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
    await openPractice(page, 'drums');
    await expect(page.getByLabel('Groove', { exact: true })).toHaveValue('starter-b');
    await expect(page.getByLabel('Drums on')).toBeChecked();
    // None
    await page.getByLabel('Groove', { exact: true }).selectOption('');
    await closeDrawer(page);
    await clearLog(page);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForTimeout(600);
    expect(await readLog(page)).toHaveLength(0);
    await page.getByRole('button', { name: 'Pause' }).click();
  });

  test('triplet feel moves the off-sixteenths of a starter pattern', async ({ page }) => {
    await openDrone(page, 'dp3');
    await chooseGroove(page, /Starter B/);
    await closeDrawer(page);
    await setBpm(page, 240);
    const pitches = async () => {
      await clearLog(page);
      await page.getByRole('button', { name: 'Play', exact: true }).click();
      await page.waitForTimeout(700);
      await page.getByRole('button', { name: 'Pause' }).click();
      return [...new Set((await readLog(page)).map((e) => Math.round((e.q % 1) * 1000) / 1000))].sort();
    };
    const straight = await pitches();
    expect(straight).toContain(0.25);
    expect(straight).not.toContain(0.333);
    await openPractice(page, 'drums');
    await page.getByRole('button', { name: 'Triplet', exact: true }).click();
    await closeDrawer(page);
    const trip = await pitches();
    expect(trip).toContain(0.333);
    expect(trip).not.toContain(0.25);
  });

  test('the mixer is untouched: muting my part leaves the drums playing, and the drums are not a part', async ({ page }) => {
    await openScore(page, 'qa-twoparts.musicxml', 'dp4');
    await chooseGroove(page, /Starter A/);
    await expect(page.getByTestId('sec-band').locator('.mixrow')).toHaveCount(2);
    await closeDrawer(page);
    await page.getByRole('button', { name: 'Mute my part' }).click();
    await setBpm(page, 240);
    await clearLog(page);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForTimeout(800);
    expect((await readLog(page)).length).toBeGreaterThan(3);
    await page.getByRole('button', { name: 'Pause' }).click();
  });

  test('MIDI download can carry a drum track on channel 10', async ({ page }) => {
    await openDrone(page, 'dp5');
    await chooseGroove(page, /Starter A/);
    await page.getByLabel('Drum track in MIDI').check();
    await closeDrawer(page);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download MIDI' }).click()]);
    const m = new Midi(fs.readFileSync(await dl.path()));
    const drums = m.tracks.find((t) => t.channel === 9)!;
    expect(drums).toBeTruthy();
    expect(new Set(drums.notes.map((n) => n.midi))).toEqual(new Set([36, 47, 56, 72]));
    // and without it, no drum track
    await openPractice(page, 'drums');
    await page.getByLabel('Drum track in MIDI').uncheck();
    await closeDrawer(page);
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download MIDI' }).click()]);
    expect(new Midi(fs.readFileSync(await dl2.path())).tracks.some((t) => t.channel === 9)).toBe(false);
  });

  test('your recorded drummers play under the score, on the beat grid, in a loop too', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await openDrone(page, 'dp6');
    await openPractice(page, 'drums');
    await page.getByRole('button', { name: 'Grooves…' }).click();
    await page.getByRole('button', { name: 'Record your drum line' }).click();
    await page.getByLabel('Click tempo').fill('240');
    await page.getByLabel('Click tempo').blur();
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByTestId('rec-state')).toContainText('Recording', { timeout: 5000 });
    await page.waitForTimeout(7500);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByTestId('groove-review')).toBeVisible({ timeout: 20_000 });
    const found = Number(await page.getByLabel('Tempo BPM').inputValue());
    expect(Math.abs(found - BPM)).toBeLessThanOrEqual(2);
    await page.getByLabel('Groove name').fill('Fake band');
    await page.getByRole('button', { name: 'Save groove' }).click();
    await expect(page.getByTestId('groove-row')).toHaveCount(1);
    await page.getByRole('button', { name: 'Close grooves' }).click();

    await page.getByLabel('Groove', { exact: true }).selectOption({ label: 'Fake band' });
    await expect(page.getByTestId('drums-status')).toBeHidden({ timeout: 10_000 });
    await closeDrawer(page);
    await setBpm(page, 112);
    await clearLog(page);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForTimeout(3000);
    const log = await readLog(page);
    expect(log.length).toBeGreaterThan(6);
    expect(log[0].q).toBeLessThan(0.3); // starts with the score (the downbeat of bar 1)
    expect(log.every((e) => e.slice !== undefined)).toBe(true);
    expectOnGrid(log, 112);
    await page.getByRole('button', { name: 'Pause' }).click();

    // at another tempo the hits are played again on the new grid
    await setBpm(page, 180);
    await clearLog(page);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForTimeout(1800);
    expectOnGrid(await readLog(page), 180);
    await page.getByRole('button', { name: 'Pause' }).click();

    // loop bars 2-3: the groove comes round again exactly every 8 quarters
    await openPractice(page, 'loop');
    await page.getByLabel('Loop from bar').fill('2'); await page.getByLabel('Loop from bar').blur();
    await page.getByLabel('Loop to bar').fill('3'); await page.getByLabel('Loop to bar').blur();
    await page.getByRole('button', { name: 'Loop these bars' }).click();
    await closeDrawer(page);
    await setBpm(page, 240);
    await clearLog(page);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForTimeout(5200);
    await page.getByRole('button', { name: 'Pause' }).click();
    const l2 = await readLog(page);
    const starts = l2.filter((e) => e.q < 4.3).map((e) => e.t);
    expect(l2.every((e) => e.q >= 4 && e.q < 12)).toBe(true);
    // pass length = 8 quarters = 2 s at 240 BPM
    const firsts = starts.filter((t, i) => i === 0 || t - starts[i - 1] > 0.5);
    expect(firsts.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < firsts.length; i++) expect(Math.abs(firsts[i] - firsts[i - 1] - 2)).toBeLessThan(0.03);
    expect(errs).toEqual([]);
  });
});
