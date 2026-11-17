import { GL } from '../gpu/gl'
import { demuxMp4 } from '../mp4/mp4'
import { detectBoard } from '../pipeline/boardDetect'
import { extractBoard, boardMatrix, BW, BH, GRID_X, GRID_Y } from '../pipeline/extractor'
import { composePage } from '../pipeline/render'
import { makeLesson, pageStrokes, type Lesson, type PenColor } from '../testgen/script'
import { synthesize, BOARD_QUAD, VIDEO_W, VIDEO_H } from '../testgen/synth'
import { homography, invert3, applyH } from '../util'

interface Check { name: string; pass: boolean; detail: string }

const checks: Check[] = []
const logEl = document.getElementById('log')!
const log = (s: string) => { logEl.textContent += s + '\n'; console.log(s) }
function check(name: string, pass: boolean, detail: string) {
  checks.push({ name, pass, detail })
  log(`${pass ? '✓' : '✗'} ${name} — ${detail}`)
}

/** 提取器实际使用的板面变换（含检测误差与边框内缩）：真值归一化坐标 -> 板面像素 */
function gtToBoard(detQuad: { x: number; y: number }[]) {
  const M = boardMatrix(detQuad, VIDEO_W, VIDEO_H) // 板面UV -> 视频UV（列主序）
  const Mr = [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]] // 行主序
  const Minv = invert3(Mr) // 视频UV -> 板面UV
  const Htrue = homography(
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    BOARD_QUAD,
  )
  return (nx: number, ny: number): [number, number] => {
    const v = applyH(Htrue, nx, ny)
    const b = applyH(Minv, v.x / VIDEO_W, v.y / VIDEO_H)
    return [b.x * BW, b.y * BH]
  }
}

/** 把一页的真值笔迹画成掩膜（板面 1280×720，黑=有笔迹），坐标经过提取器同款变换 */
function gtMask(lesson: Lesson, pageIdx: number, color: PenColor | null, map: (x: number, y: number) => [number, number]): Uint8Array {
  const c = new OffscreenCanvas(BW, BH)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, BW, BH)
  ctx.strokeStyle = '#000'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const s of pageStrokes(lesson, pageIdx)) {
    if (color && s.color !== color) continue
    ctx.beginPath()
    const p0 = map(s.pts[0][0], s.pts[0][1])
    ctx.moveTo(p0[0], p0[1])
    for (const p of s.pts) {
      const q = map(p[0], p[1])
      ctx.lineTo(q[0], q[1])
    }
    ctx.lineWidth = s.width * 1000
    ctx.stroke()
  }
  const d = ctx.getImageData(0, 0, BW, BH).data
  const mask = new Uint8Array(BW * BH)
  for (let i = 0; i < BW * BH; i++) mask[i] = d[i * 4] < 128 ? 1 : 0
  return mask
}

/** 提取结果的层掩膜 → 二值 */
function extractedMask(layer: Uint8Array, channel: 0 | 1 | 2 | null): Uint8Array {
  const mask = new Uint8Array(BW * BH)
  for (let i = 0; i < BW * BH; i++) {
    if (channel === null) {
      mask[i] = layer[i * 4] > 127 || layer[i * 4 + 1] > 127 || layer[i * 4 + 2] > 127 ? 1 : 0
    } else {
      mask[i] = layer[i * 4 + channel] > 127 ? 1 : 0
    }
  }
  return mask
}

/** 3px 膨胀（线条类结构的位置容差，避免采样走样主导 IoU） */
function dilate(mask: Uint8Array, r = 3): Uint8Array {
  const out = new Uint8Array(BW * BH)
  for (let y = 0; y < BH; y++)
    for (let x = 0; x < BW; x++) {
      if (!mask[y * BW + x]) continue
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx >= 0 && xx < BW && yy >= 0 && yy < BH) out[yy * BW + xx] = 1
        }
    }
  return out
}

/** 320×180 降采样 IoU（双方先膨胀 3px） */
function iou(a0: Uint8Array, b0: Uint8Array): number {
  const a = dilate(a0), b = dilate(b0)
  const SW = 320, SH = 180, fx = BW / SW, fy = BH / SH
  let inter = 0, union = 0
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++) {
      const i = Math.floor(y * fy) * BW + Math.floor(x * fx)
      const av = a[i], bv = b[i]
      if (av && bv) inter++
      if (av || bv) union++
    }
  return union ? inter / union : 1
}

function count(mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) n += mask[i]
  return n
}

