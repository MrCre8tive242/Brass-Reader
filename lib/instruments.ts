export type InstrumentId = 'trumpet' | 'mellophone' | 'baritone' | 'trombone' | 'sousaphone';
export type ClefKind = 'treble' | 'bass';

export interface Instrument {
  id: InstrumentId;
  name: string;
  clef: ClefKind;
  /** Semitones from written pitch to sounding (concert) pitch. */
  writtenToConcert: number;
  /** Diatonic steps (signed) matching writtenToConcert, used for correct spelling. */
  diatonic: number;
  /** Change in key-signature fifths from written to concert. */
  fifths: number;
  /** General MIDI program, 0-based. */
  program: number;
  /** smplr soundfont instrument name. */
  sample: string;
  /** Comfortable range as MIDI numbers, in the instrument's WRITTEN pitch. */
  writtenRange: [number, number];
}

// MIDI numbers: F#3=54, C6=84, E2=40, Bb4=70, E1=28, F3=53
export const INSTRUMENTS: Record<InstrumentId, Instrument> = {
  trumpet: {
    id: 'trumpet', name: 'Bb Trumpet', clef: 'treble',
    writtenToConcert: -2, diatonic: -1, fifths: -2,
    program: 56, sample: 'trumpet', writtenRange: [54, 84],
  },
  mellophone: {
    id: 'mellophone', name: 'Mellophone (F)', clef: 'treble',
    writtenToConcert: -7, diatonic: -4, fifths: -1,
    program: 60, sample: 'french_horn', writtenRange: [54, 84],
  },
  baritone: {
    id: 'baritone', name: 'Baritone (bass clef)', clef: 'bass',
    writtenToConcert: 0, diatonic: 0, fifths: 0,
    program: 57, sample: 'trombone', writtenRange: [40, 70],
  },
  trombone: {
    id: 'trombone', name: 'Trombone', clef: 'bass',
    writtenToConcert: 0, diatonic: 0, fifths: 0,
    program: 57, sample: 'trombone', writtenRange: [40, 70],
  },
  sousaphone: {
    id: 'sousaphone', name: 'Sousaphone', clef: 'bass',
    writtenToConcert: 0, diatonic: 0, fifths: 0,
    program: 58, sample: 'tuba', writtenRange: [28, 53],
  },
};

export const INSTRUMENT_IDS = Object.keys(INSTRUMENTS) as InstrumentId[];
export const DEFAULT_SOURCE_INSTRUMENT: InstrumentId = 'trumpet';

export function isInstrumentId(v: unknown): v is InstrumentId {
  return typeof v === 'string' && v in INSTRUMENTS;
}

/** Comfortable range in concert (sounding) MIDI numbers. */
export function concertRange(id: InstrumentId): [number, number] {
  const i = INSTRUMENTS[id];
  return [i.writtenRange[0] + i.writtenToConcert, i.writtenRange[1] + i.writtenToConcert];
}
