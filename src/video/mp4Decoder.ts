/**
 * MP4 demuxing (mp4box) + WebCodecs VideoDecoder, exposed as an async
 * FrameSource. Each decoded VideoFrame is yielded to the caller and closed
 * after processing, keeping steady-state memory flat.
 */
import type { FrameSource, VideoFrameData } from '../extractor.js';

// mp4box ships no types; the ambient declaration lives in src/types/mp4box.d.ts.
import { createFile, type MP4File, type MP4Info, type MP4Sample } from 'mp4box';

interface FrameWaiter {
  resolve: (f: VideoFrame | null) => void;
}

export class Mp4FrameSource implements FrameSource {
  readonly width: number;
  readonly height: number;
  readonly durationSec: number;
  private decoder: VideoDecoder;
  private queue: VideoFrame[] = [];
  private waiters: FrameWaiter[] = [];
  private ended = false;
  private failed: Error | null = null;
  private flushed = false;

  private constructor(
    file: MP4File,
    info: MP4Info,
    decoder: VideoDecoder,
    width: number,
    height: number,
  ) {
    void file;
    this.decoder = decoder;
    this.width = width;
    this.height = height;
    this.durationSec = info.duration / info.timescale;
  }

  static async create(buffer: ArrayBuffer): Promise<Mp4FrameSource> {
    if (typeof VideoDecoder === 'undefined') {
      throw new Error('WebCodecs VideoDecoder is not available in this browser');
    }
    const file = createFile();
    const ready = new Promise<MP4Info>((resolve, reject) => {
      file.onReady = resolve;
      file.onError = (reason) => reject(new Error(`mp4box error: ${reason}`));
    });

    const owned = buffer.slice(0) as ArrayBuffer & { fileStart?: number };
    owned.fileStart = 0;
    file.appendBuffer(owned);
    file.flush();
    const info = await ready;

    const track = info.videoTracks?.[0] ?? info.tracks.find((t) => t.type === 'video');
    if (!track) throw new Error('MP4 contains no video track');
    if (!/avc|hev|vp0?9|av01/i.test(track.codec)) {
      throw new Error(`Unsupported video codec: ${track.codec}`);
    }

    const instRef: { value: Mp4FrameSource | null } = { value: null };
    const decoder = new VideoDecoder({
      output: (frame) => {
        const inst = instRef.value;
        if (!inst) {
          frame.close();
          return;
        }
        const waiter = inst.waiters.shift();
        if (waiter) waiter.resolve(frame);
        else inst.queue.push(frame);
      },
      error: (e) => {
        const inst = instRef.value;
        const err = e instanceof Error ? e : new Error(String(e));
        if (inst) {
          inst.failed = err;
          for (const w of inst.waiters) w.resolve(null);
          inst.waiters.length = 0;
        }
      },
    });

    const support = await VideoDecoder.isConfigSupported({
      codec: track.codec,
      codedWidth: track.track_width,
      codedHeight: track.track_height,
    });
    if (!support.supported) throw new Error(`Codec not supported by WebCodecs: ${track.codec}`);

    const inst = new Mp4FrameSource(
      file,
      info,
      decoder,
      track.track_width ?? 1280,
      track.track_height ?? 720,
    );
    instRef.value = inst;

    let configured = false;
    file.onSamples = (_id, _user, samples: MP4Sample[]) => {
      for (const sample of samples) {
        if (!configured) {
          decoder.configure({
            codec: track.codec,
            codedWidth: track.track_width,
            codedHeight: track.track_height,
            description: sample.description && sample.description.length
              ? sample.description
              : undefined,
          });
          configured = true;
        }
        const chunk = new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: (sample.cts * 1e6) / info.timescale,
          duration: (sample.duration * 1e6) / info.timescale,
          data: sample.data,
        });
        decoder.decode(chunk);
      }
    };
    file.setExtractionOptions(track.id, null, { nbSamples: 100 });
    file.start();

    return inst;
  }

  private async nextFrame(): Promise<VideoFrame | null> {
    if (this.failed) throw this.failed;
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.ended) return null;

    // Once all input has been demuxed, flush the decoder once and wind down.
    if (this.decoder.decodeQueueSize === 0 && this.flushed) {
      this.ended = true;
      return null;
    }
    const frame = await new Promise<VideoFrame | null>((resolve) => {
      this.waiters.push({ resolve });
    });
    if (frame === null) {
      this.ended = true;
      return null;
    }
    return frame;
  }

  /** Called by the host when the entire file has been fed; flushes decode. */
  async signalInputComplete(): Promise<void> {
    if (this.flushed) return;
    this.flushed = true;
    try {
      await this.decoder.flush();
    } catch {
      /* decoder may have errored; nextFrame will surface it */
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(null);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<VideoFrameData> {
    while (true) {
      const frame = await this.nextFrame();
      if (!frame) break;
      const data: VideoFrameData = {
        image: frame,
        timestampSec: frame.timestamp / 1e6,
        width: this.width,
        height: this.height,
      };
      try {
        yield data;
      } finally {
        frame.close();
      }
    }
  }

  async close() {
    try {
      if (this.decoder.state !== 'closed') this.decoder.close();
    } catch {
      /* noop */
    }
  }
}
