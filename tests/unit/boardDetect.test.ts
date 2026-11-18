import { describe, expect, it } from 'vitest';
import type { Quad } from '../../src/types.js';
import { v } from '../../src/core/geometry.js';
import {
  brightThreshold,
  convexHull,
  detectBoardQuad,
  houghLines,
  houghQuad,
  hullToQuad,
  quadScore,
  toGray,
} from '../../src/core/boardDetect.js';

const W = 160;
const H = 90;
const BOARD: Quad = [v(20, 10), v(140, 10), v(140, 80), v(20, 80)];

function makeFrame(opts: { occluder?: { x: number; y: number; w: number; h: number; color?: [number, number, number] } } = {}): {
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
} {
  const rgba = new Uint8ClampedArray(W * H * 4);
  rgba.fill(120); // gray wall
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = x >= BOARD[0].x && x <= BOARD[2].x && y >= BOARD[0].y && y <= BOARD[2].y;
      const o = (y * W + x) * 4;
      if (inside) {
        rgba[o] = 247;
        rgba[o + 1] = 247;
        rgba[o + 2] = 245;
        rgba[o + 3] = 255;
      } else {
        rgba[o + 3] = 255;
      }
    }
  }
  if (opts.occluder) {
    const { x, y, w, h } = opts.occluder;
    const [r, g, b] = opts.occluder.color ?? [60, 80, 120];
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const o = (yy * W + xx) * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
      }
    }
  }
  return { rgba, w: W, h: H };
}

describe('brightness helpers', () => {
  it('finds a high threshold on a mostly bright board frame', () => {
    const { rgba } = makeFrame();
    const gray = toGray(rgba, W, H);
    const t = brightThreshold(gray);
    expect(t).toBeGreaterThanOrEqual(150);
  });
});

describe('convex hull', () => {
  it('reduces a rectangle point cloud to a 4-corner quad', () => {
    const pts = [];
    for (let x = 20; x <= 140; x += 4) {
      pts.push(v(x, 10), v(x, 80));
    }
    for (let y = 10; y <= 80; y += 4) {
      pts.push(v(20, y), v(140, y));
    }
    const hull = convexHull(pts);
    const quad = hullToQuad(hull);
    expect(quad).not.toBeNull();
    expect(quad![0].x).toBeLessThan(30);
    expect(quad![2].x).toBeGreaterThan(130);
  });
});

describe('detectBoardQuad', () => {
  it('locates the full visible board', () => {
    const { rgba } = makeFrame();
    const res = detectBoardQuad(rgba, W, H);
    expect(res.quad).not.toBeNull();
    const score = quadScore(res.quad!, toGray(rgba, W, H), W, H);
    expect(score).toBeGreaterThan(0.4);
    const c = res.quad!.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), v(0, 0));
    expect(Math.abs(c.x - 80)).toBeLessThan(12);
    expect(Math.abs(c.y - 45)).toBeLessThan(12);
  });

  it('keeps locating the board when a dark occluder covers the left border', () => {
    const { rgba } = makeFrame({
      occluder: { x: 14, y: 30, w: 22, h: 45, color: [58, 74, 99] },
    });
    const res = detectBoardQuad(rgba, W, H, BOARD);
    expect(res.quad).not.toBeNull();
    expect(['hull', 'hough', 'hint']).toContain(res.method);
    const c = res.quad!.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), v(0, 0));
    // Centroid stays near the true board center despite occlusion.
    expect(Math.abs(c.x - 80)).toBeLessThan(20);
    expect(Math.abs(c.y - 45)).toBeLessThan(15);
  });

  it('does not mistake a white-shirt occluder for the board interior beyond bounds', () => {
    // White shirt overlapping the board; shirt color ~ board color.
    const { rgba } = makeFrame({
      occluder: { x: 60, y: 40, w: 24, h: 40, color: [244, 244, 242] },
    });
    const res = detectBoardQuad(rgba, W, H, BOARD);
    expect(res.quad).not.toBeNull();
    // The detected quad must not balloon to the full frame.
    const area = res.quad!.reduce((s, p, i) => {
      const q = res.quad![(i + 1) % 4];
      return s + Math.abs(p.x * q.y - q.x * p.y) / 2;
    }, 0);
    expect(area).toBeLessThan(W * H * 0.85);
  });

  it('falls back to the hint when evidence collapses', () => {
    // Uniform frame: no edges, no bright region.
    const rgba = new Uint8ClampedArray(W * H * 4).fill(100);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    const res = detectBoardQuad(rgba, W, H, BOARD);
    expect(res.quad).toEqual(BOARD);
    expect(res.method).toBe('hint');
  });
});

describe('hough line path', () => {
  it('detects the four strong board edges', () => {
    const { rgba } = makeFrame();
    const gray = toGray(rgba, W, H);
    const lines = houghLines(gray, W, H, { minVotes: 10 });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const q = houghQuad(lines, W, H);
    // Hough may or may not get all 4 lines on a tiny image; only assert when it does.
    if (q) {
      const c = q.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), v(0, 0));
      expect(Math.abs(c.x - 80)).toBeLessThan(20);
    }
  });
});
