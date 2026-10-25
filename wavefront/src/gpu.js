// WebGPU host for the dream-RL loop: buffers, both dispatch modes, and the per-frame
// schedule (which blocks of the frame program run this frame). The schedule is a pure
// function of the frame count, so the CPU never needs to read GPU state to drive it.
import * as K from './consts.js';
import { buildWGSL, PROGRAM, OP_TASKS, NAIVE_WG } from './kernels.js';

const ST_ = GPUBufferUsage.STORAGE, CD = GPUBufferUsage.COPY_DST, CS = GPUBufferUsage.COPY_SRC;
const HDR = K.gEnv + K.EST, STAGE = HDR * 4 + 16; // header + the real game
const BUFS = { NET: K.NNET_BUF, ACT: K.A.N, WD: K.NWORLD, ROLL: K.NROLL * K.RLS, REP: K.NREP * K.RST, ST: K.NSTATE * K.SST };
const UNI_BYTES = K.UNIFORM.length * 4;

export function initNets(seed) {
  const P = new Float32Array(K.NNET);
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (const net of [K.NA, K.NC, K.NM]) {
    const layers = [[net.W1, net.B1, net.in, net.h], [net.W2, net.B2, net.h, net.h], [net.W3, net.B3, net.h, net.out]];
    layers.forEach(([W, B, i, o], li) => {
      const bound = 1 / Math.sqrt(i);                         // torch.nn.Linear default
      const last = li === 2 && net !== K.NC;                   // policy and opponent model start (near) uniform
      for (let k = 0; k < i * o; k++) P[W + k] = (rnd() * 2 - 1) * bound * (last ? 0.01 : 1);
      for (let k = 0; k < o; k++) P[B + k] = last ? 0 : (rnd() * 2 - 1) * bound;
    });
  }
  return P;
}

export function initWorld(seed) {
  const W = new Float32Array(K.NWORLD);
  // the real game: same layout as rl/duel.py Duel.reset (deterministic, no jitter)
  const b = K.gEnv, T8 = K.T8, T = (s, k) => b + K.E.tank + s * 8 + k;
  W[T(1, T8.x)] = 200; W[T(1, T8.y)] = 300; W[T(0, T8.x)] = 600; W[T(0, T8.y)] = 300; W[T(0, T8.h)] = Math.PI;
  for (const s of [0, 1]) { W[T(s, T8.heat)] = K.START_HEAT; W[T(s, T8.energy)] = 100; }
  for (const o of [K.E.ai, K.E.hu]) { W[b + o] = 1; W[b + o + 1] = 1; W[b + o + 2] = (K.NAIM - 1) / 2; } // until the first decision: idle, aim straight
  return W;
}

export class Dream {
  static async create({ wg = 1024 } = {}) {
    if (!navigator.gpu) throw new Error('this browser has no WebGPU');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no WebGPU adapter');
    const feats = adapter.features.has('timestamp-query') ? ['timestamp-query'] : [];
    const lim = adapter.limits;
    let WG = 64;
    while (WG * 2 <= Math.min(wg, lim.maxComputeInvocationsPerWorkgroup, lim.maxComputeWorkgroupSizeX)) WG *= 2;
    const device = await adapter.requestDevice({ requiredFeatures: feats, requiredLimits: {
      maxComputeInvocationsPerWorkgroup: Math.max(256, WG), maxComputeWorkgroupSizeX: Math.max(256, WG) } });
    const d = new Dream(device, adapter, feats.length > 0, WG);
    await d.init();
    return d;
  }

  constructor(device, adapter, ts, WG) { Object.assign(this, { device, adapterInfo: adapter.info || {}, hasTs: ts, WG }); }

