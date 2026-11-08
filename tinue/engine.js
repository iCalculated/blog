// Main-thread handle for the tactics engine. One worker per request type ('still', 'refute', 'analyze'), so a new
// request can kill a stale search of the same type immediately without disturbing the other.
const workers = {}, pending = {};
let seq = 0;

function workerFor(type) {
  if (workers[type]) return workers[type];
  const v = import.meta.url.match(/\?v=\d+/)?.[0] || '';
  const w = new Worker(new URL('./engine-worker.js' + v, import.meta.url), { type: 'module' });
  w.onmessage = ({ data }) => { const p = pending[type]; if (p && p.id === data.id) { pending[type] = null; p.resolve(data); } };
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

export const refute = (pos) => ask('refute', pos);
// Proof that an off-tree move still wins, or null after `ms` (the search is killed: a miss shouldn't wait long).
export const stillWins = (pos, ms = 2500) => Promise.race([ask('still', pos), new Promise((r) => setTimeout(r, ms, null))])
  .then((r) => { stop('still'); return r?.kind === 'wins'; });
export const analyze = (pos) => ask('analyze', pos);
export const interrupt = () => { stop('refute'); stop('analyze'); };
