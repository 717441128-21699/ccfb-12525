/**
 * ZIP package: per-page full-board PNG plus separated red/blue/black layer
 * PNGs and a machine-readable manifest with timing data.
 */
import JSZip from 'jszip';
import type { InkLayerName, PageRecord } from '../types.js';
import { INK_LAYERS } from '../core/color.js';
import { canvasToPng, withFooter } from './imageUtil.js';
import { pageFooterText } from '../core/paging.js';

export interface ZipPageInput {
  record: PageRecord;
  board: HTMLCanvasElement;
  layers: Record<InkLayerName, HTMLCanvasElement>;
}

export async function exportZip(pages: ZipPageInput[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const manifest = pages.map((p) => ({
    page: p.record.pageIndex + 1,
    startMs: p.record.startMs,
    endMs: p.record.endMs,
    totalWritingMs: p.record.totalWritingMs,
    longestTile: {
      row: p.record.longestTile.row + 1,
      col: p.record.longestTile.col + 1,
      rect: p.record.longestTile,
    },
    longestWritingMs: p.record.longestWritingMs,
    tileWritingMs: Array.from(p.record.tileWritingMs),
    addEvents: p.record.addEvents,
    eraseEvents: p.record.eraseEvents,
    footer: pageFooterText(p.record),
    files: {
      board: `pages/page-${p.record.pageIndex + 1}/board.png`,
      red: `pages/page-${p.record.pageIndex + 1}/layer-red.png`,
      blue: `pages/page-${p.record.pageIndex + 1}/layer-blue.png`,
      black: `pages/page-${p.record.pageIndex + 1}/layer-black.png`,
    },
  }));

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  for (const p of pages) {
    const dir = zip.folder(`pages/page-${p.record.pageIndex + 1}`)!;
    const composed = withFooter(p.board, pageFooterText(p.record));
    dir.file('board.png', await canvasToPng(composed));
    for (const layer of INK_LAYERS) {
      dir.file(`layer-${layer}.png`, await canvasToPng(p.layers[layer]));
    }
  }

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
