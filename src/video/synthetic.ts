/**
 * Synthetic classroom scene generator: draws a virtual teacher in front of a
 * whiteboard onto a 2D canvas, frame by frame. The scripted scene encodes
 * ground-truth page boundaries, strokes and teacher positions so the end-to
 * end test can assert extraction correctness.
 *
 * Covered requirements:
 *  - teacher silhouette standing in front of the board, occluding a border
 *  - white shirt close in color to the whiteboard (must NOT be treated as
 *    blank board / background)
 *  - red / blue / black strokes
 *  - erase + rewrite -> second page
 *  - leave and come back to add more -> merged into one page
 */
import type { FrameSource, VideoFrameData } from '../extractor.js';
import type { Quad, Vec2 } from '../types.js';
import { v } from '../core/geometry.js';

export interface ScriptedStroke {
  id: string;
  color: string;
  /** Board-fraction coordinates 0..1, polyline points. */
  points: Vec2[];
  /** Frame interval in which the stroke is progressively drawn. */
  startFrame: number;
  endFrame: number;
  /** Frame interval in which this stroke is erased (null = never). */
  eraseStart?: number;
  eraseEnd?: number;
}

export interface TeacherPhase {
  startFrame: number;
  endFrame: number;
  /** Position in board-fraction coordinates (teacher center). */
  from: Vec2;
  to: Vec2;
  shirt: 'white' | 'dark';
}

export interface GroundTruth {
  fps: number;
  frameCount: number;
  width: number;
  height: number;
  /** Board quad in video pixel coordinates. */
  boardQuad: Quad;
  strokes: ScriptedStroke[];
  teacherPhases: TeacherPhase[];
  /** Page boundary: frame at which the erase of page 1 begins. */
  eraseBoundaryFrame: number;
  expectedPageCount: number;
  /** Board-fraction regions where each color should appear (for assertions). */
  colorRegions: { color: 'red' | 'blue' | 'black'; cx: number; cy: number }[];
}

export interface SyntheticOptions {
  fps?: number;
  width?: number;
  height?: number;
}

const BOARD_FRAC = {
  x0: 0.1,
  y0: 0.08,
  x1: 0.9,
  y1: 0.92,
};

export class SyntheticFrameSource implements FrameSource {
  readonly width: number;
  readonly height: number;
  readonly durationSec: number;
  readonly fps: number;
  readonly frameCount: number;
  readonly groundTruth: GroundTruth;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(opts: SyntheticOptions = {}) {
    this.fps = opts.fps ?? 10;
    this.width = opts.width ?? 1280;
    this.height = opts.height ?? 720;
    this.frameCount = 140;
    this.durationSec = this.frameCount / this.fps;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.groundTruth = this.buildScript();
  }

  private boardPx(): Quad {
    return [
      v(this.width * BOARD_FRAC.x0, this.height * BOARD_FRAC.y0),
      v(this.width * BOARD_FRAC.x1, this.height * BOARD_FRAC.y0),
      v(this.width * BOARD_FRAC.x1, this.height * BOARD_FRAC.y1),
      v(this.width * BOARD_FRAC.x0, this.height * BOARD_FRAC.y1),
    ];
  }

