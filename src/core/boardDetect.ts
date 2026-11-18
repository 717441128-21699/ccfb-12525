/**
 * Whiteboard four-edge / four-corner detection on a low-resolution RGBA
 * frame. Two complementary strategies are combined:
 *
 *  1. Bright-region convex hull -> quad simplification. Robust when a teacher
 *     occludes part of the border: remaining border pixels still span the
 *     convex hull edges.
 *  2. Compact Hough line voting over Sobel edges -> dominant horizontal /
 *     vertical lines -> corner intersections. Fallback / cross-check.
 *
 * The detector never assumes the board is fully visible. A hint quad from a
 * previous frame keeps output stable when evidence temporarily collapses.
 */
import type { Quad, Vec2 } from '../types.js';
import { dist, normalizeQuad, quadArea, quadCentroid } from './geometry.js';
import { labelComponents } from './components.js';

export interface DetectionResult {
  quad: Quad | null;
  score: number;
  method: 'hull' | 'hough' | 'hint' | 'none';
}

export function toGray(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Float32Array {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    gray[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }
  return gray;
}

/** Brightness threshold from the histogram (board is among the brightest stuff). */
export function brightThreshold(gray: Float32Array): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[Math.min(255, gray[i] | 0)]++;
  let total = 0;
  for (const c of hist) total += c;
  // Pixels brighter than the 70th percentile are candidate board pixels.
  const target = total * 0.7;
  let acc = 0;
  let cut = 200;
  for (let b = 0; b < 256; b++) {
    acc += hist[b];
    if (acc >= target) {
      cut = b;
      break;
    }
  }
  return Math.max(150, cut);
}

export function brightMask(gray: Float32Array, threshold: number): Uint8Array {
  const m = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) m[i] = gray[i] >= threshold ? 1 : 0;
  return m;
}

/** Andrew monotone-chain convex hull. */
export function convexHull(points: Vec2[]): Vec2[] {
  if (points.length <= 2) return points.slice();
  const pts = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Collapse a convex polygon to a 4-gon by repeatedly removing the vertex whose
 * removal costs the least area, until exactly 4 vertices remain.
 */
export function hullToQuad(hull: Vec2[]): Quad | null {
  if (hull.length < 4) return null;
  const poly = hull.slice();
  const triArea = (a: Vec2, b: Vec2, c: Vec2) =>
    Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  while (poly.length > 4) {
    let best = -1;
    let bestCost = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const prev = poly[(i - 1 + poly.length) % poly.length];
      const next = poly[(i + 1) % poly.length];
      const cost = triArea(prev, poly[i], next);
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    poly.splice(best, 1);
  }
  return normalizeQuad(poly as Quad);
}

interface HoughLine {
  rho: number;
  theta: number;
  votes: number;
}

/** Compact Hough transform over edge pixels, returning the top lines. */
export function houghLines(
  gray: Float32Array,
  w: number,
  h: number,
  opts: { edgeThreshold?: number; maxLines?: number; minVotes?: number } = {},
): HoughLine[] {
  const edgeThreshold = opts.edgeThreshold ?? 60;
  const maxLines = opts.maxLines ?? 8;
  const minVotes = opts.minVotes ?? Math.max(12, Math.round(Math.min(w, h) * 0.08));
  const thetaSteps = 64; // quantized orientations 0..pi
  const diag = Math.hypot(w, h);
  const rhoSteps = Math.ceil(diag * 2);
  const acc = new Uint16Array(thetaSteps * rhoSteps);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1]
        + gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
      const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1]
        + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      const mag = Math.hypot(gx, gy);
      if (mag < edgeThreshold) continue;
      const baseTheta = Math.atan2(gy, gx);
      for (let t = 0; t < thetaSteps; t++) {
        const theta = (t / thetaSteps) * Math.PI;
        // Only vote when the edge normal roughly matches the gradient dir.
        let d = Math.abs(theta - baseTheta);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (d > 0.35) continue;
        const rho = x * Math.cos(theta) + y * Math.sin(theta) + diag;
        const r = Math.min(rhoSteps - 1, Math.max(0, Math.round(rho)));
        acc[t * rhoSteps + r]++;
      }
    }
  }

  const peaks: HoughLine[] = [];
  for (let t = 0; t < thetaSteps; t++) {
    for (let r = 1; r < rhoSteps - 1; r++) {
      const v = acc[t * rhoSteps + r];
      if (v < minVotes) continue;
      if (v >= acc[t * rhoSteps + r - 1] && v >= acc[t * rhoSteps + r + 1]) {
        peaks.push({ rho: r - diag, theta: (t / thetaSteps) * Math.PI, votes: v });
      }
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);

  // Non-maximum suppression in parameter space.
  const kept: HoughLine[] = [];
  for (const p of peaks) {
    if (kept.every((k) => {
      let dt = Math.abs(k.theta - p.theta);
      if (dt > Math.PI / 2) dt = Math.PI - dt;
      return dt > 0.12 || Math.abs(k.rho - p.rho) > diag * 0.06;
    })) {
      kept.push(p);
      if (kept.length >= maxLines) break;
    }
  }
  return kept;
}

