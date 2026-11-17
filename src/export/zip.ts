/** 极简 ZIP（store 不压缩，PNG 本身已压缩） */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry { name: string; data: Uint8Array }

export function buildZip(entries: ZipEntry[]): Blob {
  const enc = new TextEncoder()
  const u16 = (v: number) => Uint8Array.of(v & 255, (v >> 8) & 255)
  const u32 = (v: number) => Uint8Array.of(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255)

  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.name)
    const crc = crc32(e.data)
    localParts.push(
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(e.data.length), u32(e.data.length),
      u16(name.length), u16(0), name, e.data,
    )
    centralParts.push(
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(e.data.length), u32(e.data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    )
    offset += 30 + name.length + e.data.length
  }
  const centralSize = centralParts.reduce((a, p) => a + p.length, 0)
  const end = [
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralSize), u32(offset), u16(0),
  ]
  return new Blob([...localParts, ...centralParts, ...end] as BlobPart[], { type: 'application/zip' })
}
