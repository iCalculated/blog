import { Game } from './shared/tak.js?v=1794772574';
import { THEMES, GLOSSARY } from './shared/themes.js?v=1794772574';
import { provisional, PLAYER_START } from './shared/rating.js?v=1794772574';
import { Board, buildPTN } from './board.js?v=1794772574';
import * as engine from './engine.js?v=1794772574';
import * as tiltak from './tiltak.js?v=1794772574';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// The API can live elsewhere (static page on shydrie.xyz, API on crux): config.js sets TINUE_API.
// Auth is a bearer token from localStorage (cross-site cookies get blocked), plus a cookie for same-origin dev.
const API = (window.TINUE_API || '').replace(/\/$/, '');
const authHeaders = () => (token ? { authorization: 'Bearer ' + token } : {});

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
// timeout: one try with that budget (no retry), for callers with a fallback; signal: the caller may abort.
const api = async (path, body, { quiet = false, noWait = quiet, timeout, signal } = {}) => {
  // If the server can't be reached, say so instead of showing a blank page. (On Shy's tailnet, Chrome asks for
  // "local network access" before a public page may call crux's private address; that prompt also stalls here.)
  const slow = noWait ? null : setTimeout(() => { notice = WAIT_NOTICE; renderAll(); }, 4000);
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
        ? { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(body), credentials: 'include', signal: ctl.signal }
        : { headers: authHeaders(), credentials: 'include', signal: ctl.signal });
      return await r.json();
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  };
  try {
    let j;
    if (timeout) j = await once(timeout);
    else if (body) j = await once(20000);
    else try { j = await once(8000); } catch { outcome = 'retried'; j = await once(12000); }
    if (!quiet && (notice?.kind === 'wait' || notice?.kind === 'net')) { notice = null; renderAll(); }
    return j;
  } catch (e) {
    outcome = 'failed';
    if (quiet) throw e;
    notice = { kind: 'net', title: 'Can’t reach the puzzle server', body: 'Check your connection and reload. If it keeps happening, the server may be down.' };
    renderAll();
    throw e;
  } finally {
    clearTimeout(slow);
    const ms = performance.now() - t0;
    // Engine analysis is slow by design (a ~1.2 s search, maybe queued) and aborted on purpose; not a network signal.
    if ((ms > 2000 || outcome !== 'ok') && path !== '/api/slow' && !path.startsWith('/api/analyze')) reportSlow(path, ms, outcome);
  }
};
// Tell the server about requests that were slow from here, so its log shows what the network added.
const reportSlow = (path, ms, outcome) => {
  try {
    const data = JSON.stringify({ path: path.split('?')[0], ms, outcome, hidden: document.visibilityState === 'hidden' });
    if (!navigator.sendBeacon?.(API + '/api/slow', data)) fetch(API + '/api/slow', { method: 'POST', body: data, keepalive: true }).catch(() => {});
  } catch {}
};
const WAIT_NOTICE = { kind: 'wait', title: 'Waiting for the puzzle server…', body: 'The server may be down; try again in a bit.' };
let notice = null; // a message that replaces the turn card: {kind: 'wait' | 'net' | 'none', title, body}
const store = {
  get(k, d) { try { const v = localStorage.getItem('tinue.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tinue.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('tinue.' + k); } catch {} },
};

// The server rates everyone. me: the player it knows us as, an account (name) or a guest (name null: has played
// without claiming a name), with the token that identifies us (kept in memory too, in case storage is unavailable).
// A first-time visitor has neither until their first result (or claiming a name), whose answer brings the token.
let me = null, token = store.get('token', null);
const setToken = (t) => {
  token = t;
  if (t) { store.set('token', t); store.del('guest'); store.del('seen'); } else store.del('token');
};
// Until 2026-11-15 guests were rated in this browser. Until the first result here makes a guest a server user (whose
// rating the server replays from the results this browser sent then), that rating and the puzzles seen steer the
// next puzzle and show as "your rating".
const legacyGuest = token ? null : store.get('guest', null), legacySeen = token ? [] : store.get('seen', null) || [];
const guestSeed = () => ({ gid: guestId() ?? undefined });
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
const session = []; // {id, win, delta}
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
const board = NINJA ? new (await import('./ninja.js?v=1794772574')).NinjaBoard($('#board'), { onMove: (ptn) => userMove(ptn) })
  : new Board($('#board'), { onMove: (ptn) => userMove(ptn) });
board.ui({ disableBoard: true }); // no input until a puzzle is loaded
let S = null; // current puzzle state

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
    $('#logout-yes').onclick = async () => { await api('/api/logout', {}); setToken(null); me = null; session.length = 0; renderUser(); refreshPage(); };
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
      setToken(t); me = r.user; session.length = 0; renderUser(); refreshPage();
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
const nextQuery = () => {
  const q = new URLSearchParams({ difficulty: prefs.difficulty });
  if (prefs.size) q.set('size', prefs.size);
  if (prefs.theme) q.set('theme', prefs.theme);
  if (!token) { q.set('rating', Math.round(myRating().rating)); if (legacySeen.length) q.set('exclude', legacySeen.slice(-200).join(',')); }
  return q.toString();
};
// The next puzzle is fetched as soon as this one's result is in, so Continue doesn't wait on the network.
let prefetched = null; // { key, req }
const nextKey = () => (token ? 't:' + token.slice(0, 8) : 'g') + '|' + nextQuery();
function prefetchNext() {
  const key = nextKey();
  prefetched = { key, req: api('/api/next?' + nextQuery(), null, { quiet: true }).catch(() => null) };
}
async function loadNext() {
  const t = ++loadSeq;
  const pre = prefetched?.key === nextKey() ? prefetched.req : null;
  prefetched = null;
  // A prefetch still in flight gets 3 s (it is quiet: no waiting notice), then a normal request takes over.
  let r = pre && (await Promise.race([pre, new Promise((res) => setTimeout(() => res(null), 3000))]));
  if (!r?.puzzle || r.puzzle.id === S?.p.id) { // (a "no match" answer is re-asked too)
    if (pre && !r) { notice = WAIT_NOTICE; renderAll(); }
    try { r = await api('/api/next?' + nextQuery()); } catch { return; } // api() has shown the error
  }
  const { puzzle } = r;
  if (t !== loadSeq) return; // a newer request superseded this one
  if (!puzzle) { // nothing to play: clear the old puzzle rather than leave it playable under the new filters
    engine.interrupt(); tiltak.stop(); anaCtl?.abort();
    S = null;
    notice = { kind: 'none', title: 'No puzzles match', body: 'Try another theme, difficulty or board size.' };
    showHashURL('#/');
    await board.ui({ disableBoard: true, showRoads: false, dropOnStray: false });
    await board.load(buildPTN({ size: +(prefs.size || 6) }));
    renderAll(); setTitle(); return;
  }
  showPuzzleURL(puzzle.id);
  start(puzzle, prefs.theme);
}
// Does the puzzle fit the current Theme / Board filters?
const matchesFilters = (p) => (!prefs.theme || (p.themes || []).includes(prefs.theme)) && (!prefs.size || String(p.size) === String(prefs.size));

async function loadById(id) {
  const t = ++loadSeq;
  let puzzle; try { ({ puzzle } = await api('/api/puzzle/' + encodeURIComponent(id))); } catch { return; }
  if (t !== loadSeq) return;
  if (puzzle) { showPuzzleURL(puzzle.id); start(puzzle); } else loadNext();
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
  engine.interrupt(); tiltak.stop(); anaCtl?.abort(); // nothing from the previous puzzle should still be thinking
  const g = Game.fromTPS(p.tps, p.komi || 0);
  const hist = p.meta?.history || [];
  // theme: the Theme filter this puzzle was picked with (its result is damped as a themed attempt)
  const s = S = { p, g, node: p.tree, solver: g.toMove, hist, moves: [], snaps: [g.toTPS()], view: null, status: 'play', resultSent: false, hinted: false, delta: null, busy: true,
        misses: [], outcome: null, branch: null, onBranch: false, theme: theme && (p.themes || []).includes(theme) ? theme : '',
        t0: null, hiddenMs: 0, hiddenAt: null, log: [] };
  notice = null;
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
function startClock(s) { if (s.t0 == null) { s.t0 = performance.now(); s.hiddenAt = offScreen() ? s.t0 : null; } }
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
  // A proven win the puzzle's tree doesn't list is slower (the tree has every win at the minimal depth): not a miss.
  // Precomputed lists (alts at the root, altsAt in 5-ply lines) answer at once. Past the root of a deep (7+ ply)
  // puzzle nothing is precomputed, so the engine gets ~2.5 s to prove it (same search) before it counts as a miss.
  // (A 'win' node is a road-in-1: there the slower win is rightly wrong.)
  const s = S;
  if (!correct) {
    g.undo(u);
    S.busy = true;
    const plies = [...(S.hist.length ? officialLine() : S.moves.map((m) => m.ptn)), canon];
    if (!res && node && node !== 'win') {
      let wins = slowerWins().includes(canon);
      if (!wins && S.p.plies >= 7 && S.moves.length) {
        S.slower = null; S.checking = canon;
        renderAll();
        wins = await engine.stillWins({ ...enginePos(plies), attacker: S.solver });
        if (S !== s) return;
        S.checking = null;
      }
      if (wins) {
        logMove('slow', canon, tMove);
        S.slower = canon;
        renderAll();
        setTimeout(() => { if (S !== s) return; S.busy = false; restoreBoard().then(() => flushHint(s)); }, 700);
        return;
      }
    }
    S.slower = null;
    logMove('miss', canon, tMove); S.decidedMs ??= tMove;
    S.misses.push({ at: S.moves.length, ptn: canon });
    const remaining = pliesLeft();
    S.refutation = { miss: canon, kind: 'thinking' };
    engine.refute({ ...enginePos(plies), attacker: S.solver, remaining }).then((r) => {
      if (r && S === s && S.refutation?.miss === canon) { S.refutation = { miss: canon, ...r }; renderAll(); }
    });
    fail();
    setTimeout(() => { if (S !== s) return; S.busy = false; restoreBoard().then(() => flushHint(s)); }, 700);
    return;
  }
  S.slower = null;
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
    if (!reply || S !== s) return;
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

async function report(win) {
  if (S.resultSent) return;
  S.resultSent = true;
  S.casual = S.hinted; // a hint before the result makes the attempt unrated
  const s = S, p = S.p, timing = { ms: (s.decidedMs ?? elapsed(s)) ?? undefined, log: s.log.length ? s.log : undefined };
  try { // a failed upload (network, server restart) loses this result, not the session
    // noWait: a slow upload mustn't swap the card (and its Hint button) for the waiting notice; a failed one still says so
    const r = await api('/api/result', { puzzleId: p.id, win, ...(s.hinted ? { casual: true } : { theme: s.theme || undefined }), ...timing,
      ...(token ? {} : { guest: guestSeed() }) }, { noWait: true }); // the first result makes a first-time visitor a guest
    if (r.token) setToken(r.token);
    if (r.user) {
      s.delta = r.rated ? r.userDelta : null;
      // Like Lichess, the info panel keeps the rating the puzzle had when you played it (what you were up
      // against), not the one your result just moved it to.
      if (r.rated) p.attempts++;
      me = r.user; renderUser();
    }
  } catch { s.delta = null; }
  session.push({ id: p.id, win, delta: s.delta });
  renderAll();
  if (S === s) prefetchNext();
}

// Proven slower wins at the current attacker node: alts at the root, altsAt[path of moves so far] deeper in.
function slowerWins() {
  const key = S.moves.map((m) => m.ptn).join(' ');
  return (key ? S.p.altsAt?.[key] : S.p.alts) || [];
}

function fail() { S.status = 'retry'; report(false); renderAll(); }

async function solved() {
  S.status = 'solved';
  S.outcome = S.viewed ? 'viewed' : S.misses.length ? 'miss' : 'clean';
  if (!S.resultSent) report(true);
  await openExploration();
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
  if (!S || S.placeholder || S.status === 'solved' || S.status === 'viewing' || S.busy) return;
  const s = S;
  if (!S.resultSent) { S.decidedMs ??= elapsed(); logMove('view', null, S.decidedMs); report(false); }
  S.status = 'viewing';
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
    if (g.result()) { S.viewed = true; S.status = 'solved'; S.outcome = 'viewed'; S.view = null; await openExploration(); return; }
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

// A Hint pressed while the board is busy (loading, the opponent's reply, the reset after a wrong or slower move) would
// be lost: remember it and show it once the board is free.
function flushHint(s) { if (S === s && s.pendingHint) { s.pendingHint = false; showHint(); } }
function showHint() {
  if (S && S.busy && (S.status === 'retry' || S.status === 'play') && !S.placeholder) { S.pendingHint = true; return; }
  if (!S || S.placeholder || S.busy || S.status === 'solved' || S.status === 'viewing') return;
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
const shownOver = () => { const line = shownLine(); return gameAt(line.slice(0, S.view ?? line.length)).result(); };
const overNote = (r) => `Game over here: ${r.winner ? `${colorName(r.winner)} ${r.kind === 'road' ? 'made a road' : 'won on flats'}` : 'a draw'}. `
  + `Step back${finePointer.matches ? ' (←)' : ''} or click an earlier move to explore from there.`;
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
    // scale by the board host's own shape (flat bar + board + tray, or PTN Ninja's frame), measured at full width
    const maxW = Math.max(220, Math.floor(((root.clientHeight - h - top - 8) * w) / wrap.offsetHeight));
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

// The feedback card (a live region). Returns whether Next puzzle should take keyboard focus once it is drawn.
function renderFeedback(mood, delta) {
  const fb = $('#feedback');
  const dis = S.placeholder ? ' disabled tabindex="-1"' : '';
  const playActions = `<div class="actions"><button data-act="hint"${dis}>Hint</button><button data-act="solution"${dis} title="View the solution">Solution</button></div>`;
  const other = colorName(3 - S.solver);
  const refText = (r) => !r ? '' : r.kind === 'thinking' ? `Checking why ${esc(r.miss)} fails…`
    : r.kind === 'gives-road' ? `After ${esc(r.miss)}, ${other} makes a road with <b>${esc(r.reply)}</b>.`
    : r.kind === 'refuted' ? `After ${esc(r.miss)}, ${other} answers <b>${esc(r.reply)}</b> and ${r.exact ? 'the forced win is gone' : 'the solver finds no forced win'}.`
    : `${esc(r.miss)} doesn’t force the win.`;
  const hintNote = S.hint?.note && S.hint.node === S.node && S.hint.at === S.moves.length ? `<b>Hint:</b> ${esc(S.hint.note)} ` : '';
  let fbHtml;
  if (notice) {
    $('#feedback').classList.remove('is-loading');
    fbHtml = `<div class="icon bad">!</div><div class="body"><h2>${esc(notice.title)}</h2><p>${esc(notice.body)}</p></div>`;
  } else if (S.checking) {
    fbHtml = `<div class="icon turn p${S.solver}">…</div><div class="body"><h2>Checking ${esc(S.checking)}</h2>
      <p>That isn’t the puzzle’s line; checking whether it still forces a win.</p></div>${playActions}`;
  } else if (S.status === 'solved') {
    const title = solvedTitle();
    const note = (S.casual ? 'You used a hint, so this one didn’t count toward your rating. ' : '')
      + (shownOver() ? overNote(shownOver()) : S.casual ? '' : `Play any move to explore${finePointer.matches ? ', or step through the line with ← and →' : ''}.`);
    fbHtml = `<div class="icon ${S.outcome === 'clean' ? 'good' : 'bad'}">${S.outcome === 'clean' ? '✓' : '✗'}</div><div class="body">
      <h2>${title}<span class="dslot"></span></h2><p>${note}</p></div>
      <div class="actions"><button class="primary" data-act="next">Next puzzle</button></div>`;
  } else if (S.status === 'retry' && S.slower) {
    fbHtml = `<div class="icon bad">✗</div><div class="body"><h2>That wins too, but slower<span class="dslot"></span></h2>
      <p>${hintNote}${esc(S.slower)} also forces a win, but there’s a faster one. This puzzle already counts as a miss; keep trying or view the solution.</p></div>${playActions}`;
  } else if (S.status === 'retry') {
    fbHtml = `<div class="icon bad">✗</div><div class="body"><h2>That’s not the move<span class="dslot"></span></h2>
      <p>${hintNote}${refText(S.refutation) || 'Try another move.'} This puzzle now counts as a miss; keep trying or view the solution.</p></div>${playActions}`;
  } else if (S.status === 'viewing') {
    fbHtml = `<div class="icon bad">…</div><div class="body"><h2>Solution</h2><p>Watch the winning line.</p></div>`;
  } else {
    const good = mood === 'good';
    if (S.slower) fbHtml = `<div class="icon turn p${S.solver}"></div><div class="body"><h2>That wins too, but slower</h2>
      <p>${hintNote}${esc(S.slower)} also forces a win, but there’s a faster one. Find it; this doesn’t count as a miss.</p></div>${playActions}`;
    else fbHtml = `<div class="icon ${good ? 'good' : 'turn p' + S.solver}">${good ? '✓' : ''}</div><div class="body">
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
  const missesAt = (k) => S.misses.filter((x) => x.at === k).map((x) => `<span class="miss" title="Not the move">${esc(x.ptn)}</span>`).join('');
  const cells = []; // one entry per ply slot: { ply, html }
  official.forEach((m, i) => {
    const k = i - S.hist.length;
    const mvObj = k >= 0 ? S.moves[k] : null;
    const cls = ['mv', k < 0 ? 'past' : mvObj?.shown ? 'me shown' : mvObj?.me ? 'me ok' : 'opp', onShared(i) && i + 1 === viewIdx ? 'cur' : ''].join(' ');
    cells.push({ ply: startPly + i, i, html: `${k >= 0 ? missesAt(k) : ''}<span class="${cls}" data-i="${i + 1}">${esc(m)}</span>` });
  });
  if (S.misses.some((x) => x.at === S.moves.length)) cells.push({ ply: startPly + official.length, i: official.length, html: missesAt(S.moves.length) });
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
  const dockNote = notice ? esc(notice.body) : S.casual ? 'You used a hint, so this one didn’t count.' : shownOver() ? 'Game over here. Step back with ◀ to explore.' : '';
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
  if (nx) { const kb = nx.matches(':focus-visible'); return loadNext().then(() => { if (kb) $('#ptn-in')?.focus(); }); }
  const total = shownLine().length, cur = S.view ?? total;
  const n = e.target.closest('[data-step]')?.dataset.step;
  if (n) viewPly({ first: 0, prev: cur - 1, next: cur + 1, last: total }[n]);
});

// ---------- controls ----------
// buttons inside the feedback card
$('#feedback').addEventListener('click', async (e) => {
  if (!S || S.placeholder) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'hint') return showHint();
  if (act === 'solution') return showSolution();
  if (act === 'next') {
    const kb = e.target.matches(':focus-visible'); // keyboard user: put them back in the move input
    await loadNext();
    if (kb) $('#ptn-in')?.focus();
  }
});
const themeDesc = () => { $('#theme-desc').textContent = prefs.theme && THEMES[prefs.theme] ? THEMES[prefs.theme].desc + ' Knowing the theme is a hint, so wins here barely raise your rating.' : 'A mix of everything. You don’t know what’s coming, just like in a real game.'; };
$('#difficulty').value = prefs.difficulty;
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
  const { history: h } = await api('/api/history');
  const tok = me.name ? token : null; // a guest has no name to sign in as elsewhere: claiming one comes first
  // rating chart
  const rated = h.filter((r) => r.rated).reverse();
  const pts = rated.length ? [rated[0].user_rating, ...rated.map((r) => r.user_rating + r.user_delta)] : [me.rating];
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
  $('#view-leaderboard').innerHTML = `<h1>Leaderboard</h1><p class="muted">Players whose rating has settled (no “?”).</p>` + (leaders.length
    ? `<table class="t"><tr><th>#</th><th>Player</th><th>Rating</th><th>Puzzles</th></tr>${leaders.map((l, i) =>
      `<tr><td>${i + 1}</td><td>${esc(l.name)}</td><td>${Math.round(l.rating)}</td><td>${l.games}</td></tr>`).join('')}</table>`
    : `<div class="panel"><p class="flush">Nobody has a settled rating yet. It takes about 15 rated puzzles. Claim a username and you could be first.</p></div>`);
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
  if (cached && token) { me = { ...cached, rating: store.get('myRating', PLAYER_START.rating), provisional: store.get('myProv', true), games: 0, wins: 0 }; }
  renderUser();
  themeDesc();
  renderAll(); // placeholder panels at their final size
  board.load(buildPTN({ size: +(prefs.size || 6) })); // the same board component, empty, until the puzzle arrives
  requestAnimationFrame(() => document.documentElement.classList.remove('booting')); // reveal once laid out
  const meP = api('/api/me').then((r) => { me = r.user; renderUser(); if (S) renderAll(); }).catch(() => {});
  // With a cached account the puzzle request goes out alongside /api/me (the server knows us by the token).
  if (!token || me) route(); else { await meP; route(); }
})();
