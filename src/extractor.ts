/**
 * Top-level extraction orchestrator: drives board detection, the GL analysis
 * pipeline, the tile gate and the page state machine over a FrameSource.
 */
import type {
  ExtractionConfig,
  PageRecord,
  Quad,
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { AnalysisPipeline } from './gl/glPipeline.js';
import { detectBoardQuad } from './core/boardDetect.js';
import { PageManager, TileGate } from './core/paging.js';
import { emaQuad, quadSimilarity, scale as scalePt } from './core/geometry.js';

export interface VideoFrameData {
  image: CanvasImageSource & TexImageSource;
  timestampSec: number;
  width: number;
  height: number;
}

export interface FrameSource extends AsyncIterable<VideoFrameData> {
  readonly width: number;
  readonly height: number;
  readonly durationSec: number;
}

export interface ExtractionStats {
  framesProcessed: number;
  framesSkipped: number;
  wallMs: number;
  videoMs: number;
  /** Processing time as a ratio of video duration (<1 means faster than realtime). */
  realtimeFactor: number;
  detectedQuads: number;
  detectionFailures: number;
  personFrameRatio: number;
}

export interface ExtractionResult {
  pages: PageRecord[];
  quads: Quad[];
  stats: ExtractionStats;
  pipeline: AnalysisPipeline;
}

const DETECT_W = 320;

export class WhiteboardExtractor {
  private cfg: ExtractionConfig;
  private glCanvas: HTMLCanvasElement;
  private detectCanvas: HTMLCanvasElement;
  private detectCtx: CanvasRenderingContext2D;

  constructor(cfg: Partial<ExtractionConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.glCanvas = document.createElement('canvas');
    this.glCanvas.width = this.cfg.boardWidth;
    this.glCanvas.height = this.cfg.boardHeight;
    this.detectCanvas = document.createElement('canvas');
    this.detectCanvas.width = DETECT_W;
    this.detectCanvas.height = DETECT_W * 9 / 16;
    const ctx = this.detectCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.detectCtx = ctx;
  }

  get config(): ExtractionConfig {
    return this.cfg;
  }

  async run(source: FrameSource): Promise<ExtractionResult> {
    const t0 = performance.now();
    const gl = this.glCanvas.getContext('webgl2', {
      premultipliedAlpha: false,
      antialias: false,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    const pipeline = new AnalysisPipeline(gl, this.cfg, source.width, source.height);
    const gate = new TileGate(
      this.cfg.tileCols, this.cfg.tileRows,
      this.cfg.boardWidth, this.cfg.boardHeight,
      this.cfg.stableFrames,
    );
    const pages = new PageManager(gate, {
      eraseNewPageRatio: this.cfg.eraseNewPageRatio,
    });

    let quad: Quad | null = null;
    const quads: Quad[] = [];
    let framesProcessed = 0;
    let framesSkipped = 0;
    let detectedQuads = 0;
    let detectionFailures = 0;
    let personFrames = 0;
    let strideCount = 0;

    for await (const frame of source) {
      strideCount++;
      if ((strideCount - 1) % Math.max(1, this.cfg.frameStride) !== 0) {
        framesSkipped++;
        continue;
      }

      // ---- Board quad detection on a small CPU canvas at a fixed cadence.
      if (framesProcessed % this.cfg.detectInterval === 0 || !quad) {
        const det = this.detectQuad(frame);
        if (det.quad) {
          const scaled: Quad = det.quad.map((p) =>
            scalePt(p, source.width / this.detectCanvas.width),
          ) as Quad;
          if (!quad) {
            quad = scaled;
          } else if (quadSimilarity(quad, scaled) < 0.18) {
            quad = emaQuad(quad, scaled, this.cfg.quadSmoothing);
          } else {
            quad = emaQuad(quad, scaled, this.cfg.quadSmoothing * 0.25);
          }
          detectedQuads++;
          quads.push(quad);
        } else {
          detectionFailures++;
        }
      }
      if (!quad) {
        framesSkipped++;
        continue;
      }
      pipeline.setBoardQuad(quad);

      // ---- GPU analysis.
      const result = pipeline.process(frame.image);
      if (result.personRatio > 0.01) personFrames++;
      this.onStats?.(result.stats, frame.timestampSec);

      // ---- Objective erase-driven page break (person-independent).
      // Require a minimum number of simultaneously wiped tiles so a single
      // corrected stroke never starts a new page.
      const erasedTiles = pages.detectErase(result.stats);
      // A genuine board wipe hits several adjacent tiles at once and persists;
      // a teacher crossing in front of the board causes a transient blank that
      // disappears as they move. Require the signal to hold for several frames.
      const minEraseTiles = 3;
      if (erasedTiles >= minEraseTiles) {
        this.eraseStreak++;
      } else {
        this.eraseStreak = 0;
      }
      if (
        this.eraseStreak >= this.eraseConfirmFrames &&
        pages.hasActivePage &&
        !this.eraseBreakCooldown
      ) {
        // Snapshot the finished page BEFORE the erase is merged into board.
        const preErase = await pipeline.snapshotBoard();
        pages.forceBreak(frame.timestampSec, preErase);
        this.eraseBreakCooldown = this.cfg.tileCols * 2;
        this.eraseStreak = 0;
      }
      if (this.eraseBreakCooldown > 0) this.eraseBreakCooldown--;

      // ---- Tile stability gate.
      const commits = gate.process(result.stats, frame.timestampSec, 0.05);
      if (commits.length) {
        this.onCommit?.(commits, frame.timestampSec);
        const boundary = pages.evaluate(commits);
        let snapshot: ImageBitmap | null = null;
        if (boundary.closeBeforeApply) {
          // Snapshot BEFORE applying the erase so the finished page keeps
          // its pre-erase content.
          snapshot = await pipeline.snapshotBoard();
        }
        pages.commit(commits, frame.timestampSec, boundary.closeBeforeApply, snapshot);
        const tileKinds = new Map<number, 'add' | 'erase'>();
        for (const c of commits) tileKinds.set(c.index, c.kind);
        pipeline.applyCommits(tileKinds);
      }

      framesProcessed++;
    }

    const finalSnapshot = framesProcessed > 0 ? await pipeline.snapshotBoard() : null;
    const pageRecords = pages.finalize(
      source.durationSec || 0,
      finalSnapshot,
    );

    const wallMs = performance.now() - t0;
    const videoMs = source.durationSec * 1000;
    return {
      pages: pageRecords,
      quads,
      stats: {
        framesProcessed,
        framesSkipped,
        wallMs,
        videoMs,
        realtimeFactor: videoMs > 0 ? wallMs / videoMs : 0,
        detectedQuads,
        detectionFailures,
        personFrameRatio: framesProcessed ? personFrames / framesProcessed : 0,
      },
      pipeline,
    };
  }

  private detectQuad(frame: VideoFrameData) {
    const dw = this.detectCanvas.width;
    const dh = Math.round(dw * (frame.height / Math.max(1, frame.width)));
    if (this.detectCanvas.height !== dh) this.detectCanvas.height = dh;
    this.detectCtx.drawImage(frame.image, 0, 0, dw, dh);
    const img = this.detectCtx.getImageData(0, 0, dw, dh);
    const result = detectBoardQuad(img.data, dw, dh, this.hintQuad);
    if (result.quad) this.hintQuad = result.quad;
    return result;
  }

  private hintQuad: Quad | null = null;
  private eraseBreakCooldown = 0;
  private eraseStreak = 0;
  private eraseConfirmFrames = 4;

  /** Debug hook: receives every tile commit with its video timestamp. */
  onCommit: ((commits: import('./core/paging.js').TileCommit[], tSec: number) => void) | null = null;

  /** Debug hook: per-frame analysis stats. */
  onStats: ((stats: import('./types.js').TileFrameStats, tSec: number) => void) | null = null;

  /** Test/debug helper: force an initial quad (e.g. known board location). */
  setHint(quad: Quad) {
    this.hintQuad = quad;
  }
}
