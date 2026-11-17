import { GL } from '../gpu/gl'
import { FS_RECTIFY, FS_UPDATE } from '../gpu/shaders'
import { decodeFrames } from '../decode/decoder'
import type { Mp4File } from '../mp4/mp4'
import { homography, invert3, type Pt } from '../util'

export const BW = 1280, BH = 720
export const GRID_X = 6, GRID_Y = 4

export interface PageResult {
  index: number
  /** 本页首次书写时刻（秒） */
  startT: number
  /** 本页最后一次书写时刻（秒） */
  endT: number
  /** 页存续区间（被擦掉/视频结束） */
  wallStartT: number
  wallEndT: number
  /** RGBA，BW×BH，顶行在前：白板最终状态 */
  state: Uint8Array
  /** RGBA 层掩膜：R=红 G=蓝 B=黑 */
  layer: Uint8Array
  /** 6×4 格书写时长（秒） */
  heat: number[]
  topCell: number
  peakStrokes: number
}

export interface ExtractProgress {
  t: number
  duration: number
  pages: number
  strokeCount: number
  personRatio: number
}

export interface ExtractOpts {
  interval?: number   // 采样间隔秒，默认 0.5
  k?: number          // 笔迹提交稳定帧数，默认 3
  k2?: number         // 擦除确认稳定帧数，默认 3
  onProgress?: (p: ExtractProgress) => void
  onSample?: (t: number, stateRGBA: Uint8Array, metricsRGBA: Uint8Array) => void
  debug?: (msg: string) => void
}

// 翻页判定
const ERASE_WINDOW = 6     // 滑动窗口（采样数，约 3s）累计擦除量
const ERASE_BURST = 3500   // 窗口内擦除提交像素超过此值视为"擦掉重写"
const DROP_RATIO = 0.85    // 且笔迹量跌破峰值的 85%
const MIN_PAGE = 3000      // 一页至少这么多笔迹像素才保存
const RING_DEPTH = 12      // 快照环深度（约 6s，用于取擦除前的页面状态）

function mul3(a: number[], b: number[]): number[] {
  const o = new Array(9)
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  return o
}

/** 视频四角(像素) -> 白板坐标 的着色器矩阵（白板UV -> 视频UV，列主序） */
export function boardMatrix(quad: Pt[], vw: number, vh: number): Float32Array {
  // 向质心收缩 3%：去掉白板深色边框（否则边框会被当成黑笔迹提交）
  const cx = quad.reduce((a, p) => a + p.x, 0) / 4
  const cy = quad.reduce((a, p) => a + p.y, 0) / 4
  const inner = quad.map(p => ({ x: p.x + (cx - p.x) * 0.03, y: p.y + (cy - p.y) * 0.03 }))
  const Hv2b = homography(inner, [{ x: 0, y: 0 }, { x: BW, y: 0 }, { x: BW, y: BH }, { x: 0, y: BH }])
  const Hbv = invert3(Hv2b)
  const D = [BW, 0, 0, 0, BH, 0, 0, 0, 1]               // 白板UV -> 白板像素
  const N = [1 / vw, 0, 0, 0, 1 / vh, 0, 0, 0, 1]       // 视频像素 -> 视频UV
  const M = mul3(N, mul3(Hbv, D))
  // 行主序 -> 列主序
  return new Float32Array([M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]])
}

interface Snap { t: number; state: Uint8Array; layer: Uint8Array }

export interface ExtractOutput { pages: PageResult[]; elapsed: number }

