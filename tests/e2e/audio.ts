import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { junkanooLoop, synthDrumLoop } from '../drumLoop';

/** A mono 16-bit WAV of a steady sine tone: the "player" behind Chromium's fake microphone. */
export function toneWav(name: string, hz: number, seconds = 30, rate = 44100): string {
  const file = path.join(os.tmpdir(), `brass-reader-${name}-${hz}.wav`);
  if (fs.existsSync(file)) return file;
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 0.5 * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
  return file;
}

/** Chromium launch options that give the page a microphone playing `wav`. */
export function fakeMic(wav: string) {
  return {
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      '--autoplay-policy=no-user-gesture-required', '--no-sandbox',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`,
    ],
  };
}

export const hzOf = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** A 30 s WAV of a drum loop (kick, snare, hats) at `bpm`: the "drummers" behind Chromium's fake microphone. */
export function drumWav(bpm: number, name = 'drums', seconds = 30, rate = 44100): string {
  const file = path.join(os.tmpdir(), `brass-reader-${name}-${bpm}.wav`);
  if (fs.existsSync(file)) return file;
  const bars = Math.round((seconds * bpm) / 240);
  const loop = synthDrumLoop(bpm, bars, rate);
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, loop[i % loop.length])) * 0.6 * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
  return file;
}

/**
 * A WAV of a Junkanoo-like drum line (goatskin drums with flams, two cowbells, people's timing) at `bpm`, quiet like a
 * phone held too far away: 8 bars that repeat, the "drum line" behind Chromium's fake microphone.
 */
export function lineWav(bpm: number, name = 'line', level = 0.3, rate = 44100): string {
  const file = path.join(os.tmpdir(), `brass-reader-${name}-${bpm}.wav`);
  if (fs.existsSync(file)) return file;
  const { samples } = junkanooLoop({ bpm, bars: 8, rate, jitterMs: 8, seed: 5, flamMs: 26, room: true, leadS: 0, tailS: 0 });
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(samples[i] * level * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
  return file;
}

/**
 * A WAV of a steady low brass note as a phone hears it: bright harmonics, the fundamental and the octave above it
 * mostly gone (the microphone rolls off under `cutHz`), a little room noise.
 */
export function lowBrassWav(name: string, hz: number, cutHz = 250, seconds = 30, rate = 48000): string {
  const file = path.join(os.tmpdir(), `brass-reader-${name}-${Math.round(hz * 10)}.wav`);
  if (fs.existsSync(file)) return file;
  // a whole number of periods, so the file loops without a click
  const n = Math.round(Math.round(seconds * hz) / hz * rate);
  const x = new Float32Array(n);
  for (let k = 1; k * hz < 5000; k++) {
    const f = k * hz, mic = (f / cutHz) ** 2 / Math.sqrt(1 + (f / cutHz) ** 4), a = mic / Math.pow(k, 0.8);
    for (let i = 0; i < n; i++) x[i] += a * Math.sin((2 * Math.PI * f * i) / rate + k * 1.3);
  }
  let peak = 0, seed = 11;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; buf.writeInt16LE(Math.round(((x[i] / peak) * 0.5 + 0.01 * (seed / 2147483648 - 1)) * 32767), 44 + i * 2); }
  fs.writeFileSync(file, buf);
  return file;
}
