import { Game } from './shared/tak.js?v=1794092723';
import { THEMES, GLOSSARY } from './shared/themes.js?v=1794092723';
import { rate, themeWeight } from './shared/rating.js?v=1794092723';
import { NinjaBoard, buildPTN } from './board.js?v=1794092723';
import * as engine from './engine.js?v=1794092723';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// The API can live elsewhere (static page on shydrie.xyz, API on crux): config.js sets TINUE_API.
// Auth is a bearer token from localStorage (cross-site cookies get blocked), plus a cookie for same-origin dev.
const API = (window.TINUE_API || '').replace(/\/$/, '');
const authHeaders = () => { const t = store.get('token', null); return t ? { authorization: 'Bearer ' + t } : {}; };
const api = async (path, body) => {
  // If the server can't be reached, say so instead of showing a blank page. (On Shy's tailnet, Chrome asks for
  // "local network access" before a public page may call crux's private address; that prompt also stalls here.)
  const slow = setTimeout(() => {
    notice = { title: 'Waiting for the puzzle server…', body: 'If your browser asks to allow access to devices on your local network, allow it. Otherwise the server may be down; try again in a bit.' };
    renderAll();
  }, 4000);
  try {
    const r = await fetch(API + path, body
      ? { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(body), credentials: 'include' }
      : { headers: authHeaders(), credentials: 'include' });
    const j = await r.json();
    if (notice?.title.startsWith('Waiting')) { notice = null; renderAll(); }
    return j;
  } catch (e) {
    notice = { title: 'Can’t reach the puzzle server', body: 'Check your connection and reload. If it keeps happening, the server may be down.' };
    renderAll();
    throw e;
  } finally { clearTimeout(slow); }
};
let notice = null; // a message that replaces the turn card (server waiting / no puzzles)
const store = {
  get(k, d) { try { const v = localStorage.getItem('tinue.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tinue.' + k, JSON.stringify(v)); } catch {} },
};

let me = null; // server user
const guest = store.get('guest', { rating: 1500, games: 0 });
const prefs = store.get('prefs', {});
if (!prefs.v2) { prefs.size = '5'; prefs.v2 = true; } // 5×5 by default
prefs.difficulty ||= 'normal';
store.set('prefs', prefs);
const session = []; // {id, win, delta}
const seenGuest = new Set(store.get('seen', []));

const board = new NinjaBoard($('#ninja'), { onMove: (ptn) => userMove(ptn) });
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
    $('#logout-yes').onclick = async () => { await api('/api/logout', {}); store.set('token', null); me = null; renderUser(); renderAll(); };
  } else {
    // One quiet button; claiming a name (or pasting a token) happens in a small popover.
    box.innerHTML = `<div class="menu click"><button class="link name" id="claim-open" aria-haspopup="true">Claim a username</button>
      <div class="pop wide" role="dialog">
        <form id="claim"><label class="field"><span>Username</span><input name="name" id="claim-name" maxlength="20" autocomplete="username" placeholder="2–20 letters, digits, _ or -"></label>
          <button class="primary" type="submit">Claim</button><p class="err hidden" id="claim-err"></p>
          <p class="hint">No password: your browser remembers you. <button type="button" class="link" id="token-open">Have a login token?</button></p></form>
        <form id="tok" class="hidden"><label class="field"><span>Login token</span><input name="token" id="tok-in" autocomplete="off" placeholder="From the History page on your other device"></label>
          <button class="primary" type="submit">Sign in</button><p class="err hidden" id="tok-err"></p></form>
      </div></div>`;
    const menu = box.querySelector('.menu');
    $('#claim-open').onclick = () => { menu.classList.toggle('open'); if (menu.classList.contains('open')) $('#claim-name').focus(); };
    $('#token-open').onclick = () => { $('#claim').classList.add('hidden'); $('#tok').classList.remove('hidden'); $('#tok-in').focus(); };
    const showErr = (id, msg) => { const el = $(id); el.textContent = msg; el.classList.remove('hidden'); };
    $('#claim').onsubmit = async (e) => {
      e.preventDefault();
      const r = await api('/api/register', { name: $('#claim-name').value.trim() });
      if (r.error) return showErr('#claim-err', r.error);
      me = r.user; store.set('token', r.token); renderUser(); renderAll();
    };
    $('#tok').onsubmit = async (e) => {
      e.preventDefault();
      const token = $('#tok-in').value.trim();
      const r = await api('/api/login', { token });
      if (r.error) return showErr('#tok-err', 'That token doesn’t match an account.');
      me = r.user; store.set('token', token); renderUser(); route();
    };
  }
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelector('.menu.open')?.classList.remove('open'); });
document.addEventListener('click', (e) => { // close the claim popover when clicking elsewhere
  const m = document.querySelector('.menu.click.open');
  if (m && !m.contains(e.target)) m.classList.remove('open');
});

