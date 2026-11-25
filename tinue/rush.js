// The Rush page (#/rush): Rush (3 minutes, as many puzzles as you can) and Streak (until the first mistake), as
// Lichess's Puzzle Storm and Puzzle Streak. This module owns the run; the rules are in rush-rules.js (pure, tested),
// the board is PTN Ninja's (the puzzle page's frame, borrowed for each run: ninja.js lend), and the server's part is
// server/rush.js. A move off the puzzle's line is adjudicated
// with the puzzle page's own rules and engines (playon.js, defend.js, engine.js: see adjudicate), the clock paused
// while they work. Nothing here is rated, and nothing here touches the puzzle page's state.
// app.js calls enter() when the page is shown and leave() when another page is.
import { buildPTN } from './board-kit.js?v=1795581690';
import { SAYS, onNinjaTheme } from './ninja.js?v=1795581690';
import { api, store, token, guestId } from './api.js?v=1795581690';
import { confirmOn, takesHeldKey } from './settings.js?v=1795581690';
import * as R from './rush-rules.js?v=1795581690';
import { picture, pictureHTML } from './rush-look.js?v=1795581690';
import { pictureLook } from './rush-theme.js?v=1795581690';
import * as engine from './engine.js?v=1795581690';
import * as tiltak from './tiltak.js?v=1795581690';
import { defender, ending, legalMove, capWait, playOutOf, applyProofLength, pliesLeftOf, slowerWinsAt, upgradeToProven, measureProof, defenderName } from './playon.js?v=1795581690';
import { defenderMove, warmDefender, waitAtCap } from './defend.js?v=1795581690';
import { busy, BUSY_MS } from './busy.js?v=1795581690';
import * as SYM from './shared/sym.js?v=1795581690';
import * as sound from './sound.js?v=1795581690'; // (moves click through board-kit.js hooks.onPly, set by app.js; the verdicts are played here)

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// A new puzzle's board ignores input for LOCK_MS (as busy.js 'board' does on the puzzle page, 700 ms there): the
// second tap of a double tap, or a bounce, on the move that ended the last puzzle must not land on the next one, and
// here the next one appears at once under the finger. 250 ms covers a double tap (typically under ~200 ms apart) and
// is about a human's visual reaction time, so it never holds back a move made after seeing the new position; 700 ms
// would cost a fast run several seconds of clock.
export const LOCK_MS = 250;
// A puzzle with its game on record opens as the puzzle page's does (app.js start), quicker for a timed mode: the
// position before the opponent's last move for INTRO_WAIT, then that move (the board's 0.3 s slide), left tinted.
// Input opens when the intro ends (it outlasts LOCK_MS, which it replaces); the Rush clock runs on meanwhile, as on
// Lichess. With reduced motion there is no wait and no slide: the position appears with the move tinted.
const INTRO_WAIT = 100, INTRO_MS = 400;
const calm = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
// A run has its pages in memory before it needs them: right after the first, the next is fetched until NEED puzzles are
// in hand (two pages: more than a strong Rush), then one more whenever MORE_AT are left (a long Streak). The run never
// waits on them: if none came, it ends when it runs out.
const NEED = 160, MORE_AT = 15;
const SPARE_KEY = 'rushSpares', QUEUE_KEY = 'rushQueue';
const read = (k) => { try { return store.get(k, []); } catch { return []; } };
const write = (k, v) => { try { store.set(k, v); } catch {} };

const MODE = {
  rush: { name: 'Rush', desc: '3 minutes. A mistake costs 10 seconds.' },
  streak: { name: 'Streak', desc: 'No clock. One mistake ends it. One skip.' },
};

let view = null, board = null, built = false;
// The puzzle page's NinjaBoard (app.js hands it over), whose frame each run borrows (ninja.js lend).
let frame = null;
// { mode }: this page's own choice. Rush is 6×6 only (R.SIZE): an older stored size is ignored, as are cached bests for
// other sizes.
let opts = store.get('rush', {});
// the run in progress: { run, puzzles, idx, cur, more, timer, ended, token, pages }. token and pages are the
// server's signed run and its pages as handed out, sent back with the result (server/rush.js: only those puzzles count).
let st = null;
let gen = 0; // bumped by every new run and by leave(): answers for an older one are dropped

const modeChoice = () => (opts.mode === 'streak' ? 'streak' : 'rush');
const saveOpts = () => store.set('rush', opts);

function build() {
  view = $('#view-rush');
  view.innerHTML = `
    <section class="rush-start" id="rush-start"></section>
    <section class="rush-run hidden" id="rush-run">
      <div class="rush-hud">
        <div class="rush-side" aria-hidden="true"><div class="rush-turn" id="rush-turn"><i></i></div></div>
        <div class="rush-clock" id="rush-clock" role="timer"><span id="rush-clock-t">3:00</span><span class="sr-only"> left</span></div>
        <div class="rush-score"><b id="rush-score">0</b><span id="rush-score-label">solved</span></div>
        <div class="rush-combo" id="rush-combo"><div class="rush-combo-text"><span id="rush-combo-n">Combo 0</span><span id="rush-combo-next" class="muted"></span></div><div class="rush-combo-bar" aria-hidden="true"><i id="rush-combo-fill"></i></div><div class="rush-pop" id="rush-pop" aria-hidden="true"></div></div>
      </div>
      <div class="board-wrap" id="rush-board-wrap"><div id="rush-board" class="board-host"></div></div>
      <div class="confirm-bar idle" id="rush-confirm" hidden><span class="msg" id="rush-confirm-msg"></span><button type="button" id="rush-confirm-no">Cancel</button><button type="button" class="primary" id="rush-confirm-yes">Confirm</button></div>
      <div class="rush-under">
        <p class="rush-note muted" id="rush-note"></p>
        <button type="button" id="rush-skip" class="hidden">Skip</button>
        <button type="button" id="rush-giveup" class="hidden">Give up</button>
        <span class="rush-last" id="rush-last"></span>
      </div>
      <ol class="rush-strip" id="rush-strip" aria-label="Puzzles so far"></ol>
      <p class="sr-only" id="rush-say" role="status"></p>
    </section>
    <section class="rush-end hidden" id="rush-end"></section>`;
  board = frame.lend($('#rush-board'), { onMove: (ptn) => moveIn(ptn), onDead: boardDied });
  board.ui({ disableBoard: true });
  $('#rush-skip').onclick = skip;
  $('#rush-giveup').onclick = giveUp;
  $('#rush-confirm-yes').onclick = confirmHeld;
  $('#rush-confirm-no').onclick = cancelHeld;
  // (A held move (Confirm moves) is confirmed with Confirm or Enter: taps on PTN Ninja's board stay inside its frame.)
  // Keys while a move is held, as on the puzzle page (settings.js takesHeldKey): Enter confirms and Esc cancels. Moves come
  // only from the board here: Rush has no typed moves (the owner's call; a run is played on the board).
  window.addEventListener('keydown', (e) => {
    if (!held || view.classList.contains('hidden') || (e.key !== 'Enter' && e.key !== 'Escape')) return;
    const t = e.target;
    if (!takesHeldKey({ key: e.key, field: !!t?.closest?.('input, select, textarea, [contenteditable]'),
      bar: !!t?.closest?.('#rush-confirm'), control: !!t?.closest?.('button, a') })) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Enter') confirmHeld(); else cancelHeld();
  }, { capture: true });
  // a pulse's class goes when it ends, or showing the run again (a new run) would replay it
  $('#rush-turn').addEventListener('animationend', (e) => e.currentTarget.classList.remove('flip'));
  // a miss's red drain is over once the bar is empty
  $('#rush-combo-fill').addEventListener('transitionend', (e) => e.currentTarget.classList.remove('drain'));
  window.addEventListener('online', () => { flushQueue().then(topUp); });
  // timing data (R.openMove…): the first input toward a move, the input kind, a page hidden or unfocused mid-puzzle,
  // and a run left unfinished (posted as abandoned)
  $('#rush-board').addEventListener('pointerdown', (e) => { if (!st?.cur || st.ended) return; st.inputs.add(e.pointerType === 'mouse' ? 'mouse' : 'touch'); R.touchMove(st.cur, performance.now()); }, true);
  window.addEventListener('keydown', (e) => { if (st?.cur && !st.ended && !view.classList.contains('hidden') && (e.key.length === 1 || e.key === 'Enter') && !e.target?.closest?.('input, select, textarea')) R.touchMove(st.cur, performance.now()); }, true);
  const away = () => { if (st?.cur && !st.ended) st.cur.hidden = true; };
  window.addEventListener('blur', () => setTimeout(() => frameBlur(away)));
  document.addEventListener('visibilitychange', () => { if (document.hidden) { away(); snapshot(st); } else unsnapshot(st); });
  window.addEventListener('pagehide', () => abandon(st, true));
  // Back from the back/forward cache after pagehide sent the run: it ends here, not toward a post refused as a repeat.
  window.addEventListener('pageshow', (e) => { if (e.persisted && st?.gone && !st.ended) endRun(); });
  built = true;
}

