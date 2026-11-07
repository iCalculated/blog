// Main-thread handle for Tiltak, a strong Tak engine by Morten Lohne (GPL-3.0; see tiltak/NOTICE).
// Tiltak is MCTS with a trained linear value/policy evaluation, so it gives a positional opinion
// (who's better, what's the plan) where engine.js only proves forced wins.
//
//   const r = await analyze({ tps, komi: 2, ms: 1500, onInfo: (r) => draw(r) });
//   // r = { scoreCp, winProb, wdl, pv, bestmove, nodes, depth, ... }  or null if superseded
//
// Perspective: scoreCp and winProb are from WHITE's point of view (positive / >0.5 = White better).
// Tiltak itself reports from the side to move; scoreStm keeps that raw number.
// Scale: Tiltak's "cp" is not centipawns. It is 200·p − 100 where p is the MCTS expected score of the
// best move for the side to move, so it always lies in [−100, 100]; winProb = (scoreCp + 100) / 200.
// wdl is always null: this build doesn't emit WDL (and Tiltak's newer builds only fake it as [p, 0, 1−p]).
//
// Cancellation: a new analyze() stops the previous search; the previous promise resolves to null.
// stop() ends the current search early and its promise resolves with what was found so far.
// Supported: sizes 4, 5, 6; komi 0 and 2 (the only komi Tiltak has trained weights for). Other komi
// values are rounded to the nearest of those and reported in komiUsed / komiApprox.

export const SUPPORTED = Object.freeze({ sizes: [4, 5, 6], komi: [0, 2] });
export const supports = (size, komi = 0) => SUPPORTED.sizes.includes(size) && (komi == null || komi >= -5 && komi <= 5);

const workerURL = new URL('./tiltak/worker.js' + (import.meta.url.match(/\?v=[\w.]+/)?.[0] || ''), import.meta.url);

let worker = null, readyP = null, seq = 0;
let job = null; // { id, resolve, reject, onInfo, ctx, last, nodesMode, posted, stopReq }

function spawn() {
  if (worker) return readyP;
  const w = worker = new Worker(workerURL, { type: 'module' });
  readyP = new Promise((resolve, reject) => {
    // Events from a worker we already replaced (e.g. the trap's 'error' that lands after 'crashed') are ignored,
    // otherwise they would kill the fresh worker and fail the next search.
    w.onmessage = ({ data }) => {
      if (w !== worker) return;
      if (data.type === 'ready') return resolve(data.bootMs);
      onMessage(data);
    };
    w.onerror = (e) => {
      const err = new Error('Tiltak worker failed: ' + (e.message || 'load error'));
      reject(err);
      if (w === worker) crash(err);
    };
  });
  readyP.catch(() => {});
  return readyP;
}

function crash(err) {
  if (worker) worker.terminate();
  worker = null; readyP = null;
  const j = job; job = null;
  if (j) j.reject(err);
}

function onMessage(m) {
  if (m.type === 'crashed') return crash(new Error('Tiltak crashed: ' + m.message));
  if (!job || m.id !== job.id) return; // stale message from a superseded search
  if (m.type === 'info') {
    job.last = shape(m.info, job.ctx);
    job.onInfo?.(job.last);
  } else if (m.type === 'done') {
    const r = { ...(m.info ? shape(m.info, job.ctx) : shape({ pv: [] }, job.ctx)), bestmove: canonPTN(m.bestmove), stopped: m.stopped };
    const j = job; job = null;
    j.resolve(r);
  } else if (m.type === 'error') {
    const j = job; job = null;
    j.reject(new Error(m.message));
  }
}

function shape(info, ctx) {
  const stm = info.cp ?? null;
  const white = stm == null ? null : ctx.whiteToMove ? stm : -stm;
  const pv = (info.pv || []).map(canonPTN);
  return {
    scoreCp: white,
    scoreStm: stm,
    winProb: white == null ? null : (white + 100) / 200,
    wdl: info.wdl ? (ctx.whiteToMove ? info.wdl : info.wdl.slice().reverse()) : null,
    pv,
    bestmove: pv[0] ?? null,
    nodes: info.nodes ?? 0,
    depth: info.depth ?? 0,
    seldepth: info.seldepth ?? 0,
    timeMs: info.time ?? 0,
    nps: info.nps ?? 0,
    sideToMove: ctx.whiteToMove ? 'white' : 'black',
    komiUsed: ctx.komiUsed,
    komiApprox: ctx.komiApprox,
  };
}

