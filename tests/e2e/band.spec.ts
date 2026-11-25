import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { Midi } from '@tonejs/midi';
import { seedScore, fixture, collectConsoleErrors, openScore, openPractice } from './helpers';

const staves = (page: Page) => page.evaluate(() => document.querySelectorAll('.score-host svg .vf-clef').length);

test.describe('B. ensemble', () => {
  test('a multi-part file opens on my part; full score stacks the staves; mixer controls work and are saved', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await page.goto('/');
    await page.getByTestId('xml-input').setInputFiles(`${__dirname}/../fixtures/qa-twoparts.musicxml`);
    await page.waitForURL(/\/score\//);
    await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
    await expect(page.getByLabel('Part')).toHaveValue('0');
    const one = await staves(page);
    expect(one).toBe(1);

    await openPractice(page, 'band');
    await expect(page.getByTestId('mix-row')).toHaveCount(2);
    await page.getByLabel('Show full score').check();
    await expect.poll(() => staves(page)).toBe(2);
    await expect(page.getByLabel('Part')).toHaveValue('all');
    await page.getByLabel('Show full score').uncheck();
    await expect.poll(() => staves(page)).toBe(1);

    // mute my part is one tap, in the status row and in the mixer: both show the same state
    await page.getByRole('button', { name: 'Close practice tools' }).click();
    const mute = page.getByRole('button', { name: /^(Mute|Unmute) my part$/ });
    await expect(mute).toHaveText('Mute my part');
    await mute.click();
    await expect(mute).toHaveText('Unmute my part');
    await openPractice(page, 'band');
    await expect(page.getByRole('button', { name: 'Mute A' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Solo B' }).click();
    await page.getByLabel('Volume B').fill('40');

    // each part has its own instrument (detected from its clef)
    await expect(page.getByLabel('Instrument for A')).toHaveValue('trumpet');
    await expect(page.getByLabel('Instrument for B')).toHaveValue('trombone');

    // saved with the song
    await page.waitForTimeout(300);
    await page.reload();
    await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
    await openPractice(page, 'band');
    await expect(page.getByRole('button', { name: 'Unmute my part' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Solo B' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Volume B')).toHaveValue('40');

    // plays with both parts and the cursor moves
    await page.getByRole('button', { name: 'Close practice tools' }).click();
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.getByTestId('bar-counter')).toHaveText('Bar 2 / 2', { timeout: 8000 });
    expect(errs).toEqual([]);
  });

  test('MIDI download has one track per part; MusicXML download is the multi-part score', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('xml-input').setInputFiles(`${__dirname}/../fixtures/qa-twoparts.musicxml`);
    await page.waitForURL(/\/score\//);
    await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
    const [mid] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download MIDI' }).click()]);
    const midi = new Midi(fs.readFileSync(await mid.path()));
    expect(midi.tracks).toHaveLength(2);
    expect(midi.tracks.every((t) => t.notes.length > 0)).toBe(true);
    const [xml] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download MusicXML' }).click()]);
    const text = fs.readFileSync(await xml.path(), 'utf8');
    expect((text.match(/<score-part /g) ?? []).length).toBe(2);
    expect((text.match(/<part id=/g) ?? []).length).toBe(2);
  });

  test('scanning another sheet into a song adds a part; bar counts that differ are warned about and padded with rests', async ({ page }) => {
    // my part: 4 bars (scale); the new sheet has only 2 bars
    await seedScore(page, 'band1', 'March', fixture('scale.musicxml'));
    const bass = fixture('qa-twoparts.musicxml');
    await page.route('**/api/omr', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claude: true, audiveris: false }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ musicxml: bass, engine: 'claude', warnings: [], flags: [] }) });
    });
    await page.goto('/score/band1');
    await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
    await expect(page.getByLabel('Part')).toHaveCount(0);
    await openPractice(page, 'band');
    await page.getByRole('link', { name: /Add a part/ }).click();
    await expect(page.getByTestId('add-to-banner')).toContainText('March');
    await page.getByTestId('file-input').setInputFiles(`${__dirname}/../fixtures/sample-scan.pdf`);
    await page.getByRole('button', { name: 'Read PDF' }).click();
    await expect(page.getByTestId('review')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Your part').selectOption('all');
    await page.getByRole('button', { name: 'Open score' }).click();
    await page.waitForURL(/\/score\/band1$/);
    await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
    // 1 own part + the 2 parts of the second file
    await expect(page.getByLabel('Part').locator('option')).toHaveCount(4); // 3 parts + "All parts together"
    await expect(page.getByLabel('Part')).toHaveValue('0'); // still my part, not the stacked score
    await openPractice(page, 'band');
    await expect(page.getByTestId('mix-row')).toHaveCount(3);
    // the new parts have 2 bars, mine has 4: padded, and said so
    await expect(page.getByTestId('align-warning').first()).toContainText('2 bars of rests added');
    // plays to the end of my 4 bars
    await page.getByRole('button', { name: 'Close practice tools' }).click();
    await page.getByLabel('BPM').fill('240');
    await page.getByLabel('BPM').blur();
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.getByTestId('bar-counter')).toHaveText('Bar 4 / 4', { timeout: 10_000 });
    await page.getByRole('button', { name: 'Pause' }).click().catch(() => {});
  });

  test('old single-part records keep working: no mixer rows beyond one, no part picker', async ({ page }) => {
    await openScore(page, 'scale.musicxml', 'old1');
    await expect(page.getByLabel('Part')).toHaveCount(0);
    await openPractice(page, 'band');
    await expect(page.getByTestId('mix-row')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /Mute my part/ })).toHaveCount(0);
  });
});
