import { Game } from './shared/tak.js?v=1794323953';
import { THEMES, GLOSSARY } from './shared/themes.js?v=1794323953';
import { rate, themeWeight, provisional, rdFromCount, PLAYER_START } from './shared/rating.js?v=1794323953';
import { Board, buildPTN } from './board.js?v=1794323953';
import * as engine from './engine.js?v=1794323953';
import * as tiltak from './tiltak.js?v=1794323953';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// The API can live elsewhere (static page on shydrie.xyz, API on crux): config.js sets TINUE_API.
// Auth is a bearer token from localStorage (cross-site cookies get blocked), plus a cookie for same-origin dev.
const API = (window.TINUE_API || '').replace(/\/$/, '');
const authHeaders = () => { const t = store.get('token', null); return t ? { authorization: 'Bearer ' + t } : {}; };
const api = async (path, body, { quiet = false } = {}) => {
  // If the server can't be reached, say so instead of showing a blank page. (On Shy's tailnet, Chrome asks for
  // "local network access" before a public page may call crux's private address; that prompt also stalls here.)
  const slow = quiet ? null : setTimeout(() => { notice = WAIT_NOTICE; renderAll(); }, 4000);
  const t0 = performance.now();
  let outcome = 'ok';
  // A request stuck on a dead connection (e.g. the tailnet path to crux re-forming after sleep) is abandoned
  // after a while: reads are retried once, results (POSTs) just get longer before giving up.
  const once = async (ms) => {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(API + path, body
        ? { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(body), credentials: 'include', signal: ctl.signal }
        : { headers: authHeaders(), credentials: 'include', signal: ctl.signal });
      return await r.json();
    } finally { clearTimeout(timer); }
  };
  try {
    let j;
    if (body) j = await once(20000);
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
    if ((ms > 2000 || outcome !== 'ok') && path !== '/api/slow') reportSlow(path, ms, outcome);
  }
};
// Tell the server about requests that were slow from here, so its log shows what the network added.
const reportSlow = (path, ms, outcome) => {
  try {
    const data = JSON.stringify({ path: path.split('?')[0], ms, outcome, hidden: document.visibilityState === 'hidden' });
    if (!navigator.sendBeacon?.(API + '/api/slow', data)) fetch(API + '/api/slow', { method: 'POST', body: data, keepalive: true }).catch(() => {});
  } catch {}
};
const WAIT_NOTICE = { kind: 'wait', title: 'Waiting for the puzzle server…', body: 'If your browser asks to allow access to devices on your local network, allow it. Otherwise the server may be down; try again in a bit.' };
let notice = null; // a message that replaces the turn card: {kind: 'wait' | 'net' | 'none', title, body}
const store = {
  get(k, d) { try { const v = localStorage.getItem('tinue.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tinue.' + k, JSON.stringify(v)); } catch {} },
};

let me = null; // server user
const guest = store.get('guest', { rating: 1500, games: 0 });
guest.rd ??= rdFromCount(guest.games, PLAYER_START.rd); guest.vol ??= PLAYER_START.vol; // guests from before Glicko
// "1650?" while a rating is still provisional (high deviation), as on Lichess.
const fmtRating = (r, prov) => `${Math.round(r)}${prov ? '<span class="prov" title="Provisional: it settles after about 15 rated puzzles">?</span>' : ''}`;
const prefs = store.get('prefs', {});
if (!prefs.v2) { prefs.size = '5'; prefs.v2 = true; } // 5×5 by default
prefs.difficulty ||= 'normal';
store.set('prefs', prefs);
const session = []; // {id, win, delta}
const seenGuest = new Set(store.get('seen', []));
// A random id for this browser's anonymous guest results (null if storage or crypto is unavailable).
const guestId = () => {
  let id = store.get('gid', null);
  if (typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) return id;
  try { id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''); } catch { return null; }
  store.set('gid', id);
  return store.get('gid', null) === id ? id : null;
};

const board = new Board($('#board'), { onMove: (ptn) => userMove(ptn) });
board.ui({ disableBoard: true }); // no input until a puzzle is loaded
let S = null; // current puzzle state

