import { describe, it, expect } from 'vitest';
import { INSTRUMENTS, concertRange } from '@/lib/instruments';

describe('instruments', () => {
  it('has the five instruments with the planned transpositions', () => {
    expect(INSTRUMENTS.trumpet.writtenToConcert).toBe(-2);
    expect(INSTRUMENTS.mellophone.writtenToConcert).toBe(-7);
    expect(INSTRUMENTS.sousaphone.writtenToConcert).toBe(0);
    expect(INSTRUMENTS.trombone.clef).toBe('bass');
  });
  it('computes concert ranges', () => {
    expect(concertRange('trumpet')).toEqual([52, 82]);
    expect(concertRange('trombone')).toEqual([40, 70]);
  });
});