// ---------- puzzle flow ----------
let loadSeq = 0;
async function loadNext() {
  const t = ++loadSeq;
  const q = new URLSearchParams({ difficulty: prefs.difficulty });
  if (prefs.size) q.set('size', prefs.size);
  if (prefs.theme) q.set('theme', prefs.theme);
  if (!me) { q.set('rating', Math.round(guest.rating)); q.set('exclude', [...seenGuest].slice(-200).join(',')); }
  const { puzzle } = await api('/api/next?' + q);
  if (t !== loadSeq) return; // a newer request superseded this one
  if (!puzzle) { notice = { title: 'No puzzles match', body: 'Try another theme, difficulty or board size.' }; renderAll(); return; }
  notice = null;
  history.replaceState(null, '', '#/puzzle/' + puzzle.id);
  start(puzzle);
}

async function loadById(id) {
  const t = ++loadSeq;
  const { puzzle } = await api('/api/puzzle/' + encodeURIComponent(id));
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
  S.evalKey = key; S.eval = { kind: 'thinking' }; renderAll();
  const res = await engine.analyze({ ...enginePos(S.hist.length ? line.slice(0, at) : line.slice(0, at)), maxPlies: 9 });
  if (res && S.evalKey === key) { S.eval = res; renderAll(); }
}

// Load a line onto the board and show the position after `idx` plies (no animation).
async function showLine(line, idx) {
  const key = line.join(' ');
  if (S.loadedKey !== key) { await board.load(ptnFor(line)); S.loadedKey = key; }
  if (idx >= line.length) await board.last(); else if (idx === 0) await board.first(); else await board.goTo(idx - 1);
}

function boardReady() {}

async function start(p) {
  engine.interrupt(); // nothing from the previous puzzle should still be thinking
  const g = Game.fromTPS(p.tps, p.komi || 0);
  const hist = p.meta?.history || [];
  const s = S = { p, g, node: p.tree, solver: g.toMove, hist, moves: [], snaps: [g.toTPS()], view: null, status: 'play', resultSent: false, hinted: false, delta: null, busy: true,
        misses: [], outcome: null, branch: null, onBranch: false };
  renderAll(); // side panel right away; the board iframe may still be loading
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
      renderAll();
    }, 650);
  } else {
    await board.load(currentPTN());
    await board.last();
    if (S !== s) return;
    S.busy = false;
    await board.setPlayer(S.solver);
    await board.ui({ disableBoard: false });
  }
  renderAll();
}

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

