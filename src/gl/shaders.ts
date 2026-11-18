/**
 * Fragment shader sources for the analysis pipeline. All analysis runs on the
 * rectified board texture, so shaders work in canonical board coordinates.
 */
import { INK_CLASSIFY_GLSL, WHITE_MIN_CHANNEL } from '../core/color.js';

export const WARP_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uFrame;
uniform mat3 uInvH;       // board coords -> video frame coords
uniform vec2 uBoardSize;
uniform vec2 uFrameSize;
void main() {
  vec3 bp = vec3(gl_FragCoord.xy, 1.0);
  vec3 fp = uInvH * bp;
  vec2 fuv = (fp.xy / fp.z) / uFrameSize;
  if (fuv.x < 0.0 || fuv.x > 1.0 || fuv.y < 0.0 || fuv.y > 1.0) {
    outColor = vec4(0.95, 0.95, 0.95, 1.0);
    return;
  }
  // GL origin is bottom-left; frame textures uploaded from canvas are top-left.
  fuv.y = 1.0 - fuv.y;
  outColor = texture(uFrame, fuv);
}`;

/** Motion vs previous frame + color distance vs background model. */
export const SEED_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uCur;
uniform sampler2D uPrev;
uniform sampler2D uBg;
uniform float uMotionTh;
uniform float uBgDiffTh;
void main() {
  vec3 cur = texture(uCur, vUv).rgb;
  vec3 prev = texture(uPrev, vUv).rgb;
  vec3 bg = texture(uBg, vUv).rgb;
  float motion = distance(cur, prev);
  float bgDiff = distance(cur, bg);
  float motionFlag = motion > uMotionTh ? 1.0 : 0.0;
  float bgFlag = bgDiff > uBgDiffTh ? 1.0 : 0.0;
  // Raw foreground seed = motion OR (differs from learned background).
  outColor = vec4(motionFlag, bgFlag, motion, bgDiff);
}`;

/** EMA background adaptation, frozen where the CPU person mask is set. */
export const BG_ADAPT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uBg;
uniform sampler2D uCur;
uniform sampler2D uPerson;   // R channel = person mask
uniform float uRate;
void main() {
  vec3 bg = texture(uBg, vUv).rgb;
  vec3 cur = texture(uCur, vUv).rgb;
  float person = texture(uPerson, vUv).r;
  if (person > 0.5) {
    outColor = vec4(bg, 1.0);
  } else {
    outColor = vec4(mix(bg, cur, uRate), 1.0);
  }
}`;

/** Full-board difference vs committed board -> change flag + ink amount. */
export const CHANGE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uCur;
uniform sampler2D uBoard;
uniform float uChangeTh;
${INK_CLASSIFY_GLSL}
void main() {
  vec3 cur = texture(uCur, vUv).rgb;
  vec3 board = texture(uBoard, vUv).rgb;
  float diff = distance(cur, board);
  float changed = diff > uChangeTh ? 1.0 : 0.0;
  vec4 ink = classifyInk(cur);
  // Ink amount: darkness + chromatic distance from white.
  float inkAmt = ink.a > 0.5 ? 1.0 : clamp(1.0 - (cur.r + cur.g + cur.b) / 3.0, 0.0, 1.0) * 0.25;
  outColor = vec4(changed, inkAmt, diff, 1.0);
}`;

/**
 * Erase detection independent of the person gate but still person-AWARE.
 * A pixel is "erased" when the committed board holds ink there, the current
 * rectified frame is blank whiteboard AND no person covers that pixel. This
 * rejects a teacher walking in front of ink (person flag set) while accepting
 * a real wipe once the area is visible and blank.
 * R = erased flag. G = board-had-ink flag. B = current-is-blank flag.
 */
