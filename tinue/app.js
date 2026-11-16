import { Game } from './shared/tak.js?v=1794851720';
import { THEMES, GLOSSARY } from './shared/themes.js?v=1794851720';
import { provisional, PLAYER_START } from './shared/rating.js?v=1794851720';
import { Board, buildPTN, focusedByPointer } from './board.js?v=1794851720';
import * as engine from './engine.js?v=1794851720';
import * as tiltak from './tiltak.js?v=1794851720';
import * as syntaks from './syntaks.js?v=1794851720';
import { api, store, token, setToken, notice, setNotice, onNotice, WAIT_NOTICE } from './api.js?v=1794851720';
import { createNext } from './next.js?v=1794851720';
import { capMoves, capNote, defender, ending, resigns, legalMove, gameRated, unratedWhy, winRated, stalls, heldResend } from './playon.js?v=1794851720';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// A puzzle's address is a real path, <app>/puzzle/<id>, so pasting it into Discord unfurls: the static build writes
// a small page there with the puzzle's embed tags that forwards to #/puzzle/<id>, and the app then shows the path
// again. Other pages stay hash routes. APP is the app's directory (/tinue/ on shydrie.xyz, / on a dev server).
const APP = location.pathname.replace(/(puzzle\/[^/]+|glossary|me|leaderboard)\/?$/, '').replace(/[^/]*$/, '');
// The query string (e.g. ?board=ninja) rides along on every address the app shows or shares.
const puzzlePath = (id) => APP + 'puzzle/' + encodeURIComponent(id) + location.search;
const showPuzzleURL = (id) => { if (location.pathname + location.search + location.hash !== puzzlePath(id)) history.replaceState(null, '', puzzlePath(id)); };
const showHashURL = (h) => { if (location.pathname !== APP || location.hash !== h) history.replaceState(null, '', APP + location.search + h); };

// Share (phones only): the system share sheet with the puzzle's own address (see above). On desktop the address bar
// already shows that address, so there's no button (Shy, 2026-11-15).
const canShare = () => !!navigator.share && matchMedia('(pointer: coarse)').matches;
async function sharePuzzle(p) {
  try { await navigator.share({ title: 'tinue puzzle', url: location.origin + puzzlePath(p.id) }); } catch {}
}

// The server rates everyone. me: the player it knows us as, an account (name) or a guest (name null: has played
// without claiming a name), identified by the token (api.js). A first-time visitor has neither until their first
// result (or claiming a name), whose answer brings the token.
let me = null;
// Until 2026-11-15 guests were rated in this browser. Until the first result here makes a guest a server user (whose
// rating the server replays from the results this browser sent then), that rating and the puzzles seen steer the
// next puzzle and show as "your rating".
const legacyGuest = token ? null : store.get('guest', null), legacySeen = token ? [] : store.get('seen', null) || [];
const guestSeed = () => ({ gid: guestId() ?? undefined });
// A result held while its check runs (or settled but not yet acknowledged by the server), kept per tab: sessionStorage
// survives this tab's reload, and flushHeld sends it then (playon.js heldResend). Other tabs can't see it, except one
// duplicated from this tab, which copies it: the record names this page (pageId, in memory only), and from its first
// record until it goes away this page holds a Web Lock of that name, so a copy whose page is still alive is dropped, not
// sent out from under it. (Not released when the record goes: the page may settle it while a copy waits for the lock,
// and its result may not be sent yet.) It also carries the build that wrote it and whose result it is (owner: a hash
// of the token, never the token).
const pageId = (() => { try { return crypto.randomUUID(); } catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); } })();
const owner = () => { let h = 0x811c9dc5; for (const c of token || '') h = Math.imul(h ^ c.charCodeAt(0), 0x01000193); return token ? (h >>> 0).toString(36) : ''; };
let pageLock = false; // this page holds its lock (taken with its first record, kept for the page's life)
const heldRec = {
  get() { try { return JSON.parse(sessionStorage.getItem('tinue.held')); } catch { return null; } },
  set(v) {
    if (!pageLock && navigator.locks) { pageLock = true; navigator.locks.request('tinue.held.' + pageId, () => new Promise(() => {})).catch(() => {}); }
    try { sessionStorage.setItem('tinue.held', JSON.stringify({ ...v, b: BUILD, owner: owner(), page: pageId })); } catch {}
  },
  del(id) { try { if (id == null || heldRec.get()?.id === id) sessionStorage.removeItem('tinue.held'); } catch {} },
};
// A token a result just made for this browser (its first result made it a guest): a record held from before it had
// one is this guest's, so it is stamped as theirs (only the owner: its build stays the one that wrote it).
const ownHeld = () => { try { const h = heldRec.get(); if (h?.id && h.owner === '') sessionStorage.setItem('tinue.held', JSON.stringify({ ...h, owner: owner() })); } catch {} };
// Whether the page that wrote a held record is still open (its lock is taken). A lock a reload has just let go of may
// take a moment to free, so it gets 1.5 s; without Web Locks, as before (sent).
const pageAlive = (page) => {
  if (!page || page === pageId || !navigator.locks) return Promise.resolve(false);
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 1500);
  return navigator.locks.request('tinue.held.' + page, { signal: ctl.signal }, () => false)
    .catch((e) => e?.name === 'AbortError').finally(() => clearTimeout(t));
};
// Your rating as shown: the server's, else (no result yet) the browser's from before, else the start.
const myRating = () => me || (legacyGuest?.games ? { rating: legacyGuest.rating, provisional: provisional(legacyGuest) } : { rating: PLAYER_START.rating, provisional: true });
// "1650?" while a rating is still provisional (high deviation), as on Lichess.
const fmtRating = (r, prov) => `${Math.round(r)}${prov ? '<span class="prov" title="Provisional: it settles after about 15 rated puzzles">?</span>' : ''}`;
const prefs = store.get('prefs', {});
if (!prefs.v2) { prefs.size = '6'; prefs.v2 = true; } // 6×6 by default
// 2026-11-14: the default moved from 5×5 to 6×6 (where serious Tak is played). Anyone still on the old 5×5 default
// moves too, once; "Any size" and later choices stay.
if (!prefs.v3) { if (prefs.size === '5') prefs.size = '6'; prefs.v3 = true; }
prefs.difficulty ||= 'normal';
store.set('prefs', prefs);
// This sitting's results {id, win, delta}: kept per tab, so a reload (e.g. into a newer build) doesn't wipe the streak.
const session = (() => { try { return JSON.parse(sessionStorage.getItem('tinue.session')) || []; } catch { return []; } })();
const saveSession = () => { try { sessionStorage.setItem('tinue.session', JSON.stringify(session.slice(-200))); } catch {} };
const reporting = new Set(); // result uploads still on their way
// A random id for this browser (null if storage or crypto is unavailable). It links a guest's server row to the
// anonymous results older clients sent, and lets a guest whose token got lost on the way get its row back.
const guestId = () => {
  let id = store.get('gid', null);
  if (typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) return id;
  try { id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''); } catch { return null; }
  store.set('gid', id);
  return store.get('gid', null) === id ? id : null;
};

// ?board=ninja: PTN Ninja in an iframe instead of tinue's board (same API). Loaded only when asked for.
const NINJA = new URLSearchParams(location.search).get('board') === 'ninja';
const board = NINJA ? new (await import('./ninja.js?v=1794851720')).NinjaBoard($('#board'), { onMove: (ptn) => userMove(ptn) })
  : new Board($('#board'), { onMove: (ptn) => userMove(ptn) });
board.ui({ disableBoard: true }); // no input until a puzzle is loaded
let S = null; // current puzzle state
onNotice(() => renderAll()); // api() shows and clears the server notice

// ---------- user box ----------
function renderUser() {
  const box = $('#userbox');
  store.set('me', me ? { name: me.name } : null); // a guest is { name: null }
  if (me) { store.set('myRating', me.rating); store.set('myProv', !!me.provisional); } // shown before /api/me answers next time
  if (me?.name) {
    // Name with a small menu on hover/focus: History, Log out (with an inline confirm).
    box.innerHTML = `<div class="menu"><button class="link name" aria-haspopup="true">${esc(me.name)}</button>
      <div class="pop" role="menu"><a href="#/me" role="menuitem">History</a><button class="link" id="logout" role="menuitem">Log out</button>
        <div class="confirm hidden" id="logout-confirm"><p>You’ll need your login token (on your History page) to sign back in on this device.</p><button class="danger" id="logout-yes">Log out</button></div></div></div>`;
    $('#logout').onclick = () => { $('#logout-confirm').classList.remove('hidden'); $('#logout').classList.add('hidden'); };
    $('#logout-yes').onclick = async () => { await abandonCheck(S); restoreLeft(); await api('/api/logout', {}); setToken(null); forgetNext(); me = null; session.length = 0; saveSession(); renderUser(); refreshPage(); };
  } else {
    // One quiet button; claiming a name (or pasting a token) happens in a small popover.
    box.innerHTML = `<div class="menu click"><button class="link name" id="claim-open" aria-haspopup="dialog" aria-expanded="false">Claim a username</button>
      <div class="pop wide" role="dialog" aria-label="Claim a username">
        <form id="claim"><label class="field"><span>Username</span><input name="name" id="claim-name" maxlength="20" autocomplete="username" placeholder="2–20 letters, digits, _ or -"></label>
          <button class="primary" type="submit">Claim</button><p class="err hidden" id="claim-err"></p>
          <p class="hint">No password: your browser remembers you. <button type="button" class="link" id="token-open">Have a login token?</button></p></form>
        <form id="tok" class="hidden"><label class="field"><span>Login token</span><input name="token" id="tok-in" autocomplete="off" placeholder="From the History page on your other device"></label>
          <button class="primary" type="submit">Sign in</button><p class="err hidden" id="tok-err"></p></form>
      </div></div>`;
    const menu = box.querySelector('.menu');
    $('#claim-open').onclick = () => {
      const open = menu.classList.toggle('open');
      $('#claim-open').setAttribute('aria-expanded', open);
      if (!open) return;
      // always start from the claim form (not a token form left open last time)
      $('#claim').classList.remove('hidden'); $('#tok').classList.add('hidden');
      for (const id of ['#claim-err', '#tok-err']) $(id).classList.add('hidden');
      $('#claim-name').focus();
    };
    $('#token-open').onclick = () => { $('#claim').classList.add('hidden'); $('#tok').classList.remove('hidden'); $('#tok-in').focus(); };
    const showErr = (id, msg) => { const el = $(id); el.textContent = msg; el.classList.remove('hidden'); };
    $('#claim').onsubmit = async (e) => {
      e.preventDefault();
      // A guest's row just gets the name (rating and history stay); a first-time visitor's is created like a guest's.
      const r = await api('/api/register', { name: $('#claim-name').value.trim(), ...(token ? {} : { guest: guestSeed() }) });
      if (r.error) return showErr('#claim-err', r.error);
      if (r.token) setToken(r.token);
      me = r.user; renderUser(); refreshPage();
    };
    $('#tok').onsubmit = async (e) => {
      e.preventDefault();
      const t = $('#tok-in').value.trim();
      const r = await api('/api/login', { token: t });
      if (r.error) return showErr('#tok-err', 'That token doesn’t match an account.');
      await abandonCheck(S); restoreLeft(); // a held result goes out under the identity that played it
      setToken(t); forgetNext(); me = r.user; session.length = 0; saveSession(); renderUser(); refreshPage();
    };
  }
}
function closeMenu(m, refocus) {
  m.classList.remove('open');
  m.querySelector('[aria-expanded]')?.setAttribute('aria-expanded', 'false');
  if (refocus) m.querySelector('.name')?.focus();
}
document.addEventListener('keydown', (e) => {
  const m = e.key === 'Escape' && document.querySelector('.menu.open');
  if (m) closeMenu(m, m.contains(document.activeElement));
});
document.addEventListener('click', (e) => { // close the claim popover when clicking elsewhere
  const m = document.querySelector('.menu.click.open');
  if (m && !m.contains(e.target)) closeMenu(m, false);
});
// After signing in or out: re-render whichever page is showing (History shows the account and its token).
function refreshPage() {
  if ($('#view-puzzle').classList.contains('hidden')) route(); else renderAll();
}

// ---------- puzzle flow ----------
let loadSeq = 0;
const nextQuery = (skip) => { // skip: a puzzle id to leave out (one whose result may not have reached the server)
  const q = new URLSearchParams({ difficulty: prefs.difficulty });
  if (prefs.size) q.set('size', prefs.size);
  if (prefs.theme) q.set('theme', prefs.theme);
  const ex = [...(token ? [] : legacySeen.slice(-200)), ...(skip ? [skip] : [])];
  if (!token) q.set('rating', Math.round(myRating().rating));
  if (ex.length) q.set('exclude', ex.join(','));
  return q.toString();
};
// What comes after this puzzle (the win/loss pair, a settled player's batch queue, the stored next one): next.js.
const filterKey = () => [prefs.difficulty, prefs.size || '', prefs.theme || ''].join('|');
const nextQ = createNext({
  get: (path) => api(path, null, { quiet: true }), store, filterKey, playerKey: () => (token ? token.slice(0, 8) : ''), query: nextQuery,
  settled: () => !!(token && me && !me.provisional), rating: () => me?.rating ?? null, currentId: () => S?.p?.id,
});
const forgetNext = () => nextQ.forgetNext(); // another player now

