/** A synthetic drum loop for tests: kick on 1 and 3, snare on 2 and 4, closed hat on every eighth. */
export function synthDrumLoop(bpm: number, bars: number, rate = 44100): Float32Array {
  const beat = 60 / bpm;
  const n = Math.round(bars * 4 * beat * rate);
  const x = new Float32Array(n);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  const add = (t: number, fn: (s: number) => number, dur: number) => {
    const s0 = Math.round(t * rate);
    for (let i = 0; i < dur * rate && s0 + i < n; i++) x[s0 + i] += fn(i / rate);
  };
  for (let b = 0; b < bars * 4; b++) {
    const t = b * beat;
    if (b % 2 === 0) add(t, (s) => 0.9 * Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-s * 40)) * s) * Math.exp(-s * 14), 0.25);
    else add(t, (s) => 0.7 * rnd() * Math.exp(-s * 22) + 0.4 * Math.sin(2 * Math.PI * 190 * s) * Math.exp(-s * 25), 0.2);
    for (const off of [0, 0.5]) add(t + off * beat, (s) => 0.25 * rnd() * Math.exp(-s * 150), 0.04);
  }
  return x;
}
