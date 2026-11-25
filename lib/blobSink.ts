/**
 * A file that is written piece by piece, at any position, and ends up as one Blob. The muxers write the video this way
 * (mostly front to back, with a few small corrections near the start at the end). Each piece is handed to the browser
 * as a Blob straight away, so the finished parts of a long video do not pile up in the page's own memory: a browser
 * keeps Blobs outside the page (and may put large ones on disk).
 */
interface Span { pos: number; len: number; blob: Blob }

export class BlobSink {
  private spans: Span[] = [];
  private total = 0;

  /** Bytes written so far (the furthest position reached). */
  get size(): number { return this.total; }

  /** Put `data` at byte `pos`. Later writes replace what was there. */
  write(data: Uint8Array, pos: number) {
    const len = data.byteLength;
    if (!len) return;
    // copy: the muxer reuses its buffers
    const span: Span = { pos, len, blob: new Blob([data.slice() as unknown as BlobPart]) };
    this.total = Math.max(this.total, pos + len);
    const last = this.spans[this.spans.length - 1];
    if (!last || pos >= last.pos + last.len) { this.spans.push(span); return; }
    this.insert(span);
  }

  private insert(s: Span) {
    const out: Span[] = [];
    const end = s.pos + s.len;
    let placed = false;
    for (const o of this.spans) {
      const oEnd = o.pos + o.len;
      if (oEnd <= s.pos) { out.push(o); continue; }
      if (o.pos >= end) { if (!placed) { out.push(s); placed = true; } out.push(o); continue; }
      // overlap: keep what sticks out on either side
      if (o.pos < s.pos) out.push({ pos: o.pos, len: s.pos - o.pos, blob: o.blob.slice(0, s.pos - o.pos) });
      if (!placed) { out.push(s); placed = true; }
      if (oEnd > end) out.push({ pos: end, len: oEnd - end, blob: o.blob.slice(end - o.pos) });
    }
    if (!placed) out.push(s);
    this.spans = out;
  }

  /** The whole file. Throws if a part of it was never written. */
  finish(type: string): Blob {
    let at = 0;
    for (const s of this.spans) {
      if (s.pos !== at) throw new Error(`The video file has a hole at byte ${at}.`);
      at += s.len;
    }
    const blob = new Blob(this.spans.map((s) => s.blob), { type });
    this.spans = [];
    return blob;
  }
}
