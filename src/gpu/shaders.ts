/** 所有 GLSL（WebGL2 / GLSL ES 3.00） */

/** 透视矫正：把视频帧按单应矩阵采样到白板坐标系 */
export const FS_RECTIFY = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_video;
uniform mat3 u_M; // 白板UV(0..1) -> 视频UV(0..1)
void main() {
  vec3 p = u_M * vec3(v_uv, 1.0);
  vec2 uv = p.xy / p.z;
  o = texture(u_video, uv);
}`

/** 逐像素最大值融合（检测预处理的"去人影"：多帧取最亮，人走来走去被抹掉） */
export const FS_MAX = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_acc;
uniform sampler2D u_frame;
void main() {
  o = max(texture(u_acc, v_uv), texture(u_frame, v_uv));
}`

/** 直通拷贝 */
export const FS_COPY = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
void main() { o = texture(u_tex, v_uv); }`

/**
 * 核心时序累积（MRT 一遍出 4 张图）：
 *  out0 state   —— 已确认的板书内容（干净白板+笔迹）
 *  out1 layer   —— 笔迹颜色层掩膜 R=红 G=蓝 B=黑
 *  out2 cand    —— 候选颜色(rgb)+连续稳定帧数(a*255)
 *  out3 metrics —— R: 事件标志(bit0提交 bit2擦除) G: 当前有笔迹 B: 人体/瞬态遮挡
 *
 * 关键逻辑：笔迹颜色要连续稳定 K 帧才"提交"进板书 —— 老师身体不是笔迹色，
 * 永远不会提交；笔被挡住时计数冻结，人走开后继续累计，够了才更新那片板书。
 */
export const FS_UPDATE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_frame;
uniform sampler2D u_prev;
uniform sampler2D u_state;
uniform sampler2D u_layer;
uniform sampler2D u_cand;
uniform sampler2D u_heat;
uniform float u_K;   // 笔迹提交所需稳定帧数
uniform float u_K2;  // 擦除确认所需稳定帧数
uniform vec2 u_texel; // 1/板面尺寸
layout(location=0) out vec4 o_state;
layout(location=1) out vec4 o_layer;
layout(location=2) out vec4 o_cand;
layout(location=3) out vec4 o_metrics;
layout(location=4) out vec4 o_heat;

bool whiteish(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  return mn > 0.70 && (mx - mn) < 0.14;
}

void main() {
  vec3 f  = texture(u_frame, v_uv).rgb;
  vec3 pf = texture(u_prev,  v_uv).rgb;
  vec3 st = texture(u_state, v_uv).rgb;
  vec3 ly = texture(u_layer, v_uv).rgb;
  vec4 cd = texture(u_cand,  v_uv);
  float ht = texture(u_heat, v_uv).r * 255.0; // 候选时长（秒×4）

  float mx = max(f.r, max(f.g, f.b));
  float mn = min(f.r, min(f.g, f.b));
  bool moved   = distance(f, pf) > 0.12;
  bool isWhite = whiteish(f);
  // 笔迹色判定：真笔迹总有一个很暗的通道（红/蓝墨水的另两通道、黑墨水的全部通道），
  // 擦除残影/编码鬼影三通道都偏亮，以此排除
  bool isRed   = (f.r - max(f.g, f.b)) > 0.25 && min(f.g, f.b) < 0.50;
  bool isBlue  = (f.b - max(f.r, f.g)) > 0.25 && min(f.r, f.g) < 0.50;
  bool isBlack = mx < 0.28 && (mx - mn) < 0.20;
  // 细特征过滤：笔迹是细线，4px 内必有白板；头发/衣物的暗色团块内部不算
  bool nearWhite = false;
  for (int i = 0; i < 4; i++) {
    vec2 off = vec2(i == 0 ? 4.0 : (i == 1 ? -4.0 : 0.0), i == 2 ? 4.0 : (i == 3 ? -4.0 : 0.0)) * u_texel;
    if (whiteish(texture(u_frame, v_uv + off).rgb)) nearWhite = true;
  }
  bool isStroke = (isRed || isBlue || isBlack) && nearWhite;
  bool committed = (ly.r + ly.g + ly.b) > 0.5;

  float cnt = cd.a * 255.0;
  vec3 ccol = cd.rgb;
  bool commit = false, erase = false, person = false;
  vec3 nst = st, nly = ly;
  vec4 ncd = vec4(0.0);

  if (isStroke) {
    if (committed) {
      // 已有笔迹，保持（叠写暂不覆盖）
    } else {
      bool same = cnt > 0.5 && distance(ccol, f) < 0.22;
      if (same && moved) {
        ncd = cd; // 帧间在动（手/笔正在写），冻结不计数
      } else if (same) {
        cnt += 1.0;
        ncd = vec4(ccol, cnt / 255.0);
      } else {
        cnt = moved ? 0.0 : 1.0;
        ncd = vec4(f, cnt / 255.0);
      }
      if (cnt >= u_K) {
        commit = true;
        nst = ccol;
        nly = isRed ? vec3(1.0, 0.0, 0.0) : (isBlue ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
        ncd = vec4(0.0);
      }
    }
  } else if (isWhite) {
    if (committed) {
      bool sameW = cnt > 0.5 && distance(ccol, vec3(1.0)) < 0.22;
      if (sameW && moved) {
        ncd = cd;
      } else if (sameW) {
        cnt += 1.0;
        ncd = vec4(ccol, cnt / 255.0);
      } else {
        cnt = moved ? 0.0 : 1.0;
        ncd = vec4(vec3(1.0), cnt / 255.0);
      }
      if (cnt >= u_K2) {
        erase = true;
        nst = vec3(1.0);
        nly = vec3(0.0);
        ncd = vec4(0.0);
      }
    }
  } else {
    person = true; // 非板面非笔迹：人体/影子等瞬态遮挡，冻结该像素
  }

  o_state = vec4(nst, 1.0);
  o_layer = vec4(nly, 1.0);
  o_cand  = ncd;
  // bit0 提交 / bit1 擦除
  float flags = (commit ? 1.0 : 0.0) + (erase ? 2.0 : 0.0);
  bool hasStroke = (nly.r + nly.g + nly.b) > 0.5;
  o_metrics = vec4(flags / 255.0, hasStroke ? 1.0 : 0.0, person ? 1.0 : 0.0, 1.0);
  // 候选中的笔迹色像素：累计候选时长（≈书写时长），最终只统计确认成笔迹的像素。
  // 人体晕环也会伪装成候选，但它随人移动而消失 —— 非候选超过 4s 就清零，
  // 真笔迹在被擦掉前一直是候选（或已提交），时长得以保留。
  float idle = texture(u_heat, v_uv).g * 255.0;
  if (isStroke && !committed && !commit) {
    ht = min(255.0, ht + 2.0); // +0.5s × 4
    idle = 0.0;
  } else if (!committed && !commit) {
    idle += 1.0;
    if (idle > 8.0) { ht = 0.0; idle = 0.0; }
  } else {
    idle = 0.0;
  }
  o_heat = vec4(ht / 255.0, idle / 255.0, 0.0, 1.0);
}`

/** 展示用：state + 图层开关合成 */
export const FS_PRESENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_state;
uniform sampler2D u_layer;
uniform vec3 u_show; // 红/蓝/黑 各层开关 0/1
void main() {
  vec3 st = texture(u_state, v_uv).rgb;
  vec3 ly = texture(u_layer, v_uv).rgb;
  float vis = dot(ly, u_show);
  o = vec4(vis > 0.5 ? st : vec3(1.0), 1.0);
}`