  private buildScript(): GroundTruth {
    const strokes: ScriptedStroke[] = [
      // Page 1: title in black, red underline, blue formula.
      {
        id: 'title',
        color: '#1a1a1a',
        points: [v(0.2, 0.22), v(0.34, 0.22), v(0.48, 0.22)],
        startFrame: 6,
        endFrame: 18,
      },
      {
        id: 'red-underline',
        color: '#d21f1f',
        points: [v(0.19, 0.28), v(0.34, 0.28), v(0.5, 0.28)],
        startFrame: 20,
        endFrame: 26,
      },
      {
        id: 'blue-formula',
        color: '#1f3fbf',
        points: [v(0.2, 0.42), v(0.32, 0.42), v(0.32, 0.52), v(0.44, 0.52)],
        startFrame: 28,
        endFrame: 40,
      },
      // Teacher leaves (42..52), comes back and adds a black note -> merged page.
      {
        id: 'note',
        color: '#222222',
        points: [v(0.55, 0.6), v(0.66, 0.6), v(0.72, 0.66)],
        startFrame: 54,
        endFrame: 62,
      },
      // Erase page 1 (66..76), then rewrite page 2.
      {
        id: 'title', // reused id on purpose: erased then rewritten
        color: '#1a1a1a',
        points: [v(0.2, 0.22), v(0.34, 0.22), v(0.48, 0.22)],
        startFrame: 80,
        endFrame: 92,
        eraseStart: 66,
        eraseEnd: 76,
      },
      {
        id: 'red-underline',
        color: '#d21f1f',
        points: [v(0.19, 0.28), v(0.34, 0.28), v(0.5, 0.28)],
        startFrame: 94,
        endFrame: 100,
        eraseStart: 66,
        eraseEnd: 76,
      },
      {
        id: 'blue-formula',
        color: '#1f3fbf',
        points: [v(0.2, 0.42), v(0.32, 0.42), v(0.32, 0.52), v(0.44, 0.52)],
        startFrame: 102,
        endFrame: 114,
        eraseStart: 66,
        eraseEnd: 76,
      },
      {
        id: 'note',
        color: '#222222',
        points: [v(0.55, 0.6), v(0.66, 0.6), v(0.72, 0.66)],
        startFrame: 116,
        endFrame: 124,
        eraseStart: 66,
        eraseEnd: 76,
      },
      // New red-only content on page 2 proving the rewrite differs.
      {
        id: 'p2-red-mark',
        color: '#d21f1f',
        points: [v(0.6, 0.35), v(0.7, 0.35), v(0.7, 0.45)],
        startFrame: 126,
        endFrame: 132,
      },
    ];

    const teacherPhases: TeacherPhase[] = [
      // White-shirt teacher walks in front of the board's left border.
      { startFrame: 0, endFrame: 42, from: v(0.16, 0.55), to: v(0.3, 0.55), shirt: 'white' },
      // Off-board.
      { startFrame: 42, endFrame: 52, from: v(-0.2, 0.55), to: v(-0.2, 0.55), shirt: 'white' },
      // Returns, still white shirt, while adding the note.
      { startFrame: 52, endFrame: 84, from: v(0.28, 0.55), to: v(0.62, 0.55), shirt: 'white' },
      // Dark shirt for the rewrite phase.
      { startFrame: 84, endFrame: this.frameCount, from: v(0.62, 0.55), to: v(0.35, 0.55), shirt: 'dark' },
    ];

    return {
      fps: this.fps,
      frameCount: this.frameCount,
      width: this.width,
      height: this.height,
      boardQuad: this.boardPx(),
      strokes,
      teacherPhases,
      eraseBoundaryFrame: 66,
      expectedPageCount: 2,
      colorRegions: [
        { color: 'black', cx: 0.34, cy: 0.22 },
        { color: 'red', cx: 0.34, cy: 0.28 },
        { color: 'blue', cx: 0.32, cy: 0.47 },
      ],
    };
  }

  private lerpPos(phase: TeacherPhase, frame: number): Vec2 {
    const t = Math.min(1, Math.max(0, (frame - phase.startFrame) / (phase.endFrame - phase.startFrame)));
    return v(
      phase.from.x + (phase.to.x - phase.from.x) * t,
      phase.from.y + (phase.to.y - phase.from.y) * t,
    );
  }

  private drawTeacher(pos: Vec2, shirt: 'white' | 'dark') {
    const ctx = this.ctx;
    const cx = pos.x * this.width;
    const cy = pos.y * this.height;
    const scale = this.height / 720;
    // Head (skin tone).
    ctx.fillStyle = '#e8b98f';
    ctx.beginPath();
    ctx.arc(cx, cy - 95 * scale, 26 * scale, 0, Math.PI * 2);
    ctx.fill();
    // Torso: deliberately near-board white shirt when requested.
    ctx.fillStyle = shirt === 'white' ? '#f4f4f2' : '#3a4a63';
    ctx.beginPath();
    ctx.moveTo(cx - 42 * scale, cy - 60 * scale);
    ctx.lineTo(cx + 42 * scale, cy - 60 * scale);
    ctx.lineTo(cx + 50 * scale, cy + 70 * scale);
    ctx.lineTo(cx - 50 * scale, cy + 70 * scale);
    ctx.closePath();
    ctx.fill();
    // Arms.
    ctx.strokeStyle = shirt === 'white' ? '#eeeeea' : '#3a4a63';
    ctx.lineWidth = 16 * scale;
    ctx.beginPath();
    ctx.moveTo(cx - 38 * scale, cy - 45 * scale);
    ctx.lineTo(cx - 60 * scale, cy + 30 * scale);
    ctx.moveTo(cx + 38 * scale, cy - 45 * scale);
    ctx.lineTo(cx + 60 * scale, cy + 30 * scale);
    ctx.stroke();
  }