// ---------- a newer build ----------
// Next never reloads the page, so an open tab keeps the code it was opened with (2026-11-15: every regular was still
// on the old still-wins timeout an hour after the fix shipped). The static build stamps window.TINUE_BUILD and
// version.json (scripts/build-static.sh); the tab compares them on each puzzle, when it comes back into view and every
// 10 min. Once a newer build is out, moving on to the next puzzle reloads the page into it (the stored next puzzle and
// the queue are in localStorage, so nothing is lost), unless a result is held or still being checked; mid-puzzle or on
// a result card it only shows the bar. Off on the dev server (no stamp).
const BUILD = +window.TINUE_BUILD || 0;
const withBuild = (path, b = BUILD) => (b ? path + (path.includes('?') ? '&' : '?') + 'b=' + b : path); // logged by the server
let newBuild = 0, buildBarHidden = false, buildCheck = null, lastBuildCheck = 0;
// A reload into a build the CDN doesn't serve yet would come back to the old page: one try per build every 2 min.
const reloadedFor = () => { try { return JSON.parse(sessionStorage.getItem('tinue.reloadedFor')) || {}; } catch { return {}; } };
// Any other build counts (a rollback too); the server's clock doesn't matter.
function checkBuild() {
  if (!BUILD) return Promise.resolve(0);
  if (buildCheck) return buildCheck;
  lastBuildCheck = Date.now();
  const req = buildCheck = fetch(APP + 'version.json?t=' + Date.now(), { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const v = +j?.v || 0, tried = reloadedFor();
      if (v && v !== BUILD && !(tried.v === v && Date.now() - tried.at < 120e3) && v !== newBuild) { newBuild = v; renderBuildBar(); }
      return newBuild;
    })
    .catch(() => newBuild).finally(() => { if (buildCheck === req) buildCheck = null; });
  return req;
}
if (BUILD) {
  setInterval(() => { if (!document.hidden) checkBuild(); }, 10 * 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastBuildCheck > 30e3) checkBuild(); });
}
// The bar never appears in the middle of a puzzle the player has started, a miss included (it would push the board
// down under their pointer, and its Reload would leave a held check): it waits for the puzzle's end (solved, or the
// solution shown), or shows before the first move. renderAll calls this too.
const BAR_TEXT = 'tinue was updated. Reload to get the fixes. Your rating and puzzle queue are kept.';
function renderBuildBar() {
  const bar = $('#build-bar'), live = $('#build-live');
  if (!bar) return; // an older index.html
  const midPuzzle = S && !S.placeholder && (((S.status === 'play' || S.status === 'retry') && (S.moves.length > 0 || S.misses.length > 0)) || S.status === 'playon');
  const hide = !newBuild || buildBarHidden || midPuzzle;
  if (bar.hidden === hide) return;
  bar.hidden = hide;
  if (!hide && !bar.firstChild) {
    bar.innerHTML = '<span class="msg">tinue was updated. <span class="muted">Reload to get the fixes. Your rating and puzzle queue are kept.</span></span>'
      + '<button type="button" class="primary reload">Reload</button><button type="button" class="x" aria-label="Dismiss" title="Dismiss">×</button>';
    bar.querySelector('.reload').addEventListener('click', reloadNow);
    bar.querySelector('.x').addEventListener('click', () => { buildBarHidden = true; renderBuildBar(); }); // until the next puzzle
  }
  if (live) live.textContent = hide ? '' : BAR_TEXT; // an always-present live region, so screen readers announce it
  try { fitDock(); } catch {} // the phone dock sizes the board from where it starts
}
// The Reload button: from a result card on to the next puzzle (a reload of this one would replay it); before the
// first move, this puzzle again.
function reloadNow() {
  if (S?.playOn) return; // never in the middle of a play-on game (leaving it is a miss); the bar is hidden then anyway
  if (S && !S.placeholder && (S.resultSent || S.status !== 'play' || S.quickCheck)) loadNext({ reload: true }); // (a move being checked is sent as it leaves)
  else reloadInto(S?.p?.id, S?.theme);
}
// A full page load opening puzzle id (or the start). theme: the Theme its result counts under (see start()).
function reloadInto(id, theme = '') {
  try {
    sessionStorage.setItem('tinue.reloadedFor', JSON.stringify({ v: newBuild, at: Date.now() }));
    if (id) sessionStorage.setItem('tinue.reloadTheme', JSON.stringify({ id, theme: theme || '' }));
  } catch {}
  history.replaceState(null, '', APP + location.search + (id ? '#/puzzle/' + encodeURIComponent(id) : '#/'));
  location.reload();
}
const reloadTheme = (() => { try { const t = JSON.parse(sessionStorage.getItem('tinue.reloadTheme')); sessionStorage.removeItem('tinue.reloadTheme'); return t; } catch { return null; } })();

async function loadNext({ reload = false } = {}) {
  const t = ++loadSeq;
  // A held result is sent (unrated) first, so the server knows this puzzle was played and won't serve it again; if
  // that upload is slow, the request below excludes it anyway.
  const leaving = S?.checkPending || S?.quickCheck ? S.p.id : null;
  const left = abandonCheck(S);
  if (left) await Promise.race([left, new Promise((r) => setTimeout(r, 3000))]);
  const pre = nextQ.take(); // (a stored one stays until this puzzle's result: leaving halfway comes back to it)
  // A prefetch still in flight gets 3 s (it is quiet: no waiting notice), then a normal request takes over.
  let r = pre && (await Promise.race([pre, new Promise((res) => setTimeout(() => res(null), 3000))]));
  if (!r?.puzzle || r.puzzle.id === S?.p.id) { // (a "no match" answer is re-asked too)
    if (pre && !r) { setNotice(WAIT_NOTICE); renderAll(); }
    try { r = await api('/api/next?' + nextQuery(leaving)); } catch { restoreLeft(); return; } // api() has shown the error
  }
  const { puzzle } = r;
  if (t !== loadSeq) return; // a newer request superseded this one
  if (!puzzle) { // nothing to play: clear the old puzzle rather than leave it playable under the new filters
    engine.interrupt(); tiltak.stop(); anaCtl?.abort();
    S = null;
    setNotice({ kind: 'none', title: 'No puzzles match', body: 'Try another theme, difficulty or board size.' });
    showHashURL('#/');
    await board.ui({ disableBoard: true, showRoads: false, dropOnStray: false });
    await board.load(buildPTN({ size: +(prefs.size || 6) }));
    renderAll(); setTitle(); return;
  }
  // Between puzzles, a newer build (as last checked: Next doesn't wait on the network) reloads into this one. Not while
  // a result is held or still uploading (the reload would cut it off), unless the player pressed Reload: then an
  // upload in flight gets 3 s, and a held one is sent at the reload anyway (flushHeld).
  if (newBuild && (reload || (!leaving && !heldRec.get() && !reporting.size))) {
    if (reporting.size) await Promise.race([Promise.allSettled([...reporting]), new Promise((res) => setTimeout(res, 3000))]);
    if (t !== loadSeq) return;
    reloadInto(puzzle.id, prefs.theme); return;
  }
  showPuzzleURL(puzzle.id);
  start(puzzle, prefs.theme);
}
// Does the puzzle fit the current Theme / Board filters?
const matchesFilters = (p) => (!prefs.theme || (p.themes || []).includes(prefs.theme)) && (!prefs.size || String(p.size) === String(prefs.size));

async function loadById(id) {
  const t = ++loadSeq;
  // Reloaded into a newer build on the way to this puzzle: it's the stored next one (no request needed, even with the
  // server unreachable), and it keeps the Theme it was picked under (start() checks it against the puzzle's themes).
  const reloaded = reloadTheme?.id === id, stored = reloaded && store.get('next', null)?.puzzle;
  let puzzle = stored?.id === id ? stored : null;
  if (!puzzle) { try { ({ puzzle } = await api('/api/puzzle/' + encodeURIComponent(id))); } catch { restoreLeft(); return; } }
  if (t !== loadSeq) return;
  if (puzzle) { showPuzzleURL(puzzle.id); start(puzzle, reloaded ? reloadTheme.theme : ''); } else loadNext();
}

const colorName = (c) => (c === 1 ? 'White' : 'Black');

// PTN for everything shown so far: the game's history (if known) plus moves played in the puzzle.
function currentPTN() { return ptnFor(S.hist.length ? officialLine() : S.moves.map((m) => m.ptn)); }

// ---- lines: the official line (game history + puzzle moves) and, after the puzzle, your own exploration ----
const officialLine = () => [...S.hist, ...S.moves.map((m) => m.ptn)];
const shownLine = () => (S.branch && S.onBranch ? [...officialLine().slice(0, S.branch.at), ...S.branch.moves] : officialLine());
function ptnFor(plies) {
  const { p } = S;
  const names = p.meta?.white ? { white: p.meta.white, black: p.meta.black } : {};
  return S.hist.length ? buildPTN({ size: p.size, komi: p.komi, moves: plies, ...names }) : buildPTN({ size: p.size, komi: p.komi, tps: p.tps, moves: plies, ...names });
}
function gameAt(plies) {
  const g = S.hist.length ? Object.assign(new Game(S.p.size), { komi: S.p.komi || 0 }) : Game.fromTPS(S.p.tps, S.p.komi || 0);
  for (const m of plies) g.play(m);
  return g;
}
// Position description for the engine worker.
const enginePos = (plies) => ({ size: S.p.size, komi: S.p.komi || 0, tps: S.hist.length ? null : S.p.tps, plies });

// After the puzzle: ask the engine about the position on the board.
// 6×6: Syntaks on the server (much stronger there, and it knows every half-point komi); if the server can't answer,
// Tiltak (4×4–6×6, in the browser) gives the evaluation and line, streamed as it searches. On boards neither can
// play, our own forced-win solver.
let anaCtl = null; // the in-flight Syntaks request; aborted when the position changes, so the server drops it
async function runEngine() {
  if (!S || S.status !== 'solved') return;
  const line = shownLine();
  const at = S.view ?? line.length;
  const key = line.slice(0, at).join(' ');
  if (S.evalKey === key) return;
  const s = S;
  S.evalKey = key; S.eval = null; S.tk = null;
  anaCtl?.abort(); anaCtl = null;
  const g = gameAt(line.slice(0, at));
  const res0 = g.result();
  if (res0) { tiltak.stop(); S.eval = { kind: 'over', winner: res0.winner, how: res0.kind }; renderAll(); return; }
  const komi = S.p.komi || 0, live = () => S === s && S.evalKey === key;
  if (S.p.size === 6 && Math.abs(komi) <= 3.5 && Number.isInteger(komi * 2)) {
    tiltak.stop();
    S.tk = { thinking: true, src: 'syntaks' }; renderAll();
    const ctl = anaCtl = new AbortController();
    const fallback = () => { if (live()) runTiltak(s, key, g, line.slice(0, at)); };
    // 6 s covers the search plus a short queue on crux; past that, the browser engine answers sooner.
    api(`/api/analyze?tps=${encodeURIComponent(g.toTPS())}&komi=${komi}`, null, { quiet: true, timeout: 6000, signal: ctl.signal })
      .then((r) => { if (!live()) return; if (r?.engine === 'syntaks') { S.tk = { ...r, src: 'syntaks' }; renderEngine(); } else fallback(); }, fallback);
    return;
  }
  runTiltak(s, key, g, line.slice(0, at));
}
function runTiltak(s, key, g, plies) {
  if (!tiltak.supports(S.p.size, S.p.komi || 0)) { tiltak.stop(); return runSolver(s, key, plies); }
  S.tk = { thinking: true }; renderAll();
  let lastPaint = 0;
  const live = () => S === s && S.evalKey === key;
  // If Tiltak can't load or crashes, use the solver instead of thinking forever.
  const fallback = () => { if (live() && (!S.tk || S.tk.thinking)) { S.tk = null; runSolver(s, key, plies); } };
  tiltak.analyze({ tps: g.toTPS(), size: S.p.size, komi: S.p.komi || 0, ms: 2500, onInfo: (r) => {
    if (!live()) return;
    S.tk = r; const now = performance.now(); if (now - lastPaint > 250) { lastPaint = now; renderEngine(); }
  } }).then((r) => { if (!live()) return; if (r) { S.tk = r; renderEngine(); } else fallback(); }, fallback);
}
async function runSolver(s, key, plies) {
  S.eval = { kind: 'thinking' }; renderAll();
  const res = await engine.analyze({ ...enginePos(plies), maxPlies: 9 });
  if (res && S === s && S.evalKey === key) { S.eval = res; renderAll(); }
}

// Play the engine's line on the board, up to and including move k (as your line).
async function playPV(k) {
  const pv = S.tk?.pv || S.eval?.pv;
  if (!pv?.length) return;
  const line = shownLine();
  const at = S.view ?? line.length;
  const official = officialLine();
  const prefix = S.onBranch && S.branch && at > S.branch.at ? S.branch.moves.slice(0, at - S.branch.at) : [];
  const base = S.onBranch && S.branch ? Math.min(at, S.branch.at) : at;
  const moves = [...prefix, ...pv.slice(0, k + 1)];
  // If the engine's line is exactly the solution continuing, just step along the solution.
  if (!S.onBranch && official.slice(at, at + k + 1).join(' ') === pv.slice(0, k + 1).join(' ')) {
    const to = at + k + 1;
    S.view = to >= official.length ? null : to;
    await showLine(official, to); return afterExplore();
  }
  S.branch = { at: base, moves }; S.onBranch = true; S.view = null; S.loadedKey = null;
  await showLine(shownLine(), shownLine().length);
  afterExplore();
}

// Load a line onto the board and show the position after `idx` plies (no animation).
async function showLine(line, idx) {
  const key = line.join(' ');
  if (S.loadedKey !== key) { await board.load(ptnFor(line)); S.loadedKey = key; }
  if (idx >= line.length) await board.last(); else if (idx === 0) await board.first(); else await board.goTo(idx - 1);
}

async function start(p, theme = '') {
  abandonCheck(S); // leaving a puzzle whose check is still running (any route: Next, a link, a filter change)
  engine.interrupt(); tiltak.stop(); anaCtl?.abort(); // nothing from the previous puzzle should still be thinking
  const g = Game.fromTPS(p.tps, p.komi || 0);
  const hist = p.meta?.history || [];
  // theme: the Theme filter this puzzle was picked with (its result is damped as a themed attempt)
  const s = S = { p, g, node: p.tree, solver: g.toMove, hist, moves: [], snaps: [g.toTPS()], view: null, status: 'play', resultSent: false, hinted: false, delta: null, busy: true,
        misses: [], outcome: null, branch: null, onBranch: false, theme: theme && (p.themes || []).includes(theme) ? theme : '',
        t0: null, born: performance.now(), hiddenMs: 0, hiddenAt: null, log: [] };
  nextQ.prefetchPair(p);
  buildBarHidden = false; renderBuildBar(); checkBuild(); // a dismissed bar comes back with the next puzzle
  setNotice(null);
  setTitle();
  renderAll(); // side panel right away
  await board.ui({ disableBoard: true, showRoads: false, dropOnStray: false });
  if (S !== s) return;
  if (hist.length) {
    // Show the game up to just before the opponent's last move, then play that move (Lichess-style).
    const names = p.meta?.white ? { white: p.meta.white, black: p.meta.black } : {};
    await board.load(buildPTN({ size: p.size, komi: p.komi, moves: hist.slice(0, -1), ...names }));
    await board.last();
    if (S !== s) return;
    renderAll();
    setTimeout(async () => {
      if (S !== s) return;
      await board.append(hist.at(-1));
      await board.last();
      if (S !== s) return;
      S.busy = false;
      await board.setPlayer(S.solver);
      await board.ui({ disableBoard: false });
      startClock(s);
      renderAll();
      flushHint(s);
    }, 650);
  } else {
    await board.load(currentPTN());
    await board.last();
    if (S !== s) return;
    S.busy = false;
    await board.setPlayer(S.solver);
    await board.ui({ disableBoard: false });
    startClock(s);
  }
  renderAll();
  flushHint(s);
}

