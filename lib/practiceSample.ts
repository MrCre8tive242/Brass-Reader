import { DEFAULT_DRUMS } from './drumSettings';
import type { SavedScore } from './library';
import { notationToMusicXml, parseNotation } from './omrNotation';
import { PRACTICE_SAMPLE_ID } from './practiceProgress';

export function practiceSample(): SavedScore {
  const title = 'Bay Street Warm-Up';
  const { xml } = notationToMusicXml(parseNotation(`
title: ${title}
clef: treble
key: C
time: 4/4
tempo: 76
1: C4:q E4:e G4:e A4:q G4:q
2: E4:e G4:e A4:q G4:e E4:e C4:q
3: D4:q F4:e A4:e G4:q F4:q
4: E4:q D4:q C4:h
5: G4:e G4:e A4:q C5:q A4:q
6: G4:q E4:e G4:e F4:q E4:q
7: D4:e E4:e F4:q G4:e F4:e E4:q
8: D4:q G4:q C4:h
`));
  return {
    id: PRACTICE_SAMPLE_ID,
    title,
    sourceXml: xml,
    sourceInstrument: 'trumpet',
    createdAt: 0,
    view: 'twobar',
    drums: { ...DEFAULT_DRUMS, grooveId: 'junkanoo', volume: 0.55 },
  };
}