/** 真值书写热度（6×4 格）：逐根笔迹栅格化，墨迹像素 × 书写时长，与提取器口径一致 */
function gtHeat(lesson: Lesson, pageIdx: number, map: (x: number, y: number) => [number, number]): number[] {
  const prevBoundary = pageIdx === 0 ? 0 : lesson.gtPages[pageIdx - 1].boundaryT
  const boundary = lesson.gtPages[pageIdx].boundaryT
  const heat = new Array(GRID_X * GRID_Y).fill(0)
  const c = new OffscreenCanvas(BW, BH)
  const ctx = c.getContext('2d')!
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const s of lesson.strokes) {
    if (s.t0 < prevBoundary || s.t1 > boundary) continue
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, BW, BH)
    ctx.strokeStyle = '#000'
    ctx.beginPath()
    const p0 = map(s.pts[0][0], s.pts[0][1])
    ctx.moveTo(p0[0], p0[1])
    for (const p of s.pts) {
      const q = map(p[0], p[1])
      ctx.lineTo(q[0], q[1])
    }
    ctx.lineWidth = s.width * 1000
    ctx.stroke()
    const d = ctx.getImageData(0, 0, BW, BH).data
    const dur = s.t1 - s.t0
    for (let y = 0; y < BH; y += 2)
      for (let x = 0; x < BW; x += 2) {
        if (d[(y * BW + x) * 4] < 128) {
          const cell = Math.min(GRID_Y - 1, (y * GRID_Y / BH) | 0) * GRID_X + Math.min(GRID_X - 1, (x * GRID_X / BW) | 0)
          heat[cell] += dur * 4 // ×2 步长的面积补偿
        }
      }
  }
  return heat
}

function toDataURL(blob: Blob): Promise<string> {
  return new Promise(res => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.readAsDataURL(blob)
  })
}