// Solve time: milliseconds the puzzle was actually on screen since the board became playable (a hidden tab or another
// page of the site pauses the clock). Sent with the result for signed-in players, with each of the solver's moves (and
// any hint or solution view), to calibrate puzzle ratings later.
const offScreen = () => document.hidden || $('#view-puzzle').classList.contains('hidden');
function startClock(s) {
  if (s.t0 != null) return;
  s.t0 = performance.now(); s.hiddenAt = offScreen() ? s.t0 : null;
  setTimeout(() => { if (S === s) wakeActions(); }, FRESH_MS + 30); // Hint and Solution come alive (fresh)
}
// A new puzzle's Hint and Solution take no presses until it has been playable for FRESH_MS, and they show as disabled
// until then. Next puzzle sits where they appear (in the card, and on a phone in the dock over the same spot), so the
// second tap of a double tap on Next landed on Solution: a rated miss 16 ms into a puzzle nobody had looked at
// (rabbitboy84, 2026-11-16). A press during the intro isn't remembered for later either (see flushHint).
const FRESH_MS = 1000;
const fresh = (s) => s.t0 == null || performance.now() - s.t0 < FRESH_MS;
// Turns the card's Hint and Solution on where they stand once the first second is over. Redrawing the card instead
// would have a screen reader read it out a second time (it's a live region) and would cut a "Best move!" short.
// If the card's HTML ever stops matching these strings, the next render simply redraws it.
function wakeActions() {
  const fb = $('#feedback');
  for (const b of fb.querySelectorAll(':scope > .actions > [data-act="hint"], :scope > .actions > [data-act="solution"]')) b.disabled = false;
  if (fb._html) fb._html = fb._html.replace('data-act="hint" disabled>', 'data-act="hint">').replace('data-act="solution" disabled title=', 'data-act="solution" title=');
}
// The same double tap can land on the board instead. On a phone the board grows back into the space the dock held, and
// a puzzle with no intro is playable at once, so the second tap put down a flat: a miss. A move in a puzzle's first
// half second is dropped (with an intro the board is still off then anyway).
const TOO_SOON_MS = 500;
const tooSoon = (s) => performance.now() - (s.born ?? 0) < TOO_SOON_MS;
// And the other way round: Next puzzle appears where Solution was pressed, so a double tap on Solution skipped the
// solution it asked for. Next takes no press for a moment after Solution.
const justViewed = () => S?.viewT0 != null && performance.now() - S.viewT0 < 600;
function elapsed(s = S) {
  if (s?.t0 == null) return null;
  const t = performance.now();
  return Math.round(t - s.t0 - s.hiddenMs - (s.hiddenAt != null ? t - s.hiddenAt : 0));
}
// Pause or resume the clock to match whether the puzzle is on screen.
function syncClock() {
  if (!S || S.t0 == null) return;
  const t = performance.now(), off = offScreen();
  if (off) S.hiddenAt ??= t;
  else if (S.hiddenAt != null) { S.hiddenMs += t - S.hiddenAt; S.hiddenAt = null; }
}
// ms: when the move was made (callers read it before any engine check, which can take seconds).
const logMove = (k, m, ms = elapsed()) => { if (S && !S.resultSent && S.t0 != null && S.log.length < 64) S.log.push(m ? { m, ms, k } : { ms, k }); };
document.addEventListener('visibilitychange', syncClock);

const pliesLeft = () => {
  const d = (n) => (n === 'win' ? 1 : n == null ? 0 : 2 + Math.max(...Object.values(n).map((v) => (v ? d(v.n) : 0))));
  return d(S.node);
};

// Put the board back to exactly the moves we've accepted (after a wrong move, or after browsing history).
async function restoreBoard() {
  await board.load(currentPTN());
  S.loadedKey = null;
  await board.last();
  S.view = null;
  const live = S.status === 'play' || S.status === 'retry';
  await board.ui({ disableBoard: !live });
  if (live) await board.setPlayer(S.solver);
  if (live && S.hint?.node === S.node && S.hint.at === S.moves.length) await board.highlight(S.hint.sqs); // a reload clears it
  renderAll();
}

async function userMove(ptn) {
  if (!S || S.placeholder) return; // the board is disabled until a puzzle arrives
  if (S.status === 'solved') return explore(ptn);
  if (S.playOn) return playOnMove(ptn);
  if (tooSoon(S)) { restoreBoard(); return; } // a tap meant for the last puzzle's Next, landing on the new board
  if (!S || S.placeholder || S.busy || S.view != null || !(S.status === 'play' || S.status === 'retry')) { if (S) restoreBoard(); return; }
  const g = S.g;
  let canon;
  try { canon = g.canon(ptn); } catch { restoreBoard(); return; }
  if (!g.legalMoves().some((m) => g.moveToPTN(m) === canon)) { restoreBoard(); return; }
  const node = S.node, tMove = elapsed();
  let correct = false, reply = null, next = null, wonNow = false;
  const u = g.apply(g.parseMove(canon));
  const res = g.result();
  if (res && res.winner === S.solver) { correct = true; wonNow = true; }
  else if (node !== 'win' && node && Object.prototype.hasOwnProperty.call(node, canon) && !res) {
    correct = true; reply = node[canon]?.r; next = node[canon]?.n;
  }
  // A proven win the puzzle's tree doesn't list is slower (the tree has every win at the minimal depth): a solve.
  // Precomputed lists (alts at the root, altsAt in 5-ply lines) answer at once. Any other off-tree move, at any node
  // of any puzzle, gets ~2.5 s of the engine to prove it wins or to find that no Tak-threat win exists (the lists don't
  // cover 7×7/8×8, the first moves the precompute left undecided, or anything past the root of a deep puzzle: rated
  // misses on crux 2026-11-15 were real wins there). Undecided by then: where an engine can defend (6×6 Syntaks, 4×4/5×5
  // Tiltak) the move is played out on the board (startPlayOn); elsewhere the board carries on as after a miss, but the
  // result is held while the search runs on (≤60 s, settleCheck): a 'no' (no forced win made of Tak threats; quiet or
  // flat-count wins are invisible to the prover) sends the miss, a proof makes it a solve, and no answer sends it
  // unrated. A timeout is never a miss: Boris's f5 on pd616580 won but took ~20 s to prove, and was charged.
  // A 'win' node (road-in-1 on the board) is the same: a move that still forces the win, e.g. a double threat instead
  // of the road, is a solve too (Shy, 2026-11-15; alion02 on pd528655).
  const s = S;
  if (!correct) {
    g.undo(u);
    // The move being checked, played again where it was: still being checked, not a second miss.
    if (S.checkPending?.miss === canon && S.checkPending.at === S.moves.length) { restoreBoard(); return; }
    S.busy = true;
    const plies = [...(S.hist.length ? officialLine() : S.moves.map((m) => m.ptn)), canon];
    let pending = null;
    if (!res && node) {
      const key = provenKey(canon), known = S.proven?.get(key);
      let wins = known === 'wins' || (node !== 'win' && slowerWins().includes(canon));
      const po = playOnDefender();
      if (!wins && !known) {
        S.checking = canon;
        renderAll();
        // Only the first unsettled check can decide the result; a later one is only worth its quick answer, so it
        // gets a small budget (each worker can take hundreds of MB).
        const minor = !!(S.checkPending || S.resultSent);
        const chk = engine.checkStill({ ...enginePos(plies), attacker: S.solver }, minor ? { budgets: [[3e4, 5e3]] } : {});
        // Leaving (or reloading) during the quick check mustn't be a free retry: the attempt is held from here
        // (abandonCheck sends it, unrated: the move was never settled), and the stored next puzzle mustn't be this one.
        const qc = minor ? null : (S.quickCheck = { miss: canon, chk, tMove });
        if (qc) { heldRec.set({ id: S.p.id, ms: tMove }); if (store.get('next', null)?.puzzle?.id === S.p.id) store.del('next'); }
        const quick = await chk.quick;
        if (S !== s || (qc && s.quickCheck !== qc)) { chk.cancel(); return; } // (left: abandonCheck has sent it)
        S.checking = null;
        // Decided: sent as usual. A 'no' goes out now (fail); a win only after the board is put back (slowSolve), so its
        // record stays until report() re-stamps it as the solve (left in between, a reload sends it unrated).
        if (qc) { S.quickCheck = null; if (quick === 'no') heldRec.del(S.p.id); }
        // An earlier held check settled the puzzle while this one ran (solved): this move no longer counts for anything.
        if (S.status !== 'play' && S.status !== 'retry') {
          chk.cancel();
          if (S.status === 'solved') { S.loadedKey = null; await showLine(shownLine(), S.view ?? shownLine().length); if (S === s) afterExplore(); }
          return;
        }
        wins = quick === 'wins';
        if (quick === 'wins' || quick === 'no') (S.proven ||= new Map()).set(key, quick);
        else if (minor) { chk.cancel(); (S.uncheckedMoves ||= new Set()).add(canon); } else pending = chk;
      }
      if (pending && po) return startPlayOn(s, canon, plies, pending, tMove);
      if (wins) return slowSolve(canon, tMove, node);
    }
    const hadMs = S.decidedMs != null, logged = S.log.length;
    logMove('miss', canon, tMove); S.decidedMs ??= tMove;
    S.misses.push({ at: S.moves.length, ptn: canon });
    if (pending) {
      S.checkPending = { miss: canon, at: S.moves.length, key: provenKey(canon), chk: pending, hadMs, logLen: S.log.length,
        logEntry: S.log.length > logged ? S.log.at(-1) : null, flags: { hinted: S.hinted } };
      // In case the page dies before the result is sent: a reload of this tab sends it unrated (flushHeld), and the
      // stored next puzzle mustn't be this one (the server will count it as played either way).
      heldRec.set({ id: S.p.id, ms: tMove });
      if (store.get('next', null)?.puzzle?.id === S.p.id) store.del('next');
      pending.final.then((v) => { if (s.checkPending?.chk === pending) settleCheck(s, v); });
    }
    const remaining = pliesLeft();
    S.refutation = { miss: canon, kind: 'thinking' };
    engine.refute({ ...enginePos(plies), attacker: S.solver, remaining }).then((r) => {
      if (r && S === s && S.refutation?.miss === canon) { S.refutation = { miss: canon, ...r }; renderAll(); }
    });
    fail(tMove);
    setTimeout(() => {
      if (S !== s) return;
      S.busy = false;
      // A held check proved a win meanwhile (settleCheck): the puzzle is solved, so its board stays open for exploring.
      if (S.status === 'solved') { S.loadedKey = null; showLine(shownLine(), S.view ?? shownLine().length).then(() => { if (S === s) afterExplore(); }); return; }
      restoreBoard().then(() => flushHint(s));
    }, 700);
    return;
  }
  logMove('ok', canon, tMove);
  if (wonNow) S.decidedMs ??= tMove;
  S.moves.push({ ptn: canon, me: true }); S.snaps.push(g.toTPS());
  S.refutation = null;
  if (wonNow) return solved();
  S.node = next;
  S.status = 'play';
  S.busy = true;
  renderAll('good');
  setTimeout(async () => {
    if (!reply || S !== s || S.status !== 'play') return; // (a held check may have ended the puzzle meanwhile)
    g.play(reply);
    S.moves.push({ ptn: reply, me: false }); S.snaps.push(g.toTPS());
    await board.append(reply);
    await board.last();
    if (S !== s) return;
    S.busy = false;
    renderAll();
    flushHint(s);
  }, 450);
}

// flags: the hint state the result is judged by (a held miss is judged as it was when it was played).
async function report(win, s = S, flags = s, { keepalive = false, ms } = {}) {
  if (s.resultSent) return;
  if (s.checkPending) { // sent once the check settles (settleCheck), judged as it stands now
    (s.held ||= []).push({ win, hinted: flags.hinted, ms: ms ?? elapsed(s) });
    renderAll(); return;
  }
  s.resultSent = true;
  // Unrated: a hint before the result, or a miss whose check never answered (it may have been a win).
  // A game won against Tiltak (playOnRated) is an unrated solve.
  s.casual = flags.hinted || (!win && !!s.unchecked) || (win && !!flags.playOn?.unrated);
  s.casualWhy = flags.hinted ? 'hint' : !s.casual ? null : win ? 'tiltak' : 'unchecked';
  const p = s.p, timing = { ms: (s.decidedMs ?? elapsed(s)) ?? undefined, log: s.log.length ? s.log : undefined };
  let answered = false;
  // Sent as the page goes away: this request carries the result, so the held copy isn't flushed again (unrated) on the
  // next load; otherwise which of the two reached the server first would decide (a play-on left by reloading is rated).
  if (keepalive) heldRec.del(p.id);
  // A held result settled now: if the page reloads before the server has it, flushHeld sends this result (under this
  // build), not an unrated miss (the server keeps only the first, so a resend of one that landed changes nothing).
  else if (heldRec.get()?.id === p.id) heldRec.set({ id: p.id, ms: timing.ms, win, casual: !!s.casual, theme: s.casual ? undefined : s.theme || undefined });
  try { // a failed upload (network, server restart) loses this result (a held one waits for a reload), not the session
    // noWait: a slow upload mustn't swap the card (and its Hint button) for the waiting notice; a failed one still says so
    const req = api(withBuild('/api/result'), { puzzleId: p.id, win, ...(s.casual ? { casual: true } : { theme: s.theme || undefined }), ...timing,
      ...(token ? {} : { guest: guestSeed() }) }, { noWait: true, keepalive }); // the first result makes a first-time visitor a guest
    reporting.add(req); req.catch(() => {}).finally(() => reporting.delete(req)); // (a reload for a newer build waits for it)
    const r = await req;
    if (r.token) { setToken(r.token); ownHeld(); }
    // Refused: 429 (too many results, or too many new guests from one address) or any other error; nothing was rated.
    if (!r.user && r.error) s.notCounted = /^too many/i.test(r.error) ? 'rate' : 'error';
    if (r.user) {
      heldRec.del(p.id); // recorded: nothing left to resend (a failed upload keeps it for the next load)
      answered = true;
      s.delta = r.rated ? r.userDelta : null; s.serverRated = !!r.rated;
      s.repeat = !r.rated && !s.casual; // played before, or a miss from an out-of-date page (the server doesn't say which)
      // Like Lichess, the info panel keeps the rating the puzzle had when you played it (what you were up
      // against), not the one your result just moved it to.
      if (r.rated) p.attempts++;
      me = r.user; renderUser();
    }
  } catch { s.delta = null; s.notCounted = 'lost'; }
  // Not recorded, but the held copy is still there: a reload of this tab sends it (flushHeld). The cards say which.
  s.resend = !answered && !keepalive && heldRec.get()?.id === p.id;
  session.push({ id: p.id, win, delta: s.delta }); saveSession();
  renderAll();
  // The pair assumed this result counts (or is a repeat, which it allows for); if unrated or lost, ask again.
  if (S === s) nextQ.prefetchNext(win, p.id, !s.casual && answered);
}