export const ERASE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uCur;
uniform sampler2D uBoard;
uniform sampler2D uPerson;
${INK_CLASSIFY_GLSL}
void main() {
  vec3 cur = texture(uCur, vUv).rgb;
  vec3 board = texture(uBoard, vUv).rgb;
  float person = texture(uPerson, vUv).r;
  float boardInk = classifyInk(board).a;
  float curBlank = min(cur.r, min(cur.g, cur.b)) > float(${WHITE_MIN_CHANNEL}) / 255.0 ? 1.0 : 0.0;
  float erased = (boardInk > 0.5 && curBlank > 0.5 && person < 0.5) ? 1.0 : 0.0;
  outColor = vec4(erased, boardInk, curBlank, 1.0);
}`;

/**
 * Tile reduction: each output pixel is one tile.
 * R = changed-pixel fraction, G = person-pixel fraction, B = mean ink,
 * A = max diff.
 */
export const TILE_REDUCE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uChange;
uniform sampler2D uPerson;
uniform vec2 uTileCount;
void main() {
  vec2 tile = floor(vUv * uTileCount);
  vec2 uv0 = tile / uTileCount;
  vec2 uv1 = (tile + 1.0) / uTileCount;
  vec2 texel = 1.0 / vec2(textureSize(uChange, 0));
  float changedSum = 0.0;
  float personSum = 0.0;
  float inkSum = 0.0;
  float diffMax = 0.0;
  float n = 0.0;
  vec2 p = uv0;
  for (p.y = uv0.y; p.y < uv1.y; p.y += texel.y) {
    for (p.x = uv0.x; p.x < uv1.x; p.x += texel.x) {
      vec4 ch = texture(uChange, p);
      float person = texture(uPerson, p).r;
      changedSum += ch.r;
      personSum += person > 0.5 ? 1.0 : 0.0;
      inkSum += ch.g;
      diffMax = max(diffMax, ch.b);
      n += 1.0;
    }
  }
  outColor = vec4(changedSum / n, personSum / n, inkSum / n, diffMax);
}`;

/**
 * Build a pixel-level commit mask at analysis resolution.
 * Inputs:
 *   uTileGate = R channel marks tiles the CPU gate accepted this frame.
 *   uChange   = R channel is the denoised change flag.
 *   uPerson   = R channel is the person occlusion mask.
 * Output R=1 where a stable, person-free, changed pixel may be committed.
 */
export const COMMIT_MASK_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTileGate;
uniform sampler2D uChange;
uniform sampler2D uPerson;
uniform vec2 uTileCount;
void main() {
  vec2 tile = floor(vUv * uTileCount);
  vec2 uv0 = tile / uTileCount;
  vec2 uv1 = (tile + 1.0) / uTileCount;
  vec2 center = (uv0 + uv1) * 0.5;
  float gateOn = texture(uTileGate, center).r;
  float changed = texture(uChange, vUv).r;
  float person = texture(uPerson, vUv).r;
  float allow = (gateOn > 0.5 && changed > 0.5 && person < 0.5) ? 1.0 : 0.0;
  outColor = vec4(allow, 0.0, 0.0, 1.0);
}`;

/**
 * Pixel-level board merge. Only pixels flagged in uCommit are replaced with
 * the current rectified frame; everything else keeps the accumulated board.
 * Erase pixels (uCommit G=1) reset to clean whiteboard.
 */
export const BOARD_COMMIT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uBoard;
uniform sampler2D uCur;
uniform sampler2D uCommit;
void main() {
  vec4 c = texture(uCommit, vUv);
  vec4 board = texture(uBoard, vUv);
  if (c.g > 0.5) {
    outColor = vec4(0.97, 0.97, 0.97, 1.0);  // erased -> clean whiteboard
  } else if (c.r > 0.5) {
    outColor = texture(uCur, vUv);
  } else {
    outColor = board;
  }
}`;

/** Output one ink layer on white background; layer 0 red, 1 blue, 2 black. */
export const INK_LAYER_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uBoard;
uniform int uLayer;
${INK_CLASSIFY_GLSL}
void main() {
  vec3 rgb = texture(uBoard, vUv).rgb;
  vec4 ink = classifyInk(rgb);
  float take = 0.0;
  if (uLayer == 0) take = ink.r;
  else if (uLayer == 1) take = ink.g;
  else take = ink.b;
  if (take > 0.5) outColor = vec4(rgb, 1.0);
  else outColor = vec4(1.0);
}`;

/** Upscale a low-res grayscale mask to board resolution (nearest). */
export const UPSCALE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uMask;
void main() {
  float v = texture(uMask, vUv).r;
  outColor = vec4(v, v, v, 1.0);
}`;

/**
 * Upscale a packed R/G flag mask while preserving channel meaning.
 * R = commit flag, G = erase flag; B is forced to zero. Used when promoting
 * the low-resolution tile commit mask to board resolution.
 */
export const UPSCALE_MASK_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uMask;
void main() {
  vec4 m = texture(uMask, vUv);
  outColor = vec4(m.r, m.g, 0.0, 1.0);
}`;
