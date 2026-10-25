// WGSL for the dream-RL loop, generated. Every op is a per-task body: `tasks` independent
// units of work with all sizes and offsets baked in as literals. An op becomes
//   fn name(t, nt) { for (var ti = t; ti < tasks; ti += nt) { <task ti> } }
// Naive mode dispatches each op across the GPU (t = global id, nt = all threads); the
// megakernel runs the whole frame program in one workgroup (t = local id, nt = 1024) with a
// barrier between ops. `par(...)` fuses ops that don't depend on each other into one op
// (one dispatch / one barrier) without changing any task's arithmetic. No atomics and fixed
// reduction orders, so the two modes are bit-identical.
import * as K from './consts.js';

export const fmt = (x) => (Number.isInteger(x) ? `${x}.0` : `${x}`);
const f = fmt;
const H = K.HD, E = K.E, A = K.A, T = K.T8, RL = K.RL, RN = K.RNG;
const TB = 8;          // rows per register tile
export const NAIVE_WG = 64;

// Layout helpers shared with the renderer (game e, side s, field k).
export const WGSL_LAYOUT = /* wgsl */ `
const gEnv: u32 = ${K.gEnv}u; const EST: u32 = ${K.EST}u;
fn eb(e: u32) -> u32 { return gEnv + e * EST; }
fn tk(e: u32, s: u32, k: u32) -> u32 { return eb(e) + ${E.tank}u + s * 8u + k; }
fn bl(e: u32, s: u32, j: u32, k: u32) -> u32 { return eb(e) + ${E.bul}u + (s * ${K.NBUL}u + j) * 5u + k; }
`;

