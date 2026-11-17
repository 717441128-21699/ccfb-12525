import { mulberry32 } from '../util'

export type PenColor = 'red' | 'blue' | 'black'

export interface Stroke {
  color: PenColor
  /** 白板归一化坐标折线 */
  pts: [number, number][]
  width: number
  /** 书写起止（秒） */
  t0: number
  t1: number
}

export interface Erase {
  x0: number; y0: number; x1: number; y1: number
  t0: number; t1: number
}

export interface GtPage {
  /** 本页新内容书写起止（真值） */
  startT: number
  endT: number
  /** 页状态定格时刻（大擦除开始 / 视频结束） */
  boundaryT: number
}

export interface Lesson {
  fps: number
  duration: number
  strokes: Stroke[]
  erases: Erase[]
  gtPages: GtPage[]
}

const W_LINE = 0.006

/** 一页在 boundaryT 时刻可见的笔迹（真值内容） */
export function pageStrokes(lesson: Lesson, pageIdx: number): Stroke[] {
  const boundary = lesson.gtPages[pageIdx].boundaryT
  const prevBoundary = pageIdx === 0 ? 0 : lesson.gtPages[pageIdx - 1].boundaryT
  return lesson.strokes.filter(s => {
    if (s.t1 > boundary) return false
    // 被 boundary 之前完成的擦除抹掉的不可见
    for (const e of lesson.erases) {
      if (e.t1 > boundary || e.t0 < s.t0) continue
      const cx = s.pts.reduce((a, p) => a + p[0], 0) / s.pts.length
      const cy = s.pts.reduce((a, p) => a + p[1], 0) / s.pts.length
      if (cx >= e.x0 && cx <= e.x1 && cy >= e.y0 && cy <= e.y1) return false
    }
    return true
  })
}

