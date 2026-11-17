import { GL } from '../gpu/gl'
import { FS_MAX, FS_COPY } from '../gpu/shaders'
import { keyframeFrames } from '../decode/decoder'
import type { Mp4File } from '../mp4/mp4'
import type { Pt } from '../util'

export interface DetectResult {
  /** 视频像素坐标，顺序 TL TR BR BL */
  quad: Pt[]
  /** 0..1，四条边的平均支撑度 */
  confidence: number
  /** 多帧最大值融合图（已翻正），用于定位界面显示 */
  blend: ImageData
}

const DW = 320, DH = 180

/**
 * 自动定位白板四边。
 * 思路：取散布全片的关键帧做逐像素最大值融合 —— 白板比老师亮，
 * 人走来走去会被"最亮值"抹掉，即使某一帧边框被挡住一截，
 * 其它帧里同一段边框露出来过，融合后就完整了；
 * 然后在融合图上做边缘行列投影 + 直线拟合求四条边框。
 */
export async function detectBoard(gl: GL, mp4: Mp4File): Promise<DetectResult> {
  const g = gl.gl
  const frames = await keyframeFrames(mp4, 16)

  const accTex = gl.tex(mp4.width, mp4.height)
  const tmpTex = gl.tex(mp4.width, mp4.height)
  const accFb = gl.fbo(accTex)
  const tmpFb = gl.fbo(tmpTex)
  gl.clearTex(accFb, 0, 0, 0, 0, 1)

  const videoTex = g.createTexture()!
  g.bindTexture(g.TEXTURE_2D, videoTex)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)

  const maxProg = gl.program(FS_MAX)
  g.useProgram(maxProg)
  const uAcc = gl.uloc(maxProg, 'u_acc')
  const uFrame = gl.uloc(maxProg, 'u_frame')

  let src = accTex, srcFb = accFb, dst = tmpTex, dstFb = tmpFb
  for (const frame of frames) {
    g.activeTexture(g.TEXTURE1)
    g.bindTexture(g.TEXTURE_2D, videoTex)
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, frame as unknown as TexImageSource)
    frame.close()
    g.useProgram(maxProg)
    gl.bindTex(0, src, uAcc)
    g.uniform1i(uFrame, 1)
    gl.draw(dstFb, mp4.width, mp4.height)
    ;[src, dst] = [dst, src];[srcFb, dstFb] = [dstFb, srcFb]
  }

  // 缩到 320×180 读回
  const smallTex = gl.tex(DW, DH)
  const smallFb = gl.fbo(smallTex)
  const copyProg = gl.program(FS_COPY)
  g.useProgram(copyProg)
  gl.bindTex(0, src, gl.uloc(copyProg, 'u_tex'))
  gl.draw(smallFb, DW, DH)
  const px = gl.readPixels(smallFb, DW, DH)
  const blend = new ImageData(new Uint8ClampedArray(px.buffer.slice(0) as ArrayBuffer), DW, DH)

  // 灰度 + Sobel 边缘
  const lum = new Float32Array(DW * DH)
  for (let i = 0; i < DW * DH; i++)
    lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]
  const edge = new Uint8Array(DW * DH)
  for (let y = 1; y < DH - 1; y++)
    for (let x = 1; x < DW - 1; x++) {
      const gx = lum[y * DW + x + 1] - lum[y * DW + x - 1]
      const gy = lum[(y + 1) * DW + x] - lum[(y - 1) * DW + x]
      if (Math.abs(gx) + Math.abs(gy) > 60) edge[y * DW + x] = 1
    }

  // 行/列投影找边框候选
  const rows = new Float32Array(DH), cols = new Float32Array(DW)
  for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) if (edge[y * DW + x]) { rows[y]++; cols[x]++ }
  const peakIn = (arr: Float32Array, lo: number, hi: number) => {
    let best = lo, bv = -1
    for (let i = lo; i < hi; i++) if (arr[i] > bv) { bv = arr[i]; best = i }
    return { idx: best, val: bv }
  }
  const top = peakIn(rows, 2, Math.floor(DH * 0.45))
  const bottom = peakIn(rows, Math.ceil(DH * 0.55), DH - 2)
  const left = peakIn(cols, 2, Math.floor(DW * 0.45))
  const right = peakIn(cols, Math.ceil(DW * 0.55), DW - 2)

  // 在峰值附近收集边缘点做最小二乘直线拟合（含一次离群剔除）
  const fitLine = (pts: [number, number][], vertical: boolean) => {
    // vertical: x = a*y + b；否则 y = a*x + b
    let use = pts.map(() => true)
    let a = 0, b = 0
    for (let iter = 0; iter < 2; iter++) {
      let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0
      pts.forEach((p, i) => {
        if (!use[i]) return
        const x = vertical ? p[1] : p[0], y = vertical ? p[0] : p[1]
        sx += x; sy += y; sxx += x * x; sxy += x * y; n++
      })
      if (n < 3) return null
      const d = n * sxx - sx * sx || 1e-9
      a = (n * sxy - sx * sy) / d
      b = (sy - a * sx) / n
      if (iter === 0) {
        // 剔除残差 > 3px 的点
        pts.forEach((p, i) => {
          const x = vertical ? p[1] : p[0], y = vertical ? p[0] : p[1]
          if (Math.abs(y - (a * x + b)) > 3) use[i] = false
        })
      }
    }
    return { a, b }
  }
  const collect = (fixed: number, horizontal: boolean): [number, number][] => {
    const pts: [number, number][] = []
    if (horizontal) {
      for (let y = Math.max(0, fixed - 3); y <= Math.min(DH - 1, fixed + 3); y++)
        for (let x = 0; x < DW; x++) if (edge[y * DW + x]) pts.push([x, y])
    } else {
      for (let x = Math.max(0, fixed - 3); x <= Math.min(DW - 1, fixed + 3); x++)
        for (let y = 0; y < DH; y++) if (edge[y * DW + x]) pts.push([x, y])
    }
    return pts
  }

  const lt = fitLine(collect(top.idx, true), false)      // y = a x + b
  const lb = fitLine(collect(bottom.idx, true), false)
  const ll = fitLine(collect(left.idx, false), true)     // x = c y + d
  const lr = fitLine(collect(right.idx, false), true)

  const fallback = (): DetectResult => ({
    quad: [
      { x: mp4.width * 0.02, y: mp4.height * 0.02 },
      { x: mp4.width * 0.98, y: mp4.height * 0.02 },
      { x: mp4.width * 0.98, y: mp4.height * 0.98 },
      { x: mp4.width * 0.02, y: mp4.height * 0.98 },
    ],
    confidence: 0,
    blend,
  })
  if (!lt || !lb || !ll || !lr) return fallback()

  const ix = (h: { a: number; b: number }, v: { a: number; b: number }): Pt => {
    // y = h.a x + h.b 与 x = v.a y + v.a... 联立
    const y = (h.a * v.b + h.b) / (1 - h.a * v.a)
    return { x: v.a * y + v.b, y }
  }
  const q = [ix(lt, ll), ix(lt, lr), ix(lb, lr), ix(lb, ll)]
  const sx = mp4.width / DW, sy = mp4.height / DH
  const quad = q.map(p => ({ x: p.x * sx, y: p.y * sy }))

  // 支撑度：沿每条边采样，看边缘点附近命中率（边框被挡住一截时仍 > 0.5 即可）
  const support = (p0: Pt, p1: Pt) => {
    let hit = 0, n = 0
    for (let t = 0; t <= 1; t += 0.02) {
      const x = Math.round((p0.x + (p1.x - p0.x) * t) / sx)
      const y = Math.round((p0.y + (p1.y - p0.y) * t) / sy)
      n++
      let ok = false
      for (let dy = -2; dy <= 2 && !ok; dy++)
        for (let dx = -2; dx <= 2 && !ok; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx >= 0 && xx < DW && yy >= 0 && yy < DH && edge[yy * DW + xx]) ok = true
        }
      if (ok) hit++
    }
    return n ? hit / n : 0
  }
  const confidence =
    (support(quad[0], quad[1]) + support(quad[1], quad[2]) + support(quad[2], quad[3]) + support(quad[3], quad[0])) / 4
  if (confidence < 0.3) return { ...fallback(), blend }

  return { quad, confidence, blend }
}
