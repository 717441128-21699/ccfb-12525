declare module 'mp4box' {
  export interface MP4TrackInfo {
    id: number;
    type: string;
    codec: string;
    track_width?: number;
    track_height?: number;
    movie_duration?: number;
    timescale?: number;
    nb_samples?: number;
  }

  export interface MP4Info {
    duration: number;
    timescale: number;
    tracks: MP4TrackInfo[];
    videoTracks?: MP4TrackInfo[];
  }

  export interface MP4Sample {
    track_id: number;
    description: Uint8Array;
    data: ArrayBuffer;
    dts: number;
    cts: number;
    duration: number;
    is_sync: boolean;
  }

  export interface MP4File {
    onReady: (info: MP4Info) => void;
    onSamples: (id: number, user: unknown, samples: MP4Sample[]) => void;
    onError: (reason: string) => void;
    appendBuffer(buf: ArrayBuffer & { fileStart?: number }): number;
    flush(): void;
    start(): void;
    setExtractionOptions(
      trackId: number,
      user?: unknown,
      opts?: { nbSamples?: number; [k: string]: unknown },
    ): void;
  }

  export function createFile(): MP4File;
}
