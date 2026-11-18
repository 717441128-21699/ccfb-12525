/**
 * Full GPU analysis pipeline.
 *
 * Frame flow per processed frame:
 *   video frame --warp--> board-res rectified color
 *      |-- downscale to analysis res --> foreground seeds (motion + bg diff)
 *      |        CPU readback -> connected components -> person mask
 *      |        (white shirt survives via motion/history, never via color)
 *      |-- background model EMA, frozen under person mask
 *      |-- change map vs committed board -> tile reduction -> CPU readback
 *      |-- CPU TileGate decides stable commits -> commit mask -> board update
 *   board texture = the clean, person-free accumulated whiteboard.
 */
import type {
  ExtractionConfig,
  Mat3,
  Quad,
  TileFrameStats,
} from '../types.js';
import {
  PassRenderer,
  Program,
  Texture2D,
  attachFramebuffer,
  createPingPong,
  createProgram,
  createTexture,
  fullscreenVS,
  readTextureBytes,
  uploadByteTexture,
  uploadImageSource,
  type PingPong,
} from './glEngine.js';
import {
  BG_ADAPT_FS,
  BOARD_COMMIT_FS,
  CHANGE_FS,
  COMMIT_MASK_FS,
  ERASE_FS,
  INK_LAYER_FS,
  SEED_FS,
  TILE_REDUCE_FS,
  UPSCALE_FS,
  UPSCALE_MASK_FS,
  WARP_FS,
} from './shaders.js';
import { filterAndFillBlobs, temporalHold } from '../core/components.js';
import { homographyToRect, invertMat3 } from '../core/geometry.js';

export interface PipelineFrameResult {
  stats: TileFrameStats;
  personRatio: number;
}

export class AnalysisPipeline {
  readonly gl: WebGL2RenderingContext;
  readonly cfg: ExtractionConfig;
  readonly aW: number;
  readonly aH: number;
  private renderer: PassRenderer;
  private fb: WebGLFramebuffer;

  private frameTex: Texture2D;
  private board: PingPong;
  private boardWarp: Texture2D;
  private prevColor: Texture2D;
  private bg: PingPong;
  private colorLow: Texture2D;
  private seed: Texture2D;
  private personLow: Texture2D;
  private personBoard: Texture2D;
  private change: Texture2D;
  private eraseTex: Texture2D;
  private tileTex: Texture2D;
  private eraseTileTex: Texture2D;
  private commitMask: Texture2D;
  private commitBoard: Texture2D;
  private tileGateTex: Texture2D;
  private layerTex: PingPong;

  private progWarp: Program;
  private progSeed: Program;
  private progBg: Program;
  private progChange: Program;
  private progErase: Program;
  private progTile: Program;
  private progCommit: Program;
  private progUpscale: Program;
  private progUpscaleMask: Program;
  private progCommitMask: Program;
  private progLayer: Program;

  private age: Uint8Array;
  private frameW: number;
  private frameH: number;
  private invH: Mat3 | null = null;
  private prevFrameLoaded = false;

