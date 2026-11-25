import { get, set, del, keys, getMany } from 'idb-keyval';
import { asStorageError, isQuotaError, requestPersistence } from './storage';

/** A recording of the player, kept per score. */
export interface Take {
  id: string;
  scoreId: string;
  createdAt: number;
  mime: string;
  blob: Blob;
  durationS: number;
  /** Where in the score the run began and how: needed to line a replay of the backing up with the recording. */
  startMeasure: number;
  bpm: number;
  countIn: boolean;
  /** Seconds of recording that happened before the sound reached the microphone's buffer (skipped when replaying together). */
  offsetS: number;
}

export const MAX_TAKES = 10;
const PREFIX = 'take:';

/** Ids of the takes to drop so that at most `cap` stay: the oldest go first. */
export function takesToDelete(takes: { id: string; createdAt: number }[], cap = MAX_TAKES): string[] {
  if (takes.length <= cap) return [];
  return [...takes].sort((a, b) => b.createdAt - a.createdAt).slice(cap).map((t) => t.id);
}

/** Recording formats in order of preference; the browser picks the first it can make. */
export const RECORDER_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];

export function pickRecorderMime(supported: (m: string) => boolean): string | undefined {
  return RECORDER_MIMES.find((m) => { try { return supported(m); } catch { return false; } });
}

/** File extension for a recording: .webm, .m4a (mp4 audio) or .ogg. */
export function takeExtension(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  return 'webm';
}

export const takeKey = (scoreId: string, id: string) => `${PREFIX}${scoreId}:${id}`;

export async function listTakes(scoreId: string): Promise<Take[]> {
  const ks = (await keys()).filter((k): k is string => typeof k === 'string' && k.startsWith(`${PREFIX}${scoreId}:`));
  const all = (await getMany<Take>(ks)).filter((t): t is Take => !!t);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Save a take and drop the oldest beyond the cap. Returns the takes that remain, newest first.
 * When there is no room, the oldest takes of this score make way for the new one (up to three of them);
 * if that is not enough a StorageError says so, and nothing else is touched.
 */
export async function saveTake(t: Take, cap = MAX_TAKES): Promise<Take[]> {
  for (let freed = 0; ; freed++) {
    try { await set(takeKey(t.scoreId, t.id), t); break; } catch (e) {
      const old = isQuotaError(e) && freed < 3 ? (await listTakes(t.scoreId).catch(() => [] as Take[])).filter((x) => x.id !== t.id) : [];
      if (!old.length) throw asStorageError(e, 'the take');
      await del(takeKey(t.scoreId, old[old.length - 1].id)).catch(() => {});
    }
  }
  requestPersistence();
  const all = await listTakes(t.scoreId);
  for (const id of takesToDelete(all, cap)) await del(takeKey(t.scoreId, id));
  return listTakes(t.scoreId);
}

export async function deleteTake(scoreId: string, id: string): Promise<void> {
  await del(takeKey(scoreId, id));
}

export async function getTake(scoreId: string, id: string): Promise<Take | undefined> {
  return get<Take>(takeKey(scoreId, id));
}

/** Delete every take of a score (the score was deleted). */
export async function deleteTakesOf(scoreId: string): Promise<void> {
  const ks = (await keys()).filter((k): k is string => typeof k === 'string' && k.startsWith(`${PREFIX}${scoreId}:`));
  for (const k of ks) await del(k);
}
