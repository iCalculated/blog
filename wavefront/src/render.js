// Draws from GPU memory: the real duel, plus faint ghosts of dreamed duels (the AI
// imagining fights against its model of you), its aim distribution as a fan, and your aim line.
// One instanced quad per thing, in draw order (later instances paint over earlier ones):
//   0                 arena grid and walls
//   [I_SEG, I_HIT)    futures: path segments of each viewing dream, per tank   (view 1)
//   [I_HIT, I_GT)     futures: imagined hits (rings)                           (view 1)
//   [I_GT,  I_GB)     ghost tanks of training dreams 1..NGH                    (view 2)
//   [I_GB,  I_RB)     their bullets                                            (view 2)
//   [I_RB,  I_FAN)    the real game's bullets
//   I_FAN             its aim fan
//   [I_TANK, I_AIM)   the two real tanks: you, then it (drawn on top)
//   I_AIM             your aim line
import * as K from './consts.js';
import { fmt as f, WGSL_LAYOUT } from './kernels.js';

const NGH = 16;                                   // dreams drawn as ghosts
// futures: trail segments and imagined hits, from the viewing dreams
const NSEG = K.NVIZ * K.HVIZ * 2;
const I_SEG = 1, I_HIT = I_SEG + NSEG, I_GT = I_HIT + NSEG;
const I_GB = I_GT + 2 * NGH, I_RB = I_GB + 2 * NGH * K.NBUL, I_FAN = I_RB + 2 * K.NBUL;
const I_TANK = I_FAN + 1, I_AIM = I_TANK + 2, N_INST = I_AIM + 1;

