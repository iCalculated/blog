// The defender's reply in a play-out, for the puzzle page (app.js defenderTurn) and Rush (rush.js) alike: Syntaks in
// the browser, else crux's /api/defend, else Tiltak in the browser (never on 6×6: tiltak.js supports). Moved out of app.js unchanged (same engines, same
// requests, same time limits), so both pages play the same defence. po: the play-out (playon.js playOutOf), whose
// local, slowLocal, ctl and fallback fields this keeps as the page did.
import * as tiltak from './tiltak.js?v=1795581795';
import * as syntaks from './syntaks.js?v=1795581795';
import { api } from './api.js?v=1795581795';
import { legalMove, ENGINE_MS, CAP_WAIT_MS } from './playon.js?v=1795581795';

// Syntaks's reply. It runs in the browser (syntaks.js, loaded when play-on starts; 1.5 s a reply). Until it has loaded,
// or on a device too slow for a real defence (fewer than LOCAL_MIN_NODES in that time), crux answers (/api/defend,
// 8 s). With neither, Tiltak in the browser defends the rest of the game, which is then unrated (playon.js gameRated).
export const LOCAL_MIN_NODES = 150e3; // ~100k nodes/s: a fraction of crux's ~2.6M nodes per reply
// x: the puzzle page's boundary for a visit under a symmetry (pagesym.js toServer): crux gets the position in the puzzle's
// own orientation and its move comes back turned, so its cache and allowance see an ordinary visit. Rush passes none
// (its turned position goes as it always has); the in-browser search sees the position as shown.
export async function syntaksReply(po, tps, komi, live, x = null) {
  const legal = (r) => (r && legalMove(po.g, r.move) ? r : null);
  // Each in-browser search gets its 1.5 s plus 3 s (a worker the browser killed never answers); waiting for the
  // download (crux didn't answer) gets 20 s. Past either, crux or Tiltak defends.
  const within = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(res, ms, null))]);
  const local = (wait = 0) => within(syntaks.search({ tps, komi, ms: 1500, nodes: 1.5e6 }), ENGINE_MS.local + wait)
    .then((r) => legal(r && { ...r, src: 'browser' }), () => null);
  const server = () => {
    po.ctl = new AbortController(); // aborted when the game ends, so crux drops the search
    return api(`/api/defend?tps=${encodeURIComponent(x ? x.tps(tps, komi) : tps)}&komi=${komi}`, null, { quiet: true, timeout: ENGINE_MS.crux, signal: po.ctl.signal })
      .then((r) => legal(r && { ...(x ? x.answer(r) : r), src: 'crux' }), () => null);
  };
  let r = null;
  if (po.local && syntaks.status() === 'ready' && !po.slowLocal) {
    r = await local();
    if (!live()) return null;
    // this device: crux for the next replies (only a search that used its time on an undecided position says so)
    if (r && r.nodes < LOCAL_MIN_NODES && r.mate == null && r.ms >= 1200) po.slowLocal = true;
  }
  if (!r) { r = await server(); if (!live()) return null; }
  if (!r && po.local && syntaks.status() !== 'failed') { r = await local(ENGINE_MS.download); if (!live()) return null; } // waits for the download
  if (r) console.debug(`play-on: Syntaks (${r.src}) ${r.move}, ${r.nodes ?? '?'} nodes, ${r.ms} ms`);
  return r;
}

// The defender's move in po.g (tps), from defenderTurn: { mv } (legal, canonical); { end: 'proved' } when Syntaks
// dropped out of a proven play-out (no playing it out against Tiltak: the proven move is the solve); { end: 'noengine' }
// when no engine moved (po.fallback set); null once live() is false. onFallback: Syntaks dropped out of an unproven
// play-out and Tiltak takes over (po.fallback, po.fallbackAt set), for the page to redraw. Never on 6×6 (tiltak.js
// supports: no Tiltak there): Syntaks dropping out of a 6×6 play-out is { end: 'noengine' }. reply: Syntaks's reply,
// syntaksReply unless the caller wraps it.
export async function defenderMove(po, { size, komi, tps, live, onFallback = () => {}, reply = syntaksReply }) {
  let mv = null;
  if (po.engine === 'syntaks' && !po.fallback) {
    const r = await reply(po, tps, komi, live);
    if (!live()) return null;
    mv = r && legalMove(po.g, r.move);
    if (!mv && po.proven) return { end: 'proved' };
    if (!mv) { po.fallback = true; po.fallbackAt = po.mine; if (tiltak.supports(size, komi)) onFallback(); }
  }
  if (!mv && tiltak.supports(size, komi)) {
    // (a worker that never answers mustn't stall the game: 6 s from when it's up (a cold start, fetching and compiling
    // the wasm, gets 20 s of its own, as Syntaks's download does), then it's as if no engine could move)
    const up = await Promise.race([Promise.resolve().then(tiltak.warmup).then(() => true, () => false), new Promise((res) => setTimeout(res, ENGINE_MS.tiltakUp, false))]);
    if (!live()) return null;
    const t = up && await Promise.race([tiltak.analyze({ tps, size, komi, ms: 1500 }).catch(() => null), new Promise((res) => setTimeout(res, ENGINE_MS.tiltak, null))]);
    if (!live()) return null;
    mv = legalMove(po.g, t?.bestmove);
  }
  if (!mv) { po.fallback = true; return { end: 'noengine' }; }
  return { mv };
}

// Starting a play-out's engines (app.js startPlayOn): the in-browser Syntaks is fetched on first use (crux answers
// meanwhile), or Tiltak is started while the board settles. Sets po.local.
export function warmDefender(po, size, komi) {
  po.local = po.engine === 'syntaks' && syntaks.supports(size, komi);
  if (po.local) syntaks.load(); // the in-browser engine, fetched on first use (crux answers meanwhile)
  else if (po.engine === 'tiltak') Promise.resolve().then(tiltak.warmup).catch(() => {}); // it defends here: start it while the board settles
}

// A timeout that counts only time the page is visible (as checkStill's deadline does): { done, cancel }.
export function visibleTimeout(ms) {
  let t, left = ms, from = performance.now(), finish;
  const done = new Promise((resolve) => {
    const vis = () => { const now = performance.now(); if (document.hidden) left -= now - from; from = now; };
    const tick = () => {
      const now = performance.now(); if (!document.hidden) left -= now - from; from = now;
      if (left <= 0) return finish(); t = setTimeout(tick, Math.max(left, 1e3));
    };
    finish = () => { clearTimeout(t); document.removeEventListener('visibilitychange', vis); resolve(); };
    document.addEventListener('visibilitychange', vis);
    t = setTimeout(tick, ms);
  });
  return { done, cancel: () => finish() };
}

// At the move limit, the wait for what could raise it (playon.js capWait: why is 'length' or 'proof'), for the puzzle
// page's playOnMove and Rush's alike: the proof's length (po.lengthP) or the check's final answer (final), within
// CAP_WAIT_MS[why] of visible time (a locked phone freezes the check, so it freezes this too). Settles a microtask
// after, so the check's own handler (makeProven) runs first.
export async function waitAtCap(po, why, final) {
  const timeout = visibleTimeout(CAP_WAIT_MS[why]);
  await Promise.race([why === 'length' ? po.lengthP : final, timeout.done]);
  timeout.cancel();
  await Promise.resolve();
}
