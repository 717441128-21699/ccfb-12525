/**
 * CPU-side ink layer rendering from a page snapshot. Mirrors the WebGL2
 * classification shader (same thresholds in core/color.ts), used by exporters
 * so each finalized page gets its own red/blue/black layer even though the
 * live GL texture only holds the latest board state.
 */
import type { InkLayerName } from '../types.js';
import { classifyRGB, INK_LAYERS } from '../core/color.js';

export function renderLayer(
  source: CanvasImageSource,
  width: number,
  height: number,
  layer: InkLayerName,
): HTMLCanvasElement {
  const work = document.createElement('canvas');
  work.width = width;
  work.height = height;
  const wctx = work.getContext('2d', { willReadFrequently: true })!;
  wctx.drawImage(source, 0, 0, width, height);
  const img = wctx.getImageData(0, 0, width, height);

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const octx = out.getContext('2d')!;
  const outImg = octx.createImageData(width, height);
  outImg.data.fill(255);

  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const cls = classifyRGB(img.data[o], img.data[o + 1], img.data[o + 2]);
    if (cls === layer) {
      outImg.data[o] = img.data[o];
      outImg.data[o + 1] = img.data[o + 1];
      outImg.data[o + 2] = img.data[o + 2];
      outImg.data[o + 3] = 255;
    }
  }
  octx.putImageData(outImg, 0, 0);
  return out;
}

export function renderAllLayers(
  source: CanvasImageSource,
  width: number,
  height: number,
): Record<InkLayerName, HTMLCanvasElement> {
  const result = {} as Record<InkLayerName, HTMLCanvasElement>;
  for (const name of INK_LAYERS) result[name] = renderLayer(source, width, height, name);
  return result;
}

/** Count ink pixels per layer (test/assertion helper). */
export function countInkPixels(
  source: CanvasImageSource,
  width: number,
  height: number,
): Record<InkLayerName, number> {
  const work = document.createElement('canvas');
  work.width = width;
  work.height = height;
  const wctx = work.getContext('2d', { willReadFrequently: true })!;
  wctx.drawImage(source, 0, 0, width, height);
  const img = wctx.getImageData(0, 0, width, height);
  const counts: Record<InkLayerName, number> = { red: 0, blue: 0, black: 0 };
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const cls = classifyRGB(img.data[o], img.data[o + 1], img.data[o + 2]);
    if (cls === 'red' || cls === 'blue' || cls === 'black') counts[cls]++;
  }
  return counts;
}
