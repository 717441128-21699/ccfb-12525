import { describe, expect, it } from 'vitest';
import {
  add,
  dist,
  emaQuad,
  homographyFromQuad,
  homographyToRect,
  invertMat3,
  mat3Mul,
  normalizeQuad,
  project,
  quadArea,
  quadCentroid,
  quadSimilarity,
  v,
} from '../../src/core/geometry.js';
import type { Quad } from '../../src/types.js';

describe('basic vector math', () => {
  it('computes distance and addition', () => {
    expect(dist(v(0, 0), v(3, 4))).toBeCloseTo(5);
    expect(add(v(1, 2), v(3, 4))).toEqual({ x: 4, y: 6 });
  });
});

describe('homography', () => {
  it('maps a rectangle quad onto a target rectangle exactly', () => {
    const src: Quad = [v(10, 20), v(110, 20), v(110, 70), v(10, 70)];
    const H = homographyToRect(src, 200, 100);
    const p0 = project(H, src[0]);
    expect(p0.x).toBeCloseTo(0, 4);
    expect(p0.y).toBeCloseTo(0, 4);
    const p1 = project(H, src[1]);
    expect(p1.x).toBeCloseTo(200, 4);
    expect(p1.y).toBeCloseTo(0, 4);
    const p2 = project(H, src[2]);
    expect(p2.x).toBeCloseTo(200, 4);
    expect(p2.y).toBeCloseTo(100, 4);
    const p3 = project(H, src[3]);
    expect(p3.x).toBeCloseTo(0, 4);
    expect(p3.y).toBeCloseTo(100, 4);
  });

  it('round-trips through inversion on a perspective quad', () => {
    const src: Quad = [v(12, 8), v(140, 25), v(130, 95), v(5, 80)];
    const dst: Quad = [v(0, 0), v(320, 0), v(320, 180), v(0, 180)];
    const H = homographyFromQuad(src, dst);
    const Hinv = invertMat3(H);
    for (let i = 0; i < 4; i++) {
      const back = project(Hinv, project(H, src[i]));
      expect(back.x).toBeCloseTo(src[i].x, 4);
      expect(back.y).toBeCloseTo(src[i].y, 4);
    }
    // Matrix * inverse ~ identity.
    const prod = mat3Mul(H, Hinv);
    expect(prod[0]).toBeCloseTo(1, 5);
    expect(prod[4]).toBeCloseTo(1, 5);
    expect(prod[8]).toBeCloseTo(1, 5);
    expect(prod[1]).toBeCloseTo(0, 5);
  });

  it('maps interior points inside the target rectangle', () => {
    const src: Quad = [v(0, 0), v(100, 0), v(100, 100), v(0, 100)];
    const H = homographyToRect(src, 100, 100);
    const p = project(H, v(50, 50));
    expect(p.x).toBeCloseTo(50, 4);
    expect(p.y).toBeCloseTo(50, 4);
  });
});

describe('quad utilities', () => {
  it('normalizes rotated quads to TL-TR-BR-BL order', () => {
    const q: Quad = [v(100, 100), v(0, 100), v(0, 0), v(100, 0)];
    const n = normalizeQuad(q);
    expect(n[0]).toMatchObject({ x: 0, y: 0 });
    expect(n[1]).toMatchObject({ x: 100, y: 0 });
    expect(n[2]).toMatchObject({ x: 100, y: 100 });
    expect(n[3]).toMatchObject({ x: 0, y: 100 });
  });

  it('computes area and centroid', () => {
    const q: Quad = [v(0, 0), v(10, 0), v(10, 8), v(0, 8)];
    expect(quadArea(q)).toBeCloseTo(80);
    expect(quadCentroid(q)).toMatchObject({ x: 5, y: 4 });
  });

  it('EMA smoothing moves toward the new quad', () => {
    const a: Quad = [v(0, 0), v(10, 0), v(10, 10), v(0, 10)];
    const b: Quad = [v(10, 10), v(20, 10), v(20, 20), v(10, 20)];
    const s = emaQuad(a, b, 0.5);
    expect(s[0]).toMatchObject({ x: 5, y: 5 });
    expect(quadSimilarity(a, a)).toBeCloseTo(0);
    expect(quadSimilarity(a, b)).toBeGreaterThan(0.5);
  });
});
