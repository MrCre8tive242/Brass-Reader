import { buildSlices, detectOnsets, estimateTempo, foldTempo, guessBars, TEMPO_MAX, TEMPO_MIN } from './grooveAnalysis';

export interface Analysis {
  onsets: number[];
  /** Tempo found in the recording (which method found it), or null if there was nothing to measure. */
  detected: { bpm: number; by: 'library' | 'onsets' } | null;
  downbeatS: number;
  bars: 1 | 2 | 4;
}

/**
 * Listen to a recording: find the hits, the tempo (web-audio-beat-detector first, our own onset comparison when it
 * has nothing to say) and a first guess at the downbeat. `countInS` is where the count-in ended, if there was one.
 */
export async function analyzeRecording(ctx: BaseAudioContext, samples: Float32Array, rate: number, countInS: number | null, fallbackBpm: number): Promise<Analysis> {
  const on = detectOnsets(samples, rate);
  let detected: Analysis['detected'] = null;
  if (samples.length > rate * 1.5) {
    try {
      const buf = ctx.createBuffer(1, samples.length, rate);
      buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const { guess } = await import('web-audio-beat-detector');
      const r = await guess(buf, { minTempo: TEMPO_MIN - 5, maxTempo: TEMPO_MAX + 10 });
      const bpm = foldTempo(r.bpm);
      if (Number.isFinite(bpm)) detected = { bpm: Math.round(bpm * 10) / 10, by: 'library' };
    } catch { /* the library had nothing: use our own */ }
  }
  if (!detected) {
    const own = estimateTempo(on.times, on.strengths);
    if (own) detected = { bpm: own.bpm, by: 'onsets' };
  }
  const bpm = detected?.bpm ?? fallbackBpm;
  const dur = samples.length / rate;
  let downbeatS = countInS ?? 0;
  if (on.times.length) {
    const from = countInS !== null ? countInS - 0.1 : -1;
    const near = on.times.find((t) => t >= from && (countInS === null || t <= countInS + 0.3));
    downbeatS = near ?? on.times.find((t) => t >= from) ?? countInS ?? on.times[0];
  }
  downbeatS = Math.max(0, Math.min(dur, downbeatS));
  return { onsets: on.times, detected, downbeatS, bars: guessBars(Math.max(0, dur - downbeatS), bpm) };
}

export { buildSlices };