// ---------- user box ----------
function renderUser() {
  const box = $('#userbox');
  store.set('me', me ? { name: me.name } : null);
  if (me) {
    // Name with a small menu on hover/focus: History, Log out (with an inline confirm).
    box.innerHTML = `<div class="menu"><button class="link name" aria-haspopup="true">${esc(me.name)}</button>
      <div class="pop" role="menu"><a href="#/me" role="menuitem">History</a><button class="link" id="logout" role="menuitem">Log out</button>
        <div class="confirm hidden" id="logout-confirm"><p>You’ll need your login token (on your History page) to sign back in on this device.</p><button class="danger" id="logout-yes">Log out</button></div></div></div>`;
    $('#logout').onclick = () => { $('#logout-confirm').classList.remove('hidden'); $('#logout').classList.add('hidden'); };
    $('#logout-yes').onclick = async () => { await api('/api/logout', {}); store.set('token', null); me = null; session.length = 0; renderUser(); refreshPage(); };
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
      const r = await api('/api/register', { name: $('#claim-name').value.trim() });
      if (r.error) return showErr('#claim-err', r.error);
      me = r.user; store.set('token', r.token); session.length = 0; renderUser(); refreshPage();
    };
    $('#tok').onsubmit = async (e) => {
      e.preventDefault();
      const token = $('#tok-in').value.trim();
      const r = await api('/api/login', { token });
      if (r.error) return showErr('#tok-err', 'That token doesn’t match an account.');
      me = r.user; store.set('token', token); session.length = 0; renderUser(); refreshPage();
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
  if (!me) { q.set('rating', Math.round(guest.rating)); q.set('exclude', [...seenGuest].slice(-200).join(',')); }
  return q.toString();
};
// The next puzzle is fetched as soon as this one's result is in, so Continue doesn't wait on the network.
let prefetched = null; // { key, req }
const nextKey = () => (me ? 'u:' + me.name : 'g') + '|' + nextQuery();
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
    engine.interrupt(); tiltak.stop();
    S = null;
    notice = { kind: 'none', title: 'No puzzles match', body: 'Try another theme, difficulty or board size.' };
    history.replaceState(null, '', '#/');
    await board.ui({ disableBoard: true, showRoads: false });
    await board.load(buildPTN({ size: +(prefs.size || 5) }));
    renderAll(); setTitle(); return;
  }
  history.replaceState(null, '', '#/puzzle/' + puzzle.id);
  start(puzzle, prefs.theme);
}
// Does the puzzle fit the current Theme / Board filters?
const matchesFilters = (p) => (!prefs.theme || (p.themes || []).includes(prefs.theme)) && (!prefs.size || String(p.size) === String(prefs.size));