function lineIntersection(a: HoughLine, b: HoughLine): Vec2 | null {
  const ct1 = Math.cos(a.theta);
  const st1 = Math.sin(a.theta);
  const den = ct1 * Math.sin(b.theta) - st1 * Math.cos(b.theta);
  if (Math.abs(den) < 1e-4) return null;
  const x = (a.rho * Math.sin(b.theta) - b.rho * st1) / den;
  const y = (b.rho * ct1 - a.rho * Math.cos(b.theta)) / den;
  return { x, y };
}

/** Pick two near-horizontal and two near-vertical lines and intersect them. */
export function houghQuad(lines: HoughLine[], w: number, h: number): Quad | null {
  const horiz: HoughLine[] = [];
  const vert: HoughLine[] = [];
  for (const ln of lines) {
    const t = ln.theta % Math.PI;
    if (t < Math.PI / 4 || t > (3 * Math.PI) / 4) vert.push(ln);
    else horiz.push(ln);
  }
  if (horiz.length < 2 || vert.length < 2) return null;
  // For horizontal-ish lines theta ~ pi/2, rho tracks y; split by rho.
  horiz.sort((a, b) => a.rho - b.rho);
  vert.sort((a, b) => a.rho - b.rho);
  const hTop = horiz[0];
  const hBot = horiz[horiz.length - 1];
  const vLeft = vert[0];
  const vRight = vert[vert.length - 1];
  const pts = [
    lineIntersection(hTop, vLeft),
    lineIntersection(hTop, vRight),
    lineIntersection(hBot, vRight),
    lineIntersection(hBot, vLeft),
  ];
  if (pts.some((p) => !p)) return null;
  const q = normalizeQuad(pts as Vec2[] as Quad);
  const c = quadCentroid(q);
  if (c.x < 0 || c.y < 0 || c.x > w || c.y > h) return null;
  return q;
}

/**
 * Quality score in [0,1]: area coverage + how bright the interior is +
 * convexity sanity.
 */
export function quadScore(quad: Quad, gray: Float32Array, w: number, h: number): number {
  const area = quadArea(quad);
  const frameArea = w * h;
  if (area < frameArea * 0.05 || area > frameArea * 0.98) return 0;
  const areaTerm = Math.min(1, area / (frameArea * 0.5));

  // Sample interior points; require high mean brightness.
  const [tl, tr, br, bl] = quad;
  let sum = 0;
  let n = 0;
  for (let sy = 1; sy < 8; sy++) {
    for (let sx = 1; sx < 8; sx++) {
      const u = sx / 8;
      const t = sy / 8;
      const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
      const bot = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
      const px = top.x + (bot.x - top.x) * t;
      const py = top.y + (bot.y - top.y) * t;
      const ix = px | 0;
      const iy = py | 0;
      if (ix >= 0 && iy >= 0 && ix < w && iy < h) {
        sum += gray[iy * w + ix];
        n++;
      }
    }
  }
  if (!n) return 0;
  const brightnessTerm = Math.min(1, sum / n / 225);
  // Edge sanity: no zero-length edges.
  let minEdge = Infinity;
  for (let i = 0; i < 4; i++) minEdge = Math.min(minEdge, dist(quad[i], quad[(i + 1) % 4]));
  if (minEdge < Math.min(w, h) * 0.08) return 0;
  return areaTerm * 0.35 + brightnessTerm * 0.65;
}

/**
 * Main detector entry.
 * @param hint quad accepted on a previous frame; used when fresh evidence is weak.
 */
export function detectBoardQuad(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  hint: Quad | null = null,
): DetectionResult {
  const gray = toGray(rgba, w, h);

  // Strategy 1: largest bright blob -> convex hull -> quad.
  let hullQuad: Quad | null = null;
  const mask = brightMask(gray, brightThreshold(gray));
  const { blobs, labels } = labelComponents(mask, w, h);
  if (blobs.length) {
    const biggest = blobs[0];
    const pts: Vec2[] = [];
    // Subsample blob pixels to keep hull work bounded.
    const step = Math.max(1, Math.floor(Math.sqrt(biggest.pixels) / 400));
    let k = 0;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== biggest.id) continue;
      if ((k++ % step) !== 0) continue;
      pts.push({ x: i % w, y: (i / w) | 0 });
    }
    const hull = convexHull(pts);
    hullQuad = hullToQuad(hull);
  }
  const hullScore = hullQuad ? quadScore(hullQuad, gray, w, h) : 0;

  // Strategy 2: Hough lines.
  let hQuad: Quad | null = null;
  const lines = houghLines(gray, w, h);
  hQuad = houghQuad(lines, w, h);
  const hScore = hQuad ? quadScore(hQuad, gray, w, h) : 0;

  if (hullQuad && hullScore >= hScore && hullScore > 0.25) {
    return { quad: hullQuad, score: hullScore, method: 'hull' };
  }
  if (hQuad && hScore > 0.25) {
    return { quad: hQuad, score: hScore, method: 'hough' };
  }
  if (hint) {
    return { quad: hint, score: quadScore(hint, gray, w, h), method: 'hint' };
  }
  if (hullQuad) return { quad: hullQuad, score: hullScore, method: 'hull' };
  if (hQuad) return { quad: hQuad, score: hScore, method: 'hough' };
  return { quad: null, score: 0, method: 'none' };
}
