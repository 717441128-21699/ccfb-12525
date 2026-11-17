/** 极简多页 PDF：每页一张 JPEG + 一行页脚文字（Helvetica 标准字体，无需嵌入） */
export interface PdfPage {
  jpeg: Uint8Array
  width: number
  height: number
  caption?: string
}

export function buildPdf(pages: PdfPage[]): Blob {
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let len = 0
  const push = (data: Uint8Array | string) => {
    const u8 = typeof data === 'string' ? new TextEncoder().encode(data) : data
    chunks.push(u8)
    len += u8.length
  }
  const obj = (n: number, body: string | Uint8Array) => {
    offsets[n] = len
    push(`${n} 0 obj\n`)
    push(body as string)
    push(`\nendobj\n`)
  }

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  const nPages = pages.length
  const fontObj = 3 + nPages * 3
  // 页面对象号从 3 开始，每页 3 个对象（page, image, contents）
  obj(1, `<< /Type /Catalog /Pages 2 0 R >>`)
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${nPages} >>`)

  pages.forEach((p, i) => {
    const pageN = 3 + i * 3
    const imgN = pageN + 1
    const contN = pageN + 2
    // 页面尺寸：保持图像比例，宽 960pt
    const w = 960, h = Math.round((960 * p.height) / p.width)
    obj(pageN, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
      `/Resources << /XObject << /Im${i} ${imgN} 0 R >> /Font << /F1 ${fontObj} 0 R >> /ProcSet [/PDF /Text /ImageC] >> ` +
      `/Contents ${contN} 0 R >>`)
    offsets[imgN] = len
    push(`${imgN} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`)
    push(p.jpeg)
    push(`\nendstream\nendobj\n`)
    const caption = (p.caption ?? '').replace(/[\\()]/g, '')
    const content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im${i} Do\nQ\n` +
      (caption ? `BT /F1 12 Tf 16 12 Td (${caption}) Tj ET\n` : '')
    obj(contN, `<< /Length ${content.length} >>\nstream\n${content}endstream`)
  })
  obj(fontObj, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`)

  const xrefPos = len
  const total = fontObj + 1
  push(`xref\n0 ${total}\n`)
  push(`0000000000 65535 f \n`)
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`)

  const out = new Uint8Array(len)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return new Blob([out], { type: 'application/pdf' })
}
