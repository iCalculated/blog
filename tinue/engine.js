// Main-thread handle for the tactics engine. One worker per request type ('still', 'refute', 'analyze'), so a new
// request can kill a stale search of the same type immediately without disturbing the other.
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
// Proof that an off-tree move still wins, or null after `ms` (the search is killed: a miss shouldn't wait long).
export const stillWins = (pos, ms = 2500) => Promise.race([ask('still', pos), new Promise((r) => setTimeout(r, ms, null))])
  .then((r) => { stop('still'); return r?.kind === 'wins'; });
export const analyze = (pos) => ask('analyze', pos);
export const interrupt = () => { stop('refute'); stop('analyze'); };
