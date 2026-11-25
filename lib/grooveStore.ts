import { get, set, del, keys, getMany } from 'idb-keyval';
import { upgradeGroove, type Groove } from './groove';

/** A groove as kept in the browser's storage: the record plus (for a recorded one) its audio as a WAV file. */
export type StoredGroove = Groove & { audio?: Blob };

const PREFIX = 'groove:';

export async function saveGroove(g: StoredGroove): Promise<void> {
  await set(PREFIX + g.id, g);
}
export async function getGroove(id: string): Promise<StoredGroove | undefined> {
  const g = await get<StoredGroove>(PREFIX + id);
  return g ? upgradeGroove(g) : g;
}
export async function deleteGroove(id: string): Promise<void> {
  await del(PREFIX + id);
}
export async function renameGroove(id: string, name: string): Promise<void> {
  const g = await getGroove(id);
  if (g && name.trim()) await saveGroove({ ...g, name: name.trim().slice(0, 60) });
}
/** Every saved groove, newest first (the audio stays in the store until a groove is opened). */
export async function listGrooves(): Promise<StoredGroove[]> {
  const ks = (await keys()).filter((k): k is string => typeof k === 'string' && k.startsWith(PREFIX));
  const all = (await getMany<StoredGroove>(ks)).filter((x): x is StoredGroove => !!x);
  return all.map(upgradeGroove).sort((a, b) => b.createdAt - a.createdAt);
}