// Tiltak already prints standard PTN (a1, Sa1, Cb2, 3c3>12, 2d4-); this only canonicalises the optional
// bits so its moves compare equal to Game.moveToPTN(): no "F", no count of 1, no lone drop equal to the count.
export function canonPTN(m) {
  if (!m) return m;
  let s = m.replace(/['"!?*]+$/, '').replace(/^F/, '');
  const mv = /^(\d?)([a-h][1-8])([<>+-])(\d*)$/.exec(s);
  if (!mv) return s;
  let [, c, sq, dir, drops] = mv;
  const count = c ? +c : 1;
  if (drops.length === 1 && +drops === count) drops = '';
  return (count > 1 ? count : '') + sq + dir + drops;
}

function nearestKomi(k) {
  return SUPPORTED.komi.reduce((best, x) => (Math.abs(x - k) < Math.abs(best - k) ? x : best));
}

/** Boot the engine ahead of time (≈ wasm compile). Resolves to boot time in ms. */
export const warmup = () => spawn();

/**
 * Analyze a TPS position. Resolves to the final result, or null if a newer analyze() superseded it.
 * @param {{ tps: string, size?: number, komi?: number, ms?: number, nodes?: number, onInfo?: (r) => void }} opts
 */
export function analyze({ tps, size, komi = 0, ms = 1500, nodes, onInfo } = {}) {
  tps = String(tps || '').trim().replace(/^\[TPS\s+"?/i, '').replace(/"?\]$/, '').trim();
  size = size || tps.split(/\s+/)[0].split('/').length;
  const whiteToMove = tps.split(/\s+/)[1] !== '2';
  const komiUsed = nearestKomi(+komi || 0);
  const ctx = { whiteToMove, komiUsed, komiApprox: komiUsed !== (+komi || 0) };

  // Supersede the previous search.
  if (job) {
    const old = job; job = null;
    old.resolve(null);
    // A 'go nodes' search never yields to the worker's event loop, so it can't hear 'stop': restart instead.
    if (old.nodesMode && worker) { worker.terminate(); worker = null; readyP = null; }
  }
  if (!SUPPORTED.sizes.includes(size)) return Promise.reject(new Error(`Tiltak supports sizes 4, 5 and 6 only (got ${size})`));

  const id = ++seq;
  const p = new Promise((resolve, reject) => { job = { id, resolve, reject, onInfo, ctx, last: null, nodesMode: nodes > 0, posted: false, stopReq: false }; });
  // Return p right away; never make the caller wait on boot. If this worker dies or is replaced before it is
  // ready, readyP never settles, but whoever killed it (crash / terminate / supersede) has already settled p.
  let booting;
  try { booting = spawn(); } catch (e) { crash(e); return p; }
  booting.then(() => {
    if (!job || job.id !== id || !worker) return; // superseded or killed while booting
    worker.postMessage({ type: 'analyze', id, tps, size, halfKomi: komiUsed * 2, ...(nodes > 0 ? { nodes } : { ms }) });
    job.posted = true;
    if (job.stopReq) worker.postMessage({ type: 'stop' }); // stop() arrived during boot
  }, () => {}); // a boot failure has already rejected p via crash()
  return p;
}

/** End the current search early; its analyze() promise resolves with the best result so far. */
export function stop() {
  if (!job || !worker) return;
  if (job.nodesMode) { const j = job; job = null; worker.terminate(); worker = null; readyP = null; j.resolve(j.last && { ...j.last, stopped: true }); return; }
  if (!job.posted) { job.stopReq = true; return; }
  worker.postMessage({ type: 'stop' });
}

/** Kill the worker (frees ~20–60 MB of wasm memory). The next analyze() boots a fresh one. */
export function terminate() {
  if (job) { const j = job; job = null; j.resolve(null); }
  if (worker) worker.terminate();
  worker = null; readyP = null;
}

/** Debug hook: the raw Worker (send {type:'debug', on:true} / {type:'raw', line}). */
export const _worker = () => worker;