// PTN Ninja's frame took the focus (a tap on its board, or the board handing it the keyboard): the page isn't away. As on
// the puzzle page (app.js), a move waiting for Confirm keeps the keyboard: Esc cancels, Enter confirms.
function frameBlur(away) {
  if (document.activeElement !== board.iframe) return away();
  if (held) board.iframe.blur();
}
// PTN Ninja stopped answering mid-run (ninja.js _die): the run ends there, and the end screen says why. One with a move
// made goes as abandoned (abandon(): never a best, never on the leaderboard; the server takes it as it is), one without
// sends nothing; either way it isn't kept as a run of this browser's. Not paused for a reload instead: the server takes
// a run's paused time only up to its moves' own pauses plus 1 s, so a run can't honestly wait out a Retry.
function boardDied() {
  const s = st;
  if (!s || s.ended) return;
  s.boardDown = true;
  abandon(s);
  if (s.cur?.adj) stopAdj(s.cur, 'left');
  endRun();
}
// The board isn't there for a run (PTN Ninja didn't load, or stopped answering): said in Start's place, with Retry.
function boardMissing() {
  const go = $('#rush-go'), err = $('#rush-err');
  if (go) { go.disabled = false; go.textContent = 'Start'; }
  if (!err) return;
  err.classList.add('board');
  err.innerHTML = `<span>${esc(board.iframe.dataset.down === 'stopped' ? SAYS.stopped : SAYS.load)}</span><button type="button" id="rush-retry">Retry</button>`;
  $('#rush-retry').onclick = () => { err.textContent = ''; err.classList.remove('board'); board.retry(); startRun(); };
  // PTN Ninja coming up late after all (a slow load): the message goes by itself, and Start is as it was
  const g = gen;
  board.whenUp().then(() => { if (g === gen && !(st && !st.ended) && err.isConnected && err.classList.contains('board')) { err.textContent = ''; err.classList.remove('board'); } });
}

const section = (id) => { for (const s of ['rush-start', 'rush-run', 'rush-end']) $('#' + s).classList.toggle('hidden', s !== id); };

// ---------- start screen ----------
export async function enter({ frame: f = null } = {}) {
  if (!built) { frame = f; build(); }
  if (st && !st.ended) return; // (a re-render of the same page: the run goes on)
  st = null;
  renderStart();
}

async function renderStart() {
  closeLook();
  section('rush-start');
  const mode = modeChoice();
  $('#rush-start').innerHTML = `<h1 tabindex="-1">Rush</h1>
    <div class="rush-modes" role="group" aria-label="Mode">${Object.entries(MODE).map(([k, m]) =>
      `<button type="button" aria-pressed="${k === mode}" class="rush-mode${k === mode ? ' on' : ''}" data-mode="${k}"><b>${m.name}</b><span>${m.desc}</span></button>`).join('')}</div>
    <div class="rush-row">
      <button type="button" class="primary rush-go" id="rush-go">Start</button>
    </div>
    <p class="rush-err" id="rush-err" role="status"></p>
    <p class="muted rush-small">6×6, getting harder. Not rated.</p>
    <div class="rush-boards"><div><div class="panel" id="rush-best"><h2>Your best</h2><p class="muted flush">…</p></div>
    <div class="panel hidden" id="rush-recent"></div></div>
    <div class="panel" id="rush-top"><h2>Top scores</h2><p class="muted flush">…</p></div></div>`;
  for (const b of view.querySelectorAll('.rush-mode')) b.onclick = () => {
    opts.mode = b.dataset.mode; saveOpts(); renderStart();
    view.querySelector(`[data-mode="${opts.mode}"]`)?.focus(); // (the cards were redrawn: focus stays on the one pressed)
  };
  $('#rush-go').onclick = startRun;
  renderRecent();
  flushQueue().then(topUp); // (the queue first: a post is worth more than a spare)
  const g = gen;
  const [best, top] = await Promise.all([bestFor(), api(`/api/rush/top?mode=${mode}&size=${R.SIZE}`, topBody(), { quiet: true }).catch(() => null)]);
  if (g !== gen || $('#rush-best') == null || st) return;
  $('#rush-best').innerHTML = `<h2>Your best</h2>${bestTable(best?.[mode])}`;
  $('#rush-top').innerHTML = `<h2>Top scores</h2>` + (top?.top?.length
    ? `<ol class="rush-toplist">${top.top.map((t) => `<li class="${t.named ? '' : 'guest'}${t.you ? ' you' : ''}"><span>${esc(t.name)}${t.you ? ' <em>you</em>' : ''}</span><b>${t.score}</b></li>`).join('')}</ol>`
    : `<p class="muted flush">No scores yet.</p>`);
}
// A tokenless visitor's gid goes in a POST body (never the URL) so their row on the top list is marked; null: a GET.
const topBody = () => { if (token) return null; const g = store.get('gid', null); return typeof g === 'string' && /^[a-f0-9]{32}$/.test(g) ? { guest: { gid: g } } : null; };
// Best scores: the server's by token; a visitor without one has only what the last posted run's answer said (kept here).
async function bestFor() {
  if (token) { const r = await api(`/api/rush/best?size=${R.SIZE}`, null, { quiet: true }).catch(() => null); if (r?.best) return r.best; }
  const local = store.get('rushBest', {})?.[R.SIZE];
  return local && typeof local === 'object' ? local : null;
}
// ---------- offline: spare runs fetched ahead, results waiting to be sent ----------
// Spare runs (R.trimSpares: SPARE_KEEP per mode, two pages each) live in localStorage beside the recent runs: about
// 1 MB at most (R.SPARE_CHARS), well inside the ~5 MB a page gets, and read once per Start, so IndexedDB's async API
// would buy nothing here. Topped up when the start screen shows and after a run starts, while online.
let filling = false;
async function topUp() {
  if (filling || navigator.onLine === false) return;
  filling = true;
  try {
    for (const mode of ['rush', 'streak']) {
      for (let k = R.spareNeed(read(SPARE_KEY), mode, Date.now()); k > 0; k--) {
        const one = await fetchSpare(mode);
        if (!one) return; // the server isn't answering: try again next time
        write(SPARE_KEY, R.trimSpares([...read(SPARE_KEY), one], Date.now()));
      }
    }
  } catch {} finally { filling = false; }
}
async function fetchSpare(mode) {
  const q = { quiet: true };
  const a = await api(`/api/rush/run?mode=${mode}&size=${R.SIZE}`, null, q).catch(() => null);
  if (!a?.puzzles?.length) return null;
  const one = { v: 1, mode, token: a.run, pages: [{ start: a.start, ids: a.puzzles.map((p) => p.id), sig: a.sig }], puzzles: a.puzzles };
  for (let i = 1; i < R.SPARE_PAGES; i++) {
    const b = await api(`/api/rush/run?mode=${mode}&size=${R.SIZE}&run=${encodeURIComponent(a.run)}&start=${one.puzzles.length}&exclude=${one.puzzles.map((p) => p.id).join(',')}`, null, q).catch(() => null);
    if (!b?.puzzles?.length) break; // one page is still a run
    one.pages.push({ start: b.start, ids: b.puzzles.map((p) => p.id), sig: b.sig });
    one.puzzles.push(...b.puzzles);
  }
  return R.validSpare(one) ? one : null;
}
// A result the server didn't take yet (R.postOutcome 'keep') waits here; sent oldest first when the start screen shows
// and when the browser comes back online, and dropped only when the server refuses it for good (or it ages out).
let flushing = false;
const queued = () => R.queueOf(read(QUEUE_KEY), Date.now());
// who: the player it was played as (R.who); flushQueue sends it only while that is still who is signed in.
// snap: a hidden tab's snapshot (its time), which another tab's flushQueue leaves alone while fresh (R.sendable).
function enqueue(body, by, snap = false) { write(QUEUE_KEY, R.queueOf([...queued().filter((x) => x.body.run !== body.run), { t: R.tokenTime(body.run) ?? Date.now(), body, who: by, ...(snap ? { snap: Date.now() } : {}) }], Date.now())); }
const unqueue = (run) => write(QUEUE_KEY, queued().filter((x) => x.body.run !== run));
// A run left unfinished: the abandoned post, queued first so a closing tab loses nothing (a later retry of one that
// did arrive gets "already posted" and is dropped). While the tab is hidden the queue holds a snapshot, taken back
// if the player returns.
const envOf = (s) => ({ ...s.env, input: R.inputKind(s.inputs) });
const abandonedBody = (s) => {
  const b = R.abandonBody(s.run, s.cur, performance.now(), +window.TINUE_BUILD || 0, envOf(s), Date.now());
  return b && { ...b, run: s.token, pages: s.pages, ...(s.who ? {} : { guest: { gid: guestId() } }) };
};
function abandon(s, keepalive = false) {
  if (!s || s.ended || s.gone || !R.canAbandon(s.run, s.cur)) return;
  const body = abandonedBody(s);
  if (!body) return; // (a Rush timed out before finishing a puzzle: nothing to send)
  s.gone = body.abandoned ? 'left' : 'ended'; // (ended: its clock had run out, so it went as a finished run)
  enqueue(body, s.who);
  if (R.who(token) === s.who) api('/api/rush/result', body, { quiet: true, keepalive }).then((r) => { if (R.postOutcome(r) !== 'keep') unqueue(body.run); }).catch(() => {});
}
function snapshot(s) { const b = s && !s.ended && !s.gone && R.canAbandon(s.run, s.cur) && abandonedBody(s); if (b) { s.snap = true; enqueue(b, s.who, true); } }
function unsnapshot(s) { if (s?.snap && !s.gone) { s.snap = false; unqueue(s.token); } }
async function flushQueue() {
  if (flushing || navigator.onLine === false) return;
  flushing = true;
  try {
    for (const it of queued()) {
      if (!R.sendable(it, Date.now(), R.who(token), st && !st.ended ? st.token : null)) continue; // (another player's, this run, a fresh snapshot)
      let r = null, failed = false;
      try { r = await api('/api/rush/result', it.body, { quiet: true }); } catch { failed = true; }
      const out = R.postOutcome(r, failed);
      if (out === 'keep') return;
      write(QUEUE_KEY, queued().filter((x) => x.body.run !== it.body.run));
      if (out === 'sent') keepBest(r);
    }
  } catch {} finally { flushing = false; }
}
// A visitor without a token has only the bests the last post's answer named (see bestFor).
function keepBest(r) { if (r?.best && !token) { const b = store.get('rushBest', {}) || {}; b[R.SIZE] = r.best; store.set('rushBest', b); } }

