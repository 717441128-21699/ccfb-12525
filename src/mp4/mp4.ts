/** 最小 MP4（ISOBMFF）复用器与解复用器：avc1 / AVCC，非分片 */

export interface Mp4Sample {
  data: Uint8Array
  keyframe: boolean
  /** 秒 */
  ts: number
  /** 秒 */
  dur: number
}

export interface Mp4File {
  codec: string
  description: Uint8Array | null
  width: number
  height: number
  duration: number // 秒
  samples: Mp4Sample[]
}

// ---------- 基础读写 ----------
class W {
  parts: Uint8Array[] = []
  len = 0
  u8(v: number) { this.push(Uint8Array.of(v & 255)) }
  u16(v: number) { this.push(Uint8Array.of((v >> 8) & 255, v & 255)) }
  u24(v: number) { this.push(Uint8Array.of((v >> 16) & 255, (v >> 8) & 255, v & 255)) }
  u32(v: number) { this.push(Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255)) }
  str(s: string) { for (const c of s) this.u8(c.charCodeAt(0)) }
  bytes(b: Uint8Array) { this.push(b) }
  push(b: Uint8Array) { this.parts.push(b); this.len += b.length }
  box(type: string, write: (w: W) => void) {
    const inner = new W()
    write(inner)
    this.u32(inner.len + 8)
    this.str(type)
    this.push(inner.concat())
  }
  concat(): Uint8Array {
    const out = new Uint8Array(this.len)
    let o = 0
    for (const p of this.parts) { out.set(p, o); o += p.length }
    return out
  }
}

class R {
  constructor(public buf: Uint8Array, public pos = 0) {}
  u8() { return this.buf[this.pos++] }
  u16() { const v = (this.buf[this.pos] << 8) | this.buf[this.pos + 1]; this.pos += 2; return v }
  u32() { const v = (this.buf[this.pos] * 0x1000000) + ((this.buf[this.pos + 1] << 16) | (this.buf[this.pos + 2] << 8) | this.buf[this.pos + 3]); this.pos += 4; return v >>> 0 }
  u64() { const hi = this.u32(); const lo = this.u32(); return hi * 0x100000000 + lo }
  str(n: number) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8()); return s }
  skip(n: number) { this.pos += n }
  slice(n: number) { const s = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return s }
}

function* boxes(buf: Uint8Array, start: number, end: number): Generator<{ type: string; start: number; size: number; body: number }> {
  let pos = start
  while (pos + 8 <= end) {
    const r = new R(buf, pos)
    let size = r.u32()
    const type = r.str(4)
    let header = 8
    if (size === 1) { size = r.u64(); header = 16 }
    if (size === 0) size = end - pos
    yield { type, start: pos, size, body: pos + header }
    pos += size
  }
}

function findBox(buf: Uint8Array, start: number, end: number, path: string[]): { start: number; size: number; body: number } | null {
  if (path.length === 0) return null
  for (const b of boxes(buf, start, end)) {
    if (b.type !== path[0]) continue
    if (path.length === 1) return b
    // 需要下钻的容器（stsd 有 8 字节版本/条目数前缀，特殊处理）
    const off = b.type === 'stsd' ? b.body + 8 : b.body
    const found = findBox(buf, off, b.start + b.size, path.slice(1))
    if (found) return found
  }
  return null
}

// ---------- 复用 ----------
export interface MuxSample { data: Uint8Array; keyframe: boolean; /** 时间戳，timescale 单位 */ ts: number; dur: number }

