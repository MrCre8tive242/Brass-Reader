import { test, expect, type Page } from '@playwright/test';
import { seedScore, fixture, collectConsoleErrors } from './helpers';
import { notationToMusicXml, parseNotation } from '../../lib/omrNotation';

type Sent = { images: string[]; engine: string; tiles?: number[]; hints?: { instrument?: string; part?: string } };

/** Stub the reader. `reply` can change between calls. */
async function stubReader(page: Page, reply: () => Record<string, unknown>) {
  const seen: Sent[] = [];
  await page.route('**/api/omr', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ claude: true, audiveris: false }) });
    seen.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply()) });
  });
  return seen;
}

/**
 * A fake phone photo made in the page: grey paper with a strong light gradient (bright top-left, shadow
 * bottom-right), `systems` staves with bar lines, and a wide gap in the middle of the page.
 */
async function fakePhoto(page: Page, w: number, h: number, opts: { exifOrientation?: number } = {}): Promise<Buffer> {
  const b64 = await page.evaluate(({ w, h }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, 'rgb(236,228,205)'); grad.addColorStop(1, 'rgb(105,98,84)');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(15,15,20,0.9)';
    const tops = [0.06, 0.17, 0.28, 0.39, 0.56, 0.67, 0.78, 0.89].map((f) => Math.round(f * h));
    const sp = Math.round(h * 0.012);
    for (const top of tops) {
      for (let l = 0; l < 5; l++) g.fillRect(w * 0.08, top + l * sp, w * 0.84, Math.max(2, Math.round(h / 900)));
      for (let b = 0; b <= 4; b++) g.fillRect(w * 0.08 + (w * 0.84 * b) / 4, top, 3, sp * 4);
      for (let n = 0; n < 12; n++) { g.beginPath(); g.ellipse(w * 0.12 + n * w * 0.065, top + ((n * 7) % 5) * sp * 0.5 + sp, sp * 0.62, sp * 0.45, -0.3, 0, 7); g.fill(); }
    }
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }, { w, h });
  let buf = Buffer.from(b64, 'base64');
  if (opts.exifOrientation) {
    // APP1 "Exif" segment with a single Orientation tag, inserted right after the JPEG start marker
    const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0, 0, 0, opts.exifOrientation, 0, 0, 0, 0, 0, 0, 0]);
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const seg = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
    buf = Buffer.concat([buf.subarray(0, 2), seg, buf.subarray(2)]);
  }
  return buf;
}

/** Decode a data URL in the page and sample pixels at relative positions. */
async function inspect(page: Page, src: string, points: [number, number][]) {
  return page.evaluate(async ({ src, points }) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d')!; g.drawImage(img, 0, 0);
    const px = points.map(([fx, fy]) => Array.from(g.getImageData(Math.round(fx * (c.width - 1)), Math.round(fy * (c.height - 1)), 1, 1).data.slice(0, 3)));
    return { w: c.width, h: c.height, px };
  }, { src, points });
}

const twoParts = () => notationToMusicXml(parseNotation(
  'title: Parade Tune\npart: Trumpet 1\nclef: treble\nkey: 2b\ntime: 4/4\n1: B4:q C5:q D5:q E5:q\n2: F5:h D5:h\n3: C5:q C5:q B4:h\n4: B4:w\n'
  + 'part: Trombone\nclef: bass\nkey: 2b\n1: B2:h F3:h\n2: B2:h F3:h\n3: E3:h F3:h\n4: B2:w')).xml;

