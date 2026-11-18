/**
 * 2D geometry: points, quads, perspective homography (projective-basis
 * closed form), matrix inversion and quad utilities. All functions are pure
 * so they can be unit-tested under Node without a DOM.
 */
import type { Mat3, Quad, Vec2 } from '../types.js';

export const v = (x: number, y: number): Vec2 => ({ x, y });

export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export const sub = (a: Vec2, b: Vec2): Vec2 => v(a.x - b.x, a.y - b.y);

export const add = (a: Vec2, b: Vec2): Vec2 => v(a.x + b.x, a.y + b.y);

export const scale = (a: Vec2, s: number): Vec2 => v(a.x * s, a.y * s);

export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 =>
  v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

export const quadArea = (q: Quad): number => {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
};

export const quadCentroid = (q: Quad): Vec2 =>
  v(
    (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
    (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
  );

export const mat3Identity = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] =
        a[r * 3] * b[c] +
        a[r * 3 + 1] * b[3 + c] +
        a[r * 3 + 2] * b[6 + c];
    }
  }
  return o;
}

/**
 * Invert a 3x3 matrix using cofactors + determinant. Throws on singular ones.
 */
export function invertMat3(m: Mat3): Mat3 {
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(det) < 1e-12) throw new Error('Singular matrix cannot be inverted');
  const idet = 1 / det;
  return [
    (m[4] * m[8] - m[5] * m[7]) * idet,
    (m[2] * m[7] - m[1] * m[8]) * idet,
    (m[1] * m[5] - m[2] * m[4]) * idet,
    (m[5] * m[6] - m[3] * m[8]) * idet,
    (m[0] * m[8] - m[2] * m[6]) * idet,
    (m[2] * m[3] - m[0] * m[5]) * idet,
    (m[3] * m[7] - m[4] * m[6]) * idet,
    (m[1] * m[6] - m[0] * m[7]) * idet,
    (m[0] * m[4] - m[1] * m[3]) * idet,
  ];
}

export function project(m: Mat3, p: Vec2): Vec2 {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  return v(
    (m[0] * p.x + m[1] * p.y + m[2]) / w,
    (m[3] * p.x + m[4] * p.y + m[5]) / w,
  );
}

/**
 * Homography mapping source quad -> destination quad.
 *
 * Projective-basis closed form: form the 3x3 matrix whose columns are the
 * first three homogeneous corners, derive the projective scaling from the
 * fourth, then H = B_dst * B_src^-1. Reduces to the exact affine map for
 * axis-aligned rectangle inputs.
 */
export function homographyFromQuad(src: Quad, dst: Quad): Mat3 {
  const basis = (q: Quad): Mat3 => {
    const A: Mat3 = [
      q[0].x, q[1].x, q[2].x,
      q[0].y, q[1].y, q[2].y,
      1, 1, 1,
    ];
    const Ainv = invertMat3(A);
    const p3 = [q[3].x, q[3].y, 1];
    const lambda = [
      Ainv[0] * p3[0] + Ainv[1] * p3[1] + Ainv[2] * p3[2],
      Ainv[3] * p3[0] + Ainv[4] * p3[1] + Ainv[5] * p3[2],
      Ainv[6] * p3[0] + Ainv[7] * p3[1] + Ainv[8] * p3[2],
    ];
    return [
      A[0] * lambda[0], A[1] * lambda[1], A[2] * lambda[2],
      A[3] * lambda[0], A[4] * lambda[1], A[5] * lambda[2],
      A[6] * lambda[0], A[7] * lambda[1], A[8] * lambda[2],
    ];
  };
  const Bsrc = basis(src);
  const Bdst = basis(dst);
  return mat3Mul(Bdst, invertMat3(Bsrc));
}

/** Convenience: map a source quad onto an axis-aligned rectangle. */
export function homographyToRect(src: Quad, w: number, h: number): Mat3 {
  const dst: Quad = [v(0, 0), v(w, 0), v(w, h), v(0, h)];
  return homographyFromQuad(src, dst);
}

/**
 * Normalize a quad so corners run TL -> TR -> BR -> BL regardless of input
 * rotation.
 */
export function normalizeQuad(q: Quad): Quad {
  const c = quadCentroid(q);
  const withAngles = q.map((p) => ({ p, a: Math.atan2(p.y - c.y, p.x - c.x) }));
  withAngles.sort((a, b) => a.a - b.a);
  const pts = withAngles.map((t) => t.p);
  let tlIdx = 0;
  for (let i = 1; i < 4; i++) {
    if (pts[i].x + pts[i].y < pts[tlIdx].x + pts[tlIdx].y) tlIdx = i;
  }
  return [
    pts[tlIdx],
    pts[(tlIdx + 1) % 4],
    pts[(tlIdx + 2) % 4],
    pts[(tlIdx + 3) % 4],
  ];
}

export function emaQuad(prev: Quad | null, next: Quad, alpha: number): Quad {
  if (!prev) return next;
  return next.map((p, i) => lerp(prev[i], p, alpha)) as Quad;
}

export function quadSimilarity(a: Quad, b: Quad): number {
  // Mean corner distance normalized by mean edge length of a.
  let edgeSum = 0;
  for (let i = 0; i < 4; i++) edgeSum += dist(a[i], a[(i + 1) % 4]);
  const meanEdge = edgeSum / 4;
  let d = 0;
  for (let i = 0; i < 4; i++) d += dist(a[i], b[i]);
  return d / 4 / Math.max(meanEdge, 1e-6);
}

export function quadPerimeter(q: Quad): number {
  let s = 0;
  for (let i = 0; i < 4; i++) s += dist(q[i], q[(i + 1) % 4]);
  return s;
}
