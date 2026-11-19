// Rush and Streak rules (Lichess Puzzle Storm / Puzzle Streak), pure so node can test them (scripts/test-rush.mjs):
// judging a move without an engine, the clock, the combo and its time bonuses, and the end-of-run numbers.
// public/rush.js owns the screen and calls these with the time it read.
import { Game, colorOf, typeOf } from './shared/tak.js?v=1795073685';
import { finalSquare } from './settings.js?v=1795073685';

export const SIZE = 6; // Rush and Streak are 6×6 only (server/rush.js refuses any other size)
export const RUSH_MS = 180e3; // 3:00
export const WRONG_MS = 10e3; // a wrong move costs 10 s
// Combo bonuses, as Storm: at 5 in a row +3 s, 12 +5 s, 20 +7 s, 30 +10 s, then +10 s at every 10 more (40, 50, ...).
const STEPS = [[5, 3], [12, 5], [20, 7], [30, 10]];
export function bonusAt(combo) {
  for (const [at, s] of STEPS) if (combo === at) return s * 1000;
  return combo > 30 && combo % 10 === 0 ? 10e3 : 0;
}
// The next bonus from this combo: { at, ms }, and how far along the bar is (0..1) from the last one.
export function nextBonus(combo) {
  const marks = [0, ...STEPS.map(([a]) => a)];
  let at = STEPS.find(([a]) => a > combo)?.[0];
  if (at == null) at = Math.floor(combo / 10) * 10 + 10;
  const prev = at > 30 ? at - 10 : marks[marks.indexOf(at) - 1];
  return { at, ms: bonusAt(at), frac: (combo - prev) / (at - prev) };
}

// ---------- judging ----------
// What a puzzle needs: { tps, komi, tree } (GET /api/rush/run). The solver is the side to move.
// line: the moves played in this puzzle so far, both sides, canonical PTN. Returns one of
//   { kind: 'illegal' }                      not a legal move here (the board puts it back; nothing counted)
//   { kind: 'wrong', canon }                 a mistake
//   { kind: 'solved', canon, how: 'road' }   wins on the spot (or ends the stored line)
//   { kind: 'ok', canon, reply }             in the tree; the reply is played and the puzzle goes on
export function startGame(p, line = []) {
  const g = Game.fromTPS(p.tps, p.komi || 0);
  for (const m of line) g.play(m);
  return g;
}
export function nodeAt(p, line) {
  let node = p.tree;
  for (let i = 0; i < line.length; i += 2) {
    const e = node && node !== 'win' ? node[line[i]] : null;
    node = e ? e.n : null;
  }
  return node;
}
export function judge(p, line, ptn) {
  const g = startGame(p, line);
  const solver = Game.fromTPS(p.tps).toMove;
  let canon;
  try { canon = g.canon(ptn); } catch { return { kind: 'illegal' }; }
  if (!g.legalMoves().some((m) => g.moveToPTN(m) === canon)) return { kind: 'illegal' };
  const node = nodeAt(p, line);
  g.play(canon);
  const res = g.result();
  if (res && res.winner === solver) return { kind: 'solved', canon, how: 'road' };
  if (res) return { kind: 'wrong', canon };
  if (node && node !== 'win' && Object.hasOwn(node, canon)) {
    const e = node[canon];
    // A tree edge without a reply would leave the puzzle with nothing to play: count it as the end (none exist today).
    if (!e?.r) return { kind: 'solved', canon, how: 'road' };
    return { kind: 'ok', canon, reply: e.r };
  }
  // Anything else is a mistake, a different winning move included: one move proves nothing about the rest of the line,
  // and there's no time to play it out (the puzzle page does). Puzzles that list other winning moves (alts / altsAt)
  // are never in a run (server/rush.js pools), so this only meets moves no one has found to win.
  return { kind: 'wrong', canon };
}