const HEADER = /* wgsl */ `
struct U { ${K.UNIFORM.map(([n, ty]) => `${n}: ${ty}`).join(', ')} }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> NET: array<f32>;   // params | m | v | grads | scalars
@group(0) @binding(2) var<storage, read_write> ACT: array<f32>;   // activations, deltas, aux, partials
@group(0) @binding(3) var<storage, read_write> WD: array<f32>;    // header + games + futures
@group(0) @binding(4) var<storage, read_write> ROLL: array<f32>;  // dream rollout
@group(0) @binding(5) var<storage, read_write> REP: array<f32>;   // replay of you
@group(0) @binding(6) var<storage, read_write> ST: array<f32>;    // saved real states

const PI: f32 = ${Math.PI};
const AW: f32 = ${f(K.AW)}; const AH: f32 = ${f(K.AH)}; const HALF: f32 = ${f(K.HALF)};
const VMAX: f32 = ${f(K.VMAX)}; const ACC: f32 = ${f(K.ACC)}; const DEC: f32 = ${f(K.DEC)};
const BSPEED: f32 = ${f(K.BSPEED)}; const MEA: f32 = ${K.MEA}; const AIM_STEP: f32 = ${K.AIM_STEP};
const TX: u32 = ${T.x}u; const TY: u32 = ${T.y}u; const TH: u32 = ${T.h}u; const TV: u32 = ${T.v}u;
const THEAT: u32 = ${T.heat}u; const TEN: u32 = ${T.energy}u; const TDH: u32 = ${T.dh}u; const TSHOTS: u32 = ${T.shots}u;
${WGSL_LAYOUT}
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// every random draw: (seed, stream, key, index, sub) → a hash; streams are listed in consts.RNG
fn hs(stream: u32, key: u32, idx: u32, sub: u32) -> u32 { return pcg(u.seed ^ pcg(stream ^ pcg(key ^ pcg(idx ^ pcg(sub))))); }
fn rs(stream: u32, key: u32, idx: u32, sub: u32) -> f32 { return f32(hs(stream, key, idx, sub) >> 8u) / 16777216.0; }
fn bump(slot: u32) { let v = WD[slot] + 1.0; WD[slot] = select(v, 0.0, v >= ${f(K.WRAP)}); }  // counters wrap at 2^24
fn wrapA(a: f32) -> f32 { return a - 2.0 * PI * floor((a + PI) / (2.0 * PI)); }
fn sgn(x: f32) -> f32 { return select(select(0.0, -1.0, x < 0.0), 1.0, x > 0.0); }
// Robocode velocity rule: accelerate by ACC toward the target speed, brake by DEC
fn approach(v: f32, t: f32) -> f32 {
  if (v == t) { return v; }
  if (v * t >= 0.0 && abs(t) > abs(v)) { return v + sgn(t) * min(ACC, abs(t) - abs(v)); }
  if (v * t > 0.0) { return v - sgn(v) * min(DEC, abs(v) - abs(t)); }
  let nv = v - sgn(v) * DEC;
  if (sgn(nv) != sgn(v)) { return 0.0; }
  return nv;
}
fn maxTurn(v: f32) -> f32 { return (${f(K.TURN0)} - ${f(K.TURNV)} * abs(v)) * PI / 180.0; }
fn ray(x: f32, y: f32, a: f32) -> f32 {
  let c = cos(a); let s = sin(a);
  var tx = 1.0e4; var ty = 1.0e4;
  if (c > 1.0e-6) { tx = (AW - HALF - x) / c; } else if (c < -1.0e-6) { tx = (HALF - x) / c; }
  if (s > 1.0e-6) { ty = (AH - HALF - y) / s; } else if (s < -1.0e-6) { ty = (HALF - y) / s; }
  return max(min(tx, ty), 0.0);
}
fn bearing(e: u32, s: u32) -> f32 {
  return atan2(WD[tk(e, 1u - s, TY)] - WD[tk(e, s, TY)], WD[tk(e, 1u - s, TX)] - WD[tk(e, s, TX)]);
}
fn aimOff(bin: u32) -> f32 { return -MEA + f32(bin) * AIM_STEP; }

// Egocentric observation of side s in game e (same features and order as rl/duel.py obs v1).
fn obsOf(e: u32, s: u32) -> array<f32, ${K.OBS}> {
  var o: array<f32, ${K.OBS}>;
  let o2 = 1u - s;
  let mx = WD[tk(e, s, TX)]; let my = WD[tk(e, s, TY)]; let mh = WD[tk(e, s, TH)]; let mv = WD[tk(e, s, TV)];
  let ox = WD[tk(e, o2, TX)]; let oy = WD[tk(e, o2, TY)]; let oh = WD[tk(e, o2, TH)]; let ov = WD[tk(e, o2, TV)];
  let dx = ox - mx; let dy = oy - my; let d = max(sqrt(dx * dx + dy * dy), 1.0); let th = atan2(dy, dx);
  o[0] = d / 1000.0;
  o[1] = sin(mh - th); o[2] = cos(mh - th); o[3] = mv / VMAX;
  o[4] = sin(oh - th); o[5] = cos(oh - th); o[6] = ov / VMAX;
  o[7] = ov * sin(oh - th) / VMAX; o[8] = -ov * cos(oh - th) / VMAX;
  o[9] = WD[tk(e, s, THEAT)] / 3.0; o[10] = WD[tk(e, o2, THEAT)] / 3.0;
  o[11] = WD[tk(e, s, TEN)] / 100.0; o[12] = WD[tk(e, o2, TEN)] / 100.0; o[13] = WD[tk(e, o2, TDH)] * 10.0;
  o[14] = ray(mx, my, mh) / 800.0; o[15] = ray(mx, my, mh + PI) / 800.0;
  o[16] = ray(mx, my, mh + PI / 2.0) / 800.0; o[17] = ray(mx, my, mh - PI / 2.0) / 800.0;
  o[18] = ray(ox, oy, oh) / 800.0; o[19] = ray(ox, oy, oh + PI) / 800.0;
  // the three nearest incoming enemy bullets, in the bearing frame
  var bd = array<f32, 3>(1.0e4, 1.0e4, 1.0e4); var bi = array<u32, 3>(0u, 0u, 0u);
  for (var j = 0u; j < ${K.NBUL}u; j++) {
    if (WD[bl(e, o2, j, 4u)] < 0.5) { continue; }
    let rx = WD[bl(e, o2, j, 0u)] - mx; let ry = WD[bl(e, o2, j, 1u)] - my; let dd = sqrt(rx * rx + ry * ry);
    if (dd < bd[2]) {
      if (dd < bd[1]) {
        bd[2] = bd[1]; bi[2] = bi[1];
        if (dd < bd[0]) { bd[1] = bd[0]; bi[1] = bi[0]; bd[0] = dd; bi[0] = j; } else { bd[1] = dd; bi[1] = j; }
      } else { bd[2] = dd; bi[2] = j; }
    }
  }
  let cs = cos(-th); let sn = sin(-th);
  for (var k = 0u; k < 3u; k++) {
    let al = select(0.0, 1.0, bd[k] < 1.0e4);
    let j = bi[k];
    let rx = WD[bl(e, o2, j, 0u)] - mx; let ry = WD[bl(e, o2, j, 1u)] - my;
    let vx = WD[bl(e, o2, j, 2u)]; let vy = WD[bl(e, o2, j, 3u)];
    o[20u + k] = al;
    o[23u + k] = (rx * cs - ry * sn) / 400.0 * al;
    o[26u + k] = (rx * sn + ry * cs) / 400.0 * al;
    o[29u + k] = (vx * cs - vy * sn) / BSPEED * al;
    o[32u + k] = (vx * sn + vy * cs) / BSPEED * al;
  }
  o[35] = min(WD[eb(e) + ${E.t}u] / ${f(K.ROUND_TICKS)}, 1.0);   // the round clock (stays at 1 in sudden death)
  return o;
}

// One physics tick of game e. Aims are absolute angles; returns damage dealt by (side 0, side 1).
fn tickEnv(e: u32, thr: vec2f, turn: vec2f, aim: vec2f, fire: vec2<bool>) -> vec2f {
  var px: array<f32, 2>; var py: array<f32, 2>;
  for (var s = 0u; s < 2u; s++) {
    let v = approach(WD[tk(e, s, TV)], clamp(thr[s], -1.0, 1.0) * VMAX);
    let dh = clamp(turn[s], -1.0, 1.0) * maxTurn(v);
    let h = wrapA(WD[tk(e, s, TH)] + dh);
    var x = WD[tk(e, s, TX)] + cos(h) * v; var y = WD[tk(e, s, TY)] + sin(h) * v; var vv = v;
    if (x < HALF || x > AW - HALF || y < HALF || y > AH - HALF) { vv = 0.0; }
    x = clamp(x, HALF, AW - HALF); y = clamp(y, HALF, AH - HALF);
    WD[tk(e, s, TX)] = x; WD[tk(e, s, TY)] = y; WD[tk(e, s, TH)] = h; WD[tk(e, s, TV)] = vv; WD[tk(e, s, TDH)] = dh;
    WD[tk(e, s, THEAT)] = max(WD[tk(e, s, THEAT)] - ${f(K.COOL)}, 0.0);
    px[s] = x; py[s] = y;
  }
  for (var s = 0u; s < 2u; s++) {
    if (fire[s] && WD[tk(e, s, THEAT)] <= 0.0 && WD[tk(e, s, TEN)] > ${f(K.COST)}) {
      let sl = u32(WD[tk(e, s, TSHOTS)]) % ${K.NBUL}u; let a = aim[s];
      WD[bl(e, s, sl, 0u)] = px[s] + cos(a) * ${f(K.MUZZLE)}; WD[bl(e, s, sl, 1u)] = py[s] + sin(a) * ${f(K.MUZZLE)};
      WD[bl(e, s, sl, 2u)] = cos(a) * BSPEED; WD[bl(e, s, sl, 3u)] = sin(a) * BSPEED; WD[bl(e, s, sl, 4u)] = 1.0;
      WD[tk(e, s, THEAT)] = ${f(K.HEAT)}; WD[tk(e, s, TEN)] -= ${f(K.COST)}; WD[tk(e, s, TSHOTS)] += 1.0;
    }
  }
  var nh = vec2f(0.0);
  for (var s = 0u; s < 2u; s++) {
    let tx = px[1u - s]; let ty = py[1u - s];
    for (var j = 0u; j < ${K.NBUL}u; j++) {
      if (WD[bl(e, s, j, 4u)] < 0.5) { continue; }
      let x = WD[bl(e, s, j, 0u)] + WD[bl(e, s, j, 2u)]; let y = WD[bl(e, s, j, 1u)] + WD[bl(e, s, j, 3u)];
      WD[bl(e, s, j, 0u)] = x; WD[bl(e, s, j, 1u)] = y;
      if (abs(x - tx) < HALF && abs(y - ty) < HALF) { WD[bl(e, s, j, 4u)] = 0.0; nh[s] += 1.0; }
      else if (x < 0.0 || x > AW || y < 0.0 || y > AH) { WD[bl(e, s, j, 4u)] = 0.0; }
    }
  }
  WD[tk(e, 0u, TEN)] += nh[0] * ${f(K.GAIN)} - nh[1] * ${f(K.DAMAGE)};
  WD[tk(e, 1u, TEN)] += nh[1] * ${f(K.GAIN)} - nh[0] * ${f(K.DAMAGE)};
  WD[eb(e) + ${E.t}u] += 1.0;
  return nh * ${f(K.DAMAGE)};
}
// A round ends on a kill, or after ROUND_TICKS if health differs; level at time → sudden death.
fn envDone(e: u32) -> bool {
  let e0 = WD[tk(e, 0u, TEN)]; let e1 = WD[tk(e, 1u, TEN)];
  return e0 <= 0.0 || e1 <= 0.0 || (WD[eb(e) + ${E.t}u] >= ${f(K.ROUND_TICKS)} && e0 != e1);
}
// side 0's result: +1 / -1 by kill or on health at time; 0 only if both die on the same tick
fn terminalR(e: u32) -> f32 {
  let e0 = WD[tk(e, 0u, TEN)]; let e1 = WD[tk(e, 1u, TEN)];
  if (e0 > 0.0 && e1 > 0.0) { return sign(e0 - e1); }
  return select(0.0, 1.0, e1 <= 0.0) - select(0.0, 1.0, e0 <= 0.0);
}
// a fresh random round (rl/duel.py Duel.reset)
fn envReset(e: u32, stream: u32, key: u32) {
  for (var i = 0u; i < ${K.SST}u; i++) { WD[eb(e) + i] = 0.0; }
  let flip = rs(stream, key, e, 1u) < 0.5; let x0 = select(200.0, 600.0, flip);
  WD[tk(e, 1u, TX)] = x0 + (rs(stream, key, e, 2u) - 0.5) * 120.0; WD[tk(e, 1u, TY)] = 300.0 + (rs(stream, key, e, 3u) - 0.5) * 300.0;
  WD[tk(e, 0u, TX)] = 800.0 - x0 + (rs(stream, key, e, 4u) - 0.5) * 120.0; WD[tk(e, 0u, TY)] = 300.0 + (rs(stream, key, e, 5u) - 0.5) * 300.0;
  for (var s = 0u; s < 2u; s++) {
    WD[tk(e, s, TH)] = (rs(stream, key, e, 6u + s) - 0.5) * 2.0 * PI; WD[tk(e, s, THEAT)] = ${f(K.START_HEAT)}; WD[tk(e, s, TEN)] = 100.0;
  }
}
// start a dream from a remembered real state
fn envLoad(e: u32, stream: u32, key: u32) {
  let n = max(u32(WD[${H.stCount}u]), 1u);
  let idx = hs(stream, key, e, 0u) % n;
  for (var i = 0u; i < ${K.SST}u; i++) { WD[eb(e) + i] = ST[idx * ${K.SST}u + i]; }
}
// log-sum-exp pieces of head h of the logits at ACT[z]: (max, Σ exp(z - max))
fn headLSE(z: u32, h: u32) -> vec2f {
  var offs = array<u32, 4>(${K.HEAD_OFF.join('u, ')}u); var ns = array<u32, 4>(${K.HEADS.join('u, ')}u);
  let o = z + offs[h]; var mx = -3.0e38;
  for (var j = 0u; j < ns[h]; j++) { mx = max(mx, ACT[o + j]); }
  var s = 0.0;
  for (var j = 0u; j < ns[h]; j++) { s += exp(ACT[o + j] - mx); }
  return vec2f(mx, s);
}
// sample one factorized action from the logits at ACT[z]; returns indices, writes the log-prob
fn sampleHeads(z: u32, stream: u32, key: u32, idx: u32, lp: ptr<function, f32>) -> vec4<u32> {
  var offs = array<u32, 4>(${K.HEAD_OFF.join('u, ')}u); var ns = array<u32, 4>(${K.HEADS.join('u, ')}u);
  var out = vec4<u32>(0u); var l = 0.0;
  for (var h = 0u; h < 4u; h++) {
    let o = z + offs[h]; let m = headLSE(z, h);
    var r = rs(stream, key, idx, h) * m.y; var c = 0u;
    for (; c < ns[h] - 1u; c++) { r -= exp(ACT[o + c] - m.x); if (r <= 0.0) { break; } }
    out[h] = c; l += ACT[o + c] - m.x - log(m.y);
  }
  *lp = l;
  return out;
}
`;