export function muxMp4(samples: MuxSample[], opts: { width: number; height: number; timescale: number; description: Uint8Array }): ArrayBuffer {
  const { width, height, timescale, description } = opts
  const w = new W()
  // ftyp
  w.box('ftyp', b => { b.str('isom'); b.u32(0x200); b.str('isom'); b.str('iso2'); b.str('avc1'); b.str('mp41') })
  const ftypLen = w.len
  // mdat（先写，moov 里的 stco 需要绝对偏移）
  const mdatHeader = 8
  const offsets: number[] = []
  let cursor = ftypLen + mdatHeader
  const mdat = new W()
  for (const s of samples) { offsets.push(cursor); mdat.push(s.data); cursor += s.data.length }
  w.u32(mdat.len + 8); w.str('mdat'); w.push(mdat.concat())

  const duration = samples.reduce((a, s) => a + s.dur, 0)
  const matrix = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]
  w.box('moov', moov => {
    moov.box('mvhd', b => {
      b.u32(0); b.u32(0); b.u32(0); b.u32(timescale); b.u32(duration)
      b.u32(0x00010000); b.u16(0x0100); b.u16(0)
      b.u32(0); b.u32(0)
      for (const m of matrix) b.u32(m)
      for (let i = 0; i < 6; i++) b.u32(0)
      b.u32(2)
    })
    moov.box('trak', trak => {
      trak.box('tkhd', b => {
        b.u32(7); b.u32(0); b.u32(0); b.u32(1); b.u32(0); b.u32(duration)
        b.u32(0); b.u32(0)
        b.u16(0); b.u16(0); b.u16(0); b.u16(0)
        for (const m of matrix) b.u32(m)
        b.u32(width << 16); b.u32(height << 16)
      })
      trak.box('mdia', mdia => {
        mdia.box('mdhd', b => { b.u32(0); b.u32(0); b.u32(0); b.u32(timescale); b.u32(duration); b.u16(0x55c4); b.u16(0) })
        mdia.box('hdlr', b => { b.u32(0); b.u32(0); b.str('vide'); b.u32(0); b.u32(0); b.u32(0); b.str('VideoHandler'); b.u8(0) })
        mdia.box('minf', minf => {
          minf.box('vmhd', b => { b.u32(1); b.u16(0); b.u16(0); b.u16(0); b.u16(0) })
          minf.box('dinf', dinf => {
            dinf.box('dref', dref => { dref.u32(0); dref.u32(1); dref.box('url ', u => u.u32(1)) })
          })
          minf.box('stbl', stbl => {
            stbl.box('stsd', stsd => {
              stsd.u32(0); stsd.u32(1)
              stsd.box('avc1', avc1 => {
                avc1.u32(0); avc1.u16(0); avc1.u16(1) // reserved + data_ref
                for (let i = 0; i < 8; i++) avc1.u16(0)
                avc1.u16(width); avc1.u16(height)
                avc1.u32(0x00480000); avc1.u32(0x00480000)
                avc1.u32(0); avc1.u16(1)
                for (let i = 0; i < 32; i++) avc1.u8(0)
                avc1.u16(0x18); avc1.u16(0xffff)
                avc1.box('avcC', c => c.push(description))
              })
            })
            // stts：按 delta 行程压缩
            stbl.box('stts', stts => {
              stts.u32(0)
              const runs: [number, number][] = []
              for (const s of samples) {
                if (runs.length && runs[runs.length - 1][1] === s.dur) runs[runs.length - 1][0]++
                else runs.push([1, s.dur])
              }
              stts.u32(runs.length)
              for (const [n, d] of runs) { stts.u32(n); stts.u32(d) }
            })
            stbl.box('stsc', stsc => { stsc.u32(0); stsc.u32(1); stsc.u32(1); stsc.u32(1); stsc.u32(1) })
            stbl.box('stsz', stsz => { stsz.u32(0); stsz.u32(0); stsz.u32(samples.length); for (const s of samples) stsz.u32(s.data.length) })
            const keys = samples.map((s, i) => (s.keyframe ? i + 1 : 0)).filter(Boolean)
            stbl.box('stss', stss => { stss.u32(0); stss.u32(keys.length); for (const k of keys) stss.u32(k) })
            stbl.box('stco', stco => { stco.u32(0); stco.u32(offsets.length); for (const o of offsets) stco.u32(o) })
          })
        })
      })
    })
  })
  return w.concat().buffer as ArrayBuffer
}

