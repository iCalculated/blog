// Scripted opponents (ports of rl/scripts.py) that drive the other tank through the same
// input you use (throttle, turn, an aim point the turret swings toward at 10°/tick, fire).
// They read the last readback of the real game, so they see the world a frame or two late.
import * as K from './consts.js';

const wrap = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const maxTurn = (v) => ((K.TURN0 - K.TURNV * Math.abs(v)) * Math.PI) / 180;
function ray(x, y, a) {
  const c = Math.cos(a), s = Math.sin(a); let tx = 1e4, ty = 1e4;
  if (c > 1e-6) tx = (K.AW - K.HALF - x) / c; else if (c < -1e-6) tx = (K.HALF - x) / c;
  if (s > 1e-6) ty = (K.AH - K.HALF - y) / s; else if (s < -1e-6) ty = (K.HALF - y) / s;
  return Math.max(Math.min(tx, ty), 0);
}
const tank = (W, s) => { const b = K.gEnv + K.E.tank + s * 8; return { x: W[b], y: W[b + 1], h: W[b + 2], v: W[b + 3], dh: W[b + 6] }; };
// where to aim so a bullet meets the target if it keeps its speed (and, if circular, its turn rate)
function lead(me, op, circular) {
  let qx = op.x, qy = op.y, qh = op.h;
  for (let i = 1; i < 150; i++) {
    if (circular) qh += op.dh;
    qx = clamp(qx + Math.cos(qh) * op.v, K.HALF, K.AW - K.HALF);
    qy = clamp(qy + Math.sin(qh) * op.v, K.HALF, K.AH - K.HALF);
    if (i * K.BSPEED >= Math.hypot(qx - me.x, qy - me.y)) break;
  }
  return { x: qx, y: qy };
}
// tank controls toward an angle, backing up when that's quicker
function drive(me, want) {
  let diff = wrap(want - me.h), thr = 1;
  if (Math.abs(diff) > Math.PI / 2) { diff = wrap(diff + Math.PI); thr = -1; }
  return { thr: thr * (Math.abs(diff) < 0.8 ? 1 : 0.4), turn: clamp(diff / maxTurn(me.v), -1, 1) };
}

export const BOT_NOTES = {
  strafer: 'orbits at ~350 px and reverses on a ~1.2 s rhythm; leads its shots assuming you keep turning',
  dodger: 'orbits and reverses when one of your bullets is about to arrive; leads assuming you go straight',
  rusher: 'charges to close range, then circles you tightly; fires straight at you',
  wanderer: 'random throttle and turn held for 0.5–1.5 s; sloppy aim',
};

export function makeBot(name) {
  let dir = Math.random() < 0.5 ? 1 : -1, timer = 0, thr = 0, turn = 0;
  const geo = (W) => {
    const me = tank(W, 1), op = tank(W, 0);
    return { me, op, th: Math.atan2(op.y - me.y, op.x - me.x), d: Math.hypot(op.x - me.x, op.y - me.y) };
  };
  const orbit = (g, goal) => g.th + dir * (Math.PI / 2 - clamp((g.d - goal) / 300, -0.5, 0.5));
  const blocked = (g, want) => ray(g.me.x, g.me.y, want) < 60;
  const out = (c, aim) => ({ thr: c.thr, turn: c.turn, mx: aim.x, my: aim.y, fire: true });

  const bots = {
    strafer(W) {
      const g = geo(W); timer--;
      if (timer <= 0 || blocked(g, orbit(g, 350))) { dir = -dir; timer = 55 + Math.random() * 30; }
      return out(drive(g.me, orbit(g, 350)), lead(g.me, g.op, true));
    },
    dodger(W) {
      const g = geo(W); timer--;
      let close = false;
      for (let j = 0; j < K.NBUL; j++) {   // the AI's bullets (side 0) heading at it, within 130 px
        const b = K.gEnv + K.E.bul + j * 5;
        if (W[b + 4] < 0.5) continue;
        const bx = g.me.x - W[b], by = g.me.y - W[b + 1];
        if (bx * bx + by * by < 130 * 130 && bx * W[b + 2] + by * W[b + 3] > 0) close = true;
      }
      if (timer <= 0 && (close || blocked(g, orbit(g, 350)))) { dir = -dir; timer = 25; }
      return out(drive(g.me, orbit(g, 350)), lead(g.me, g.op, false));
    },
    rusher(W) {
      const g = geo(W);
      if (blocked(g, orbit(g, 160))) dir = -dir;
      return out(drive(g.me, g.d > 240 ? g.th : orbit(g, 160)), g.op);
    },
    wanderer(W) {
      const g = geo(W); timer--;
      if (timer <= 0) { thr = Math.floor(Math.random() * 3) - 1; turn = Math.floor(Math.random() * 3) - 1; timer = 30 + Math.random() * 60; }
      const a = g.th + (Math.random() - 0.5) * K.MEA;
      return out({ thr, turn }, { x: g.me.x + Math.cos(a) * g.d, y: g.me.y + Math.sin(a) * g.d });
    },
  };
  return bots[name];
}
