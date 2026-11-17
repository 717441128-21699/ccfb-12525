import { BW, BH, GRID_X, GRID_Y, type PageResult } from './extractor'

export interface LayerShow { red: boolean; blue: boolean; black: boolean }

/** 合成页面图像：白板底 + 选中的笔迹图层，可叠加书写热度 */
export function composePage(page: PageResult, show: LayerShow, showHeat = false): ImageData {
  const out = new Uint8ClampedArray(BW * BH * 4)
  const { state, layer } = page
  for (let i = 0; i < BW * BH; i++) {
    const l = layer[i * 4]
    const g = layer[i * 4 + 1]
    const b = layer[i * 4 + 2]
    const visible =
      (l > 127 && show.red) || (g > 127 && show.blue) || (b > 127 && show.black)
    if (visible) {
      out[i * 4] = state[i * 4]
      out[i * 4 + 1] = state[i * 4 + 1]
      out[i * 4 + 2] = state[i * 4 + 2]
    } else {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255
    }
    out[i * 4 + 3] = 255
  }
  if (showHeat) {
    const max = Math.max(1e-9, ...page.heat)
    const cw = BW / GRID_X, ch = BH / GRID_Y
    for (let cy = 0; cy < GRID_Y; cy++)
      for (let cx = 0; cx < GRID_X; cx++) {
        const a = (page.heat[cy * GRID_X + cx] / max) * 0.35
        if (a < 0.02) continue
        for (let y = Math.floor(cy * ch); y < (cy + 1) * ch; y++)
          for (let x = Math.floor(cx * cw); x < (cx + 1) * cw; x++) {
            const i = (y * BW + x) * 4
            out[i] = out[i] * (1 - a) + 255 * a
            out[i + 1] = out[i + 1] * (1 - a) + 140 * a
            out[i + 2] = out[i + 2] * (1 - a) + 0 * a
          }
      }
  }
  return new ImageData(out, BW, BH)
}

export function imageDataToPng(img: ImageData): Promise<Blob> {
  const c = new OffscreenCanvas(img.width, img.height)
  c.getContext('2d')!.putImageData(img, 0, 0)
  return c.convertToBlob({ type: 'image/png' })
}

export async function imageDataToJpeg(img: ImageData, quality = 0.9): Promise<Uint8Array> {
  const c = new OffscreenCanvas(img.width, img.height)
  c.getContext('2d')!.putImageData(img, 0, 0)
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality })
  return new Uint8Array(await blob.arrayBuffer())
}

const CELL_NAMES = ['左上', '中上', '右上']
/** 6×4 热度格的中文方位名 */
export function cellName(idx: number): string {
  const cx = idx % GRID_X, cy = Math.floor(idx / GRID_X)
  const v = ['上', '中上', '中下', '下'][cy] ?? ''
  const h = ['最左', '左', '左中', '右中', '右', '最右'][cx] ?? ''
  return `${h}${v}区`
}
