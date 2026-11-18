/**
 * Node-side E2E runner: starts the Vite dev server, drives the installed
 * Chrome via puppeteer-core (with GPU + WebGL2/WebCodecs enabled), opens the
 * self-test page and waits for window.__E2E_RESULT__.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findBrowser(): string {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('No Chrome/Edge executable found; set CHROME_PATH to override.');
}

async function main() {
  const server = await createServer({
    root,
    configFile: join(root, 'vite.config.ts'),
    server: { port: 0, strictPort: false },
    logLevel: 'warn',
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 5317;
  const url = `http://localhost:${port}/tests/browser/index.html`;

  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    args: [
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-features=WebCodecs',
      '--window-size=1400,1000',
    ],
    dumpio: false,
  });

  let exitCode = 1;
  try {
    const page = await browser.newPage();
    const consoleMessages: string[] = [];
    page.on('console', (m) => consoleMessages.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => consoleMessages.push(`[pageerror] ${e.stack}`));
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });

    const handle = await page.waitForFunction(
      () => (window as unknown as { __E2E_RESULT__?: unknown }).__E2E_RESULT__,
      { timeout: 120000, polling: 500 },
    );
    const raw = await page.evaluate(() =>
      JSON.parse(JSON.stringify((window as unknown as { __E2E_RESULT__: unknown }).__E2E_RESULT__)),
    );
    const data = raw as {
      passed: boolean;
      checks?: { name: string; pass: boolean; detail: string }[];
      fatal?: string;
      stats?: Record<string, unknown>;
      pageCount?: number;
    };
    void handle;

    console.log('\n--- browser console ---');
    console.log(consoleMessages.join('\n'));
    console.log('--- end console ---\n');

    if (!data.checks) {
      console.error('Result missing checks:', JSON.stringify(data).slice(0, 2000));
      process.exit(1);
    }

    for (const c of data.checks) {
      console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
    }
    if (data.fatal) console.error(`FATAL: ${data.fatal}`);
    console.log('\nStats:', JSON.stringify(data.stats, null, 2));
    console.log(`Pages: ${data.pageCount}`);

    await mkdir(join(root, 'out'), { recursive: true });
    await writeFile(join(root, 'out', 'e2e-result.json'), JSON.stringify(data, null, 2));
    await page.screenshot({ path: join(root, 'out', 'e2e-page.png'), fullPage: true });

    exitCode = data.passed ? 0 : 1;
    if (!data.passed) {
      console.error('One or more checks failed (see console log above).');
    }
  } finally {
    await browser.close();
    await server.close();
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
