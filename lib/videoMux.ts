import { Muxer as Mp4Muxer, StreamTarget as Mp4Stream } from 'mp4-muxer';
import { Muxer as WebmMuxer, StreamTarget as WebmStream } from 'webm-muxer';
import { BlobSink } from './blobSink';

export interface MuxSpec {
  container: 'mp4' | 'webm';
  /** MP4: `avc` (H.264). WebM: `V_VP9` or `V_VP8`. */
  video: 'avc' | 'V_VP9' | 'V_VP8';
  audio: 'aac' | 'opus';
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  channels: number;
}

/** Pieces of the file are handed over in blocks of this size. */
const BLOCK = 1 << 20;

/**
 * Writes encoded pictures and sound into an MP4 or WebM, a block at a time into a `BlobSink`, so that the page never
 * holds the whole file in its own memory (the MP4's index is written at the end, the usual place for a camera file).
 */
export class VideoMux {
  readonly sink = new BlobSink();
  readonly mime: string;
  private mp4: Mp4Muxer<Mp4Stream> | null = null;
  private webm: WebmMuxer<WebmStream> | null = null;
  videoChunks = 0;
  audioChunks = 0;

  constructor(readonly spec: MuxSpec) {
    const onData = (data: Uint8Array, position: number) => this.sink.write(data, position);
    if (spec.container === 'mp4') {
      if (spec.video !== 'avc') throw new Error('MP4 needs H.264 here.');
      this.mime = 'video/mp4';
      this.mp4 = new Mp4Muxer({
        target: new Mp4Stream({ onData, chunked: true, chunkSize: BLOCK }),
        video: { codec: 'avc', width: spec.width, height: spec.height, frameRate: spec.fps },
        audio: { codec: spec.audio, numberOfChannels: spec.channels, sampleRate: spec.sampleRate },
        fastStart: false,
        firstTimestampBehavior: 'offset',
      });
    } else {
      if (spec.video === 'avc' || spec.audio !== 'opus') throw new Error('WebM needs VP9 or VP8 with Opus here.');
      this.mime = 'video/webm';
      this.webm = new WebmMuxer({
        target: new WebmStream({ onData, chunked: true, chunkSize: BLOCK }),
        video: { codec: spec.video, width: spec.width, height: spec.height, frameRate: spec.fps },
        audio: { codec: 'A_OPUS', numberOfChannels: spec.channels, sampleRate: spec.sampleRate },
        firstTimestampBehavior: 'offset',
      });
    }
  }

  /** Bytes handed over so far. */
  get bytes(): number { return this.sink.size; }

  addVideo(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) {
    this.videoChunks++;
    if (this.mp4) this.mp4.addVideoChunk(chunk, meta); else this.webm!.addVideoChunk(chunk, meta);
  }
  addAudio(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) {
    this.audioChunks++;
    if (this.mp4) this.mp4.addAudioChunk(chunk, meta); else this.webm!.addAudioChunk(chunk, meta);
  }
  /** The same with plain bytes (times in microseconds). */
  addVideoRaw(data: Uint8Array, key: boolean, timestampUs: number, durationUs: number, meta?: EncodedVideoChunkMetadata) {
    this.videoChunks++;
    if (this.mp4) this.mp4.addVideoChunkRaw(data, key ? 'key' : 'delta', timestampUs, durationUs, meta);
    else this.webm!.addVideoChunkRaw(data, key ? 'key' : 'delta', timestampUs, meta);
  }
  addAudioRaw(data: Uint8Array, timestampUs: number, durationUs: number, meta?: EncodedAudioChunkMetadata) {
    this.audioChunks++;
    if (this.mp4) this.mp4.addAudioChunkRaw(data, 'key', timestampUs, durationUs, meta);
    else this.webm!.addAudioChunkRaw(data, 'key', timestampUs, meta);
  }

  /** Close the file and return it. */
  finish(): Blob {
    if (this.mp4) this.mp4.finalize(); else this.webm!.finalize();
    return this.sink.finish(this.mime);
  }
}