  constructor(gl: WebGL2RenderingContext, cfg: ExtractionConfig, frameW: number, frameH: number) {
    this.gl = gl;
    this.cfg = cfg;
    this.frameW = frameW;
    this.frameH = frameH;
    this.aW = Math.round(cfg.boardWidth / cfg.analysisScale);
    this.aH = Math.round(cfg.boardHeight / cfg.analysisScale);
    this.renderer = new PassRenderer(gl);
    this.fb = attachFramebuffer(gl);

    const boardInit = new Uint8Array(cfg.boardWidth * cfg.boardHeight * 4).fill(247);
    for (let i = 0; i < cfg.boardWidth * cfg.boardHeight; i++) boardInit[i * 4 + 3] = 255;
    this.board = createPingPong(gl, cfg.boardWidth, cfg.boardHeight, {
      filter: gl.LINEAR,
      data: boardInit,
    });
    this.frameTex = createTexture(gl, frameW, frameH, { filter: gl.LINEAR });
    this.boardWarp = createTexture(gl, cfg.boardWidth, cfg.boardHeight, { filter: gl.LINEAR });
    this.prevColor = createTexture(gl, this.aW, this.aH, { filter: gl.NEAREST });
    this.bg = createPingPong(gl, this.aW, this.aH, { filter: gl.NEAREST });
    this.colorLow = createTexture(gl, this.aW, this.aH, { filter: gl.LINEAR });
    this.seed = createTexture(gl, this.aW, this.aH, { filter: gl.NEAREST });
    this.personLow = createTexture(gl, this.aW, this.aH, { filter: gl.NEAREST });
    this.personBoard = createTexture(gl, cfg.boardWidth, cfg.boardHeight, {
      filter: gl.NEAREST,
    });
    this.change = createTexture(gl, this.aW, this.aH, { filter: gl.NEAREST });
    this.eraseTex = createTexture(gl, this.aW, this.aH, { filter: gl.NEAREST });
    this.tileTex = createTexture(gl, cfg.tileCols, cfg.tileRows, { filter: gl.NEAREST });
    this.eraseTileTex = createTexture(gl, cfg.tileCols, cfg.tileRows, { filter: gl.NEAREST });
    this.commitMask = createTexture(gl, this.aW, this.aH, { filter: gl.NEAREST });
    this.commitBoard = createTexture(gl, cfg.boardWidth, cfg.boardHeight, {
      filter: gl.NEAREST,
    });
    this.tileGateTex = createTexture(gl, cfg.tileCols, cfg.tileRows, { filter: gl.NEAREST });
    this.layerTex = createPingPong(gl, cfg.boardWidth, cfg.boardHeight, {
      filter: gl.LINEAR,
    });

    const vs = fullscreenVS();
    this.progWarp = createProgram(gl, vs, WARP_FS, ['uFrame', 'uInvH', 'uBoardSize', 'uFrameSize']);
    this.progSeed = createProgram(gl, vs, SEED_FS, [
      'uCur', 'uPrev', 'uBg', 'uMotionTh', 'uBgDiffTh',
    ]);
    this.progBg = createProgram(gl, vs, BG_ADAPT_FS, ['uBg', 'uCur', 'uPerson', 'uRate']);
    this.progChange = createProgram(gl, vs, CHANGE_FS, ['uCur', 'uBoard', 'uChangeTh']);
    this.progErase = createProgram(gl, vs, ERASE_FS, ['uCur', 'uBoard', 'uPerson']);
    this.progTile = createProgram(gl, vs, TILE_REDUCE_FS, [
      'uChange', 'uPerson', 'uTileCount',
    ]);
    this.progCommit = createProgram(gl, vs, BOARD_COMMIT_FS, ['uBoard', 'uCur', 'uCommit']);
    this.progUpscale = createProgram(gl, vs, UPSCALE_FS, ['uMask']);
    this.progUpscaleMask = createProgram(gl, vs, UPSCALE_MASK_FS, ['uMask']);
    this.progCommitMask = createProgram(gl, vs, COMMIT_MASK_FS, [
      'uTileGate', 'uChange', 'uPerson', 'uTileCount',
    ]);
    this.progLayer = createProgram(gl, vs, INK_LAYER_FS, ['uBoard', 'uLayer']);

    this.age = new Uint8Array(this.aW * this.aH);
  }

  /** Update rectification homography from the detected video-space quad. */
  setBoardQuad(quad: Quad) {
    const h = homographyToRect(quad, this.cfg.boardWidth, this.cfg.boardHeight);
    this.invH = invertMat3(h);
    // GLSL mat3 uniforms are column-major; transpose the row-major CPU matrix.
    const m = this.invH;
    this.invHGL = new Float32Array([
      m[0], m[3], m[6],
      m[1], m[4], m[7],
      m[2], m[5], m[8],
    ]);
  }
  private invHGL: Float32Array | null = null;

  get boardTexture(): Texture2D {
    return this.board.read;
  }


  private ensureFrame(source: TexImageSource) {
    uploadImageSource(this.gl, this.frameTex, source);
  }