function userMove(ptn) {
  if (S && !S.placeholder && S.status === 'solved') return explore(ptn);
  if (!S || S.placeholder || S.busy || S.view != null || !(S.status === 'play' || S.status === 'retry')) { if (S) restoreBoard(); return; }
  const g = S.g;
  let canon;
  try { canon = g.canon(ptn); } catch { restoreBoard(); return; }
  if (!g.legalMoves().some((m) => g.moveToPTN(m) === canon)) { restoreBoard(); return; }
  const node = S.node;
  let correct = false, reply = null, next = null, wonNow = false;
  const u = g.apply(g.parseMove(canon));
  const res = g.result();
  if (res && res.winner === S.solver) { correct = true; wonNow = true; }
  else if (node !== 'win' && node && Object.prototype.hasOwnProperty.call(node, canon) && !res) {
    correct = true; reply = node[canon]?.r; next = node[canon]?.n;
  }
  if (!correct) {
    g.undo(u);
    S.busy = true;
    S.misses.push({ at: S.moves.length, ptn: canon });
    const remaining = pliesLeft();
    const plies = [...(S.hist.length ? officialLine() : S.moves.map((m) => m.ptn)), canon];
    S.refutation = { miss: canon, kind: 'thinking' };
    const s = S;
    engine.refute({ ...enginePos(plies), attacker: S.solver, remaining }).then((r) => {
      if (r && S === s && S.refutation?.miss === canon) { S.refutation = { miss: canon, ...r }; renderAll(); }
    });
    fail();
    setTimeout(() => { if (S !== s) return; S.busy = false; restoreBoard(); }, 700);
    return;
  }
  S.moves.push({ ptn: canon, me: true }); S.snaps.push(g.toTPS());
  S.refutation = null;
  if (wonNow) return solved();
  S.node = next;
  S.status = 'play';
  S.busy = true;
  renderAll('good');
  const s = S;
  setTimeout(async () => {
    if (!reply || S !== s) return;
    g.play(reply);
    S.moves.push({ ptn: reply, me: false }); S.snaps.push(g.toTPS());
    await board.append(reply);
    await board.last();
    if (S !== s) return;
    S.busy = false;
    renderAll();
  }, 450);
}

