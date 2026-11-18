/**
 * Shared type definitions for the whiteboard extraction pipeline.
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** Four corners ordered top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Vec2, Vec2, Vec2, Vec2];

/** Row-major 3x3 matrix. */
export type Mat3 = number[];

export type InkLayerName = 'red' | 'blue' | 'black';

export type InkClass = 'white' | InkLayerName | 'other';

/** Per-tile operation flags produced for one processed frame. */
export interface TileFrameStats {
  /** Fraction of tile pixels flagged as changed vs committed board. */
  changeFrac: Float32Array;
  /** Fraction of tile pixels covered by the person mask. */
  personFrac: Float32Array;
  /** Mean ink amount (0..1, darkness/color distance from white) in current frame. */
  inkNow: Float32Array;
  /** Fraction of tile pixels where board ink disappeared (objective erase). */
  eraseFrac: Float32Array;
}

export interface TileRect {
  col: number;
  row: number;
  /** Board-space pixel rectangle. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageTiming {
  pageIndex: number;
  startMs: number;
  endMs: number;
  totalWritingMs: number;
  /** Tile that accumulated the most writing time. */
  longestTile: TileRect;
  longestWritingMs: number;
  /** Per-tile accumulated writing time, indexed row*cols+col. */
  tileWritingMs: Float32Array;
}

export interface PageRecord extends PageTiming {
  /** Snapshot of the committed board texture at page close (board pixels). */
  snapshot: ImageBitmap | null;
  /** Layer-separated snapshots, filled on demand. */
  layers: Partial<Record<InkLayerName, ImageBitmap>>;
  /** Number of committed add/erase tile-events, useful for tests. */
  addEvents: number;
  eraseEvents: number;
}

export interface ExtractionConfig {
  /** Canonical board width the warped board is rectified to. */
  boardWidth: number;
  boardHeight: number;
  /** Analysis texture is board size divided by this. */
  analysisScale: number;
  tileCols: number;
  tileRows: number;
  /** Process every Nth video frame (1 = every frame). */
  frameStride: number;
  /** Consecutive stable frames before a changed tile is committed. */
  stableFrames: number;
  /** Erased fraction of active tiles that forces a new page. */
  eraseNewPageRatio: number;
  /** Motion luma difference threshold (0..255). */
  motionThreshold: number;
  /** Background color-distance threshold (0..~442). */
  bgDiffThreshold: number;
  /** Minimum person blob area as fraction of analysis pixels. */
  minPersonBlobRatio: number;
  /** Background EMA adaptation rate per processed frame. */
  bgAdaptRate: number;
  /** Board color-difference threshold for change detection (0..255 per channel avg). */
  changeThreshold: number;
  /** Re-run board quad detection every N processed frames. */
  detectInterval: number;
  /** Corner EMA smoothing factor (0 = freeze on first detection). */
  quadSmoothing: number;
}

export const DEFAULT_CONFIG: ExtractionConfig = {
  boardWidth: 1600,
  boardHeight: 900,
  analysisScale: 3,
  tileCols: 16,
  tileRows: 9,
  frameStride: 1,
  stableFrames: 3,
  eraseNewPageRatio: 0.25,
  motionThreshold: 10,
  bgDiffThreshold: 30,
  minPersonBlobRatio: 0.0008,
  bgAdaptRate: 0.05,
  changeThreshold: 20,
  detectInterval: 12,
  quadSmoothing: 0.35,
};
