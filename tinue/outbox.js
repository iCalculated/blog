// The ply outbox (docs/plan/PLAN.md §1.3 "Client delivery", step C2): every ply of an attempt (the player's moves and
// the acts hint, view, giveup, leave, unload) is posted to POST /api/move, one at a time and in order, BESIDE today's
// /api/result. SHADOW ONLY: nothing here rates anything or changes what the page shows, waits for or reports; the answers
// are not read. /api/result stays the only thing that rates.
//
// Off unless the server says so: setMode(judge) takes the `judge` field of /api/next's answers, and only 'shadow' turns
// posting on (a server with TINUE_JUDGE off sends no such field, so this page sends nothing at all: no request, no
// 404). A later answer without it turns posting off again.
// Never mints a guest: an attempt opens only for a visitor who already holds a token, and every post carries it as
// `Authorization: Bearer` (never in the URL or the body). The body is JSON sent as text/plain; the nonce goes in the body.
// Never delays the page: open/move/act only append to the queue (sessionStorage, or memory where storage fails); the
// network runs later on a timer. Bounded: at most MAX_ITEMS queued (oldest dropped), MAX_PLY plies per attempt, items
// older than MAX_AGE dropped, and after MAX_FAILS failed posts in a row this page stops posting (what is left is resent
// on the next load of this tab: replays are idempotent on (nonce, ply)). A 404 means the routes are gone (server off):
// posting stops at once. Other 4xx answers drop that one ply (it can never succeed).
// A move whose verdict the page does not know yet (the still-wins check) is queued held: hold() returns fill(verdict);
// a held ply (and everything queued after it) waits until filled or HOLD_MS, then goes as it stands ('judging').
//
// A puzzle shown under a symmetry (pagesym.js: opened from a Rush run) is posted in its own orientation: open() takes the
// visit's sym from p, and a ply's move is turned back as it is queued (the queue outlives the page, which alone knows
// the sym), so the judge sees exactly what an ordinary visit would send.
// No DOM here: createOutbox takes everything it needs, so scripts/test-outbox.mjs drives it with fakes.
import * as SYM from './shared/sym.js?v=1795581690';

export const KEY = 'tinue.outbox';
export const MAX_ITEMS = 64, MAX_PLY = 64, MAX_AGE = 3600e3, HOLD_MS = 10e3, MAX_FAILS = 4, TIMEOUT_MS = 15e3, PAGEHIDE_MAX = 8;
const ACTS = new Set(['hint', 'view', 'giveup', 'leave', 'unload']);

// A short, non-reversible tag of the token: which player an item was queued for (the token itself is never stored here).
export const ownerOf = (t) => { if (!t) return ''; let h = 0x811c9dc5; for (const c of t) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193); return (h >>> 0).toString(36); };

// 22 random URL-safe characters: one attempt's nonce (server/move.js: [A-Za-z0-9_-]{16,64}).
export function newNonce(rand = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return [...rand(22)].map((b) => A[b & 63]).join('');
}

