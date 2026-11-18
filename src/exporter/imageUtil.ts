/** Shared canvas -> PNG bytes helper. */
export async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG encoding failed');
  return new Uint8Array(await blob.arrayBuffer());
}

export async function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.92): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  );
  if (!blob) throw new Error('JPEG encoding failed');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Draw footer text under a board snapshot, returning a new canvas. */
export function withFooter(
  board: HTMLCanvasElement,
  footer: string,
  opts: { bg?: string; fg?: string; footerHeight?: number } = {},
): HTMLCanvasElement {
  const footerHeight = opts.footerHeight ?? 64;
  const out = document.createElement('canvas');
  out.width = board.width;
  out.height = board.height + footerHeight;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = opts.bg ?? '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(board, 0, 0);
  ctx.fillStyle = opts.fg ?? '#222222';
  ctx.font = `${Math.round(footerHeight * 0.42)}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(footer, 24, board.height + footerHeight / 2);
  return out;
}
