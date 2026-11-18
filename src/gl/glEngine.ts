/**
 * Minimal WebGL2 helper: shader compilation, full-screen passes, ping-pong
 * float/byte textures and typed readbacks.
 */

export function createGL(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    antialias: false,
    alpha: false,
  });
  if (!gl) throw new Error('WebGL2 is not available in this browser');
  return gl;
}

export function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('Failed to allocate shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile error: ${log}\n${src}`);
  }
  return sh;
}

export interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
  uniformNames: string[] = [],
): Program {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram();
  if (!program) throw new Error('Failed to allocate program');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
  return { program, uniforms };
}

const QUAD_VS = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export function fullscreenVS(): string {
  return QUAD_VS;
}

export interface Texture2D {
  tex: WebGLTexture;
  width: number;
  height: number;
  internalFormat: number;
  format: number;
  type: number;
}

export function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  opts: {
    internalFormat?: number;
    format?: number;
    type?: number;
    filter?: number;
    wrap?: number;
    data?: ArrayBufferView | null;
  } = {},
): Texture2D {
  const tex = gl.createTexture();
  if (!tex) throw new Error('Failed to allocate texture');
  const internalFormat = opts.internalFormat ?? gl.RGBA8;
  const format = opts.format ?? gl.RGBA;
  const type = opts.type ?? gl.UNSIGNED_BYTE;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type,
    opts.data ?? null,
  );
  const filter = opts.filter ?? gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  const wrap = opts.wrap ?? gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return { tex, width, height, internalFormat, format, type };
}

export interface PingPong {
  a: Texture2D;
  b: Texture2D;
  swap(): void;
  get read(): Texture2D;
  get write(): Texture2D;
}

export function createPingPong(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  opts: Parameters<typeof createTexture>[3] = {},
): PingPong {
  const a = createTexture(gl, width, height, opts);
  const b = createTexture(gl, width, height, opts);
  let cur = a;
  return {
    a,
    b,
    swap() {
      cur = cur === a ? b : a;
    },
    get read() {
      return cur;
    },
    get write() {
      return cur === a ? b : a;
    },
  };
}

export class PassRenderer {
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('VAO allocation failed');
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.vao = vao;
  }

  bind() {
    this.gl.bindVertexArray(this.vao);
  }

  draw(
    program: Program,
    target: Texture2D | null,
    bindings: { tex: Texture2D; unit: number; name: string }[],
    setUniforms?: (u: Record<string, WebGLUniformLocation | null>) => void,
  ) {
    const gl = this.gl;
    // Re-establish VAO + vertex attribute every draw: intermediate
    // readPixels/framebuffer work in the pipeline can leave global VAO state
    // changed, and a disabled attrib 0 silently renders zero fragments.
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.useProgram(program.program);
    if (target) {
      gl.viewport(0, 0, target.width, target.height);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.tex, 0,
      );
    }
    for (const b of bindings) {
      gl.activeTexture(gl.TEXTURE0 + b.unit);
      gl.bindTexture(gl.TEXTURE_2D, b.tex.tex);
      const loc = program.uniforms[b.name];
      if (loc) gl.uniform1i(loc, b.unit);
    }
    if (setUniforms) setUniforms(program.uniforms);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

export function attachFramebuffer(gl: WebGL2RenderingContext): WebGLFramebuffer {
  const fb = gl.createFramebuffer();
  if (!fb) throw new Error('Framebuffer allocation failed');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  return fb;
}

export function readTextureBytes(
  gl: WebGL2RenderingContext,
  tex: Texture2D,
  fb: WebGLFramebuffer,
): Uint8Array {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.tex, 0);
  const out = new Uint8Array(tex.width * tex.height * 4);
  gl.readPixels(0, 0, tex.width, tex.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out;
}

export function uploadByteTexture(
  gl: WebGL2RenderingContext,
  t: Texture2D,
  data: Uint8Array,
) {
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  // texSubImage2D preserves the texture's sampling parameters; a fresh
  // texImage2D would reset MIN_FILTER to NEAREST_MIPMAP_LINEAR and make a
  // mipmap-less texture incomplete (sampling as black).
  gl.texSubImage2D(
    gl.TEXTURE_2D, 0, 0, 0, t.width, t.height, t.format, t.type, data,
  );
}

export function uploadImageSource(
  gl: WebGL2RenderingContext,
  t: Texture2D,
  source: TexImageSource,
) {
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
}