// ---------- the run ----------
// mode 'rush': the clock starts at the first move; 'streak': no clock, the first wrong move ends it, one skip.
export function newRun(mode) {
  return { mode, startedAt: null, endedAt: null, over: false, bonusMs: 0, penaltyMs: 0, combo: 0, bestCombo: 0,
    moves: 0, errors: 0, score: 0, skipUsed: false, results: [], units: 0 }; // units: combo earned in all (see weight)
}
export function startClock(run, now) { if (run.startedAt == null) run.startedAt = now; }
// Rush time left (ms) at `now`; the full 3:00 until the first move.
export function timeLeft(run, now) {
  if (run.mode !== 'rush') return Infinity;
  const used = run.startedAt == null ? 0 : (run.endedAt ?? now) - run.startedAt;
  return Math.max(0, RUSH_MS + run.bonusMs - run.penaltyMs - used);
}
// Called before acting on a move, with the time it was made: true when the clock ran out first, which ends the run
// (the move doesn't count).
export function expired(run, now) {
  if (run.mode !== 'rush' || run.over || run.startedAt == null || timeLeft(run, now) > 0) return run.over;
  end(run, run.startedAt + RUSH_MS + run.bonusMs - run.penaltyMs);
  return true;
}
export function end(run, now) { if (!run.over) { run.over = true; run.endedAt = now; } }

// A move's weight toward the combo (Shy, 2026-11-18: each placement in a stack counts): the squares a stack move drops
// on, e.g. 4a2>112 is 3 and a2> (one square, its count implied) is 1; a placement is 1. At most MAX_DROPS on 6×6.
export const MAX_DROPS = SIZE - 1;
export function weight(ptn) {
  const m = /^([1-8])?[a-h][1-8][<>+-]([1-8]*)\*?$/.exec(String(ptn ?? ''));
  return m && m[2] ? m[2].length : 1;
}
// A correct move: the combo grows by its weight (units), and every bonus threshold it reaches or crosses pays. Returns
// the bonus in ms (0 for none).
export function correct(run, w = 1) {
  const from = run.combo;
  run.moves++; run.combo += w; run.units = (run.units || 0) + w;
  run.bestCombo = Math.max(run.bestCombo, run.combo);
  let b = 0;
  if (run.mode === 'rush') for (let c = from + 1; c <= run.combo; c++) b += bonusAt(c);
  run.bonusMs += b;
  return b;
}
// A wrong move: −10 s (rush), combo back to 0; a streak ends.
export function wrong(run, now) {
  run.moves++; run.errors++; run.combo = 0;
  if (run.mode === 'rush') run.penaltyMs += WRONG_MS; else end(run, now);
  if (run.mode === 'rush' && timeLeft(run, now) <= 0) end(run, now);
}
// One puzzle finished: { id, rating, solved, skipped?, ms, wrong?, clock?, combo? }.
export function finish(run, r) {
  run.results.push(r);
  if (r.solved) run.score++;
}

// The end screen's numbers, and the body of POST /api/rush/result.
export function summary(run) {
  const played = run.startedAt == null ? 0 : (run.endedAt ?? run.startedAt) - run.startedAt;
  const solved = run.results.filter((r) => r.solved);
  return {
    score: run.score, moves: run.moves, errors: run.errors, bestCombo: run.bestCombo,
    accuracy: run.moves ? (run.moves - run.errors) / run.moves : null,
    ms: Math.max(0, Math.round(played)), perMove: run.moves ? played / run.moves : null,
    highest: solved.length ? Math.max(...solved.map((r) => r.rating)) : null,
  };
}
export function resultBody(run, build = 0, env = null) {
  const s = summary(run);
  return { mode: run.mode, size: SIZE, score: s.score, moves: s.moves, errors: s.errors, bestCombo: s.bestCombo, units: run.units || 0, ms: s.ms, build,
    ...(env ? { env } : {}),
    puzzles: run.results.map((r) => ({ id: r.id, solved: r.solved, ...(r.skipped ? { skipped: true } : {}), ...(r.unfinished ? { unfinished: true } : {}), ms: Math.round(r.ms),
      ...(r.wrong ? { wrong: r.wrong } : {}), ...(r.clock != null ? { clock: Math.round(r.clock) } : {}), ...(r.combo != null ? { combo: r.combo } : {}),
      ...(r.mv ? { mv: r.mv } : {}), ...(r.hidden != null ? { hidden: r.hidden } : {}) })) };
}