// A held result once its slow check settles (s may no longer be the puzzle on screen). 'wins': the miss was a slower
// win after all, which is a solve (see below). 'no': no Tak-threat win was found, so the miss is sent as it stood when
// played (rated, unless a hint came first). 'unknown': it might have won, so the miss is sent unrated.
function settleCheck(s, verdict, opts) {
  const c = s.checkPending, held = s.held || [];
  if (!c) return;
  s.checkPending = null; s.held = null;
  let sent;
  if (verdict === 'wins' || verdict === 'no') (s.proven ||= new Map()).set(c.key, verdict);
  if (verdict === 'wins') {
    // The "miss" was a slower win, and a slower win is a solve (slowSolve): it is the result, sent as a win at the time
    // it was played; whatever happened after it doesn't count. Still on that puzzle, it ends there as solved.
    // (Misses after it went in with it, as did any later move left unchecked.)
    const i = s.misses.findIndex((m) => m.ptn === c.miss && m.at === c.at);
    if (i >= 0) s.misses.length = i;
    s.uncheckedMoves = null;
    if (c.logEntry) c.logEntry.k = 'slow';
    s.log.length = Math.min(s.log.length, c.logLen);
    if (!c.hadMs) s.decidedMs = held[0]?.ms;
    s.slowWin = { move: c.miss, fastest: c.fastest ?? null, playOn: c.flags.playOn };
    // The result is this win, whether or not the solution was looked at after it. While the solution is still being
    // played out, its end (showSolution) finishes the puzzle; the board is left to the animation until then.
    const viewing = s.status === 'viewing';
    if (s.status !== 'solved' && !viewing) { s.status = 'solved'; s.refutation = null; }
    s.outcome = s.misses.length ? 'miss' : 'clean';
    sent = report(true, s, c.flags, opts);
    if (S === s && !viewing) { S.busy = false; openExploration(); }
  } else {
    // A move played out that wasn't won is a miss whatever the check says: rated only if Syntaks defended throughout
    // and moved at least once (gameRated: Tiltak, a dropout or no defender move make it unrated). Without play-on,
    // the check decides.
    const po = c.playOn, unrated = !po ? verdict !== 'no' : !gameRated(po);
    if (unrated) { s.unchecked = c.miss; s.uncheckedWhy = po ? { why: po.end === 'noengine' ? 'noengine' : unratedWhy(po), at: po.fallbackAt || 0, engine: defenderName(po) } : null; }
    s.log.length = Math.min(s.log.length, c.logLen); // the miss decided it: nothing after it belongs in its log
    sent = report(false, s, c.flags, opts);
  }
  if (S === s) renderAll();
  return sent;
}

// Leaving a puzzle (or the page) while its check runs: there's no answer to wait for, so the miss goes in unrated.
function abandonCheck(s, opts) {
  if (!s?.checkPending) return s?.quickCheck ? abandonQuick(s, opts) : null;
  // Leaving in the middle of a play-on counts as giving up (rated miss), or leaving would be the way out of a lost game.
  if (s.playOn && !s.playOn.end) { const sent = endPlayOn(s, 'left', opts); if (!s.checkPending) return sent; }
  s.checkPending.chk.cancel();
  return settleCheck(s, 'unknown', opts);
}
// Left during a first move's quick check (userMove): the same, an unrated miss. The move is logged on s itself (S may
// be on its way to the next puzzle), and if this puzzle stays on screen after all (restoreLeft) it goes on as after a
// miss; the check's late answer is ignored (userMove sees quickCheck gone).
function abandonQuick(s, opts) {
  const { miss, chk, tMove: ms } = s.quickCheck;
  s.quickCheck = null; s.checking = null; chk.cancel();
  if (s.resultSent) return null;
  if (s.t0 != null && s.log.length < 64) s.log.push({ m: miss, ms, k: 'miss' });
  s.decidedMs ??= ms;
  s.misses.push({ at: s.moves.length, ptn: miss });
  s.unchecked = miss; s.status = 'retry'; s.refutation = null; s.needsRestore = true;
  return report(false, s, s, { ...opts, ms });
}
addEventListener('pagehide', () => abandonCheck(S, { keepalive: true }));
// A result held when the page died (crash, a keepalive that didn't make it, or an upload that failed), before anything
// is served: what it goes as, or whether it's dropped, is playon.js heldResend. Unreachable: kept for the next load.
async function flushHeld() {
  const h = heldRec.get();
  if (!h?.id) return null;
  const send = heldResend(h, owner(), await pageAlive(h.page));
  if (!send) return heldRec.del(h.id);
  try {
    const r = await api(withBuild('/api/result', send.build), { ...send.body, ...(token ? {} : { guest: guestSeed() }) }, { quiet: true });
    if (r?.token) setToken(r.token);
    heldRec.del(h.id);
  } catch {}
}

// ---------- play on ----------
// A move the still-wins check can't decide in 2.5 s is played out on the board: the move stays and an engine defends
// (Syntaks on the server for 6×6, Tiltak in the browser for 4×4/5×5; spec agreed with Shy 2026-11-15). Your road or
// flat win within capMoves (playon.js), or Syntaks resigning, is a solve like any longer win (3421d53): the game
// becomes the puzzle's line and the puzzle ends there. Syntaks holding (out of moves, its road, flats or a draw), Give
// up or leaving is a miss. Which of these count toward rating is playon.js's gameRated / winRated (only a game Syntaks
// defended throughout; Tiltak, a dropout, no defender move or a stalled reply make it unrated both ways, while a proof
// always counts). The check runs on meanwhile: a proof ends the game as a solve at once, and a 'no' is ignored (the
// prover only sees road threats; the game decides). The result is held as for a pending check (checkPending with
// .playOn), so settleCheck sends it, and a reload resends what was settled (flushHeld). No engine at all ('noengine')
// sets po.fallback: unrated whatever the check says.
const playOnDefender = () => defender(S.p.size, S.p.komi || 0, tiltak.supports);
// (6×6 is Syntaks's even where it can't run in this browser (no WebAssembly SIMD): crux answers every reply then.)
const defenderName = (po) => (po.engine === 'syntaks' && !po.fallback ? 'Syntaks' : 'Tiltak');
// Whether a game won on the board counts toward rating. A weak reply can let a move that doesn't force the win "win",
// so only Syntaks's defence is trusted for rating; a win against Tiltak is an unrated solve. (A proof always counts.)
const playOnRated = (po) => gameRated(po); // (playon.js: only a game Syntaks defended throughout counts, either way)

function startPlayOn(s, canon, plies, chk, tMove) {
  const hadMs = s.decidedMs != null, logged = s.log.length, left = pliesLeft();
  logMove('miss', canon, tMove); s.decidedMs ??= tMove;
  s.misses.push({ at: s.moves.length, ptn: canon });
  const po = s.playOn = { miss: canon, at: s.moves.length, base: plies.slice(0, -1), line: [canon], g: gameAt(plies),
    mine: 1, cap: capMoves(left), capNote: capNote(left), engine: playOnDefender(), fallback: false, thinking: false, end: null };
  s.checkPending = { miss: canon, at: s.moves.length, key: provenKey(canon), chk, hadMs, logLen: s.log.length, playOn: po,
    fastest: s.node === 'win' ? finisher(s.g) : Object.keys(s.node)[0], // the puzzle's own move here, for the solved card
    logEntry: s.log.length > logged ? s.log.at(-1) : null, flags: { hinted: s.hinted } };
  heldRec.set({ id: s.p.id, ms: tMove });
  if (store.get('next', null)?.puzzle?.id === s.p.id) store.del('next');
  chk.final.then((v) => {
    const c = s.checkPending;
    if (c?.chk !== chk) return;
    if (c.playOn.end) return settleCheck(s, v); // (only after 'noengine': a lost game stops the check)
    if (v === 'wins') endPlayOn(s, 'proved'); else c.final = v; // still playing: only a proof ends the game
  });
  po.local = po.engine === 'syntaks' && syntaks.supports(s.p.size, s.p.komi || 0);
  if (po.local) syntaks.load(); // the in-browser engine, fetched on first use (crux answers meanwhile)
  else if (po.engine === 'tiltak') Promise.resolve().then(tiltak.warmup).catch(() => {}); // it defends here: start it while the board settles
  // Give up sits where Hint was: it ignores clicks for its first 1.5 s, so one meant for Hint can't end the game
  po.t0 = performance.now(); setTimeout(() => { if (S === s && s.playOn === po) renderAll(); }, 1600);
  s.status = 'playon'; s.refutation = null; s.checking = null;
  s.pendingHint = s.pendingSolution = false; // pressed during the quick check: not meant for after the game
  report(false, s, s, { ms: tMove }); // held until the game (and the check) settle
  defenderTurn(s, po);
}

// Syntaks's reply. It runs in the browser (syntaks.js, loaded when play-on starts; 1.5 s a reply). Until it has loaded,
// or on a device too slow for a real defence (fewer than LOCAL_MIN_NODES in that time), crux answers (/api/defend,
// 8 s). With neither, Tiltak in the browser defends the rest of the game, which is then unrated (playOnRated).
const LOCAL_MIN_NODES = 150e3; // ~100k nodes/s: a fraction of crux's ~2.6M nodes per reply
async function syntaksReply(s, po, tps, komi, live) {
  const legal = (r) => (r && legalMove(po.g, r.move) ? r : null);
  // Each in-browser search gets its 1.5 s plus 3 s (a worker the browser killed never answers); waiting for the
  // download (crux didn't answer) gets 20 s. Past either, crux or Tiltak defends.
  const within = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(res, ms, null))]);
  const local = (wait = 0) => within(syntaks.search({ tps, komi, ms: 1500, nodes: 1.5e6 }), 4500 + wait)
    .then((r) => legal(r && { ...r, src: 'browser' }), () => null);
  const server = () => {
    po.ctl = new AbortController(); // aborted when the game ends, so crux drops the search
    return api(`/api/defend?tps=${encodeURIComponent(tps)}&komi=${komi}`, null, { quiet: true, timeout: 8000, signal: po.ctl.signal }).then((r) => legal(r && { ...r, src: 'crux' }), () => null);
  };
  let r = null;
  if (po.local && syntaks.status() === 'ready' && !po.slowLocal) {
    r = await local();
    if (!live()) return null;
    // this device: crux for the next replies (only a search that used its time on an undecided position says so)
    if (r && r.nodes < LOCAL_MIN_NODES && r.mate == null && r.ms >= 1200) po.slowLocal = true;
  }
  if (!r) { r = await server(); if (!live()) return null; }
  if (!r && po.local && syntaks.status() !== 'failed') { r = await local(20e3); if (!live()) return null; } // waits for the download
  if (r) console.debug(`play-on: Syntaks (${r.src}) ${r.move}, ${r.nodes ?? '?'} nodes, ${r.ms} ms`);
  return r;
}

// The defender's reply: Syntaks (syntaksReply), else Tiltak in the browser for the rest of this game.
async function defenderTurn(s, po) {
  const live = () => S === s && s.playOn === po && !po.end;
  const typed = document.activeElement?.id === 'ptn-in'; // a keyboard player gets the move box back after the reply
  po.thinking = true; po.thinkingSince = performance.now(); s.busy = true;
  await board.ui({ disableBoard: true });
  renderAll();
  const komi = s.p.komi || 0, tps = po.g.toTPS();
  let mv = null, r = null;
  if (po.engine === 'syntaks' && !po.fallback) {
    r = await syntaksReply(s, po, tps, komi, live);
    if (!live()) return;
    mv = r && legalMove(po.g, r.move);
    if (!mv) { po.fallback = true; po.fallbackAt = po.mine; r = null; renderAll(); }
    // Syntaks's search sees a forced road (or flat win) for you: it resigns. (Its answer is in: not overdue.)
    else if (resigns(r.mate, s.solver)) { po.thinking = false; return endPlayOn(s, 'resign'); }
  }
  if (!mv && tiltak.supports(s.p.size, komi)) {
    // (a worker that never answers mustn't stall the game: 6 s from when it's up (a cold start, fetching and compiling
    // the wasm, gets 20 s of its own, as Syntaks's download does), then it's as if no engine could move)
    const up = await Promise.race([Promise.resolve().then(tiltak.warmup).then(() => true, () => false), new Promise((res) => setTimeout(res, 20e3, false))]);
    if (!live()) return;
    const t = up && await Promise.race([tiltak.analyze({ tps, size: s.p.size, komi, ms: 1500 }).catch(() => null), new Promise((res) => setTimeout(res, 6000, null))]);
    if (!live()) return;
    mv = legalMove(po.g, t?.bestmove);
  }
  if (!mv) { po.fallback = true; return endPlayOn(s, 'noengine'); }
  po.thinking = false; // the reply is in hand: leaving while the board plays it isn't the defender being overdue (stalls)
  po.g.play(mv); po.line.push(mv);
  await board.append(mv); await board.last();
  if (!live()) return;
  const end = ending(po.g.result(), s.solver);
  if (end) return endPlayOn(s, end);
  po.thinking = false; s.busy = false;
  await board.setPlayer(s.solver);
  await board.ui({ disableBoard: false });
  renderAll();
  if (typed && live()) $('#ptn-in').focus();
}

// Your move in the game: checked against the game's own position, then the defender answers.
async function playOnMove(ptn) {
  const s = S, po = s.playOn;
  const back = () => showPlayOn(s);
  if (po.end || po.thinking || s.busy) return back();
  let canon;
  try { canon = po.g.canon(ptn); } catch { return back(); }
  if (!legalMove(po.g, canon)) return back();
  po.g.play(canon); po.line.push(canon); po.mine++;
  logMove('po', canon);
  const end = ending(po.g.result(), s.solver);
  if (end) return endPlayOn(s, end);
  if (po.mine >= po.cap) return endPlayOn(s, 'out');
  defenderTurn(s, po);
}
// Put the board back to the game as played (after a refused move).
async function showPlayOn(s) {
  if (S !== s || !s.playOn) return;
  await board.load(ptnFor([...s.playOn.base, ...s.playOn.line]));
  S.loadedKey = null;
  await board.last();
}

