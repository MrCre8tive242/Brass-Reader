import { get, set, del, keys, getMany } from 'idb-keyval';
import type { InstrumentId } from './instruments';
import type { LoopRange, Trainer } from './loop';

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
  loop?: LoopRange | null;
  trainer?: Trainer;
}

const PREFIX = 'score:';

export function newId(): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}${r}`;
}

export async function saveScore(s: SavedScore): Promise<void> {
  await set(PREFIX + s.id, s);
}

export async function getScore(id: string): Promise<SavedScore | undefined> {
  return get<SavedScore>(PREFIX + id);
}

export async function deleteScore(id: string): Promise<void> {
  await del(PREFIX + id);
}

export async function listScores(): Promise<SavedScore[]> {
  const ks = (await keys()).filter((k): k is string => typeof k === 'string' && k.startsWith(PREFIX));
  const all = (await getMany<SavedScore>(ks)).filter((x): x is SavedScore => !!x);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function updateScore(id: string, patch: Partial<SavedScore>): Promise<void> {
  const cur = await getScore(id);
  if (cur) await saveScore({ ...cur, ...patch, id });
}
