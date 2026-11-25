import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

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
