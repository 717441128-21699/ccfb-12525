// 验证 PDF/ZIP 生成器的二进制结构（Node 环境直接跑）
import { buildPdf } from './src/export/pdf.ts'
import { buildZip } from './src/export/zip.ts'

const jpegStub = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0]) // 假 JPEG 头
const pdf = buildPdf([
  { jpeg: jpegStub, width: 1280, height: 720, caption: 'Page 1  00:04 - 00:33' },
  { jpeg: jpegStub, width: 1280, height: 720, caption: 'Page 2  00:43 - 00:60' },
])
const pdfBuf = new Uint8Array(await pdf.arrayBuffer())
const pdfText = new TextDecoder().decode(pdfBuf.slice(0, 200))
const trailer = new TextDecoder().decode(pdfBuf.slice(-200))
const xrefPos = parseInt(trailer.match(/startxref\s+(\d+)/)[1])
const xrefOk = new TextDecoder().decode(pdfBuf.slice(xrefPos, xrefPos + 5)) === 'xref\n'
console.log('PDF 头:', pdfText.slice(0, 8), '| xref 偏移正确:', xrefOk, '| 大小:', pdfBuf.length)

const zip = buildZip([
  { name: 'page-01.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
  { name: 'page-02.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]) },
])
const zipBuf = new Uint8Array(await zip.arrayBuffer())
const eocd = zipBuf.slice(-22)
const entries = (eocd[10] | (eocd[11] << 8))
const cdOk = zipBuf[0] === 0x50 && zipBuf[1] === 0x4b && eocd[0] === 0x50 && eocd[3] === 0x06
console.log('ZIP 条目数:', entries, '| 结构正确:', cdOk, '| 大小:', zipBuf.length)

if (zipBuf.length !== 2 * (30 + 11 + 7) + 2 * (46 + 11) + 22) throw new Error('ZIP 长度不符')
if (!xrefOk || !cdOk || entries !== 2) throw new Error('结构校验失败')
console.log('PDF/ZIP 生成器结构校验通过')