test('a phone photo is cleaned up, cut at the gap between systems and sent with its page layout', async ({ page }) => {
  const seen = await stubReader(page, () => ({ musicxml: fixture('scale.musicxml'), engine: 'claude', warnings: [], flags: [] }));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'IMG_0042.jpg', mimeType: 'image/jpeg', buffer: await fakePhoto(page, 1800, 2400) });
  await page.getByRole('button', { name: 'Read 1 page' }).click();
  await expect(page.getByTestId('review')).toBeVisible({ timeout: 30_000 });
  expect(seen).toHaveLength(1);
  expect(seen[0].tiles).toEqual([2]); // one page, sent as a top and a bottom image
  expect(seen[0].images).toHaveLength(2);
  const top = await inspect(page, seen[0].images[0], [[0.02, 0.02], [0.98, 0.5], [0.5, 0.995]]);
  const bottom = await inspect(page, seen[0].images[1], [[0.02, 0.5], [0.98, 0.97], [0.5, 0.005]]);
  // both halves keep the full width and together cover the page; the cut is in the wide gap (45-55 %)
  expect(top.w).toBe(1800);
  expect(bottom.w).toBe(1800);
  expect(top.h + bottom.h).toBe(2400);
  expect(top.h / 2400).toBeGreaterThan(0.45);
  expect(top.h / 2400).toBeLessThan(0.56);
  // paper is white everywhere, including what was the deep shadow, and the result is grey (no colour cast)
  for (const p of [...top.px, ...bottom.px]) {
    expect(Math.min(...p), JSON.stringify(p)).toBeGreaterThan(238);
    expect(Math.max(...p) - Math.min(...p)).toBeLessThan(6);
  }
  // ink stays dark: a note head in the top system and one in the last (shadowed) system
  const ink = await page.evaluate(async (srcs) => {
    const darkest = async (src: string) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d')!; g.drawImage(img, 0, 0);
      const d = g.getImageData(0, Math.round(c.height * 0.7), c.width, Math.round(c.height * 0.25)).data;
      let min = 255; for (let i = 0; i < d.length; i += 4) if (d[i] < min) min = d[i];
      return min;
    };
    return [await darkest(srcs[0]), await darkest(srcs[1])];
  }, seen[0].images);
  expect(ink[0]).toBeLessThan(40);
  expect(ink[1]).toBeLessThan(40);
  // a camera file name is not used as the title
  await expect(page.getByLabel('Title')).toHaveValue('Simple Scale');
});

test('EXIF orientation from the camera and the manual rotate button are both applied', async ({ page }) => {
  const seen = await stubReader(page, () => ({ musicxml: fixture('scale.musicxml'), engine: 'claude', warnings: [], flags: [] }));
  await page.goto('/');
  // stored 1200 x 800, EXIF says "rotate 90 degrees clockwise to view": the upright page is 800 x 1200
  await page.getByTestId('file-input').setInputFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: await fakePhoto(page, 1200, 800, { exifOrientation: 6 }) });
  await page.getByRole('button', { name: 'Read 1 page' }).click();
  await expect(page.getByTestId('review')).toBeVisible({ timeout: 30_000 });
  const a = await inspect(page, seen[0].images[0], []);
  expect([a.w, a.h]).toEqual([800, 1200]);
  // turn it once more by hand: back to landscape
  await page.getByRole('button', { name: 'Rotate page 1' }).click();
  await expect(page.locator('.thumb img')).toHaveAttribute('style', /rotate\(90deg\)/);
  await page.getByRole('button', { name: 'Read 1 page' }).click();
  await expect.poll(() => seen.length, { timeout: 30_000 }).toBe(2);
  const b = await inspect(page, seen[1].images[0], []);
  expect([b.w, b.h]).toEqual([1200, 800]);
});

