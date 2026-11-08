// Tiltak (Morten Lohne, GPL-3.0) in a module worker, speaking TEI. See NOTICE and PROVENANCE.md.
//
// main → worker
//   { type: 'analyze', id, tps, size, halfKomi, ms }      search for ms milliseconds (stoppable)
//   { type: 'analyze', id, tps, size, halfKomi, nodes }   fixed-node search (NOT stoppable: Tiltak never
//                                                           yields during 'go nodes'; terminate the worker instead)
//   { type: 'stop' }                                      stop the current search (bestmove follows)
//   { type: 'raw', line }                                 send one raw TEI line (debugging only)
// worker → main
//   { type: 'ready', bootMs }
//   { type: 'info', id, info }       info = { depth, seldepth, nodes, cp, time, nps, pv: [...] } (cp is side-to-move)
//   { type: 'done', id, bestmove, info, stopped }
//   { type: 'error', id, message }   rejected before reaching the engine (engine still healthy)
//   { type: 'crashed', message }     the engine panicked; this worker is dead, make a new one
//   { type: 'line', line }           every raw TEI output line (only when debug is on)
//
// Rules this file enforces, because breaking them panics the engine:
//   - only 'stop' / 'isready' / 'quit' may be sent while a search runs; anything else panics
//   - sizes other than 4/5/6 panic ('Unsupported size'); malformed TPS panics (from_fen().unwrap())
//   - HalfKomi other than 0 or 4 is accepted by setoption but panics inside the evaluation
//   - a finished game (road, full board, a player out of pieces) panics the search: no best move at the root
//   - more pieces than the reserves underflows the reserve counters
import init, { start_engine } from './tiltak_wasm.js?v=1794121741';

const SIZES = new Set([4, 5, 6]);
const HALF_KOMIS = new Set([0, 4]); // the only komi values Tiltak has trained parameters for (0 and 2)

let send = null;          // TEI input callback from start_engine
let engineSize = null;    // size of the current 'teinewgame'
let engineHalfKomi = 0;   // Tiltak's default
let current = null;       // job being searched: { id, lastInfo, stopped }
let pending = null;       // newest job waiting for the current search to finish
let stopSent = false;
let dead = false;
let debug = false;
let teiOk = null;

// The panic hook reports through console.error before the wasm traps; treat that as fatal.
const origError = console.error.bind(console);
console.error = (...args) => {
  origError(...args);
  const msg = args.map(String).join(' ');
  if (/panicked at/.test(msg)) die(msg);
};
self.addEventListener('error', (e) => die(String(e.message || e)));
self.addEventListener('unhandledrejection', (e) => die(String(e.reason && (e.reason.stack || e.reason))));

function die(message) {
  if (dead) return;
  dead = true;
  self.postMessage({ type: 'crashed', message });
}

function tei(line) {
  if (dead) return;
  if (debug) self.postMessage({ type: 'line', line: '> ' + line });
  send(line);
}

function parseInfo(line) {
  const w = line.split(/\s+/);
  const info = { pv: [] };
  for (let i = 1; i < w.length; i++) {
    const k = w[i];
    if (k === 'pv') { info.pv = w.slice(i + 1); break; }
    if (k === 'score') {
      const kind = w[++i], v = +w[++i];
      if (kind === 'cp') info.cp = v; else if (kind === 'mate') info.mate = v;
      continue;
    }
    if (k === 'wdl') { info.wdl = [+w[i + 1], +w[i + 2], +w[i + 3]]; i += 3; continue; }
    if (i + 1 < w.length) info[k] = +w[++i];
  }
  return info;
}

function onLine(line) {
  if (debug) self.postMessage({ type: 'line', line });
  if (line === 'teiok') { teiOk?.(); return; }
  if (line.startsWith('info ')) {
    const info = parseInfo(line);
    if (current) { current.lastInfo = info; self.postMessage({ type: 'info', id: current.id, info }); }
    return;
  }
  if (line.startsWith('bestmove')) {
    const bestmove = line.split(/\s+/)[1] || null;
    const job = current;
    current = null;
    stopSent = false;
    if (job) self.postMessage({ type: 'done', id: job.id, bestmove, info: job.lastInfo || null, stopped: job.stopped });
    if (pending) { const p = pending; pending = null; start(p); }
  }
}

