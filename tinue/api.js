// Talking to the puzzle server: api() with its timeouts and retries, the slow-request beacon, the server notice
// (slow or unreachable) that replaces the turn card, browser storage and the login token.

// The API can live elsewhere (static page on shydrie.xyz, API on crux): config.js sets TINUE_API.
// Auth is a bearer token from localStorage. The server also sets a cookie (used by same-origin dev; on
// tinue-api.shydrie.xyz it is same-site with the page and gets sent too), but honours it only from allowed origins
// (server.js userFrom), and the bearer token wins when both arrive.
export const API = (window.TINUE_API || '').replace(/\/$/, '');

export const store = {
  get(k, d) { try { const v = localStorage.getItem('tinue.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tinue.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('tinue.' + k); } catch {} },
};

// The token that identifies us to the server (kept in memory too, in case storage is unavailable). A first-time
// visitor has none until their first result (or claiming a name), whose answer brings it.
export let token = store.get('token', null);
export const setToken = (t) => {
  token = t;
  if (t) { store.set('token', t); store.del('guest'); store.del('seen'); } else store.del('token');
};
const authHeaders = () => (token ? { authorization: 'Bearer ' + token } : {});

// A random id for this browser (null if storage or crypto is unavailable). It links a guest's server row to the
// anonymous results older clients sent, and lets a guest whose token got lost on the way get its row back.
export const guestId = () => {
  let id = store.get('gid', null);
  if (typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) return id;
  try { id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''); } catch { return null; }
  store.set('gid', id);
  return store.get('gid', null) === id ? id : null;
};

export const WAIT_NOTICE = { kind: 'wait', title: 'Waiting for the puzzle server…', body: 'The server may be down; try again in a bit.' };
export let notice = null; // a message that replaces the turn card: {kind: 'wait' | 'net' | 'none', title, body}
// When the browser says it is offline at the moment the wait or can't-reach notice is shown, that notice says so
// instead (same kind, so it shows and clears exactly as before).
const offlineOr = (n) => ((n?.kind === 'wait' || n?.kind === 'net') && navigator.onLine === false
  ? { kind: n.kind, title: 'You seem to be offline', body: 'Puzzles will load again when your connection is back.' } : n);
export const setNotice = (n) => { notice = offlineOr(n); };
let redraw = () => {};
export const onNotice = (fn) => { redraw = fn; }; // how api() redraws the page after changing the notice

// timeout: one try with that budget (no retry), for callers with a fallback; signal: the caller may abort.
// keepalive: the request may outlive the page (a result sent as the tab closes).
export const api = async (path, body, { quiet = false, noWait = quiet, timeout, signal, keepalive = false } = {}) => {
  // If the server can't be reached, say so instead of showing a blank page. (On Shy's tailnet, Chrome asks for
  // "local network access" before a public page may call crux's private address; that prompt also stalls here.)
  const slow = noWait ? null : setTimeout(() => { notice = offlineOr(WAIT_NOTICE); redraw(); }, 4000);
  const t0 = performance.now();
  let outcome = 'ok', tries = 0, err; // err: the name of the last failed try's error (for the slow report)
  // A request stuck on a dead connection (e.g. the tailnet path to crux re-forming after sleep) is abandoned
  // after a while: reads are retried once, results (POSTs) just get longer before giving up.
  const once = async (ms) => {
    tries++;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
    const cancel = () => ctl.abort();
    signal?.addEventListener('abort', cancel);
    try {
      const r = await fetch(API + path, body
        ? { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(body), credentials: 'include', signal: ctl.signal, keepalive }
        : { headers: authHeaders(), credentials: 'include', signal: ctl.signal });
      return await r.json();
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  };
  try {
    let j;
    if (timeout) j = await once(timeout);
    else if (body) j = await once(20000);
    else try { j = await once(8000); } catch (e) { err = e?.name; outcome = 'retried'; j = await once(12000); }
    if (!quiet && (notice?.kind === 'wait' || notice?.kind === 'net')) { notice = null; redraw(); }
    return j;
  } catch (e) {
    err = e?.name;
    outcome = 'failed';
    if (quiet) throw e;
    notice = offlineOr({ kind: 'net', title: 'Can’t reach the puzzle server', body: 'Check your connection and reload. If it keeps happening, the server may be down.' });
    redraw();
    throw e;
  } finally {
    clearTimeout(slow);
    const ms = performance.now() - t0;
    // Engine analysis is slow by design (a ~1.2 s search, maybe queued) and aborted on purpose; not a network signal.
    if ((ms > 2000 || outcome !== 'ok') && path !== '/api/slow' && !path.startsWith('/api/analyze') && !path.startsWith('/api/defend')) reportSlow(path, ms, outcome, { err, tries });
    if (outcome !== 'failed') { lastOk = performance.now(); flushSlow(); } // the server answered: send what waited
  }
};

// Tell the server about requests that were slow from here, so its log shows what the network added. Besides the
// timing: err (AbortError = our timeout fired, TypeError = the fetch failed at the network level, SyntaxError = an
// answer that wasn't ours, e.g. a proxy's error page), the browser's view of the connection (online; conn where the
// browser has navigator.connection, not Safari), tries, sinceOk (ms since this tab last got an answer, -1 = never) and
// the build. Sent as a beacon (text/plain, no CORS preflight; survives the page closing) with the cookie, which the
// server honours from the page's origin (server.js userFrom). Not every player has that cookie on the API host (it is
// set only by login, register or a new token, and the API moved host on 2026-11-16), but a live report is about a
// request that reached the server, whose own access-log line carries the player's id.
let lastOk = -1; // performance.now() when an api() call last succeeded in this tab
export const reportSlow = (path, ms, outcome, { err, tries } = {}) => {
  try {
    const on = navigator.onLine, c = navigator.connection, build = +window.TINUE_BUILD || 0;
    const conn = c ? Object.fromEntries(['effectiveType', 'rtt', 'downlink', 'saveData'].filter((k) => c[k] != null).map((k) => [k, c[k]])) : null;
    const r = { path: path.split('?')[0], ms, outcome, hidden: document.visibilityState === 'hidden',
      ...(outcome !== 'ok' && err ? { err } : {}), ...(typeof on === 'boolean' ? { online: on } : {}), ...(conn ? { conn } : {}),
      ...(tries ? { tries } : {}), sinceOk: lastOk < 0 ? -1 : Math.round(performance.now() - lastOk), ...(build ? { build } : {}) };
    // A report made while the server can't be reached would be lost the same way: it waits for the connection.
    if (outcome === 'failed' || on === false) return queueSlow(r);
    const data = JSON.stringify(r);
    if (!navigator.sendBeacon?.(API + '/api/slow', data)) fetch(API + '/api/slow', { method: 'POST', body: data, credentials: 'include', keepalive: true }).catch(() => {});
  } catch {}
};

// The waiting reports: in storage (so a reload keeps them; shared by the tab's siblings), or in memory where storage
// is unavailable. At most SLOW_QMAX, oldest dropped; each {t: when made, r: report, n: failed flushes}. A flush takes
// the whole queue out first (so another tab can't send it too) and sends it as one batch, after the next api() call
// that succeeds and on the window's 'online' event. A flush that fails puts its reports back, each at most 3 times.
// These reports are about requests that never arrived, so the flush carries the same Authorization header as api()
// (never the token in the URL or body); that costs a CORS preflight, cached up to access-control-max-age (server.js cors).
const SLOW_Q = 'slowq', SLOW_QMAX = 10, SLOW_QAGE = 86400e3;
let memQ = [], flushing = false;
const readQ = () => { const q = store.get(SLOW_Q, null); return Array.isArray(q) ? q : memQ; };
// An empty queue is removed, not written: with storage full, setItem throws but getItem still returns the old queue,
// which would then be sent again after every answered call.
const writeQ = (q) => { memQ = q; if (q.length) store.set(SLOW_Q, q); else store.del(SLOW_Q); };
const queueSlow = (r) => writeQ([...readQ(), { t: Date.now(), r }].slice(-SLOW_QMAX));
export const flushSlow = () => {
  try {
    if (flushing) return;
    const q = readQ(), t = Date.now();
    if (!q.length) return;
    writeQ([]);
    const keep = q.filter((e) => e && e.r && typeof e.t === 'number' && t - e.t < SLOW_QAGE && (e.n || 0) < 3);
    if (!keep.length) return;
    flushing = true;
    const back = () => { try { writeQ([...keep.map((e) => ({ ...e, n: (e.n || 0) + 1 })), ...readQ()].slice(-SLOW_QMAX)); } catch {} };
    fetch(API + '/api/slow', { method: 'POST', body: JSON.stringify({ batch: keep.map((e) => ({ ...e.r, queued: Math.max(0, t - e.t) })) }),
      headers: authHeaders(), credentials: 'include', keepalive: true, signal: AbortSignal.timeout?.(15000) })
      .then((res) => { if (!res.ok) back(); }, back)
      .finally(() => { flushing = false; });
  } catch { flushing = false; }
};
try { window.addEventListener('online', flushSlow); } catch {}
