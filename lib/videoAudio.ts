import type { InstrumentId } from './instruments';
import type { Timeline } from './timeline';
import { partGain, type MixState } from './mixer';
import { DrumBus, warmKit, type DrumSource } from './drums';
import type { DrumHit } from './groove';
import { createVoice, type Voice } from './voices';

export const VIDEO_RATE = 48000;

/** What the video's sound is made of: the same parts, mix and drums the player makes. */
export interface AudioJob {
  tl: Timeline;
  bpm: number;
  /** Instrument of every part (index = part). */
  partInstruments: InstrumentId[];
  /** Loudness, mute and solo of every part. */
  mix: MixState[];
  drumHits: DrumHit[];
  drumSource: DrumSource | null;
  drumsOn: boolean;
  drumsVolume: number;
}

/**
 * Play the whole piece into an OfflineAudioContext, which the browser renders much faster than real time. The notes and
 * drums are scheduled exactly as the player schedules them (same gain per part, same note length, same drum bus),
 * minus the click and count-in. Returns the stereo sound at 48 kHz, `seconds` long.
 */
export async function renderAudio(job: AudioJob, seconds: number, onVoices?: (engine: 'soundfont' | 'synth') => void): Promise<AudioBuffer> {
  const OAC = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new OAC(2, Math.ceil(seconds * VIDEO_RATE), VIDEO_RATE);
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  const spq = 60 / job.bpm;
  const ids = [...new Set(job.partInstruments)];
  const loaded = await Promise.all(ids.map(async (id) => [id, await createVoice(ctx, master, id)] as const));
  const byId = new Map(loaded);
  onVoices?.(loaded.every(([, v]) => v.engine === 'soundfont') ? 'soundfont' : 'synth');
  const voices: Voice[] = job.partInstruments.map((id) => byId.get(id)!.voice);
  for (const e of job.tl.events) {
    const part = e.part ?? 0;
    const g = partGain(job.mix, part);
    if (g <= 0) continue;
    (voices[part] ?? voices[0])?.start({ note: e.midi, time: e.timeQ * spq, duration: Math.max(0.05, e.durQ * spq * 0.97), velocity: 0.8 * g });
  }
  if (job.drumsOn && job.drumHits.length) {
    const bus = new DrumBus(ctx, ctx.destination);
    bus.source = job.drumSource;
    bus.setVolume(job.drumsVolume);
    warmKit(ctx, job.drumHits);
    for (const h of [...job.drumHits].sort((a, b) => a.timeQ - b.timeQ)) bus.hit(h, h.timeQ * spq, spq, job.bpm, h.timeQ);
  }
  return ctx.startRendering();
}
