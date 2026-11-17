import type { Mp4File } from '../mp4/mp4'

function makeDecoder(onFrame: (f: VideoFrame) => void, onErr: (e: unknown) => void) {
  return new VideoDecoder({ output: onFrame, error: e => onErr(e) })
}

function chunkOf(s: { data: Uint8Array; keyframe: boolean; ts: number; dur: number }) {
  return new EncodedVideoChunk({
    type: s.keyframe ? 'key' : 'delta',
    timestamp: Math.round(s.ts * 1e6),
    duration: Math.round(s.dur * 1e6),
    data: s.data as BufferSource,
  })
}

/** 顺序解码全部帧（带去背压）。调用方负责 close() 每一帧。 */
export async function* decodeFrames(mp4: Mp4File): AsyncGenerator<VideoFrame> {
  const queue: VideoFrame[] = []
  let err: unknown = null
  const decoder = makeDecoder(f => queue.push(f), e => { err = e })
  decoder.configure({ codec: mp4.codec, description: mp4.description ?? undefined } as VideoDecoderConfig)
  const waitDrain = () => new Promise<void>((res, rej) => {
    const h = () => { decoder.removeEventListener('dequeue', h); res() }
    decoder.addEventListener('dequeue', h)
    // 解码器出错时立刻拒绝，而不是干等 dequeue
    const check = setInterval(() => {
      if (err) { clearInterval(check); decoder.removeEventListener('dequeue', h); rej(err) }
      else if (decoder.decodeQueueSize <= 24) { clearInterval(check); decoder.removeEventListener('dequeue', h); res() }
    }, 50)
  })
  let fed = 0
  for (const s of mp4.samples) {
    while (decoder.decodeQueueSize > 24) await waitDrain()
    decoder.decode(chunkOf(s))
    fed++
    while (queue.length) yield queue.shift()!
    if (err) throw err
  }
  // 有的环境 flush() 永不 settle；解码器空闲时所有输出其实已交付，超时兜底
  await Promise.race([
    decoder.flush().catch(() => {}),
    new Promise(r => setTimeout(r, 5000)),
  ])
  while (queue.length) yield queue.shift()!
  decoder.close()
  if (err) throw err
}

/** 取均匀分布的若干关键帧（用于白板检测预处理），调用方负责 close()。 */
export async function keyframeFrames(mp4: Mp4File, count: number): Promise<VideoFrame[]> {
  const keyIdx = mp4.samples.map((s, i) => (s.keyframe ? i : -1)).filter(i => i >= 0)
  if (!keyIdx.length) return []
  const picked: number[] = []
  for (let k = 0; k < count; k++) {
    const idx = keyIdx[Math.min(keyIdx.length - 1, Math.floor((k + 0.5) * keyIdx.length / count))]
    if (!picked.includes(idx)) picked.push(idx)
  }
  const frames: VideoFrame[] = []
  for (const idx of picked) {
    let done: VideoFrame | null = null
    let err: unknown = null
    const decoder = makeDecoder(f => { if (!done) done = f; else f.close() }, e => { err = e })
    decoder.configure({ codec: mp4.codec, description: mp4.description ?? undefined } as VideoDecoderConfig)
    decoder.decode(chunkOf(mp4.samples[idx]))
    try { await decoder.flush() } catch { /* 单帧 flush 偶发警告可忽略 */ }
    decoder.close()
    if (err) throw err
    if (done) frames.push(done)
  }
  return frames
}