// ---------- timing data, for calibrating puzzle difficulty (server/rush.js rush_moves) ----------
// Per puzzle c: c.mv, the move the board is waiting for ({ t0: when the board took input, first: the first tap, click
// or key toward it, held: Confirm moves' hold }), and c.moves, those made: { first, ms, held?, weight, correct } in whole
// ms from t0. performance.now() times throughout.
export function openMove(c, t0) { c.moves ||= []; c.mv = { t0, first: null, held: null }; }
export function touchMove(c, now) { if (c?.mv && c.mv.first == null && now >= c.mv.t0) c.mv.first = now; }
export function holdMove(c, now) { if (c?.mv && c.mv.held == null) c.mv.held = now; }
export function closeMove(c, now, weight, correct, ptn = null) {
  const m = c.mv, t0 = m ? m.t0 : now, d = (t) => Math.max(0, Math.round(Math.min(t, now) - t0));
  (c.moves ||= []).push({ first: m?.first != null ? d(m.first) : null, ms: d(now), ...(m?.held != null ? { held: d(m.held) } : {}), weight, correct,
    ...(ptn ? { ptn } : {}) });
  c.mv = null;
}
// The trajectory of the move just made, once the run has counted it (after correct / wrong): at, whole ms from the
// run's clock start (its first move), and in Rush the clock left with any bonus or penalty applied.
export function stampMove(c, run, now) {
  const m = c.moves?.at(-1);
  if (!m || run.startedAt == null) return;
  m.at = Math.max(0, Math.round(now - run.startedAt));
  if (run.mode === 'rush') m.clock = Math.round(timeLeft(run, now));
}
// Who played, as a queued result remembers it: a fingerprint of the token (not the token), or null without one. A
// queued result is sent only while the same token is in use, so a run is never posted as another account's (or, after
// signing out, as nobody's).
export function who(tok) {
  if (!tok) return null;
  let h = 0x811c9dc5;
  for (const ch of String(tok)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(36);
}
// The run's setting, as sent (env): no device detail beyond these classes.
export const widthClass = (w) => (w < 600 ? 'phone' : w < 1024 ? 'tablet' : 'desktop');
export const inputKind = (kinds) => (kinds.has('touch') && kinds.has('mouse') ? 'both' : kinds.has('touch') ? 'touch' : kinds.has('mouse') ? 'mouse' : undefined);
// A run left unfinished (the view left, the tab closed) is posted as abandoned once a move was made: its finished
// puzzles, and the one it was left on if a move was made there (unfinished). Never a best, never in Recent runs.
export const canAbandon = (run) => !run.over && run.moves > 0;
// A Rush whose clock had already run out (a tab hidden or closed past it) is no abandoned run but a finished one: it
// ends where its clock did, without the puzzle open then (as any time-out), and null when nothing was finished, so it
// never replaces a queued snapshot with a body the server would refuse as too long. wall: Date.now() at `now`, for
// playedAt (when the run ended, wall clock).
export function abandonBody(run, cur, now, build = 0, env = null, wall = null) {
  const r = { ...run, results: [...run.results] };
  const out = expired(r, now);
  if (out) { closeOpen(r, cur); if (!r.results.length) return null; } else {
    if (cur?.moves?.length) r.results.push({ id: cur.p.id, rating: cur.p.rating, solved: false, unfinished: true, ms: now - cur.born, mv: cur.moves, hidden: !!cur.hidden });
    end(r, now);
  }
  return { ...resultBody(r, build, env), ...(out ? {} : { abandoned: true }), ...(wall != null ? { playedAt: playedAtOf(r.endedAt, now, wall) } : {}) };
}
// A Rush that ran out of time with a puzzle on the board keeps it, last, as unfinished: the position it reached (at),
// the moves made in it (none, if it had just appeared), its time up to the clock's end. Never solved or failed, so no
// score, accuracy or hardest solved; a puzzle already finished (a penalty that emptied the clock, a run out of
// puzzles) isn't open. Returns the run.
export function closeOpen(run, cur) {
  if (run.mode !== 'rush' || !cur?.p || run.results.some((x) => x.id === cur.p.id)) return run;
  finish(run, { id: cur.p.id, rating: cur.p.rating, solved: false, unfinished: true, ms: Math.max(0, (run.endedAt ?? cur.born) - cur.born),
    mv: cur.moves || [], hidden: !!cur.hidden, at: [...(cur.line || [])], clock: 0, combo: run.combo });
  return run;
}
// A result's mark on the end screen's list: the glyph, its colour, its word for screen readers, and any text after it.
export function resultMark(r) {
  if (r.skipped) return { cls: 'muted', glyph: '–', sr: 'skipped', text: '' };
  if (r.unfinished) return { cls: 'muted', glyph: '·', sr: 'unfinished', text: 'unfinished' };
  if (r.solved) return { cls: 'good', glyph: '✓', sr: 'solved', text: '' };
  return { cls: 'bad', glyph: '✗', sr: 'failed, played', text: r.wrong || '' };
}
// When a run ended, wall clock: performance.now() endedAt, read against now / wall taken together.
export const playedAtOf = (endedAt, now, wall) => Math.round(wall - Math.max(0, now - endedAt));
// Whether flushQueue sends a queued result now: played as who is signed in, not the run being played here, and not a
// fresh snapshot (another tab's run may still be going: one left two minutes is fair game).
export const SNAP_FRESH_MS = 120e3;
export function sendable(it, now, who, playing) {
  return it.who === who && it.body.run !== playing && !(it.snap && now - it.snap < SNAP_FRESH_MS);
}

// ---------- what the run screen shows ----------
// What the board shows of a puzzle after `line`: from the position before the opponent's last move when the server
// sent it (before, last: the intro, played as the puzzle opens and tinted as the last move), else the puzzle's own.
export function boardFrom(p, line = []) {
  return p.before && p.last ? { tps: p.before, moves: [p.last, ...line] } : { tps: p.tps, moves: [...line] };
}
// The colour to move (solver 1 = white), and whether it differs from the last puzzle's: a run mixes both colours, and
// the stone and the board's ring pulse on a change so a player in the habit of one side notices.
export function turn(solver, prev = null) {
  const white = solver === 1;
  return { color: white ? 'white' : 'black', text: white ? 'White to play.' : 'Black to play.', changed: prev != null && prev !== solver };
}
// The puzzle just finished, as Storm shows it: a mark and its rating (whole; ratings are stored as reals).
export function lastText(r) {
  if (!r) return null;
  const n = Math.round(r.rating);
  if (r.skipped) return { text: `Skipped ${n}`, cls: 'skip', label: `Last puzzle skipped, rated ${n}` };
  return r.solved ? { text: `✓ ${n}`, cls: 'good', label: `Last puzzle solved, rated ${n}` }
    : { text: `✗ ${n}`, cls: 'bad', label: `Last puzzle failed, rated ${n}` };
}
// What a screen reader hears once per puzzle (rush.js say()): the result (lastText's), in Rush the time it moved the
// clock by, then whose turn it is next, or how the run ended. bonus: ms gained on the puzzle (0 or more).
// 'Solved. 3 seconds added. Black to play.' · 'Wrong. 10 seconds lost. White to play.' · 'Wrong. Streak over.'
export function sayText({ r = null, mode, bonus = 0, next = null, over = false }) {
  const v = lastText(r), rush = mode === 'rush';
  const parts = v ? [{ good: 'Solved.', bad: 'Wrong.', skip: 'Skipped.' }[v.cls]] : [];
  if (v && rush && v.cls === 'good' && bonus > 0) parts.push(`${bonus / 1000} seconds added.`);
  if (v && rush && v.cls === 'bad') parts.push(`${WRONG_MS / 1000} seconds lost.`);
  if (over) parts.push(rush ? 'Time’s up.' : 'Streak over.');
  else if (next) parts.push(next);
  return parts.join(' ');
}
// When a stored run was played, short: 'Today, 8:05 PM', 'Yesterday, 8:05 PM', 'Nov 16, 8:05 PM', and the year only
// when it isn't this one ('Dec 30, 2025, 8:05 PM'). Local time; locale as the browser's unless given.
export function whenText(t, now = Date.now(), locale = undefined) {
  const d = new Date(t), n = new Date(now);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const ago = Math.round((day(n) - day(d)) / 864e5); // (whole days, also across a DST change)
  if (ago === 0) return `Today, ${time}`;
  if (ago === 1) return `Yesterday, ${time}`;
  return d.toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}) });
}
// A recent-runs row as a screen reader says it (the row itself shows the same in columns).
export function recentLabel(rec, when) {
  if (rec.mode !== 'rush') return `Streak, ${rec.score}, ${when}`;
  const a = rec.sum?.accuracy;
  return `Rush, ${rec.score} solved, ${a == null ? 'no' : Math.round(a * 100) + '%'} accuracy, ${when}`;
}

