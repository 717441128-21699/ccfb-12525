// 无头自测：构建产物 → vite preview → 无头 Chrome 跑 test.html → 输出结果
import { spawn } from 'node:child_process'
import puppeteer from 'puppeteer-core'

const CHROME =
  process.env.CHROME_PATH ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://localhost:5317'

async function waitForServer(url, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('服务器未就绪: ' + url)
}

const server = spawn('npx', ['vite', 'preview', '--port', '5317', '--strictPort'], {
  stdio: 'pipe',
  shell: true,
})
server.stderr.on('data', d => process.stderr.write(d))
const killServer = () => {
  try { spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { shell: true }) } catch {}
}

let browser
try {
  await waitForServer(`${BASE}/test.html`)
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 900000,
    args: ['--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('[pageerror]', e.message))
  page.on('console', m => console.log('[page]', m.text()))
  await page.goto(`${BASE}/test.html`)
  await page.waitForFunction('window.__DONE__ === true', { timeout: 900000, polling: 1000 })
  const result = await page.evaluate('window.__RESULT__')
  const images = await page.evaluate('window.__IMAGES__ ?? []')
  if (images.length) {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync('selftest-out', { recursive: true })
    for (const img of images) {
      writeFileSync(`selftest-out/${img.name}`, Buffer.from(img.png.split(',')[1], 'base64'))
    }
    console.log(`调试图像已存到 selftest-out/（${images.length} 张）`)
  }
  const title = await page.title()
  console.log('\n===== 自测结果 =====')
  console.log('title:', title)
  for (const c of result.checks ?? []) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  —  ${c.detail}`)
  }
  if (result.error) console.log('ERROR:', result.error)
  console.log('总体:', result.pass ? 'PASS' : 'FAIL')
  process.exitCode = result.pass ? 0 : 1
} finally {
  if (browser) await browser.close()
  killServer()
}
