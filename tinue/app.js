import { Game } from './shared/tak.js?v=1794090440';
import { THEMES, GLOSSARY } from './shared/themes.js?v=1794090440';
import { rate, themeWeight } from './shared/rating.js?v=1794090440';
import { NinjaBoard, buildPTN } from './ninja.js?v=1794090440';

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
    const fb = document.querySelector('#feedback');
    if (fb && !fb.textContent.trim()) fb.innerHTML = '<div><h2>Waiting for the puzzle server…</h2><p>If your browser is asking to allow access to devices on your local network, allow it. Otherwise the server may be down; try again in a bit.</p></div>';
  }, 4000);
  try {
    const r = await fetch(API + path, body
      ? { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(body), credentials: 'include' }
      : { headers: authHeaders(), credentials: 'include' });
    return await r.json();
  } finally { clearTimeout(slow); }
};
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
    box.innerHTML = `<span class="name">${esc(me.name)}</span>
      <button id="logout" title="Forget this device">Log out</button>`;
    $('#logout').onclick = async () => {
      if (!confirm('Log out? To get back in on this device you will need your token (History page shows it while logged in).')) return;
      await api('/api/logout', {}); store.set('token', null); me = null; renderUser();
    };
  } else {
    box.innerHTML = `<span class="muted">Guest</span>
      <form id="claim"><input name="name" placeholder="claim a username" maxlength="20"><button class="primary">Join</button></form>
      <a href="#" id="use-token" title="Log in on this device with the token from your History page">token</a>`;
    $('#use-token').onclick = async (e) => {
      e.preventDefault();
      const token = (prompt('Paste your login token (shown on your History page):') || '').trim();
      if (!token) return;
      const r = await api('/api/login', { token });
      if (r.error) return alert(r.error);
      me = r.user; store.set('token', token); renderUser(); route();
    };
    $('#claim').onsubmit = async (e) => {
      e.preventDefault();
      const r = await api('/api/register', { name: e.target.name.value.trim() });
      if (r.error) return alert(r.error);
      me = r.user; store.set('token', r.token);
      renderUser();
    };
  }
}

// ---------- puzzle flow ----------
async function loadNext() {
  const q = new URLSearchParams({ difficulty: prefs.difficulty });
  if (prefs.size) q.set('size', prefs.size);
  if (prefs.theme) q.set('theme', prefs.theme);
  if (!me) { q.set('rating', Math.round(guest.rating)); q.set('exclude', [...seenGuest].slice(-200).join(',')); }
  const { puzzle } = await api('/api/next?' + q);
  if (!puzzle) { $('#feedback').innerHTML = `<div><h2>No puzzles match</h2><p>Try another theme or board size.</p></div>`; return; }
  history.replaceState(null, '', '#/puzzle/' + puzzle.id);
  start(puzzle);
}

async function loadById(id) {
  const { puzzle } = await api('/api/puzzle/' + encodeURIComponent(id));
  if (puzzle) start(puzzle); else loadNext();
}

const colorName = (c) => (c === 1 ? 'White' : 'Black');

// PTN for everything shown so far: the game's history (if known) plus moves played in the puzzle.
function currentPTN() {
  const { p } = S;
  const names = p.meta?.white ? { white: p.meta.white, black: p.meta.black } : {};
  if (S.hist.length) return buildPTN({ size: p.size, komi: p.komi, moves: [...S.hist, ...S.moves.map((m) => m.ptn)], ...names });
  return buildPTN({ size: p.size, komi: p.komi, tps: p.tps, moves: S.moves.map((m) => m.ptn), ...names });
}

// Show the board only after PTN Ninja has loaded the position with our theme (no PlayTak-blue flash).
function boardReady() { setTimeout(() => $('#board-wrap').classList.add('ready'), 120); }

async function start(p) {
  const g = Game.fromTPS(p.tps, p.komi || 0);
  const hist = p.meta?.history || [];
  S = { p, g, node: p.tree, solver: g.toMove, hist, moves: [], snaps: [g.toTPS()], view: null, status: 'play', resultSent: false, hinted: false, delta: null, busy: true };
  renderAll(); // side panel right away; the board iframe may still be loading
  await board.ui({ disableBoard: true, showRoads: false });
  if (hist.length) {
    // Show the game up to just before the opponent's last move, then play that move (Lichess-style).
    const names = p.meta?.white ? { white: p.meta.white, black: p.meta.black } : {};
    await board.load(buildPTN({ size: p.size, komi: p.komi, moves: hist.slice(0, -1), ...names }));
    await board.last();
    boardReady();
    renderAll();
    setTimeout(async () => {
      if (S?.p !== p) return;
      await board.append(hist.at(-1));
      await board.last();
      S.busy = false;
      await board.setPlayer(S.solver);
      await board.ui({ disableBoard: false });
      renderAll();
    }, 650);
  } else {
    await board.load(currentPTN());
    await board.last();
    boardReady();
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
  await board.last();
  S.view = null;
  const live = S.status === 'play' || S.status === 'retry';
  await board.ui({ disableBoard: !live });
  if (live) await board.setPlayer(S.solver);
  renderAll();
}

function userMove(ptn) {
  if (!S || S.busy || S.view != null || !(S.status === 'play' || S.status === 'retry')) { if (S) restoreBoard(); return; }
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
    fail();
    setTimeout(() => { S.busy = false; restoreBoard(); }, 700);
    return;
  }
  S.moves.push({ ptn: canon, me: true }); S.snaps.push(g.toTPS());
  if (wonNow) return solved();
  S.node = next;
  S.status = 'play';
  S.busy = true;
  renderAll('good');
  setTimeout(async () => {
    if (!reply) return;
    g.play(reply);
    S.moves.push({ ptn: reply, me: false }); S.snaps.push(g.toTPS());
    await board.append(reply);
    await board.last();
    S.busy = false;
    renderAll();
  }, 450);
}

