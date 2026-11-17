(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const n of document.querySelectorAll('link[rel="modulepreload"]'))e(n);new MutationObserver(n=>{for(const r of n)if(r.type==="childList")for(const c of r.addedNodes)c.tagName==="LINK"&&c.rel==="modulepreload"&&e(c)}).observe(document,{childList:!0,subtree:!0});function o(n){const r={};return n.integrity&&(r.integrity=n.integrity),n.referrerPolicy&&(r.referrerPolicy=n.referrerPolicy),n.crossOrigin==="use-credentials"?r.credentials="include":n.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function e(n){if(n.ep)return;n.ep=!0;const r=o(n);fetch(n.href,r)}})();const Pt=`#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;class Ht{gl;progs=new Map;vao;constructor(t){const e=(t??document.createElement("canvas")).getContext("webgl2",{preserveDrawingBuffer:!1,antialias:!1});if(!e)throw new Error("WebGL2 不可用");this.gl=e,this.vao=e.createVertexArray(),e.bindVertexArray(this.vao)}program(t,o){const e=t;let n=this.progs.get(e);if(n)return n;const r=this.gl,c=(i,y)=>{const d=r.createShader(i);if(r.shaderSource(d,y),r.compileShader(d),!r.getShaderParameter(d,r.COMPILE_STATUS))throw new Error("shader: "+r.getShaderInfoLog(d));return d};if(n=r.createProgram(),r.attachShader(n,c(r.VERTEX_SHADER,Pt)),r.attachShader(n,c(r.FRAGMENT_SHADER,t)),r.linkProgram(n),!r.getProgramParameter(n,r.LINK_STATUS))throw new Error("link: "+r.getProgramInfoLog(n));return this.progs.set(e,n),n}tex(t,o){const e=this.gl,n=e.createTexture();return e.bindTexture(e.TEXTURE_2D,n),e.texImage2D(e.TEXTURE_2D,0,e.RGBA8,t,o,0,e.RGBA,e.UNSIGNED_BYTE,null),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),n}fbo(...t){const o=this.gl,e=o.createFramebuffer();o.bindFramebuffer(o.FRAMEBUFFER,e);const n=[];if(t.forEach((r,c)=>{o.framebufferTexture2D(o.FRAMEBUFFER,o.COLOR_ATTACHMENT0+c,o.TEXTURE_2D,r,0),n.push(o.COLOR_ATTACHMENT0+c)}),o.drawBuffers(n),o.checkFramebufferStatus(o.FRAMEBUFFER)!==o.FRAMEBUFFER_COMPLETE)throw new Error("FBO 不完整");return o.bindFramebuffer(o.FRAMEBUFFER,null),e}bindTex(t,o,e){const n=this.gl;n.activeTexture(n.TEXTURE0+t),n.bindTexture(n.TEXTURE_2D,o),n.uniform1i(e,t)}uloc(t,o){return this.gl.getUniformLocation(t,o)}draw(t,o,e){const n=this.gl;n.bindFramebuffer(n.FRAMEBUFFER,t),n.viewport(0,0,o,e),n.drawArrays(n.TRIANGLES,0,3)}readPixels(t,o,e,n=0){const r=this.gl;r.bindFramebuffer(r.FRAMEBUFFER,t),r.readBuffer(r.COLOR_ATTACHMENT0+n);const c=new Uint8Array(o*e*4);return r.readPixels(0,0,o,e,r.RGBA,r.UNSIGNED_BYTE,c),r.bindFramebuffer(r.FRAMEBUFFER,null),c}clearTex(t,o,e,n,r,c){const i=this.gl;i.bindFramebuffer(i.FRAMEBUFFER,t),i.clearBufferfv(i.COLOR,o,[e,n,r,c]),i.bindFramebuffer(i.FRAMEBUFFER,null)}}class bt{parts=[];len=0;u8(t){this.push(Uint8Array.of(t&255))}u16(t){this.push(Uint8Array.of(t>>8&255,t&255))}u24(t){this.push(Uint8Array.of(t>>16&255,t>>8&255,t&255))}u32(t){this.push(Uint8Array.of(t>>>24&255,t>>>16&255,t>>>8&255,t&255))}str(t){for(const o of t)this.u8(o.charCodeAt(0))}bytes(t){this.push(t)}push(t){this.parts.push(t),this.len+=t.length}box(t,o){const e=new bt;o(e),this.u32(e.len+8),this.str(t),this.push(e.concat())}concat(){const t=new Uint8Array(this.len);let o=0;for(const e of this.parts)t.set(e,o),o+=e.length;return t}}class rt{constructor(t,o=0){this.buf=t,this.pos=o}u8(){return this.buf[this.pos++]}u16(){const t=this.buf[this.pos]<<8|this.buf[this.pos+1];return this.pos+=2,t}u32(){const t=this.buf[this.pos]*16777216+(this.buf[this.pos+1]<<16|this.buf[this.pos+2]<<8|this.buf[this.pos+3]);return this.pos+=4,t>>>0}u64(){const t=this.u32(),o=this.u32();return t*4294967296+o}str(t){let o="";for(let e=0;e<t;e++)o+=String.fromCharCode(this.u8());return o}skip(t){this.pos+=t}slice(t){const o=this.buf.subarray(this.pos,this.pos+t);return this.pos+=t,o}}function*gt(s,t,o){let e=t;for(;e+8<=o;){const n=new rt(s,e);let r=n.u32();const c=n.str(4);let i=8;r===1&&(r=n.u64(),i=16),r===0&&(r=o-e),yield{type:c,start:e,size:r,body:e+i},e+=r}}function ft(s,t,o,e){if(e.length===0)return null;for(const n of gt(s,t,o)){if(n.type!==e[0])continue;if(e.length===1)return n;const r=n.type==="stsd"?n.body+8:n.body,c=ft(s,r,n.start+n.size,e.slice(1));if(c)return c}return null}function At(s,t){const{width:o,height:e,timescale:n,description:r}=t,c=new bt;c.box("ftyp",b=>{b.str("isom"),b.u32(512),b.str("isom"),b.str("iso2"),b.str("avc1"),b.str("mp41")});const i=c.len,y=8,d=[];let _=i+y;const p=new bt;for(const b of s)d.push(_),p.push(b.data),_+=b.data.length;c.u32(p.len+8),c.str("mdat"),c.push(p.concat());const a=s.reduce((b,R)=>b+R.dur,0),T=[65536,0,0,0,65536,0,0,0,1073741824];return c.box("moov",b=>{b.box("mvhd",R=>{R.u32(0),R.u32(0),R.u32(0),R.u32(n),R.u32(a),R.u32(65536),R.u16(256),R.u16(0),R.u32(0),R.u32(0);for(const w of T)R.u32(w);for(let w=0;w<6;w++)R.u32(0);R.u32(2)}),b.box("trak",R=>{R.box("tkhd",w=>{w.u32(7),w.u32(0),w.u32(0),w.u32(1),w.u32(0),w.u32(a),w.u32(0),w.u32(0),w.u16(0),w.u16(0),w.u16(0),w.u16(0);for(const u of T)w.u32(u);w.u32(o<<16),w.u32(e<<16)}),R.box("mdia",w=>{w.box("mdhd",u=>{u.u32(0),u.u32(0),u.u32(0),u.u32(n),u.u32(a),u.u16(21956),u.u16(0)}),w.box("hdlr",u=>{u.u32(0),u.u32(0),u.str("vide"),u.u32(0),u.u32(0),u.u32(0),u.str("VideoHandler"),u.u8(0)}),w.box("minf",u=>{u.box("vmhd",g=>{g.u32(1),g.u16(0),g.u16(0),g.u16(0),g.u16(0)}),u.box("dinf",g=>{g.box("dref",E=>{E.u32(0),E.u32(1),E.box("url ",h=>h.u32(1))})}),u.box("stbl",g=>{g.box("stsd",h=>{h.u32(0),h.u32(1),h.box("avc1",l=>{l.u32(0),l.u16(0),l.u16(1);for(let m=0;m<8;m++)l.u16(0);l.u16(o),l.u16(e),l.u32(4718592),l.u32(4718592),l.u32(0),l.u16(1);for(let m=0;m<32;m++)l.u8(0);l.u16(24),l.u16(65535),l.box("avcC",m=>m.push(r))})}),g.box("stts",h=>{h.u32(0);const l=[];for(const m of s)l.length&&l[l.length-1][1]===m.dur?l[l.length-1][0]++:l.push([1,m.dur]);h.u32(l.length);for(const[m,I]of l)h.u32(m),h.u32(I)}),g.box("stsc",h=>{h.u32(0),h.u32(1),h.u32(1),h.u32(1),h.u32(1)}),g.box("stsz",h=>{h.u32(0),h.u32(0),h.u32(s.length);for(const l of s)h.u32(l.data.length)});const E=s.map((h,l)=>h.keyframe?l+1:0).filter(Boolean);g.box("stss",h=>{h.u32(0),h.u32(E.length);for(const l of E)h.u32(l)}),g.box("stco",h=>{h.u32(0),h.u32(d.length);for(const l of d)h.u32(l)})})})})})}),c.concat().buffer}function qt(s){const t=new Uint8Array(s),o=ft(t,0,t.length,["moov"]);if(!o)throw new Error("MP4 中找不到 moov（暂不支持分片/异常封装）");let e=null;for(const n of gt(t,o.body,o.start+o.size)){if(n.type!=="trak")continue;const r=ft(t,n.body,n.start+n.size,["mdia","minf","stbl","stsd"]);if(!r)continue;const c=r.body+8,i=String.fromCharCode(...t.subarray(c+4,c+8));if(i!=="avc1"&&i!=="avc3")continue;const y=c+8,d=new rt(t,y);d.skip(6),d.u16(),d.skip(16);const _=d.u16(),p=d.u16(),a=ft(t,y+78,r.start+r.size,["avcC"]);if(!a)throw new Error("找不到 avcC");const T=t.slice(a.body,a.start+a.size),b=f=>T[f].toString(16).padStart(2,"0"),R=`avc1.${b(1)}${b(2)}${b(3)}`,w=ft(t,n.body,n.start+n.size,["mdia","mdhd"]),u=new rt(t,w.body),g=u.u8();u.skip(3),g===1?u.skip(16):u.skip(8);const E=u.u32(),h=g===1?u.u64():u.u32(),l=f=>ft(t,n.body,n.start+n.size,["mdia","minf","stbl",f]),m=new rt(t,l("stts").body+4),I=m.u32(),L=[];for(let f=0;f<I;f++){const M=m.u32(),D=m.u32();for(let S=0;S<M;S++)L.push(D)}let W=null;const J=l("ctts");if(J){const f=new rt(t,J.body),M=f.u8();f.skip(3);const D=f.u32();W=[];for(let S=0;S<D;S++){const N=f.u32(),q=M===1?f.u32()|0:f.u32();for(let V=0;V<N;V++)W.push(q)}}const H=new rt(t,l("stsc").body+4),$=H.u32(),K=[];for(let f=0;f<$;f++)K.push([H.u32(),H.u32(),H.u32()]);const Z=l("stco"),et=Z?null:l("co64"),Q=Z??et,ot=!Z,Y=new rt(t,Q.body+4),it=Y.u32(),ct=[];for(let f=0;f<it;f++)ct.push(ot?Y.u64():Y.u32());const k=new rt(t,l("stsz").body+4),B=k.u32(),X=k.u32(),z=[];for(let f=0;f<X;f++)z.push(B||k.u32());const C=new Set,O=l("stss");if(O){const f=new rt(t,O.body+4),M=f.u32();for(let D=0;D<M;D++)C.add(f.u32()-1)}else for(let f=0;f<X;f++)C.add(f);const tt=[];let x=0,v=0,P=0;for(let f=1;f<=ct.length;f++){for(;P+1<K.length&&K[P+1][0]<=f;)P++;const M=K[P][1];let D=ct[f-1];for(let S=0;S<M&&x<X;S++){const N=z[x],q=t.slice(D,D+N),V=v+(W?W[x]??0:0);tt.push({data:q,keyframe:C.has(x),ts:V/E,dur:L[x]/E}),v+=L[x],D+=N,x++}}e={codec:R,description:T,width:_,height:p,duration:h/E,samples:tt};break}if(!e)throw new Error("MP4 中找不到 avc1 视频轨");return e}const kt=`#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_video;
uniform mat3 u_M; // 白板UV(0..1) -> 视频UV(0..1)
void main() {
  vec3 p = u_M * vec3(v_uv, 1.0);
  vec2 uv = p.xy / p.z;
  o = texture(u_video, uv);
}`,Ut=`#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_acc;
uniform sampler2D u_frame;
void main() {
  o = max(texture(u_acc, v_uv), texture(u_frame, v_uv));
}`,Dt=`#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
void main() { o = texture(u_tex, v_uv); }`,Ft=`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_frame;
uniform sampler2D u_prev;
uniform sampler2D u_state;
uniform sampler2D u_layer;
uniform sampler2D u_cand;
uniform sampler2D u_heat;
uniform float u_K;   // 笔迹提交所需稳定帧数
uniform float u_K2;  // 擦除确认所需稳定帧数
uniform vec2 u_texel; // 1/板面尺寸
layout(location=0) out vec4 o_state;
layout(location=1) out vec4 o_layer;
layout(location=2) out vec4 o_cand;
layout(location=3) out vec4 o_metrics;
layout(location=4) out vec4 o_heat;