const WGSL = /* wgsl */ `
struct RU { aa: f32, view: f32, mx: f32, my: f32, alpha: f32, _pad0: f32, _pad1: f32, _pad2: f32 }   // view: 0 off, 1 futures, 2 training dreams; alpha: futures brightness
@group(0) @binding(0) var<uniform> ru: RU;
@group(0) @binding(1) var<storage, read> WD: array<f32>;
struct VO {
  @builtin(position) pos: vec4f, @location(0) q: vec2f,
  @location(1) @interpolate(flat) kind: u32, @location(2) @interpolate(flat) prm: vec4f,
};
const PI: f32 = ${Math.PI}; const MEA: f32 = ${K.MEA};
const CORAL = vec3f(1.0, 0.42, 0.34); const VIOLET = vec3f(0.616, 0.486, 1.0); const CYAN = vec3f(0.42, 0.89, 1.0);
${WGSL_LAYOUT}
fn wrapA(a: f32) -> f32 { return a - 2.0 * PI * floor((a + PI) / (2.0 * PI)); }

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  var o: VO; var ctr = vec2f(0.0); var half = vec2f(0.0); var ang = 0.0; var kind = 0u; var prm = vec4f(0.0);
  if (ii == 0u) { ctr = vec2f(${f(K.AW / 2)}, ${f(K.AH / 2)}); half = ctr; }
  else if (ii < ${I_HIT}u) {
    // one segment of one tank's path in one imagined future
    let k = ii - ${I_SEG}u; let i = k / ${K.HVIZ * 2}u; let r = k % ${K.HVIZ * 2}u; let j = r / 2u; let s = r % 2u;
    let pa = ${K.gTrail}u + (i * ${K.HVIZ + 1}u + j) * 6u + s * 3u; let pb = pa + 6u;
    let a = vec2f(WD[pa], WD[pa + 1u]); let b = vec2f(WD[pb], WD[pb + 1u]); let d = b - a; let l = length(d);
    if (abs(ru.view - 1.0) < 0.5 && l > 0.05) {
      kind = 7u; ctr = (a + b) * 0.5; half = vec2f(l * 0.5 + 0.8, 1.6); ang = atan2(d.y, d.x);
      prm = vec4f(f32(s), 1.0 - f32(j) / ${f(K.HVIZ)}, 0.0, 0.0);
    }
  } else if (ii < ${I_GT}u) {
    // an imagined hit: that tank's energy dropped by a bullet during this step
    let k = ii - ${I_HIT}u; let i = k / ${K.HVIZ * 2}u; let r = k % ${K.HVIZ * 2}u; let j = r / 2u; let s = r % 2u;
    let pa = ${K.gTrail}u + (i * ${K.HVIZ + 1}u + j) * 6u + s * 3u; let pb = pa + 6u;
    if (abs(ru.view - 1.0) < 0.5 && WD[pa + 2u] - WD[pb + 2u] > 7.0) {
      kind = 8u; ctr = vec2f(WD[pb], WD[pb + 1u]); half = vec2f(9.0); prm = vec4f(f32(s), 1.0 - f32(j) / ${f(K.HVIZ)}, 0.0, 0.0);
    }
  } else if (ii < ${I_GB}u) {
    // ghost tanks from dreams 1..NGH (only once dreams have started)
    let k = ii - ${I_GT}u; let e = 1u + k / 2u; let s = k % 2u;
    if (abs(ru.view - 2.0) < 0.5 && WD[tk(e, s, 5u)] > 0.0) {
      kind = 1u; ctr = vec2f(WD[tk(e, s, 0u)], WD[tk(e, s, 1u)]); ang = WD[tk(e, s, 2u)]; half = vec2f(22.0);
      prm = vec4f(f32(s), 0.0, 0.0, 0.0);
    }
  } else if (ii < ${I_RB}u) {
    let k = ii - ${I_GB}u; let e = 1u + k / ${2 * K.NBUL}u; let r = k % ${2 * K.NBUL}u; let s = r / ${K.NBUL}u; let j = r % ${K.NBUL}u;
    if (abs(ru.view - 2.0) < 0.5 && WD[bl(e, s, j, 4u)] > 0.5) { kind = 2u; ctr = vec2f(WD[bl(e, s, j, 0u)], WD[bl(e, s, j, 1u)]); half = vec2f(4.0); prm = vec4f(f32(s), 0.0, 0.0, 0.0); }
  } else if (ii < ${I_FAN}u) {
    let r = ii - ${I_RB}u; let s = r / ${K.NBUL}u; let j = r % ${K.NBUL}u;
    if (WD[bl(0u, s, j, 4u)] > 0.5) { kind = 3u; ctr = vec2f(WD[bl(0u, s, j, 0u)], WD[bl(0u, s, j, 1u)]); half = vec2f(6.0); prm = vec4f(f32(s), 0.0, 0.0, 0.0); }
  } else if (ii == ${I_FAN}u) {
    // its aim policy: 9 offsets across your escape cone, brightness = probability
    kind = 4u; ctr = vec2f(WD[tk(0u, 0u, 0u)], WD[tk(0u, 0u, 1u)]); half = vec2f(150.0);
    let th = atan2(WD[tk(0u, 1u, 1u)] - ctr.y, WD[tk(0u, 1u, 0u)] - ctr.x);
    prm = vec4f(th, WD[${K.HD.aiFireAng}u], 0.0, 0.0);
  } else if (ii < ${I_AIM}u) {
    let s = 1u - (ii - ${I_TANK}u); // draw the AI (s = 0) last
    kind = 5u; ctr = vec2f(WD[tk(0u, s, 0u)], WD[tk(0u, s, 1u)]); ang = WD[tk(0u, s, 2u)]; half = vec2f(30.0);
    let gun = select(WD[${K.HD.pg}u], WD[${K.HD.aiFireAng}u], s == 0u);
    prm = vec4f(f32(s), wrapA(gun - ang), WD[tk(0u, s, 4u)], 0.0);
  } else {
    let pp = vec2f(WD[tk(0u, 1u, 0u)], WD[tk(0u, 1u, 1u)]); let g = WD[${K.HD.pg}u];
    let len = max(length(vec2f(ru.mx, ru.my) - pp), 40.0);
    kind = 6u; ang = g; ctr = pp + vec2f(cos(g), sin(g)) * (len * 0.5 + 12.0); half = vec2f(len * 0.5 - 12.0, 4.0);
    prm = vec4f(select(0.0, 1.0, WD[tk(0u, 1u, 4u)] <= 0.0), len * 0.5 - 12.0, 0.0, 0.0);
  }
  let q = c * half;
  let w = ctr + vec2f(q.x * cos(ang) - q.y * sin(ang), q.x * sin(ang) + q.y * cos(ang));
  o.pos = vec4f(w.x / ${f(K.AW)} * 2.0 - 1.0, 1.0 - w.y / ${f(K.AH)} * 2.0, 0.0, 1.0);
  if (half.x == 0.0) { o.pos = vec4f(2.0, 2.0, 0.0, 1.0); }
  o.q = q; o.kind = kind; o.prm = prm;
  return o;
}
fn cov(d: f32) -> f32 { return clamp(0.5 - d / ru.aa, 0.0, 1.0); }
fn over(dst: vec4f, rgb: vec3f, a: f32) -> vec4f { return vec4f(rgb * a, a) + dst * (1.0 - a); }
fn box(q: vec2f, b: vec2f) -> f32 { let d = abs(q) - b; return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0); }
// signed distance (approx.) to the nose wedge: base at x = 12 spanning |y| ≤ 11, tip at x = 25
fn noseD(q: vec2f) -> f32 { return max(12.0 - q.x, (abs(q.y) * 13.0 / 11.0 + q.x - 25.0) / 1.55); }
fn tankShape(o0: vec4f, q: vec2f, col: vec3f, rel: f32, ready: f32, a: f32) -> vec4f {
  var o = o0;
  o = over(o, col * 0.45, a * cov(box(q - vec2f(0.0, 15.0), vec2f(19.0, 4.0))));
  o = over(o, col * 0.45, a * cov(box(q + vec2f(0.0, 15.0), vec2f(19.0, 4.0))));
  o = over(o, col * 0.6, a * cov(box(q, vec2f(15.0, 11.0)) - 2.0));
  // the back: a dark band across the trailing edge
  o = over(o, col * 0.18, a * cov(box(q + vec2f(13.5, 0.0), vec2f(2.4, 10.5))));
  // the front: the hull comes to a triangular point, so heading reads at a glance
  o = over(o, col * 0.6, a * cov(noseD(q)));
  let g = vec2f(q.x * cos(rel) + q.y * sin(rel), -q.x * sin(rel) + q.y * cos(rel));
  o = over(o, col * ready, a * cov(box(g - vec2f(13.0, 0.0), vec2f(11.0, 2.2))));
  o = over(o, col * ready, a * cov(length(q) - 7.0));
  return o;
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let q = v.q; var o = vec4f(0.0);
  switch v.kind {
    case 0u: {
      let p = q + vec2f(${f(K.AW / 2)}, ${f(K.AH / 2)});
      let g = min(abs(fract(p.x / 50.0 + 0.5) - 0.5), abs(fract(p.y / 50.0 + 0.5) - 0.5)) * 50.0;
      o = over(o, vec3f(0.12), cov(g - 0.5));
      let e = min(min(p.x, ${f(K.AW)} - p.x), min(p.y, ${f(K.AH)} - p.y));
      o = over(o, vec3f(0.3), cov(abs(e - 1.0) - 1.0));
    }
    case 1u: {
      // a dreamed tank: just a faint outline
      let col = select(VIOLET, CYAN, v.prm.x > 0.5);
      o = over(o, col, 0.10 * cov(abs(box(q, vec2f(17.0, 13.0))) - 0.8));
      o = over(o, col, 0.14 * cov(noseD(q) + 1.0));  // its front
    }
    case 2u: { o = over(o, select(CORAL, CYAN, v.prm.x > 0.5), 0.12 * cov(length(q) - 1.8)); }
    case 3u: {
      let d = length(q); let col = select(CORAL, CYAN, v.prm.x > 0.5);
      o = over(o, col, 0.25 * cov(d - 4.5)); o = over(o, col, cov(d - 2.5));
    }
    case 4u: {
      let d = length(q); let a = wrapA(atan2(q.y, q.x) - v.prm.x);
      let k = clamp(round((a + MEA) / (MEA / 4.0)), 0.0, 8.0);
      let center = -MEA + k * MEA / 4.0;
      let inWedge = abs(a - center) < MEA / 8.0 && abs(a) <= MEA + MEA / 8.0;
      let p = WD[${K.HD.aimProbs}u + u32(k)];
      if (inWedge && d > 34.0) { o = over(o, CORAL, (0.04 + 0.55 * p) * cov(d - 150.0) * smoothstep(150.0, 40.0, d)); }
      let fa = wrapA(atan2(q.y, q.x) - v.prm.y);
      o = over(o, CORAL, 0.6 * cov(abs(fa) * d - 0.6) * select(0.0, 1.0, d > 34.0 && d < 150.0));
    }
    case 7u: {
      // path segment: you cyan, it violet; fades with how far into the future it is
      let col = select(VIOLET, CYAN, v.prm.x > 0.5);
      o = over(o, col, min(1.0, ru.alpha * (0.012 + 0.05 * v.prm.y)) * cov(abs(q.y) - 0.7));
    }
    case 8u: {
      // where a bullet lands in the imagined future: coral ring = it hits you, cyan = you hit it
      let col = select(CYAN, CORAL, v.prm.x > 0.5);
      o = over(o, col, min(1.0, ru.alpha * (0.06 + 0.16 * v.prm.y)) * cov(abs(length(q) - 5.5) - 1.0));
    }
    case 5u: {
      let col = select(CYAN, VIOLET, v.prm.x < 0.5);
      o = tankShape(o, q, col, v.prm.y, select(0.6, 1.0, v.prm.z <= 0.0), 1.0);
    }
    default: {
      let dash = select(0.0, 1.0, fract(q.x / 10.0) < 0.55); let a = select(0.12, 0.4, v.prm.x > 0.5);
      o = over(o, CYAN, a * dash * cov(abs(q.y) - 0.6));
      o = over(o, CYAN, (a + 0.2) * cov(abs(length(q - vec2f(v.prm.y, 0.0)) - 3.5) - 0.7));
    }
  }
  return o;
}
`;

