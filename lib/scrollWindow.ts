import { slotAt, type Timeline } from './timeline';
import type { BarWindow, Loop } from './barWindow';

/** Draw eight played bars at a time. Overlap the neighbouring strips so the whole
 * visible staff, including the notes ahead of the playhead, survives a handoff. */
const CHUNK = 8;
const OVERLAP = 12;

export interface ScrollWindow extends BarWindow {
  focus: number;
  next: number | null;
  previous: number | null;
}

export function scrollWindow(tl: Timeline, slot: number, loop: Loop): ScrollWindow {
  const loopStart = loop ? slotAt(tl, loop.startQ) : 0;
  const loopEnd = loop ? slotAt(tl, loop.endQ - 0.0001) + 1 : 0;
  const cycling = !!loop && slot >= loopStart && slot < loopEnd;
  const first = cycling ? loopStart : 0;
  const end = cycling ? loopEnd : tl.order.length;
  const block = first + Math.floor((slot - first) / CHUNK) * CHUNK;
  const blockEnd = Math.min(block + CHUNK, end);
  const start = cycling ? block - OVERLAP : Math.max(first, block - OVERLAP);
  const stop = cycling ? blockEnd + OVERLAP : Math.min(end, blockEnd + OVERLAP);
  const length = end - first;
  const slots: number[] = [];
  for (let i = start; i < stop; i++) {
    slots.push(cycling ? first + ((i - first) % length + length) % length : i);
  }
  const bars = slots.map(i => tl.order[i]);
  return {
    slot, slots, bars, key: bars.join('+'), focus: slot - start,
    next: blockEnd < end ? blockEnd : cycling ? first : null,
    previous: block > first ? block - 1 : cycling ? end - 1 : null,
  };
}