  async init() {
    const d = this.device;
    this.U = d.createBuffer({ size: UNI_BYTES, usage: GPUBufferUsage.UNIFORM | CD });
    for (const [n, size] of Object.entries(BUFS)) this[n] = d.createBuffer({ size: size * 4, usage: ST_ | CD | CS });
    const module = d.createShaderModule({ code: buildWGSL(this.WG) });
    const info = await module.getCompilationInfo();
    const errs = info.messages.filter((x) => x.type === 'error');
    if (errs.length) throw new Error('WGSL: ' + errs.slice(0, 5).map((x) => `${x.lineNum}:${x.linePos} ${x.message}`).join('\n'));
    const C = GPUShaderStage.COMPUTE;
    const bgl = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: C, buffer: { type: 'uniform' } },
      ...[1, 2, 3, 4, 5, 6].map((b) => ({ binding: b, visibility: C, buffer: { type: 'storage' } }))] });
    const layout = d.createPipelineLayout({ bindGroupLayouts: [bgl] });
    this.bg = d.createBindGroup({ layout: bgl, entries: [this.U, this.NET, this.ACT, this.WD, this.ROLL, this.REP, this.ST].map((b, i) => ({ binding: i, resource: { buffer: b } })) });
    const names = Object.keys(OP_TASKS);
    const pipes = await Promise.all(names.map((n) => d.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'k_' + n } })));
    this.pipe = Object.fromEntries(names.map((n, i) => [n, { p: pipes[i], wg: Math.ceil(OP_TASKS[n] / NAIVE_WG) }]));
    this.mega = await d.createComputePipelineAsync({ layout, compute: { module, entryPoint: 'mega' } });
    if (this.hasTs) { this.qs = d.createQuerySet({ type: 'timestamp', count: 2 }); this.qr = d.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | CS }); }
    this.stages = [0, 1, 2].map(() => ({ buf: d.createBuffer({ size: STAGE, usage: GPUBufferUsage.MAP_READ | CD }), busy: false }));
    this.uni = new ArrayBuffer(UNI_BYTES); this.uU = new Uint32Array(this.uni); this.uF = new Float32Array(this.uni);
    this.seed = (Math.random() * 2 ** 32) >>> 0;
    this.keepW = K.KEEP_W; this.keepDist = K.KEEP_DIST; this.wallW = K.WALL_W;   // reward shaping, changeable any frame
    this.viz = true;   // viewing dreams (drawn only; switch off for pure training runs)
    this.opp = 0;      // the other tank: 0 = driven by input (you or a scripted bot), 1 = by a policy net
    this.oppSelf = 0;  // with opp = 1: 0 = the champion's weights, 1 = the learner's own actor
    this.reset();
  }

  // fresh brain + fresh world (the seed also keys every GPU random stream)
  reset(seed = this.seed) {
    this.seed = seed >>> 0;
    this.device.queue.writeBuffer(this.NET, 0, initNets(seed ^ 0x9e3779b9));
    this.device.queue.writeBuffer(this.WD, 0, initWorld(seed));
    this.sched = { frame: 0, rep: 0, st: 0, phase: 'wait', t: 0, s: 0 };
  }

  // which blocks run this frame (mirrors the counters the GPU keeps)
  plan() {
    const S = this.sched, p = { decide: 0, bc: 0, nCollect: 0, gae: 0, nPPO: 0, reset: 0, viz: 0, nViz: 0 };
    if (this.viz && S.frame % K.VIZ_EVERY === 0) { p.viz = 1; p.nViz = K.HVIZ; }
    if (S.frame % K.REPEAT === 0) { p.decide = 1; S.rep = Math.min(S.rep + 1, K.NREP); S.st = Math.min(S.st + 1, K.NSTATE); }
    if (S.rep >= K.BC_START) p.bc = 1;
    if (S.phase === 'wait') { if (S.st >= K.DREAM_START) { p.reset = 1; S.phase = 'collect'; S.t = 0; } }
    else if (S.phase === 'collect') {
      p.nCollect = Math.min(K.COLLECT_PER_FRAME, K.TD - S.t); S.t += p.nCollect;
      if (S.t === K.TD) { p.gae = 1; S.phase = 'ppo'; S.s = 0; }
    } else {
      p.nPPO = Math.min(K.PPO_PER_FRAME, K.PPO_STEPS - S.s); S.s += p.nPPO;
      if (S.s === K.PPO_STEPS) { p.reset = 1; S.phase = 'collect'; S.t = 0; }
    }
    S.frame++;
    return p;
  }

  // the champion's actor, flat in netLayout order (W1 B1 W2 B2 W3 B3), into the opponent-net slot
  setChampion(actor) {
    if (actor.length !== K.NCH.end - K.NCH.W1) throw new Error(`champion has ${actor.length} params, expected ${K.NCH.end - K.NCH.W1}`);
    this.device.queue.writeBuffer(this.NET, K.NCH.W1 * 4, Float32Array.from(actor));
  }

  // write the uniform from named fields (layout: consts.UNIFORM)
  writeUniform(fields) {
    K.UNIFORM.forEach(([n, ty], i) => { const v = fields[n] ?? 0; if (ty === 'u32') this.uU[i] = v >>> 0; else this.uF[i] = v; });
    this.device.queue.writeBuffer(this.U, 0, this.uni);
  }

  // One frame. input: {thr, turn, mx, my, fire}. extra(enc) appends the render pass.
  step(mode, input, { readback = true, extra = null } = {}) {
    const d = this.device;
    const p = this.plan();
    this.writeUniform({ ...p, seed: this.seed, fire: input.fire ? 1 : 0, thr: input.thr, turn: input.turn, mx: input.mx, my: input.my,
      keepW: this.keepW, keepDist: this.keepDist, wallW: this.wallW, opp: this.opp, oppSelf: this.oppSelf });
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass(this.hasTs ? { timestampWrites: { querySet: this.qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : undefined);
    pass.setBindGroup(0, this.bg);
    let dispatches = 0;
    if (mode === 'mega') { pass.setPipeline(this.mega); pass.dispatchWorkgroups(1); dispatches = 1; }
    else {
      for (const blk of PROGRAM) {
        const reps = blk.flag ? p[blk.flag] : blk.loop ? p[blk.loop] : 1;
        for (let r = 0; r < reps; r++) for (const [n] of blk.ops) { const q = this.pipe[n]; pass.setPipeline(q.p); pass.dispatchWorkgroups(q.wg); dispatches++; }
      }
    }
    pass.end();
    if (extra) extra(enc);
    const stage = readback ? this.stages.find((s) => !s.busy) : null;
    if (stage) {
      stage.busy = true;
      enc.copyBufferToBuffer(this.WD, 0, stage.buf, 0, HDR * 4);
      if (this.hasTs) { enc.resolveQuerySet(this.qs, 0, 2, this.qr, 0); enc.copyBufferToBuffer(this.qr, 0, stage.buf, HDR * 4, 16); }
    }
    d.queue.submit([enc.finish()]);
    const promise = stage ? stage.buf.mapAsync(GPUMapMode.READ).then(() => {
      const raw = stage.buf.getMappedRange().slice(0); stage.buf.unmap(); stage.busy = false;
      let gpuMs = null;
      if (this.hasTs) { const ts = new BigUint64Array(raw, HDR * 4, 2); if (ts[1] > ts[0]) gpuMs = Number(ts[1] - ts[0]) / 1e6; }
      return { hdr: new Float32Array(raw, 0, HDR), gpuMs };
    }) : null;
    return { dispatches, promise };
  }

  async read(names = Object.keys(BUFS)) {
    const d = this.device, enc = d.createCommandEncoder(), out = {};
    const tmp = names.map((n) => { const b = d.createBuffer({ size: this[n].size, usage: GPUBufferUsage.MAP_READ | CD }); enc.copyBufferToBuffer(this[n], 0, b, 0, this[n].size); return [n, b]; });
    d.queue.submit([enc.finish()]);
    for (const [n, b] of tmp) { await b.mapAsync(GPUMapMode.READ); out[n] = b.getMappedRange().slice(0); b.destroy(); }
    return out;
  }
  write(snap) { for (const [n, raw] of Object.entries(snap)) if (this[n] && raw && BUFS[n]) this.device.queue.writeBuffer(this[n], 0, raw); }
}
