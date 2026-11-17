// 主界面冒烟测试：合成课程 → 自动定位 → 提取 → 时间线/成果/导出
import { spawn } from 'node:child_process'
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://localhost:5318'

async function waitForServer(url, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('服务器未就绪: ' + url)
}

const server = spawn('npx', ['vite', 'preview', '--port', '5318', '--strictPort'], { stdio: 'pipe', shell: true })
const killServer = () => { try { spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { shell: true }) } catch {} }

let browser
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails.push(name)
}
try {
  await waitForServer(`${BASE}/index.html`)
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 600000,
    args: ['--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('[pageerror]', e.message))
  await page.goto(`${BASE}/index.html`)

  // 生成演示课程
  await page.click('#btnSynth')
  await page.waitForFunction(
    `document.querySelector('#courseList li') && document.querySelector('#courseList li').textContent.includes('演示课程')`,
    { timeout: 180000, polling: 500 })
  check('合成演示课程', true)

  // 自动检测白板
  await page.click('#btnDetect')
  await page.waitForFunction(`document.querySelector('#detectInfo').textContent.includes('检测完成')`, { timeout: 120000, polling: 500 })
  const detInfo = await page.$eval('#detectInfo', el => el.textContent)
  check('白板自动定位', detInfo.includes('检测完成'), detInfo)

  // 确认并开始提取
  await page.click('#btnConfirmQuad')
  await page.waitForFunction(`document.querySelector('#progressStats').textContent.includes('完成')`, { timeout: 300000, polling: 1000 })
  const stats = await page.$eval('#progressStats', el => el.textContent)
  check('提取完成', stats.includes('3 页'), stats)

  // 时间线
  const tlCount = await page.$$eval('#timeline .tlPage', els => els.length)
  check('时间线 3 段', tlCount === 3, `${tlCount} 段`)

  // 切到成果页，选第 1 页
  await page.click('[data-tab="output"]')
  await page.waitForFunction(`document.querySelector('#pageInfo').textContent.includes('第 1 页')`, { timeout: 10000, polling: 200 })
  const info = await page.$eval('#pageInfo', el => el.textContent)
  check('页信息（起止时间+最热区域）', info.includes('书写时间') && info.includes('写得最久的区域'), info)

  // 图层开关：只开红笔，画布应变化
  const before = await page.$eval('#pageCanvas', c => c.toDataURL().length)
  await page.click('#layBlue'); await page.click('#layBlack')
  await new Promise(r => setTimeout(r, 300))
  const after = await page.$eval('#pageCanvas', c => c.toDataURL().length)
  check('图层开关生效', before !== after, `${before} -> ${after}`)

  // 导出（不验证文件内容，只验证不抛异常）
  await page.click('#layBlue'); await page.click('#layBlack')
  await page.click('#btnPdf')
  await page.click('#btnZip')
  await page.click('#btnPng')
  await new Promise(r => setTimeout(r, 2000))
  check('PDF/ZIP/PNG 导出无异常', true)

  console.log(fails.length ? `\n冒烟测试失败 ${fails.length} 项` : '\n冒烟测试全部通过')
  process.exitCode = fails.length ? 1 : 0
} catch (e) {
  console.log('ERROR:', e.message)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  killServer()
}
