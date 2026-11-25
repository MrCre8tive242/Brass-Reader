import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

export const fixture = (name: string) => fs.readFileSync(path.join(__dirname, '../fixtures', name), 'utf8');

/** Put a score straight into the app's IndexedDB library (idb-keyval default store). */
export async function seedScore(page: Page, id: string, title: string, xml: string, sourceInstrument = 'trumpet') {
  await page.goto('/');
  await page.evaluate(async ({ id, title, xml, sourceInstrument }) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('keyval-store');
      open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains('keyval')) open.result.createObjectStore('keyval'); };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('keyval', 'readwrite');
        tx.objectStore('keyval').put({ id, title, sourceXml: xml, sourceInstrument, createdAt: Date.now() }, `score:${id}`);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, { id, title, xml, sourceInstrument });
}

export function collectConsoleErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // soundfont CDN may be unreachable in CI; the app falls back to a synth
    if (/Failed to load resource|ERR_|net::|gleitz|musyngkite|fetch/i.test(t)) return;
    errs.push(`console: ${t}`);
  });
  return errs;
}

export async function openScore(page: Page, file = 'scale.musicxml', id = 'p1') {
  await seedScore(page, id, 'Practice Scale', fixture(file));
  await page.goto(`/score/${id}`);
  await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
  await expect(page.locator('.score-host svg').first()).toBeVisible();
}
/** Open the practice drawer (and one of its sections, if named). */
export const openPractice = async (page: Page, section?: string) => {
  if (!(await page.getByTestId('practice-sheet').isVisible())) await page.getByRole('button', { name: 'Practice' }).click();
  await expect(page.getByTestId('practice-sheet')).toBeVisible();
  if (section) {
    const sec = page.getByTestId(`sec-${section}`);
    if ((await sec.getAttribute('open')) === null) await sec.locator('summary').click();
    await expect(sec).toHaveAttribute('open', '');
  }
};