test('review step: facts, things to check, part choice, hints sent, read again, then the score opens on the chosen part', async ({ page }) => {
  const errs = collectConsoleErrors(page);
  let call = 0;
  const seen = await stubReader(page, () => (++call === 1
    ? { musicxml: twoParts(), engine: 'claude', warnings: ['Bar 3 may be misread (has 3 of 4 beats).', 'Bar 2: the reader was not sure (second note may be D5 or E5).'], flags: [{ bar: '2', text: 'second note may be D5 or E5' }] }
    : { musicxml: twoParts(), engine: 'claude', warnings: [], flags: [{ bar: '2', text: 'second note may be D5 or E5' }] }));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({ name: 'march.png', mimeType: 'image/png', buffer: await fakePhoto(page, 600, 800) });
  await page.getByLabel('Scan is written for').selectOption('trumpet');
  await page.getByText('The page shows several instruments').click();
  await page.getByLabel('Only read this part').fill('Trumpet 1');
  await page.getByRole('button', { name: 'Read 1 page' }).click();
  const review = page.getByTestId('review');
  await expect(review).toBeVisible({ timeout: 30_000 });
  expect(seen[0].hints).toEqual({ instrument: 'trumpet', part: 'Trumpet 1' });
  expect(seen[0].tiles).toEqual([1]); // a small photo is not cut
  await expect(page.getByLabel('Title')).toHaveValue('Parade Tune');
  await expect(page.getByTestId('review-facts')).toHaveText(/Clef\s*treble\s*Key\s*2 flats\s*Time\s*4\/4\s*Bars\s*4/);
  await expect(page.getByTestId('review-warnings')).toContainText('2 things to check');
  await expect(page.getByTestId('review-warnings')).toContainText('Bar 3 may be misread');
  // nothing is saved until the player says so
  await expect(page.getByTestId('empty-library')).toBeVisible();
  // the other part
  await page.getByLabel('Your part').selectOption('1');
  await expect(page.getByTestId('review-facts')).toHaveText(/Clef\s*bass/);
  await expect(review).toContainText('The page is in bass clef, but Bb Trumpet normally reads treble clef');
  // read again: a second scan, this time clean
  await page.getByRole('button', { name: 'Read again' }).click();
  await expect(page.getByTestId('review-ok')).toBeVisible({ timeout: 30_000 });
  expect(seen).toHaveLength(2);
  await page.getByLabel('Title').fill('Parade Tune (my part)');
  await page.getByRole('button', { name: 'Open score' }).click();
  await page.waitForURL(/\/score\//);
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect(page.locator('h1.title')).toHaveText('Parade Tune (my part)');
  // first part by default after a re-read; the picker switches to the trombone line
  await expect(page.getByLabel('Part')).toHaveValue('0');
  await expect(page.getByTestId('bar-counter')).toHaveText('Bar 1 / 4');
  // the reader's own doubt is listed and marked on the score
  await expect(page.getByTestId('bar-warnings')).toContainText('1 bar to check');
  await expect(page.getByTestId('bar-flag')).toHaveCount(1);
  expect(errs).toEqual([]);
});

test('part picker: shows one line of a multi-part score, follows the clef, and is remembered', async ({ page }) => {
  await seedScore(page, 'parts1', 'Duet', twoParts());
  await page.goto('/score/parts1');
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect(page.getByLabel('Part')).toHaveValue('all');
  const staves = () => page.evaluate(() => document.querySelectorAll('.score-host svg .vf-clef').length);
  const both = await staves();
  await page.getByLabel('Part').selectOption('1');
  await expect(page.getByLabel('Written for')).toHaveValue('trombone');
  await expect(page.getByTestId('source-hint')).toContainText('bass clef');
  await expect.poll(staves).toBeLessThan(both);
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.getByLabel('Part')).toHaveValue('1');
  await expect(page.getByLabel('Written for')).toHaveValue('trombone');
});