async function report(win) {
  if (S.resultSent) return;
  S.resultSent = true;
  S.casual = S.hinted; // a hint before the result makes the attempt unrated
  const s = S, p = S.p;
  if (me) {
    if (S.hinted) { await api('/api/result', { puzzleId: p.id, win, casual: true }); s.delta = null; }
    else {
      const r = await api('/api/result', { puzzleId: p.id, win, theme: prefs.theme || undefined });
      if (r.user) { s.delta = r.rated ? r.userDelta : null; if (r.rated) p.attempts++; me = r.user; renderUser(); }
    }
  } else {
    if (!S.hinted && !seenGuest.has(p.id)) {
      const { userDelta } = rate(guest, p, win, themeWeight(prefs.theme, THEMES, win));
      guest.rating += userDelta; guest.games++; S.delta = userDelta;
      store.set('guest', guest);
      api('/api/result', { puzzleId: p.id, win }); // counted as a play, not rated
    }
    seenGuest.add(p.id); store.set('seen', [...seenGuest].slice(-500));
    renderUser();
  }
  session.push({ id: p.id, win, delta: s.delta });
  renderAll();
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
  await board.ui({ disableBoard: false, showRoads: true });
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
  S.loadedKey = null;
  await showLine(shownLine(), shownLine().length);
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
  if (!S.resultSent) report(false);
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

function showHint() {
  if (!S || S.placeholder || S.busy || S.status === 'solved' || S.status === 'viewing') return;
  const g = S.g;
  const mv = S.node === 'win' ? finisher(g) : Object.keys(S.node)[0];
  if (!mv) return;
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
const PLACEHOLDER = {
  placeholder: true, solver: 1, status: 'play', moves: [], view: null, delta: null, misses: [], branch: null, onBranch: false,
  hist: 'a1 e5 c3 b4 d3 c4 b3 d4 e3 a4 c2 e4 b2 a5 d2'.split(' '),
  p: { id: '', size: 5, themes: [], meta: {}, komi: 0, tps: 'x5/x5/x5/x5/x5 1 1', rating: 0, attempts: 0 },
};

// ---------- rendering ----------
function renderAll(mood) {
  if (!S) S = PLACEHOLDER;
  const loading = !!S.placeholder;
  for (const id of ['#feedback', '#moves']) $(id).classList.toggle('is-loading', loading);
  const { p } = S;
  const fb = $('#feedback');
  const myRating = Math.round(me ? me.rating : guest.rating);
  if (me) store.set('myRating', me.rating);
  const delta = S.delta != null ? `<span class="delta ${S.delta >= 0 ? 'up' : 'down'}">${S.delta >= 0 ? '+' : ''}${Math.round(S.delta)}</span>` : '';
  const dis = S.placeholder ? ' disabled tabindex="-1"' : '';
  const playActions = `<div class="actions"><button data-act="hint"${dis}>Hint</button><button data-act="solution"${dis}>View solution</button></div>`;
  const other = colorName(3 - S.solver);
  const refText = (r) => !r ? '' : r.kind === 'thinking' ? `Checking why ${esc(r.miss)} fails…`
    : r.kind === 'gives-road' ? `After ${esc(r.miss)}, ${other} makes a road with <b>${esc(r.reply)}</b>.`
    : r.kind === 'refuted' ? `After ${esc(r.miss)}, ${other} answers <b>${esc(r.reply)}</b> and ${r.exact ? 'the forced win is gone' : 'the solver finds no forced win'}.`
    : `${esc(r.miss)} doesn’t force the win.`;
  if (notice) {
    $('#feedback').classList.remove('is-loading');
    fb.innerHTML = `<div class="icon bad">!</div><div class="body"><h2>${esc(notice.title)}</h2><p>${esc(notice.body)}</p></div>`;
  } else if (S.status === 'solved') {
    const title = S.outcome === 'viewed' ? 'Solution shown' : S.outcome === 'miss' ? 'Solved, after a miss' : 'Solved';
    const note = S.casual ? 'You used a hint, so this one didn’t count toward your rating.'
      : 'Try any move on the board to explore, or step through the line with ← and →.';
    fb.innerHTML = `<div class="icon ${S.outcome === 'clean' ? 'good' : 'bad'}">${S.outcome === 'clean' ? '✓' : '✗'}</div><div class="body">
      <h2>${title}</h2><p>${note}</p></div>
      <div class="actions one"><button class="primary" data-act="next">Continue training</button></div>`;
  } else if (S.status === 'retry') {
    fb.innerHTML = `<div class="icon bad">✗</div><div class="body"><h2>That’s not the move</h2>
      <p>${refText(S.refutation) || 'Try another move.'} This puzzle now counts as a miss; keep trying or view the solution.</p></div>${playActions}`;
  } else if (S.status === 'viewing') {
    fb.innerHTML = `<div class="icon bad">…</div><div class="body"><h2>Solution</h2><p>Watch the winning line.</p></div>`;
  } else {
    const good = mood === 'good';
    fb.innerHTML = `<div class="icon ${good ? 'good' : 'turn p' + S.solver}">${good ? '✓' : ''}</div><div class="body">
      <h2>${good ? 'Best move!' : 'Your turn'}</h2>
      <p>${good ? 'Keep going.' : `You play ${colorName(S.solver)}`}</p></div>${playActions}`;
  }

  // Session card: your rating (with the latest change beside it) and one chip per puzzle, Lichess-style.
  const last = session.at(-1);
  const sign = (d) => (d >= 0 ? '+' : '−') + Math.abs(Math.round(d));
  $('#session').innerHTML = `<div><div class="label">Your rating</div><div class="rating-line"><span class="big">${myRating}</span>${S.status === 'solved' && last?.id === p.id && last.delta != null ? `<span class="delta ${last.delta >= 0 ? 'up' : 'down'}">${sign(last.delta)}</span>` : ''}</div></div>
    <div class="streak">${session.map((x) => `<a class="${x.win ? 'w' : 'l'}${x.id === p.id ? ' cur' : ''}" href="#/puzzle/${esc(x.id)}" title="Puzzle #${esc(x.id)}">${x.delta != null ? sign(x.delta) : x.win ? '✓' : '✗'}</a>`).join('')}</div>`;

  // Everything about the puzzle itself comes at the end.
  const done = S.status === 'solved';
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
      ${m.white ? `<div class="players">${player(1, m.white, m.ratingWhite)}${player(2, m.black, m.ratingBlack)}</div>` : ''}
      <hr><div>${themes.map((t) => `<a class="tag" href="#/glossary/${t}" title="${esc(THEMES[t].desc)}">${THEMES[t].name}</a>`).join('') || '<span class="sub">No themes</span>'}</div>`;
  }

  // Move list: the game so far (dim), then the puzzle (your misses struck through in red), then your own
  // line if you're exploring, then the engine's view after the puzzle. Click any move to see that position.
  const official = officialLine();
  const startPly = S.hist.length ? 0 : Game.fromTPS(p.tps).ply;
  const numFor = (ply, first) => (ply % 2 === 0 ? `<span class="num">${Math.floor(ply / 2) + 1}.</span>` : first ? `<span class="num">${Math.floor(ply / 2) + 1}…</span>` : '');
  const viewIdx = S.view ?? shownLine().length;
  const missesAt = (k) => S.misses.filter((x) => x.at === k).map((x) => `<span class="mv miss" title="Not the move">${esc(x.ptn)}</span>`).join('');
  let html = '';
  const onShared = (i) => !S.onBranch || (S.branch && i + 1 <= S.branch.at); // official moves also on your line
  official.forEach((m, i) => {
    const k = i - S.hist.length; // index within the puzzle moves
    if (k === 0) html += '<span class="start">Puzzle</span>';
    const mvObj = k >= 0 ? S.moves[k] : null;
    const cls = ['mv', k < 0 ? 'past' : mvObj?.shown ? 'me shown' : mvObj?.me ? 'me ok' : 'opp', onShared(i) && i + 1 === viewIdx ? 'cur' : ''].join(' ');
    html += `${numFor(startPly + i, i === 0)}${k >= 0 ? missesAt(k) : ''}<span class="${cls}" data-i="${i + 1}">${esc(m)}</span>`;
  });
  if (S.hist.length === official.length && S.moves.length === 0) html += '<span class="start">Puzzle</span>';
  if (S.misses.some((x) => x.at === S.moves.length)) html += numFor(startPly + official.length, official.length === 0) + missesAt(S.moves.length);
  if (S.branch) {
    const b0 = S.branch.at;
    html += `<div class="branch"><span class="branch-label">Your line</span>${S.branch.moves.map((m, j) =>
      `${numFor(startPly + b0 + j, j === 0)}<span class="mv ${S.onBranch && b0 + j + 1 === viewIdx ? 'cur' : ''}" data-b="${b0 + j + 1}">${esc(m)}</span>`).join('')}
      <button class="link back" data-act2="back">Back to the solution</button></div>`;
  }
  let engineHtml = '';
  if (S.status === 'solved' && S.eval) {
    const e = S.eval, side = colorName(e.side);
    const t = e.kind === 'thinking' ? 'Thinking…'
      : e.kind === 'over' ? (e.winner === 0 ? 'Drawn on flats.' : `${colorName(e.winner)} has won${e.how === 'flat' ? ' on flats' : ''}.`)
      : e.kind === 'win' ? `${side} forces a win in ${Math.ceil(e.plies / 2)}: <span class="pv">${(e.pv || []).map(esc).join(' ')}</span>`
      : e.kind === 'none' ? `${e.exact ? 'No forced win' : 'No forced win found'} for ${side} within ${Math.ceil(e.maxPlies / 2)} moves.${e.threat ? ` ${colorName(3 - e.side)} threatens a road (${esc(e.threat)}).` : ''}`
      : 'Engine unavailable.';
    engineHtml = `<div class="engine"><span class="engine-label">Engine</span> ${t}</div>`;
  }
  html = `<div class="list">${html || '<span class="muted">Moves appear here.</span>'}</div>${engineHtml}`;
  const mv = $('#moves');
  mv.innerHTML = html +
    `<div class="nav"><button data-nav="first" title="Start" aria-label="Start">⏮</button><button data-nav="prev" title="Back (←)" aria-label="Back">◀</button><button data-nav="next" title="Forward (→)" aria-label="Forward">▶</button><button data-nav="last" title="Current position" aria-label="Current position">⏭</button>${S.view != null ? '<span class="muted">viewing an earlier position</span>' : ''}</div>`;
  const curEl = mv.querySelector('.mv.cur') || mv.querySelector('.mv:last-of-type');
  if (curEl && mv.scrollHeight > mv.clientHeight) curEl.scrollIntoView({ block: 'nearest' });

}

$('#moves').addEventListener('click', (e) => {
  if (!S || S.placeholder) return;
  if (e.target.closest('[data-act2="back"]')) return backToSolution();
  const m = e.target.closest('[data-i]');
  if (m) return viewPly(+m.dataset.i, false);
  const b = e.target.closest('[data-b]');
  if (b) return viewPly(+b.dataset.b, true);
  const total = shownLine().length, cur = S.view ?? total;
  const n = e.target.closest('[data-nav]')?.dataset.nav;
  if (n) viewPly({ first: 0, prev: cur - 1, next: cur + 1, last: total }[n]);
});

// ---------- controls ----------
// buttons inside the feedback card
$('#feedback').addEventListener('click', async (e) => {
  if (!S || S.placeholder) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'hint') return showHint();
  if (act === 'solution') return showSolution();
  if (act === 'next') return loadNext();
});
const themeDesc = () => { $('#theme-desc').textContent = prefs.theme && THEMES[prefs.theme] ? THEMES[prefs.theme].desc : 'A mix of everything. You don’t know what’s coming, just like in a real game.'; };
$('#difficulty').value = prefs.difficulty;
$('#difficulty').onchange = (e) => { prefs.difficulty = e.target.value; store.set('prefs', prefs); loadNext(); };
$('#size').onchange = (e) => { prefs.size = e.target.value; store.set('prefs', prefs); renderFilters(); loadNext(); };
$('#theme').onchange = (e) => { prefs.theme = e.target.value; store.set('prefs', prefs); themeDesc(); loadNext(); };
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || !S) return;
  if (S.placeholder) return;
  const total = shownLine().length, cur = S.view ?? total;
  if (e.key === 'Enter' && S.status === 'solved') loadNext();
  else if (e.key === 'ArrowLeft') viewPly(cur - 1);
  else if (e.key === 'ArrowRight') viewPly(cur + 1);
  else if (e.key === 'Escape') board.cancel();
});

async function renderFilters() {
  const t = await api('/api/themes' + (prefs.size ? '?size=' + prefs.size : ''));
  const sel = $('#size');
  sel.innerHTML = '<option value="">Any size</option>' + Object.keys(t.allSizes || t.sizes).sort().map((s) => `<option value="${s}">${s}×${s} (${(t.allSizes || t.sizes)[s]})</option>`).join('');
  sel.value = prefs.size || '';
  const groups = {};
  for (const [k, v] of Object.entries(THEMES)) if (t.themes[k] && v.group !== 'Board') (groups[v.group] ||= []).push(k);
  $('#theme').innerHTML = `<option value="">Mix (everything)</option>` + Object.entries(groups).map(([g, ks]) =>
    `<optgroup label="${g}">${ks.map((k) => `<option value="${k}">${THEMES[k].name} (${t.themes[k]})</option>`).join('')}</optgroup>`).join('');
  $('#theme').value = prefs.theme || '';
  themeDesc();
  return t;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-theme]');
  if (a) { e.preventDefault(); prefs.theme = a.dataset.theme; store.set('prefs', prefs); renderFilters(); go('#/'); }
});

// ---------- pages ----------
function show(id) {
  for (const v of ['view-puzzle', 'view-glossary', 'view-me', 'view-leaderboard']) $('#' + v).classList.toggle('hidden', v !== id);
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('on', a.getAttribute('href') === (location.hash.replace(/^(#\/[a-z]*).*$/, '$1') || '#/').replace('#/puzzle', '#/'));
}

async function glossaryPage() {
  show('view-glossary');
  const t = await api('/api/themes');
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
  if (!me) { el.innerHTML = `<h1>History</h1><div class="panel"><p class="flush">Claim a username at the top right to keep your rating and history across visits. As a guest you’re rated <b class="your-rating">${Math.round(guest.rating)}</b> after ${guest.games} puzzle${guest.games === 1 ? '' : 's'}.</p></div>`; return; }
  const { history: h } = await api('/api/history');
  const tok = store.get('token', null);
  // rating chart
  const pts = h.filter((r) => r.rated).reverse().map((r) => r.user_rating + r.user_delta);
  pts.unshift(1500);
  const W = 860, H = 160, lo = Math.min(...pts) - 20, hi = Math.max(...pts) + 20;
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${(i / Math.max(1, pts.length - 1)) * W},${H - ((v - lo) / (hi - lo)) * H}`).join('');
  el.innerHTML = `<h1>${esc(me.name)}</h1><p class="muted">Rating <b class="your-rating">${Math.round(me.rating)}</b></p>
    <p class="muted">${me.games} rated puzzles, ${me.wins} solved first try.${tok ? ` Your login token (paste on another device): <code>${tok}</code>` : ''}</p>
    <div class="chart"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none"><path d="${path}" fill="none" stroke="#3692e7" stroke-width="2" vector-effect="non-scaling-stroke"/></svg></div>
    <table class="t"><tr><th>Puzzle</th><th>Result</th><th>Puzzle rating</th><th>Δ</th><th>When</th></tr>
    ${h.map((r) => `<tr><td><a href="#/puzzle/${esc(r.puzzle_id)}">#${esc(r.puzzle_id)}</a> <span class="muted">${r.size}×${r.size}, ${r.plies} ply</span></td>
      <td>${r.win ? '✓' : '✗'}</td><td>${Math.round(r.puzzle_rating)}</td>
      <td>${r.rated ? `<span class="delta ${r.user_delta >= 0 ? 'up' : 'down'}">${r.user_delta >= 0 ? '+' : ''}${Math.round(r.user_delta)}</span>` : '<span class="muted">casual</span>'}</td>
      <td class="muted">${new Date(r.ts).toLocaleString()}</td></tr>`).join('')}</table>`;
}

async function leaderPage() {
  show('view-leaderboard');
  const { leaders } = await api('/api/leaderboard');
  $('#view-leaderboard').innerHTML = `<h1>Leaderboard</h1><p class="muted">Players with at least 5 rated puzzles.</p>` + (leaders.length
    ? `<table class="t"><tr><th>#</th><th>Player</th><th>Rating</th><th>Puzzles</th></tr>${leaders.map((l, i) =>
      `<tr><td>${i + 1}</td><td>${esc(l.name)}</td><td>${Math.round(l.rating)}</td><td>${l.games}</td></tr>`).join('')}</table>`
    : `<div class="panel"><p class="flush">Nobody has rated 5 puzzles yet. Claim a username and you could be first.</p></div>`);
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
  await renderFilters();
  if (page === 'puzzle' && arg) { if (S?.p.id !== arg) loadById(decodeURIComponent(arg)); }
  else if (S && !S.placeholder && S.status !== 'solved') history.replaceState(null, '', '#/puzzle/' + S.p.id); // back to the puzzle in progress
  else loadNext();
}
window.addEventListener('hashchange', route);

(async () => {
  const cached = store.get('me', null);
  if (cached && store.get('token', null)) { me = { ...cached, rating: store.get('myRating', 1500), games: 0, wins: 0 }; }
  renderUser();
  themeDesc();
  renderAll(); // placeholder panels at their final size
  board.load(buildPTN({ size: +(prefs.size || 5) })); // the same board component, empty, until the puzzle arrives
  // old path-style URLs from the dev server → hash routes
  const old = /^\/(puzzle\/[\w.-]+|glossary|me|leaderboard)$/.exec(location.pathname);
  if (old) history.replaceState(null, '', '/#/' + old[1]);
  const meP = api('/api/me').then((r) => { me = r.user; renderUser(); if (S) renderAll(); });
  if (!store.get('token', null)) route(); else { await meP; route(); }
})();
