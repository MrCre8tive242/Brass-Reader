import { buildSlices, detectOnsets, estimateTempo, foldTempo, guessBars, guessDownbeat, TEMPO_MAX, TEMPO_MIN } from './grooveAnalysis';

export interface Analysis {
  /** The main stroke of each hit, seconds. */
  onsets: number[];
  /** Where the sound of each hit begins (same order as `onsets`); missing for grooves saved by older versions. */
  starts?: number[];
  /** Tempo found in the recording (which method found it), or null if there was nothing to measure. */
  detected: { bpm: number; by: 'library' | 'onsets' } | null;
  downbeatS: number;
  bars: 1 | 2 | 4;
}

export interface AnalyzeOpts {
  /** Where the count-in ended in the recording (seconds), or null when there was none. */
  countInS: number | null;
  /** The tempo of the count-in click (the tempo of the score unless it was changed). */
  clickBpm: number;
  /** 1 = normal; higher finds more (softer) hits, lower fewer. */
  sensitivity?: number;
}

const octaveApart = (a: number, b: number) => [0.5, 1, 2].some((k) => Math.abs(a / (b * k) - 1) < 0.04);

/**
 * Listen to a recording: find the hits, the tempo and a first guess at the downbeat and the number of bars.
 * The tempo comes from the hits themselves (they all have to sit on one grid, which pins it to a fraction of a BPM;
 * the count-in tempo settles 80 against 160). Only when the hits make no regular grid is the general-purpose
 * beat detector (web-audio-beat-detector) asked instead.
 */
export async function analyzeRecording(ctx: BaseAudioContext, samples: Float32Array, rate: number, opts: AnalyzeOpts): Promise<Analysis> {
  const { countInS, clickBpm } = opts;
  const on = detectOnsets(samples, rate, opts.sensitivity ?? 1);
  const dur = samples.length / rate;
  const tempoOpts = { levels: on.levels, hint: countInS !== null ? clickBpm : null, near: clickBpm };
  let est = estimateTempo(on.times, on.strengths, { ...tempoOpts, from: countInS !== null ? countInS - 0.15 : undefined });
  if (!est && countInS !== null) est = estimateTempo(on.times, on.strengths, tempoOpts);
  let detected: Analysis['detected'] = est ? { bpm: Math.round(est.bpm * 10) / 10, by: 'onsets' } : null;
  let phaseS = est ? est.phaseS : null;
  if ((!est || est.confidence < 0.5) && samples.length > rate * 1.5) {
    try {
      const buf = ctx.createBuffer(1, samples.length, rate);
      buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const { guess } = await import('web-audio-beat-detector');
      const r = await guess(buf, { minTempo: TEMPO_MIN - 5, maxTempo: TEMPO_MAX + 10 });
      const bpm = foldTempo(r.bpm);
      // our own shaky reading stands when the detector agrees with it (it only gives whole BPM)
      if (Number.isFinite(bpm) && !(est && octaveApart(est.bpm, bpm))) { detected = { bpm: Math.round(bpm * 10) / 10, by: 'library' }; phaseS = null; }
    } catch { /* the library had nothing either */ }
  }
  const bpm = detected?.bpm ?? clickBpm;
  const downbeatS = Math.max(0, Math.min(dur, guessDownbeat(on.times, on.levels, bpm, phaseS, countInS, dur)));
  return { onsets: on.times, starts: on.starts, detected, downbeatS, bars: guessBars(Math.max(0, dur - downbeatS), bpm) };
}

export { buildSlices };