// ---------- 解复用 ----------
export function demuxMp4(buf: ArrayBuffer): Mp4File {
  const u8 = new Uint8Array(buf)
  const moov = findBox(u8, 0, u8.length, ['moov'])
  if (!moov) throw new Error('MP4 中找不到 moov（暂不支持分片/异常封装）')

  // 找第一条视频轨
  let result: Mp4File | null = null
  for (const trak of boxes(u8, moov.body, moov.start + moov.size)) {
    if (trak.type !== 'trak') continue
    const stsd = findBox(u8, trak.body, trak.start + trak.size, ['mdia', 'minf', 'stbl', 'stsd'])
    if (!stsd) continue
    // stsd：4 字节 version/flags + 4 字节条目数，然后才是第一个条目（size+fourcc+内容）
    const entryStart = stsd.body + 8
    const cc = String.fromCharCode(...u8.subarray(entryStart + 4, entryStart + 8))
    if (cc !== 'avc1' && cc !== 'avc3') continue

    const entryBody = entryStart + 8
    const r = new R(u8, entryBody)
    r.skip(6); r.u16(); r.skip(16)
    const width = r.u16(); const height = r.u16()
    // avcC 在 78 字节 VisualSampleEntry 之后
    const avcC = findBox(u8, entryBody + 78, stsd.start + stsd.size, ['avcC'])
    if (!avcC) throw new Error('找不到 avcC')
    const description = u8.slice(avcC.body, avcC.start + avcC.size)
    const hex = (n: number) => description[n].toString(16).padStart(2, '0')
    const codec = `avc1.${hex(1)}${hex(2)}${hex(3)}`

    const mdhd = findBox(u8, trak.body, trak.start + trak.size, ['mdia', 'mdhd'])!
    const mr = new R(u8, mdhd.body)
    const ver = mr.u8(); mr.skip(3)
    if (ver === 1) { mr.skip(16) } else { mr.skip(8) }
    const timescale = mr.u32()
    const duration = ver === 1 ? mr.u64() : mr.u32()

    const stbl = (p: string) => findBox(u8, trak.body, trak.start + trak.size, ['mdia', 'minf', 'stbl', p])
    // stts
    const sttsR = new R(u8, stbl('stts')!.body + 4)
    const tsCount = sttsR.u32()
    const deltas: number[] = [] // 每样本时长（timescale 单位）
    for (let i = 0; i < tsCount; i++) {
      const n = sttsR.u32(); const d = sttsR.u32()
      for (let j = 0; j < n; j++) deltas.push(d)
    }
    // ctts（B 帧的显示偏移，可选）
    let ctts: number[] | null = null
    const cttsBox = stbl('ctts')
    if (cttsBox) {
      const cr = new R(u8, cttsBox.body)
      const cv = cr.u8(); cr.skip(3)
      const n = cr.u32()
      ctts = []
      for (let i = 0; i < n; i++) {
        const cnt = cr.u32()
        const off = cv === 1 ? (cr.u32() | 0) : cr.u32() // v1 有符号
        for (let j = 0; j < cnt; j++) ctts.push(off)
      }
    }
    // stsc / stco / stsz
    const stscR = new R(u8, stbl('stsc')!.body + 4)
    const stscN = stscR.u32()
    const stsc: [number, number, number][] = []
    for (let i = 0; i < stscN; i++) stsc.push([stscR.u32(), stscR.u32(), stscR.u32()])
    const stcoBox = stbl('stco')
    const co64Box = stcoBox ? null : stbl('co64')
    const coBox = (stcoBox ?? co64Box)!
    const co64 = !stcoBox
    const coR = new R(u8, coBox.body + 4)
    const coN = coR.u32()
    const chunkOffsets: number[] = []
    for (let i = 0; i < coN; i++) chunkOffsets.push(co64 ? coR.u64() : coR.u32())
    const stszR = new R(u8, stbl('stsz')!.body + 4)
    const uniform = stszR.u32()
    const szN = stszR.u32()
    const sizes: number[] = []
    for (let i = 0; i < szN; i++) sizes.push(uniform || stszR.u32())
    // stss
    const keySet = new Set<number>()
    const stssBox = stbl('stss')
    if (stssBox) {
      const kr = new R(u8, stssBox.body + 4)
      const kn = kr.u32()
      for (let i = 0; i < kn; i++) keySet.add(kr.u32() - 1)
    } else {
      for (let i = 0; i < szN; i++) keySet.add(i)
    }
    // 展开 chunk -> sample
    const samples: Mp4Sample[] = []
    let sampleIdx = 0
    let dts = 0
    let stscIdx = 0
    for (let chunk = 1; chunk <= chunkOffsets.length; chunk++) {
      while (stscIdx + 1 < stsc.length && stsc[stscIdx + 1][0] <= chunk) stscIdx++
      const perChunk = stsc[stscIdx][1]
      let off = chunkOffsets[chunk - 1]
      for (let k = 0; k < perChunk && sampleIdx < szN; k++) {
        const size = sizes[sampleIdx]
        const data = u8.slice(off, off + size)
        const ts = dts + (ctts ? ctts[sampleIdx] ?? 0 : 0)
        samples.push({ data, keyframe: keySet.has(sampleIdx), ts: ts / timescale, dur: deltas[sampleIdx] / timescale })
        dts += deltas[sampleIdx]
        off += size
        sampleIdx++
      }
    }
    result = { codec, description, width, height, duration: duration / timescale, samples }
    break
  }
  if (!result) throw new Error('MP4 中找不到 avc1 视频轨')
  return result
}