// ---------- looking back (the end screen's list) ----------
// The puzzle's move at this point of the line: the tree's, else (a 'win' node) a move that wins on the spot.
export function answerAt(p, line = []) {
  const node = nodeAt(p, line);
  if (node && node !== 'win') return Object.keys(node)[0] ?? null;
  const g = startGame(p, line), me = g.toMove;
  for (const m of g.legalMoves()) {
    const h = g.clone(), ptn = g.moveToPTN(m);
    h.play(ptn);
    if (h.result()?.winner === me) return ptn;
  }
  return null;
}
// The squares a move touches, [start, final] (one for a placement).
export function moveSquares(ptn) {
  const s = /^(\d?)([a-h][1-8])/.exec(String(ptn || '').replace(/^[FSC]/, ''))?.[2];
  if (!s) return [];
  const f = finalSquare(ptn);
  return f && f !== s ? [s, f] : [s];
}
// One row of the list, looked back at. A miss shows the position it was made in (the start, for a miss on the first
// move), so the player sees the side and the squares they had; a solve or a skip shows the start and its first move.
// r: the run's result with `at`, the moves accepted before the miss (rush.js keeps it; it isn't posted), and
// `answer` when already known (a stored run keeps it, not the puzzle's tree).
// Returns { size, toMove, cells (rank size first, file a first: { sq, dark, top: { color, type } | null, h }), last
// (the move that led to the position, tinted as the board does), played, answer (each [start, final] squares), you (what was played, '' for a solve), want (the puzzle's move), text (both) }.
export function review(p, r) {
  const at = r.solved || r.skipped ? [] : r.at || [];
  const g = startGame(p, at), answer = r.answer !== undefined ? r.answer : answerAt(p, at), n = p.size, cells = [];
  for (let row = n - 1; row >= 0; row--) for (let col = 0; col < n; col++) {
    const sq = row * n + col, stack = g.board[sq], t = stack.length ? stack[stack.length - 1] : -1;
    cells.push({ sq: g.sqName(sq), dark: col % 2 === row % 2, top: t < 0 ? null : { color: colorOf(t), type: typeOf(t) }, h: stack.length });
  }
  const you = r.solved ? '' : r.skipped ? 'Skipped' : r.unfinished ? (at.length ? `After ${at.join(' ')}, time ran out` : 'Time ran out')
    : (at.length ? `After ${at.join(' ')}, you played ` : 'You played ') + (r.wrong || '?');
  const want = !answer ? '' : r.solved || r.skipped ? `The first move was ${answer}` : `The move was ${answer}`;
  const led = at.length ? at.at(-1) : p.last; // the move that led here (none: no game on record)
  return { size: n, toMove: g.toMove, cells, last: moveSquares(led), played: r.solved || r.skipped ? [] : moveSquares(r.wrong), answer: moveSquares(answer),
    you, want, text: [you, want].filter(Boolean).join(' · ') };
}

