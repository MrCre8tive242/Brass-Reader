import { test, expect } from '@playwright/test';
import { collectConsoleErrors, openPractice, seedScore, fixture } from './helpers';
import { fakeMic, drumWav } from './audio';
import { openDrone } from './pitchHelpers';

const BPM = 112;
test.use({ launchOptions: fakeMic(drumWav(BPM)) });

type Chan = [Float32Array, Float32Array];
interface Lib {
  renderWhole(job: unknown, s: number): Promise<Chan>;
  AudioRenderer: new (job: unknown, s: number, rate?: number, seg?: number) => { segments: unknown[]; render(i: number): Promise<Chan> };
}
interface Job { audio: { drumsOn: boolean; drumHits: { slice?: number; inst?: string }[]; drumSource: { buffer: AudioBuffer | null } | null; mix: { volume: number; mute: boolean; solo: boolean }[]; partInstruments: string[] } }

// The sound of a video is checked here where it is made (rendered ahead of time, whole and in pieces); the files
// themselves are made in video.spec.ts.
test.describe('Video sound: what is in the mix', () => {
  test.setTimeout(180_000);

  test('your own recorded drummers are in the video, on the beat, and the pieces of sound still join', async ({ page }) => {
    const errs = collectConsoleErrors(page);
    await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__brTest = true; });
    await openDrone(page, 'vg1');
    await openPractice(page, 'drums');
    await page.getByRole('button', { name: 'Grooves…' }).click();
    await page.getByRole('button', { name: 'Record your drum line' }).click();
    await page.getByLabel('Click tempo').fill('240');
    await page.getByLabel('Click tempo').blur();
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByTestId('rec-state')).toContainText('Recording', { timeout: 5000 });
    await page.waitForTimeout(7500);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByTestId('groove-review')).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Groove name').fill('Fake band');
    await page.getByRole('button', { name: 'Save groove' }).click();
    await expect(page.getByTestId('groove-row')).toHaveCount(1);
    await page.getByRole('button', { name: 'Close grooves' }).click();
    await page.getByLabel('Groove', { exact: true }).selectOption({ label: 'Fake band' });
    await expect(page.getByTestId('drums-status')).toBeHidden({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Close practice tools' }).click();
    await page.getByLabel('BPM', { exact: true }).fill('120');
    await page.getByLabel('BPM', { exact: true }).blur();

    await page.getByTestId('download-video').click();
    const d = page.getByTestId('video-dialog');
    await expect(d.getByLabel('Include drums')).toBeChecked();
    await page.waitForFunction(() => { const w = window as unknown as Record<string, unknown>; return !!w.__brVideoLib && !!w.__brVideoJob; });
    // the drums alone (horn muted), whole and in pieces
    const r = await page.evaluate(async () => {
      const w = window as unknown as { __brVideoLib: Lib; __brVideoJob: () => Job };
      const job = w.__brVideoJob();
      const audio = { ...job.audio, mix: job.audio.mix.map((m) => ({ ...m, mute: true })) };
      const secs = 8;
      const whole = await w.__brVideoLib.renderWhole(audio, secs);
      const pieces = new w.__brVideoLib.AudioRenderer(audio, secs, 48000, 2);
      let pos = 0, diff = 0;
      for (let i = 0; i < pieces.segments.length; i++) {
        const [l] = await pieces.render(i);
        for (let k = 0; k < l.length; k++) diff = Math.max(diff, Math.abs(l[k] - whole[0][pos + k]));
        pos += l.length;
      }
      const rms: number[] = [];
      for (let s = 0; s < secs; s++) { let sum = 0; for (let k = s * 48000; k < (s + 1) * 48000; k++) sum += whole[0][k] * whole[0][k]; rms.push(Math.sqrt(sum / 48000)); }
      const noDrums = await w.__brVideoLib.renderWhole({ ...audio, drumsOn: false }, 2);
      let quiet = 0; for (let k = 0; k < noDrums[0].length; k++) quiet = Math.max(quiet, Math.abs(noDrums[0][k]));
      return { slices: job.audio.drumHits.filter((h) => h.slice !== undefined).length, kit: job.audio.drumHits.filter((h) => h.inst).length, hasBuffer: !!job.audio.drumSource?.buffer, n: pieces.segments.length, diff, rms, quiet };
    });
    expect(r.hasBuffer).toBe(true);
    expect(r.slices).toBeGreaterThan(6); // the hits are slices of the recording, not the starter kit
    expect(r.kit).toBe(0);
    expect(r.n).toBe(4);
    for (let s = 0; s < 8; s++) expect(r.rms[s], `drums in second ${s}`).toBeGreaterThan(0.01);
    expect(r.diff).toBeLessThan(1e-3);
    expect(r.quiet).toBeLessThan(1e-4); // nothing but the drums was playing

    expect(errs).toEqual([]);
  });

  test('a band score: the video sounds every part as mixed, and shows only mine', async ({ page }) => {
    await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__brTest = true; });
    await seedScore(page, 'vg2', 'Two Parts', fixture('qa-twoparts.musicxml'));
    await page.goto('/score/vg2');
    await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
    await page.getByLabel('Part').selectOption('1'); // the second part is mine
    await expect(page.getByTestId('score')).toHaveAttribute('data-busy', '0', { timeout: 30_000 });
    await page.getByLabel('BPM', { exact: true }).fill('240');
    await page.getByLabel('BPM', { exact: true }).blur();
    await page.getByTestId('download-video').click();
    await page.waitForFunction(() => { const w = window as unknown as Record<string, unknown>; return !!w.__brVideoLib && !!w.__brVideoJob; });
    const r = await page.evaluate(async () => {
      const w = window as unknown as { __brVideoLib: Lib; __brVideoJob: () => Job & { myIdx: number; tl: { events: { part?: number }[] } } };
      const job = w.__brVideoJob();
      const level = async (mix: Job['audio']['mix']) => { const [l] = await w.__brVideoLib.renderWhole({ ...job.audio, mix }, 4); let s = 0; for (let k = 0; k < l.length; k++) s += l[k] * l[k]; return Math.sqrt(s / l.length); };
      const on = { volume: 1, mute: false, solo: false }, off = { volume: 1, mute: true, solo: false };
      return {
        parts: job.audio.partInstruments.length, myIdx: job.myIdx, both: await level([on, on]), first: await level([on, off]), second: await level([off, on]), none: await level([off, off]),
        partsWithNotes: [...new Set(job.tl.events.map((e) => e.part ?? 0))].sort(),
      };
    });
    expect(r.parts).toBe(2);
    expect(r.myIdx).toBe(1);
    expect(r.partsWithNotes).toEqual([0, 1]);
    expect(r.first).toBeGreaterThan(0.003);
    expect(r.second).toBeGreaterThan(0.003);
    expect(r.none).toBeLessThan(1e-5);
  });
});