// ---------- this browser's recent runs (R.recordOf; local only) ----------
const HIST_KEY = 'rushHistory';
const pastRuns = () => { try { return R.historyOf(store.get(HIST_KEY, [])); } catch { return []; } };
const when = (t, now = Date.now()) => { try { return R.whenText(t, now); } catch { return ''; } };
const pct = (a) => (a == null ? '–' : Math.round(a * 100) + '%');
function renderRecent(asking = false) {
  const el = $('#rush-recent'), list = pastRuns();
  el.classList.toggle('hidden', !list.length);
  if (!list.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<h2>Recent runs</h2><ol class="rush-recent">${list.map((r, i) => `<li><button type="button" class="rush-recent-row" data-i="${i}" aria-label="${esc(R.recentLabel(r, when(r.t)))}">
    <span class="muted">${esc(when(r.t))}</span><span>${MODE[r.mode].name}</span><b>${r.score}</b><span class="muted">${r.mode === 'rush' ? pct(r.sum.accuracy) : ''}</span></button></li>`).join('')}</ol>
    <p class="rush-clear flush">${asking ? 'Clear all recent runs? <button type="button" class="link" id="rush-clear-yes">Clear</button> <button type="button" class="link" id="rush-clear-no">Keep</button>'
      : '<button type="button" class="link" id="rush-clear">Clear history</button>'}</p>`;
  for (const b of el.querySelectorAll('.rush-recent-row')) b.onclick = () => { const r = list[+b.dataset.i]; if (r) showEnd(r, null, +b.dataset.i); };
  if (asking) {
    $('#rush-clear-yes').onclick = () => { store.del(HIST_KEY); renderRecent(); };
    $('#rush-clear-no').onclick = () => { renderRecent(); $('#rush-clear')?.focus(); };
    $('#rush-clear-no').focus();
  } else $('#rush-clear').onclick = () => renderRecent(true);
}
function saveRun(rec) {
  if (!rec.puzzles.length) return; // nothing was played (an empty pool)
  try { store.set(HIST_KEY, R.addRun(store.get(HIST_KEY, []), rec)); } catch {}
}

const bestTable = (b) => (b?.today == null && b?.week == null && b?.all == null ? '<p class="muted flush">No runs yet.</p>' : `<dl class="rush-best">${[['today', 'Today'], ['week', 'This week'], ['all', 'All time']].map(([k, l]) =>
  `<div><dt>${l}</dt><dd>${b?.[k] ?? '–'}</dd></div>`).join('')}</dl>`);

// ---------- the run ----------
async function startRun() {
  const mode = modeChoice(), g = ++gen, go = $('#rush-go');
  if (go) { go.disabled = true; go.textContent = !board.frameUp ? 'Loading board…' : 'Loading…'; }
  // Start waits for the board (PTN Ninja up and answering: ninja.js MS.up at most), so the clock never starts without it
  const up = board.frameReady();
  if ($('#rush-err')) { $('#rush-err').textContent = ''; $('#rush-err').classList.remove('board'); }
  // A spare run kept in this browser starts at once, with or without a connection; else one is fetched. (A spare is
  // taken out of storage only once the board is there.)
  let got = null, rest = null;
  try { const t = R.takeSpare(read(SPARE_KEY), mode, Date.now()); if (t.spare) { got = t.spare; rest = t.rest; } } catch {}
  if (!got) {
    let r;
    try { r = await api(`/api/rush/run?mode=${mode}&size=${R.SIZE}`); } catch { r = null; }
    if (g !== gen) return;
    if (!r?.puzzles?.length) {
      if (go) { go.disabled = false; go.textContent = 'Start'; }
      if ($('#rush-err')) $('#rush-err').textContent = 'Couldn’t load puzzles. Try again.';
      return;
    }
    got = { puzzles: r.puzzles, token: r.run, pages: [{ start: r.start, ids: r.puzzles.map((p) => p.id), sig: r.sig }] };
  }
  const ok = await up;
  if (g !== gen) return;
  if (!ok) return boardMissing();
  if (rest) write(SPARE_KEY, rest);
  abandon(st); // a run left for a new one
  if (st?.cur?.adj) stopAdj(st.cur, 'left');
  st = { who: R.who(token), run: R.newRun(mode), puzzles: got.puzzles.map(turned), idx: -1, cur: null, more: null, timer: null, ended: false, g, inputs: new Set(),
    env: { confirm: confirmOn(store.get('prefs', {})), calm: calm(), width: R.widthClass(innerWidth) },
    token: got.token, pages: [...got.pages] };
  section('rush-run');
  const runEl = $('#rush-run');
  runEl.tabIndex = -1; runEl.focus({ preventScroll: true }); // (Start is hidden now: focus would fall to the body)
  $('#rush-board-wrap').classList.remove('rush-over');
  $('#rush-clock').classList.remove('gain', 'loss', 'low'); $('#rush-clock-t').textContent = R.clockText(R.RUSH_MS);
  clearTimeout(popT); $('#rush-pop').className = 'rush-pop';
  comboHold = false; clearTimeout(comboT); $('#rush-combo-fill').classList.remove('drain');
  sayNext = null; $('#rush-say').textContent = '';
  $('#rush-strip').innerHTML = '';
  showLast(null);
  $('#rush-score-label').textContent = mode === 'rush' ? 'solved' : 'streak';
  $('#rush-clock').classList.toggle('hidden', mode !== 'rush');
  $('#rush-combo').classList.toggle('hidden', mode !== 'rush');
  $('#rush-skip').classList.toggle('hidden', mode !== 'streak');
  $('#rush-skip').disabled = false; $('#rush-skip').textContent = 'Skip';
  $('#rush-confirm').hidden = !confirmOn(store.get('prefs', {}));
  if (mode === 'rush') st.timer = setInterval(tick, 100);
  board.giveBack(); board.borrow(R.SIZE); // (the frame over the board now shown)
  nextPuzzle();
  morePuzzles();
  topUp(); // the spare just used, or the first, is replaced in the background
}

// Each puzzle of a run is shown under one of the board's 8 symmetries, picked here at random (shared/sym.js), so a
// remembered picture doesn't give the answer away. The run works in that orientation throughout (the board, the
// judging, the check and the defender all see the turned position); only what is posted is turned back (resultBody).
const turned = (p) => SYM.orient(p, SYM.pick());

function morePuzzles() {
  if (!st || st.ended || st.more || (st.puzzles.length >= NEED && st.puzzles.length - st.idx > MORE_AT)) return;
  const s = st, ids = s.puzzles.map((p) => p.id).join(',');
  s.more = api(`/api/rush/run?mode=${s.run.mode}&size=${R.SIZE}&run=${encodeURIComponent(s.token)}&start=${s.puzzles.length}&exclude=${ids}`, null, { quiet: true })
    .then((r) => {
      if (st !== s || !r?.puzzles) return;
      s.pages.push({ start: r.start, ids: r.puzzles.map((p) => p.id), sig: r.sig });
      const fresh = r.puzzles.filter((p) => !s.puzzles.some((q) => q.id === p.id)).map(turned);
      s.puzzles.push(...fresh);
      if (fresh.length) s.chain = true; // (the pool still had some: keep filling to NEED)
    })
    .catch(() => {}).finally(() => { if (st !== s) return; s.more = null; if (s.chain) { s.chain = false; morePuzzles(); } });
}

async function nextPuzzle() {
  const s = st;
  dropHeld();
  s.idx++;
  if (st !== s || s.ended) return;
  if (s.idx >= s.puzzles.length) return endRun(); // nothing left to play (a small pool)
  morePuzzles();
  const p = s.puzzles[s.idx], solver = R.startGame(p).toMove;
  showTurn(R.turn(solver, s.cur?.solver));
  const born = performance.now(), c = s.cur = { p, line: [], born, ready: born + LOCK_MS, solver }; // ready: input opens
  board.forget(); // nothing begun on the last puzzle (stones in hand, a touch) carries over
  board.lock(c.ready);
  const from = R.boardFrom(p), intro = from.moves.length > 0;
  if (intro) await board.ui({ disableBoard: true });
  await board.load(buildPTN({ size: p.size, komi: p.komi || 0, tps: from.tps }));
  await board.last();
  await board.setPlayer(solver);
  if (intro) {
    c.opening = true; // restore() waits: the intro puts the last move on the board itself
    const slow = !calm();
    if (slow) { c.ready = Math.max(c.ready, performance.now() + INTRO_MS); board.lock(c.ready); }
    render();
    if (slow) await new Promise((r) => setTimeout(r, INTRO_WAIT));
    if (st !== s || s.cur !== c || s.ended) return;
    await board.append(p.last); // the board tints the move that led to the position, as on the puzzle page
    await board.last();
    c.opening = false;
  }
  await board.ui({ disableBoard: false, showRoads: false, dropOnStray: false });
  R.openMove(c, Math.max(performance.now(), c.ready)); // the first move's clock opens when the board takes input
  render();
}

// The board shows exactly the moves accepted so far (after a refused or cancelled move).
async function restore() {
  const c = st?.cur;
  if (!c || c.opening) return;
  if (c.reply) { c.reply = null; c.ready = performance.now(); board.lock(c.ready); R.openMove(c, c.ready); } // (a reply still due is in c.line: drawn below)
  const a = c.adj; // (a move being adjudicated stays on the board, and a play-out's game with it)
  const from = R.boardFrom(c.p, a ? [...c.line, ...(a.po ? a.po.line : [a.canon])] : c.line);
  await board.load(buildPTN({ size: c.p.size, komi: c.p.komi || 0, tps: from.tps, moves: from.moves }));
  await board.last();
  await board.ui({ disableBoard: !!st.ended || (!!a && !a.turn) });
}

// ---------- Confirm moves (the puzzle page's setting) ----------
let held = null; // { ptn, cur }
function moveIn(ptn) {
  if (!st || st.ended || !st.cur) return;
  if (!confirmOn(store.get('prefs', {})) || performance.now() < st.cur.ready) return play(ptn);
  held = { ptn, cur: st.cur };
  R.holdMove(st.cur, performance.now());
  board.ui({ disableBoard: true });
  $('#rush-confirm').classList.remove('idle');
  $('#rush-board-wrap').classList.add('pending');
  $('#rush-confirm-msg').innerHTML = `Confirm <b>${esc(ptn)}</b>?`;
}
function dropHeld() {
  held = null;
  $('#rush-confirm')?.classList.add('idle');
  $('#rush-board-wrap')?.classList.remove('pending');
  if ($('#rush-confirm-msg')) $('#rush-confirm-msg').textContent = '';
}
function confirmHeld() {
  const h = held;
  dropHeld();
  if (!h || !st || st.cur !== h.cur) return;
  board.ui({ disableBoard: false });
  play(h.ptn); // timed now, as an unconfirmed move would be
}
function cancelHeld() { const h = held; dropHeld(); if (h && st?.cur === h.cur) restore(); }

// ---------- moves ----------
// The reply to a correct mid-line move follows REPLY_MS later, so the move lands first; input is shut until the reply is
// on the board and opens that moment (the clock runs meanwhile: the beat is kept short). With reduced motion: at once.
const REPLY_MS = 80;
function play(ptn) {
  const s = st, now = performance.now();
  if (!s || s.ended || !s.cur) return;
  if (R.expired(s.run, now)) return endRun(); // the clock ran out before this move: it doesn't count
  if (!R.takesMove(s.cur, now)) return restore(); // a tap meant for the last puzzle, made during the intro, or during a pause
  if (s.cur.adj) return playOutMove(s, s.cur, ptn, now); // a move in a play-out
  const c = s.cur, v = R.judge(c.p, c.line, ptn);
  if (v.kind === 'illegal') return restore();
  R.startClock(s.run, now); // the clock starts with the first move
  if (s.head) { s.head = null; render(); } // (the last play-out's ending, shown until this move)
  if (v.kind === 'off') return adjudicate(s, c, v.canon, now);
  R.closeMove(c, now, R.weight(v.canon), v.kind !== 'wrong', v.canon);
  if (v.kind === 'wrong') {
    R.wrong(s.run, now);
    R.stampMove(c, s.run, now);
    if (s.run.mode === 'rush') { comboHold = false; clearTimeout(comboT); $('#rush-combo-fill').classList.add('drain'); }
    flash('−10s', 'bad', s.run.mode === 'rush');
    done(false, now, v.canon);
    return;
  }
  const bonus = R.correct(s.run, R.weight(v.canon)); // a spread counts each square it drops on
  R.stampMove(c, s.run, now);
  $('#rush-combo-fill').classList.remove('drain');
  if (bonus) {
    c.gained = (c.gained || 0) + bonus;
    flash(`+${bonus / 1000}s`, 'good', true);
    fillCombo(s);
  }
  if (v.kind === 'solved') return done(true, now);
  // In the tree: the reply follows a beat later (REPLY_MS); the line has it at once, so a restore() draws it too.
  c.line.push(v.canon, v.reply);
  if (calm()) reply(c, v.reply);
  else {
    const p = c.reply = v.reply;
    c.ready = Infinity; board.lock(Infinity); // (until the reply is on the board)
    setTimeout(() => { if (st === s && s.cur === c && c.reply === p) reply(c, p); }, REPLY_MS);
  }
  render();
}
// The reply goes on the board and input opens: the board's, and the next move's clock (R.openMove).
function reply(c, ptn) {
  const t = performance.now();
  c.reply = null; c.ready = t; board.lock(t);
  sound.holdMoves(sound.tail()); // its sound after the move's own (a smash built by hand slaps ~200 ms in), the board at once
  board.append(ptn).then(() => board.last());
  R.openMove(c, t);
}
// ---------- a move off the line, adjudicated as the puzzle page does (app.js userMove, startPlayOn, defenderTurn,
// playOnMove, makeProven, endPlayOn; the rules are playon.js's and shared/judge.js's, the engines engine.js's and
// defend.js's) ----------
// Rush's part is only the driver: its own state (c.adj), its clock, its screen. The clock is paused from the move until
// the player is to move again (the check, the defender thinking, an engine loading, a wait at the move limit), each
// wait bounded by the puzzle page's own limits; nothing else pauses it, and the board takes no move meanwhile
// (R.takesMove). c.adj: { canon, m (its timing row), at (when it was made), phase: 'check' | 'play' | 'wait', chk,
// po (the play-out, playon.js playOutOf), turn (the player's move in the play-out), final, look }.
const komiOf = (p) => p.komi || 0;
const adjLive = (s, c, a) => st === s && s.cur === c && c.adj === a && !s.ended;
// The pause up to now goes to the move's row (and to its play-out's, once one is going); the clock runs again. No more
// is credited than the move's bound (R.pauseMax: a page frozen past it has the rest charged to the clock), so a
// defender's reply recorded in this pause is held to what was credited. False when the clock ran out that way: the
// caller ends the run (the move stays open, as any move the clock beat).
function unpause(s, c, a, now) {
  const d = R.resume(s.run, now, R.pauseMax(a.m, !!c.hidden) - (a.m.paused || 0));
  a.m.paused = (a.m.paused || 0) + d;
  if (a.m.po && a.phase === 'play') a.m.po.paused += d;
  if (a.reply) { a.reply.ms = Math.min(a.reply.ms, d); a.reply = null; }
  return !R.expired(s.run, now);
}
function hold(s, c, now) { // the engine's turn: the clock stops and the board takes nothing
  R.pause(s.run, now);
  c.ready = Infinity; board.lock(Infinity); board.ui({ disableBoard: true });
}
// The turn line's text: the card's heading (and, in a play-out, its status line), as the puzzle page words them.
const adjText = (a) => R.adjHead(a, a.po && defenderName(a.po));
// The check's final answer, kept on the move while it is open (R.finalAnswer).
const noteFinal = (c, a, v) => R.finalAnswer(a.m, v, performance.now() - a.t0, !!c.hidden);

async function adjudicate(s, c, canon, now) {
  const p = c.p, plies = [...c.line, canon], node = R.nodeAt(p, c.line);
  // A listed alternative is a known win, no check needed (app.js slowerWins); a 'win' node lists none.
  const alt = node !== 'win' && slowerWinsAt(p, c.line).includes(canon);
  // (open until decided: R.decide; posted with the position it was judged in, and 'checking' until the check answers)
  const a = c.adj = { canon, m: R.openAdj(c, now, R.weight(canon), canon, alt), at: now, phase: 'check', turn: false };
  hold(s, c, now);
  const def = defender(p.size, komiOf(p), tiltak.supports);
  let quick = null;
  if (!alt) {
    render(); say(R.cardHead('checking', { move: canon }));
    // the puzzle page's first check, with its budgets (2.5 s quick; it runs on up to 60 s for a play-out or a wait)
    a.t0 = performance.now();
    a.chk = engine.checkStill({ size: p.size, komi: komiOf(p), tps: p.tps, plies, attacker: c.solver });
    quick = await a.chk.quick;
    if (!adjLive(s, c, a)) return a.chk.cancel();
    R.checked(a.m, quick, performance.now() - a.t0, !!c.hidden); // ('unknown' as it came: the worker failed)
  }
  const way = R.route({ alt, quick, def });
  if (way === 'mistake' || way === 'solved') { a.chk?.cancel(); return settle(s, c, way); }
  if (way === 'wait') return waitFinal(s, c);
  startPlayOut(s, c, way === 'proven');
}
// No engine to play it out against (or none answered an unproven game): the check's final answer decides (settleCheck),
// within its own 60 s.
async function waitFinal(s, c) {
  const a = c.adj;
  a.phase = 'wait'; render(); say(R.cardHead('wait', { move: a.canon }));
  const v = await a.chk.final;
  if (!adjLive(s, c, a)) return;
  noteFinal(c, a, v);
  settle(s, c, R.finalOutcome(v));
}

function startPlayOut(s, c, proven) {
  const a = c.adj, p = c.p, now = performance.now();
  if (!unpause(s, c, a, now)) return endRun();
  R.pause(s.run, now); // (the play-out's own pauses are counted from here)
  const po = a.po = playOutOf({ miss: a.canon, at: c.line.length, base: [...c.line], g: R.startGame(p, [...c.line, a.canon]), proven,
    left: pliesLeftOf(R.nodeAt(p, c.line)), key: a.canon, engine: defender(p.size, komiOf(p), tiltak.supports) });
  a.phase = 'play';
  a.m.po = { proven, cap: po.cap, end: null, paused: 0, line: [] }; // what is posted of it (R.resultBody)
  if (proven) proofLength(s, c, po, a.chk?.info?.plies); // (a listed alternative's length is measured, as on the puzzle page)
  else a.chk.final.then((v) => { if (!adjLive(s, c, a)) return; noteFinal(c, a, v); if (!po.end) { if (v === 'wins') lateProof(s, c, po); else a.final = v; } }); // the game decides
  warmDefender(po, p.size, komiOf(p));
  po.t0 = performance.now(); setTimeout(() => { if (adjLive(s, c, a)) render(); }, BUSY_MS.giveup + 100); // Give up wakes
  render(); say(R.cardHead('play', { proven }));
  defenderTurn(s, c, po);
}
// app.js setProofLength: the cap rises to cover the proof (playon.js applyProofLength); a length not known is measured
// in the engine worker (playon.js measureProof).
function proofLength(s, c, po, plies) {
  const a = c.adj;
  if (applyProofLength(po, plies)) { a.m.po.cap = po.cap; return render(); }
  if (plies === null) return;
  measureProof(po, () => engine.proofLength({ size: c.p.size, komi: komiOf(c.p), tps: c.p.tps, plies: [...po.base, po.miss], attacker: c.solver, budget: 1e5 }), (r) => {
    if (r && Number.isFinite(r.plies) && adjLive(s, c, a) && !po.end) proofLength(s, c, po, r.plies);
  });
}
// app.js makeProven: a proof mid-game makes it a proven play-out against Syntaks, or a solve now against Tiltak
// (playon.js upgradeToProven).
function lateProof(s, c, po) {
  const a = c.adj;
  if (po.proven || po.end) return;
  if (!upgradeToProven(po)) return endPlayOut(s, c, 'proved');
  a.final = 'wins'; a.m.po.proven = true;
  proofLength(s, c, po, a.chk.info?.plies);
  render(); say(R.cardHead('play', { proven: true, late: true }));
}
// app.js defenderTurn, with the clock paused for it.
async function defenderTurn(s, c, po) {
  const a = c.adj, live = () => adjLive(s, c, a) && !po.end;
  po.thinking = true; po.thinkingSince = performance.now(); a.turn = false;
  hold(s, c, po.thinkingSince);
  render();
  const t0 = performance.now();
  const d = await defenderMove(po, { size: c.p.size, komi: komiOf(c.p), tps: po.g.toTPS(), live, onFallback: render });
  if (!d) return;
  if (d.end === 'proved') { po.thinking = false; return endPlayOut(s, c, 'proved'); }
  if (d.end) return endPlayOut(s, c, 'noengine');
  po.thinking = false;
  po.g.play(d.mv); po.line.push(d.mv);
  // (its time is held to the reply's bound here, and to the pause credited for it in unpause)
  a.m.po.line.push(a.reply = { m: d.mv, ms: Math.min(performance.now() - t0, R.PAUSE_MS.reply + (c.hidden ? R.PAUSE_MS.hidden : 0)) });
  await board.append(d.mv); await board.last();
  if (!live()) return;
  const end = ending(po.g.result(), c.solver);
  if (end) return endPlayOut(s, c, end);
  // the player's turn: the clock runs again, and the board takes their move
  const t = performance.now();
  if (!unpause(s, c, a, t)) return endRun();
  a.turn = true; a.mvT0 = c.ready = t; board.lock(t);
  await board.setPlayer(c.solver);
  await board.ui({ disableBoard: false, showRoads: false, dropOnStray: false });
  render();
}
// app.js playOnMove: the player's move in the game, then the defender's, or a wait at the move limit for what could
// raise it (capWait: the proof's length, or the proof), or the end.
async function playOutMove(s, c, ptn, now) {
  const a = c.adj, po = a.po;
  if (!po || po.end || po.thinking || !a.turn) return restore();
  const canon = legalMove(po.g, ptn);
  if (!canon) return restore();
  po.g.play(canon); po.line.push(canon); po.mine++;
  a.m.po.line.push({ m: canon, ms: now - a.mvT0 });
  a.turn = false;
  const end = ending(po.g.result(), c.solver);
  if (end) return endPlayOut(s, c, end);
  hold(s, c, now);
  if (po.mine >= po.cap) {
    const why = capWait(po, { lengthPending: !!po.lengthP, checkLive: !!a.chk && !po.proven && a.final === undefined });
    if (why) {
      po.waiting = why; render();
      await waitAtCap(po, why, a.chk.final); // (defend.js, as the puzzle page waits; lateProof runs first)
      if (!adjLive(s, c, a) || po.end) return;
      po.waiting = null;
    }
    if (po.mine >= po.cap) return endPlayOut(s, c, 'out');
  }
  defenderTurn(s, c, po);
}
// Give up (the puzzle page's button and word): a mistake. Not in the play-out's first 1.5 s (busy.js giveup).
function giveUp() {
  const s = st, c = s?.cur, po = c?.adj?.po;
  if (!po || po.end || s.ended || busy('giveup', po.t0)) return;
  endPlayOut(s, c, 'gaveup');
}
// app.js endPlayOn: the game is over; how it counts is R.playOutOutcome.
function endPlayOut(s, c, kind) {
  const a = c.adj, po = a.po;
  if (!po || po.end) return;
  po.end = kind; po.thinking = false; po.waiting = null; po.ctl?.abort();
  a.m.po.end = kind; a.m.po.cap = po.cap;
  a.look = R.playOutLook(po, defenderName(po));
  const out = R.playOutOutcome(kind, po.proven);
  if (out === 'wait') return waitFinal(s, c); // (no engine moved in an unproven game: the check decides)
  a.chk?.cancel();
  settle(s, c, out);
}
// Rush's own end of a move's adjudication: the pause ends, the move counts one way or the other. A solve counts as one
// correct move, earning the combo the puzzle's own line had left from there (R.lineCredit: its credit, posted beside the
// move's own weight; the game's moves add nothing more); anything else is a mistake, as today.
function settle(s, c, out) {
  const a = c.adj, now = performance.now();
  if (!unpause(s, c, a, now)) return endRun(); // (the clock ran out over a frozen page's pause: the move stays open)
  c.adj = null;
  R.decide(c, out === 'solved');
  if (out === 'solved') {
    const credit = R.lineCredit(c.p, a.m.path);
    if (credit != null) a.m.credit = credit;
    const bonus = R.correct(s.run, credit ?? a.m.weight);
    R.stampMove(c, s.run, now, a.at);
    $('#rush-combo-fill').classList.remove('drain');
    if (bonus) { c.gained = (c.gained || 0) + bonus; flash(`+${bonus / 1000}s`, 'good', true); fillCombo(s); }
    return done(true, now, null, a);
  }
  R.wrong(s.run, now);
  R.stampMove(c, s.run, now, a.at);
  if (s.run.mode === 'rush') { comboHold = false; clearTimeout(comboT); $('#rush-combo-fill').classList.add('drain'); }
  flash('−10s', 'bad', s.run.mode === 'rush');
  done(false, now, a.canon, a);
}
// The run ends or is left mid-adjudication: the engines stop, the move stays open (posted as such, the puzzle
// unfinished). kind: 'time' (the clock ran out on the player's turn) or 'left'.
function stopAdj(c, kind) {
  const a = c.adj;
  a.chk?.cancel();
  if (a.po && !a.po.end) { a.po.end = kind; a.po.thinking = false; a.po.ctl?.abort(); a.m.po.end = kind; a.look = R.playOutLook(a.po, defenderName(a.po)); }
}

// A bonus fills the bar for COMBO_HOLD_MS, then it snaps to what the next bonus needs (render() leaves it meanwhile).
const COMBO_HOLD_MS = 300;
let comboHold = false, comboT = 0;
function fillCombo(s) {
  const fill = $('#rush-combo-fill');
  comboHold = true; fill.style.width = '100%';
  clearTimeout(comboT);
  comboT = setTimeout(() => {
    comboHold = false;
    if (st !== s) return;
    fill.style.transition = 'none';
    fill.style.width = `${Math.round(R.nextBonus(s.run.combo).frac * 100)}%`;
    void fill.offsetWidth;
    fill.style.transition = '';
  }, COMBO_HOLD_MS);
}

// a: the adjudication that decided it (a move off the line): the move, and its play-out's ending when there was one.
function done(solved, now, wrong = null, a = null) {
  const s = st, c = s.cur;
  R.finish(s.run, { id: c.p.id, rating: c.p.rating, solved, ms: now - c.born, mv: c.moves || [], hidden: !!c.hidden, sym: c.p.sym ?? 0, ...(wrong ? { wrong, at: c.line.slice() } : {}),
    ...(a ? { played: a.canon, at: c.line.slice(), ...(a.look ? { po: a.look } : {}) } : {}),
    ...(s.run.mode === 'rush' ? { clock: R.timeLeft(s.run, now), combo: s.run.combo } : {}) });
  // a beat after the move's own sounds (after a smash's slap: sound.verdict), and before the next puzzle's intro move,
  // whose sound waits until the verdict has played (rushGood is 55 ms long; wrong's second knock ends ~130 ms in).
  // Before mark(), whose clock may cross ten seconds here (a miss's penalty): the warning then waits for wrongAt.
  if (solved) s.goodAt = performance.now() + sound.verdict('rushGood', 45, 55); else s.wrongAt = performance.now() + sound.verdict('wrong', 80, 130);
  mark(solved, c.gained || 0, a);
  if (s.run.over) return endRun(wrong, !!a?.po);
  nextPuzzle();
}

function skip() {
  const s = st;
  if (!s || s.ended || s.run.mode !== 'streak' || s.run.skipUsed || !s.cur || s.cur.adj) return; // (not mid-adjudication)
  s.run.skipUsed = true;
  R.finish(s.run, { id: s.cur.p.id, rating: s.cur.p.rating, solved: false, skipped: true, sym: s.cur.p.sym ?? 0, ms: performance.now() - s.cur.born, mv: s.cur.moves || [], hidden: !!s.cur.hidden });
  mark(null);
  $('#rush-skip').disabled = true; $('#rush-skip').textContent = 'Skip used';
  nextPuzzle();
}

function tick() {
  if (!st || st.ended) return;
  if (R.expired(st.run, performance.now())) return endRun();
  renderClock();
}

// ---------- drawing ----------
// Screen readers hear one message per puzzle (R.sayText), in one status region: cleared, then set a frame later, so the
// same words twice are still read twice.
function say(t) {
  const el = $('#rush-say');
  if (!el) return;
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = t; });
}
let sayNext = null; // the result just marked, said with the next puzzle's colour to move (nextPuzzle) or the end (endRun)
function renderClock() {
  const left = R.timeLeft(st.run, performance.now()), el = $('#rush-clock');
  // (written only when it changes: this runs 10 times a second, and writing the same text still costs a layout, a
  // paint and a frame each time; that was about 3 s of CPU a minute on an untouched run)
  const t = R.clockText(left), ct = $('#rush-clock-t');
  if (ct.textContent !== t) ct.textContent = t;
  const low = st.run.startedAt != null && left < 20e3;
  el.classList.toggle('low', low);
  if (low && !st.saidLow) { st.saidLow = true; say('20 seconds left'); }
  // Ten seconds left: one tick-tock as the clock crosses 10 s (again only if a bonus lifts it back over and it crosses
  // again), not while paused or over, and not on top of a wrong move's sound.
  if (left > 10e3) st.lowArmed = true;
  else if (st.lowArmed && left > 0 && st.run.startedAt != null && st.run.pausedAt == null && !st.ended) {
    st.lowArmed = false;
    sound.later('lowTime', Math.max(0, (st.wrongAt ?? -1e9) + 250 - performance.now()));
  }
}
function render() {
  const s = st;
  if (!s) return;
  $('#rush-score').textContent = s.run.score;
  if (s.run.mode === 'rush') {
    renderClock();
    const nb = R.nextBonus(s.run.combo);
    $('#rush-combo-n').textContent = `Combo ${s.run.combo}`;
    $('#rush-combo-next').textContent = `+${nb.ms / 1000}s at ${nb.at}`;
    if (!comboHold) $('#rush-combo-fill').style.width = `${Math.round(nb.frac * 100)}%`;
  }
  // the text the stone and ring say, for screen readers and as a small second line; while a move is adjudicated, the
  // puzzle page's card heading and status in its place (adjText)
  const toMove = s.cur ? R.turn(s.cur.solver).text : '', note = $('#rush-note');
  const a = s.cur?.adj;
  note.textContent = R.noteText({ toMove, head: s.head, adj: a ? adjText(a) : null, waiting: s.run.startedAt == null && s.run.mode === 'rush' });
  note.title = a?.po ? a.po.capNote : '';
  $('#rush-clock').classList.toggle('paused', s.run.pausedAt != null);
  const gb = $('#rush-giveup'), po = a?.po;
  gb.classList.toggle('hidden', !po);
  gb.disabled = !po || !!po.end || busy('giveup', po.t0); // (its first 1.5 s: a tap aimed at the board, as on the puzzle page)
  if (s.run.mode === 'streak') $('#rush-skip').disabled = s.run.skipUsed || !!a;
}
// The colour to move, first thing in the bar above the board: the stone on a board square, swelling once on a change.
// No words beside it (Sasha, 2026-11-21: "Let's not say which side to play in the bar"): the board's green to-move trim
// on the flat-count bar says it too, and the line under the board names the side in words first (a colour-blind
// player, or one who doesn't trust a shade, reads it there). Screen readers get it from that line and say(), so the
// bar stays hidden from them.
function showTurn(t) {
  const el = $('#rush-turn');
  el.classList.remove('white', 'black', 'flip');
  el.classList.add(t.color);
  if (t.changed) { void el.offsetWidth; el.classList.add('flip'); } // (a reflow restarts the animation)
  if (sayNext) { say(R.sayText({ ...sayNext, next: t.text })); sayNext = null; } // (the side to move first, as on screen)
}
// The puzzle just finished and its rating, until the next one finishes (Storm's corner). It pops in only when a new
// result arrives, so two close ratings in a row still read as two results.
function showLast(r) {
  const v = R.lastText(r), el = $('#rush-last');
  el.className = 'rush-last' + (v ? ' ' + v.cls : '');
  el.innerHTML = v ? `<span class="sr-only">${esc(v.label)}</span><span aria-hidden="true">${esc(v.text)}</span>` : '';
  if (v) { void el.offsetWidth; el.classList.add('in'); }
}
function mark(solved, gained = 0, a = null) {
  const r = st.run.results.at(-1);
  showLast(r);
  // a play-out's ending, in the puzzle page's words: on the turn line until the next move, and said with the result
  st.head = a?.look ? R.endingHead(a.look, a.canon) : null;
  sayNext = { r, mode: st.run.mode, bonus: gained, head: st.head };
  const li = document.createElement('li');
  li.className = solved == null ? 'skip' : solved ? 'good' : 'bad';
  li.setAttribute('aria-label', solved == null ? 'skipped' : solved ? 'solved' : 'failed');
  li.innerHTML = `<span aria-hidden="true">${solved == null ? '–' : solved ? '✓' : '✗'}</span>`;
  $('#rush-strip').append(li);
  render();
}
// +3s / −10s over the combo row for POP_MS, with the clock's digits tinted for the same moment (the number that changed).
const POP_MS = 900;
let popT = 0;
function flash(text, cls, show) {
  if (!show) return;
  const el = $('#rush-pop'), clock = $('#rush-clock');
  el.textContent = text; el.className = 'rush-pop on ' + cls;
  clock.classList.remove('gain', 'loss'); clock.classList.add(cls === 'good' ? 'gain' : 'loss');
  clearTimeout(popT); popT = setTimeout(() => { el.className = 'rush-pop'; clock.classList.remove('gain', 'loss'); }, POP_MS);
}

// ---------- the end ----------
const sec = (ms) => (ms == null ? '–' : ms >= 60e3 ? R.clockText(ms) : (ms / 1000).toFixed(1) + 's');
// The board stays for END_BEAT_MS before the end screen, dimmed (a Streak's losing move on it): the moment is
// seen, and a tap already on its way doesn't land on Play again. A pause, not motion: kept under reduced motion.
const END_BEAT_MS = 500;
async function endRun(wrong = null, played = false) {
  const s = st;
  if (!s || s.ended) return;
  if (s.cur?.adj) stopAdj(s.cur, 'time'); // (the clock ran out on the player's turn in a play-out: unfinished)
  s.ended = true;
  R.end(s.run, performance.now());
  clearInterval(s.timer);
  dropHeld();
  board.ui({ disableBoard: true });
  const mode = s.run.mode;
  say(R.sayText({ ...(sayNext || {}), mode, over: true })); sayNext = null;
  if (mode === 'rush') $('#rush-clock-t').textContent = '0:00';
  const wrap = $('#rush-board-wrap');
  wrap.classList.add('rush-over');
  board.dim(true); // (the frame is over the board, not in its wrap)
  // (the board drew the move as it was made: it is appended only if it isn't already the last one there)
  if (s.cur) s.cur.reply = null; // (a reply still due stays off the board)
  if (wrong && mode === 'streak') {
    // (a play-out's game is already on the board, its last move not this one)
    if (!played) (board.snaps?.at(-1)?.ptn === wrong ? board.last() : board.append(wrong).then(() => board.last())).catch?.(() => {});
  }
  R.closeOpen(s.run, s.cur); // (a Rush out of time keeps the puzzle on the board, as unfinished)
  const rec = R.recordOf(s.run, s.puzzles, Date.now());
  // The run's end: now (the clock ran out, the pool ran dry), or after the beat when a streak's miss ended it, so it
  // doesn't land on the wrong sound; a clock emptied by a wrong move's 10 s waits for that sound to finish too.
  if (!wrong && !s.gone && !s.boardDown) sound.later('rushEnd', Math.max(0, (s.wrongAt ?? -1e9) + 250 - performance.now(), (s.goodAt ?? -1e9) + 80 - performance.now()));
  await new Promise((r) => setTimeout(r, END_BEAT_MS));
  if (wrong && !s.gone && st === s) sound.play('rushEnd');
  if (s.gone !== 'left' && !s.boardDown) saveRun(rec); // kept whether or not the post below succeeds (a run left unfinished isn't one)
  if (st === s) board.giveBack();
  if (st === s) showEnd(rec, s);
  if (s.boardDown) return showBest(null, null, s, 'board'); // (sent as abandoned already, or nothing to send)
  if (s.gone) return showBest(null, null, s, s.gone === 'left' ? 'left' : null); // already sent (pagehide)
  // Posted here when the run ended by itself (the clock, or a streak's miss); one left unfinished is posted as abandoned
  // (abandon(): leave(), a new run, pagehide), never a best.
  if (s.snap) unqueue(s.token); // (a hidden tab's snapshot: the run ended after all)
  if (!s.run.results.length) return showBest(null, null, s);
  const body = { ...R.resultBody(s.run, +window.TINUE_BUILD || 0, envOf(s)), playedAt: R.playedAtOf(s.run.endedAt, performance.now(), Date.now()), run: s.token, pages: s.pages, ...(s.who ? {} : { guest: { gid: guestId() } }) };
  let r = null, failed = R.who(token) !== s.who; // signed in or out since it started: held for the player who played it
  if (!failed) try { r = await api('/api/rush/result', body, { quiet: true }); } catch { failed = true; }
  const out = R.postOutcome(r, failed);
  if (out === 'keep') enqueue(body, s.who); else keepBest(r);
  showBest(r, mode, s, out);
}
// The end screen for a run: s, the run just played (Play again, its best and the post's answer to come), or null for
// one from the recent runs (when it was played, Back only; at, its row there, which Back gives the focus to).
function showEnd(rec, s, at = null) {
  const sum = rec.sum, mode = rec.mode, played = R.timePlayed(rec); // (the engine's pauses aren't the player's)
  section('rush-end');
  paintTheme(); // (before the pictures go in: drawn in the player's theme from the start, when it is known)
  const stats = mode === 'rush'
    ? [['Moves', sum.moves], ['Accuracy', pct(sum.accuracy)], ['Best combo', sum.bestCombo],
      ['Time played', sec(played)], ['Per move', sec(sum.perMove)], ['Hardest solved', sum.highest ?? '–']]
    : [['Hardest solved', sum.highest ?? '–'], ['Time played', sec(played)]];
  const hint = window.matchMedia?.('(hover: hover)').matches ? 'Click a puzzle to see it larger.' : 'Tap a puzzle to see it larger.';
  $('#rush-end').innerHTML = (s ? `<h1 tabindex="-1">${s.boardDown ? 'Run ended' : mode === 'rush' ? 'Time’s up' : 'Streak over'}</h1>
    <p class="rush-newbest" id="rush-newbest" aria-live="polite"></p>` : `<h1 tabindex="-1">${MODE[mode].name}</h1><p class="rush-newbest rush-when">${esc(when(rec.t))}</p>`) + `
    <p class="rush-hero"><span>${mode === 'rush' ? 'Score' : 'Streak'}</span><b>${sum.score}</b></p>
    <dl class="rush-stats">${stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <div class="rush-row">${s ? '<button type="button" class="primary" id="rush-again">Play again</button>' : ''}<button type="button" id="rush-back">Back</button></div>
    ${s ? '<div class="panel" id="rush-end-best"><h2>Your best</h2><p class="muted flush">…</p></div>' : ''}
    ${rec.puzzles.length ? `<h2>Puzzles</h2>
    <p class="muted rush-small">${hint}</p>
    <ol class="rush-cards" id="rush-cards">${rec.puzzles.map((r, i) => cardHTML(rec, i)).join('')}</ol>
    <dialog class="rush-dlg" id="rush-look" aria-labelledby="rush-look-h"></dialog>` : '<p class="muted">No puzzles played.</p>'}`;
  if (rec.puzzles.length) lookBack(rec);
  // (no board: back to Start, which waits for it again, Retry reloading it first)
  if (s) $('#rush-again').onclick = () => { st = null; if (board.frameUp) return startRun(); if (board.iframe.dataset.down) board.retry(); renderStart(); startRun(); };
  $('#rush-back').onclick = () => {
    st = null; renderStart();
    (at != null && view.querySelector(`.rush-recent-row[data-i="${at}"]`) || $('#rush-go'))?.focus();
  };
  window.scrollTo?.(0, 0);
  $('#rush-end h1').focus({ preventScroll: true });
}
// A row's result: a glyph, as the strip's, with its word for screen readers.
const resultHTML = (r) => { const m = R.resultMark(r); return `<span class="${m.cls}"><span aria-hidden="true">${m.glyph}</span><span class="sr-only">${m.sr}</span>${m.text ? ' ' + `<span${m.sr === m.text ? ' aria-hidden="true"' : ''}>${esc(m.text)}</span>` : ''}</span>`; };
// ---------- looking back at a puzzle (the end screen's cards; never during the run, where it would cost clock) ----------
// Every puzzle of the run is a card with a picture of it (rush-look.js: a still copy of the board, in the symmetry, the
// labels and the orientation the player saw it in), its result, its link, rating and time. Its result button opens a
// larger picture with the words (lookHTML) in a dialog, with Previous and Next through the run.
// rec: R.recordOf (a run just played, or a stored one); each of its puzzles is both the position and the result.
// The board's orientation (the player's own turn or mirror, [ ] - ; : =, kept in this browser) is the Rush board's.
// ...and its colours: the player's board theme (ninja.js pictureTheme, rush-theme.js), as custom properties on the end
// screen, which style.css's .rt lays over the pictures' felt. A built-in theme the embed hasn't reported yet in this
// browser: felt until it does (onNinjaTheme), then the same pictures recoloured where they are (nothing moves).
let themed = [];
function paintTheme() {
  const el = document.querySelector('#rush-end');
  if (!el) return;
  const look = pictureLook(board?.pictureTheme?.().theme ?? null, R.SIZE);
  for (const k of themed) el.style.removeProperty(k);
  themed = look ? Object.keys(look.vars) : [];
  for (const k of themed) el.style.setProperty(k, look.vars[k]);
  el.classList.toggle('rt', !!look);
}
onNinjaTheme(() => paintTheme());
const orientOf = () => board?.frameM?.() || [1, 0, 0, 1]; // (PTN Ninja's own turn of its board)
const viewOf = (q) => { try { return R.review(q, q); } catch { return null; } }; // (a stored position that doesn't parse: nothing to draw)
function picHTML(q) { const v = viewOf(q); return v ? pictureHTML(picture(v, orientOf())) : '<div class="rush-pic none"></div>'; }
function cardHTML(rec, i) {
  const r = rec.puzzles[i], m = R.resultMark(r);
  return `<li class="rush-card ${m.cls}" data-i="${i}"><button type="button" class="rush-res" aria-haspopup="dialog" aria-expanded="false" aria-controls="rush-look">
    ${picHTML(r)}<span class="rush-card-res"><span class="sr-only">Puzzle ${i + 1}, </span>${resultHTML(r)}</span></button>
    <p class="rush-card-meta"><a href="${esc(R.puzzleLink(r))}">#${esc(r.id)}</a><span><span class="sr-only">rated </span>${Math.round(r.rating)}</span><span>${sec(r.ms)}</span></p></li>`;
}
// The words under the larger picture: whose turn it was, what was played, what the move was, how a play-out ended.
function lookHTML(rec, i) {
  const q = rec.puzzles[i], v = viewOf(q);
  if (!v) return '';
  const r = q, t = R.turn(v.toMove);
  const g = (x) => `<span aria-hidden="true">${x}</span> `;
  return `<div class="rush-look-txt"><p><span class="rush-turn sm ${t.color}" aria-hidden="true"><i></i></span>${t.text}</p>
    ${v.you ? `<p class="${r.skipped || r.unfinished ? 'muted' : r.solved ? 'good' : 'bad'}">${r.skipped || r.unfinished ? '' : g(r.solved ? '✓' : '✗')}${esc(v.you)}</p>` : ''}${v.want ? `<p class="${r.solved && r.played != null ? 'muted' : 'good'}">${r.solved && r.played != null ? '' : g('✓')}${esc(v.want)}</p>` : ''}
    ${v.marks.length ? `<p class="rush-key muted" aria-hidden="true">${v.marks.some((x) => x.role === 'bad') ? '<span class="k bad"></span>your move ' : ''}${v.marks.some((x) => x.role === 'good') ? '<span class="k good"></span>the puzzle’s move' : ''}</p>` : ''}</div>`;
}
// A puzzle stored without its symmetry (runs from before records kept it): a note for the puzzle page, read and
// cleared by its next route, from which it works the symmetry out (app.js loadById, R.symFromRecord). A link opened
// in a new tab goes without it and shows the puzzle in its own orientation.
function noteLink(a, q) {
  if (a && q && q.sym === undefined) a.addEventListener('click', (e) => { if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; try { sessionStorage.setItem('tinue.lookFrom', JSON.stringify(R.lookFrom(q))); } catch {} });
}
// The look-back dialog closed whenever its page goes (another page, the start screen, the browser's Back): left open in
// a hidden section it would stay modal and leave the whole page unclickable.
function closeLook() { const d = document.querySelector('#rush-look'); if (d?.open) d.close(); }
function lookBack(rec) {
  const list = $('#rush-cards'), dlg = $('#rush-look'), n = rec.puzzles.length;
  let at = -1;
  const btn = (i) => list.querySelector(`.rush-card[data-i="${i}"] .rush-res`);
  const show = (i) => {
    if (at >= 0) btn(at)?.setAttribute('aria-expanded', 'false');
    at = i;
    const q = rec.puzzles[i];
    dlg.innerHTML = `<div class="rush-dlg-head"><h2 id="rush-look-h">Puzzle ${i + 1} of ${n} <span class="rush-dlg-res">${resultHTML(q)}</span></h2>
      <button type="button" class="link rush-dlg-x" id="rush-look-x" aria-label="Close">×</button></div>
      <p class="rush-card-meta"><a href="${esc(R.puzzleLink(q))}">#${esc(q.id)}</a><span>Rated ${Math.round(q.rating)}</span><span>${sec(q.ms)}</span></p>
      <div class="rush-dlg-body">${picHTML(q)}${lookHTML(rec, i)}</div>
      <div class="rush-row rush-dlg-nav"><button type="button" id="rush-look-prev"${i ? '' : ' disabled'}>Previous</button><button type="button" id="rush-look-next"${i < n - 1 ? '' : ' disabled'}>Next</button></div>`;
    noteLink(dlg.querySelector('a'), q);
    // Following the link leaves this page with the dialog open: a modal dialog in a hidden page stays modal, and
    // everything outside it (the puzzle page too) stops taking clicks. Closed first (a new tab's link leaves it be).
    dlg.querySelector('a').addEventListener('click', (e) => { if (!(e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) dlg.close(); });
    $('#rush-look-x').onclick = () => dlg.close();
    $('#rush-look-prev').onclick = () => go(-1);
    $('#rush-look-next').onclick = () => go(1);
    btn(i)?.setAttribute('aria-expanded', 'true');
  };
  // (Previous or Next turned off at the end of the run: the focus moves to the other, not out of the dialog)
  const go = (d) => { const i = at + d; if (i < 0 || i >= n) return; show(i); (d < 0 ? (i ? $('#rush-look-prev') : $('#rush-look-next')) : (i < n - 1 ? $('#rush-look-next') : $('#rush-look-prev')))?.focus(); };
  dlg.addEventListener('close', () => { const b = btn(at); b?.setAttribute('aria-expanded', 'false'); at = -1; b?.focus(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // (the backdrop)
  dlg.addEventListener('keydown', (e) => {
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.target.closest?.('a')) return;
    e.preventDefault(); go(e.key === 'ArrowLeft' ? -1 : 1);
  });
  for (const li of list.querySelectorAll('.rush-card')) {
    const i = +li.dataset.i;
    li.querySelector('.rush-res').onclick = () => { show(i); if (!dlg.open) dlg.showModal(); $('#rush-look-x').focus(); };
    noteLink(li.querySelector('a'), rec.puzzles[i]);
  }
}
// The end screen's line for a run the board ended (boardDied)
export const BOARD_ENDED = 'The board (PTN Ninja) stopped answering, so this run ended. It isn’t kept, and doesn’t count against you.';
async function showBest(r, mode, s, out = null) {
  if (st !== s) return;
  const best = r?.best ?? await bestFor();
  if (st !== s) return;
  $('#rush-end-best').innerHTML = `<h2>Your best</h2>${bestTable(best?.[s.run.mode])}`;
  const nb = r?.newBest, el = $('#rush-newbest');
  // a best is gold; where the run went is plain news (kept for later) or a failure (red), never gold
  el.className = 'rush-newbest' + (!nb && (out === 'keep' || out === 'left' || out === 'board') ? ' rush-when' : !nb && out === 'drop' ? ' bad' : '');
  el.textContent = nb ? R.newBestText(nb) : out === 'board' ? BOARD_ENDED : out === 'keep' ? 'Saved here. Will send when online.' : out === 'drop' ? 'Couldn’t send this run.' : out === 'left' ? 'Saved as left unfinished.' : '';
}

// Another page: a run in progress ends here, posted as abandoned once a move was made (see abandon).
export function leave() {
  gen++;
  if (st) sound.dropLater(); // (a verdict, the ten-second warning or the end still due stays in the run)
  closeLook();
  abandon(st);
  if (st?.cur?.adj) stopAdj(st.cur, 'left');
  if (st) { clearInterval(st.timer); st = null; dropHeld(); board?.ui({ disableBoard: true }); }
  board?.giveBack();
}
