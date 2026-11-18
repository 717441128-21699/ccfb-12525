import { describe, expect, it } from 'vitest';
import {
  dilate,
  filterAndFillBlobs,
  labelComponents,
  temporalHold,
} from '../../src/core/components.js';

describe('connected components', () => {
  it('labels separate blobs and reports stats', () => {
    const w = 5;
    const h = 3;
    // Row 0: two isolated pixels; row 2: a 3-pixel run.
    const mask = new Uint8Array(w * h);
    mask[0] = 1;
    mask[4] = 1;
    mask[10] = mask[11] = mask[12] = 1;
    const { labels, blobs } = labelComponents(mask, w, h);
    expect(new Set(labels.filter((x) => x > 0)).size).toBe(3);
    expect(blobs[0].pixels).toBe(3);
    expect(blobs[0].minX).toBe(0);
    expect(blobs[0].maxX).toBe(2);
  });

  it('merges 4-connected neighbors but not diagonals', () => {
    // 3x3 grid: index 0 and 4 touch only diagonally (index 1 is empty),
    // so they must remain two separate components.
    const mask = new Uint8Array(9);
    mask[0] = 1;
    mask[4] = 1;
    const { blobs } = labelComponents(mask, 3, 3);
    expect(blobs).toHaveLength(2);
    expect(blobs.every((b) => b.pixels === 1)).toBe(true);
  });

  it('filters small blobs and fills bounding boxes (shirt holes)', () => {
    const w = 8;
    const h = 8;
    const mask = new Uint8Array(w * h);
    // Ring-shaped blob with an interior hole at (3,3)-(4,4).
    for (let x = 2; x <= 5; x++) {
      mask[2 * w + x] = 1;
      mask[5 * w + x] = 1;
    }
    for (let y = 2; y <= 5; y++) {
      mask[y * w + 2] = 1;
      mask[y * w + 5] = 1;
    }
    const kept = filterAndFillBlobs(mask, w, h, 4, { fillBoundingBox: true });
    // Interior hole must be filled.
    expect(kept[3 * w + 3]).toBe(1);
    expect(kept[4 * w + 4]).toBe(1);
  });

  it('dilation expands the mask by the given radius', () => {
    const mask = new Uint8Array(25);
    mask[12] = 1;
    const out = dilate(mask, 5, 5, 1);
    expect(out[7]).toBe(1);
    expect(out[12]).toBe(1);
    expect(out[17]).toBe(1);
    expect(out[0]).toBe(0);
  });

  it('temporal hold keeps a disappearing person for N frames then releases', () => {
    const prev = new Uint8Array([1, 0]);
    const curr = new Uint8Array([0, 0]);
    const age = new Uint8Array([2, 0]);
    const r1 = temporalHold(prev, curr, age, 2);
    expect(r1.mask[0]).toBe(1);
    expect(r1.age[0]).toBe(1);
    const r2 = temporalHold(r1.mask, curr, r1.age, 2);
    expect(r2.mask[0]).toBe(1);
    expect(r2.age[0]).toBe(0);
    const r3 = temporalHold(r2.mask, curr, r2.age, 2);
    expect(r3.mask[0]).toBe(0);
  });
});