// The game is over. A win (your road, Syntaks resigning, or the check's proof) is a solve; anything else makes it a
// miss, sent once the check has answered too (a later proof still makes it a solve).
function endPlayOn(s, kind, opts) {
  const po = s.playOn, c = s.checkPending;
  if (!po || po.end) return;
  // Left while Syntaks was overdue with a reply (Give up, Solution, leaving): that game doesn't count (gameRated).
  if (stalls(po, kind, performance.now())) po.stalled = true;
  po.end = kind; po.thinking = false; po.ctl?.abort();
  if (c?.playOn === po) c.logLen = s.log.length; // the game's moves belong in this result's log
  if (kind === 'win' || kind === 'resign' || kind === 'proved') {
    // The game becomes the puzzle's line (the board already shows it) and the puzzle ends there, solved (settleCheck).
    s.playOn = null; s.loadedKey = null;
    po.line.forEach((m, j) => { s.g.play(m); s.moves.push({ ptn: m, me: j % 2 === 0, po: j > 0 }); s.snaps.push(s.g.toTPS()); });
    if (c?.playOn === po) {
      c.flags.playOn = { how: kind, engine: defenderName(po), unrated: !winRated(po, kind), why: unratedWhy(po) };
      settleCheck(s, 'wins', opts); c.chk.cancel();
    }
    return;
  }
  s.playOn = null;
  s.status = 'retry';
  // byYou: the last ply was the player's (line[0] is theirs), e.g. a move that completed only the defender's road
  s.refutation = { miss: po.miss, kind: 'playon', how: kind, n: po.mine, engine: defenderName(po),
    byYou: po.line.length % 2 === 1 };
  if (kind === 'noengine') s.refutation = { miss: po.miss, kind: 'unknown' };
  // A lost game (Syntaks held, out of moves, Give up, left) is final: the check is stopped and the miss sent now, rated
  // only if gameRated (settleCheck). With no engine at all ('noengine', po.fallback set) the check still runs, so a
  // proof can make it a solve, but a miss is unrated whatever it says.
  let sent = null;
  if (c?.playOn === po) {
    if (kind !== 'noengine') { c.chk.cancel(); sent = settleCheck(s, 'unknown', opts); }
    else if (c.final) sent = settleCheck(s, c.final, opts);
  }
  if (kind === 'left') { s.needsRestore = true; return sent; } // the board is put back only if this puzzle stays (restoreLeft)
  s.busy = true;
  if (S === s) { renderAll(); restoreBoard().then(() => { if (S !== s) return; s.busy = false; renderAll(); flushHint(s); }); }
  return sent;
}
// A puzzle left mid-game that is still on screen after all (Next failed to load, or the page came back from the
// back/forward cache): put the board back to its accepted moves.
function restoreLeft() {
  if (!S?.needsRestore) return;
  const s = S;
  s.needsRestore = false; s.busy = false;
  restoreBoard().then(() => flushHint(s));
}
addEventListener('pageshow', (e) => { if (e.persisted) restoreLeft(); });
// Proven slower wins at the current attacker node: alts at the root, altsAt[path of moves so far] deeper in.
function slowerWins() {
  const key = S.moves.map((m) => m.ptn).join(' ');
  return (key ? S.p.altsAt?.[key] : S.p.alts) || [];
}

function fail(ms) { S.status = 'retry'; report(false, S, S, { ms }); renderAll(); }
// Still-wins verdicts already known in this puzzle, by position and move, so a repeat doesn't search again.
const provenKey = (canon) => S.moves.map((m) => m.ptn).join(' ') + '|' + canon;

async function solved() {
  S.status = 'solved';
  S.outcome = S.viewed ? 'viewed' : S.misses.length ? 'miss' : 'clean';
  if (!S.resultSent) report(true);
  await openExploration();
}

// A proven forced win the puzzle's line doesn't take (it's slower: the tree has every fastest win) is a solve: longer
// wins count as wins (Shy, 2026-11-15: "People don't like having to play for shortest"). The move stays on the board,
// the puzzle ends there, and the card names the puzzle's faster move. node: the attacker node the move was played at.
function slowSolve(canon, tMove, node) {
  const g = S.g;
  logMove('slow', canon, tMove); S.decidedMs ??= tMove;
  S.slowWin = { move: canon, fastest: node === 'win' ? finisher(g) : Object.keys(node)[0] };
  g.play(canon);
  S.moves.push({ ptn: canon, me: true }); S.snaps.push(g.toTPS());
  S.refutation = null; S.busy = false;
  restoreBoard().then(() => solved());
}

// After the puzzle the board is free: play any legal move, for either side, from any position.
async function openExploration() {
  await board.ui({ disableBoard: false, dropOnStray: true }); // roads are drawn only where one is complete (board.js does that by itself)
  await board.setPlayer(gameAt(shownLine().slice(0, S.view ?? shownLine().length)).toMove);
  renderAll();
  runEngine();
}

async function explore(ptn) {
  const line = shownLine();
  const at = S.view ?? line.length;
  const base = line.slice(0, at);
  const g = gameAt(base);
  let canon;
  try { canon = g.canon(ptn); } catch { return showLine(line, at); }
  if (g.result() || !g.legalMoves().some((m) => g.moveToPTN(m) === canon)) return showLine(line, at);
  const official = officialLine();
  if (at < line.length && line[at] === canon) { S.view = at + 1 >= line.length ? null : at + 1; await showLine(line, at + 1); return afterExplore(); } // next move of the line you're on
  if (S.onBranch && S.branch && at <= S.branch.at && at < official.length && official[at] === canon) { // the solution's own move from the shared prefix
    S.onBranch = false; S.view = at + 1 >= official.length ? null : at + 1; await showLine(official, at + 1); return afterExplore();
  }
  if (S.onBranch && S.branch && at === line.length) S.branch.moves.push(canon); // extend your line
  else {
    const branchAt = S.onBranch && S.branch ? Math.min(at, S.branch.at) : at;
    const prefix = S.onBranch && S.branch && at > S.branch.at ? S.branch.moves.slice(0, at - S.branch.at) : [];
    S.branch = { at: branchAt, moves: [...prefix, canon] };
  }
  S.onBranch = true;
  S.view = null;
  const now = shownLine();
  // The board already shows this line (the move was just made on it): keep it, so the move animates.
  const bs = board.snaps;
  if (bs.length === now.length + 1 && board.cur === now.length && bs.at(-1).ptn === canon) S.loadedKey = now.join(' ');
  else { S.loadedKey = null; await showLine(now, now.length); }
  afterExplore();
}
async function afterExplore() {
  const line = shownLine();
  const g = gameAt(line.slice(0, S.view ?? line.length));
  await board.setPlayer(g.toMove);
  renderAll();
  runEngine();
}
async function backToSolution() {
  // Return to where your line split off (not the end of the solution, a finished game where no move can be played).
  const at = Math.min(S.branch?.at ?? officialLine().length, officialLine().length);
  S.branch = null; S.onBranch = false; S.loadedKey = null;
  S.view = at < officialLine().length ? at : null;
  await showLine(officialLine(), at);
  afterExplore();
}

function finisher(g) {
  for (const m of g.legalMoves()) { const u = g.apply(m); const r = g.result(); g.undo(u); if (r && r.winner === S.solver) return g.moveToPTN(m); }
  return null;
}

// Play out the main line (first-listed move at each node) for "View solution".
async function showSolution() {
  // Pressed while the board is busy (the puzzle's intro, the opponent's reply, the reset after a miss): play it out
  // once the board is free (flushHint), as with Hint.
  if (S && S.busy && (S.status === 'retry' || S.status === 'play') && !S.placeholder) { S.pendingSolution = true; return; }
  // In the middle of a play-on: give up (a miss), then show it once the board is back
  if (S?.playOn) { if (!S.playOn.end) { S.pendingSolution = true; endPlayOn(S, 'gaveup'); } return; }
  if (!S || S.placeholder || S.status === 'solved' || S.status === 'viewing' || S.busy) return;
  const s = S;
  if (!S.resultSent) { const at = elapsed(); S.decidedMs ??= at; logMove('view', null, at); report(false, S, S, { ms: at }); }
  S.status = 'viewing'; S.viewT0 = performance.now(); // (justViewed)
  await restoreBoard();
  if (S !== s) return;
  await board.ui({ disableBoard: true });
  const g = S.g;
  const step = async () => {
    if (S !== s) return;
    const node = S.node;
    const mv = node === 'win' ? finisher(g) : Object.keys(node)[0];
    if (!mv) return;
    g.play(mv); S.moves.push({ ptn: mv, me: true, shown: true }); S.snaps.push(g.toTPS());
    await board.append(mv); await board.last();
    if (S !== s) return;
    if (g.result()) { S.viewed = true; S.status = 'solved'; S.outcome = S.slowWin ? (S.misses.length ? 'miss' : 'clean') : 'viewed'; S.view = null; await openExploration(); return; } // (a held move proved to win meanwhile: that's the result)
    const { r: reply, n } = node[mv];
    renderAll();
    setTimeout(async () => {
      if (S !== s) return;
      g.play(reply); S.moves.push({ ptn: reply, me: false }); S.snaps.push(g.toTPS());
      await board.append(reply); await board.last();
      if (S !== s) return;
      S.node = n; renderAll();
      setTimeout(step, 750);
    }, 750);
  };
  step();
}

// A Hint (or Solution) pressed while the board is busy (the opponent's reply, the reset after a wrong move) would be
// lost: remember it and show it once the board is free. Solution wins over a pending hint. Not during a new puzzle's
// intro or its first second: those presses are dropped (fresh), since they are usually meant for the last puzzle.
function flushHint(s) {
  if (S !== s) return;
  if (s.pendingSolution) { s.pendingSolution = s.pendingHint = false; showSolution(); }
  else if (s.pendingHint) { s.pendingHint = false; showHint(); }
}
function showHint() {
  if (S && S.busy && (S.status === 'retry' || S.status === 'play') && !S.placeholder) { S.pendingHint = true; return; }
  if (!S || S.placeholder || S.busy || S.playOn || S.status === 'solved' || S.status === 'viewing') return;
  // Looking at an earlier position: go back to the live one and show the hint there.
  if (S.view != null) { const s = S; restoreBoard().then(() => { if (S === s && S.view == null) showHint(); }); return; }
  const g = S.g;
  const mv = S.node === 'win' ? finisher(g) : Object.keys(S.node)[0];
  if (!mv) return;
  if (!S.hinted) logMove('hint');
  S.hinted = true;
  // Each press at the same position says more: 1, the square to play on or move from; 2, the whole path of a stack
  // move; 3, the stone to place or how to drop the stack. A miss that already used those squares skips ahead.
  const path = moveSquares(mv), at = S.moves.length, lastMiss = S.misses.at(-1);
  let level = S.hint?.node === S.node && S.hint.at === at ? S.hint.level + 1 : 1;
  if (lastMiss?.at === at) {
    const missed = moveSquares(lastMiss.ptn);
    if (missed[0] === path[0]) level = Math.max(level, 2);
    if (missed.join() === path.join()) level = Math.max(level, 3);
  }
  if (path.length === 1 && level === 2) level = 3; // a placement has no path to show
  level = Math.min(level, 3);
  S.hint = { node: S.node, at, level, sqs: level >= 2 ? path : path.slice(0, 1), note: level === 3 ? moveNote(mv) : '' };
  board.highlight(S.hint.sqs);
  renderAll();
}
// The last hint step in words: which stone to place, or how many to carry and how to drop them.
function moveNote(ptn) {
  const m = /^(\d?)[a-h][1-8]([<>+-])(\d*)/.exec(ptn);
  if (!m) return `Place a ${{ S: 'wall', C: 'capstone' }[ptn[0]] || 'flat'} there.`;
  const n = +m[1] || 1, drops = m[3] ? m[3].split('').map(Number) : [n];
  if (drops.length === 1) return n === 1 ? 'Move the top piece one square.' : `Carry ${n} pieces one square.`;
  return `Carry ${n} pieces and drop ${drops.join(', then ')}.`;
}
// Squares a move touches, as names: where it starts, then each square a stack drops onto.
function moveSquares(ptn) {
  const m = /^(\d?)([a-h])([1-8])([<>+-])?(\d*)/.exec(ptn.replace(/^[FSC]/, ''));
  if (!m) return [];
  const sqs = [m[2] + m[3]];
  if (!m[4]) return sqs;
  const [df, dr] = { '+': [0, 1], '-': [0, -1], '>': [1, 0], '<': [-1, 0] }[m[4]];
  let f = m[2].charCodeAt(0), r = +m[3];
  for (let i = 0; i < (m[5] ? m[5].length : 1); i++) { f += df; r += dr; sqs.push(String.fromCharCode(f) + r); }
  return sqs;
}

// Browse any earlier position (game history or puzzle moves). Index = number of plies shown.
async function viewPly(i, branch = S.onBranch) {
  if (!S || S.placeholder || board.holding) return; // stones in hand: finish or cancel the move first
  if (S.playOn) return; // a play-on game is played, not browsed
  if (S.status === 'solved') {
    S.onBranch = !!(branch && S.branch);
    const line = shownLine();
    i = Math.max(0, Math.min(line.length, i));
    S.view = i === line.length ? null : i;
    await showLine(line, i);
    return afterExplore();
  }
  if (S.busy || S.status === 'viewing') return; // the board is mid-animation; browse once it settles
  const total = S.hist.length + S.moves.length;
  i = Math.max(0, Math.min(total, i));
  if (i === total) { if (S.view != null) await restoreBoard(); return; }
  S.view = i;
  await board.highlight([]); // the hint belongs to the live position; restoreBoard redraws it
  await board.ui({ disableBoard: true });
  if (i === 0) await board.first(); else await board.goTo(i - 1);
  renderAll();
}

// Before a puzzle arrives, render the real panels with dummy values (masked by CSS), so nothing jumps.
let fbFocus = null; // data-act of the feedback button that had keyboard focus before a re-render
const finePointer = matchMedia('(pointer: fine)');
const PLACEHOLDER = {
  placeholder: true, solver: 1, status: 'play', moves: [], view: null, delta: null, misses: [], branch: null, onBranch: false,
  hist: 'a1 e5 c3 b4 d3 c4 b3 d4 e3 a4 c2 e4 b2 a5 d2'.split(' '),
  p: { id: '', size: 5, themes: [], meta: {}, komi: 0, tps: 'x5/x5/x5/x5/x5 1 1', rating: 0, attempts: 0 },
};