  private strokeProgress(stroke: ScriptedStroke, frame: number): number {
    if (frame < stroke.startFrame) return 0;
    if (frame >= stroke.endFrame) return 1;
    return (frame - stroke.startFrame) / (stroke.endFrame - stroke.startFrame);
  }

  private isErased(stroke: ScriptedStroke, frame: number): boolean {
    if (stroke.eraseStart === undefined || stroke.eraseEnd === undefined) return false;
    if (frame < stroke.eraseStart) return false;
    if (frame >= stroke.eraseEnd) return true;
    // Progressive erase handled by shortening the visible prefix.
    return false;
  }

  private drawBoardContent(frame: number) {
    const ctx = this.ctx;
    const bx = this.width * BOARD_FRAC.x0;
    const by = this.height * BOARD_FRAC.y0;
    const bw = this.width * (BOARD_FRAC.x1 - BOARD_FRAC.x0);
    const bh = this.height * (BOARD_FRAC.y1 - BOARD_FRAC.y0);

    for (const stroke of this.groundTruth.strokes) {
      if (this.isErased(stroke, frame)) continue;
      const p = this.strokeProgress(stroke, frame);
      if (p <= 0) continue;

      // Erase animation: shrink from the end during the erase window.
      let visible = p;
      if (
        stroke.eraseStart !== undefined &&
        stroke.eraseEnd !== undefined &&
        frame >= stroke.eraseStart &&
        frame < stroke.eraseEnd
      ) {
        const ep = (frame - stroke.eraseStart) / (stroke.eraseEnd - stroke.eraseStart);
        visible = Math.max(0, 1 - ep);
      }
      if (visible <= 0) continue;

      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const total = stroke.points.length - 1;
      const drawSegments = total * visible;
      for (let i = 0; i < total; i++) {
        if (i > drawSegments) break;
        const a = stroke.points[i];
        const b = stroke.points[i + 1];
        const ax = bx + a.x * bw;
        const ay = by + a.y * bh;
        if (i === 0) ctx.moveTo(ax, ay);
        const t = Math.min(1, drawSegments - i);
        ctx.lineTo(ax + (bx + b.x * bw - ax) * t, ay + (by + b.y * bh - ay) * t);
      }
      ctx.stroke();
    }
  }

  private renderFrame(frame: number): HTMLCanvasElement {
    const ctx = this.ctx;
    // Classroom background (warm gray wall).
    ctx.fillStyle = '#8a8178';
    ctx.fillRect(0, 0, this.width, this.height);

    const bx = this.width * BOARD_FRAC.x0;
    const by = this.height * BOARD_FRAC.y0;
    const bw = this.width * (BOARD_FRAC.x1 - BOARD_FRAC.x0);
    const bh = this.height * (BOARD_FRAC.y1 - BOARD_FRAC.y0);

    // Whiteboard + dark aluminum frame.
    ctx.fillStyle = '#3d4248';
    ctx.fillRect(bx - 10, by - 10, bw + 20, bh + 20);
    ctx.fillStyle = '#f7f7f5';
    ctx.fillRect(bx, by, bw, bh);

    this.drawBoardContent(frame);

    // Teacher on top, potentially covering the left border (x near bx).
    const phase = this.groundTruth.teacherPhases.find(
      (p) => frame >= p.startFrame && frame < p.endFrame,
    );
    if (phase) {
      const pos = this.lerpPos(phase, frame);
      if (pos.x > 0) this.drawTeacher(pos, phase.shirt);
    }

    return this.canvas;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<VideoFrameData> {
    for (let i = 0; i < this.frameCount; i++) {
      const image = this.renderFrame(i);
      yield {
        image,
        timestampSec: i / this.fps,
        width: this.width,
        height: this.height,
      };
    }
  }

  /** Render a specific frame on demand (used by tests). */
  renderAt(frame: number): HTMLCanvasElement {
    return this.renderFrame(frame);
  }
}