// ---------- op constructors: { tasks, task(I) } where I names the task index ----------
const op = (tasks, task) => ({ tasks, task });
const one = (body) => op(1, () => body);                    // a single thread
const ROWS = (n, body) => op(n, (I) => `let i = ${I};\n${body}`);  // body uses i
// fuse independent ops: task ranges are concatenated; each keeps its own index
function par(...ops) {
  let start = 0; const parts = ops.map((o) => { const p = { o, start }; start += o.tasks; return p; });
  return op(start, (I) => parts.map(({ o, start: s }, k) => {
    const cond = k === parts.length - 1 ? '' : `if (${I} < ${s + o.tasks}u) `;
    return `${k ? 'else ' : ''}${cond}{ let p${k} = ${I} - ${s}u;\n${o.task(`p${k}`)}\n}`;
  }).join(' '));
}

// y[r,k] = act(b[k] + Σ_j x[r,j] W[j,k]) for rows r in [r0, r0+nb); a task owns one k for TB rows.
function fc(inR, inD, net, layer, outR, outD, r0, nb, act) {
  const W = net[`W${layer}`], Bo = net[`B${layer}`];
  const RN_ = Math.min(TB, nb), R_ = [...Array(RN_).keys()];
  const fn = act === 'tanh' ? (v) => `tanh(${v})` : act === 'relu' ? (v) => `max(${v}, 0.0)` : (v) => v;
  return op(Math.ceil(nb / TB) * outD, (I) => `
    let b0 = ${r0}u + (${I} / ${outD}u) * ${TB}u; let k = ${I} % ${outD}u;
    let bias = NET[${Bo}u + k];
    ${R_.map((r) => `var a${r} = bias; let x${r} = ${inR}u + (b0 + ${r}u) * ${inD}u;`).join(' ')}
    for (var j = 0u; j < ${inD}u; j++) {
      let w = NET[${W}u + j * ${outD}u + k];
      ${R_.map((r) => `a${r} += ACT[x${r} + j] * w;`).join(' ')}
    }
    ${R_.map((r) => `if (b0 + ${r}u < ${r0 + nb}u) { ACT[${outR}u + (b0 + ${r}u) * ${outD}u + k] = ${fn(`a${r}`)}; }`).join('\n    ')}`);
}
// Weight gradients, split-K: chunk c of KS sums rows [c·nb/KS, (c+1)·nb/KS) into
// ACT[GP + c·NP + param]; gsum() then adds the KS partials in a fixed order. Within a chunk
// a task owns one k for 4 j's (or 4 bias entries): adjacent lanes read adjacent deltas.
function gradw(aR, aD, dR, dD, net, layer, nb, KS) {
  const W = net[`W${layer}`], Bo = net[`B${layer}`], jq = aD / 4, per = (jq + 1) * dD, R = nb / KS;
  return op(per * KS, (I) => `
    let c = ${I} / ${per}u; let rem = ${I} % ${per}u;
    let g = rem / ${dD}u; let k = rem % ${dD}u;
    let isW = g < ${jq}u; let j0 = min(g, ${jq - 1}u) * 4u;
    var acc = vec4f(0.0);
    for (var r = c * ${R}u; r < (c + 1u) * ${R}u; r++) {
      let ar = ${aR}u + r * ${aD}u + j0;
      let a = select(vec4f(1.0), vec4f(ACT[ar], ACT[ar + 1u], ACT[ar + 2u], ACT[ar + 3u]), isW);
      acc += a * ACT[${dR}u + r * ${dD}u + k];
    }
    let gp = ${A.GP}u + c * ${K.NP}u;
    if (isW) { ${[0, 1, 2, 3].map((q) => `ACT[gp + ${W}u + (j0 + ${q}u) * ${dD}u + k] = acc[${q}];`).join(' ')} }
    else { ACT[gp + ${Bo}u + k] = acc[0]; }`);
}
// G[p] = Σ_c partial[c][p] for p in [off, off+n), c = 0..KS-1 in order
const gsum = (off, n, KS) => op(n, (I) => `
    var s = 0.0;
    for (var c = 0u; c < ${KS}u; c++) { s += ACT[${A.GP}u + c * ${K.NP}u + ${off}u + ${I}]; }
    NET[${K.nG + off}u + ${I}] = s;`);
