export interface Pt { x: number; y: number }

/** 确定性伪随机（合成录像要可复现） */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v }

export function fmtTime(sec: number) {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** 由 4 组对应点求单应矩阵 H（dst = H · src），返回行主序 9 元数组 */
export function homography(src: Pt[], dst: Pt[]): number[] {
  // 8 未知量（h33=1），高斯消元
  const n = 8
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: X, y: Y } = dst[i]
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X)
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y)
  }
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r
    ;[A[col], A[piv]] = [A[piv], A[col]];[b[col], b[piv]] = [b[piv], b[col]]
    const d = A[col][col] || 1e-12
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = A[r][col] / d
      if (f === 0) continue
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c]
      b[r] -= f * b[col]
    }
  }
  const h = b.map((v, i) => v / (A[i][i] || 1e-12))
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]
}

/** 3x3 求逆（行主序） */
export function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C || 1e-12
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ]
}

/** 3x3 · 点 */
export function applyH(m: number[], x: number, y: number): Pt {
  const w = m[6] * x + m[7] * y + m[8] || 1e-12
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w }
}

export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