async function loadById(id) {
  const t = ++loadSeq;
  let puzzle; try { ({ puzzle } = await api('/api/puzzle/' + encodeURIComponent(id))); } catch { return; }
  if (t !== loadSeq) return;
  if (puzzle) start(puzzle); else loadNext();
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
async function runEngine() {
  if (!S || S.status !== 'solved') return;
  const line = shownLine();
  const at = S.view ?? line.length;
  const key = line.slice(0, at).join(' ');
  if (S.evalKey === key) return;
  const s = S;
  S.evalKey = key; S.eval = null; S.tk = null;
  // Tiltak (4×4–6×6) gives the evaluation and line, streamed as it searches. On boards it can't play,
  // fall back to our own forced-win solver.
  const g = gameAt(line.slice(0, at));
  const res0 = g.result();
  if (res0) { tiltak.stop(); S.eval = { kind: 'over', winner: res0.winner, how: res0.kind }; renderAll(); return; }
  if (tiltak.supports(S.p.size, S.p.komi || 0)) {
    S.tk = { thinking: true }; renderAll();
    let lastPaint = 0;
    const live = () => S === s && S.evalKey === key;
    // If Tiltak can't load or crashes, use the solver instead of thinking forever.
    const fallback = () => { if (live() && (!S.tk || S.tk.thinking)) { S.tk = null; runSolver(s, key, line.slice(0, at)); } };
    tiltak.analyze({ tps: g.toTPS(), size: S.p.size, komi: S.p.komi || 0, ms: 2500, onInfo: (r) => {
      if (!live()) return;
      S.tk = r; const now = performance.now(); if (now - lastPaint > 250) { lastPaint = now; renderEngine(); }
    } }).then((r) => { if (!live()) return; if (r) { S.tk = r; renderEngine(); } else fallback(); }, fallback);
    return;
  }
  tiltak.stop();
  runSolver(s, key, line.slice(0, at));
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
  engine.interrupt(); tiltak.stop(); // nothing from the previous puzzle should still be thinking
  const g = Game.fromTPS(p.tps, p.komi || 0);
  const hist = p.meta?.history || [];
  // theme: the Theme filter this puzzle was picked with (its result is damped as a themed attempt)
  const s = S = { p, g, node: p.tree, solver: g.toMove, hist, moves: [], snaps: [g.toTPS()], view: null, status: 'play', resultSent: false, hinted: false, delta: null, busy: true,
        misses: [], outcome: null, branch: null, onBranch: false, theme: theme && (p.themes || []).includes(theme) ? theme : '',
        t0: null, hiddenMs: 0, hiddenAt: null, log: [] };
  notice = null;
  setTitle();
  renderAll(); // side panel right away
  await board.ui({ disableBoard: true, showRoads: false });
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
  if (me) {
    try { // a failed upload (network, server restart) loses this result, not the session
      if (S.hinted) { await api('/api/result', { puzzleId: p.id, win, casual: true, ...timing }); s.delta = null; }
      else {
        const r = await api('/api/result', { puzzleId: p.id, win, theme: s.theme || undefined, ...timing });
        if (r.user) {
          s.delta = r.rated ? r.userDelta : null;
          // Like Lichess, the info panel keeps the rating the puzzle had when you played it (what you were up
          // against), not the one your result just moved it to.
          if (r.rated) p.attempts++;
          me = r.user; renderUser();
        }
      }
    } catch { s.delta = null; }
  } else {
    // Guests are rated locally only. Their first try at a puzzle is also sent anonymously (random browser id, the
    // rating before this attempt, timing) to calibrate puzzle difficulty; the server records it and rates nothing.
    if (!seenGuest.has(p.id)) {
      const gid = guestId();
      if (gid) api('/api/guest-result', { gid, puzzleId: p.id, win, hinted: !!S.hinted, rating: guest.rating, rd: guest.rd, games: guest.games, ...timing }, { quiet: true }).catch(() => {});
    }
    if (!S.hinted && !seenGuest.has(p.id)) {
      const r = rate(guest, p, win, themeWeight(s.theme, THEMES, win));
      Object.assign(guest, r.user); guest.games++; S.delta = r.userDelta;
      store.set('guest', guest);
    }
    seenGuest.add(p.id); store.set('seen', [...seenGuest].slice(-500));
    renderUser();
  }
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
  await board.ui({ disableBoard: false }); // roads are drawn only where one is complete (board.js does that by itself)
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
  S.branch = null; S.onBranch = false; S.view = null; S.loadedKey = null;
  await showLine(officialLine(), officialLine().length);
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
  const g = S.g;
  const mv = S.node === 'win' ? finisher(g) : Object.keys(S.node)[0];
  if (!mv) return;
  if (!S.hinted) logMove('hint');
  S.hinted = true;
  board.highlight([g.sqName(g.parseMove(mv).sq)]);
  renderAll();
}

// Browse any earlier position (game history or puzzle moves). Index = number of plies shown.
async function viewPly(i, branch = S.onBranch) {
  if (!S || S.placeholder) return;
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
        const fav = Math.abs(pw - 0.5) < 0.05 ? 'Even' : `${pw > 0.5 ? 'White' : 'Black'} ${Math.round(Math.max(pw, 1 - pw) * 100)}%`;
        lead = `<span class="bar" title="White’s chances"><i style="width:${(pw * 100).toFixed(1)}%"></i></span><b>${fav}</b>`;
        pv = pvHtml(S.tk.pv);
      }
      tag = '<a class="src" href="https://github.com/MortenLohne/tiltak" target="_blank" rel="noopener" title="Evaluation by Tiltak, running in your browser">Tiltak</a>';
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
    const maxW = Math.max(220, Math.floor((root.clientHeight - h - top - 8) / (1 + 1 / S.p.size))); // tray is 1/n of the board
    if (maxW < w) wrap.style.maxWidth = maxW + 'px';
  }
};
const dockRO = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitDock()) : null;
addEventListener('resize', () => fitDock());
const nextBtn = () => $('#moves .dock [data-act="next"]') || $('#feedback [data-act="next"]');
function renderAll(mood) {
  if (!S) S = PLACEHOLDER;
  const loading = !!S.placeholder;
  for (const id of ['#feedback', '#moves']) $(id).classList.toggle('is-loading', loading);
  const { p } = S;
  const fb = $('#feedback');
  const myRating = fmtRating(me ? me.rating : guest.rating, me ? me.provisional : provisional(guest));
  if (me) { store.set('myRating', me.rating); store.set('myProv', !!me.provisional); }
  const delta = S.delta != null ? `<span class="delta ${S.delta >= 0 ? 'up' : 'down'}">${S.delta >= 0 ? '+' : '−'}${Math.abs(Math.round(S.delta))}</span>` : '';
  const dis = S.placeholder ? ' disabled tabindex="-1"' : '';
  const playActions = `<div class="actions"><button data-act="hint"${dis}>Hint</button><button data-act="solution"${dis} title="View the solution">Solution</button></div>`;
  const other = colorName(3 - S.solver);
  const refText = (r) => !r ? '' : r.kind === 'thinking' ? `Checking why ${esc(r.miss)} fails…`
    : r.kind === 'gives-road' ? `After ${esc(r.miss)}, ${other} makes a road with <b>${esc(r.reply)}</b>.`
    : r.kind === 'refuted' ? `After ${esc(r.miss)}, ${other} answers <b>${esc(r.reply)}</b> and ${r.exact ? 'the forced win is gone' : 'the solver finds no forced win'}.`
    : `${esc(r.miss)} doesn’t force the win.`;
  let fbHtml;
  if (notice) {
    $('#feedback').classList.remove('is-loading');
    fbHtml = `<div class="icon bad">!</div><div class="body"><h2>${esc(notice.title)}</h2><p>${esc(notice.body)}</p></div>`;
  } else if (S.checking) {
    fbHtml = `<div class="icon turn p${S.solver}">…</div><div class="body"><h2>Checking ${esc(S.checking)}</h2>
      <p>That isn’t the puzzle’s line; checking whether it still forces a win.</p></div>${playActions}`;
  } else if (S.status === 'solved') {
    const title = solvedTitle();
    const note = S.casual ? 'You used a hint, so this one didn’t count toward your rating.'
      : `Play any move to explore${finePointer.matches ? ', or step through the line with ← and →' : ''}.`;
    fbHtml = `<div class="icon ${S.outcome === 'clean' ? 'good' : 'bad'}">${S.outcome === 'clean' ? '✓' : '✗'}</div><div class="body">
      <h2>${title}<span class="dslot"></span></h2><p>${note}</p></div>
      <div class="actions"><button class="primary" data-act="next">Next puzzle</button></div>`;
  } else if (S.status === 'retry' && S.slower) {
    fbHtml = `<div class="icon bad">✗</div><div class="body"><h2>That wins too, but slower</h2>
      <p>${esc(S.slower)} also forces a win, but there’s a faster one. This puzzle already counts as a miss; keep trying or view the solution.</p></div>${playActions}`;
  } else if (S.status === 'retry') {
    fbHtml = `<div class="icon bad">✗</div><div class="body"><h2>That’s not the move</h2>
      <p>${refText(S.refutation) || 'Try another move.'} This puzzle now counts as a miss; keep trying or view the solution.</p></div>${playActions}`;
  } else if (S.status === 'viewing') {
    fbHtml = `<div class="icon bad">…</div><div class="body"><h2>Solution</h2><p>Watch the winning line.</p></div>`;
  } else {
    const good = mood === 'good';
    if (S.slower) fbHtml = `<div class="icon turn p${S.solver}"></div><div class="body"><h2>That wins too, but slower</h2>
      <p>${esc(S.slower)} also forces a win, but there’s a faster one. Find it; this doesn’t count as a miss.</p></div>${playActions}`;
    else fbHtml = `<div class="icon ${good ? 'good' : 'turn p' + S.solver}">${good ? '✓' : ''}</div><div class="body">
      <h2>${good ? 'Best move!' : 'Your turn'}</h2>
      <p>${good ? 'Keep going.' : `You play ${colorName(S.solver)}`}</p></div>${playActions}`;
  }
  // Only touch the card when it changes (it's a live region), and keep keyboard focus on the equivalent
  // button when it does (Hint / View solution, then Continue once the puzzle is over).
  let focusNext = false; // focus Next puzzle once the move panel (and the dock's button) is drawn
  if (fb._html !== fbHtml) {
    const active = document.activeElement;
    const ended = !fb._html?.includes('data-act="next"') && fbHtml.includes('data-act="next"');
    if (fb.contains(active)) fbFocus = active.dataset.act || null;
    else if (active && active !== document.body) fbFocus = null;
    fb.innerHTML = fbHtml; fb._html = fbHtml;
    if (fbFocus && (!document.activeElement || document.activeElement === document.body)) {
      const same = fb.querySelector(`[data-act="${fbFocus}"]:not(:disabled)`);
      if (same && same.offsetParent) same.focus(); else focusNext = true;
    }
    if (ended && active?.id === 'ptn-in') focusNext = true; // solved by a typed move
  }
  const dslot = fb.querySelector('.dslot');
  if (dslot && dslot._html !== delta) { dslot.innerHTML = delta; dslot._html = delta; }
  $('#ptn-in').disabled = !!(S.placeholder || board.opts.disableBoard);

  // Session card: your rating (with the latest change beside it) and one chip per puzzle, Lichess-style.
  const last = session.at(-1);
  const sign = (d) => (d >= 0 ? '+' : '−') + Math.abs(Math.round(d));
  $('#session').innerHTML = `<div><div class="label">Your rating</div><div class="rating-line"><span class="big">${myRating}</span>${S.status === 'solved' && last?.id === p.id && last.delta != null ? `<span class="delta ${last.delta >= 0 ? 'up' : 'down'}">${sign(last.delta)}</span>` : ''}</div></div>
    <div class="streak">${session.map((x) => `<a class="${x.win ? 'w' : 'l'}${x.id === p.id ? ' cur' : ''}" href="#/puzzle/${esc(x.id)}" title="Puzzle #${esc(x.id)}">${x.delta != null ? sign(x.delta) : x.win ? '✓' : '✗'}</a>`).join('')}</div>`;

  // Everything about the puzzle itself comes at the end.
  const done = S.status === 'solved';
  const docked = done && DOCK_MQ.matches;
  const vp = $('#view-puzzle');
  vp.classList.toggle('analysis', done); // phones: step buttons only for the review...
  vp.classList.toggle('peek', !done && S.view != null); // ...or to get back after tapping an earlier move
  vp.classList.toggle('docked', docked);
  const info = $('#info');
  info.classList.toggle('hidden', !done);
  if (done) {
    const themes = (p.themes || []).filter((t) => THEMES[t] && THEMES[t].group !== 'Board');
    const m = p.meta || {};
    const player = (c, name, r) => `<div><span class="dot p${c}"></span>${esc(name)}${r ? ` <span class="sub">(${r})</span>` : ''}</div>`;
    const game = p.sourceRef?.startsWith('http') ? `<a href="${esc(p.sourceRef)}" target="_blank" rel="noopener">PlayTak game</a>` : esc(p.source);
    info.innerHTML = `<dl>
        <dt>Puzzle</dt><dd><a href="#/puzzle/${esc(p.id)}">#${esc(p.id)}</a>, ${p.size}×${p.size}${p.komi ? ` with komi ${p.komi}` : ''}</dd>
        <dt>Rating</dt><dd>${Math.round(p.rating)}</dd>
        <dt>Played</dt><dd>${p.attempts ? `${p.attempts} time${p.attempts === 1 ? '' : 's'}` : 'Not rated by anyone yet'}</dd>
        <dt>From</dt><dd>${game}</dd>
      </dl>
      ${p.turn === 1 ? `<div class="sub">Turning point: ${p.pre0 != null && p.pre0 < 0.4 ? 'you were behind' : 'the game was even'} until your opponent’s last move.</div>` : ''}
      ${m.white ? `<div class="players">${player(1, m.white, m.ratingWhite)}${player(2, m.black, m.ratingBlack)}</div>` : ''}
      <hr><div>${themes.map((t) => `<a class="tag" href="#/glossary/${t}" title="${esc(THEMES[t].desc)}">${THEMES[t].name}</a>`).join('') || '<span class="sub">No themes</span>'}</div>`;
  }

  // Move list, Lichess-style: a fixed-height scrolling table (number | White | Black). The game so far is
  // dim, a divider marks where the puzzle starts, your misses sit struck-through in the cell of the move you
  // were looking for, and your own line is an indented row at its branch point. Click any move to see it.
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
  const puzzleFrom = S.hist.length; // index of the first puzzle ply
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
  const dockNote = notice ? esc(notice.body) : S.casual ? 'You used a hint, so this one didn’t count.' : '';
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
const themeDesc = () => { $('#theme-desc').textContent = prefs.theme && THEMES[prefs.theme] ? THEMES[prefs.theme].desc : 'A mix of everything. You don’t know what’s coming, just like in a real game.'; };
$('#difficulty').value = prefs.difficulty;
$('#difficulty').onchange = (e) => { prefs.difficulty = e.target.value; store.set('prefs', prefs); loadNext(); };
$('#size').onchange = (e) => { prefs.size = e.target.value; store.set('prefs', prefs); renderFilters(); loadNext(); };
$('#theme').onchange = (e) => { prefs.theme = e.target.value; store.set('prefs', prefs); themeDesc(); loadNext(); };
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || !S) return;
  if (S.placeholder || $('#view-puzzle').classList.contains('hidden')) return;
  const total = shownLine().length, cur = S.view ?? total;
  if (e.key === 'Enter') {
    // Enter = Continue, unless it's meant for whatever has focus (a button, a link, a field).
    if (S.status === 'solved' && !e.target.closest?.('a, button, input, select, textarea, [contenteditable]')) loadNext();
  } else if (e.key === 'ArrowLeft') viewPly(cur - 1);
  else if (e.key === 'ArrowRight') viewPly(cur + 1);
  // (Escape cancels a half-entered move: board.js handles it.)
});
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
  if (!me) { el.innerHTML = `<h1>History</h1><div class="panel"><p class="flush">Claim a username at the top right to keep your rating and history across visits. As a guest you’re rated <b class="your-rating">${fmtRating(guest.rating, provisional(guest))}</b> after ${guest.games} puzzle${guest.games === 1 ? '' : 's'}.</p></div>`; return; }
  const { history: h } = await api('/api/history');
  const tok = store.get('token', null);
  // rating chart
  const pts = h.filter((r) => r.rated).reverse().map((r) => r.user_rating + r.user_delta);
  pts.unshift(1500);
  const W = 860, H = 160, lo = Math.min(...pts) - 20, hi = Math.max(...pts) + 20;
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${(i / Math.max(1, pts.length - 1)) * W},${H - ((v - lo) / (hi - lo)) * H}`).join('');
  el.innerHTML = `<h1>${esc(me.name)}</h1><p class="muted">Rating <b class="your-rating">${fmtRating(me.rating, me.provisional)}</b></p>
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
  const [, page, arg] = (location.hash || '#/').split('/');
  if (page === 'glossary') return glossaryPage();
  if (page === 'me') return mePage();
  if (page === 'leaderboard') return leaderPage();
  show('view-puzzle');
  renderFilters().catch(() => {}); // the puzzle doesn't wait for the theme counts
  if (page === 'puzzle' && arg) { if (S?.p.id !== arg) loadById(decodeURIComponent(arg)); }
  else if (S && !S.placeholder && S.status !== 'solved' && matchesFilters(S.p)) history.replaceState(null, '', '#/puzzle/' + S.p.id); // back to the puzzle in progress
  else loadNext();
}
window.addEventListener('hashchange', route);

(async () => {
  const cached = store.get('me', null);
  if (cached && store.get('token', null)) { me = { ...cached, rating: store.get('myRating', 1500), provisional: store.get('myProv', true), games: 0, wins: 0 }; }
  renderUser();
  themeDesc();
  renderAll(); // placeholder panels at their final size
  board.load(buildPTN({ size: +(prefs.size || 5) })); // the same board component, empty, until the puzzle arrives
  requestAnimationFrame(() => document.documentElement.classList.remove('booting')); // reveal once laid out
  // old path-style URLs from the dev server → hash routes
  const old = /^\/(puzzle\/[\w.-]+|glossary|me|leaderboard)$/.exec(location.pathname);
  if (old) history.replaceState(null, '', '/#/' + old[1]);
  const meP = api('/api/me').then((r) => { me = r.user; renderUser(); if (S) renderAll(); }).catch(() => {});
  // With a cached account the puzzle request goes out alongside /api/me (the server knows us by the token).
  if (!store.get('token', null) || me) route(); else { await meP; route(); }
})();
