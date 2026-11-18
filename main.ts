/**
 * Browser UI: file -> Mp4FrameSource (or SyntheticFrameSource for the demo)
 * -> WhiteboardExtractor -> page preview with layer tabs -> PDF/ZIP export.
 */
import { WhiteboardExtractor, type ExtractionResult, type FrameSource } from './src/extractor.js';
import { Mp4FrameSource } from './src/video/mp4Decoder.js';
import { SyntheticFrameSource } from './src/video/synthetic.js';
import { ExportBuilder } from './src/exporter/ExportBuilder.js';
import { pageFooterText } from './src/core/paging.js';
import type { InkLayerName, PageRecord } from './src/types.js';
import { INK_LAYERS } from './src/core/color.js';
import { renderLayer } from './src/exporter/layerRender.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const fileInput = $<HTMLInputElement>('file');
const demoBtn = $<HTMLButtonElement>('demo');
const pdfBtn = $<HTMLButtonElement>('pdf');
const zipBtn = $<HTMLButtonElement>('zip');
const progress = $<HTMLDivElement>('progress');
const progressBar = progress.firstElementChild as HTMLDivElement;
const statsEl = $<HTMLDivElement>('stats');
const pagesEl = $<HTMLDivElement>('pages');
const logEl = $<HTMLDivElement>('log');
const hint = $<HTMLSpanElement>('hint');

let lastResult: ExtractionResult | null = null;

function log(msg: string) {
  logEl.style.display = 'block';
  logEl.textContent += `${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(pct: number) {
  progress.classList.add('show');
  progressBar.style.width = `${Math.round(pct * 100)}%`;
}

function download(bytes: Uint8Array, filename: string, mime: string) {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function snapshotCanvas(record: PageRecord): HTMLCanvasElement {
  const bmp = record.snapshot;
  if (!bmp) throw new Error('页面缺少板书快照');
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0);
  return canvas;
}

function renderPages(result: ExtractionResult) {
  pagesEl.innerHTML = '';
  for (const record of result.pages) {
    const board = snapshotCanvas(record);
    const card = document.createElement('div');
    card.className = 'card';

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const view = document.createElement('canvas');
    view.width = board.width;
    view.height = board.height;
    thumb.appendChild(view);
    const vctx = view.getContext('2d')!;
    vctx.drawImage(board, 0, 0);

    const tabs = document.createElement('div');
    tabs.className = 'layer-tabs';
    const showLayer = (name: InkLayerName | 'all') => {
      vctx.clearRect(0, 0, view.width, view.height);
      if (name === 'all') {
        vctx.drawImage(board, 0, 0);
      } else {
        const layer = renderLayer(board, board.width, board.height, name);
        vctx.drawImage(layer, 0, 0);
      }
      for (const b of tabs.querySelectorAll('button')) {
        b.classList.toggle('active', b.dataset.layer === name);
      }
    };
    const allBtn = document.createElement('button');
    allBtn.textContent = '全部';
    allBtn.dataset.layer = 'all';
    allBtn.onclick = () => showLayer('all');
    tabs.appendChild(allBtn);
    for (const name of INK_LAYERS) {
      const b = document.createElement('button');
      b.textContent = name === 'red' ? '红' : name === 'blue' ? '蓝' : '黑';
      b.dataset.layer = name;
      b.onclick = () => showLayer(name);
      tabs.appendChild(b);
    }
    allBtn.classList.add('active');

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML =
      `<div><b>第 ${record.pageIndex + 1} 页</b></div>` +
      `<div class="footer">${pageFooterText(record)}</div>`;

    card.appendChild(thumb);
    card.appendChild(tabs);
    card.appendChild(meta);
    pagesEl.appendChild(card);
  }
}

function renderStats(result: ExtractionResult) {
  const s = result.stats;
  const items: [string, string][] = [
    ['提取页数', `${result.pages.length}`],
    ['处理帧数', `${s.framesProcessed}`],
    ['处理/视频时长比', s.realtimeFactor.toFixed(2)],
    ['人物出现帧占比', `${(s.personFrameRatio * 100).toFixed(0)}%`],
    ['白板检测次数', `${s.detectedQuads}`],
    ['耗时', `${(s.wallMs / 1000).toFixed(1)}s`],
  ];
  statsEl.innerHTML = items
    .map(([label, value]) => `<div class="stat"><label>${label}</label><b>${value}</b></div>`)
    .join('');
}

async function run(source: FrameSource) {
  pdfBtn.disabled = true;
  zipBtn.disabled = true;
  pagesEl.innerHTML = '';
  statsEl.innerHTML = '';
  setProgress(0.05);
  hint.textContent = '正在分析视频…';
  try {
    const extractor = new WhiteboardExtractor();
    let seen = 0;
    extractor.onStats = () => {
      seen++;
      // Frames are processed quickly; advance the bar without overshooting.
      setProgress(0.1 + Math.min(0.85, seen / 600));
    };
    const result = await extractor.run(source);
    lastResult = result;
    setProgress(1);
    renderStats(result);
    renderPages(result);
    pdfBtn.disabled = false;
    zipBtn.disabled = false;
    hint.textContent = `完成：识别 ${result.pages.length} 页板书。`;
    log(`实时性 wall/video=${result.stats.realtimeFactor.toFixed(2)}（要求 <2）`);
  } catch (e) {
    hint.textContent = '分析失败';
    log(`错误: ${(e as Error)?.stack ?? e}`);
  }
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  log(`读取文件 ${file.name} (${(file.size / 1e6).toFixed(1)} MB)`);
  const buffer = await file.arrayBuffer();
  const source = await Mp4FrameSource.create(buffer);
  await run(source);
});

demoBtn.addEventListener('click', () => {
  log('启动合成虚拟老师+白板测试片…');
  void run(new SyntheticFrameSource());
});

pdfBtn.addEventListener('click', async () => {
  if (!lastResult) return;
  const bytes = await new ExportBuilder(lastResult).pdf();
  download(bytes, 'whiteboard-pages.pdf', 'application/pdf');
});

zipBtn.addEventListener('click', async () => {
  if (!lastResult) return;
  const bytes = await new ExportBuilder(lastResult).zip();
  download(bytes, 'whiteboard-pages.zip', 'application/zip');
});
