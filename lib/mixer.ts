/** One row of the ensemble mixer. */
export interface MixState { volume: number; mute: boolean; solo: boolean }

export const DEFAULT_MIX: MixState = { volume: 1, mute: false, solo: false };

/** What to multiply a part's loudness by: 0 when it should be silent. Any solo silences every part that is not soloed. */
export function partGain(mix: readonly (MixState | undefined)[], i: number): number {
  const m = mix[i] ?? DEFAULT_MIX;
  const anySolo = mix.some((x) => x?.solo);
  if (anySolo ? !m.solo : m.mute) return 0;
  return Math.max(0, Math.min(1, Number.isFinite(m.volume) ? m.volume : 1));
}

export function normalizeMix(m: Partial<MixState> | undefined | null): MixState {
  return {
    volume: Math.max(0, Math.min(1, typeof m?.volume === 'number' && Number.isFinite(m.volume) ? m.volume : 1)),
    mute: !!m?.mute,
    solo: !!m?.solo,
  };
}
