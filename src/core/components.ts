/**
 * Connected-component labeling (4-connectivity, two-pass union-find) and
 * blob filtering on a binary mask. Pure TS, operates on flat Uint8Arrays.
 */

export interface Blob {
  id: number;
  pixels: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
}

class UnionFind {
  parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== x) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/**
 * Label foreground pixels (value != 0). 4-connectivity via a two-pass
 * union-find: each pixel unions with its up and left neighbors (diagonal
 * neighbors are deliberately NOT unioned, so diagonally touching pixels
 * stay separate).
 */
export function labelComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; blobs: Blob[] } {
  const labels = new Int32Array(width * height);
  const uf = new UnionFind(width * height + 1);
  let nextLabel = 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const up = y > 0 ? labels[i - width] : 0;
      const left = x > 0 ? labels[i - 1] : 0;
      if (up && left) {
        // Both neighbors labeled: take one label and merge the two sets.
        labels[i] = up;
        uf.union(up, left);
      } else if (up) {
        labels[i] = up;
      } else if (left) {
        labels[i] = left;
      } else {
        labels[i] = nextLabel++;
      }
    }
  }

  // Flatten roots.
  const rootToBlob = new Map<number, number>();
  const blobs: Blob[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (!labels[i]) continue;
    const root = uf.find(labels[i]);
    labels[i] = root;
    let idx = rootToBlob.get(root);
    if (idx === undefined) {
      idx = blobs.length;
      rootToBlob.set(root, idx);
      blobs.push({
        id: root,
        pixels: 0,
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        cx: 0,
        cy: 0,
      });
    }
    const b = blobs[idx];
    const x = i % width;
    const y = (i / width) | 0;
    b.pixels++;
    b.cx += x;
    b.cy += y;
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
  }
  for (const b of blobs) {
    b.cx /= b.pixels;
    b.cy /= b.pixels;
  }
  blobs.sort((a, b) => b.pixels - a.pixels);
  return { labels, blobs };
}

/**
 * Build a mask that keeps only blobs passing a minimum-area test.
 * Optionally fills the bounding boxes / convex hull of kept blobs so that
 * interior holes (white shirt against white board) stay masked.
 */
export function filterAndFillBlobs(
  mask: Uint8Array,
  width: number,
  height: number,
  minPixels: number,
  opts: { fillBoundingBox?: boolean; dilateRadius?: number } = {},
): Uint8Array {
  const { labels, blobs } = labelComponents(mask, width, height);
  const out = new Uint8Array(width * height);
  const keep = new Set<number>();
  for (const b of blobs) {
    if (b.pixels >= minPixels) keep.add(b.id);
  }
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] && keep.has(labels[i])) out[i] = 1;
  }
  if (opts.fillBoundingBox) {
    for (const b of blobs) {
      if (!keep.has(b.id)) continue;
      for (let y = b.minY; y <= b.maxY; y++) {
        const row = y * width;
        for (let x = b.minX; x <= b.maxX; x++) out[row + x] = 1;
      }
    }
  }
  const r = opts.dilateRadius ?? 0;
  if (r > 0) return dilate(out, width, height, r);
  return out;
}

/** Square-kernel dilation; radius 1 means a 3x3 kernel. */
export function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      for (let yy = y0; yy <= y1 && !v; yy++) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx++) {
          if (mask[row + xx]) {
            v = 1;
            break;
          }
        }
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

/** Temporal hold: OR the previous mask in, then decay after `holdFrames`. */
export function temporalHold(
  prev: Uint8Array,
  curr: Uint8Array,
  age: Uint8Array,
  holdFrames: number,
): { mask: Uint8Array; age: Uint8Array } {
  const n = curr.length;
  const out = new Uint8Array(n);
  const nextAge = new Uint8Array(age);
  for (let i = 0; i < n; i++) {
    if (curr[i]) {
      out[i] = 1;
      nextAge[i] = holdFrames;
    } else if (prev[i] && age[i] > 0) {
      out[i] = 1;
      nextAge[i] = age[i] - 1;
    } else {
      nextAge[i] = 0;
    }
  }
  return { mask: out, age: nextAge };
}
