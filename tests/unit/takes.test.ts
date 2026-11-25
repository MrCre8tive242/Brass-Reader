import { describe, it, expect } from 'vitest';
import { MAX_TAKES, pickRecorderMime, takeExtension, takesToDelete } from '@/lib/takes';

describe('takes', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, createdAt: 1000 + i }));
  it('keeps at most 10 and drops the oldest', () => {
    expect(MAX_TAKES).toBe(10);
    expect(takesToDelete(mk(10))).toEqual([]);
    expect(takesToDelete(mk(11))).toEqual(['t0']);
    expect(takesToDelete(mk(13))).toEqual(['t2', 't1', 't0']);
    expect(takesToDelete(mk(5), 3)).toEqual(['t1', 't0']);
  });
  it('picks the first format the browser can record', () => {
    expect(pickRecorderMime((m) => m.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(pickRecorderMime((m) => m === 'audio/mp4')).toBe('audio/mp4'); // Safari
    expect(pickRecorderMime(() => false)).toBeUndefined();
    expect(pickRecorderMime(() => { throw new Error('x'); })).toBeUndefined();
  });
  it('names the download by its format', () => {
    expect(takeExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(takeExtension('audio/mp4')).toBe('m4a');
    expect(takeExtension('audio/ogg;codecs=opus')).toBe('ogg');
  });
});
