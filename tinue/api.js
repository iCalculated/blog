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

export const WAIT_NOTICE = { kind: 'wait', title: 'Waiting for the puzzle server…', body: 'The server may be down; try again in a bit.' };
export let notice = null; // a message that replaces the turn card: {kind: 'wait' | 'net' | 'none', title, body}
export const setNotice = (n) => { notice = n; };
let redraw = () => {};
export const onNotice = (fn) => { redraw = fn; }; // how api() redraws the page after changing the notice

// timeout: one try with that budget (no retry), for callers with a fallback; signal: the caller may abort.
// keepalive: the request may outlive the page (a result sent as the tab closes).
export const api = async (path, body, { quiet = false, noWait = quiet, timeout, signal, keepalive = false } = {}) => {
  // If the server can't be reached, say so instead of showing a blank page. (On Shy's tailnet, Chrome asks for
  // "local network access" before a public page may call crux's private address; that prompt also stalls here.)
  const slow = noWait ? null : setTimeout(() => { notice = WAIT_NOTICE; redraw(); }, 4000);
  const t0 = performance.now();
  let outcome = 'ok';
  // A request stuck on a dead connection (e.g. the tailnet path to crux re-forming after sleep) is abandoned
  // after a while: reads are retried once, results (POSTs) just get longer before giving up.
  const once = async (ms) => {
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
    else try { j = await once(8000); } catch { outcome = 'retried'; j = await once(12000); }
    if (!quiet && (notice?.kind === 'wait' || notice?.kind === 'net')) { notice = null; redraw(); }
    return j;
  } catch (e) {
    outcome = 'failed';
    if (quiet) throw e;
    notice = { kind: 'net', title: 'Can’t reach the puzzle server', body: 'Check your connection and reload. If it keeps happening, the server may be down.' };
    redraw();
    throw e;
  } finally {
    clearTimeout(slow);
    const ms = performance.now() - t0;
    // Engine analysis is slow by design (a ~1.2 s search, maybe queued) and aborted on purpose; not a network signal.
    if ((ms > 2000 || outcome !== 'ok') && path !== '/api/slow' && !path.startsWith('/api/analyze') && !path.startsWith('/api/defend')) reportSlow(path, ms, outcome);
  }
};

// Tell the server about requests that were slow from here, so its log shows what the network added.
export const reportSlow = (path, ms, outcome) => {
  try {
    const data = JSON.stringify({ path: path.split('?')[0], ms, outcome, hidden: document.visibilityState === 'hidden' });
    if (!navigator.sendBeacon?.(API + '/api/slow', data)) fetch(API + '/api/slow', { method: 'POST', body: data, keepalive: true }).catch(() => {});
  } catch {}
};
