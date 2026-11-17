/** WebGL2 基础封装：程序编译、纹理/FBO、全屏三角形、翻行读回 */
export const QUAD_VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

export class GL {
  gl: WebGL2RenderingContext
  private progs = new Map<string, WebGLProgram>()
  private vao: WebGLVertexArrayObject

  constructor(canvas?: HTMLCanvasElement | OffscreenCanvas) {
    const c = canvas ?? document.createElement('canvas')
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: false, antialias: false }) as WebGL2RenderingContext | null
    if (!gl) throw new Error('WebGL2 不可用')
    this.gl = gl
    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
  }

  program(fsSrc: string, outNames?: string[]): WebGLProgram {
    const key = fsSrc
    let p = this.progs.get(key)
    if (p) return p
    const gl = this.gl
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error('shader: ' + gl.getShaderInfoLog(s))
      return s
    }
    p = gl.createProgram()!
    gl.attachShader(p, compile(gl.VERTEX_SHADER, QUAD_VS))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('link: ' + gl.getProgramInfoLog(p))
    this.progs.set(key, p)
    return p
  }

  tex(w: number, h: number): WebGLTexture {
    const gl = this.gl
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  fbo(...textures: WebGLTexture[]): WebGLFramebuffer {
    const gl = this.gl
    const fb = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    const bufs: number[] = []
    textures.forEach((t, i) => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0)
      bufs.push(gl.COLOR_ATTACHMENT0 + i)
    })
    gl.drawBuffers(bufs)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('FBO 不完整')
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return fb
  }

  bindTex(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(loc, unit)
  }

  uloc(p: WebGLProgram, name: string) { return this.gl.getUniformLocation(p, name) }

  draw(target: WebGLFramebuffer | null, w: number, h: number) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target)
    gl.viewport(0, 0, w, h)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /**
   * 读回附件像素。本管线里 UV(0,0) 即图像左上角（全屏三角形把 v_uv(0,0)
   * 写到窗口 (0,0)，而 readPixels 也从 (0,0) 开始），所以读回顺序天然是顶行在前，无需翻转。
   */
  readPixels(fb: WebGLFramebuffer, w: number, h: number, attachment = 0): Uint8Array {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment)
    const out = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return out
  }

  clearTex(fb: WebGLFramebuffer, attachment: number, r: number, g: number, b: number, a: number) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    // clearBufferfv 按附件索引清，不改动 FBO 的 drawBuffers 状态
    gl.clearBufferfv(gl.COLOR, attachment, [r, g, b, a])
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }
}
