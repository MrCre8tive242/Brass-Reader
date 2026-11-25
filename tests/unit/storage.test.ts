import { describe, it, expect, vi, beforeEach } from 'vitest';

// a tiny stand-in for the browser's store: `failSet` decides which writes are refused
const db = new Map<string, unknown>();
let failSet: (key: string) => unknown = () => null;
vi.mock('idb-keyval', () => ({
  get: async (k: string) => db.get(k),
  set: async (k: string, v: unknown) => { const err = failSet(k); if (err) throw err; db.set(k, v); },
  del: async (k: string) => { db.delete(k); },
  keys: async () => [...db.keys()],
  getMany: async (ks: string[]) => ks.map((k) => db.get(k)),
}));

import { StorageError, asStorageError, isQuotaError, onStorageProblem, reportStorageProblem, resetStorageState, storageErrorMessage } from '@/lib/storage';
import { saveTake, listTakes, type Take } from '@/lib/takes';
import { saveScore, updateScore, getScore, type SavedScore } from '@/lib/library';
import { saveGroove, getGroove } from '@/lib/grooveStore';

const quota = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
const take = (id: string, createdAt: number): Take => ({ id, scoreId: 's', createdAt, mime: 'audio/webm', blob: new Blob(['x']), durationS: 1, startMeasure: 1, bpm: 100, countIn: false, offsetS: 0 });
const score = (): SavedScore => ({ id: 's', title: 'T', sourceXml: '<x/>', sourceInstrument: 'trumpet', createdAt: 1 });

beforeEach(() => { db.clear(); failSet = () => null; resetStorageState(); });

describe('telling a full device from broken storage', () => {
  it('knows the ways browsers say "no room"', () => {
    expect(isQuotaError(quota())).toBe(true);
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError(new Error('Encountered full disk while opening backing store'))).toBe(true);
    expect(isQuotaError(new Error('storage is full'))).toBe(true);
    expect(isQuotaError({ name: 'InvalidStateError' })).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
  it('says what to do', () => {
    expect(storageErrorMessage(quota(), 'the take')).toMatch(/no room left.*keep the take.*Delete/);
    expect(storageErrorMessage(new Error('x'), 'the groove')).toMatch(/Could not keep the groove.*private browsing/);
    const e = asStorageError(quota(), 'the score');
    expect(e).toBeInstanceOf(StorageError);
    expect(e.quota).toBe(true);
    expect(asStorageError(e, 'something else')).toBe(e); // already explained: not explained twice
    expect(storageErrorMessage(e, 'x')).toBe(e.message);
  });
  it('reports background problems once in a while, not on every write', () => {
    const heard: string[] = [];
    const off = onStorageProblem((m) => heard.push(m));
    reportStorageProblem(quota(), 'your settings', 100_000);
    reportStorageProblem(quota(), 'your settings', 101_000);
    reportStorageProblem(quota(), 'your settings', 109_000);
    expect(heard).toHaveLength(2);
    expect(heard[0]).toMatch(/no room left/);
    off();
    reportStorageProblem(quota(), 'your settings', 200_000);
    expect(heard).toHaveLength(2);
  });
});

describe('saving when the device is full', () => {
  it('a new take pushes out the oldest takes of the same score, and other things are left alone', async () => {
    for (let i = 1; i <= 4; i++) await saveTake(take(`t${i}`, i));
    db.set('groove:g1', { id: 'g1' });
    db.set('take:other:z', take('z', 0));
    // there is room again once two old takes are gone
    failSet = (k) => (k === 'take:s:new' && [...db.keys()].filter((x) => x.startsWith('take:s:')).length > 2 ? quota() : null);
    const left = await saveTake(take('new', 99));
    expect(left.map((t) => t.id)).toEqual(['new', 't4', 't3']);
    expect(db.has('groove:g1')).toBe(true);
    expect(db.has('take:other:z')).toBe(true);
  });
  it('gives up with words for the player when making room does not help, keeping what was there', async () => {
    for (let i = 1; i <= 5; i++) await saveTake(take(`t${i}`, i));
    failSet = (k) => (k === 'take:s:new' ? quota() : null);
    await expect(saveTake(take('new', 99))).rejects.toThrow(/no room left on this device to keep the take/);
    expect((await listTakes('s')).length).toBe(2); // three made way, no more
    // storage switched off altogether: nothing is deleted
    failSet = () => new Error('blocked');
    await expect(saveTake(take('n2', 100))).rejects.toThrow(/Could not keep the take/);
    expect((await listTakes('s')).length).toBe(2);
  });
  it('a score or a groove that cannot be stored fails with a plain message', async () => {
    failSet = () => quota();
    await expect(saveScore(score())).rejects.toThrow(/no room left.*the score/);
    await expect(saveGroove({ id: 'g', name: 'g', kind: 'kit', createdAt: 1, feel: 'straight' })).rejects.toBeInstanceOf(StorageError);
    expect(await getGroove('g')).toBeUndefined();
  });
  it('a practice setting that cannot be stored never throws: the player is told and the old record stays', async () => {
    await saveScore(score());
    const heard: string[] = [];
    onStorageProblem((m) => heard.push(m));
    failSet = () => quota();
    await expect(updateScore('s', { loop: { from: 1, to: 2 } })).resolves.toBeUndefined();
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(/your settings for this score/);
    expect((await getScore('s'))!.loop).toBeUndefined();
    failSet = () => null;
    await updateScore('s', { loop: { from: 1, to: 2 } });
    expect((await getScore('s'))!.loop).toEqual({ from: 1, to: 2 });
    await expect(updateScore('missing', { loop: null })).resolves.toBeUndefined();
  });
});
