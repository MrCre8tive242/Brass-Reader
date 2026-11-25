import { Midi } from '@tonejs/midi';
import type { Timeline } from './timeline';
import type { DrumHit } from './groove';

const PPQ = 480;

/** Standard MIDI file for a timeline. Pitches are concert (sounding). */
export function toMidi(tl: Timeline, bpm: number, program: number, name = 'Brass Reader', tracks?: { name: string; program: number }[], drums?: DrumHit[]): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(bpm);
  midi.header.name = name;
  // time signatures follow the unrolled (played) bars
  let lastSig = '';
  tl.measureStartsQ.forEach((startQ, slot) => {
    const w = tl.order[slot];
    let sig: Timeline['timeSigs'][number] | undefined;
    for (const ts of tl.timeSigs) if (ts.measure <= w) sig = ts;
    if (!sig) return;
    const key = `${sig.beats}/${sig.beatType}`;
    if (key === lastSig) return;
    lastSig = key;
    midi.header.timeSignatures.push({ ticks: Math.round(startQ * PPQ), timeSignature: [sig.beats, sig.beatType] });
  });
  midi.header.update();
  // one track per part for an ensemble; a single part keeps its single track
  const list = tracks && tracks.length > 1 ? tracks : [{ name, program }];
  const made = list.map((t) => {
    const track = midi.addTrack();
    track.name = t.name;
    track.instrument.number = t.program;
    return track;
  });
  for (const e of tl.events) {
    const track = made[made.length > 1 ? Math.min(made.length - 1, e.part ?? 0) : 0];
    track.addNote({
      midi: e.midi,
      ticks: Math.round(e.timeQ * PPQ),
      durationTicks: Math.max(1, Math.round(e.durQ * PPQ)),
      velocity: 0.8,
    });
  }
  // the drums go on General MIDI channel 10 (index 9): lead drum 47, bass drum 36, cowbells 56, whistle 72
  if (drums?.length) {
    const d = midi.addTrack();
    d.name = 'Drums';
    d.channel = 9;
    for (const h of drums) {
      d.addNote({ midi: h.gm, ticks: Math.round(h.timeQ * PPQ), durationTicks: Math.max(1, Math.round(Math.min(h.durQ, 0.5) * PPQ)), velocity: Math.max(0.1, Math.min(1, h.vel * 0.9)) });
    }
  }
  return midi.toArray();
}
