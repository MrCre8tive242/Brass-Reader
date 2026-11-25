import type { Feel, Groove } from './groove';

/** How the drums play under one score (kept with the score). */
export interface DrumSettings {
  /** Chosen groove: a starter id or a saved groove's id; null = none. */
  grooveId: string | null;
  on: boolean;
  /** Loudness of the drums against the horns, 0 to 1. */
  volume: number;
  /** Straight or triplet feel for a starter-kit groove (unset = the groove's own). */
  feel?: Feel;
  /** Keep the drums playing while recording yourself and when a take is replayed with the backing. */
  inTakes: boolean;
  /** Add a drum track (General MIDI channel 10) to the MIDI download. */
  inMidi: boolean;
}

export const DEFAULT_DRUMS: DrumSettings = { grooveId: null, on: true, volume: 0.7, inTakes: true, inMidi: false };

export function normalizeDrums(d: Partial<DrumSettings> | null | undefined): DrumSettings {
  return {
    grooveId: typeof d?.grooveId === 'string' ? d.grooveId : null,
    on: d?.on !== false,
    volume: typeof d?.volume === 'number' && Number.isFinite(d.volume) ? Math.max(0, Math.min(1, d.volume)) : DEFAULT_DRUMS.volume,
    ...(d?.feel === 'triplet' || d?.feel === 'straight' ? { feel: d.feel } : {}),
    inTakes: d?.inTakes !== false,
    inMidi: !!d?.inMidi,
  };
}

/** Whether the drums should sound right now. */
export function drumsAudible(s: DrumSettings, g: Groove | undefined, recordingOrReplay: boolean): boolean {
  return !!g && s.on && (s.inTakes || !recordingOrReplay);
}

/** The feel to play a groove in: the score's choice for a starter-kit groove with 16 steps, else the groove's own. */
export function feelFor(s: DrumSettings, g: Groove): Feel {
  return g.kind === 'kit' && g.pattern?.steps === 16 && s.feel ? s.feel : g.feel;
}
