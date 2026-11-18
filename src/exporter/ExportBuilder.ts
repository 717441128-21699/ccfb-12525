import type { ExtractionResult } from '../extractor.js';
import type { InkLayerName, PageRecord } from '../types.js';
import { exportPdf } from './pdfExporter.js';
import { exportZip, type ZipPageInput } from './zipExporter.js';
import { renderAllLayers } from './layerRender.js';

/**
 * Build per-page canvas outputs (full board + separated ink layers) from the
 * stored page snapshots, then run the requested exporters. Snapshots are
 * mandatory: they preserve each finalized page even though the live GL board
 * texture only holds the latest state.
 */
export class ExportBuilder {
  constructor(private result: ExtractionResult) {}

  private pageCanvases(): {
    record: PageRecord;
    board: HTMLCanvasElement;
    layers: Record<InkLayerName, HTMLCanvasElement>;
  }[] {
    const { pages } = this.result;
    return pages.map((record) => {
      const board = this.snapshotCanvas(record);
      const layers = renderAllLayers(board, board.width, board.height);
      return { record, board, layers };
    });
  }

  private snapshotCanvas(record: PageRecord): HTMLCanvasElement {
    const bmp = record.snapshot;
    if (!bmp) throw new Error(`Page ${record.pageIndex + 1} has no stored snapshot`);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    return canvas;
  }

  async pdf(): Promise<Uint8Array> {
    const items = this.pageCanvases();
    return exportPdf(
      items.map((x) => x.record),
      items.map((x) => x.board),
    );
  }

  async zip(): Promise<Uint8Array> {
    const items: ZipPageInput[] = this.pageCanvases();
    return exportZip(items);
  }
}