export async function extractBoard(gl: GL, mp4: Mp4File, quad: Pt[], opts: ExtractOpts = {}): Promise<ExtractOutput> {
  const g = gl.gl
  const interval = opts.interval ?? 0.5
  const K = opts.k ?? 3, K2 = opts.k2 ?? 3

  // --- 纹理 ---
  const frameTex = [gl.tex(BW, BH), gl.tex(BW, BH)]
  const frameFb = [gl.fbo(frameTex[0]), gl.fbo(frameTex[1])]
  const mkBundle = () => {
    const state = gl.tex(BW, BH), layer = gl.tex(BW, BH), cand = gl.tex(BW, BH), metrics = gl.tex(BW, BH), heat = gl.tex(BW, BH)
    const fb = gl.fbo(state, layer, cand, metrics, heat)
    return { state, layer, cand, metrics, heat, fb }
  }
  const bundles = [mkBundle(), mkBundle()]
  gl.clearTex(bundles[0].fb, 0, 1, 1, 1, 1) // state = 白板
  gl.clearTex(bundles[0].fb, 1, 0, 0, 0, 1)
  gl.clearTex(bundles[0].fb, 2, 0, 0, 0, 0)
  gl.clearTex(bundles[0].fb, 3, 0, 0, 0, 1)
  gl.clearTex(bundles[0].fb, 4, 0, 0, 0, 1) // 候选时长
  let cur = 0

  const videoTex = g.createTexture()!
  g.bindTexture(g.TEXTURE_2D, videoTex)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)

  const rectProg = gl.program(FS_RECTIFY)
  const rectM = gl.uloc(rectProg, 'u_M')
  const rectTex = gl.uloc(rectProg, 'u_video')
  const M = boardMatrix(quad, mp4.width, mp4.height)

  const updProg = gl.program(FS_UPDATE)
  const uL = (n: string) => gl.uloc(updProg, n)
  g.useProgram(updProg)
  g.uniform1f(uL('u_K'), K)
  g.uniform1f(uL('u_K2'), K2)
  g.uniform2f(uL('u_texel'), 1 / BW, 1 / BH)

  // --- 页状态 ---
  const pages: PageResult[] = []
  const ring: Snap[] = []
  let pagePeak = 0
  let pageWallStart = 0
  let firstCommitT: number | null = null
  let lastCommitT: number | null = null
  let burstCooldown = 0
  let burstArmed = true // 触发后要等擦除窗口回落才再武装，防止同一次擦除翻两页
  const eraseWindow: number[] = [] // 最近若干次采样的擦除量
  let t0 = 0

  const finalize = (snap: Snap, wallEnd: number) => {
    if (pagePeak < MIN_PAGE) return
    // 热度 = 各格内"最终确认笔迹"像素的候选时长总和（≈书写时长）
    const heatTex = gl.readPixels(bundles[cur].fb, BW, BH, 4)
    const heat = new Array(GRID_X * GRID_Y).fill(0)
    for (let y = 0; y < BH; y++) {
      const cellRow = Math.min(GRID_Y - 1, (y * GRID_Y / BH) | 0) * GRID_X
      const row = y * BW
      for (let x = 0; x < BW; x++) {
        const i = row + x
        if (snap.layer[i * 4] > 127 || snap.layer[i * 4 + 1] > 127 || snap.layer[i * 4 + 2] > 127)
          heat[cellRow + Math.min(GRID_X - 1, (x * GRID_X / BW) | 0)] += heatTex[i * 4] / 4
      }
    }
    const topCell = heat.indexOf(Math.max(...heat))
    pages.push({
      index: pages.length,
      startT: firstCommitT ?? pageWallStart,
      endT: lastCommitT ?? pageWallStart,
      wallStartT: pageWallStart,
      wallEndT: wallEnd,
      state: snap.state.slice(),
      layer: snap.layer.slice(),
      heat,
      topCell,
      peakStrokes: pagePeak,
    })
  }
  const resetPage = (t: number, strokeCount: number) => {
    pagePeak = strokeCount
    pageWallStart = t
    firstCommitT = null
    lastCommitT = null
    // 新一页的候选时长从零开始（两块乒乓纹理都清）
    gl.clearTex(bundles[0].fb, 4, 0, 0, 0, 1)
    gl.clearTex(bundles[1].fb, 4, 0, 0, 0, 1)
  }

  // --- 主循环 ---
  let nextT = -1
  let curFrame = 0
  let havePrev = false
  let sampleCount = 0
  const tStart = performance.now()

  for await (const frame of decodeFrames(mp4)) {
    const t = frame.timestamp / 1e6
    if (t < nextT - 1e-6) { frame.close(); continue }
    nextT = t + interval
    if (sampleCount === 0) opts.debug?.('extractor: 第一帧到达')
    if (sampleCount % 40 === 0) opts.debug?.(`extractor: 采样 #${sampleCount} t=${t.toFixed(1)}`)
    if (sampleCount++ % 8 === 0) await new Promise(r => setTimeout(r, 0)) // 让出主线程
    if (!havePrev) { t0 = t; pageWallStart = t }

    // 上传 + 矫正
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, videoTex)
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, frame as unknown as TexImageSource)
    frame.close()
    g.useProgram(rectProg)
    g.uniformMatrix3fv(rectM, false, M)
    g.uniform1i(rectTex, 0)
    gl.draw(frameFb[curFrame], BW, BH)

    if (havePrev) {
      // 时序累积
      const src = bundles[cur], dst = bundles[1 - cur]
      g.useProgram(updProg)
      gl.bindTex(0, frameTex[curFrame], uL('u_frame'))
      gl.bindTex(1, frameTex[1 - curFrame], uL('u_prev'))
      gl.bindTex(2, src.state, uL('u_state'))
      gl.bindTex(3, src.layer, uL('u_layer'))
      gl.bindTex(4, src.cand, uL('u_cand'))
      gl.bindTex(5, src.heat, uL('u_heat'))
      gl.draw(dst.fb, BW, BH)
      cur = 1 - cur

      // 读回
      const b = bundles[cur]
      const metrics = gl.readPixels(b.fb, BW, BH, 3)
      const state = gl.readPixels(b.fb, BW, BH, 0)
      const layer = gl.readPixels(b.fb, BW, BH, 1)
      ring.push({ t, state, layer })
      if (ring.length > RING_DEPTH) ring.shift()

      // CPU 统计
      let commits = 0, erases = 0, strokeCount = 0, person = 0
      for (let y = 0; y < BH; y++) {
        const row = y * BW * 4
        for (let x = 0; x < BW; x++) {
          const i = row + x * 4
          const fl = metrics[i]
          if (fl & 1) commits++
          if (fl & 2) erases++
          if (metrics[i + 1] > 127) strokeCount++
          if (metrics[i + 2] > 127) person++
        }
      }

      if (commits > 30 || erases > 30) opts.debug?.(`t=${t.toFixed(1)} commits=${commits} erases=${erases}`)

      // 起止时间只认成规模的书写（零星提交是擦除边界的编码噪点）
      if (commits >= 100) {
        if (firstCommitT === null) firstCommitT = t
        lastCommitT = t
      }
      if (strokeCount > pagePeak) pagePeak = strokeCount
      burstCooldown--
      eraseWindow.push(erases)
      if (eraseWindow.length > ERASE_WINDOW) eraseWindow.shift()
      const eraseSum = eraseWindow.reduce((a, v) => a + v, 0)
      if (!burstArmed && eraseSum < ERASE_BURST / 2) burstArmed = true

      if (
        burstArmed &&
        eraseSum > ERASE_BURST &&
        pagePeak >= MIN_PAGE &&
        strokeCount < pagePeak * DROP_RATIO &&
        burstCooldown <= 0
      ) {
        // 擦掉重写 → 上一页结束（取快照环里最老的、擦除开始前的状态）
        const snap = ring[0]
        finalize(snap, t)
        resetPage(t, strokeCount)
        burstArmed = false
        burstCooldown = Math.round(2 / interval)
      }

      opts.onProgress?.({
        t, duration: mp4.duration, pages: pages.length,
        strokeCount, personRatio: person / (BW * BH),
      })
      opts.onSample?.(t, state, metrics)
    } else {
      havePrev = true
    }
    curFrame = 1 - curFrame
  }

  // 收尾：最后一页
  opts.debug?.('extractor: 解码循环结束')
  if (ring.length) finalize(ring[ring.length - 1], ring[ring.length - 1].t)
  const elapsed = (performance.now() - tStart) / 1000
  return { pages, elapsed }
}

/** 处理耗时统计由调用方记录；这里导出常量方便测试断言 */
export const LIMITS = { ERASE_BURST, DROP_RATIO, MIN_PAGE }
