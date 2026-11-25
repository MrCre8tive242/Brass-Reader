/**
 * When the browser will not store something (the device is full, or the site's allowance is used up), the app says
 * so in plain words and carries on; nothing that is on screen is thrown away because it could not be saved.
 */

/** Is this "no room left" (as opposed to storage being switched off or broken)? */
export function isQuotaError(e: unknown): boolean {
  const x = e as { name?: string; code?: number; message?: string } | null;
  if (!x) return false;
  return x.name === 'QuotaExceededError' || x.name === 'NS_ERROR_DOM_QUOTA_REACHED' || x.code === 22 || x.code === 1014 || /quota|full disk|storage.*full|no space/i.test(String(x.message ?? ''));
}

/** A storage failure that already carries words for the player (so it is not explained twice). */
export class StorageError extends Error {
  readonly quota: boolean;
  constructor(message: string, quota: boolean) { super(message); this.name = 'StorageError'; this.quota = quota; }
}

/** What to tell the player when `what` ("the take", "the groove") could not be stored. */
export function storageErrorMessage(e: unknown, what: string): string {
  if (e instanceof StorageError) return e.message;
  if (isQuotaError(e)) return `There is no room left on this device to keep ${what}. Delete takes, grooves or scores you no longer need, then try again.`;
  return `Could not keep ${what}: the browser is not letting the app use its storage (private browsing can do this).`;
}

/** Wrap a storage failure in an error that says what happened in plain words. */
export function asStorageError(e: unknown, what: string): StorageError {
  return e instanceof StorageError ? e : new StorageError(storageErrorMessage(e, what), isQuotaError(e));
}

type Listener = (message: string) => void;
const listeners = new Set<Listener>();
let lastSaid = 0;

/** Hear about storage problems that happen in the background (settings that could not be saved). */
export function onStorageProblem(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Tell whoever is listening, at most once every few seconds (a full disk fails every write). */
export function reportStorageProblem(e: unknown, what: string, now = Date.now()): void {
  if (now - lastSaid < 8000) return;
  lastSaid = now;
  const msg = storageErrorMessage(e, what);
  for (const fn of listeners) { try { fn(msg); } catch { /* a listener must not break saving */ } }
}

let asked = false;
/**
 * Ask the browser to keep the app's data (scores, takes, the band's recorded grooves) instead of clearing it when
 * the device runs low or the site has not been opened for a while. Asked once, after something worth keeping is saved.
 */
export function requestPersistence(): void {
  if (asked) return;
  asked = true;
  try {
    const st = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (st?.persist) void st.persisted?.().then((already) => (already ? true : st.persist())).catch(() => {});
  } catch { /* not available: nothing to do */ }
}

/** For tests. */
export function resetStorageState() { lastSaid = 0; asked = false; listeners.clear(); }