// ---------- this browser's history of runs (local only: never posted, not tied to an account) ----------
// A finished run as stored: { v, t (ms, when it ended), mode, score, sum (summary), puzzles: [{ id, rating, solved,
// skipped?, ms, wrong?, at?, answer, size, tps, komi, last? }] }: each puzzle carries what the look-back draws from
// (its start, the moves before a miss, the puzzle's move there), not its tree. The newest HIST_MAX, in HIST_CHARS of
// JSON (about 400 kB as stored), newest first.
export const HIST_V = 1, HIST_MAX = 30, HIST_CHARS = 400e3;
export function recordOf(run, puzzles, t) {
  const byId = new Map(puzzles.map((p) => [p.id, p]));
  return { v: HIST_V, t, mode: run.mode, score: run.score, sum: summary(run), puzzles: run.results.map((r) => {
    const p = byId.get(r.id) || {}, at = r.solved || r.skipped ? [] : r.at || [];
    let answer = null;
    try { answer = answerAt(p, at); } catch {}
    return { id: r.id, rating: Math.round(r.rating), solved: r.solved, ...(r.skipped ? { skipped: true } : {}), ms: Math.round(r.ms),
      ...(r.wrong ? { wrong: r.wrong, at } : {}), ...(r.unfinished ? { unfinished: true, at } : {}), answer, size: p.size, tps: p.tps, komi: p.komi || 0, ...(p.last ? { last: p.last } : {}) };
  }) };
}
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const SUM_KEYS = ['score', 'moves', 'errors', 'bestCombo', 'accuracy', 'ms', 'perMove', 'highest'];
function validPuzzle(q) {
  return !!q && typeof q === 'object' && str(q.id, 40) && num(q.rating) && typeof q.solved === 'boolean' && num(q.ms) && q.ms >= 0
    && Number.isInteger(q.size) && q.size >= 3 && q.size <= 8 && str(q.tps, 400) && num(q.komi ?? 0)
    && (q.skipped === undefined || typeof q.skipped === 'boolean') && (q.unfinished === undefined || typeof q.unfinished === 'boolean') && (q.wrong === undefined || str(q.wrong, 24))
    && (q.at === undefined || (Array.isArray(q.at) && q.at.length <= 200 && q.at.every((m) => str(m, 24))))
    && (q.answer === null || str(q.answer, 24)) && (q.last === undefined || str(q.last, 24));
}
// Whether a stored run can be shown: the current shape, whole. Anything else (an older shape, a hand edit, a cut-off
// write) is skipped, never repaired.
export function validRecord(x) {
  return !!x && typeof x === 'object' && x.v === HIST_V && num(x.t) && (x.mode === 'rush' || x.mode === 'streak')
    && Number.isInteger(x.score) && x.score >= 0 && !!x.sum && typeof x.sum === 'object'
    && SUM_KEYS.every((k) => x.sum[k] === null || num(x.sum[k])) && Array.isArray(x.puzzles) && x.puzzles.length <= 1000
    && x.puzzles.every(validPuzzle);
}
// The stored list as it can be shown: valid runs only, newest first.
export const historyOf = (raw) => (Array.isArray(raw) ? raw.filter(validRecord).sort((a, b) => b.t - a.t) : []);
// Kept to the newest max runs and to chars of JSON, dropping the oldest first.
export function trimHistory(list, max = HIST_MAX, chars = HIST_CHARS) {
  const out = list.slice(0, max);
  while (out.length && JSON.stringify(out).length > chars) out.pop();
  return out;
}
export const addRun = (raw, rec) => trimHistory(historyOf([rec, ...(Array.isArray(raw) ? raw : [])]));