// Engine, Lichess-style: one compact line at the top of the panel. Chance bar, who's better, and the
// engine's line as clickable moves (click to play it on the board), with a small source tag at the end.
function engineMarkup() {
  let engineHtml = '';
  if (S && S.status === 'solved' && (S.tk || S.eval)) {
    const pvHtml = (pv) => (pv || []).slice(0, 8).map((m, k) => `<button class="pvm" data-pv="${k}">${esc(m)}</button>`).join('');
    let lead = '', pv = '', tag = '';
    if (S.eval?.kind === 'over') lead = S.eval.winner === 0 ? 'Drawn on flats' : `${colorName(S.eval.winner)} won`;
    else if (S.tk) {
      if (S.tk.thinking) lead = '<span class="muted">Thinking…</span>';
      else {
        const pw = Math.max(0, Math.min(1, S.tk.winProb ?? 0.5));
        // Syntaks proves forced wins: mate = moves to the win, signed from White's side.
        const fav = S.tk.mate ? `${S.tk.mate > 0 ? 'White' : 'Black'} wins in ${Math.abs(S.tk.mate)}`
          : Math.abs(pw - 0.5) < 0.05 ? 'Even' : `${pw > 0.5 ? 'White' : 'Black'} ${Math.round(Math.max(pw, 1 - pw) * 100)}%`;
        lead = `<span class="bar" title="White’s chances"><i style="width:${(pw * 100).toFixed(1)}%"></i></span><b>${fav}</b>`;
        pv = pvHtml(S.tk.pv);
      }
      tag = S.tk.src === 'syntaks'
        ? '<a class="src" href="https://github.com/Ciekce/syntaks" target="_blank" rel="noopener" title="Evaluation by Syntaks, Ciekce’s 6×6 engine, running on the puzzle server">Syntaks</a>'
        : '<a class="src" href="https://github.com/MortenLohne/tiltak" target="_blank" rel="noopener" title="Evaluation by Tiltak, running in your browser">Tiltak</a>';
    } else if (S.eval) {
      const e = S.eval, side = colorName(e.side);
      lead = e.kind === 'thinking' ? '<span class="muted">Thinking…</span>'
        : e.kind === 'win' ? `<b>${side} wins in ${Math.ceil(e.plies / 2)}</b>` : `<span class="muted">No forced win for ${side}</span>`;
      pv = e.kind === 'win' ? pvHtml(e.pv) : '';
      tag = '<span class="src">solver</span>';
    }
    engineHtml = `<div class="eng">${lead}<span class="pvline">${pv}</span>${tag}</div>`;
  }
  return engineHtml;
}
// Update only the engine row (Tiltak streams updates; re-rendering the whole panel would flicker).
function renderEngine() {
  const slot = document.querySelector('#moves .eng-slot');
  if (!slot) return renderAll();
  const html = engineMarkup();
  if (slot._html !== html) { const f = pvFocused(); slot.innerHTML = html; slot._html = html; refocusPV(f); fitDock(); }
}
// After clicking a move in the engine line, the line is redrawn for the new position: keep keyboard focus
// on its first move (Enter again steps further along), or on Forward while the engine is still thinking.
const pvFocused = () => !!document.activeElement?.closest?.('#moves [data-pv]');
let pvFollow = false; // focus is parked on Forward until the engine's new line arrives
const refocusPV = (was) => {
  const onFwd = !!document.activeElement?.matches?.('#moves [data-step="next"]');
  const pv0 = $('#moves [data-pv="0"]');
  if (was && !pvFocused()) { if (pv0) pv0.focus(); else { $('#moves [data-step="next"]')?.focus(); pvFollow = true; } }
  else if (pvFollow && onFwd && pv0) { pv0.focus(); pvFollow = false; }
  else if (pvFollow && !onFwd) pvFollow = false;
};

// ---------- rendering ----------
// After the puzzle: the result of the position on the board, if that game is over (then no move can be played there).
// dragon: the last move completed both players' roads (the mover wins: the dragon clause)
const shownOver = () => {
  const line = shownLine(), g = gameAt(line.slice(0, S.view ?? line.length)), r = g.result();
  return r && { ...r, dragon: r.kind === 'road' && g.hasRoad(1) && g.hasRoad(2) };
};
const overNote = (r) => `Game over here: ${!r.winner ? 'a draw' : r.dragon ? `${colorName(r.winner)} completed both roads at once, and the player who moved wins (the dragon clause)` : `${colorName(r.winner)} ${r.kind === 'road' ? 'made a road' : 'won on flats'}`}. `
  + `Step back${finePointer.matches ? ' (←)' : ''} or click an earlier move to explore from there.`;
// A longer win: proven by the search, or won on the board against an engine (play on).
const slowWinText = (w) => {
  const m = esc(w.move), po = w.playOn;
  return po?.how === 'win' ? `${m} won against ${po.engine}, so it counts as solved`
    : po?.how === 'resign' ? `${m} won: Syntaks resigned, seeing a forced win for you, so it counts as solved`
    : `${m} forces a win too, so it counts as solved`;
};
const solvedTitle = () => S.outcome === 'viewed' ? 'Solution shown' : S.outcome === 'miss' ? 'Solved, after a miss' : 'Solved';
// Review dock (Shy picked it from mockups): on phones in portrait, once the puzzle is over, the result with Next
// puzzle, Tiltak's line and the step buttons are pinned to the bottom of the screen. It only exists while pinned;
// everywhere else the move panel keeps its usual order (engine line, moves, steps) and the card keeps the result.
const DOCK_MQ = matchMedia('(max-width: 860px) and (min-height: 561px)');
DOCK_MQ.addEventListener?.('change', () => { if (S) renderAll(); });
// The page reserves the dock's height at its very end (below the footer) and as scroll padding, so nothing
// ends up stuck under it; and the board shrinks if that's what it takes to keep board + tray above the dock.
const fitDock = () => {
  const d = document.querySelector('#moves .dock'), page = $('#view-puzzle'), root = document.documentElement;
  const pinned = !!d && !page.classList.contains('hidden');
  const h = pinned ? d.offsetHeight : 0;
  root.style.setProperty('--dock-h', h + 'px');
  root.classList.toggle('docked', pinned);
  const wrap = $('#board-wrap');
  wrap.style.maxWidth = '';
  if (pinned && S?.p?.size) {
    const top = wrap.getBoundingClientRect().top + scrollY, w = wrap.clientWidth;
    // scale by the board host's own shape (flat bar + board + tray, or PTN Ninja's frame), measured at full width;
    // the floor is low enough that a 320 px phone's tray stays above the dock
    const maxW = Math.max(160, Math.floor(((root.clientHeight - h - top - 8) * w) / wrap.offsetHeight));
    if (maxW < w) wrap.style.maxWidth = maxW + 'px';
  }
};
const dockRO = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitDock()) : null;
addEventListener('resize', () => fitDock());
const nextBtn = () => $('#moves .dock [data-act="next"]') || $('#feedback [data-act="next"]');
// "+12" / "−8": a rating change, with a real minus sign.
const signed = (d) => (d >= 0 ? '+' : '−') + Math.abs(Math.round(d));
const deltaSpan = (d) => `<span class="delta ${d >= 0 ? 'up' : 'down'}">${signed(d)}</span>`;

// Redraw the side panel from S: the feedback card, the session card (your rating), the puzzle's info and the move list.
function renderAll(mood) {
  if (!S) S = PLACEHOLDER;
  const loading = !!S.placeholder;
  for (const id of ['#feedback', '#moves']) $(id).classList.toggle('is-loading', loading);
  const delta = S.delta != null ? deltaSpan(S.delta) : '';
  const focusNext = renderFeedback(mood, delta);
  renderSession();
  renderBuildBar();
  // Everything about the puzzle itself comes at the end.
  const done = S.status === 'solved';
  const docked = done && DOCK_MQ.matches;
  const vp = $('#view-puzzle');
  vp.classList.toggle('analysis', done); // phones: step buttons only for the review...
  vp.classList.toggle('peek', !done && S.view != null); // ...or to get back after tapping an earlier move
  vp.classList.toggle('docked', docked);
  renderInfo(done);
  renderMoves(docked, delta, focusNext);
}

// The result didn't reach the server: refused ('rate', 'error') or no answer ('lost'). A held one with no answer is
// still in this tab (S.resend), and a reload sends it, so it isn't "not rated" yet. A refusal isn't told to reload: a
// resend right away is usually refused again (the guest limit is per hour), and flushHeld drops it then.
const notCountedText = () => {
  const n = S.notCounted;
  if (!n) return '';
  if (S.resend && n === 'lost') return 'Your result isn’t saved yet: the server didn’t answer. Reload the page to send it again.';
  return n === 'rate' ? 'Not rated: too many results too quickly; try again in a bit.'
    : n === 'lost' ? 'Your result couldn’t be saved: the server didn’t answer.' : 'Not rated: the server didn’t record this result.';
};
// A held result: still checking a move that might win, or the check gave up (then the miss went in unrated).
// (Solved meanwhile: a game played out is over by then, with no engine ('noengine'), so its miss is unrated anyway.)
const uncheckedText = () => S.checkPending ? (S.status === 'solved'
    ? `Still checking whether ${esc(S.checkPending.miss)} forces a win: if it does, the puzzle counts as solved; if not, ${S.checkPending.playOn || S.checkPending.flags.hinted ? 'the miss goes in unrated' : 'the miss counts'}. If you move on before that’s known, ${S.checkPending.playOn && !S.checkPending.playOn.fallback ? 'the miss counts' : 'it goes in unrated'}.`
    : `Still checking whether ${esc(S.checkPending.miss)} forces a win; your result is sent once that’s known.`)
  : S.casualWhy === 'unchecked' ? (S.uncheckedWhy?.why ? playOnUnratedText(S.uncheckedWhy) : `Not rated: ${esc(S.unchecked)} might win, and there wasn’t time to check.`) : '';
// Why a played-out miss isn't rated (playon.js unratedWhy).
const playOnUnratedText = (u) => u.why === 'tiltak' ? 'Not rated: Tiltak defended.'
  : u.why === 'nomove' ? `Not rated: ${u.engine} hadn’t moved yet.`
  : u.why === 'stalled' ? 'Not rated: Syntaks didn’t answer in time.'
  : u.why === 'noengine' ? 'Not rated: no engine could answer.'
  : `Not rated: Syntaks dropped out ${u.at > 1 ? `after ${u.at} moves` : 'at the start'}, so Tiltak defended.`;
// The feedback card (a live region). Returns whether Next puzzle should take keyboard focus once it is drawn.
function renderFeedback(mood, delta) {
  const fb = $('#feedback');
  const dis = S.placeholder ? ' disabled tabindex="-1"' : fresh(S) ? ' disabled' : ''; // (fresh: a new puzzle's first second)
  const playActions = `<div class="actions"><button data-act="hint"${dis}>Hint</button><button data-act="solution"${dis} title="View the solution">Solution</button></div>`;
  const other = colorName(3 - S.solver);
  const refText = (r) => !r ? '' : r.kind === 'thinking' ? `Checking why ${esc(r.miss)} fails…`
    : r.kind === 'gives-road' ? `After ${esc(r.miss)}, ${other} makes a road with <b>${esc(r.reply)}</b>.`
    : r.kind === 'lost' ? (r.how === 'road' ? `${esc(r.miss)} completes ${other}’s road but not yours, so ${other} wins on the spot.`
      : r.how === 'flat' ? `${esc(r.miss)} ends the game, and ${other} wins on flats.` : `${esc(r.miss)} ends the game in a draw.`)
    : r.kind === 'refuted' ? `After ${esc(r.miss)}, ${other} answers <b>${esc(r.reply)}</b> and ${r.exact ? 'the forced win is gone' : 'the solver finds no forced win'}.`
    : `${esc(r.miss)} doesn’t force the win.`;
  // A move whose still-wins check is running or gave up gets no "why it fails": it may yet be a (slower) win.
  const unsure = (m) => m != null && (m === S.checkPending?.miss || m === S.unchecked || !!S.uncheckedMoves?.has(m));
  const hintNote = S.hint?.note && S.hint.node === S.node && S.hint.at === S.moves.length ? `<b>Hint:</b> ${esc(S.hint.note)} ` : '';
  // The result didn't reach the server (refused, or no answer): say so instead of "counts as a miss".
  const NOT_COUNTED = notCountedText(), UNCHECKED = uncheckedText();
  const missNote = () => S.notCounted ? `${NOT_COUNTED} Keep trying or view the solution.`
    : S.checkPending ? `Still checking whether ${esc(S.checkPending.miss)} forces a win; if it does, it isn’t a miss. Keep trying or view the solution.`
    : S.casualWhy === 'unchecked' ? `${UNCHECKED} Keep trying or view the solution.`
    : S.casualWhy === 'hint' ? 'You used a hint, so this one doesn’t count toward your rating. Keep trying or view the solution.'
    // (the server's own answer: a repeat attempt or an out-of-date page is recorded unrated, and it doesn't say which)
    : S.repeat ? 'It isn’t rated: you’ve played this puzzle before, or this page is out of date. Keep trying or view the solution.'
    : 'This puzzle now counts as a miss; keep trying or view the solution.';
  let fbHtml;
  if (notice) {
    $('#feedback').classList.remove('is-loading');
    fbHtml = `<div class="icon bad">!</div><div class="body"><h2>${esc(notice.title)}</h2><p>${esc(notice.body)}</p></div>`;
  } else if (S.checking) {
    fbHtml = `<div class="icon turn p${S.solver}">…</div><div class="body"><h2>Checking ${esc(S.checking)}</h2>
      <p>That isn’t the puzzle’s line; checking whether it still forces a win.</p></div>${playActions}`;
  } else if (S.playOn) {
    // Play on (see startPlayOn). The wording is Shy's approved spec (2026-11-15).
    const po = S.playOn, E = defenderName(po), m = esc(po.miss);
    {
      const n = po.thinking ? po.mine : po.mine + 1;
      fbHtml = `<div class="icon turn p${S.solver}"></div><div class="body"><h2>Play it out</h2>
        <p>We couldn’t check ${m} in time, so show it on the board: ${E} defends. Win within <span class="cap" title="${esc(po.capNote)}">${po.cap}</span> of your moves (counting ${m}) and it counts as solved. If ${E} holds, it’s a miss.${po.engine !== 'syntaks' ? ' Against Tiltak, how the game ends doesn’t count toward your rating (a proof that your move wins still does).' : ''}${po.fallback && po.engine === 'syntaks' ? '<span class="po-line">Syntaks is unreachable; Tiltak, in your browser, defends now, so how this game ends doesn’t count toward your rating (a proof that your move wins still does).</span>' : ''}<span class="po-line po-status">Move ${n} of ${po.cap}${po.thinking ? ` · ${E} is thinking…` : ''}</span></p></div>
        <div class="actions"><button data-act="giveup"${performance.now() - po.t0 < 1500 ? ' disabled' : ''}>Give up</button><button data-act="solution" title="Give up and view the solution">Solution</button></div>`;
    }
  } else if (S.status === 'solved') {
    const title = solvedTitle();
    const slow = S.slowWin ? `${slowWinText(S.slowWin)}${S.slowWin.fastest ? `; the puzzle’s faster line starts with ${esc(S.slowWin.fastest)}` : ''}. ` : '';
    const note = slow + (S.notCounted ? NOT_COUNTED + ' ' : UNCHECKED ? UNCHECKED + ' ' : S.casualWhy === 'tiltak' ? 'Not rated: Tiltak defended. '
      : S.casual ? 'You used a hint, so this one didn’t count toward your rating. ' : '')
      + (shownOver() ? overNote(shownOver()) : S.casualWhy === 'hint' ? '' : `Play any move to explore${finePointer.matches ? ', or step through the line with ← and →' : ''}.`);
    fbHtml = `<div class="icon ${S.outcome === 'clean' ? 'good' : 'bad'}">${S.outcome === 'clean' ? '✓' : '✗'}</div><div class="body">
      <h2>${title}<span class="dslot"></span></h2><p>${note}</p></div>
      <div class="actions"><button class="primary" data-act="next">Next puzzle</button></div>`;
  } else if (S.status === 'retry' && S.refutation?.kind === 'playon') {
    const r = S.refutation, E = r.engine, mv = `${r.n} move${r.n === 1 ? '' : 's'}`;
    const h2 = r.how === 'gaveup' || r.how === 'left' ? 'You gave up' : r.how === 'out' ? 'Out of moves'
      : r.how === 'road' ? (r.byYou ? `Your move completed ${E}’s road` : `${E} made a road`) : `${E} held`;
    const lead = r.how === 'gaveup' || r.how === 'left' ? `You gave up on ${esc(r.miss)} after ${mv}` : `${E} defended ${esc(r.miss)} for ${mv}`;
    // (the server's own answer decides "counts": a repeat attempt or an out-of-date page is recorded unrated: missNote)
    const rated = !S.checkPending && !S.notCounted && !S.casualWhy && S.serverRated !== false;
    const rest = rated ? ', so it counts as a miss. Keep trying or view the solution.'
      : '. ' + (S.casualWhy === 'unchecked' && S.uncheckedWhy?.why ? `${playOnUnratedText(S.uncheckedWhy)} Keep trying or view the solution.` : missNote());
    fbHtml = `<div class="icon bad">✗</div><div class="body"><h2>${h2}<span class="dslot"></span></h2>
      <p>${hintNote}${lead}${rest}</p></div>${playActions}`;
  } else if (S.status === 'retry') {
    fbHtml = `<div class="icon bad">✗</div><div class="body"><h2>That’s not the move<span class="dslot"></span></h2>
      <p>${hintNote}${unsure(S.refutation?.miss) ? '' : (refText(S.refutation) || 'Try another move.') + ' '}${missNote()}</p></div>${playActions}`;
  } else if (S.status === 'viewing') {
    fbHtml = `<div class="icon bad">…</div><div class="body"><h2>Solution</h2><p>Watch the winning line.</p></div>`;
  } else {
    const good = mood === 'good';
    fbHtml = `<div class="icon ${good ? 'good' : 'turn p' + S.solver}">${good ? '✓' : ''}</div><div class="body">
      <h2>${good ? 'Best move!' : 'Your turn'}</h2>
      <p>${hintNote}${good ? 'Keep going.' : `You play ${colorName(S.solver)}`}</p></div>${playActions}`;
  }
  // Only touch the card when it changes (it's a live region), and keep keyboard focus on the equivalent
  // button when it does (Hint / View solution, then Continue once the puzzle is over).
  let focusNext = false; // focus Next puzzle once the move panel (and the dock's button) is drawn
  if (fb._html !== fbHtml) {
    const active = document.activeElement;
    const ended = !fb._html?.includes('data-act="next"') && fbHtml.includes('data-act="next"');
    if (fb.contains(active)) fbFocus = active.dataset.act || null;
    else if (active && active !== document.body) fbFocus = null;
    // Same buttons as before (e.g. the miss text updating with the refutation): replace only the text, so a press on
    // Hint or Solution that straddles the update still lands as a click.
    const acts = fb.querySelector(':scope > .actions');
    if (acts && fb._html?.endsWith(playActions) && fbHtml.endsWith(playActions) && acts.outerHTML === playActions) {
      for (const el of [...fb.children]) if (el !== acts) el.remove();
      acts.insertAdjacentHTML('beforebegin', fbHtml.slice(0, -playActions.length));
    } else fb.innerHTML = fbHtml;
    fb._html = fbHtml;
    if (fbFocus && (!document.activeElement || document.activeElement === document.body)) {
      const same = fb.querySelector(`[data-act="${fbFocus}"]:not(:disabled)`);
      if (same && same.offsetParent) same.focus(); else focusNext = true;
    }
    if (ended && active?.id === 'ptn-in') focusNext = true; // solved by a typed move
  }
  const dslot = fb.querySelector('.dslot');
  if (dslot && dslot._html !== delta) { dslot.innerHTML = delta; dslot._html = delta; }
  $('#ptn-in').disabled = !!(S.placeholder || board.opts.disableBoard);

  return focusNext;
}

