import { Midi } from '@tonejs/midi';
import type { Timeline } from './timeline';

const PPQ = 480;

/** Standard MIDI file for a timeline. Pitches are concert (sounding). */
export function toMidi(tl: Timeline, bpm: number, program: number, name = 'Brass Reader'): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(bpm);
  midi.header.name = name;
  for (const ts of tl.timeSigs) {
    midi.header.timeSignatures.push({
      ticks: Math.round(tl.measureStartsQ[ts.measure - 1] * PPQ),
      timeSignature: [ts.beats, ts.beatType],
    });
  }
  midi.header.update();
  const track = midi.addTrack();
  track.name = name;
  track.instrument.number = program;
  for (const e of tl.events) {
    track.addNote({
      midi: e.midi,
      ticks: Math.round(e.timeQ * PPQ),
      durationTicks: Math.max(1, Math.round(e.durQ * PPQ)),
      velocity: 0.8,
    });
  }
  return midi.toArray();
}