// ---------- offline: spare runs fetched ahead, results waiting to be sent ----------
// A run token is good for RUN_TTL_MS from when the server minted it (server/rush.js RUN_TTL, the same 30 days): a
// spare older than SPARE_AGE_MS isn't started (its result would have under 5 days left to be sent), and a queued
// result past RUN_TTL_MS is dropped (the server would refuse it). Times are the token's own (the server's clock).
const DAY_MS = 864e5;
export const RUN_TTL_MS = 30 * DAY_MS, SPARE_AGE_MS = 25 * DAY_MS;
// Spares: SPARE_KEEP runs per mode of SPARE_PAGES pages (2 × 80 puzzles: more than a strong Rush, and a long Streak),
// in at most SPARE_CHARS of JSON in localStorage. QUEUE_MAX results at most wait to be sent.
export const SPARE_KEEP = 3, SPARE_PAGES = 2, SPARE_CHARS = 1.2e6, QUEUE_MAX = 20;
// (a token: <time base 36>.<random>.<mac>, server/rush.js signer)
export const tokenTime = (tok) => { const m = /^([0-9a-z]+)\.[\w-]+\.[\w-]+$/.exec(String(tok ?? '')); return m ? parseInt(m[1], 36) : null; };
const validRunPuzzle = (p) => !!p && typeof p === 'object' && str(p.id, 40) && p.size === SIZE && str(p.tps, 400) && num(p.rating)
  && (p.tree === 'win' || (!!p.tree && typeof p.tree === 'object' && !Array.isArray(p.tree))) && (p.komi == null || num(p.komi));