// dx[r,j] = act'(a[r,j]) Σ_k W[j,k] d[r,k]   (a = the layer's stored activation)
function backprop(dR, dD, net, layer, aR, aD, outR, nb, act) {
  const W = net[`W${layer}`], R_ = [...Array(TB).keys()];
  const dv = act === 'tanh' ? (a, s) => `(1.0 - ${a} * ${a}) * ${s}` : (a, s) => `select(0.0, ${s}, ${a} > 0.0)`;
  return op((nb / TB) * aD, (I) => `
    let b0 = (${I} / ${aD}u) * ${TB}u; let j = ${I} % ${aD}u;
    ${R_.map((r) => `var s${r} = 0.0;`).join(' ')}
    for (var k = 0u; k < ${dD}u; k++) {
      let w = NET[${W}u + j * ${dD}u + k];
      ${R_.map((r) => `s${r} += w * ACT[${dR}u + (b0 + ${r}u) * ${dD}u + k];`).join(' ')}
    }
    ${R_.map((r) => `{ let o = (b0 + ${r}u) * ${aD}u + j; let a = ACT[${aR}u + o]; ACT[${outR}u + o] = ${dv('a', `s${r}`)}; }`).join('\n    ')}`);
}
// bias-corrected Adam over NET[off, off+n), optionally scaled by the grad-norm clip factor
const adam = (off, n, lr, eps, stepSlot, scaled) => op(n, (I) => `
    let st = NET[${K.nS + stepSlot}u];
    let bc1 = 1.0 - pow(0.9, st); let bc2 = 1.0 - pow(0.999, st);
    let p = ${off}u + ${I};
    let g = NET[${K.nG}u + p] * ${scaled ? `NET[${K.nS + K.SC.gscale}u]` : '1.0'};
    let m = 0.9 * NET[${K.nM}u + p] + 0.1 * g; let v = 0.999 * NET[${K.nV}u + p] + 0.001 * g * g;
    NET[${K.nM}u + p] = m; NET[${K.nV}u + p] = v;
    NET[p] -= ${lr} * (m / bc1) / (sqrt(v / bc2) + ${eps});`);

// forward layer `layer` of one net (X → H1 → H2 → out); fused across nets with par()
const LAYER = (net, layer, io, r0, nb, act) => fc(io[layer - 1], layer === 1 ? K.OBS : K.HID, net, layer, io[layer], layer === 3 ? net.out : K.HID, r0, nb, layer === 3 ? 'none' : act);
const fwd = (name, specs) => [1, 2, 3].map((l) => [`${name}${l}`, par(...specs.map(([net, io, r0, nb, act]) => LAYER(net, l, io, r0, nb, act)))]);
// backward of layer l for several nets at once: weight grads and (except layer 1) the next delta
const bwd = (name, specs, nb, KS) => [3, 2, 1].map((l) => [`${name}${l}`, par(...specs.flatMap(([net, x, h1, h2, dOut, dH2, dH1, act]) => {
  const a = [x, h1, h2][l - 1], aD = l === 1 ? K.OBS : K.HID, d = [dH1, dH2, dOut][l - 1], dD = l === 3 ? net.out : K.HID;
  const ops = [gradw(a, aD, d, dD, net, l, nb, KS)];
  if (l > 1) ops.push(backprop(d, dD, net, l, [h1, h2][l - 2], K.HID, [dH1, dH2][l - 2], nb, act));
  return ops;
}))]);
const ACTOR = [A.X, A.H1, A.H2, A.Z], CRITIC = [A.X, A.H1c, A.H2c, A.V], MODEL = ACTOR;
const PZ = K.AUX_PPO, BZ = K.AUX_BC, AUXW = K.AUXW;

