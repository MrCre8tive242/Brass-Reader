/** Magnitude spectrum of the start of a sound (for tests): [frequency in Hz, magnitude] pairs. The window leans on the attack. */
export function spectrum(x: ArrayLike<number>, rate: number, from = 0, len = x.length, N = 16384): [number, number][] {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < len && i < N && from + i < x.length; i++) re[i] = x[from + i] * Math.cos((Math.PI * i) / (2 * Math.min(len, N))) ** 2;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const a = re[i]; re[i] = re[j]; re[j] = a; }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const ang = (-2 * Math.PI) / size, half = size >> 1;
    for (let i = 0; i < N; i += size) for (let k = 0; k < half; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
      const vr = re[i + k + half] * wr - im[i + k + half] * wi, vi = re[i + k + half] * wi + im[i + k + half] * wr;
      re[i + k + half] = re[i + k] - vr; im[i + k + half] = im[i + k] - vi;
      re[i + k] += vr; im[i + k] += vi;
    }
  }
  const out: [number, number][] = [];
  for (let k = 1; k < N / 2; k++) out.push([(k * rate) / N, Math.hypot(re[k], im[k])]);
  return out;
}

/** Where the weight of a spectrum lies, Hz. */
export function centroid(sp: [number, number][]): number {
  let a = 0, b = 0;
  for (const [f, m] of sp) { a += f * m * m; b += m * m; }
  return b ? a / b : 0;
}

/** The strongest peaks of a spectrum, loudest first: [Hz, level relative to the loudest]. */
export function peaks(sp: [number, number][], count = 6, apart = 3): [number, number][] {
  const out: [number, number][] = [];
  for (let i = apart; i < sp.length - apart; i++) {
    let top = true;
    for (let d = 1; d <= apart && top; d++) if (sp[i][1] < sp[i - d][1] || sp[i][1] < sp[i + d][1]) top = false;
    if (top) out.push(sp[i]);
  }
  out.sort((p, q) => q[1] - p[1]);
  const m = out[0]?.[1] || 1;
  return out.slice(0, count).map(([f, v]) => [f, v / m]);
}
