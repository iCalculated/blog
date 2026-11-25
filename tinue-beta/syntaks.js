// Main-thread handle for Syntaks in the browser (the 6×6 NNUE engine by Ciekce and contributors, MIT, with chef's cnet023 net, shipped with
// his OK, 2026-11-15). syntaks/worker.js runs syntaks/syntaks.wasm (wasm/syntaks/build.sh) in a Web Worker.
//
//   await load();                                   // first use only: ~9.8 MB gzipped, then the browser's cache
//   const r = await search({ tps, komi: 2, ms: 1500 }); // -> { move, mate, winProb, depth, nodes, ms } or throws
//
// mate and winProb are from White's side, like /api/analyze. One search at a time; it can't be stopped midway (the
// limits bound it), so a search nobody wants any more just finishes and is dropped.
import { canonPTN } from './shared/ptn.js?v=1795581795';
import { syntaksBoard } from './shared/judge.js?v=1795581795';

// The engine build, not the site build: the 19.5 MB file only changes when the engine is rebuilt, so the browser keeps
// it across site deploys. build-static.sh stamps this with the wasm's own hash.
const ENGINE = '021c832f8fcc';
const workerURL = new URL('./syntaks/worker.js' + (import.meta.url.match(/\?v=[\w.]+/)?.[0] || ''), import.meta.url);
const wasmURL = new URL('./syntaks/syntaks.wasm?e=' + ENGINE, import.meta.url).href;

// WebAssembly with SIMD (every current browser; Safari since 16.4): the smallest module using a v128 op.
const SIMD = (() => {
  try { return typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch { return false; }
})();
export const supports = (size, komi) => SIMD && typeof Worker === 'function' && syntaksBoard(size, komi);

let worker = null, readyP = null, state = 'idle', seq = 0;
const waiting = new Map(); // id -> { resolve, reject }
export const status = () => state; // 'idle' | 'loading' | 'ready' | 'failed'

export function load() {
  if (readyP) return readyP;
  state = 'loading';
  readyP = new Promise((resolve, reject) => {
    const w = worker = new Worker(workerURL);
    const fail = (why) => {
      state = 'failed'; worker = null; w.terminate();
      for (const p of waiting.values()) p.reject(new Error(why));
      waiting.clear(); reject(new Error(why));
    };
    w.onerror = (e) => fail('syntaks worker: ' + (e.message || 'failed'));
    w.onmessage = ({ data }) => {
      if (data.type === 'ready') { state = 'ready'; resolve(data.bootMs); return; }
      if (data.type === 'error' && data.id == null) return fail(data.error);
      const p = waiting.get(data.id);
      if (!p) return;
      waiting.delete(data.id);
      if (data.type === 'error') { p.reject(new Error(data.error)); fail(data.error); } // a trap leaves the instance unusable
      else p.resolve(data);
    };
    w.postMessage({ type: 'init', url: wasmURL });
  });
  readyP.catch(() => {});
  return readyP;
}

/** Syntaks's move in a validated 6×6 TPS (komi in half-point steps): ms of search, at most `nodes`. */
export async function search({ tps, komi = 0, ms = 1500, nodes = 1.5e6 }) {
  await load();
  const id = ++seq;
  const r = await new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, type: 'go', tps, halfKomi: Math.round(komi * 2), ms, nodes });
  });
  const i = r.info, white = tps.split(' ')[1] !== '2', sgn = white ? 1 : -1;
  const wdl = i?.wdl && (white ? i.wdl : i.wdl.slice().reverse());
  const mate = i?.mate == null ? null : sgn * i.mate;
  return {
    move: r.bestmove ? canonPTN(r.bestmove) : null, mate,
    winProb: mate != null ? (mate > 0 ? 1 : 0) : wdl ? (wdl[0] + wdl[1] / 2) / 1000 : null,
    depth: i?.depth ?? 0, nodes: i?.nodes ?? 0, ms: r.ms,
  };
}
