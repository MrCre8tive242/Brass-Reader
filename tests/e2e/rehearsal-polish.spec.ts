import { expect, test } from '@playwright/test';
import { fixture } from './helpers';
import { notationToMusicXml, parseNotation } from '../../lib/omrNotation';

test('the sample opens in two bars with a slow tempo and Junkanoo drums', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Try a sample' }).click();
  await expect(page.getByRole('heading', { name: 'Bay Street Warm-Up' })).toBeVisible();
  await expect(page.getByRole('radio', { name: '2 bars' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('twobar')).toHaveAttribute('data-busy', '0');
  await expect(page.getByLabel('BPM')).toHaveValue('76');
  await page.getByRole('button', { name: 'Practice' }).click();
  await expect(page.getByTestId('sec-drums')).toContainText('Junkanoo');
  await page.getByRole('button', { name: 'Close practice' }).click();
  await page.getByRole('link', { name: 'Back to library' }).click();
  await expect(page.getByTestId('empty-library')).toBeVisible();
});

test('continue practice restores the selected bar and tempo of the most recent saved score', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('xml-input').setInputFiles({
    name: 'scale.musicxml', mimeType: 'application/xml', buffer: Buffer.from(fixture('scale.musicxml')),
  });
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0');
  await page.getByRole('button', { name: 'Next bar' }).click();
  await page.getByLabel('BPM').fill('82');
  await page.getByLabel('BPM').blur();
  await page.getByRole('link', { name: 'Back to library' }).click();
  const resume = page.getByRole('link', { name: /Continue practice/ });
  await expect(resume).toContainText('Bar 2');
  await resume.click();
  await expect(page.getByTestId('bar-counter')).toContainText('Bar 2');
  await expect(page.getByLabel('BPM')).toHaveValue('82');
});

test('a flagged bar compares with the source and only changes when the player accepts the crop reading', async ({ page }) => {
  const score = (bars: string) => notationToMusicXml(parseNotation(`clef: treble\nkey: 0\ntime: 4/4\n${bars}`)).xml;
  const requests: { images: string[]; hints?: { bar?: unknown } }[] = [];
  await page.route('**/api/omr', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { claude: true } });
    const request = route.request().postDataJSON();
    requests.push(request);
    await route.fulfill({ json: request.hints?.bar
      ? { musicxml: score('1: G4:w'), engine: 'claude', flags: [], warnings: [] }
      : { musicxml: score('1: C4:w\n2: E4:w'), engine: 'claude', flags: [{ bar: '2', text: 'Unclear pitch' }], warnings: ['Bar 2: the reader was not sure.'] },
    });
  });
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles('tests/fixtures/sample-scan.pdf');
  await page.getByRole('button', { name: 'Read PDF' }).click();
  await page.getByRole('button', { name: 'Check bar 2' }).click();
  const dialog = page.getByRole('dialog', { name: 'Check bar 2' });
  await expect(dialog.getByRole('button', { name: 'Hear this bar' })).toBeVisible();
  const image = dialog.getByRole('button', { name: 'Select the bar on the original page' });
  const box = (await image.boundingBox())!;
  await image.click({ position: { x: box.width * 0.2, y: box.height * 0.14 } });
  await image.click({ position: { x: box.width * 0.65, y: box.height * 0.3 } });
  await dialog.getByRole('button', { name: 'Retry this bar' }).click();
  await expect(dialog.getByRole('heading', { name: 'New reading' })).toBeVisible();
  expect(requests[1].images).toHaveLength(1);
  expect(requests[1].hints?.bar).toEqual({ clef: 'treble', fifths: 0, beats: 4, beatType: 4 });
  await dialog.getByRole('button', { name: 'Use new reading' }).click();
  await expect(page.getByText('Bar 2 updated.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check bar 2' })).toHaveCount(0);
});
