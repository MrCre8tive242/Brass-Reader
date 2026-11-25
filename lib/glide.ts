/** A point the moving line passes: `off` quarters into the bar, at `x`. */
export interface GlidePoint { off: number; x: number }

/**
 * Where the moving line is `off` quarters into a bar, gliding from note to note instead of jumping.
 * Between two notes it moves at a steady speed; after the last note it glides on to `endX`
 * (the end of the bar) over the rest of the bar (`barLen` quarters). `points` sorted by `off`.
 */
export function glideX(points: GlidePoint[], off: number, barLen: number, endX: number): number | null {
  if (!points.length) return null;
  let i = 0;
  for (let k = 0; k < points.length; k++) if (points[k].off <= off + 1e-6) i = k; else break;
  const p = points[i];
  if (off <= p.off) return p.x;
  const next = points[i + 1] ?? { off: barLen, x: Math.max(p.x, endX) };
  const span = next.off - p.off;
  if (!(span > 1e-6)) return p.x;
  const f = Math.min(1, Math.max(0, (off - p.off) / span));
  return p.x + (next.x - p.x) * f;
}