// ---------- the real game ----------
const REAL_DECIDE = [
  ['real_obs', par(one(`
  let o = obsOf(0u, 0u); let oh = obsOf(0u, 1u);
  // row 0: its situation (its actor); row 1: the other tank's (the opponent net, when one drives it)
  for (var j = 0u; j < ${K.OBS}u; j++) { ACT[${A.X}u + j] = o[j]; ACT[${A.X + K.OBS}u + j] = oh[j]; }
  // the other tank's situation → the opponent model's training data (its action is filled in by real_sample)
  let rh = u32(WD[${H.repHead}u]); let rr = rh * ${K.RST}u;
  for (var j = 0u; j < ${K.OBS}u; j++) { REP[rr + j] = oh[j]; }
  WD[${H.repHead}u] = f32((rh + 1u) % ${K.NREP}u); WD[${H.repCount}u] = min(WD[${H.repCount}u] + 1.0, ${f(K.NREP)});
  let sh = u32(WD[${H.stHead}u]);
  for (var i = 0u; i < ${K.SST}u; i++) { ST[sh * ${K.SST}u + i] = WD[eb(0u) + i]; }
  WD[${H.stHead}u] = f32((sh + 1u) % ${K.NSTATE}u); WD[${H.stCount}u] = min(WD[${H.stCount}u] + 1.0, ${f(K.NSTATE)});
  bump(${H.decisions}u);`),
    // playing itself: the opponent net is a fresh copy of its own actor
    ROWS(K.NA.end, `if (u.oppSelf == 1u) { NET[${K.NCH.W1}u + i] = NET[${K.NA.W1}u + i]; }`))],
  ...fwd('ra', [[K.NA, ACTOR, 0, 1, 'tanh'], [K.NCH, ACTOR, 1, 1, 'tanh']]),
  ['real_sample', one(`
  var lp = 0.0;
  let a = sampleHeads(${A.Z}u, ${RN.realSample}u, u32(WD[${H.decisions}u]), 0u, &lp);
  for (var h = 0u; h < 4u; h++) { WD[eb(0u) + ${E.ai}u + h] = f32(a[h]); }
  // the other tank's action now: sampled from the opponent net, or read off the input (you / a bot)
  let rr = ((u32(WD[${H.repHead}u]) + ${K.NREP - 1}u) % ${K.NREP}u) * ${K.RST}u;
  if (u.opp == 1u) {
    let b = sampleHeads(${A.Z + K.NLOGIT}u, ${RN.oppSample}u, u32(WD[${H.decisions}u]), 0u, &lp);
    for (var h = 0u; h < 4u; h++) { WD[eb(0u) + ${E.hu}u + h] = f32(b[h]); REP[rr + ${K.OBS}u + h] = f32(b[h]); }
  } else {
    let off = wrapA(WD[${H.pg}u] - bearing(0u, 1u));
    REP[rr + ${K.OBS}u] = sgn(u.thr) + 1.0;
    REP[rr + ${K.OBS + 1}u] = sgn(u.turn) + 1.0;
    REP[rr + ${K.OBS + 2}u] = clamp(round(off / AIM_STEP), -4.0, 4.0) + 4.0;
    REP[rr + ${K.OBS + 3}u] = select(0.0, 1.0, u.fire == 1u);
  }
  // for the display: the aim head's distribution (the coral fan)
  let m = headLSE(${A.Z}u, 2u);
  for (var j = 0u; j < ${K.NAIM}u; j++) { WD[${H.aimProbs}u + j] = exp(ACT[${A.Z + K.HEAD_OFF[2]}u + j] - m.x) / m.y; }`)],
];
const REAL_TICK = [['real_tick', one(`
  // the other tank: a net's held action (aimed like its own: bearing + offset, instantly), or the input,
  // whose turret turns toward the mouse at 10°/tick; its bullets fly where the turret points
  var thr1 = u.thr; var turn1 = u.turn; var fire1 = u.fire == 1u;
  let hu = eb(0u) + ${E.hu}u;
  if (u.opp == 1u) {
    thr1 = WD[hu] - 1.0; turn1 = WD[hu + 1u] - 1.0; fire1 = WD[hu + 3u] > 0.5;
    WD[${H.pg}u] = bearing(0u, 1u) + aimOff(u32(WD[hu + 2u]));
  } else {
    let pp = vec2f(WD[tk(0u, 1u, TX)], WD[tk(0u, 1u, TY)]);
    let gd = wrapA(atan2(u.my - pp.y, u.mx - pp.x) - WD[${H.pg}u]);
    WD[${H.pg}u] = wrapA(WD[${H.pg}u] + clamp(gd, -${K.GUN_TURN}, ${K.GUN_TURN}));
  }
  let ai = eb(0u) + ${E.ai}u;
  let aiAim = bearing(0u, 0u) + aimOff(u32(WD[ai + 2u]));
  WD[${H.aiFireAng}u] = aiAim;
  let dmg = tickEnv(0u, vec2f(WD[ai] - 1.0, thr1), vec2f(WD[ai + 1u] - 1.0, turn1), vec2f(aiAim, WD[${H.pg}u]),
                    vec2<bool>(WD[ai + 3u] > 0.5, fire1));
  WD[${H.realDealt}u] += dmg.x; WD[${H.realTaken}u] += dmg.y;
  bump(${H.frame}u);
  if (envDone(0u)) {
    let tr = terminalR(0u);
    // a double kill on the same tick is replayed, not scored
    if (tr > 0.0) { WD[${H.aiWins}u] += 1.0; } else if (tr < 0.0) { WD[${H.pWins}u] += 1.0; }
    if (tr != 0.0) { WD[${H.round}u] += 1.0; }
    envReset(0u, ${RN.realReset}u, u32(WD[${H.frame}u]));
    WD[${H.pg}u] = WD[tk(0u, 1u, TH)];
  }`)]];

// ---------- opponent model: one behaviour-cloning step on your recent play ----------
const BC_STEP = [
  ['bc_gather', ROWS(K.BCB, `
    let n = max(u32(WD[${H.repCount}u]), 1u);
    let idx = hs(${RN.bcGather}u, u32(WD[${H.bcSteps}u]), i, 0u) % n;
    for (var j = 0u; j < ${K.OBS}u; j++) { ACT[${A.X}u + i * ${K.OBS}u + j] = REP[idx * ${K.RST}u + j]; }
    for (var h = 0u; h < 4u; h++) { ACT[${A.AUX}u + i * ${AUXW}u + ${BZ.lab}u + h] = REP[idx * ${K.RST}u + ${K.OBS}u + h]; }`)],
  ...fwd('bm', [[K.NM, MODEL, 0, K.BCB, 'relu']]),
  ['bc_grad', ROWS(K.BCB, `
    var offs = array<u32, 4>(${K.HEAD_OFF.join('u, ')}u); var ns = array<u32, 4>(${K.HEADS.join('u, ')}u);
    let z = ${A.Z}u + i * ${K.NLOGIT}u; let ax = ${A.AUX}u + i * ${AUXW}u; var loss = 0.0;
    for (var h = 0u; h < 4u; h++) {
      let o = offs[h]; let lab = u32(ACT[ax + ${BZ.lab}u + h]); let m = headLSE(z, h);
      var best = 0u;
      for (var j = 0u; j < ns[h]; j++) {
        if (ACT[z + o + j] > ACT[z + o + best]) { best = j; }
        let p = exp(ACT[z + o + j] - m.x) / m.y;
        ACT[${A.dZ}u + i * ${K.NLOGIT}u + o + j] = (p - select(0.0, 1.0, j == lab)) / ${f(K.BCB)};
      }
      loss -= ACT[z + o + lab] - m.x - log(m.y);
      ACT[ax + ${BZ.acc}u + h] = select(0.0, 1.0, best == lab);
    }
    ACT[ax + ${BZ.loss}u] = loss;`)],
  ...bwd('bmb', [[K.NM, A.X, A.H1, A.H2, A.dZ, A.dH2, A.dH1, 'relu']], K.BCB, K.KS_BC),
  ['bm_gsum', gsum(K.NM.W1, K.NM.end - K.NM.W1, K.KS_BC)],
  ['bc_stats', one(`
  var L = 0.0; var acc = vec4f(0.0);
  for (var r = 0u; r < ${K.BCB}u; r++) {
    let ax = ${A.AUX}u + r * ${AUXW}u;
    L += ACT[ax + ${BZ.loss}u];
    for (var h = 0u; h < 4u; h++) { acc[h] += ACT[ax + ${BZ.acc}u + h]; }
  }
  WD[${H.bcLoss}u] = 0.98 * WD[${H.bcLoss}u] + 0.02 * L / ${f(K.BCB)};
  for (var h = 0u; h < 4u; h++) { WD[${H.accHeads}u + h] = 0.98 * WD[${H.accHeads}u + h] + 0.02 * acc[h] / ${f(K.BCB)}; }
  bump(${H.bcSteps}u); NET[${K.nS + K.SC.stepBC}u] += 1.0;`)],
  ['bc_adam', adam(K.NM.W1, K.NM.end - K.NM.W1, K.BC.lr, K.BC.eps, K.SC.stepBC, false)],
];