async function main() {
  const t0 = performance.now()
  log('1/4 生成教案并合成录像…')
  const lesson = makeLesson()
  const synth = await synthesize(lesson, (d, t) => log(`  编码 ${d}/${t}`))
  check('合成录像', synth.encodedFrames === Math.round(lesson.duration * lesson.fps),
    `${synth.encodedFrames} 帧，编码耗时 ${synth.encodeSeconds.toFixed(1)}s，文件 ${(synth.blob.size / 1e6).toFixed(2)}MB`)

  log('2/4 解复用…')
  const mp4 = demuxMp4(await synth.blob.arrayBuffer())
  check('MP4 解复用', mp4.samples.length === synth.encodedFrames && Math.abs(mp4.duration - lesson.duration) < 0.5,
    `${mp4.samples.length} 样本，时长 ${mp4.duration.toFixed(2)}s，编码 ${mp4.codec}`)

  log('3/4 白板自动定位…')
  const gl = new GL()
  const det = await detectBoard(gl, mp4)
  const cornerErr = det.quad.map((p, i) => Math.hypot(p.x - BOARD_QUAD[i].x, p.y - BOARD_QUAD[i].y))
  const maxErr = Math.max(...cornerErr)
  check('白板四边定位（边框部分被挡）', maxErr < 30 && det.confidence > 0.5,
    `四角误差 [${cornerErr.map(e => e.toFixed(1)).join(', ')}]px，支撑度 ${(det.confidence * 100).toFixed(0)}%`)

  log('4/4 提取板书…')
  const { pages, elapsed } = await extractBoard(gl, mp4, det.quad, {
    debug: m => log('  [dbg] ' + m),
    onProgress: p => { if (Math.round(p.t * 2) % 20 === 0) log(`  t=${p.t.toFixed(1)}s 页数=${p.pages} 笔迹=${p.strokeCount}`) },
  })
  check('处理速度（≤2× 片长）', elapsed <= lesson.duration * 2,
    `耗时 ${elapsed.toFixed(1)}s / 片长 ${lesson.duration}s = ${(elapsed / lesson.duration).toFixed(2)}×`)

  check('页数正确', pages.length === lesson.gtPages.length,
    `提取 ${pages.length} 页 / 真值 ${lesson.gtPages.length} 页`)

  const map = gtToBoard(det.quad)
  const debugImages: { name: string; png: string }[] = []
  const n = Math.min(pages.length, lesson.gtPages.length)
  for (let i = 0; i < n; i++) {
    const p = pages[i], gt = lesson.gtPages[i]
    check(`第${i + 1}页 书写起止时间`, Math.abs(p.startT - gt.startT) <= 3.5 && Math.abs(p.endT - gt.endT) <= 3.5,
      `提取 ${p.startT.toFixed(1)}–${p.endT.toFixed(1)}s / 真值 ${gt.startT.toFixed(1)}–${gt.endT.toFixed(1)}s`)

    const gtAll = gtMask(lesson, i, null, map)
    const exAll = extractedMask(p.layer, null)
    check(`第${i + 1}页 内容一致(IoU)`, iou(gtAll, exAll) > 0.5,
      `IoU=${iou(gtAll, exAll).toFixed(3)}（真值 ${count(gtAll)}px / 提取 ${count(exAll)}px）`)

    const colors: [PenColor, 0 | 1 | 2][] = [['red', 0], ['blue', 1], ['black', 2]]
    for (const [cname, ch] of colors) {
      const gtm = gtMask(lesson, i, cname, map)
      const gtCount = count(gtm)
      const exm = extractedMask(p.layer, ch)
      const exCount = count(exm)
      if (gtCount > 500) {
        check(`第${i + 1}页 ${cname} 图层`, iou(gtm, exm) > 0.4 && exCount / gtCount > 0.4 && exCount / gtCount < 2.5,
          `IoU=${iou(gtm, exm).toFixed(3)}，像素比 ${(exCount / gtCount).toFixed(2)}`)
      } else {
        check(`第${i + 1}页 ${cname} 图层（无该色）`, exCount < 500, `误检 ${exCount}px`)
      }
    }

    const gh = gtHeat(lesson, i, map)
    const ranked = gh.map((v, idx) => [v, idx] as [number, number]).sort((a, b) => b[0] - a[0])
    const top2 = ranked.slice(0, 2).map(r => r[1])
    check(`第${i + 1}页 最热区域`, top2.includes(p.topCell),
      `提取最热格=${p.topCell}，真值前二=${top2.join(',')}`)
    log(`  [heat] 提取: ${p.heat.map(v => v.toFixed(1)).join(',')}`)
    log(`  [heat] 真值: ${gh.map(v => v.toFixed(1)).join(',')}`)

    // 调试图像：提取页 / 真值掩膜
    const pc = new OffscreenCanvas(BW, BH)
    pc.getContext('2d')!.putImageData(composePage(p, { red: true, blue: true, black: true }), 0, 0)
    const pblob = await pc.convertToBlob({ type: 'image/png' })
    debugImages.push({ name: `page${i + 1}-extracted.png`, png: await toDataURL(pblob) })
    const gc = new OffscreenCanvas(BW, BH)
    const gctx = gc.getContext('2d')!
    const gimg = gctx.createImageData(BW, BH)
    for (let px = 0; px < BW * BH; px++) {
      const v = gtAll[px] ? 0 : 255
      gimg.data[px * 4] = gimg.data[px * 4 + 1] = gimg.data[px * 4 + 2] = v
      gimg.data[px * 4 + 3] = 255
    }
    gctx.putImageData(gimg, 0, 0)
    const gblob = await gc.convertToBlob({ type: 'image/png' })
    debugImages.push({ name: `page${i + 1}-gt.png`, png: await toDataURL(gblob) })
  }
  ;(window as any).__IMAGES__ = debugImages

  // 可视化对比（调试用）
  const checksEl = document.getElementById('checks')!
  const table = document.createElement('table')
  table.innerHTML = '<tr><th>检查项</th><th>结果</th><th>细节</th></tr>'
  for (const c of checks) {
    const tr = document.createElement('tr')
    tr.innerHTML = `<td>${c.name}</td><td class="${c.pass ? 'pass' : 'fail'}">${c.pass ? 'PASS' : 'FAIL'}</td><td>${c.detail}</td>`
    table.appendChild(tr)
  }
  checksEl.appendChild(table)

  const pass = checks.every(c => c.pass)
  const total = ((performance.now() - t0) / 1000).toFixed(1)
  document.getElementById('summary')!.innerHTML =
    `<span class="${pass ? 'pass' : 'fail'}">${pass ? '全部通过' : '存在失败项'}</span> · ` +
    `${checks.filter(c => c.pass).length}/${checks.length} 项 · 总耗时 ${total}s`
  document.title = pass ? 'SELFTEST:PASS' : 'SELFTEST:FAIL'
  ;(window as any).__RESULT__ = { pass, checks, elapsed }
  ;(window as any).__DONE__ = true
}

main().catch(e => {
  log(`异常：${e?.stack ?? e}`)
  document.title = 'SELFTEST:ERROR'
  ;(window as any).__RESULT__ = { pass: false, error: String(e) }
  ;(window as any).__DONE__ = true
})