// A stored spare: { v, mode, token, pages: [{ start, ids, sig }], puzzles } as GET /api/rush/run handed them out.
export function validSpare(x) {
  return !!x && typeof x === 'object' && x.v === 1 && (x.mode === 'rush' || x.mode === 'streak') && tokenTime(x.token) != null
    && Array.isArray(x.pages) && x.pages.length >= 1 && x.pages.length <= 12
    && x.pages.every((g) => !!g && Number.isInteger(g.start) && g.start >= 0 && Array.isArray(g.ids) && g.ids.every((i) => str(i, 40)) && str(g.sig, 64))
    && Array.isArray(x.puzzles) && x.puzzles.length >= 1 && x.puzzles.length <= 400 && x.puzzles.every(validRunPuzzle);
}
// The spares that can still be started, oldest first (so they are used before they age out).
export const sparesOf = (raw, now) => (Array.isArray(raw) ? raw.filter((x) => validSpare(x) && now - tokenTime(x.token) < SPARE_AGE_MS) : [])
  .sort((a, b) => tokenTime(a.token) - tokenTime(b.token));
// At most keep per mode and chars in all, the newest dropped first (the oldest are the next to be played).
export function trimSpares(raw, now, keep = SPARE_KEEP, chars = SPARE_CHARS) {
  const n = { rush: 0, streak: 0 }, out = sparesOf(raw, now).filter((x) => ++n[x.mode] <= keep);
  while (out.length && JSON.stringify(out).length > chars) out.pop();
  return out;
}
// The next spare for a mode, and the stored list without it.
export function takeSpare(raw, mode, now) {
  const list = sparesOf(raw, now), i = list.findIndex((x) => x.mode === mode);
  return i < 0 ? { spare: null, rest: list } : { spare: list[i], rest: list.filter((_, j) => j !== i) };
}
export const spareNeed = (raw, mode, now, keep = SPARE_KEEP) => Math.max(0, keep - sparesOf(raw, now).filter((x) => x.mode === mode).length);

// What a try at POST /api/rush/result settles: 'sent'; 'drop' when the server refuses the run for good (bad, already
// posted, too big); otherwise 'keep' it for later (no answer: offline, a timeout, a 5xx page; or 429, too many).
const FINAL = new Set(['bad run', 'no player', 'run already posted', 'too big']);
export function postOutcome(answer, failed = false) {
  if (failed || !answer || typeof answer !== 'object') return 'keep';
  if (answer.id != null) return 'sent';
  return FINAL.has(answer.error) ? 'drop' : 'keep';
}
// Results waiting to be sent, oldest first: { t (its token's time), body }; the newest QUEUE_MAX, none past the
// token's lifetime, one per run.
export function queueOf(raw, now) {
  const seen = new Set();
  const q = (Array.isArray(raw) ? raw : []).filter((x) => !!x && typeof x === 'object' && num(x.t) && now - x.t < RUN_TTL_MS
    && !!x.body && typeof x.body === 'object' && str(x.body.run, 200) && !seen.has(x.body.run) && seen.add(x.body.run));
  return q.sort((a, b) => a.t - b.t).slice(-QUEUE_MAX);
}

export const clockText = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
