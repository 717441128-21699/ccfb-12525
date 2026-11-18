/**
 * Multi-page PDF export. Each page shows the board snapshot with a footer
 * listing writing start/end time and the longest-written tile region.
 * Standard PDF fonts only (WinAnsi) so no font assets are required; Chinese
 * footer text would need an embedded TTF, so we render the footer into the
 * page image and add an English metadata line as selectable PDF text.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PageRecord } from '../types.js';
import { formatClock } from '../core/timefmt.js';
import { canvasToJpeg, withFooter } from './imageUtil.js';
import { pageFooterText } from '../core/paging.js';

export interface PdfExportOptions {
  includeLayers?: boolean;
}

export async function exportPdf(
  pages: PageRecord[],
  boardCanvases: HTMLCanvasElement[],
  opts: PdfExportOptions = {},
): Promise<Uint8Array> {
  if (pages.length !== boardCanvases.length) {
    throw new Error('pages and boardCanvases length mismatch');
  }
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const margin = 28;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const footer = pageFooterText(page);
    const composed = withFooter(boardCanvases[i], footer);
    const jpeg = await doc.embedJpg(await canvasToJpeg(composed, 0.92));

    const pdfPage = doc.addPage([
      composed.width + margin * 2,
      composed.height + margin * 2 + 24,
    ]);
    pdfPage.drawImage(jpeg, {
      x: margin,
      y: margin + 24,
      width: composed.width,
      height: composed.height,
    });

    // Selectable English metadata line (the Chinese footer lives in the image).
    const meta =
      `Page ${page.pageIndex + 1}/${pages.length} - ` +
      `writing ${formatClock(page.startMs)}-${formatClock(page.endMs)}, ` +
      `total ${(page.totalWritingMs / 1000).toFixed(1)}s, ` +
      `longest tile r${page.longestTile.row + 1}c${page.longestTile.col + 1} ` +
      `(${(page.longestWritingMs / 1000).toFixed(1)}s)`;
    pdfPage.drawText(meta, {
      x: margin,
      y: margin,
      size: 10,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });

    if (opts.includeLayers) {
      // Layer pages are added by the caller via appendLayerPages; kept as hook.
    }
  }

  return doc.save();
}