// ---------- dreams: 256 duels vs the opponent model, from remembered real states ----------
const D_OBS = ['d_obs', ROWS(K.ED, `
    let e = i + 1u;
    let o = obsOf(e, 0u); let oh = obsOf(e, 1u);
    for (var j = 0u; j < ${K.OBS}u; j++) { ACT[${A.X}u + i * ${K.OBS}u + j] = o[j]; ACT[${A.X}u + (${K.ED}u + i) * ${K.OBS}u + j] = oh[j]; }`)];
const COLLECT = [
  D_OBS,
  // actor and critic on the AI's rows, the opponent model on yours: one fused op per layer
  ...fwd('dfw', [[K.NA, ACTOR, 0, K.ED, 'tanh'], [K.NC, CRITIC, 0, K.ED, 'tanh'], [K.NM, MODEL, K.ED, K.ED, 'relu']]),
  ['d_act', ROWS(K.ED, `
    let e = i + 1u; let tt = u32(WD[${H.dreamT}u]); let key = u32(WD[${H.dreamDecisions}u]) + tt;
    var lp = 0.0; var lh = 0.0;
    let a = sampleHeads(${A.Z}u + i * ${K.NLOGIT}u, ${RN.dreamAI}u, key, e, &lp);
    let h = sampleHeads(${A.Z}u + (${K.ED}u + i) * ${K.NLOGIT}u, ${RN.dreamYou}u, key, e, &lh);
    for (var q = 0u; q < 4u; q++) { WD[eb(e) + ${E.ai}u + q] = f32(a[q]); WD[eb(e) + ${E.hu}u + q] = f32(h[q]); }
    let ro = (tt * ${K.ED}u + i) * ${K.RLS}u;
    for (var j = 0u; j < ${K.OBS}u; j++) { ROLL[ro + j] = ACT[${A.X}u + i * ${K.OBS}u + j]; }
    for (var q = 0u; q < 4u; q++) { ROLL[ro + ${RL.act}u + q] = f32(a[q]); }
    ROLL[ro + ${RL.logp}u] = lp; ROLL[ro + ${RL.val}u] = ACT[${A.V}u + i];`)],
  ['d_tick', ROWS(K.ED, `
    let e = i + 1u; let tt = u32(WD[${H.dreamT}u]);
    var r = 0.0; var dn = 0.0;
    for (var k = 0u; k < ${K.REPEAT}u; k++) {
      let b0 = bearing(e, 0u); let b1 = bearing(e, 1u);
      let ai = eb(e) + ${E.ai}u; let hu = eb(e) + ${E.hu}u;
      let d = tickEnv(e, vec2f(WD[ai] - 1.0, WD[hu] - 1.0), vec2f(WD[ai + 1u] - 1.0, WD[hu + 1u] - 1.0),
                      vec2f(b0 + aimOff(u32(WD[ai + 2u])), b1 + aimOff(u32(WD[hu + 2u]))), vec2<bool>(WD[ai + 3u] > 0.5, WD[hu + 3u] > 0.5));
      if (dn < 0.5) {
        r += (d.x - d.y) / ${f(K.DAMAGE)};   // one hit = ±1
        // weak shaping: don't sit on top of the player
        let sep = length(vec2f(WD[tk(e, 0u, TX)] - WD[tk(e, 1u, TX)], WD[tk(e, 0u, TY)] - WD[tk(e, 1u, TY)]));
        r -= u.keepW * max(0.0, 1.0 - sep / max(u.keepDist, 1.0));
        // weak shaping: don't sit pinned against a wall (a cost per tick in contact, not for being near)
        let ax = WD[tk(e, 0u, TX)]; let ay = WD[tk(e, 0u, TY)];
        if (ax <= HALF + 0.01 || ax >= AW - HALF - 0.01 || ay <= HALF + 0.01 || ay >= AH - HALF - 0.01) { r -= u.wallW; }
      }
      if (envDone(e)) {
        if (dn < 0.5) { r += terminalR(e); }
        dn = 1.0;
        envLoad(e, ${RN.dreamReload}u, u32(WD[${H.dreamDecisions}u]) + tt * ${K.REPEAT}u + k);
      }
    }
    let ro = (tt * ${K.ED}u + i) * ${K.RLS}u;
    ROLL[ro + ${RL.rew}u] = r; ROLL[ro + ${RL.done}u] = dn;`)],
  ['d_bump', one(`WD[${H.dreamT}u] += 1.0;`)],
];
const GAE = [
  D_OBS,
  ...fwd('gc', [[K.NC, CRITIC, 0, K.ED, 'tanh']]),
  ['gae', ROWS(K.ED, `
    var adv = 0.0; var nv = ACT[${A.V}u + i];
    for (var q = 0u; q < ${K.TD}u; q++) {
      let tt = ${K.TD - 1}u - q; let ro = (tt * ${K.ED}u + i) * ${K.RLS}u;
      let nonterm = 1.0 - ROLL[ro + ${RL.done}u];
      let v = ROLL[ro + ${RL.val}u];
      let delta = ROLL[ro + ${RL.rew}u] + ${K.PPO.gamma} * nv * nonterm - v;
      adv = delta + ${K.PPO.gamma * K.PPO.lam} * nonterm * adv;
      ROLL[ro + ${RL.adv}u] = adv; ROLL[ro + ${RL.ret}u] = adv + v;
      nv = v;
    }`)],
  // advantage mean/std: NADV chunks write (mean, M2); one thread merges them in a fixed order
  // with Chan's parallel-variance formula (numerically stable)
  ['adv_part', ROWS(K.NADV, `
    let n = ${K.NROLL / K.NADV}u; let r0 = i * n; var m = 0.0;
    for (var r = r0; r < r0 + n; r++) { m += ROLL[r * ${K.RLS}u + ${RL.adv}u]; }
    m = m / ${f(K.NROLL / K.NADV)};
    var m2 = 0.0;
    for (var r = r0; r < r0 + n; r++) { let d = ROLL[r * ${K.RLS}u + ${RL.adv}u] - m; m2 += d * d; }
    ACT[${A.GP}u + 2u * i] = m; ACT[${A.GP}u + 2u * i + 1u] = m2;`)],
  ['adv_fin', one(`
  var n = 0.0; var mean = 0.0; var m2 = 0.0; let nc = ${f(K.NROLL / K.NADV)};
  for (var c = 0u; c < ${K.NADV}u; c++) {
    let mc = ACT[${A.GP}u + 2u * c]; let delta = mc - mean; let nn = n + nc;
    mean += delta * nc / nn; m2 += ACT[${A.GP}u + 2u * c + 1u] + delta * delta * n * nc / nn; n = nn;
  }
  WD[${H.advMean}u] = mean; WD[${H.advStd}u] = sqrt(m2 / ${f(K.NROLL - 1)});
  // dreamDecisions also keys the dream RNG streams: bumping it here starts fresh ones
  WD[${H.ppoS}u] = 0.0; WD[${H.dreamDecisions}u] += ${f(K.NROLL)};`)],
];
// PPO: 3 epochs × 4 minibatches of 1024 samples (64 games × 16 decisions, games permuted per epoch)
const PPO_STEP = [
  ['p_gather', ROWS(K.MB, `
    let s = u32(WD[${H.ppoS}u]); let ep = s / ${K.NMB}u; let mb = s % ${K.NMB}u; let upd = u32(WD[${H.ppoUpdates}u]);
    let pa = (hs(${RN.ppoPerm}u, upd, ep, 0u) % ${K.ED / 2}u) * 2u + 1u;   // odd: a bijection mod ED
    let pb = hs(${RN.ppoPerm}u, upd, ep, 1u) % ${K.ED}u;
    let slot = mb * ${K.ED / K.NMB}u + i / ${K.TD}u;
    let e = (pa * slot + pb) % ${K.ED}u; let tt = i % ${K.TD}u;
    let ro = (tt * ${K.ED}u + e) * ${K.RLS}u;
    for (var j = 0u; j < ${K.OBS}u; j++) { ACT[${A.X}u + i * ${K.OBS}u + j] = ROLL[ro + j]; }
    let ax = ${A.AUX}u + i * ${AUXW}u;
    for (var q = 0u; q < 4u; q++) { ACT[ax + ${PZ.act}u + q] = ROLL[ro + ${RL.act}u + q]; }
    ACT[ax + ${PZ.logp}u] = ROLL[ro + ${RL.logp}u];
    ACT[ax + ${PZ.adv}u] = (ROLL[ro + ${RL.adv}u] - WD[${H.advMean}u]) / (WD[${H.advStd}u] + 1.0e-8);
    ACT[ax + ${PZ.ret}u] = ROLL[ro + ${RL.ret}u];`)],
  ...fwd('pfw', [[K.NA, ACTOR, 0, K.MB, 'tanh'], [K.NC, CRITIC, 0, K.MB, 'tanh']]),
  ['p_grad', ROWS(K.MB, `
    var offs = array<u32, 4>(${K.HEAD_OFF.join('u, ')}u); var ns = array<u32, 4>(${K.HEADS.join('u, ')}u);
    let z = ${A.Z}u + i * ${K.NLOGIT}u; let ax = ${A.AUX}u + i * ${AUXW}u;
    var lse: array<vec2f, 4>;
    var lp = 0.0;   // log-prob of the stored action under the current policy
    for (var h = 0u; h < 4u; h++) { lse[h] = headLSE(z, h); lp += ACT[z + offs[h] + u32(ACT[ax + ${PZ.act}u + h])] - lse[h].x - log(lse[h].y); }
    let ratio = exp(lp - ACT[ax + ${PZ.logp}u]); let adv = ACT[ax + ${PZ.adv}u];
    let s1 = ratio * adv; let s2 = clamp(ratio, ${1 - K.PPO.clip}, ${1 + K.PPO.clip}) * adv;
    let g = select(0.0, -adv * ratio, s1 <= s2);   // dL/dlogp of the clipped surrogate
    var ent = 0.0;
    for (var h = 0u; h < 4u; h++) {
      let o = offs[h]; let a = u32(ACT[ax + ${PZ.act}u + h]); let m = lse[h];
      var Hh = 0.0;
      for (var j = 0u; j < ns[h]; j++) { let p = exp(ACT[z + o + j] - m.x) / m.y; Hh -= p * log(max(p, 1.0e-30)); }
      for (var j = 0u; j < ns[h]; j++) {
        let p = exp(ACT[z + o + j] - m.x) / m.y;
        let dpg = g * (select(0.0, 1.0, j == a) - p);
        let dent = ${K.PPO.ent} * p * (log(max(p, 1.0e-30)) + Hh);
        ACT[${A.dZ}u + i * ${K.NLOGIT}u + o + j] = (dpg + dent) / ${f(K.MB)};
      }
      ent += Hh;
    }
    let v = ACT[${A.V}u + i]; let ret = ACT[ax + ${PZ.ret}u];
    ACT[${A.dV}u + i] = ${K.PPO.vf} * (v - ret) / ${f(K.MB)};
    ACT[ax + ${PZ.pg}u] = -min(s1, s2); ACT[ax + ${PZ.vl}u] = 0.5 * (v - ret) * (v - ret); ACT[ax + ${PZ.ent}u] = ent;
    ACT[ax + ${PZ.clip}u] = select(0.0, 1.0, abs(ratio - 1.0) > ${K.PPO.clip});`)],
  ...bwd('pbw', [[K.NA, A.X, A.H1, A.H2, A.dZ, A.dH2, A.dH1, 'tanh'], [K.NC, A.X, A.H1c, A.H2c, A.dV, A.dH2c, A.dH1c, 'tanh']], K.MB, K.KS_PPO),
  ['p_gsum', gsum(0, K.NC.end, K.KS_PPO)],
  // global grad-norm clip over actor + critic (two-level, fixed order)
  ['gn_part', ROWS(K.NGN, `
    let n = ${K.NC.end}u; let a0 = i * n / ${K.NGN}u; let a1 = (i + 1u) * n / ${K.NGN}u;
    var s = 0.0; for (var p = a0; p < a1; p++) { let g = NET[${K.nG}u + p]; s += g * g; }
    NET[${K.nS + K.SC.gpart}u + i] = s;`)],
  ['gn_fin', one(`
  var s = 0.0; for (var c = 0u; c < ${K.NGN}u; c++) { s += NET[${K.nS + K.SC.gpart}u + c]; }
  NET[${K.nS + K.SC.gscale}u] = min(1.0, ${K.PPO.maxNorm} / (sqrt(s) + 1.0e-6));
  NET[${K.nS + K.SC.stepPol}u] += 1.0;
  // display stats from every 16th row (64 of 1024): they only feed the panel
  var pg = 0.0; var vl = 0.0; var en = 0.0; var cf = 0.0;
  for (var q = 0u; q < ${K.MB / 16}u; q++) {
    let ax = ${A.AUX}u + q * 16u * ${AUXW}u;
    pg += ACT[ax + ${PZ.pg}u]; vl += ACT[ax + ${PZ.vl}u]; en += ACT[ax + ${PZ.ent}u]; cf += ACT[ax + ${PZ.clip}u];
  }
  WD[${H.pgLoss}u] = 0.9 * WD[${H.pgLoss}u] + 0.1 * pg / ${f(K.MB / 16)};
  WD[${H.vLoss}u] = 0.9 * WD[${H.vLoss}u] + 0.1 * vl / ${f(K.MB / 16)};
  WD[${H.entTrain}u] = 0.9 * WD[${H.entTrain}u] + 0.1 * en / ${f(K.MB / 16)};
  WD[${H.clipFrac}u] = 0.9 * WD[${H.clipFrac}u] + 0.1 * cf / ${f(K.MB / 16)};
  WD[${H.ppoS}u] += 1.0;
  if (u32(WD[${H.ppoS}u]) == ${K.PPO_STEPS}u) { WD[${H.ppoUpdates}u] += 1.0; }`)],
  ['p_adam', adam(0, K.NC.end, K.PPO.lr, K.PPO.eps, K.SC.stepPol, true)],
];
const RESET = [['d_reset', ROWS(K.ED, `
    envLoad(i + 1u, ${RN.dreamReset}u, u32(WD[${H.dreamDecisions}u]));
    if (i == 0u) { WD[${H.dreamT}u] = 0.0; }`)]];