bool whiteish(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  return mn > 0.70 && (mx - mn) < 0.14;
}

void main() {
  vec3 f  = texture(u_frame, v_uv).rgb;
  vec3 pf = texture(u_prev,  v_uv).rgb;
  vec3 st = texture(u_state, v_uv).rgb;
  vec3 ly = texture(u_layer, v_uv).rgb;
  vec4 cd = texture(u_cand,  v_uv);
  float ht = texture(u_heat, v_uv).r * 255.0; // 候选时长（秒×4）

  float mx = max(f.r, max(f.g, f.b));
  float mn = min(f.r, min(f.g, f.b));
  bool moved   = distance(f, pf) > 0.12;
  bool isWhite = whiteish(f);
  // 笔迹色判定：真笔迹总有一个很暗的通道（红/蓝墨水的另两通道、黑墨水的全部通道），
  // 擦除残影/编码鬼影三通道都偏亮，以此排除
  bool isRed   = (f.r - max(f.g, f.b)) > 0.25 && min(f.g, f.b) < 0.50;
  bool isBlue  = (f.b - max(f.r, f.g)) > 0.25 && min(f.r, f.g) < 0.50;
  bool isBlack = mx < 0.28 && (mx - mn) < 0.20;
  // 细特征过滤：笔迹是细线，4px 内必有白板；头发/衣物的暗色团块内部不算
  bool nearWhite = false;
  for (int i = 0; i < 4; i++) {
    vec2 off = vec2(i == 0 ? 4.0 : (i == 1 ? -4.0 : 0.0), i == 2 ? 4.0 : (i == 3 ? -4.0 : 0.0)) * u_texel;
    if (whiteish(texture(u_frame, v_uv + off).rgb)) nearWhite = true;
  }
  bool isStroke = (isRed || isBlue || isBlack) && nearWhite;
  bool committed = (ly.r + ly.g + ly.b) > 0.5;

  float cnt = cd.a * 255.0;
  vec3 ccol = cd.rgb;
  bool commit = false, erase = false, person = false;
  vec3 nst = st, nly = ly;
  vec4 ncd = vec4(0.0);

  if (isStroke) {
    if (committed) {
      // 已有笔迹，保持（叠写暂不覆盖）
    } else {
      bool same = cnt > 0.5 && distance(ccol, f) < 0.22;
      if (same && moved) {
        ncd = cd; // 帧间在动（手/笔正在写），冻结不计数
      } else if (same) {
        cnt += 1.0;
        ncd = vec4(ccol, cnt / 255.0);
      } else {
        cnt = moved ? 0.0 : 1.0;
        ncd = vec4(f, cnt / 255.0);
      }
      if (cnt >= u_K) {
        commit = true;
        nst = ccol;
        nly = isRed ? vec3(1.0, 0.0, 0.0) : (isBlue ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
        ncd = vec4(0.0);
      }
    }
  } else if (isWhite) {
    if (committed) {
      bool sameW = cnt > 0.5 && distance(ccol, vec3(1.0)) < 0.22;
      if (sameW && moved) {
        ncd = cd;
      } else if (sameW) {
        cnt += 1.0;
        ncd = vec4(ccol, cnt / 255.0);
      } else {
        cnt = moved ? 0.0 : 1.0;
        ncd = vec4(vec3(1.0), cnt / 255.0);
      }
      if (cnt >= u_K2) {
        erase = true;
        nst = vec3(1.0);
        nly = vec3(0.0);
        ncd = vec4(0.0);
      }
    }
  } else {
    person = true; // 非板面非笔迹：人体/影子等瞬态遮挡，冻结该像素
  }

  o_state = vec4(nst, 1.0);
  o_layer = vec4(nly, 1.0);
  o_cand  = ncd;
  // bit0 提交 / bit1 擦除
  float flags = (commit ? 1.0 : 0.0) + (erase ? 2.0 : 0.0);
  bool hasStroke = (nly.r + nly.g + nly.b) > 0.5;
  o_metrics = vec4(flags / 255.0, hasStroke ? 1.0 : 0.0, person ? 1.0 : 0.0, 1.0);
  // 候选中的笔迹色像素：累计候选时长（≈书写时长），最终只统计确认成笔迹的像素。
  // 人体晕环也会伪装成候选，但它随人移动而消失 —— 非候选超过 4s 就清零，
  // 真笔迹在被擦掉前一直是候选（或已提交），时长得以保留。
  float idle = texture(u_heat, v_uv).g * 255.0;
  if (isStroke && !committed && !commit) {
    ht = min(255.0, ht + 2.0); // +0.5s × 4
    idle = 0.0;
  } else if (!committed && !commit) {
    idle += 1.0;
    if (idle > 8.0) { ht = 0.0; idle = 0.0; }
  } else {
    idle = 0.0;
  }
  o_heat = vec4(ht / 255.0, idle / 255.0, 0.0, 1.0);
}`;function wt(s,t){return new VideoDecoder({output:s,error:o=>t(o)})}function Rt(s){return new EncodedVideoChunk({type:s.keyframe?"key":"delta",timestamp:Math.round(s.ts*1e6),duration:Math.round(s.dur*1e6),data:s.data})}async function*St(s){const t=[];let o=null;const e=wt(r=>t.push(r),r=>{o=r});e.configure({codec:s.codec,description:s.description??void 0});const n=()=>new Promise((r,c)=>{const i=()=>{e.removeEventListener("dequeue",i),r()};e.addEventListener("dequeue",i);const y=setInterval(()=>{o?(clearInterval(y),e.removeEventListener("dequeue",i),c(o)):e.decodeQueueSize<=24&&(clearInterval(y),e.removeEventListener("dequeue",i),r())},50)});for(const r of s.samples){for(;e.decodeQueueSize>24;)await n();for(e.decode(Rt(r));t.length;)yield t.shift();if(o)throw o}for(await Promise.race([e.flush().catch(()=>{}),new Promise(r=>setTimeout(r,5e3))]);t.length;)yield t.shift();if(e.close(),o)throw o}async function Bt(s,t){const o=s.samples.map((r,c)=>r.keyframe?c:-1).filter(r=>r>=0);if(!o.length)return[];const e=[];for(let r=0;r<t;r++){const c=o[Math.min(o.length-1,Math.floor((r+.5)*o.length/t))];e.includes(c)||e.push(c)}const n=[];for(const r of e){let c=null,i=null;const y=wt(d=>{c?d.close():c=d},d=>{i=d});y.configure({codec:s.codec,description:s.description??void 0}),y.decode(Rt(s.samples[r]));try{await y.flush()}catch{}if(y.close(),i)throw i;c&&n.push(c)}return n}const U=320,G=180;async function $t(s,t){const o=s.gl,e=await Bt(t,16),n=s.tex(t.width,t.height),r=s.tex(t.width,t.height),c=s.fbo(n),i=s.fbo(r);s.clearTex(c,0,0,0,0,1);const y=o.createTexture();o.bindTexture(o.TEXTURE_2D,y),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_MIN_FILTER,o.LINEAR),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_WRAP_S,o.CLAMP_TO_EDGE),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_WRAP_T,o.CLAMP_TO_EDGE);const d=s.program(Ut);o.useProgram(d);const _=s.uloc(d,"u_acc"),p=s.uloc(d,"u_frame");let a=n,T=c,b=r,R=i;for(const x of e)o.activeTexture(o.TEXTURE1),o.bindTexture(o.TEXTURE_2D,y),o.texImage2D(o.TEXTURE_2D,0,o.RGBA,o.RGBA,o.UNSIGNED_BYTE,x),x.close(),o.useProgram(d),s.bindTex(0,a,_),o.uniform1i(p,1),s.draw(R,t.width,t.height),[a,b]=[b,a],[T,R]=[R,T];const w=s.tex(U,G),u=s.fbo(w),g=s.program(Dt);o.useProgram(g),s.bindTex(0,a,s.uloc(g,"u_tex")),s.draw(u,U,G);const E=s.readPixels(u,U,G),h=new ImageData(new Uint8ClampedArray(E.buffer.slice(0)),U,G),l=new Float32Array(U*G);for(let x=0;x<U*G;x++)l[x]=.299*E[x*4]+.587*E[x*4+1]+.114*E[x*4+2];const m=new Uint8Array(U*G);for(let x=1;x<G-1;x++)for(let v=1;v<U-1;v++){const P=l[x*U+v+1]-l[x*U+v-1],f=l[(x+1)*U+v]-l[(x-1)*U+v];Math.abs(P)+Math.abs(f)>60&&(m[x*U+v]=1)}const I=new Float32Array(G),L=new Float32Array(U);for(let x=0;x<G;x++)for(let v=0;v<U;v++)m[x*U+v]&&(I[x]++,L[v]++);const W=(x,v,P)=>{let f=v,M=-1;for(let D=v;D<P;D++)x[D]>M&&(M=x[D],f=D);return{idx:f,val:M}},J=W(I,2,Math.floor(G*.45)),H=W(I,Math.ceil(G*.55),G-2),$=W(L,2,Math.floor(U*.45)),K=W(L,Math.ceil(U*.55),U-2),Z=(x,v)=>{let P=x.map(()=>!0),f=0,M=0;for(let D=0;D<2;D++){let S=0,N=0,q=0,V=0,j=0;if(x.forEach((nt,Tt)=>{if(!P[Tt])return;const at=v?nt[1]:nt[0],pt=v?nt[0]:nt[1];S+=at,N+=pt,q+=at*at,V+=at*pt,j++}),j<3)return null;const ht=j*q-S*S||1e-9;f=(j*V-S*N)/ht,M=(N-f*S)/j,D===0&&x.forEach((nt,Tt)=>{const at=v?nt[1]:nt[0],pt=v?nt[0]:nt[1];Math.abs(pt-(f*at+M))>3&&(P[Tt]=!1)})}return{a:f,b:M}},et=(x,v)=>{const P=[];if(v)for(let f=Math.max(0,x-3);f<=Math.min(G-1,x+3);f++)for(let M=0;M<U;M++)m[f*U+M]&&P.push([M,f]);else for(let f=Math.max(0,x-3);f<=Math.min(U-1,x+3);f++)for(let M=0;M<G;M++)m[M*U+f]&&P.push([f,M]);return P},Q=Z(et(J.idx,!0),!1),ot=Z(et(H.idx,!0),!1),Y=Z(et($.idx,!1),!0),it=Z(et(K.idx,!1),!0),ct=()=>({quad:[{x:t.width*.02,y:t.height*.02},{x:t.width*.98,y:t.height*.02},{x:t.width*.98,y:t.height*.98},{x:t.width*.02,y:t.height*.98}],confidence:0,blend:h});if(!Q||!ot||!Y||!it)return ct();const k=(x,v)=>{const P=(x.a*v.b+x.b)/(1-x.a*v.a);return{x:v.a*P+v.b,y:P}},B=[k(Q,Y),k(Q,it),k(ot,it),k(ot,Y)],X=t.width/U,z=t.height/G,C=B.map(x=>({x:x.x*X,y:x.y*z})),O=(x,v)=>{let P=0,f=0;for(let M=0;M<=1;M+=.02){const D=Math.round((x.x+(v.x-x.x)*M)/X),S=Math.round((x.y+(v.y-x.y)*M)/z);f++;let N=!1;for(let q=-2;q<=2&&!N;q++)for(let V=-2;V<=2&&!N;V++){const j=D+V,ht=S+q;j>=0&&j<U&&ht>=0&&ht<G&&m[ht*U+j]&&(N=!0)}N&&P++}return f?P/f:0},tt=(O(C[0],C[1])+O(C[1],C[2])+O(C[2],C[3])+O(C[3],C[0]))/4;return tt<.3?{...ct(),blend:h}:{quad:C,confidence:tt,blend:h}}function It(s){let t=s>>>0;return function(){t|=0,t=t+1831565813|0;let o=Math.imul(t^t>>>15,1|t);return o=o+Math.imul(o^o>>>7,61|o)^o,((o^o>>>14)>>>0)/4294967296}}function dt(s,t,o){return s<t?t:s>o?o:s}function Kt(s){const t=Math.max(0,Math.round(s)),o=Math.floor(t/60);return`${String(o).padStart(2,"0")}:${String(t%60).padStart(2,"0")}`}function Mt(s,t){const e=[],n=[];for(let c=0;c<4;c++){const{x:i,y}=s[c],{x:d,y:_}=t[c];e.push([i,y,1,0,0,0,-d*i,-d*y]),n.push(d),e.push([0,0,0,i,y,1,-_*i,-_*y]),n.push(_)}for(let c=0;c<8;c++){let i=c;for(let d=c+1;d<8;d++)Math.abs(e[d][c])>Math.abs(e[i][c])&&(i=d);[e[c],e[i]]=[e[i],e[c]],[n[c],n[i]]=[n[i],n[c]];const y=e[c][c]||1e-12;for(let d=0;d<8;d++){if(d===c)continue;const _=e[d][c]/y;if(_!==0){for(let p=c;p<8;p++)e[d][p]-=_*e[c][p];n[d]-=_*n[c]}}}const r=n.map((c,i)=>c/(e[i][i]||1e-12));return[r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[7],1]}function Ct(s){const[t,o,e,n,r,c,i,y,d]=s,_=r*d-c*y,p=-(n*d-c*i),a=n*y-r*i,T=t*_+o*p+e*a||1e-12;return[_/T,-(o*d-e*y)/T,(o*c-e*r)/T,p/T,(t*d-e*i)/T,-(t*c-e*n)/T,a/T,-(t*y-o*i)/T,(t*r-o*n)/T]}function Lt(s,t,o){const e=s[6]*t+s[7]*o+s[8]||1e-12;return{x:(s[0]*t+s[1]*o+s[2])/e,y:(s[3]*t+s[4]*o+s[5])/e}}function Yt(s,t){const o=document.createElement("a");o.href=URL.createObjectURL(s),o.download=t,o.click(),setTimeout(()=>URL.revokeObjectURL(o.href),5e3)}const A=1280,F=720,st=6,yt=4,Ot=6,Et=3500,Xt=.85,vt=3e3,Nt=12;function _t(s,t){const o=new Array(9);for(let e=0;e<3;e++)for(let n=0;n<3;n++)o[e*3+n]=s[e*3]*t[n]+s[e*3+1]*t[3+n]+s[e*3+2]*t[6+n];return o}function Gt(s,t,o){const e=s.reduce((p,a)=>p+a.x,0)/4,n=s.reduce((p,a)=>p+a.y,0)/4,r=s.map(p=>({x:p.x+(e-p.x)*.03,y:p.y+(n-p.y)*.03})),c=Mt(r,[{x:0,y:0},{x:A,y:0},{x:A,y:F},{x:0,y:F}]),i=Ct(c),y=[A,0,0,0,F,0,0,0,1],d=[1/t,0,0,0,1/o,0,0,0,1],_=_t(d,_t(i,y));return new Float32Array([_[0],_[3],_[6],_[1],_[4],_[7],_[2],_[5],_[8]])}async function jt(s,t,o,e={}){const n=s.gl,r=e.interval??.5,c=e.k??3,i=e.k2??3,y=[s.tex(A,F),s.tex(A,F)],d=[s.fbo(y[0]),s.fbo(y[1])],_=()=>{const k=s.tex(A,F),B=s.tex(A,F),X=s.tex(A,F),z=s.tex(A,F),C=s.tex(A,F),O=s.fbo(k,B,X,z,C);return{state:k,layer:B,cand:X,metrics:z,heat:C,fb:O}},p=[_(),_()];s.clearTex(p[0].fb,0,1,1,1,1),s.clearTex(p[0].fb,1,0,0,0,1),s.clearTex(p[0].fb,2,0,0,0,0),s.clearTex(p[0].fb,3,0,0,0,1),s.clearTex(p[0].fb,4,0,0,0,1);let a=0;const T=n.createTexture();n.bindTexture(n.TEXTURE_2D,T),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_MIN_FILTER,n.LINEAR),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_WRAP_S,n.CLAMP_TO_EDGE),n.texParameteri(n.TEXTURE_2D,n.TEXTURE_WRAP_T,n.CLAMP_TO_EDGE);const b=s.program(kt),R=s.uloc(b,"u_M"),w=s.uloc(b,"u_video"),u=Gt(o,t.width,t.height),g=s.program(Ft),E=k=>s.uloc(g,k);n.useProgram(g),n.uniform1f(E("u_K"),c),n.uniform1f(E("u_K2"),i),n.uniform2f(E("u_texel"),1/A,1/F);const h=[],l=[];let m=0,I=0,L=null,W=null,J=0,H=!0;const $=[],K=(k,B)=>{if(m<vt)return;const X=s.readPixels(p[a].fb,A,F,4),z=new Array(st*yt).fill(0);for(let O=0;O<F;O++){const tt=Math.min(yt-1,O*yt/F|0)*st,x=O*A;for(let v=0;v<A;v++){const P=x+v;(k.layer[P*4]>127||k.layer[P*4+1]>127||k.layer[P*4+2]>127)&&(z[tt+Math.min(st-1,v*st/A|0)]+=X[P*4]/4)}}const C=z.indexOf(Math.max(...z));h.push({index:h.length,startT:L??I,endT:W??I,wallStartT:I,wallEndT:B,state:k.state.slice(),layer:k.layer.slice(),heat:z,topCell:C,peakStrokes:m})},Z=(k,B)=>{m=B,I=k,L=null,W=null,s.clearTex(p[0].fb,4,0,0,0,1),s.clearTex(p[1].fb,4,0,0,0,1)};let et=-1,Q=0,ot=!1,Y=0;const it=performance.now();for await(const k of St(t)){const B=k.timestamp/1e6;if(B<et-1e-6){k.close();continue}if(et=B+r,Y===0&&e.debug?.("extractor: 第一帧到达"),Y%40===0&&e.debug?.(`extractor: 采样 #${Y} t=${B.toFixed(1)}`),Y++%8===0&&await new Promise(X=>setTimeout(X,0)),ot||(I=B),n.activeTexture(n.TEXTURE0),n.bindTexture(n.TEXTURE_2D,T),n.texImage2D(n.TEXTURE_2D,0,n.RGBA,n.RGBA,n.UNSIGNED_BYTE,k),k.close(),n.useProgram(b),n.uniformMatrix3fv(R,!1,u),n.uniform1i(w,0),s.draw(d[Q],A,F),ot){const X=p[a],z=p[1-a];n.useProgram(g),s.bindTex(0,y[Q],E("u_frame")),s.bindTex(1,y[1-Q],E("u_prev")),s.bindTex(2,X.state,E("u_state")),s.bindTex(3,X.layer,E("u_layer")),s.bindTex(4,X.cand,E("u_cand")),s.bindTex(5,X.heat,E("u_heat")),s.draw(z.fb,A,F),a=1-a;const C=p[a],O=s.readPixels(C.fb,A,F,3),tt=s.readPixels(C.fb,A,F,0),x=s.readPixels(C.fb,A,F,1);l.push({t:B,state:tt,layer:x}),l.length>Nt&&l.shift();let v=0,P=0,f=0,M=0;for(let S=0;S<F;S++){const N=S*A*4;for(let q=0;q<A;q++){const V=N+q*4,j=O[V];j&1&&v++,j&2&&P++,O[V+1]>127&&f++,O[V+2]>127&&M++}}(v>30||P>30)&&e.debug?.(`t=${B.toFixed(1)} commits=${v} erases=${P}`),v>=100&&(L===null&&(L=B),W=B),f>m&&(m=f),J--,$.push(P),$.length>Ot&&$.shift();const D=$.reduce((S,N)=>S+N,0);if(!H&&D<Et/2&&(H=!0),H&&D>Et&&m>=vt&&f<m*Xt&&J<=0){const S=l[0];K(S,B),Z(B,f),H=!1,J=Math.round(2/r)}e.onProgress?.({t:B,duration:t.duration,pages:h.length,strokeCount:f,personRatio:M/(A*F)}),e.onSample?.(B,tt,O)}else ot=!0;Q=1-Q}e.debug?.("extractor: 解码循环结束"),l.length&&K(l[l.length-1],l[l.length-1].t);const ct=(performance.now()-it)/1e3;return{pages:h,elapsed:ct}}function Qt(s,t,o=!1){const e=new Uint8ClampedArray(A*F*4),{state:n,layer:r}=s;for(let c=0;c<A*F;c++){const i=r[c*4],y=r[c*4+1],d=r[c*4+2];i>127&&t.red||y>127&&t.blue||d>127&&t.black?(e[c*4]=n[c*4],e[c*4+1]=n[c*4+1],e[c*4+2]=n[c*4+2]):e[c*4]=e[c*4+1]=e[c*4+2]=255,e[c*4+3]=255}if(o){const c=Math.max(1e-9,...s.heat),i=A/st,y=F/yt;for(let d=0;d<yt;d++)for(let _=0;_<st;_++){const p=s.heat[d*st+_]/c*.35;if(!(p<.02))for(let a=Math.floor(d*y);a<(d+1)*y;a++)for(let T=Math.floor(_*i);T<(_+1)*i;T++){const b=(a*A+T)*4;e[b]=e[b]*(1-p)+255*p,e[b+1]=e[b+1]*(1-p)+140*p,e[b+2]=e[b+2]*(1-p)+0*p}}}return new ImageData(e,A,F)}function Jt(s){const t=new OffscreenCanvas(s.width,s.height);return t.getContext("2d").putImageData(s,0,0),t.convertToBlob({type:"image/png"})}async function Zt(s,t=.9){const o=new OffscreenCanvas(s.width,s.height);o.getContext("2d").putImageData(s,0,0);const e=await o.convertToBlob({type:"image/jpeg",quality:t});return new Uint8Array(await e.arrayBuffer())}function te(s){const t=s%st,o=Math.floor(s/st),e=["上","中上","中下","下"][o]??"";return`${["最左","左","左中","右中","右","最右"][t]??""}${e}区`}const mt=.006;function ee(s,t){const o=s.gtPages[t].boundaryT;return t===0||s.gtPages[t-1].boundaryT,s.strokes.filter(e=>{if(e.t1>o)return!1;for(const n of s.erases){if(n.t1>o||n.t0<e.t0)continue;const r=e.pts.reduce((i,y)=>i+y[0],0)/e.pts.length,c=e.pts.reduce((i,y)=>i+y[1],0)/e.pts.length;if(r>=n.x0&&r<=n.x1&&c>=n.y0&&c<=n.y1)return!1}return!0})}function oe(){const s=It(20261117),t=[],o=[],e=(a,T,b,R,w,u,g=mt)=>{const E=Math.max(8,Math.round(b*60)),h=[];for(let l=0;l<=E;l++){const m=a+b*l/E;h.push([m,T+(s()-.5)*.012+Math.sin(l*1.7)*.008])}t.push({color:R,pts:h,width:g,t0:w,t1:w+u})},n=(a,T,b,R,w,u)=>{const g=[];for(let E=0;E<=40;E++){const h=E/40*Math.PI*2;g.push([a+Math.cos(h)*b,T+Math.sin(h)*b*1.3])}t.push({color:R,pts:g,width:mt,t0:w,t1:w+u})},r=(a,T,b,R,w,u,g,E=mt)=>{const h=[];for(let m=0;m<=20;m++)h.push([a+(b-a)*m/20,T+(R-T)*m/20]);t.push({color:w,pts:h,width:E,t0:u,t1:u+g})};let c=4;for(let a=0;a<6;a++)e(.06,.16+a*.11,.46+s()*.06,"black",c,2.6),c+=2.9;r(.06,.3,.52,.3,"red",c,1.6,.008),c+=1.9;const i=[];for(let a=0;a<=5;a++){const T=-Math.PI/2+a*4*Math.PI/5;i.push([.78+Math.cos(T)*.05,.14+Math.sin(T)*.065])}t.push({color:"red",pts:i,width:mt,t0:c,t1:c+1.8}),c+=2.1,e(.62,.28,.3,"blue",c,2.2),c+=2.5,e(.62,.4,.24,"blue",c,2),c+=2.3,e(.06,.86,.5,"black",c,2.6),c+=2.9;const y=c;o.push({x0:.58,y0:.04,x1:.98,y1:.96,t0:37,t1:41}),c=43,r(.64,.15,.64,.75,"blue",c,1.4),c+=1.6,r(.62,.72,.95,.72,"blue",c,1.4),c+=1.6;const d=[];for(let a=0;a<=30;a++){const T=.64+.3*a/30;d.push([T,.72-.5*Math.pow(a/30,2)])}t.push({color:"blue",pts:d,width:mt,t0:c,t1:c+2.4}),c+=2.8,e(.66,.82,.26,"black",c,2.2),c+=2.5,e(.66,.1,.2,"black",c,2),c+=2.3,r(.72,.5,.85,.32,"red",c,1.6),c+=1.8,r(.85,.32,.82,.33,"red",c,.8),c+=1,r(.85,.32,.84,.35,"red",c,.8),c+=1,e(.06,.86,.4,"black",c,2.2),c+=2.5;const _=c;o.push({x0:.02,y0:.02,x1:.99,y1:.98,t0:67,t1:71}),c=73;for(let a=0;a<4;a++)r(.08,.2+a*.18,.6,.2+a*.18,"black",c,.9),c+=1.05;for(let a=0;a<4;a++)r(.08+a*.174,.2,.08+a*.174,.74,"black",c,.9),c+=1.05;return e(.12,.29,.1,"black",c,1.2),c+=1.4,o.push({x0:.09,y0:.24,x1:.26,y1:.34,t0:c+.5,t1:c+1.5}),c+=1.8,e(.12,.29,.11,"blue",c,1.2),c+=1.4,e(.68,.3,.12,"black",c,1.4),c+=4,e(.68,.3,.26,"black",c,1.6),c+=1.8,n(.8,.3,.16,"red",c,1.6),c+=1.8,e(.68,.55,.24,"black",c,1.6),c+=1.8,{fps:24,duration:100,strokes:t,erases:o,gtPages:[{startT:4,endT:y,boundaryT:37},{startT:43,endT:_,boundaryT:67},{startT:73,endT:c,boundaryT:100}]}}const xt=1280,ut=720,lt=[{x:170,y:90},{x:1170,y:70},{x:1190,y:650},{x:150,y:630}],Wt={red:"#d22424",blue:"#2040c8",black:"#1a1a1a"};function zt(s,t,o,e){if(e<s.t0)return 0;for(const n of o.erases){if(n.t0<s.t0)continue;const r=s.pts.reduce((i,y)=>i+y[0],0)/s.pts.length,c=s.pts.reduce((i,y)=>i+y[1],0)/s.pts.length;if(r>=n.x0&&r<=n.x1&&c>=n.y0&&c<=n.y1){const i=.15+t*2654435761%1e3/1e3*.7;if(e>=n.t0+i*(n.t1-n.t0))return-1}}return dt((e-s.t0)/(s.t1-s.t0),0,1)}function Vt(s,t){for(let o=0;o<s.strokes.length;o++){const e=s.strokes[o];if(t>=e.t0&&t<=e.t1){const n=dt((t-e.t0)/(e.t1-e.t0),0,1),r=e.pts[Math.min(e.pts.length-1,Math.floor(n*e.pts.length))];return{x:r[0]+.07,y:dt(r[1]+.1,.2,.8)}}}for(const o of s.erases)if(t>=o.t0-.5&&t<=o.t1){const e=dt((t-o.t0)/(o.t1-o.t0),0,1);return{x:o.x0+(o.x1-o.x0)*e,y:(o.y0+o.y1)/2}}return t<4?{x:-.15+t*.12,y:.55}:t>=87&&t<90?{x:1.18,y:.5}:t>=95?{x:1.25,y:.5}:{x:.9,y:.6}}async function ne(s,t){const o=s.fps,e=Math.round(s.duration*o),n=new OffscreenCanvas(xt,ut),r=n.getContext("2d"),c=Mt([{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],lt),i=(u,g)=>Lt(c,u,g),y=()=>{r.beginPath(),r.moveTo(lt[0].x,lt[0].y);for(let u=1;u<4;u++)r.lineTo(lt[u].x,lt[u].y);r.closePath()},d=(u,g,E)=>{const h=i(u,g),l=Math.sin(E*2.2)*3,m=1;r.save(),r.translate(h.x,h.y+l),r.fillStyle="#565b66",r.fillRect(-22*m,60*m,18*m,90*m),r.fillRect(6*m,60*m,18*m,90*m),r.fillStyle="#6b5f4e",r.beginPath(),r.roundRect(-45*m,-60*m,90*m,130*m,18*m),r.fill(),r.fillStyle="#caa27e",r.beginPath(),r.arc(0,-88*m,24*m,0,Math.PI*2),r.fill(),r.fillStyle="#5a4b40",r.beginPath(),r.arc(0,-94*m,23*m,Math.PI,Math.PI*2),r.fill(),r.restore()},_=[];let p=null;const a=new VideoEncoder({output:(u,g)=>{const E=new Uint8Array(u.byteLength);u.copyTo(E),_.push({data:E,keyframe:u.type==="key",ts:Math.round((u.timestamp??0)/1e6*9e4),dur:Math.round(9e4/o)});const h=g?.decoderConfig?.description;h&&!p&&(p=new Uint8Array(h))},error:u=>{throw u}});a.configure({codec:"avc1.42001f",width:xt,height:ut,bitrate:2e6,framerate:o,latencyMode:"quality",avc:{format:"avc"}});let T=-.2,b=.55;const R=performance.now();for(let u=0;u<e;u++){const g=u/o,E=r.createLinearGradient(0,0,0,ut);E.addColorStop(0,"#7d838c"),E.addColorStop(1,"#5c6169"),r.fillStyle=E,r.fillRect(0,0,xt,ut),r.fillStyle="#4a4e55",r.fillRect(0,ut-60,xt,60),y(),r.fillStyle="#f4f4f0",r.fill(),r.lineWidth=9,r.strokeStyle="#3d3f45",r.stroke(),r.save(),y(),r.clip(),r.lineCap="round",r.lineJoin="round";for(let I=0;I<s.strokes.length;I++){const L=s.strokes[I],W=zt(L,I,s,g);if(W<=0)continue;const J=Math.max(2,Math.floor(L.pts.length*W));r.beginPath();const H=i(L.pts[0][0],L.pts[0][1]);r.moveTo(H.x,H.y);for(let $=1;$<J;$++){const K=i(L.pts[$][0],L.pts[$][1]);r.lineTo(K.x,K.y)}r.strokeStyle=Wt[L.color],r.lineWidth=L.width*1e3,r.stroke()}r.restore();const h=Vt(s,g),l=.9/o;T+=dt(h.x-T,-l,l),b+=dt(h.y-b,-l,l),T>-.05&&T<1.3&&d(T,b,g);const m=new VideoFrame(n,{timestamp:Math.round(u*1e6/o),duration:Math.round(1e6/o)});for(a.encode(m,{keyFrame:u%48===0}),m.close();a.encodeQueueSize>6;)await new Promise(I=>a.addEventListener("dequeue",I,{once:!0}));u%24===0&&(t?.(u,e),await new Promise(I=>setTimeout(I,0)))}if(await a.flush(),a.close(),!p)throw new Error("编码器未给出 avcC 描述");const w=At(_,{width:xt,height:ut,timescale:9e4,description:p});return{blob:new Blob([w],{type:"video/mp4"}),quad:lt.map(u=>({...u})),encodedFrames:e,encodeSeconds:(performance.now()-R)/1e3}}export{A as B,Ht as G,ut as V,$t as a,F as b,Qt as c,qt as d,jt as e,Kt as f,te as g,Zt as h,Jt as i,Yt as j,lt as k,Gt as l,oe as m,Mt as n,Lt as o,xt as p,ee as q,st as r,ne as s,yt as t,Ct as u};