// url: the /api/move address. fetch, storage (sessionStorage-like, or null), token() (the current token or null),
// now(), later(fn, ms) (setTimeout), build (the page's build stamp or 0).
export function createOutbox({ url, fetch, storage, token, now = Date.now, later = (f, ms) => setTimeout(f, ms), build = 0, nonce = newNonce }) {
  let enabled = false, stopped = false, inflight = false, fails = 0, backoffUntil = 0, mem = [], stored = !!storage;
  let timer = 0, timerAt = 0, seq = 0;

  // The queue: in sessionStorage while that works, else in memory for the rest of this page (a write that failed
  // would leave getItem answering with an old queue).
  const read = () => {
    if (stored) {
      try { const v = storage.getItem(KEY); if (v == null) return []; const q = JSON.parse(v); return Array.isArray(q) ? q : []; } catch { stored = false; }
    }
    return mem;
  };
  const write = (q) => {
    mem = q;
    if (!stored) return;
    try { if (q.length) storage.setItem(KEY, JSON.stringify(q)); else storage.removeItem(KEY); }
    catch { stored = false; try { storage.removeItem(KEY); } catch {} }
  };
  // What may still be sent: well-formed, young enough, queued for the player holding the token now; the newest MAX_ITEMS.
  const clean = (q, owner) => q.filter((e) => e && e.b && typeof e.k === 'string' && Number.isInteger(e.n) && typeof e.t === 'number'
    && now() - e.t < MAX_AGE && e.o === owner).slice(-MAX_ITEMS);

  // One flush at a time, on a timer (never in the caller's turn). A sooner kick replaces a later one.
  function kick(delay = 0) {
    if (inflight || !enabled || stopped) return;
    const at = now() + Math.max(delay, backoffUntil - now(), 0);
    if (timer && timerAt <= at) return;
    const id = timer = ++seq; timerAt = at;
    later(() => { if (timer !== id) return; timer = 0; flush(); }, at - now());
  }

  async function flush() {
    if (!enabled || stopped || inflight) return;
    const tk = token();
    if (!tk) return;
    const q = clean(read(), ownerOf(tk));
    write(q);
    const it = q[0];
    if (!it) return;
    if (it.h && it.h > now()) return kick(it.h - now());
    inflight = true;
    let status = 0, wait = 0;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: 'Bearer ' + tk },
        body: JSON.stringify(it.b), credentials: 'include', signal: AbortSignal.timeout?.(TIMEOUT_MS) });
      status = r.status; wait = +r.headers?.get?.('retry-after') || 0;
      r.text?.().catch(() => {}); // the answer is not used in shadow
    } catch { status = 0; }
    inflight = false;
    if (status === 404) { enabled = false; return; } // no such route: the server has the judge off
    if ((status >= 200 && status < 300) || (status >= 400 && status < 500 && status !== 408 && status !== 429)) {
      fails = 0; backoffUntil = 0;
      write(read().filter((e) => !(e && e.k === it.k && e.n === it.n)));
    } else {
      if (++fails >= MAX_FAILS) { stopped = true; return; } // the rest waits for the next load
      backoffUntil = now() + (status === 429 ? Math.min(Math.max(wait, 1) * 1000, 300e3) : Math.min(1000 * 2 ** (fails - 1), 30e3));
    }
    kick();
  }

  function push(att, fields, hold = 0) {
    if (!att || att.n >= MAX_PLY || !enabled || att.owner !== ownerOf(token())) return null;
    const n = att.n++;
    if (att.sym && typeof fields.move === 'string') fields = { ...fields, move: SYM.move(SYM.inverse(att.sym), att.size, fields.move) };
    const b = { puzzleId: att.puzzleId, ...(att.rev != null ? { rev: att.rev } : {}), nonce: att.nonce, ply: n, ...fields,
      ...(att.theme ? { theme: att.theme } : {}), ...(build ? { b: build } : {}) };
    const e = { k: att.nonce, n, o: att.owner, t: now(), h: hold ? now() + hold : 0, b };
    write([...read(), e].slice(-MAX_ITEMS));
    kick();
    return e;
  }
  const ms = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
  const verdict = (v) => (typeof v === 'string' && /^[a-z-]{1,16}$/.test(v) ? v : undefined);

  return {
    // judge: /api/next's `judge` field (undefined when the server has the judge off).
    setMode(judge) { enabled = judge === 'shadow'; if (enabled) kick(); },
    get enabled() { return enabled && !stopped; },
    // A new attempt for puzzle p (an object with id and maybe rev), or null when nothing is to be sent.
    open(p, theme) {
      const tk = token();
      if (!enabled || stopped || !tk || !p || typeof p.id !== 'string') return null;
      // (sym, size: in memory only, for push; never sent)
      const sym = Number.isInteger(p.sym) && p.sym > 0 && p.sym < 8 && Number.isInteger(p.size) ? p.sym : 0;
      return { nonce: nonce(), puzzleId: p.id, rev: Number.isInteger(p.rev) ? p.rev : null, theme: theme || '', owner: ownerOf(tk), n: 0, closed: false, ...(sym ? { sym, size: p.size } : {}) };
    },
    move(att, move, { clientVerdict, ms: t } = {}) { return !!push(att, { move, clientVerdict: verdict(clientVerdict), ms: ms(t) }); },
    act(att, act, { clientVerdict, ms: t, seen } = {}) {
      if (!ACTS.has(act)) return false;
      return !!push(att, { act, ...(Number.isInteger(seen) && seen >= 0 ? { seen } : {}), clientVerdict: verdict(clientVerdict), ms: ms(t) });
    },
    // A move whose verdict comes later: fill(verdict) releases it (once); unfilled, it goes after HOLD_MS as 'judging'.
    hold(att, move, { ms: t } = {}) {
      const e = push(att, { move, clientVerdict: 'judging', ms: ms(t) }, HOLD_MS);
      let done = !e;
      return (v) => {
        if (done) return; done = true;
        write(read().map((x) => (x && x.k === e.k && x.n === e.n ? { ...x, h: 0, b: { ...x.b, clientVerdict: verdict(v) ?? 'judging' } } : x)));
        kick();
      };
    },
    // Everything held for this attempt goes as it stands (leaving the puzzle).
    release(att) {
      if (!att) return;
      write(read().map((x) => (x && x.k === att.nonce && x.h ? { ...x, h: 0 } : x)));
      kick();
    },
    // The page is going away: post what is queued, keepalive, without waiting (it stays queued; a resend is a replay).
    pagehide() {
      try {
        const tk = token();
        if (!enabled || stopped || !tk) return;
        for (const e of clean(read(), ownerOf(tk)).slice(0, PAGEHIDE_MAX)) {
          fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: 'Bearer ' + tk }, body: JSON.stringify(e.b),
            credentials: 'include', keepalive: true }).catch(() => {});
        }
      } catch {}
    },
    flush, // (tests)
  };
}
