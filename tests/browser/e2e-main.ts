/**
 * Browser-side end-to-end self-test. Renders the synthetic teacher+whiteboard
 * scene, runs the full extractor over it, and asserts every headline
 * requirement: page count/content, quad detection, person occlusion timing,
 * white-shirt handling, color layer separation, timing footer and exports.
 *
 * Results are posted on window.__E2E_RESULT__ for the puppeteer runner.
 */
import { WhiteboardExtractor } from '../../src/extractor.js';
import { SyntheticFrameSource } from '../../src/video/synthetic.js';
import { ExportBuilder } from '../../src/exporter/ExportBuilder.js';
import { countInkPixels, renderAllLayers } from '../../src/exporter/layerRender.js';
import { classifyRGB } from '../../src/core/color.js';
import { dist } from '../../src/core/geometry.js';
import { pageFooterText } from '../../src/core/paging.js';

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

function log(msg: string) {
  const el = document.getElementById('log');
  if (el) el.textContent += `\n${msg}`;
  // Also surface on console for interactive debugging.
  // eslint-disable-next-line no-console
  console.log(msg);
}

function assert(cond: boolean, name: string, detail: string, checks: CheckResult[]) {
  checks.push({ name, pass: !!cond, detail });
  log(`${cond ? 'PASS' : 'FAIL'} - ${name}: ${detail}`);
}