// ---------- viewing dreams: futures from right now, drawn but never trained on ----------
// Same physics, policy and model of you, sampled independently: a fan of "what it imagines
// happens next". They use their own games, scratch rows and RNG streams.
const VE = 1 + K.ED;   // first viewing game
const trail = (i, step, s) => `${K.gTrail}u + ((${i}) * ${K.HVIZ + 1}u + (${step})) * 6u + (${s}) * 3u`;
const recordPoint = (i, e, step) => `for (var s = 0u; s < 2u; s++) {
      let tp = ${trail(i, step, 's')};
      WD[tp] = WD[tk(${e}, s, TX)]; WD[tp + 1u] = WD[tk(${e}, s, TY)]; WD[tp + 2u] = WD[tk(${e}, s, TEN)];
    }`;
const V_INIT = [['v_init', ROWS(K.NVIZ, `
    let e = ${VE}u + i;
    for (var q = 0u; q < ${K.SST}u; q++) { WD[eb(e) + q] = WD[eb(0u) + q]; }
    WD[eb(e) + ${E.vdone}u] = 0.0;
    ${recordPoint('i', 'e', '0u')}
    if (i == 0u) { WD[${H.vizStep}u] = 0.0; }`)]];
const V_STEP = [
  ['v_obs', ROWS(K.NVIZ, `
    let e = ${VE}u + i;
    let o = obsOf(e, 0u); let oh = obsOf(e, 1u);
    for (var j = 0u; j < ${K.OBS}u; j++) { ACT[${A.X}u + (${K.VR0}u + i) * ${K.OBS}u + j] = o[j]; ACT[${A.X}u + (${K.VR0 + K.NVIZ}u + i) * ${K.OBS}u + j] = oh[j]; }`)],
  ...fwd('vfw', [[K.NA, ACTOR, K.VR0, K.NVIZ, 'tanh'], [K.NM, MODEL, K.VR0 + K.NVIZ, K.NVIZ, 'relu']]),
  ['v_act', ROWS(K.NVIZ, `
    let e = ${VE}u + i; let step = u32(WD[${H.vizStep}u]);
    let key = u32(WD[${H.frame}u]) * ${K.HVIZ}u + step;
    var lp = 0.0;
    let a = sampleHeads(${A.Z}u + (${K.VR0}u + i) * ${K.NLOGIT}u, ${RN.vizAI}u, key, e, &lp);
    let h = sampleHeads(${A.Z}u + (${K.VR0 + K.NVIZ}u + i) * ${K.NLOGIT}u, ${RN.vizYou}u, key, e, &lp);
    if (WD[eb(e) + ${E.vdone}u] < 0.5) {
      for (var k = 0u; k < ${K.REPEAT}u; k++) {
        let b0 = bearing(e, 0u); let b1 = bearing(e, 1u);
        _ = tickEnv(e, vec2f(f32(a[0]) - 1.0, f32(h[0]) - 1.0), vec2f(f32(a[1]) - 1.0, f32(h[1]) - 1.0),
                    vec2f(b0 + aimOff(a[2]), b1 + aimOff(h[2])), vec2<bool>(a[3] == 1u, h[3] == 1u));
        if (envDone(e)) { WD[eb(e) + ${E.vdone}u] = 1.0; break; }
      }
    }
    ${recordPoint('i', 'e', 'step + 1u')}`)],
  ['v_bump', one(`WD[${H.vizStep}u] += 1.0;`)],
];