/** 生成固定教案：3 页板书，含擦掉重写、半页补写、小改不重分页 */
export function makeLesson(): Lesson {
  const rng = mulberry32(20261117)
  const strokes: Stroke[] = []
  const erases: Erase[] = []

  const row = (x0: number, y: number, len: number, color: PenColor, t0: number, dur: number, w = W_LINE) => {
    const n = Math.max(8, Math.round(len * 60))
    const pts: [number, number][] = []
    for (let i = 0; i <= n; i++) {
      const x = x0 + (len * i) / n
      pts.push([x, y + (rng() - 0.5) * 0.012 + Math.sin(i * 1.7) * 0.008])
    }
    strokes.push({ color, pts, width: w, t0, t1: t0 + dur })
  }
  const circle = (cx: number, cy: number, r: number, color: PenColor, t0: number, dur: number) => {
    const pts: [number, number][] = []
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * 1.3])
    }
    strokes.push({ color, pts, width: W_LINE, t0, t1: t0 + dur })
  }
  const line = (x0: number, y0: number, x1: number, y1: number, color: PenColor, t0: number, dur: number, w = W_LINE) => {
    const pts: [number, number][] = []
    const n = 20
    for (let i = 0; i <= n; i++) pts.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n])
    strokes.push({ color, pts, width: w, t0, t1: t0 + dur })
  }

  // ---------- 第 1 页：4s–33s ----------
  let t = 4
  for (let r = 0; r < 6; r++) {
    row(0.06, 0.16 + r * 0.11, 0.46 + rng() * 0.06, 'black', t, 2.6)
    t += 2.9
  }
  // 红笔：第 2 行下划线 + 右上五角星
  line(0.06, 0.30, 0.52, 0.30, 'red', t, 1.6, 0.008); t += 1.9
  const star: [number, number][] = []
  for (let i = 0; i <= 5; i++) {
    const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5
    star.push([0.78 + Math.cos(a) * 0.05, 0.14 + Math.sin(a) * 0.065])
  }
  strokes.push({ color: 'red', pts: star, width: W_LINE, t0: t, t1: t + 1.8 }); t += 2.1
  // 蓝笔公式（右侧）
  row(0.62, 0.28, 0.3, 'blue', t, 2.2); t += 2.5
  row(0.62, 0.40, 0.24, 'blue', t, 2.0); t += 2.3
  // 底部再来一行黑
  row(0.06, 0.86, 0.5, 'black', t, 2.6); t += 2.9
  const p1End = t // ≈ 33

  // ---------- 擦除 A：37s–41s 擦掉右侧 40% ----------
  erases.push({ x0: 0.58, y0: 0.04, x1: 0.98, y1: 0.96, t0: 37, t1: 41 })

  // ---------- 第 2 页：43s–63s（左半旧板书保留） ----------
  t = 43
  // 蓝笔坐标系 + 曲线
  line(0.64, 0.15, 0.64, 0.75, 'blue', t, 1.4); t += 1.6
  line(0.62, 0.72, 0.95, 0.72, 'blue', t, 1.4); t += 1.6
  const curve: [number, number][] = []
  for (let i = 0; i <= 30; i++) {
    const x = 0.64 + (0.3 * i) / 30
    curve.push([x, 0.72 - 0.5 * Math.pow(i / 30, 2)])
  }
  strokes.push({ color: 'blue', pts: curve, width: W_LINE, t0: t, t1: t + 2.4 }); t += 2.8
  // 黑笔标注
  row(0.66, 0.82, 0.26, 'black', t, 2.2); t += 2.5
  row(0.66, 0.10, 0.2, 'black', t, 2.0); t += 2.3
  // 红笔箭头
  line(0.72, 0.5, 0.85, 0.32, 'red', t, 1.6); t += 1.8
  line(0.85, 0.32, 0.82, 0.33, 'red', t, 0.8); t += 1.0
  line(0.85, 0.32, 0.84, 0.35, 'red', t, 0.8); t += 1.0
  row(0.06, 0.86, 0.4, 'black', t, 2.2); t += 2.5
  const p2End = t // ≈ 63

  // ---------- 擦除 B：67s–71s 整板擦掉 ----------
  erases.push({ x0: 0.02, y0: 0.02, x1: 0.99, y1: 0.98, t0: 67, t1: 71 })

  // ---------- 第 3 页：73s–95s ----------
  t = 73
  // 黑笔表格
  for (let i = 0; i < 4; i++) { line(0.08, 0.2 + i * 0.18, 0.6, 0.2 + i * 0.18, 'black', t, 0.9); t += 1.05 }
  for (let i = 0; i < 4; i++) { line(0.08 + i * 0.174, 0.2, 0.08 + i * 0.174, 0.74, 'black', t, 0.9); t += 1.05 }
  // 表格里一个小词（随后被小范围擦掉重写 —— 不应触发翻页）
  row(0.12, 0.29, 0.1, 'black', t, 1.2); t += 1.4
  erases.push({ x0: 0.09, y0: 0.24, x1: 0.26, y1: 0.34, t0: t + 0.5, t1: t + 1.5 })
  t += 1.8
  row(0.12, 0.29, 0.11, 'blue', t, 1.2); t += 1.4 // 重写（蓝笔）
  // 公式写一半，老师走开，再回来补完（同一页，最终合成完整状态）
  row(0.68, 0.3, 0.12, 'black', t, 1.4); t += 4.0 // 中途有 ~2.6s 空档（老师离开）
  row(0.68, 0.3, 0.26, 'black', t, 1.6); t += 1.8
  // 红笔重点圈
  circle(0.8, 0.3, 0.16, 'red', t, 1.6); t += 1.8
  row(0.68, 0.55, 0.24, 'black', t, 1.6); t += 1.8
  const p3End = t // ≈ 95.4

  return {
    fps: 24,
    duration: 100,
    strokes,
    erases,
    gtPages: [
      { startT: 4, endT: p1End, boundaryT: 37 },
      { startT: 43, endT: p2End, boundaryT: 67 },
      { startT: 73, endT: p3End, boundaryT: 100 },
    ],
  }
}