  /**
   * Process one rectifiable frame.
   * @param source canvas / VideoFrame-backed image
   * @param commitsTileMask optional precomputed commit mask setter
   */
  process(source: TexImageSource): PipelineFrameResult {
    const gl = this.gl;
    if (!this.invH) throw new Error('Board quad must be set before processing frames');
    this.renderer.bind();
    this.ensureFrame(source);

    // 1) Rectify to board resolution (flip Y handled in shader).
    this.renderer.draw(
      this.progWarp, this.boardWarp,
      [{ tex: this.frameTex, unit: 0, name: 'uFrame' }],
      (u) => {
        gl.uniformMatrix3fv(u.uInvH!, false, this.invHGL!);
        gl.uniform2f(u.uBoardSize!, this.cfg.boardWidth, this.cfg.boardHeight);
        gl.uniform2f(u.uFrameSize!, this.frameW, this.frameH);
      },
    );

    // 2) Downscale rectified color for analysis (draw into low-res target).
    this.renderer.draw(this.progUpscale, this.colorLow, [
      { tex: this.boardWarp, unit: 0, name: 'uMask' },
    ]);

    // 3) Foreground seeds: motion + background difference.
    if (this.prevFrameLoaded) {
      this.renderer.draw(this.progSeed, this.seed, [
        { tex: this.colorLow, unit: 0, name: 'uCur' },
        { tex: this.prevColor, unit: 1, name: 'uPrev' },
        { tex: this.bg.read, unit: 2, name: 'uBg' },
      ], (u) => {
        gl.uniform1f(u.uMotionTh!, this.cfg.motionThreshold / 255);
        gl.uniform1f(u.uBgDiffTh!, this.cfg.bgDiffThreshold / 255);
      });
    } else {
      // First frame: seed BOTH the background model and the previous-frame
      // buffer with the current color, so frame 2's motion pass compares
      // against a real baseline instead of an uninitialized black texture.
      this.renderer.draw(this.progBg, this.bg.write, [
        { tex: this.bg.read, unit: 0, name: 'uBg' },
        { tex: this.colorLow, unit: 1, name: 'uCur' },
        { tex: this.personLow, unit: 2, name: 'uPerson' },
      ], (u) => gl.uniform1f(u.uRate!, 1.0));
      this.bg.swap();
      this.copyTexture(this.colorLow, this.prevColor);
      uploadByteTexture(gl, this.seed, new Uint8Array(this.aW * this.aH * 4));
    }

    // 4) CPU connected-component filtering -> person mask (analysis res).
    const seedBytes = readTextureBytes(gl, this.seed, this.fb);
    const rawMask = new Uint8Array(this.aW * this.aH);
    for (let i = 0; i < rawMask.length; i++) {
      // Motion OR background-difference seed.
      if (seedBytes[i * 4] > 0 || seedBytes[i * 4 + 1] > 0) rawMask[i] = 1;
    }
    const minBlob = Math.round(this.aW * this.aH * this.cfg.minPersonBlobRatio);
    const filled = filterAndFillBlobs(rawMask, this.aW, this.aH, minBlob, {
      fillBoundingBox: true,
      dilateRadius: 1,
    });
    const held = temporalHold(
      this.personPrev ?? new Uint8Array(this.aW * this.aH),
      filled, this.age, 6,
    );
    this.age = held.age;
    this.personPrev = held.mask;
    const personBytes = new Uint8Array(this.aW * this.aH * 4);
    let personCount = 0;
    for (let i = 0; i < held.mask.length; i++) {
      const v = held.mask[i] * 255;
      personBytes[i * 4] = v;
      personBytes[i * 4 + 1] = v;
      personBytes[i * 4 + 2] = v;
      personBytes[i * 4 + 3] = 255;
      if (v) personCount++;
    }
    uploadByteTexture(gl, this.personLow, personBytes);

    // 5) Background adaptation, frozen under the person.
    this.renderer.draw(this.progBg, this.bg.write, [
      { tex: this.bg.read, unit: 0, name: 'uBg' },
      { tex: this.colorLow, unit: 1, name: 'uCur' },
      { tex: this.personLow, unit: 2, name: 'uPerson' },
    ], (u) => gl.uniform1f(u.uRate!, this.cfg.bgAdaptRate));
    this.bg.swap();

    // 6) Change map vs the committed board.
    this.renderer.draw(this.progChange, this.change, [
      { tex: this.colorLow, unit: 0, name: 'uCur' },
      { tex: this.board.read, unit: 1, name: 'uBoard' },
    ], (u) => gl.uniform1f(u.uChangeTh!, this.cfg.changeThreshold / 255));

    // 6b) CPU morphological denoise: drop tiny isolated change components
    // (border anti-aliasing / codec shimmer) while keeping strokes, which form
    // connected lines of meaningful size.
    const rawChange = readTextureBytes(gl, this.change, this.fb);
    const changeMask = new Uint8Array(this.aW * this.aH);
    for (let i = 0; i < changeMask.length; i++) changeMask[i] = rawChange[i * 4] ? 1 : 0;
    const minChangeBlob = Math.max(6, Math.round(this.aW * this.aH * 0.00005));
    const cleanChange = filterAndFillBlobs(changeMask, this.aW, this.aH, minChangeBlob, {
      fillBoundingBox: false,
      dilateRadius: 0,
    });
    const cleanBytes = new Uint8Array(this.aW * this.aH * 4);
    for (let i = 0; i < cleanChange.length; i++) {
      if (cleanChange[i]) {
        cleanBytes[i * 4] = 255;
        cleanBytes[i * 4 + 1] = rawChange[i * 4 + 1];
        cleanBytes[i * 4 + 2] = rawChange[i * 4 + 2];
        cleanBytes[i * 4 + 3] = 255;
      }
    }
    uploadByteTexture(gl, this.change, cleanBytes);

    // 7) Upscale person mask to board res for the commit shader and tile stats.
    this.renderer.draw(this.progUpscale, this.personBoard, [
      { tex: this.personLow, unit: 0, name: 'uMask' },
    ]);

    // 7b) Objective erase signal: board ink that vanished in the current
    //     frame, independent of the person gate.
    this.renderer.draw(this.progErase, this.eraseTex, [
      { tex: this.colorLow, unit: 0, name: 'uCur' },
      { tex: this.board.read, unit: 1, name: 'uBoard' },
      { tex: this.personLow, unit: 2, name: 'uPerson' },
    ]);

    // 8) Tile reduction -> CPU stats.
    this.renderer.draw(this.progTile, this.tileTex, [
      { tex: this.change, unit: 0, name: 'uChange' },
      { tex: this.personLow, unit: 1, name: 'uPerson' },
    ], (u) => gl.uniform2f(u.uTileCount!, this.cfg.tileCols, this.cfg.tileRows));
    const tileBytes = readTextureBytes(gl, this.tileTex, this.fb);

    // Erase fraction per tile via the same reduction kernel (R channel).
    this.renderer.draw(this.progTile, this.eraseTileTex, [
      { tex: this.eraseTex, unit: 0, name: 'uChange' },
      { tex: this.personLow, unit: 1, name: 'uPerson' },
    ], (u) => gl.uniform2f(u.uTileCount!, this.cfg.tileCols, this.cfg.tileRows));
    const eraseTileBytes = readTextureBytes(gl, this.eraseTileTex, this.fb);

    const nTiles = this.cfg.tileCols * this.cfg.tileRows;
    const stats: TileFrameStats = {
      changeFrac: new Float32Array(nTiles),
      personFrac: new Float32Array(nTiles),
      inkNow: new Float32Array(nTiles),
      eraseFrac: new Float32Array(nTiles),
    };
    for (let i = 0; i < nTiles; i++) {
      stats.changeFrac[i] = tileBytes[i * 4] / 255;
      stats.personFrac[i] = tileBytes[i * 4 + 1] / 255;
      stats.inkNow[i] = tileBytes[i * 4 + 2] / 255;
      stats.eraseFrac[i] = eraseTileBytes[i * 4] / 255;
    }

    // 9) Current frame becomes previous for the next motion pass.
    this.copyColorToPrev();
    this.prevFrameLoaded = true;

    return {
      stats,
      personRatio: personCount / (this.aW * this.aH),
    };
  }

