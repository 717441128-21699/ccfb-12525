import { GL } from '../gpu/gl'
import { demuxMp4, type Mp4File } from '../mp4/mp4'
import { detectBoard } from '../pipeline/boardDetect'
import { extractBoard, BW, BH, type PageResult } from '../pipeline/extractor'
import { composePage, imageDataToPng, imageDataToJpeg, cellName } from '../pipeline/render'
import { buildPdf } from '../export/pdf'
import { buildZip } from '../export/zip'
import { makeLesson } from '../testgen/script'
import { synthesize } from '../testgen/synth'
import { downloadBlob, fmtTime, type Pt } from '../util'

interface Course {
  id: number
  name: string
  blob: Blob
  mp4: Mp4File
  quad: Pt[] | null
  confidence: number
  blend: ImageData | null
  pages: PageResult[] | null
  elapsed: number
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const gl = new GL()
const courses: Course[] = []
let selected: Course | null = null
let selectedPage = 0
let nextId = 1

// ---------- 标签页 ----------
document.querySelectorAll<HTMLButtonElement>('#tabs .tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('#tabs .tab').forEach(b => b.classList.toggle('active', b === btn))
    document.querySelectorAll('.tabpage').forEach(p => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`))
  }
})

// ---------- 课程列表 ----------
function addCourse(name: string, blob: Blob) {
  const mp4 = demuxMp4Sync(blob)
  return mp4.then(m => {
    const c: Course = { id: nextId++, name, blob, mp4: m, quad: null, confidence: 0, blend: null, pages: null, elapsed: 0 }
    courses.push(c)
    renderCourseList()
    selectCourse(c)
    return c
  })
}
async function demuxMp4Sync(blob: Blob): Promise<Mp4File> {
  return demuxMp4(await blob.arrayBuffer())
}

function renderCourseList() {
  const ul = $('courseList')
  ul.innerHTML = ''
  for (const c of courses) {
    const li = document.createElement('li')
    li.className = c === selected ? 'sel' : ''
    li.innerHTML = `<b>${c.name}</b><div class="meta">${fmtTime(c.mp4.duration)} · ${c.mp4.width}×${c.mp4.height}` +
      (c.pages ? ` · 已提取 ${c.pages.length} 页` : c.quad ? ' · 白板已定位' : '') + `</div>`
    li.onclick = () => selectCourse(c)
    ul.appendChild(li)
  }
}

function selectCourse(c: Course) {
  selected = c
  selectedPage = 0
  renderCourseList()
  drawLocate()
  renderTimeline()
  renderOutput()
  $('progressStats').textContent = c.pages
    ? `已完成：${c.pages.length} 页，耗时 ${c.elapsed.toFixed(1)}s（片长 ${c.mp4.duration.toFixed(0)}s）`
    : '尚未开始'
  $('progressBar').style.width = c.pages ? '100%' : '0%'
}

// ---------- 白板定位 ----------
const locateCanvas = $('locateCanvas') as HTMLCanvasElement
let dragIdx = -1

function drawLocate() {
  const ctx = locateCanvas.getContext('2d')!
  ctx.fillStyle = '#222'
  ctx.fillRect(0, 0, locateCanvas.width, locateCanvas.height)
  const c = selected
  if (!c) return
  if (c.blend) {
    const tmp = new OffscreenCanvas(c.blend.width, c.blend.height)
    tmp.getContext('2d')!.putImageData(c.blend, 0, 0)
    ctx.drawImage(tmp, 0, 0, locateCanvas.width, locateCanvas.height)
  }
  if (c.quad) {
    const sx = locateCanvas.width / c.mp4.width
    const sy = locateCanvas.height / c.mp4.height
    ctx.strokeStyle = '#22c55e'
    ctx.lineWidth = 2
    ctx.beginPath()
    c.quad.forEach((p, i) => (i ? ctx.lineTo(p.x * sx, p.y * sy) : ctx.moveTo(p.x * sx, p.y * sy)))
    ctx.closePath()
    ctx.stroke()
    c.quad.forEach((p, i) => {
      ctx.fillStyle = '#f59e0b'
      ctx.beginPath()
      ctx.arc(p.x * sx, p.y * sy, 7, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#000'
      ctx.font = '10px sans-serif'
      ctx.fillText(['TL', 'TR', 'BR', 'BL'][i], p.x * sx - 8, p.y * sy - 10)
    })
  }
}

locateCanvas.addEventListener('mousedown', e => {
  if (!selected?.quad) return
  const r = locateCanvas.getBoundingClientRect()
  const mx = ((e.clientX - r.left) / r.width) * locateCanvas.width
  const my = ((e.clientY - r.top) / r.height) * locateCanvas.height
  const sx = locateCanvas.width / selected.mp4.width
  const sy = locateCanvas.height / selected.mp4.height
  dragIdx = selected.quad.findIndex(p => Math.hypot(p.x * sx - mx, p.y * sy - my) < 14)
})
window.addEventListener('mousemove', e => {
  if (dragIdx < 0 || !selected?.quad) return
  const r = locateCanvas.getBoundingClientRect()
  const mx = ((e.clientX - r.left) / r.width) * locateCanvas.width
  const my = ((e.clientY - r.top) / r.height) * locateCanvas.height
  selected.quad[dragIdx] = {
    x: (mx / locateCanvas.width) * selected.mp4.width,
    y: (my / locateCanvas.height) * selected.mp4.height,
  }
  drawLocate()
})
window.addEventListener('mouseup', () => (dragIdx = -1))

async function runDetect() {
  if (!selected) return
  $('detectInfo').textContent = '检测中（取关键帧融合去人影）…'
  const res = await detectBoard(gl, selected.mp4)
  selected.quad = res.quad
  selected.confidence = res.confidence
  selected.blend = res.blend
  $('detectInfo').textContent = `检测完成，边缘支撑度 ${(res.confidence * 100).toFixed(0)}%` +
    (res.confidence < 0.5 ? '（偏低，请手动微调四角）' : '')
  drawLocate()
  renderCourseList()
}
$('btnDetect').onclick = runDetect

// ---------- 提取 ----------
$('btnConfirmQuad').onclick = async () => {
  const c = selected
  if (!c) return
  if (!c.quad) await runDetect()
  if (!c.quad) return
  document.querySelector<HTMLButtonElement>('[data-tab="progress"]')!.click()
  const live = $('liveCanvas') as HTMLCanvasElement
  const lctx = live.getContext('2d')!
  const tmp = new OffscreenCanvas(BW, BH)
  const tctx = tmp.getContext('2d')!
  const showPerson = () => ($('chkShowPerson') as HTMLInputElement).checked

  const t0 = performance.now()
  const { pages, elapsed } = await extractBoard(gl, c.mp4, c.quad!, {
    onProgress: p => {
      $('progressBar').style.width = `${((p.t / p.duration) * 100).toFixed(1)}%`
      $('progressStats').textContent =
        `解码到 ${fmtTime(p.t)} / ${fmtTime(p.duration)} · 已存 ${p.pages} 页 · ` +
        `当前笔迹 ${(p.strokeCount / 1000).toFixed(1)}k px · 人体遮挡 ${(p.personRatio * 100).toFixed(1)}%`
    },
    onSample: (_t, state, metrics) => {
      const img = new ImageData(new Uint8ClampedArray(state.buffer.slice(0) as ArrayBuffer), BW, BH)
      if (showPerson()) {
        for (let i = 0; i < BW * BH; i++) {
          if (metrics[i * 4 + 2] > 127) {
            img.data[i * 4] = 255
            img.data[i * 4 + 1] = 80
            img.data[i * 4 + 2] = 200
          }
        }
      }
      tctx.putImageData(img, 0, 0)
      lctx.drawImage(tmp, 0, 0, live.width, live.height)
    },
  })
  c.pages = pages
  c.elapsed = elapsed
  $('progressStats').textContent =
    `完成：${pages.length} 页，耗时 ${elapsed.toFixed(1)}s（片长 ${c.mp4.duration.toFixed(0)}s，${(elapsed / c.mp4.duration).toFixed(2)}×）`
  renderCourseList()
  renderTimeline()
  renderOutput()
  document.querySelector<HTMLButtonElement>('[data-tab="timeline"]')!.click()
}

// ---------- 时间线 ----------
function renderTimeline() {
  const tl = $('timeline')
  tl.innerHTML = ''
  const c = selected
  if (!c?.pages?.length) {
    tl.innerHTML = '<p class="muted" style="padding:12px">还没有提取结果</p>'
    return
  }
  const dur = c.mp4.duration
  const width = Math.max(tl.clientWidth, dur * 14)
  tl.style.minWidth = `${width}px`
  for (let s = 0; s <= dur; s += 60) {
    const tick = document.createElement('div')
    tick.className = 'tlAxis'
    tick.style.left = `${(s / dur) * 100}%`
    tick.textContent = fmtTime(s)
    tl.appendChild(tick)
  }
  c.pages.forEach((p, i) => {
    const div = document.createElement('div')
    div.className = 'tlPage' + (i === selectedPage ? ' sel' : '')
    div.style.left = `${(p.wallStartT / dur) * 100}%`
    div.style.width = `${Math.max(4, ((p.wallEndT - p.wallStartT) / dur) * 100)}%`
    const img = document.createElement('img')
    composeThumb(p).then(url => (img.src = url))
    div.appendChild(img)
    const label = document.createElement('span')
    label.textContent = `第${i + 1}页 ${fmtTime(p.startT)}–${fmtTime(p.endT)}`
    div.appendChild(label)
    div.onclick = () => { selectedPage = i; renderTimeline(); renderOutput() }
    tl.appendChild(div)
  })
}

const thumbCache = new WeakMap<PageResult, string>()
async function composeThumb(p: PageResult): Promise<string> {
  let url = thumbCache.get(p)
  if (!url) {
    const blob = await imageDataToPng(composePage(p, { red: true, blue: true, black: true }))
    url = URL.createObjectURL(blob)
    thumbCache.set(p, url)
  }
  return url
}

// ---------- 成果 ----------
function renderOutput() {
  const c = selected
  const info = $('pageInfo')
  const canvas = $('pageCanvas') as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const thumbs = $('pageThumbs')
  thumbs.innerHTML = ''
  if (!c?.pages?.length) {
    info.textContent = '还没有提取结果'
    return
  }
  const p = c.pages[Math.min(selectedPage, c.pages.length - 1)]
  const show = {
    red: ($('layRed') as HTMLInputElement).checked,
    blue: ($('layBlue') as HTMLInputElement).checked,
    black: ($('layBlack') as HTMLInputElement).checked,
  }
  const heat = ($('layHeat') as HTMLInputElement).checked
  ctx.putImageData(composePage(p, show, heat), 0, 0)
  info.textContent =
    `第 ${p.index + 1} 页 · 书写时间 ${fmtTime(p.startT)} – ${fmtTime(p.endT)} · ` +
    `写得最久的区域：${cellName(p.topCell)}（墨迹时长 ${(p.heat[p.topCell] / 1000).toFixed(1)}k px·s）· 峰值笔迹 ${(p.peakStrokes / 1000).toFixed(1)}k px`
  c.pages.forEach((pg, i) => {
    const d = document.createElement('div')
    d.className = 'thumb' + (i === selectedPage ? ' sel' : '')
    const img = document.createElement('img')
    composeThumb(pg).then(url => (img.src = url))
    const t = document.createElement('div')
    t.className = 't'
    t.textContent = `第${i + 1}页 ${fmtTime(pg.startT)}–${fmtTime(pg.endT)}`
    d.appendChild(img)
    d.appendChild(t)
    d.onclick = () => { selectedPage = i; renderOutput(); renderTimeline() }
    thumbs.appendChild(d)
  })
}
;['layRed', 'layBlue', 'layBlack', 'layHeat'].forEach(id => {
  $(id).addEventListener('change', renderOutput)
})

$('btnPdf').onclick = async () => {
  const c = selected
  if (!c?.pages?.length) return
  const pages = []
  for (const p of c.pages) {
    const img = composePage(p, { red: true, blue: true, black: true })
    pages.push({
      jpeg: await imageDataToJpeg(img),
      width: BW,
      height: BH,
      caption: `Page ${p.index + 1}  ${fmtTime(p.startT)} - ${fmtTime(p.endT)}`,
    })
  }
  downloadBlob(buildPdf(pages), `${c.name}-板书.pdf`)
}

$('btnZip').onclick = async () => {
  const c = selected
  if (!c?.pages?.length) return
  const entries = []
  for (const p of c.pages) {
    const img = composePage(p, { red: true, blue: true, black: true })
    const blob = await imageDataToPng(img)
    entries.push({ name: `page-${String(p.index + 1).padStart(2, '0')}.png`, data: new Uint8Array(await blob.arrayBuffer()) })
  }
  downloadBlob(buildZip(entries), `${c.name}-板书.zip`)
}

$('btnPng').onclick = async () => {
  const c = selected
  if (!c?.pages?.length) return
  const p = c.pages[selectedPage]
  const blob = await imageDataToPng(composePage(p, { red: true, blue: true, black: true }))
  downloadBlob(blob, `第${p.index + 1}页.png`)
}

// ---------- 入口按钮 ----------
$('btnAddFile').onclick = () => ($('fileInput') as HTMLInputElement).click()
$('fileInput').addEventListener('change', async e => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  try {
    await addCourse(f.name.replace(/\.[^.]+$/, ''), f)
  } catch (err) {
    alert(`解析失败：${err}`)
  }
})

$('btnSynth').onclick = async () => {
  const btn = $('btnSynth') as HTMLButtonElement
  btn.disabled = true
  try {
    const lesson = makeLesson()
    const { blob } = await synthesize(lesson, (done, total) => {
      $('synthStatus').textContent = `合成录像中 ${done}/${total} 帧…`
    })
    $('synthStatus').textContent = ''
    await addCourse('演示课程（合成）', blob)
  } catch (err) {
    $('synthStatus').textContent = `合成失败：${err}`
  } finally {
    btn.disabled = false
  }
}