// Shape check strict enough that Tiltak's parser can't panic on it.
function validTPS(tps, size) {
  const parts = tps.trim().split(/\s+/);
  if (parts.length !== 3) return 'TPS must have 3 fields';
  const [board, player, move] = parts;
  if (!/^[12]$/.test(player)) return 'bad side to move';
  if (!/^[1-9]\d*$/.test(move)) return 'bad move number';
  const rows = board.split('/');
  if (rows.length !== size) return `TPS has ${rows.length} rows, expected ${size}`;
  const grid = []; // grid[r][c] = top-piece string ('', '1', '2S', '1C', ...); row order as in the TPS
  const used = [0, 0, 0], capsUsed = [0, 0, 0];
  for (const row of rows) {
    let n = 0;
    const g = [];
    for (const cell of row.split(',')) {
      const m = /^x(\d*)$/.exec(cell);
      if (m) { const k = m[1] ? +m[1] : 1; n += k; for (let i = 0; i < k; i++) g.push(''); continue; }
      if (!/^[12]+[SC]?$/.test(cell)) return `bad cell "${cell}"`;
      const digits = cell.replace(/[SC]$/, '');
      for (const d of digits) used[+d]++;
      if (cell.endsWith('C')) { used[+digits.at(-1)]--; capsUsed[+digits.at(-1)]++; }
      g.push(digits.at(-1) + (/[SC]$/.test(cell) ? cell.at(-1) : ''));
      n++;
    }
    if (n !== size) return `row "${row}" has ${n} squares, expected ${size}`;
    grid.push(g);
  }
  // Too many pieces would underflow Tiltak's reserve counters.
  const [stones, caps] = RESERVES[size];
  for (const c of [1, 2]) {
    if (used[c] > stones) return `player ${c} has ${used[c]} stones on the board, more than ${stones}`;
    if (capsUsed[c] > caps) return `player ${c} has ${capsUsed[c]} capstones, more than ${caps}`;
  }
  // A finished game panics Tiltak's search (no best move at the root), so refuse it here.
  for (const c of [1, 2]) if (hasRoad(grid, size, String(c))) return `game is already over (${c === 1 ? 'white' : 'black'} road)`;
  if (grid.every((g) => g.every((t) => t))) return 'game is already over (board full)';
  for (const c of [1, 2]) if (used[c] === stones && capsUsed[c] === caps) return `game is already over (${c === 1 ? 'white' : 'black'} has no pieces left)`;
  return null;
}

const RESERVES = { 4: [15, 0], 5: [21, 1], 6: [30, 1] };

function hasRoad(grid, n, color) {
  const road = (r, c) => { const t = grid[r][c]; return t[0] === color && !t.endsWith('S'); };
  const reach = (starts, done) => {
    const seen = new Set(), stack = starts.filter(([r, c]) => road(r, c));
    for (const [r, c] of stack) seen.add(r * n + c);
    while (stack.length) {
      const [r, c] = stack.pop();
      if (done(r, c)) return true;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n || seen.has(rr * n + cc) || !road(rr, cc)) continue;
        seen.add(rr * n + cc); stack.push([rr, cc]);
      }
    }
    return false;
  };
  const idx = [...Array(n).keys()];
  return reach(idx.map((c) => [0, c]), (r) => r === n - 1) || reach(idx.map((r) => [r, 0]), (_, c) => c === n - 1);
}

function start(job) {
  const { id, tps, size, halfKomi, ms, nodes } = job;
  const bad = !SIZES.has(size) ? `Tiltak supports sizes 4, 5 and 6 only (got ${size})`
    : !HALF_KOMIS.has(halfKomi) ? `Tiltak supports komi 0 and 2 only (got half-komi ${halfKomi})`
    : validTPS(tps, size)
    || (!(ms > 0 || nodes > 0) ? 'need ms or nodes' : null);
  if (bad) { self.postMessage({ type: 'error', id, message: bad }); if (pending) { const p = pending; pending = null; start(p); } return; }

  if (size !== engineSize) { tei(`teinewgame ${size}`); engineSize = size; }
  if (halfKomi !== engineHalfKomi) { tei(`setoption name HalfKomi value ${halfKomi}`); engineHalfKomi = halfKomi; }
  tei(`position tps ${tps.trim()}`);
  current = { id, lastInfo: null, stopped: false };
  tei(nodes > 0 ? `go nodes ${Math.floor(nodes)}` : `go movetime ${Math.max(1, Math.floor(ms))}`);
}

function stopCurrent() {
  if (current && !stopSent) { current.stopped = true; stopSent = true; tei('stop'); }
}

const queue = [];
self.onmessage = ({ data }) => (send ? handle(data) : queue.push(data));

function handle(msg) {
  if (dead) return;
  switch (msg.type) {
    case 'analyze':
      if (current) { pending = msg; stopCurrent(); } else start(msg);
      break;
    case 'stop':
      pending = null; stopCurrent();
      break;
    case 'raw':
      tei(msg.line);
      break;
    case 'debug':
      debug = !!msg.on;
      break;
  }
}

(async () => {
  const t0 = performance.now();
  // Fetch the bytes ourselves so a server that doesn't label .wasm as application/wasm doesn't matter.
  // Same ?v= as this worker's URL, so a new build never pairs fresh glue with a cached wasm.
  const v = import.meta.url.match(/\?v=[\w.]+/)?.[0] || '';
  const bytes = await (await fetch(new URL('./tiltak_wasm_bg.wasm' + v, import.meta.url))).arrayBuffer();
  await init({ module_or_path: bytes });
  const ok = new Promise((r) => { teiOk = r; });
  send = start_engine((line) => onLine(line));
  send('tei');
  await ok;
  self.postMessage({ type: 'ready', bootMs: performance.now() - t0 });
  for (const m of queue.splice(0)) handle(m);
})().catch((e) => die(String(e && (e.stack || e))));