export class DreamRenderer {
  constructor(dream, canvas) {
    const d = (this.device = dream.device);
    this.canvas = canvas;
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device: d, format: this.format, alphaMode: 'opaque' });
    const module = d.createShaderModule({ code: WGSL });
    this.compiled = module.getCompilationInfo().then((info) => {
      const errs = info.messages.filter((x) => x.type === 'error');
      if (errs.length) throw new Error('render WGSL: ' + errs.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join('\n'));
    });
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const bgl = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: VF, buffer: { type: 'uniform' } }, { binding: 1, visibility: VF, buffer: { type: 'read-only-storage' } }] });
    this.pipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
      primitive: { topology: 'triangle-list' },
    });
    this.U = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bg = d.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: this.U } }, { binding: 1, resource: { buffer: dream.WD } }] });
    this.uni = new Float32Array(8); this.view = 1; this.alpha = 1; this.mouse = { x: 0, y: 0 };
    // size the backing store to the element's device pixels when layout changes (not every frame);
    // the element itself keeps its 4:3 box from CSS, so arena units per pixel = AW / width
    this.aa = K.AW / canvas.width;
    this.ro = new ResizeObserver(([e]) => this.resize(e));
    try { this.ro.observe(canvas, { box: 'device-pixel-content-box' }); } catch { this.ro.observe(canvas); }
  }
  resize(e) {
    const dpr = window.devicePixelRatio || 1, dp = e.devicePixelContentBoxSize?.[0], cb = e.contentBoxSize?.[0];
    const w = Math.max(1, Math.round(dp ? dp.inlineSize : (cb ? cb.inlineSize : e.contentRect.width) * dpr));
    const h = Math.max(1, Math.round(dp ? dp.blockSize : (cb ? cb.blockSize : e.contentRect.height) * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.aa = K.AW / w;
  }
  encode(enc) {
    const u = this.uni;   // field order of RU
    u[0] = this.aa; u[1] = this.view; u[2] = this.mouse.x; u[3] = this.mouse.y; u[4] = this.alpha; u[5] = u[6] = u[7] = 0;
    this.device.queue.writeBuffer(this.U, 0, this.uni);
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(),
      clearValue: { r: 0.0863, g: 0.0863, b: 0.0863, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.bg); pass.draw(6, N_INST); pass.end();
  }
  draw() { const enc = this.device.createCommandEncoder(); this.encode(enc); this.device.queue.submit([enc.finish()]); }
}
