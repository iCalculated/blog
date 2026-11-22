// Syntaks (6×6 NNUE engine by Ciekce and contributors, MIT; github.com/Ciekce/syntaks) with chef's cnet023 net, in a Web Worker.
// syntaks.wasm is built by wasm/syntaks/build.sh: wasm32-wasip1, single-threaded, TEI lines in through tk_command,
// output on stdout. This file is the host: a six-call WASI shim (clock, stdout, random, env, exit) and a TEI loop.
//
//   → { type: 'init', url }                         ← { type: 'ready', bootMs } | { type: 'error', error }
//   → { id, type: 'go', tps, halfKomi, ms, nodes }  ← { id, type: 'result', bestmove, info, ms } | { id, type: 'error' }
// A search runs to completion inside tk_command (no 'stop' mid-search), so the limits are what bound it.
let ex = null, outBuf = '', lines = [], errBuf = '', errs = [];
const enc = new TextEncoder(), dec = new TextDecoder();
const view = () => new DataView(ex.memory.buffer); // fresh each time: memory.grow detaches old buffers

const wasi = {
  clock_time_get(id, _precision, out) { // 0 realtime, else monotonic; nanoseconds
    const ms = id === 0 ? Date.now() : performance.now();
    view().setBigUint64(out, BigInt(Math.round(ms * 1e6)), true);
    return 0;
  },
  fd_write(fd, iovs, n, written) {
    const v = view();
    let total = 0;
    for (let i = 0; i < n; i++) {
      const p = v.getUint32(iovs + 8 * i, true), len = v.getUint32(iovs + 8 * i + 4, true);
      if (fd === 1) outBuf += dec.decode(new Uint8Array(ex.memory.buffer, p, len), { stream: true });
      else if (fd === 2) errBuf += new TextDecoder().decode(new Uint8Array(ex.memory.buffer, p, len));
      total += len;
    }
    v.setUint32(written, total, true);
    let k;
    while ((k = outBuf.indexOf('\n')) >= 0) { lines.push(outBuf.slice(0, k).trim()); outBuf = outBuf.slice(k + 1); }
    while ((k = errBuf.indexOf('\n')) >= 0) { errs.push(errBuf.slice(0, k).trim()); errBuf = errBuf.slice(k + 1); }
    return 0;
  },
  random_get(p, len) {
    for (let o = 0; o < len; o += 65536) crypto.getRandomValues(new Uint8Array(ex.memory.buffer, p + o, Math.min(65536, len - o)));
    return 0;
  },
  environ_sizes_get(count, size) { const v = view(); v.setUint32(count, 0, true); v.setUint32(size, 0, true); return 0; },
  environ_get() { return 0; },
  proc_exit(code) { throw new Error('syntaks exited ' + code); },
};

// One TEI line; returns what the engine printed for it.
function tei(line) {
  const b = enc.encode(line), p = ex.tk_alloc(b.length);
  new Uint8Array(ex.memory.buffer, p, b.length).set(b);
  lines = [];
  ex.tk_command(p, b.length);
  ex.tk_free(p, b.length);
  return lines;
}

// The last complete iteration's info line (a bounded one is from an unfinished iteration).
function parseInfo(ls) {
  let last = null, exact = null;
  for (const line of ls) {
    if (!line.startsWith('info ') || !line.includes(' score ')) continue;
    const t = line.split(' '), get = (k) => { const i = t.indexOf(k); return i < 0 ? null : t[i + 1]; };
    const s = t.indexOf('score'), pvAt = t.indexOf('pv'), wdlAt = t.indexOf('wdl');
    const info = {
      depth: +get('depth') || 0, nodes: +get('nodes') || 0,
      cp: t[s + 1] === 'cp' ? +t[s + 2] : null, mate: t[s + 1] === 'mate' ? +t[s + 2] : null,
      wdl: wdlAt < 0 ? null : t.slice(wdlAt + 1, wdlAt + 4).map(Number), pv: pvAt < 0 ? [] : t.slice(pvAt + 1),
    };
    last = info;
    if (!t.includes('lowerbound') && !t.includes('upperbound')) exact = info;
  }
  return exact || last;
}

let halfKomi = null;
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      const t0 = performance.now();
      const imports = { wasi_snapshot_preview1: wasi };
      const res = await fetch(data.url);
      if (!res.ok) throw new Error('syntaks.wasm: HTTP ' + res.status);
      const { instance } = WebAssembly.instantiateStreaming && (res.headers.get('content-type') || '').includes('wasm')
        ? await WebAssembly.instantiateStreaming(res, imports)
        : await WebAssembly.instantiate(await res.arrayBuffer(), imports);
      ex = instance.exports;
      ex._initialize?.();
      tei('tei');
      // A phone-sized hash; MateScores so a found forced win is reported as one; HumanWDL as on the server.
      tei('setoption name Hash value 16'); tei('setoption name MateScores value true'); tei('setoption name HumanWDL value true');
      self.postMessage({ type: 'ready', bootMs: Math.round(performance.now() - t0) });
    } catch (e) {
      self.postMessage({ type: 'error', error: String(e.message || e) });
    }
    return;
  }
  if (data.type === 'go') {
    try {
      // Komi changes every evaluation, so the hash goes with it (as on the server).
      if (halfKomi !== data.halfKomi) { tei(`setoption name HalfKomi value ${data.halfKomi}`); tei('teinewgame 6'); halfKomi = data.halfKomi; }
      // A position Syntaks can't parse is only a warning on stderr, after which it would search the previous one.
      errs = [];
      tei(`position tps ${data.tps}`);
      if (errs.length) throw new Error('syntaks rejected the position: ' + errs[0]);
      const t0 = performance.now();
      const out = tei(`go ${data.nodes ? `nodes ${data.nodes} ` : ''}movetime ${data.ms}`);
      const best = out.find((l) => l.startsWith('bestmove'));
      self.postMessage({ id: data.id, type: 'result', bestmove: best ? best.split(/\s+/)[1] : null, info: parseInfo(out), ms: Math.round(performance.now() - t0) });
    } catch (e) {
      self.postMessage({ id: data.id, type: 'error', error: String(e.message || e) });
    }
  }
};
