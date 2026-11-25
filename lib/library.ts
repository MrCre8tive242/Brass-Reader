import { get, set, del, keys, getMany } from 'idb-keyval';
import type { InstrumentId } from './instruments';
import type { LoopRange, Trainer } from './loop';
import type { SongPart } from './song';
import type { OctaveShift } from './range';
import type { MixState } from './mixer';
import type { DrumSettings } from './drumSettings';
import { deleteTakesOf } from './takes';
import { asStorageError, reportStorageProblem, requestPersistence } from './storage';

export interface SavedScore {
  id: string;
  title: string;
  sourceXml: string;
  sourceInstrument: InstrumentId;
  createdAt: number;
  /** Optional: where the score came from, for the library list. */
  origin?: 'scan' | 'musicxml';
  /** True if `sourceInstrument` was auto-detected from the music (not picked by the user). */
  sourceAuto?: boolean;
  /** Bars the reader itself was unsure about (printed bar label + what it said). */
  flags?: { bar: string; text: string }[];
  /** Which part of a multi-part score to show and play (0-based); undefined or null = all parts together. */
  partIndex?: number | null;
  /** Practice loop (written bars) and speed trainer settings. */
  /**
   * The song's parts, one single-part MusicXML per instrument sheet. Absent on records made before ensembles
   * (those are split on the fly from `sourceXml`, so old records keep working).
   */
  parts?: SongPart[];
  /** Which part is "mine" (index into the song's parts). */
  myPart?: number;
  /** Mixer state per part id. */
  mix?: Record<string, MixState>;
  loop?: LoopRange | null;
  /** Passages moved an octave to fit the instrument's range (applied on top of the reading; undo any time). */
  octaveShifts?: OctaveShift[];
  trainer?: Trainer;
  /** Drums under this score (chosen groove, volume, feel). */
  drums?: DrumSettings;
}

const PREFIX = 'score:';

export function newId(): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}${r}`;
}

/** Throws a StorageError (with words for the player) when the browser will not store it. */
export async function saveScore(s: SavedScore): Promise<void> {
  try { await set(PREFIX + s.id, s); } catch (e) { throw asStorageError(e, 'the score'); }
  requestPersistence();
}

export async function getScore(id: string): Promise<SavedScore | undefined> {
  return get<SavedScore>(PREFIX + id);
}

export async function deleteScore(id: string): Promise<void> {
  await del(PREFIX + id);
  // recordings belong to the score
  await deleteTakesOf(id).catch(() => {});
}

export async function listScores(): Promise<SavedScore[]> {
  const ks = (await keys()).filter((k): k is string => typeof k === 'string' && k.startsWith(PREFIX));
  const all = (await getMany<SavedScore>(ks)).filter((x): x is SavedScore => !!x);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Change some fields of a saved score (practice settings mostly). Never throws: a setting that cannot be stored
 * still works until the page is closed, and the player is told once (see `onStorageProblem`).
 */
export async function updateScore(id: string, patch: Partial<SavedScore>): Promise<void> {
  try {
    const cur = await getScore(id);
    if (cur) await set(PREFIX + id, { ...cur, ...patch, id });
  } catch (e) { reportStorageProblem(e, 'your settings for this score'); }
}
