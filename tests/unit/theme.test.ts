import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(__dirname, '../../app/globals.css'), 'utf8');
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const vars = (block: string) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));

describe('theme contrast', () => {
  const light = vars(css.slice(css.indexOf('prefers-color-scheme: light')).split('}')[0]);
  const dark = vars(css.slice(0, css.indexOf('@media (prefers-color-scheme: light)')));
  it('light primary button text >= 4.5:1', () => {
    expect(contrast(light.accent, light['accent-ink'])).toBeGreaterThanOrEqual(4.5);
  });
  it('light accent on page/panel backgrounds is usable as a focus ring (>= 3:1)', () => {
    expect(contrast(light.accent, light.bg)).toBeGreaterThanOrEqual(3);
    expect(contrast(light.accent, light.panel)).toBeGreaterThanOrEqual(3);
  });
  it('dark primary button text >= 4.5:1', () => {
    expect(contrast(dark.accent, dark['accent-ink'])).toBeGreaterThanOrEqual(4.5);
  });
});
