import { describe, expect, it } from 'vitest';
import {
  BLACK_MEAN,
  classifyRGB,
  GRAY_SPREAD,
  splitInkLayers,
  WHITE_MIN_CHANNEL,
} from '../../src/core/color.js';

describe('classifyRGB', () => {
  it('treats near-white as white', () => {
    expect(classifyRGB(240, 240, 240)).toBe('white');
    expect(classifyRGB(WHITE_MIN_CHANNEL, 250, 250)).toBe('white');
  });

  it('classifies red, blue and black ink', () => {
    expect(classifyRGB(210, 31, 31)).toBe('red');
    expect(classifyRGB(31, 63, 191)).toBe('blue');
    expect(classifyRGB(26, 26, 26)).toBe('black');
  });

  it('keeps a white shirt pixel distinct from red/blue ink', () => {
    // #f4f4f2 white shirt: high min channel => white, never an ink class.
    expect(classifyRGB(244, 244, 242)).toBe('white');
    // Slightly shaded shirt fold: still achromatic and too bright for black.
    const cls = classifyRGB(205, 205, 202);
    expect(cls === 'white' || cls === 'other').toBe(true);
    expect(cls).not.toBe('red');
    expect(cls).not.toBe('blue');
    expect(cls).not.toBe('black');
  });

  it('rejects weakly colored noise below dominance threshold', () => {
    const cls = classifyRGB(BLACK_MEAN + 30, BLACK_MEAN + 20, BLACK_MEAN + 25);
    // Achromatic-ish: must not become a color layer.
    expect(cls === 'other' || cls === 'black').toBe(true);
  });

  it('black requires both darkness and low chroma spread', () => {
    expect(classifyRGB(40, 40, 40 + GRAY_SPREAD - 4)).toBe('black');
    expect(classifyRGB(40, 40, 120)).not.toBe('black');
  });

  it('splitInkLayers produces three binary masks on white background', () => {
    const w = 3;
    const h = 1;
    const rgba = new Uint8ClampedArray([
      210, 31, 31, 255,   // red
      31, 63, 191, 255,   // blue
      20, 20, 20, 255,    // black
    ]);
    const { masks, combined } = splitInkLayers(rgba, w, h);
    expect(masks.red[0]).toBe(1);
    expect(masks.blue[1]).toBe(1);
    expect(masks.black[2]).toBe(1);
    expect(combined[3]).toBe(255);
    // Background of the combined image is white.
    const blank = splitInkLayers(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1);
    expect(blank.combined[0]).toBe(255);
    expect(blank.masks.red[0]).toBe(0);
  });
});
