/**
 * Ink color classification: red / blue / black / white / other.
 * Thresholds are exported so the WebGL2 classification shader can use the
 * exact same numbers as the CPU reference implementation.
 */
import type { InkClass, InkLayerName } from '../types.js';

export const INK_LAYERS: InkLayerName[] = ['red', 'blue', 'black'];

/** Pixels whose min channel is above this are treated as blank board. */
export const WHITE_MIN_CHANNEL = 178;
/** Pixels whose max-min channel spread is below this are achromatic. */
export const GRAY_SPREAD = 34;
/** Dark achromatic pixels below this mean are black ink. */
export const BLACK_MEAN = 150;
/** Chromatic pixels need this much dominance of the target hue channel. */
export const HUE_DOMINANCE = 30;
/** Chromatic pixels must be darker than this mean to count as ink at all. */
export const COLOR_INK_MEAN_MAX = 215;

export function classifyRGB(r: number, g: number, b: number): InkClass {
  const min = Math.min(r, g, b);
  const max = Math.max(r, g, b);
  const mean = (r + g + b) / 3;

  // Blank/whiteboard: all channels high.
  if (min >= WHITE_MIN_CHANNEL) return 'white';

  const spread = max - min;

  // Achromatic first: dark gray/black ink must never leak into color layers.
  if (spread < GRAY_SPREAD) {
    if (mean < BLACK_MEAN) return 'black';
    return 'other';
  }

  if (mean > COLOR_INK_MEAN_MAX) return 'other';

  // Strongly chromatic pixel: require clear single-channel dominance.
  if (spread >= HUE_DOMINANCE) {
    if (r >= g + HUE_DOMINANCE && r >= b + HUE_DOMINANCE) return 'red';
    if (b >= r + HUE_DOMINANCE && b >= g + HUE_DOMINANCE) return 'blue';
  }

  // Weakly colored dark pixel falls back to black rather than being dropped.
  if (mean < BLACK_MEAN) return 'black';
  return 'other';
}

/**
 * Classify a whole RGBA buffer into per-layer binary masks and a combined
 * colored-ink image (white background). CPU reference used by tests and for
 * verifying the shader implementation.
 */
export function splitInkLayers(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number) {
  const n = width * height;
  const masks: Record<InkLayerName, Uint8Array> = {
    red: new Uint8Array(n),
    blue: new Uint8Array(n),
    black: new Uint8Array(n),
  };
  const combined = new Uint8ClampedArray(n * 4);
  combined.fill(255);
  combined.fill(255, 3);

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const cls = classifyRGB(rgba[o], rgba[o + 1], rgba[o + 2]);
    if (cls === 'red' || cls === 'blue' || cls === 'black') {
      masks[cls][i] = 1;
      combined[o] = rgba[o];
      combined[o + 1] = rgba[o + 1];
      combined[o + 2] = rgba[o + 2];
      combined[o + 3] = 255;
    }
  }
  return { masks, combined };
}

/** GLSL fragment matching classifyRGB; injects the same constants. */
export const INK_CLASSIFY_GLSL = /* glsl */ `
vec4 classifyInk(vec3 rgb) {
  float mn = min(rgb.r, min(rgb.g, rgb.b));
  float mx = max(rgb.r, max(rgb.g, rgb.b));
  float meanV = (rgb.r + rgb.g + rgb.b) / 3.0;
  float spread = mx - mn;
  // returns vec4(redFlag, blueFlag, blackFlag, inkFlag)
  if (mn >= float(${WHITE_MIN_CHANNEL}) / 255.0) return vec4(0.0);
  if (spread < float(${GRAY_SPREAD}) / 255.0) {
    if (meanV < float(${BLACK_MEAN}) / 255.0) return vec4(0.0, 0.0, 1.0, 1.0);
    return vec4(0.0);
  }
  if (meanV > float(${COLOR_INK_MEAN_MAX}) / 255.0) return vec4(0.0);
  if (spread >= float(${HUE_DOMINANCE}) / 255.0) {
    if (rgb.r >= rgb.g + float(${HUE_DOMINANCE}) / 255.0 &&
        rgb.r >= rgb.b + float(${HUE_DOMINANCE}) / 255.0) return vec4(1.0, 0.0, 0.0, 1.0);
    if (rgb.b >= rgb.r + float(${HUE_DOMINANCE}) / 255.0 &&
        rgb.b >= rgb.g + float(${HUE_DOMINANCE}) / 255.0) return vec4(0.0, 1.0, 0.0, 1.0);
  }
  if (meanV < float(${BLACK_MEAN}) / 255.0) return vec4(0.0, 0.0, 1.0, 1.0);
  return vec4(0.0);
}
`;