async function main() {
  const checks: CheckResult[] = [];
  const source = new SyntheticFrameSource({ fps: 10, width: 1280, height: 720 });
  const gt = source.groundTruth;

  const extractor = new WhiteboardExtractor({
    // Tight, deterministic cadence for the 140-frame synthetic clip.
    stableFrames: 2,
    detectInterval: 10,
    frameStride: 1,
    motionThreshold: 14,
    bgDiffThreshold: 32,
    changeThreshold: 22,
    eraseNewPageRatio: 0.2,
  });

  const result = await extractor.run(source);
  const { pages, stats, quads } = result;

  // ---- 1. Page count matches the scripted two-page scenario.
  assert(
    pages.length === gt.expectedPageCount,
    'page count',
    `got ${pages.length}, expected ${gt.expectedPageCount}`,
    checks,
  );

  // ---- 2. Board quad detection: corners close to ground truth.
  if (quads.length) {
    const q = quads[quads.length - 1];
    const meanCorner = gt.boardQuad.reduce((s, p, i) => s + dist(p, q[i]), 0) / 4;
    assert(
      meanCorner < 28,
      'quad localization (occluded border)',
      `mean corner error ${meanCorner.toFixed(1)}px`,
      checks,
    );
  } else {
    assert(false, 'quad localization (occluded border)', 'no quad detected', checks);
  }
  assert(stats.detectionFailures <= stats.detectedQuads, 'detector stability',
    `detections=${stats.detectedQuads} failures=${stats.detectionFailures}`, checks);

  // ---- 3. Page 1 snapshot contains the scripted red/blue/black content.
  if (pages.length >= 1) {
    const p1 = pages[0];
    const bmp = p1.snapshot!;
    const counts1 = countInkPixels(bmp, bmp.width, bmp.height);
    assert(counts1.red > 50, 'page1 red ink present', `red px=${counts1.red}`, checks);
    assert(counts1.blue > 50, 'page1 blue ink present', `blue px=${counts1.blue}`, checks);
    assert(counts1.black > 50, 'page1 black ink present', `black px=${counts1.black}`, checks);

    // Writing window overlaps the scripted stroke interval for page 1.
    const expectedStartSec = 6 / gt.fps;
    assert(
      Math.abs(p1.startMs / 1000 - expectedStartSec) < 2.5,
      'page1 writing start time',
      `start=${(p1.startMs / 1000).toFixed(2)}s expected≈${expectedStartSec}s`,
      checks,
    );
    assert(p1.totalWritingMs > 0, 'page1 accumulated writing time',
      `${(p1.totalWritingMs / 1000).toFixed(2)}s`, checks);
    assert(p1.longestWritingMs > 0, 'page1 longest-tile region recorded',
      `r${p1.longestTile.row + 1}c${p1.longestTile.col + 1} ${(p1.longestWritingMs / 1000).toFixed(2)}s`,
      checks);
  } else {
    assert(false, 'page1 content', 'no page 1', checks);
  }

  // ---- 4. Page 2 exists and differs (rewrite after erase).
  if (pages.length >= 2) {
    const p2 = pages[1];
    const bmp2 = p2.snapshot!;
    const counts2 = countInkPixels(bmp2, bmp2.width, bmp2.height);
    assert(counts2.red > 50, 'page2 rewritten content present',
      `red=${counts2.red} blue=${counts2.blue} black=${counts2.black}`, checks);
    // The boundary must sit near the scripted erase frame.
    const boundarySec = gt.eraseBoundaryFrame / gt.fps;
    assert(
      Math.abs(p2.startMs / 1000 - boundarySec) < 3,
      'erase triggers a new page at the right time',
      `page2 start=${(p2.startMs / 1000).toFixed(2)}s erase≈${boundarySec}s`,
      checks,
    );
    // Page 1 ends before page 2 starts.
    assert(pages[0].endMs <= pages[1].startMs + 50, 'page ordering',
      `p1 end=${pages[0].endMs}ms p2 start=${pages[1].startMs}ms`, checks);
  } else {
    assert(false, 'page2 rewrite', 'no page 2', checks);
  }

  // ---- 5. White shirt is never classified as ink.
  const shirt = classifyRGB(244, 244, 242);
  assert(shirt === 'white', 'white shirt not treated as ink/board background',
    `classifyRGB(244,244,242)=${shirt}`, checks);

  // ---- 6. Person was actually detected during the occluding phases.
  assert(
    stats.personFrameRatio > 0.25,
    'teacher silhouette detected while teaching',
    `person frame ratio=${stats.personFrameRatio.toFixed(2)}`,
    checks,
  );

  // ---- 7. Layer separation produces three non-empty, mostly-disjoint layers.
  if (pages[0].snapshot) {
    const layers = renderAllLayers(pages[0].snapshot, pages[0].snapshot.width, pages[0].snapshot.height);
    const lc = {
      red: countInkPixels(layers.red, layers.red.width, layers.red.height),
      blue: countInkPixels(layers.blue, layers.blue.width, layers.blue.height),
      black: countInkPixels(layers.black, layers.black.width, layers.black.height),
    };
    assert(lc.red.red > 50 && lc.red.blue === 0 && lc.red.black === 0,
      'red layer isolated', JSON.stringify(lc.red), checks);
    assert(lc.blue.blue > 50 && lc.blue.red === 0 && lc.blue.black === 0,
      'blue layer isolated', JSON.stringify(lc.blue), checks);
    assert(lc.black.black > 50 && lc.black.red === 0 && lc.black.blue === 0,
      'black layer isolated', JSON.stringify(lc.black), checks);
  }

  // ---- 8. Footer text carries timing + longest region.
  const footer = pageFooterText(pages[0]);
  assert(/书写\s\d{2}:\d{2}\.\d/.test(footer) && /最久区域/.test(footer),
    'footer lists time range and longest region', footer, checks);

  // ---- 9. Exports: PDF bytes and ZIP bytes.
  const builder = new ExportBuilder(result);
  const pdf = await builder.pdf();
  assert(pdf.byteLength > 1000 && pdf[0] === 0x25 && pdf[1] === 0x50,
    'multi-page PDF exported', `${pdf.byteLength} bytes, header=%PDF`, checks);
  const zip = await builder.zip();
  // ZIP local file header signature "PK\x03\x04".
  assert(zip.byteLength > 1000 && zip[0] === 0x50 && zip[1] === 0x4b,
    'image/layer ZIP exported', `${zip.byteLength} bytes, header=PK`, checks);

  // ---- 10. Performance: processing faster than 2x video duration budget.
  const factor = stats.realtimeFactor;
  assert(factor < 2, 'finishes within the 2x-duration budget',
    `wall/video=${factor.toFixed(2)} (video ${(stats.videoMs / 1000).toFixed(1)}s, ` +
    `wall ${(stats.wallMs / 1000).toFixed(1)}s)`, checks);

  const passed = checks.every((c) => c.pass);
  const summary = {
    passed,
    checks,
    stats: {
      ...stats,
      wallMs: Math.round(stats.wallMs),
      realtimeFactor: Number(factor.toFixed(3)),
    },
    pageCount: pages.length,
  };
  (window as unknown as { __E2E_RESULT__: unknown }).__E2E_RESULT__ = summary;
  log(`\n== ${checks.filter((c) => c.pass).length}/${checks.length} checks passed ==`);
  if (!passed) {
    const failed = checks.filter((c) => !c.pass).map((c) => c.name);
    log(`FAILED: ${failed.join(', ')}`);
  }
}

main().catch((err) => {
  log(`FATAL: ${err?.stack ?? err}`);
  (window as unknown as { __E2E_RESULT__: unknown }).__E2E_RESULT__ = {
    passed: false,
    fatal: String(err?.stack ?? err),
    checks: [],
  };
});