// Session card: your rating (with the latest change beside it) and one chip per puzzle, Lichess-style.
function renderSession() {
  const mine = myRating(), shown = fmtRating(mine.rating, mine.provisional);
  const last = session.at(-1);
  $('#session').innerHTML = `<div><div class="label">Your rating</div><div class="rating-line"><span class="big">${shown}</span>${S.resultSent && last?.id === S.p.id && last.delta != null ? deltaSpan(last.delta) : ''}</div></div>
    <div class="streak">${session.map((x) => `<a class="${x.win ? 'w' : 'l'}${x.id === S.p.id ? ' cur' : ''}" href="#/puzzle/${esc(x.id)}" title="Puzzle #${esc(x.id)}">${x.delta != null ? signed(x.delta) : x.win ? '✓' : '✗'}</a>`).join('')}</div>`;

}

// The puzzle's info panel, shown once it is over.
function renderInfo(done) {
  const info = $('#info'), { p } = S;
  info.classList.toggle('hidden', !done);
  if (done) {
    const themes = (p.themes || []).filter((t) => THEMES[t] && THEMES[t].group !== 'Board');
    const m = p.meta || {};
    const player = (c, name, r) => `<div><span class="dot p${c}"></span>${esc(name)}${r ? ` <span class="sub">(${r})</span>` : ''}</div>`;
    const game = p.sourceRef?.startsWith('http') ? `<a href="${esc(p.sourceRef)}" target="_blank" rel="noopener">PlayTak game</a>` : esc(p.source);
    info.innerHTML = `<dl>
        <dt>Puzzle</dt><dd><a href="#/puzzle/${esc(p.id)}">#${esc(p.id)}</a>, ${p.size}×${p.size}${p.komi ? ` with komi ${p.komi}` : ''}${canShare() ? ' · <button class="link" id="share-link">Share</button>' : ''}</dd>
        <dt>Rating</dt><dd>${Math.round(p.rating)}</dd>
        <dt>Played</dt><dd>${p.attempts ? `${p.attempts} time${p.attempts === 1 ? '' : 's'}` : 'Not rated by anyone yet'}</dd>
        <dt>From</dt><dd>${game}</dd>
      </dl>
      ${p.turn === 1 ? `<div class="sub">Turning point: ${p.pre0 != null && p.pre0 < 0.4 ? 'you were behind' : 'the game was even'} until your opponent’s last move.</div>` : ''}
      ${m.white ? `<div class="players">${player(1, m.white, m.ratingWhite)}${player(2, m.black, m.ratingBlack)}</div>` : ''}
      <hr><div>${themes.map((t) => `<a class="tag" href="#/glossary/${t}" title="${esc(THEMES[t].desc)}">${THEMES[t].name}</a>`).join('') || '<span class="sub">No themes</span>'}</div>`;
    const sb = $('#share-link');
    if (sb) sb.onclick = () => sharePuzzle(p);
  }

}

// Move list, Lichess-style: a fixed-height scrolling table (number | White | Black). The game so far is
// dim, a divider marks where the puzzle starts, your misses sit struck-through in the cell of the move you
// were looking for, and your own line is an indented row at its branch point. Click any move to see it.
// On phones, after the puzzle, the result, engine and step buttons dock below it (docked).
function renderMoves(docked, delta, focusNext) {
  const { p } = S;
  const official = officialLine();
  const startPly = S.hist.length ? 0 : Game.fromTPS(p.tps).ply;
  const viewIdx = S.view ?? shownLine().length;
  const onShared = (i) => !S.onBranch || (S.branch && i + 1 <= S.branch.at); // official moves also on your line
  const po = S.playOn; // a play-on game shows after the puzzle's moves, in italics, instead of its move as a miss
  const missesAt = (k) => S.misses.filter((x) => x.at === k && !(po && x.at === po.at && x.ptn === po.miss)).map((x) => `<span class="miss" title="Not the move">${esc(x.ptn)}</span>`).join('');
  const cells = []; // one entry per ply slot: { ply, html }
  official.forEach((m, i) => {
    const k = i - S.hist.length;
    const mvObj = k >= 0 ? S.moves[k] : null;
    const cls = ['mv', k < 0 ? 'past' : mvObj?.po ? 'po' : mvObj?.shown ? 'me shown' : mvObj?.me ? 'me ok' : 'opp', onShared(i) && i + 1 === viewIdx ? 'cur' : ''].join(' ');
    cells.push({ ply: startPly + i, i, html: `${k >= 0 ? missesAt(k) : ''}<span class="${cls}" data-i="${i + 1}">${esc(m)}</span>` });
  });
  if (po) po.line.forEach((m, j) => cells.push({ ply: startPly + official.length + j, i: official.length + j,
    html: `${j ? '' : missesAt(S.moves.length)}<span class="mv po" title="Played out against ${defenderName(po)}">${esc(m)}</span>` }));
  else if (S.misses.some((x) => x.at === S.moves.length)) cells.push({ ply: startPly + official.length, i: official.length, html: missesAt(S.moves.length) });
  const branchRow = () => {
    const b0 = S.branch.at;
    const moves = S.branch.moves.map((m, j) => {
      const ply = startPly + b0 + j;
      const num = ply % 2 === 0 ? `${Math.floor(ply / 2) + 1}.` : j === 0 ? `${Math.floor(ply / 2) + 1}…` : '';
      return `${num ? `<span class="num">${num}</span>` : ''}<span class="mv ${S.onBranch && b0 + j + 1 === viewIdx ? 'cur' : ''}" data-b="${b0 + j + 1}">${esc(m)}</span>`;
    }).join(' ');
    return `<div class="mrow branch"><span class="branch-label">Your line</span> ${moves} <button class="link back" data-act2="back">Back to the solution</button></div>`;
  };
  let rows = '';
  for (let c = 0; c < cells.length; ) {
    const first = cells[c];
    if (!first) break;
    const moveNo = Math.floor(first.ply / 2) + 1;
    const white = first.ply % 2 === 0 ? first : null;
    const black = white ? (cells[c + 1] && cells[c + 1].ply === first.ply + 1 ? cells[c + 1] : null) : first;
    rows += `<span class="mnum">${moveNo}</span><span class="mcell">${white ? white.html : '<span class="dots">…</span>'}</span><span class="mcell">${black ? black.html : ''}</span>`;
    // Your line goes under the row it branches from, including from White's move (replacing Black's reply).
    if (S.branch && [white, black].some((x) => x && S.branch.at === x.i + 1)) rows += branchRow();
    c += white && black ? 2 : 1;
  }
  if (S.branch && S.branch.at === 0) rows = branchRow() + rows;
  const mv = $('#moves');
  const prevScroll = mv.querySelector('.mscroll')?.scrollTop ?? 0;
  const engineHtml = engineMarkup();
  const fa = mv.contains(document.activeElement) ? document.activeElement : null;
  const navFocus = fa?.dataset.step ? `[data-step="${fa.dataset.step}"]` : null;
  const hadNext = document.activeElement?.dataset?.act === 'next'; // the dock's or the card's: keep it across layout flips
  const pvWas = pvFocused();
  const clean = S.outcome === 'clean';
  // A server notice (slow or unreachable) replaces the result, so a Next puzzle that's waiting doesn't look dead.
  const dockHead = notice ? `<span class="icon bad" aria-hidden="true">!</span><b>${esc(notice.title)}</b>`
    : `<span class="icon ${clean ? 'good' : 'bad'}" aria-hidden="true">${clean ? '✓' : '✗'}</span><b>${solvedTitle()}${delta}</b>`;
  const dockNote = notice ? esc(notice.body) : S.notCounted ? notCountedText() : uncheckedText() ? uncheckedText() : S.slowWin ? `${slowWinText(S.slowWin)}.${S.casualWhy === 'tiltak' ? ' Not rated: Tiltak defended.' : ''}` : S.casual ? 'You used a hint, so this one didn’t count.' : shownOver() ? 'Game over here. Step back with ◀ to explore.' : '';
  const engSlot = `<div class="eng-slot">${engineHtml}</div>`;
  const scroller = `<div class="mscroll" role="group" aria-label="Moves"><div class="mtable">${rows}</div></div>`;
  const nav = `<div class="nav"><button data-step="first" title="Start" aria-label="Start">⏮</button><button data-step="prev" title="Back (←)" aria-label="Back">◀</button><button data-step="next" title="Forward (→)" aria-label="Forward">▶</button><button data-step="last" title="Current position" aria-label="Current position">⏭</button>${S.view != null ? '<span class="muted">viewing an earlier position</span>' : ''}</div>`;
  mv.innerHTML = docked ? scroller + `<div class="dock"><div class="dock-res">${dockHead}<button class="primary" data-act="next">Next puzzle</button>${dockNote ? `<p>${dockNote}</p>` : ''}</div>${engSlot}${nav}</div>`
    : engSlot + scroller + nav;
  fitDock();
  if (dockRO) { dockRO.disconnect(); const d = mv.querySelector('.dock'); if (d) dockRO.observe(d); }
  if (navFocus) mv.querySelector(navFocus)?.focus();
  if (focusNext || hadNext) nextBtn()?.focus();
  refocusPV(pvWas);
  // Keep the current move in view by scrolling the table itself (never the page).
  const sc = mv.querySelector('.mscroll');
  sc.scrollTop = prevScroll; // keep where the reader was, then make sure the current move is visible
  const cur = S.view === 0 ? null : sc.querySelector('.mv.cur') || [...sc.querySelectorAll('.mv, .miss')].at(-1);
  if (S.view === 0) sc.scrollTop = 0; // the starting position: show the top of the game
  else if (cur) {
    const top = cur.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const rowH = cur.offsetHeight + 8, h = sc.clientHeight;
    if (top < sc.scrollTop || top + rowH > sc.scrollTop + h) sc.scrollTop = Math.max(0, top - h / 2 + rowH / 2);
  }

}

$('#moves').addEventListener('click', (e) => {
  if (!S || S.placeholder) return;
  if (e.target.closest('[data-act2="back"]')) return backToSolution();
  const pvb = e.target.closest('[data-pv]');
  if (pvb) return playPV(+pvb.dataset.pv);
  const m = e.target.closest('[data-i]');
  if (m) return viewPly(+m.dataset.i, false);
  const b = e.target.closest('[data-b]');
  if (b) return viewPly(+b.dataset.b, true);
  const nx = e.target.closest('[data-act="next"]'); // the phone dock's Next puzzle
  if (nx) { if (justViewed()) return; const kb = nx.matches(':focus-visible'); return loadNext().then(() => { if (kb) $('#ptn-in')?.focus(); }); }
  const total = shownLine().length, cur = S.view ?? total;
  const n = e.target.closest('[data-step]')?.dataset.step;
  if (n) viewPly({ first: 0, prev: cur - 1, next: cur + 1, last: total }[n]);
});

