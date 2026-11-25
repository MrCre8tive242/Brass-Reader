import { describe, it, expect } from 'vitest';
import { BlobSink } from '@/lib/blobSink';

const bytes = async (b: Blob) => [...new Uint8Array(await b.arrayBuffer())];
const u8 = (...n: number[]) => new Uint8Array(n);

describe('a file written in pieces', () => {
  it('pieces in order become one file', async () => {
    const s = new BlobSink();
    s.write(u8(1, 2, 3), 0);
    s.write(u8(4, 5), 3);
    s.write(u8(6), 5);
    expect(s.size).toBe(6);
    const b = s.finish('video/mp4');
    expect(b.type).toBe('video/mp4');
    expect(await bytes(b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a later write replaces what was there (the muxer goes back to fill in sizes)', async () => {
    const s = new BlobSink();
    s.write(u8(0, 0, 0, 0, 9, 9), 0);
    s.write(u8(7, 7, 7, 7), 6);
    s.write(u8(1, 2, 3, 4), 0); // inside the first piece
    s.write(u8(5, 5), 5); // across two pieces
    expect(await bytes(s.finish('x/y'))).toEqual([1, 2, 3, 4, 9, 5, 5, 7, 7, 7]);
  });

  it('pieces out of order are put in their places', async () => {
    const s = new BlobSink();
    s.write(u8(4, 5, 6), 3);
    s.write(u8(1, 2, 3), 0);
    s.write(u8(8, 9), 7);
    s.write(u8(7), 6);
    expect(await bytes(s.finish(''))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('the muxer may reuse its buffer after a write', async () => {
    const s = new BlobSink();
    const buf = u8(1, 2, 3);
    s.write(buf, 0);
    buf.fill(0);
    expect(await bytes(s.finish(''))).toEqual([1, 2, 3]);
  });

  it('a hole is an error, not a broken file', () => {
    const s = new BlobSink();
    s.write(u8(1), 0);
    s.write(u8(3), 2);
    expect(() => s.finish('video/mp4')).toThrow(/hole/);
  });
});