// ---------- the frame program ----------
// Each block is guarded by a uniform flag or repeated a uniform number of times, so the
// megakernel and the naive encoder walk exactly the same sequence.
export const PROGRAM = [
  { flag: 'decide', ops: REAL_DECIDE },
  { ops: REAL_TICK },
  { flag: 'bc', ops: BC_STEP },
  { loop: 'nCollect', ops: COLLECT },
  { flag: 'gae', ops: GAE },
  { loop: 'nPPO', ops: PPO_STEP },
  { flag: 'reset', ops: RESET },
  { flag: 'viz', ops: V_INIT },
  { loop: 'nViz', ops: V_STEP },
];

const ALL = new Map();
for (const blk of PROGRAM) for (const [n, o] of blk.ops) {
  if (ALL.has(n) && ALL.get(n) !== o) throw new Error(`kernels: two different ops named ${n}`);
  ALL.set(n, o);
}
export const OP_TASKS = Object.fromEntries([...ALL].map(([n, o]) => [n, o.tasks]));

export function buildWGSL(WG) {
  const fns = [...ALL].map(([n, o]) => `fn ${n}(t: u32, nt: u32) {\n  for (var ti = t; ti < ${o.tasks}u; ti += nt) {\n${o.task('ti')}\n  }\n}`).join('\n');
  const entries = [...ALL.keys()].map((n) => `@compute @workgroup_size(${NAIVE_WG}) fn k_${n}(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) w: vec3u) { ${n}(g.x, w.x * ${NAIVE_WG}u); }`).join('\n');
  const body = PROGRAM.map((blk) => {
    const inner = blk.ops.map(([n]) => `${n}(t, nt); sync();`).join('\n    ');
    if (blk.flag) return `if (u.${blk.flag} == 1u) {\n    ${inner}\n  }`;
    if (blk.loop) return `for (var rep = 0u; rep < u.${blk.loop}; rep++) {\n    ${inner}\n  }`;
    return inner;
  }).join('\n  ');
  return `${HEADER}
${fns}
${entries}
// storage-only scratch (no var<workgroup>), and storageBarrier is also a control barrier
fn sync() { storageBarrier(); }
@compute @workgroup_size(${WG}) fn mega(@builtin(local_invocation_index) t: u32) {
  let nt = ${WG}u;
  ${body}
}
`;
}