test('bars to check: tapping a line jumps to that bar; single-part scores have no part picker', async ({ page }) => {
  await seedScore(page, 'chk1', 'Check', fixture('two-pages.musicxml'));
  // add the reader's doubts to the saved score
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('keyval-store');
      open.onsuccess = () => {
        const db = open.result; const tx = db.transaction('keyval', 'readwrite'); const st = tx.objectStore('keyval');
        const get = st.get('score:chk1');
        get.onsuccess = () => { st.put({ ...get.result, flags: [{ bar: '9', text: 'smudged' }, { bar: '', text: 'the last line is cut off' }] }, 'score:chk1'); };
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.goto('/score/chk1');
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect(page.getByLabel('Part')).toHaveCount(0);
  const w = page.getByTestId('bar-warnings');
  await expect(w).toContainText('2 bars to check');
  await w.locator('summary').click();
  await expect(w).toContainText('Note from the reader: the reader was not sure (the last line is cut off).');
  await w.getByRole('button', { name: /Bar 9: the reader was not sure \(smudged\)/ }).click();
  await expect(page.getByTestId('bar-counter')).toHaveText(/^Bar 9 \//);
  await expect(page.getByTestId('bar-flag')).toHaveCount(1);
});

test('click and count-in are remembered; the sound status is shown; the printed tempo is used', async ({ page }) => {
  const xml = notationToMusicXml(parseNotation('title: Tempo\ntempo: 132\ntime: 4/4\n1: C5:q D5:q E5:q F5:q\n2: G5:w')).xml;
  await seedScore(page, 'tempo1', 'Tempo', xml);
  await page.goto('/score/tempo1');
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect(page.getByLabel('BPM')).toHaveValue('132');
  await expect(page.getByTestId('engine-status')).toContainText(/Loading Bb Trumpet sound|Sound: /);
  await expect(page.getByTestId('engine-status')).toContainText('Sound: ', { timeout: 20_000 });
  await page.getByLabel('Click').check();
  await page.getByLabel('Count-in').check();
  await page.reload();
  await expect(page.getByLabel('Click')).toBeChecked();
  await expect(page.getByLabel('Count-in')).toBeChecked();
  // with count-in on, the bar counter waits one bar (4 beats at 132 = 1.8 s) before it moves
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(1200);
  await expect(page.getByTestId('bar-counter')).toHaveText('Bar 1 / 2');
  await expect(page.getByTestId('bar-counter')).toHaveText('Bar 2 / 2', { timeout: 6000 });
});

test('long score: 160 bars draw in reasonable time and playback stays smooth', async ({ page }) => {
  test.setTimeout(120_000);
  const lines = ['title: Long March', 'clef: treble', 'key: 2b', 'time: 4/4'];
  const pat = ['B4:e C5:e D5:e E5:e F5:q D5:q', 'C5:q. B4:e A4:q F4:q', 'G4:e A4:e B4:e C5:e D5:h', 'B4:q r:q F5:h'];
  for (let i = 1; i <= 160; i++) lines.push(`${i}: ${i === 1 ? '|: ' : ''}${pat[i % 4]}${i === 32 ? ' :|' : ''}`);
  const xml = notationToMusicXml(parseNotation(lines.join('\n'))).xml;
  await seedScore(page, 'long1', 'Long March', xml);
  const t0 = Date.now();
  await page.goto('/score/long1');
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 60_000 });
  const drawMs = Date.now() - t0;
  await expect(page.getByTestId('bar-counter')).toHaveText('Bar 1 / 160');
  expect(drawMs).toBeLessThan(25_000);
  await page.getByLabel('BPM').fill('240');
  await page.getByLabel('BPM').blur();
  // jump deep into the piece, then play: frames must keep coming and the cursor must stay in its bar
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Next bar' }).click();
  await page.evaluate(() => {
    const w = window as unknown as { __f: { n: number; long: number; last: number; off: number } };
    w.__f = { n: 0, long: 0, last: performance.now(), off: 0 };
    const frame = (t: number) => {
      const f = w.__f; f.n++; if (t - f.last > 100) f.long++; f.last = t;
      const c = document.querySelector('img[id^="cursorImg"]') as HTMLElement | null;
      const h = document.querySelector('[data-testid="bar-highlight"]') as HTMLElement | null;
      if (c && h && h.style.display !== 'none') {
        const cx = c.getBoundingClientRect().left + c.getBoundingClientRect().width / 2, hb = h.getBoundingClientRect();
        if (cx < hb.left - 3 || cx > hb.right + 3) f.off++;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(5000);
  const f = await page.evaluate(() => (window as unknown as { __f: { n: number; long: number; off: number } }).__f);
  await page.getByRole('button', { name: 'Pause' }).click();
  expect(f.n).toBeGreaterThan(150); // at least 30 frames per second on average
  expect(f.long).toBeLessThanOrEqual(3);
  expect(f.off).toBeLessThanOrEqual(2);
  // 5 s at 240 bpm = 20 beats = 5 bars from bar 4
  const label = await page.getByTestId('bar-counter').textContent();
  expect(Number(label!.match(/Bar (\d+)/)![1])).toBeGreaterThanOrEqual(8);
  console.log(`long score: drawn in ${drawMs} ms, ${f.n} frames in 5 s, ${f.long} long frames`);
});