async function report(win) {
  if (S.resultSent) return;
  S.resultSent = true;
  const p = S.p;
  if (me) {
    if (S.hinted) { await api('/api/result', { puzzleId: p.id, win, casual: true }); S.delta = null; }
    else {
      const r = await api('/api/result', { puzzleId: p.id, win, theme: prefs.theme || undefined });
      if (r.user) { S.delta = r.rated ? r.userDelta : null; me = r.user; renderUser(); }
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
  session.push({ id: p.id, win, delta: S.delta });
  renderAll();
}

function fail() { S.status = 'retry'; report(false); renderAll(); }

async function solved() {
  S.status = 'solved';
  await board.ui({ disableBoard: true, showRoads: true });
  if (!S.resultSent) report(true);
  renderAll();
}

function finisher(g) {
  for (const m of g.legalMoves()) { const u = g.apply(m); const r = g.result(); g.undo(u); if (r && r.winner === S.solver) return g.moveToPTN(m); }
  return null;
}

// Play out the main line (first-listed move at each node) for "View solution".
async function showSolution() {
  if (!S || S.status === 'solved' || S.busy) return;
  if (!S.resultSent) report(false);
  S.status = 'viewing';
  await restoreBoard();
  await board.ui({ disableBoard: true });
  const g = S.g;
  const step = async () => {
    const node = S.node;
    const mv = node === 'win' ? finisher(g) : Object.keys(node)[0];
    if (!mv) return;
    g.play(mv); S.moves.push({ ptn: mv, me: true }); S.snaps.push(g.toTPS());
    await board.append(mv); await board.last();
    if (g.result()) { S.status = 'solved'; S.viewed = true; await board.ui({ showRoads: true }); renderAll(); return; }
    const { r: reply, n } = node[mv];
    renderAll();
    setTimeout(async () => {
      g.play(reply); S.moves.push({ ptn: reply, me: false }); S.snaps.push(g.toTPS());
      await board.append(reply); await board.last();
      S.node = n; renderAll();
      setTimeout(step, 750);
    }, 750);
  };
  step();
}

function showHint() {
  if (!S || S.status === 'solved' || S.status === 'viewing') return;
  S.hinted = true;
  const g = S.g;
  const mv = S.node === 'win' ? finisher(g) : Object.keys(S.node)[0];
  if (mv) board.highlight([g.sqName(g.parseMove(mv).sq)]);
  renderAll();
}

// Browse any earlier position (game history or puzzle moves). Index = number of plies shown.
async function viewPly(i) {
  if (!S) return;
  const total = S.hist.length + S.moves.length;
  i = Math.max(0, Math.min(total, i));
  if (i === total) { if (S.view != null) await restoreBoard(); return; }
  S.view = i;
  await board.ui({ disableBoard: true });
  if (i === 0) await board.first(); else await board.goTo(i - 1);
  renderAll();
}

// ---------- rendering ----------
function renderAll(mood) {
  if (!S) return;
  const { p } = S;
  const fb = $('#feedback');
  const myRating = Math.round(me ? me.rating : guest.rating);
  if (me) store.set('myRating', me.rating);
  const delta = S.delta != null ? `<span class="delta ${S.delta >= 0 ? 'up' : 'down'}">${S.delta >= 0 ? '+' : ''}${Math.round(S.delta)}</span>` : '';
  const playActions = `<div class="actions"><button data-act="hint">Hint</button><button data-act="solution">View solution</button></div>`;
  if (S.status === 'solved') {
    fb.innerHTML = `<div class="icon ${S.viewed ? 'bad' : 'good'}">${S.viewed ? '✗' : '✓'}</div><div class="body">
      <h2>${S.viewed ? 'Solution shown' : session.at(-1)?.win === false ? 'Solved — after a miss' : 'Success!'}</h2>
      <p>${S.hinted ? 'Hint used, so this one was unrated.' : 'Use ← and → to replay the line.'}</p></div>
      <div class="actions one"><button class="primary" data-act="next">Continue training</button></div>`;
  } else if (S.status === 'retry') {
    fb.innerHTML = `<div class="icon bad">✗</div><div class="body"><h2>That’s not the move!</h2><p>Try something else.</p></div>${playActions}`;
  } else if (S.status === 'viewing') {
    fb.innerHTML = `<div class="icon bad">…</div><div class="body"><h2>Solution</h2><p>Watch the line.</p></div>`;
  } else {
    const good = mood === 'good';
    fb.innerHTML = `<div class="icon ${good ? 'good' : 'turn p' + S.solver}">${good ? '✓' : ''}</div><div class="body">
      <h2>${good ? 'Best move!' : 'Your turn'}</h2>
      <p>${good ? 'Keep going…' : `You play ${colorName(S.solver)}`}</p></div>${playActions}`;
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
        <dt>Played</dt><dd>${p.attempts + 1} time${p.attempts ? 's' : ''}</dd>
        <dt>From</dt><dd>${game}</dd>
      </dl>
      ${m.white ? `<div class="players">${player(1, m.white, m.ratingWhite)}${player(2, m.black, m.ratingBlack)}</div>` : ''}
      <hr><div>${themes.map((t) => `<a class="tag" href="#/glossary/${t}" title="${esc(THEMES[t].desc)}">${THEMES[t].name}</a>`).join('') || '<span class="sub">No themes</span>'}</div>`;
  }

  // Move list: the game so far (dim) and then the puzzle. Click any move to see that position.
  const all = [...S.hist.map((m) => ({ ptn: m, past: true })), ...S.moves];
  const g0 = S.hist.length ? null : Game.fromTPS(p.tps);
  let ply = S.hist.length ? 0 : g0.ply;
  const cur = S.view ?? all.length;
  const html = all.map((m, i) => {
    const num = ply % 2 === 0 ? `<span class="num">${Math.floor(ply / 2) + 1}.</span>` : i === 0 ? `<span class="num">${Math.floor(ply / 2) + 1}…</span>` : '';
    ply++;
    const cls = ['mv', m.past ? 'past' : m.me ? 'me ok' : 'opp', i + 1 === cur ? 'cur' : ''].join(' ');
    const sep = !m.past && i === S.hist.length ? '<span class="start">puzzle</span>' : '';
    return `${sep}${num}<span class="${cls}" data-i="${i + 1}">${esc(m.ptn)}</span>`;
  }).join('');
  const mv = $('#moves');
  mv.innerHTML = `<div class="list">${html || '<span class="muted">Moves appear here.</span>'}</div>` +
    `<div class="nav"><button data-nav="first" title="Start" aria-label="Start">⏮</button><button data-nav="prev" title="Back (←)" aria-label="Back">◀</button><button data-nav="next" title="Forward (→)" aria-label="Forward">▶</button><button data-nav="last" title="Current position" aria-label="Current position">⏭</button>${S.view != null ? '<span class="muted">viewing an earlier position</span>' : ''}</div>`;
  const curEl = mv.querySelector('.mv.cur') || mv.querySelector('.mv:last-of-type');
  if (curEl && mv.scrollHeight > mv.clientHeight) curEl.scrollIntoView({ block: 'nearest' });

}

$('#moves').addEventListener('click', (e) => {
  if (!S) return;
  const total = S.hist.length + S.moves.length, cur = S.view ?? total;
  const m = e.target.closest('[data-i]');
  if (m) return viewPly(+m.dataset.i);
  const n = e.target.closest('[data-nav]')?.dataset.nav;
  if (n) viewPly({ first: 0, prev: cur - 1, next: cur + 1, last: total }[n]);
});

// ---------- controls ----------
// buttons inside the feedback card
$('#feedback').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'hint') return showHint();
  if (act === 'solution') return showSolution();
  if (act === 'next') return loadNext();
});
const themeDesc = () => { $('#theme-desc').textContent = prefs.theme && THEMES[prefs.theme] ? THEMES[prefs.theme].desc : 'A mix of everything. You don’t know what’s coming, just like in a real game.'; };
$('#difficulty').value = prefs.difficulty;
$('#difficulty').onchange = (e) => { prefs.difficulty = e.target.value; store.set('prefs', prefs); };
$('#size').onchange = (e) => { prefs.size = e.target.value; store.set('prefs', prefs); renderFilters(); loadNext(); };
$('#theme').onchange = (e) => { prefs.theme = e.target.value; store.set('prefs', prefs); themeDesc(); loadNext(); };
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || !S) return;
  const total = S.hist.length + S.moves.length, cur = S.view ?? total;
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
  else if (!S || S.status === 'solved' || page !== 'puzzle') { if (!S || location.hash === '#/' || !location.hash) loadNext(); }
}
window.addEventListener('hashchange', route);

(async () => {
  const cached = store.get('me', null);
  if (cached && store.get('token', null)) { me = { ...cached, rating: store.get('myRating', 1500), games: 0, wins: 0 }; }
  renderUser();
  // old path-style URLs from the dev server → hash routes
  const old = /^\/(puzzle\/[\w.-]+|glossary|me|leaderboard)$/.exec(location.pathname);
  if (old) history.replaceState(null, '', '/#/' + old[1]);
  me = (await api('/api/me')).user;
  renderUser();
  route();
})();
