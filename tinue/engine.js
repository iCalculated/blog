// Main-thread handle for the tactics engine. One worker per request type ('refute', 'analyze'), so a new request can
// kill a stale search of the same type immediately without disturbing the other. 'still' checks get a worker each.
const workers = {}, pending = {};
let seq = 0;

function workerFor(type) {
  if (workers[type]) return workers[type];
  const v = import.meta.url.match(/\?v=\d+/)?.[0] || '';
  const w = new Worker(new URL('./engine-worker.js' + v, import.meta.url), { type: 'module' });
  w.onmessage = ({ data }) => {
    const p = pending[type];
    if (!p || p.id !== data.id) return;
    if (data.partial) { p.partial = data; return; } // an interim answer, kept in case the search is killed
    pending[type] = null; p.resolve(data);
  };
  return (workers[type] = w);
}

function stop(type) {
  const p = pending[type];
  if (!p) return;
  pending[type] = null;
  workers[type]?.terminate(); workers[type] = null; // abandon the old search outright
  p.resolve(null);
}

function ask(type, payload) {
  stop(type); // newest request wins
  const id = ++seq;
  return new Promise((resolve) => {
    pending[type] = { id, resolve };
    workerFor(type).postMessage({ id, type, ...payload });
  });
}

// Why a miss fails. The worker stops trying replies after `ms` and answers with what it has; past `ms` + 2 s (one reply's
// search still running) it is killed and the answer is 'unknown' ("X doesn't force the win").
export const refute = (pos, ms = 8000) => Promise.race([ask('refute', { ...pos, ms }), new Promise((r) => setTimeout(r, ms + 2000, 'late'))])
  .then((r) => {
    if (r !== 'late') return r;
    const partial = pending.refute?.partial; // a refutation found before the reply still being searched at the kill
    stop('refute');
    return partial ? { kind: partial.kind, reply: partial.reply, exact: false } : { kind: 'unknown' };
  });
// Does an off-tree move still force a win? `quick` settles within `quickMs`: 'wins', 'no', or 'pending' when the
// search hasn't finished. `final` lets the same search run on with bigger budgets for up to `maxMs`: 'wins', 'no', or
// 'unknown' (out of time or budget). A timeout is never a 'no': a real win can take ~20 s on a slow device
// (pd616580). Each check has its own worker, so a later check can't kill it; cancel() ends it. The budgets are small
// because the search keeps every node (~28 KB per full-defense node: 25k nodes is ~700 MB), and the clock only runs
// while the page is visible (a locked phone freezes the search, not the deadline).
export function checkStill(pos, { quickMs = 2500, maxMs = 60e3, budgets = [[3e4, 2.5e4], [1e5, 2.5e4]] } = {}) {
  const v = import.meta.url.match(/\?v=\d+/)?.[0] || '';
  const w = new Worker(new URL('./engine-worker.js' + v, import.meta.url), { type: 'module' });
  let end;
  const final = new Promise((resolve) => {
    let t, left = maxMs, from = performance.now();
    // Only visible time counts: `from` is re-anchored on every visibility change, and a span is subtracted only if
    // the page was visible through it.
    const used = () => { const now = performance.now(); if (!document.hidden) left -= now - from; from = now; };
    const tick = () => {
      used();
      if (left <= 0) return end('unknown');
      t = setTimeout(tick, Math.max(left, 2e3));
    };
    t = setTimeout(tick, maxMs);
    const vis = () => { const now = performance.now(); if (document.hidden) left -= now - from; from = now; };
    document.addEventListener('visibilitychange', vis);
    end = (kind) => { clearTimeout(t); document.removeEventListener('visibilitychange', vis); w.terminate(); resolve(kind); end = () => {}; };
    w.onmessage = ({ data }) => end(data.kind === 'wins' || data.kind === 'no' ? data.kind : 'unknown');
    w.onerror = () => end('unknown');
    w.postMessage({ id: 1, type: 'still', ...pos, budgets });
  });
  const quick = Promise.race([final, new Promise((r) => setTimeout(r, quickMs, 'pending'))]);
  return { quick, final, cancel: () => end('unknown') };
}
export const analyze = (pos) => ask('analyze', pos);
export const interrupt = () => { stop('refute'); stop('analyze'); };