// ---------- controls ----------
// buttons inside the feedback card
$('#feedback').addEventListener('click', async (e) => {
  if (!S || S.placeholder) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if ((act === 'hint' || act === 'solution') && fresh(S)) return; // a tap meant for the last puzzle's Next
  if (act === 'hint') return showHint();
  if (act === 'solution') return showSolution();
  if (act === 'giveup') { if (performance.now() - (S.playOn?.t0 ?? 0) < 1500) return; return endPlayOn(S, 'gaveup'); }
  if (act === 'next') {
    if (justViewed()) return;
    const kb = e.target.matches(':focus-visible'); // keyboard user: put them back in the move input
    await loadNext();
    if (kb) $('#ptn-in')?.focus();
  }
});
const themeDesc = () => { $('#theme-desc').textContent = prefs.theme && THEMES[prefs.theme] ? THEMES[prefs.theme].desc + ' Knowing the theme is a hint, so wins here barely raise your rating.' : 'A mix of everything. You don’t know what’s coming, just like in a real game.'; };
$('#difficulty').value = prefs.difficulty;
// A filter changed with the mouse lets go of focus, or number keys meant for the board would go to it (on Board size,
// 4–8 even pick a size). Changed from the keyboard, it keeps focus.
for (const id of ['#difficulty', '#size', '#theme']) $(id).addEventListener('change', (e) => { if (focusedByPointer(e.target)) e.target.blur(); });
$('#difficulty').onchange = (e) => { prefs.difficulty = e.target.value; store.set('prefs', prefs); loadNext(); };
$('#size').onchange = (e) => { prefs.size = e.target.value; store.set('prefs', prefs); renderFilters(); loadNext(); };
$('#theme').onchange = (e) => { prefs.theme = e.target.value; store.set('prefs', prefs); themeDesc(); loadNext(); };
// Stepping in half-moves, as in PTN Ninja: h = 2·plies shown, +1 while the next move's squares are only
// highlighted (Shift+arrow). Plain steps land on whole moves.
async function navTo(h) {
  if (!S || S.placeholder || board.holding) return;
  const total = shownLine().length;
  h = Math.max(0, Math.min(2 * total, h));
  await viewPly(h >> 1);
  if (h & 1 && (S.view ?? total) === h >> 1) board.peek();
}
const navAt = () => 2 * (S.view ?? shownLine().length) + (board.peeking ? 1 : 0);
const navStep = (dir, half) => { const h = navAt(); navTo(half ? h + dir : h + dir * (h & 1 ? 1 : 2)); };
// Captured first, so Enter = Continue wins over board.js's Enter (lift / drop all) when nothing is in hand.
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || !S) return;
  if (S.placeholder || $('#view-puzzle').classList.contains('hidden')) return;
  if (e.key === 'Enter') {
    // Enter = Continue, unless it's meant for whatever has focus (a button, a link, a field) or stones are in hand.
    if (S.status === 'solved' && !board.holding && !e.target.closest?.('a, button, input, select, textarea, [contenteditable]')) { e.preventDefault(); loadNext(); }
    return;
  }
  const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
  if (e.key === 'Home' || e.key === 'End' || (dir && e.ctrlKey)) { e.preventDefault(); navTo(e.key === 'Home' || dir < 0 ? 0 : Infinity); }
  else if (dir && !e.altKey && !e.metaKey) { e.preventDefault(); navStep(dir, e.shiftKey); }
  // (Escape, number keys and rotation are the board's: board.js.)
}, { capture: true });
// Scroll wheel over the board steps through moves (mouse and trackpad only; a phone's swipe still scrolls the page).
let wheelAcc = 0;
$('#board').addEventListener('wheel', (e) => {
  if (!finePointer.matches || !S || S.placeholder || board.holding || e.ctrlKey) return;
  e.preventDefault();
  const step = devicePixelRatio * 100, d = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1);
  if (Math.sign(d) !== Math.sign(wheelAcc)) wheelAcc = 0;
  wheelAcc += d;
  const times = Math.trunc(wheelAcc / step);
  if (!times) return;
  wheelAcc -= times * step;
  const h = navAt();
  navTo(e.shiftKey ? h + times : 2 * ((h + (times > 0 ? 0 : 1)) >> 1) + 2 * times);
}, { passive: false });
// Typed moves (keyboard / screen reader): played on the board exactly as if clicked.
$('#ptn-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('#ptn-in'), ptn = inp.value.trim();
  if (!ptn) return;
  const ok = board.play(ptn);
  inp.setAttribute('aria-invalid', ok ? 'false' : 'true');
  if (ok) inp.value = ''; else inp.select();
});
$('#ptn-in').addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));

async function renderFilters() {
  const t = await api('/api/themes' + (prefs.size ? '?size=' + prefs.size : ''));
  const sel = $('#size');
  sel.innerHTML = '<option value="">Any size</option>' + Object.keys(t.allSizes || t.sizes).sort().map((s) => `<option value="${s}">${s}×${s} (${(t.allSizes || t.sizes)[s]})</option>`).join('');
  sel.value = prefs.size || '';
  const groups = {};
  // the chosen theme stays listed even with no puzzles at this size ("Quiet move (0)"), so the select is never blank
  for (const [k, v] of Object.entries(THEMES)) if ((t.themes[k] || k === prefs.theme) && v.group !== 'Board') (groups[v.group] ||= []).push(k);
  $('#theme').innerHTML = `<option value="">Mix (everything)</option>` + Object.entries(groups).map(([g, ks]) =>
    `<optgroup label="${g}">${ks.map((k) => `<option value="${k}">${THEMES[k].name} (${t.themes[k] || 0})</option>`).join('')}</optgroup>`).join('');
  $('#theme').value = prefs.theme || '';
  themeDesc();
  return t;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-theme]');
  // Practice a theme: route() then loads a puzzle with it (the puzzle in progress stays only if it has the theme).
  if (a) { e.preventDefault(); prefs.theme = a.dataset.theme; store.set('prefs', prefs); go('#/'); }
});

// ---------- pages ----------
const TITLES = { 'view-glossary': 'Glossary', 'view-me': 'History', 'view-leaderboard': 'Leaderboard' };
function setTitle() {
  const page = ['view-glossary', 'view-me', 'view-leaderboard'].find((v) => !$('#' + v).classList.contains('hidden'));
  document.title = page ? `${TITLES[page]} — tinue` : S && !S.placeholder ? `Puzzle #${S.p.id} — tinue` : 'tinue — Tak puzzles';
}
function show(id) {
  for (const v of ['view-puzzle', 'view-glossary', 'view-me', 'view-leaderboard']) $('#' + v).classList.toggle('hidden', v !== id);
  setTitle();
  fitDock(); // the dock (and the room reserved for it) belongs to the puzzle page only
  syncClock(); // another page pauses the puzzle's solve-time clock
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('on', a.getAttribute('href') === (location.hash.replace(/^(#\/[a-z]*).*$/, '$1') || '#/').replace('#/puzzle', '#/'));
}

async function glossaryPage() {
  show('view-glossary');
  const t = await api('/api/themes' + (prefs.size ? '?size=' + prefs.size : '')); // counts for the Board you practice on
  const slug = (w) => w.toLowerCase().replace(/[^a-z]+/g, '-');
  const themeRows = Object.entries(THEMES).filter(([k, v]) => v.group !== 'Board').map(([k, v]) =>
    `<dt id="${k}">${v.name}</dt><dd>${esc(v.desc)}${t.themes[k] ? ` <a href="#/" class="practice" data-theme="${k}">Practice (${t.themes[k].toLocaleString()} puzzles)</a>` : ''}</dd>`).join('');
  $('#view-glossary').innerHTML = `<div class="glossary"><h1>Glossary</h1>
    <h2>Tak basics</h2><dl>${GLOSSARY.map(([w, d]) => `<dt id="${slug(w)}">${w}</dt><dd>${esc(d)}</dd>`).join('')}</dl>
    <h2>Puzzle themes</h2><p class="muted">Every puzzle is tagged automatically from its solution. You can drill one theme from the Theme menu on the puzzle page.</p>
    <dl>${themeRows}</dl></div>`;
  const anchor = location.hash.split('/')[2];
  if (anchor) document.getElementById(anchor)?.scrollIntoView({ block: 'center' });
}

async function mePage() {
  show('view-me');
  const el = $('#view-me');
  const claim = 'Claim a username at the top right to be on the leaderboard and to sign in on other devices.';
  if (!me) { el.innerHTML = `<h1>History</h1><div class="panel"><p class="flush">Your puzzles will show up here. ${claim}</p></div>`; return; }
  // (me fresh too: another tab may have played since this one loaded, and the chart ends at me.rating)
  const [{ history: h }, fresh] = await Promise.all([api('/api/history'), api(withBuild('/api/me')).catch(() => null)]);
  if (fresh?.user) { me = fresh.user; renderUser(); }
  const tok = me.name ? token : null; // a guest has no name to sign in as elsewhere: claiming one comes first
  // rating chart
  const rated = h.filter((r) => r.rated).reverse();
  const pts = rated.length ? [rated[0].user_rating, ...rated.map((r) => r.user_rating + r.user_delta)] : [me.rating];
  if (Math.abs(pts.at(-1) - me.rating) > 0.5) pts.push(me.rating); // ends at the rating shown above (a refund moves it)
  const W = 860, H = 160, lo = Math.min(...pts) - 20, hi = Math.max(...pts) + 20;
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${(i / Math.max(1, pts.length - 1)) * W},${H - ((v - lo) / (hi - lo)) * H}`).join('');
  el.innerHTML = `<h1>${me.name ? esc(me.name) : 'History'}</h1>${me.name ? '' : `<div class="panel"><p class="flush">You’re playing as a guest: this browser remembers you. ${claim}</p></div>`}<p class="muted">Rating <b class="your-rating">${fmtRating(me.rating, me.provisional)}</b></p>
    <p class="muted">${me.games} rated puzzle${me.games === 1 ? '' : 's'}, ${me.wins} solved first try.${tok ? ' Your login token (paste on another device):' : ''}</p>
    ${tok ? `<div class="token"><input id="token-out" readonly value="${esc(tok)}" aria-label="Login token"><button id="token-copy">Copy</button></div>` : ''}
    <div class="chart"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none"><path d="${path}" fill="none" stroke="#3692e7" stroke-width="2" vector-effect="non-scaling-stroke"/></svg></div>
    <table class="t"><tr><th>Puzzle</th><th>Result</th><th>Puzzle rating</th><th>Δ</th><th>When</th></tr>
    ${h.map((r) => `<tr><td><a href="#/puzzle/${esc(r.puzzle_id)}">#${esc(r.puzzle_id)}</a> <span class="muted">${r.size}×${r.size}, ${r.plies} ${r.plies === 1 ? 'ply' : 'plies'}</span></td>
      <td>${r.win ? '✓' : '✗'}</td><td>${Math.round(r.puzzle_rating)}</td>
      <td>${r.rated ? `<span class="delta ${r.user_delta >= 0 ? 'up' : 'down'}">${r.user_delta >= 0 ? '+' : ''}${Math.round(r.user_delta)}</span>` : '<span class="muted">casual</span>'}</td>
      <td class="muted">${new Date(r.ts).toLocaleString()}</td></tr>`).join('')}</table>`;
  const out = $('#token-out');
  if (out) {
    out.onfocus = () => out.select();
    $('#token-copy').onclick = async () => {
      out.select();
      try { await navigator.clipboard.writeText(tok); } catch { document.execCommand?.('copy'); }
      $('#token-copy').textContent = 'Copied';
    };
  }
}

async function leaderPage() {
  show('view-leaderboard');
  const { leaders } = await api('/api/leaderboard');
  $('#view-leaderboard').innerHTML = `<h1>Leaderboard</h1><p class="muted">A “?” means the rating is still provisional: it settles after about 15 rated puzzles.</p>` + (leaders.length
    ? `<table class="t"><tr><th>#</th><th>Player</th><th>Rating</th><th>Puzzles</th></tr>${leaders.map((l, i) =>
      `<tr><td>${i + 1}</td><td>${esc(l.name)}</td><td>${fmtRating(l.rating, l.provisional)}</td><td>${l.games}</td></tr>`).join('')}</table>`
    : `<div class="panel"><p class="flush">Nobody is on the leaderboard yet. Claim a username, solve a puzzle and you could be first.</p></div>`);
}

// Hash routes (#/, #/puzzle/ID, #/glossary[/term], #/me, #/leaderboard) so it works as static files.
function go(hash) {
  if (location.hash !== hash) location.hash = hash; // triggers route() via hashchange
  else route();
}

async function route() {
  // a hash wins (in-app links); else the path (<app>/puzzle/<id>, the address shown for a puzzle)
  const pathRoute = location.pathname.slice(APP.length);
  const [, page, arg] = (location.hash && location.hash !== '#' ? location.hash : '#/' + pathRoute).split('/');
  if (page === 'glossary' || page === 'me' || page === 'leaderboard') showHashURL('#/' + (location.hash || '#/' + pathRoute).split('/').slice(1).join('/'));
  if (page === 'glossary') return glossaryPage();
  if (page === 'me') return mePage();
  if (page === 'leaderboard') return leaderPage();
  show('view-puzzle');
  renderFilters().catch(() => {}); // the puzzle doesn't wait for the theme counts
  if (page === 'puzzle' && arg) { if (S?.p.id !== decodeURIComponent(arg)) loadById(decodeURIComponent(arg)); else showPuzzleURL(S.p.id); }
  else if (S && !S.placeholder && S.status !== 'solved' && matchesFilters(S.p)) showPuzzleURL(S.p.id); // back to the puzzle in progress
  else loadNext();
}
window.addEventListener('hashchange', route);

(async () => {
  const cached = store.get('me', null);
  nextQ.resume(); // the puzzle picked after the last result here, if still fresh: the first puzzle needs no request
  if (cached && token) { me = { ...cached, rating: store.get('myRating', PLAYER_START.rating), provisional: store.get('myProv', true), games: 0, wins: 0 }; }
  renderUser();
  themeDesc();
  renderAll(); // placeholder panels at their final size
  board.load(buildPTN({ size: +(prefs.size || 6) })); // the same board component, empty, until the puzzle arrives
  requestAnimationFrame(() => document.documentElement.classList.remove('booting')); // reveal once laid out
  const meP = api(withBuild('/api/me')).then((r) => { me = r.user; renderUser(); if (S) renderAll(); }).catch(() => {});
  // With a cached account the puzzle request goes out alongside /api/me (the server knows us by the token).
  const flushed = flushHeld(); // before the first puzzle, so the server knows that one was played
  if (flushed) await Promise.race([flushed, new Promise((r) => setTimeout(r, 3000))]);
  if (!token || me) route(); else { await meP; route(); }
})();
