import { muxMp4, type MuxSample } from '../mp4/mp4'
import { homography, applyH, clamp, type Pt } from '../util'
import type { Lesson, Stroke } from './script'

export const VIDEO_W = 1280, VIDEO_H = 720

/** 白板在视频里的四角（轻微透视，且老师站位会挡住部分边框） */
export const BOARD_QUAD: Pt[] = [
  { x: 170, y: 90 },   // TL
  { x: 1170, y: 70 },  // TR
  { x: 1190, y: 650 }, // BR
  { x: 150, y: 630 },  // BL
]

const PEN: Record<string, string> = { red: '#d22424', blue: '#2040c8', black: '#1a1a1a' }

/** 笔迹在 t 时刻的可见比例（0..1）；被擦除时返回 -1 表示已隐藏 */
function strokeVisibility(s: Stroke, idx: number, lesson: Lesson, t: number): number {
  if (t < s.t0) return 0
  for (const e of lesson.erases) {
    if (e.t0 < s.t0) continue
    const cx = s.pts.reduce((a, p) => a + p[0], 0) / s.pts.length
    const cy = s.pts.reduce((a, p) => a + p[1], 0) / s.pts.length
    if (cx >= e.x0 && cx <= e.x1 && cy >= e.y0 && cy <= e.y1) {
      // 每根笔迹在擦除区间内按确定性的时刻消失（板擦一块块擦）
      const frac = 0.15 + ((idx * 2654435761) % 1000) / 1000 * 0.7
      if (t >= e.t0 + frac * (e.t1 - e.t0)) return -1
    }
  }
  return clamp((t - s.t0) / (s.t1 - s.t0), 0, 1)
}

/** 老师在 t 时刻应该站的位置（白板归一化坐标，可 >1 表示走出白板） */
function teacherTarget(lesson: Lesson, t: number): { x: number; y: number } {
  // 正在写的笔迹 → 站到笔尖右侧
  for (let i = 0; i < lesson.strokes.length; i++) {
    const s = lesson.strokes[i]
    if (t >= s.t0 && t <= s.t1) {
      const f = clamp((t - s.t0) / (s.t1 - s.t0), 0, 1)
      const p = s.pts[Math.min(s.pts.length - 1, Math.floor(f * s.pts.length))]
      return { x: p[0] + 0.07, y: clamp(p[1] + 0.1, 0.2, 0.8) }
    }
  }
  // 正在擦 → 站到擦除区域中
  for (const e of lesson.erases) {
    if (t >= e.t0 - 0.5 && t <= e.t1) {
      const f = clamp((t - e.t0) / (e.t1 - e.t0), 0, 1)
      return { x: e.x0 + (e.x1 - e.x0) * f, y: (e.y0 + e.y1) / 2 }
    }
  }
  // 空闲：开场走进来；页间站边上；结尾走出画面
  if (t < 4) return { x: -0.15 + t * 0.12, y: 0.55 }
  if (t >= 87 && t < 90) return { x: 1.18, y: 0.5 }   // 中途离开（补写前的空档）
  if (t >= 95) return { x: 1.25, y: 0.5 }             // 下课离开
  return { x: 0.9, y: 0.6 }
}

export interface SynthResult {
  blob: Blob
  quad: Pt[]
  encodedFrames: number
  encodeSeconds: number
}