  private personPrev: Uint8Array | null = null;

  private copyColorToPrev() {
    this.copyTexture(this.colorLow, this.prevColor);
  }

  private copyTexture(src: Texture2D, dst: Texture2D) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst.tex, 0);
    gl.viewport(0, 0, dst.width, dst.height);
    gl.useProgram(this.progUpscale.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    const loc = this.progUpscale.uniforms.uMask;
    if (loc) gl.uniform1i(loc, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Apply tile commits decided by the CPU TileGate, at pixel granularity.
   *
   * Only pixels that (a) belong to a gate-accepted tile, (b) actually differ
   * from the committed board and (c) are not covered by the person are merged
   * from the current rectified frame. This prevents a teacher standing in a
   * tile from ever being painted into the accumulated whiteboard.
   *
   * @param tiles map tile index -> 'add' | 'erase'
   */
  applyCommits(tiles: Map<number, 'add' | 'erase'>) {
    const gl = this.gl;
    if (tiles.size === 0) return;

    // 1) Pack accepted tiles into a small tileCols x tileRows gate texture.
    const gateData = new Uint8Array(this.cfg.tileCols * this.cfg.tileRows * 4);
    for (const [idx, kind] of tiles) {
      const o = idx * 4;
      gateData[o] = 255;
      if (kind === 'erase') gateData[o + 1] = 255;
      gateData[o + 3] = 255;
    }
    uploadByteTexture(gl, this.tileGateTex, gateData);

    // 2) Pixel-level commit mask at analysis resolution (gate AND change AND
    //    not-person). The change texture already holds denoised change flags.
    this.renderer.bind();
    this.renderer.draw(this.progCommitMask, this.commitMask, [
      { tex: this.tileGateTex, unit: 0, name: 'uTileGate' },
      { tex: this.change, unit: 1, name: 'uChange' },
      { tex: this.personLow, unit: 2, name: 'uPerson' },
    ], (u) => gl.uniform2f(u.uTileCount!, this.cfg.tileCols, this.cfg.tileRows));

    // Mark erase tiles in the G channel so the board merge can reset them.
    if ([...tiles.values()].includes('erase')) {
      const eraseBytes = readTextureBytes(gl, this.commitMask, this.fb);
      for (const [idx, kind] of tiles) {
        if (kind !== 'erase') continue;
        const col = idx % this.cfg.tileCols;
        const row = (idx / this.cfg.tileCols) | 0;
        const tw = this.aW / this.cfg.tileCols;
        const th = this.aH / this.cfg.tileRows;
        for (let y = Math.round(row * th); y < Math.round((row + 1) * th); y++) {
          for (let x = Math.round(col * tw); x < Math.round((col + 1) * tw); x++) {
            eraseBytes[(y * this.aW + x) * 4 + 1] = 255;
          }
        }
      }
      uploadByteTexture(gl, this.commitMask, eraseBytes);
    }

    // 3) Upscale the pixel mask to board resolution, preserving R/G flags.
    this.renderer.draw(this.progUpscaleMask, this.commitBoard, [
      { tex: this.commitMask, unit: 0, name: 'uMask' },
    ]);

    // 4) Merge into the board ping-pong.
    this.renderer.draw(this.progCommit, this.board.write, [
      { tex: this.board.read, unit: 0, name: 'uBoard' },
      { tex: this.boardWarp, unit: 1, name: 'uCur' },
      { tex: this.commitBoard, unit: 2, name: 'uCommit' },
    ]);
    this.board.swap();
  }

  /** Snapshot the current board to an ImageBitmap (via 2D canvas). */
  async snapshotBoard(): Promise<ImageBitmap> {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.board.read.tex, 0,
    );
    gl.viewport(0, 0, this.cfg.boardWidth, this.cfg.boardHeight);
    const buf = new Uint8Array(this.cfg.boardWidth * this.cfg.boardHeight * 4);
    gl.readPixels(0, 0, this.cfg.boardWidth, this.cfg.boardHeight, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // GL rows are bottom-up; flip into a canvas.
    const canvas = document.createElement('canvas');
    canvas.width = this.cfg.boardWidth;
    canvas.height = this.cfg.boardHeight;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(canvas.width, canvas.height);
    const rowBytes = canvas.width * 4;
    for (let y = 0; y < canvas.height; y++) {
      img.data.set(
        buf.subarray((canvas.height - 1 - y) * rowBytes, (canvas.height - y) * rowBytes),
        y * rowBytes,
      );
    }
    ctx.putImageData(img, 0, 0);
    return createImageBitmap(canvas);
  }

  /** Render one separated ink layer (0 red, 1 blue, 2 black) as a canvas. */
  snapshotLayerCanvas(layer: 0 | 1 | 2): HTMLCanvasElement {
    const gl = this.gl;
    this.renderer.bind();
    this.renderer.draw(this.progLayer, this.layerTex.write, [
      { tex: this.board.read, unit: 0, name: 'uBoard' },
    ], (u) => gl.uniform1i(u.uLayer!, layer));
    const tex = this.layerTex.write;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.tex, 0);
    const buf = new Uint8Array(tex.width * tex.height * 4);
    gl.readPixels(0, 0, tex.width, tex.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    this.layerTex.swap();
    const canvas = document.createElement('canvas');
    canvas.width = tex.width;
    canvas.height = tex.height;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(canvas.width, canvas.height);
    const rowBytes = canvas.width * 4;
    for (let y = 0; y < canvas.height; y++) {
      img.data.set(
        buf.subarray((canvas.height - 1 - y) * rowBytes, (canvas.height - y) * rowBytes),
        y * rowBytes,
      );
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  boardCanvas(): HTMLCanvasElement {
    return this.dumpTexture(this.board.read);
  }

  /** Canvas dump of the current perspective-rectified frame. */
  warpCanvas(): HTMLCanvasElement {
    return this.dumpTexture(this.boardWarp);
  }

  private dumpTexture(tex: Texture2D): HTMLCanvasElement {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.tex, 0,
    );
    const buf = new Uint8Array(tex.width * tex.height * 4);
    gl.readPixels(0, 0, tex.width, tex.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const canvas = document.createElement('canvas');
    canvas.width = tex.width;
    canvas.height = tex.height;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(canvas.width, canvas.height);
    const rowBytes = canvas.width * 4;
    for (let y = 0; y < canvas.height; y++) {
      img.data.set(
        buf.subarray((canvas.height - 1 - y) * rowBytes, (canvas.height - y) * rowBytes),
        y * rowBytes,
      );
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }
}