/** 用 canvas 画"虚拟老师 + 白板"合成一节课并编码成 MP4 */
export async function synthesize(lesson: Lesson, onProgress?: (done: number, total: number) => void): Promise<SynthResult> {
  const fps = lesson.fps
  const totalFrames = Math.round(lesson.duration * fps)
  const canvas = new OffscreenCanvas(VIDEO_W, VIDEO_H)
  const ctx = canvas.getContext('2d')!

  // 白板归一化坐标 -> 视频像素 的单应
  const H = homography(
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    BOARD_QUAD,
  )
  const map = (x: number, y: number) => applyH(H, x, y)

  const quadPath = () => {
    ctx.beginPath()
    ctx.moveTo(BOARD_QUAD[0].x, BOARD_QUAD[0].y)
    for (let i = 1; i < 4; i++) ctx.lineTo(BOARD_QUAD[i].x, BOARD_QUAD[i].y)
    ctx.closePath()
  }

  const drawTeacher = (bx: number, by: number, t: number) => {
    const p = map(bx, by)
    const bob = Math.sin(t * 2.2) * 3
    const s = 1.0 // 近处比例
    ctx.save()
    ctx.translate(p.x, p.y + bob)
    // 腿
    ctx.fillStyle = '#565b66'
    ctx.fillRect(-22 * s, 60 * s, 18 * s, 90 * s)
    ctx.fillRect(6 * s, 60 * s, 18 * s, 90 * s)
    // 身体（棕灰夹克：不黑不红不蓝，不会被误判成笔迹）
    ctx.fillStyle = '#6b5f4e'
    ctx.beginPath()
    ctx.roundRect(-45 * s, -60 * s, 90 * s, 130 * s, 18 * s)
    ctx.fill()
    // 头
    ctx.fillStyle = '#caa27e'
    ctx.beginPath()
    ctx.arc(0, -88 * s, 24 * s, 0, Math.PI * 2)
    ctx.fill()
    // 头发（棕灰，避开近黑色误判）
    ctx.fillStyle = '#5a4b40'
    ctx.beginPath()
    ctx.arc(0, -94 * s, 23 * s, Math.PI, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  // --- 编码器 ---
  const chunks: MuxSample[] = []
  let description: Uint8Array | null = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      chunks.push({
        data,
        keyframe: chunk.type === 'key',
        ts: Math.round((chunk.timestamp ?? 0) / 1e6 * 90000),
        dur: Math.round(90000 / fps),
      })
      const desc = meta?.decoderConfig?.description
      if (desc && !description) description = new Uint8Array(desc as ArrayBuffer)
    },
    error: e => { throw e },
  })
  encoder.configure({
    codec: 'avc1.42001f',
    width: VIDEO_W,
    height: VIDEO_H,
    bitrate: 2_000_000,
    framerate: fps,
    latencyMode: 'quality',
    avc: { format: 'avc' },
  } as VideoEncoderConfig)

  // --- 逐帧渲染 ---
  let tx = -0.2, ty = 0.55 // 老师当前位置（平滑追随目标）
  const t0 = performance.now()
  for (let fi = 0; fi < totalFrames; fi++) {
    const t = fi / fps
    // 墙 + 地板
    const grad = ctx.createLinearGradient(0, 0, 0, VIDEO_H)
    grad.addColorStop(0, '#7d838c')
    grad.addColorStop(1, '#5c6169')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, VIDEO_W, VIDEO_H)
    ctx.fillStyle = '#4a4e55'
    ctx.fillRect(0, VIDEO_H - 60, VIDEO_W, 60)
    // 白板
    quadPath()
    ctx.fillStyle = '#f4f4f0'
    ctx.fill()
    ctx.lineWidth = 9
    ctx.strokeStyle = '#3d3f45'
    ctx.stroke()
    // 笔迹
    ctx.save()
    quadPath()
    ctx.clip()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (let i = 0; i < lesson.strokes.length; i++) {
      const s = lesson.strokes[i]
      const vis = strokeVisibility(s, i, lesson, t)
      if (vis <= 0) continue
      const n = Math.max(2, Math.floor(s.pts.length * vis))
      ctx.beginPath()
      const p0 = map(s.pts[0][0], s.pts[0][1])
      ctx.moveTo(p0.x, p0.y)
      for (let k = 1; k < n; k++) {
        const p = map(s.pts[k][0], s.pts[k][1])
        ctx.lineTo(p.x, p.y)
      }
      ctx.strokeStyle = PEN[s.color]
      ctx.lineWidth = s.width * 1000
      ctx.stroke()
    }
    ctx.restore()
    // 老师（平滑移动）
    const target = teacherTarget(lesson, t)
    const speed = 0.9 / fps // 归一化单位/帧
    tx += clamp(target.x - tx, -speed, speed)
    ty += clamp(target.y - ty, -speed, speed)
    if (tx > -0.05 && tx < 1.3) drawTeacher(tx, ty, t)

    const frame = new VideoFrame(canvas, { timestamp: Math.round((fi * 1e6) / fps), duration: Math.round(1e6 / fps) })
    encoder.encode(frame, { keyFrame: fi % 48 === 0 })
    frame.close()
    // 编码器背压 + 定期让出主线程
    while (encoder.encodeQueueSize > 6) {
      await new Promise(r => encoder.addEventListener('dequeue', r, { once: true }))
    }
    if (fi % 24 === 0) {
      onProgress?.(fi, totalFrames)
      await new Promise(r => setTimeout(r, 0))
    }
  }
  await encoder.flush()
  encoder.close()
  if (!description) throw new Error('编码器未给出 avcC 描述')
  const buf = muxMp4(chunks, { width: VIDEO_W, height: VIDEO_H, timescale: 90000, description })
  return {
    blob: new Blob([buf], { type: 'video/mp4' }),
    quad: BOARD_QUAD.map(p => ({ ...p })),
    encodedFrames: totalFrames,
    encodeSeconds: (performance.now() - t0) / 1000,
  }
}
