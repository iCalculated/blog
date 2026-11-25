// Rush and Streak rules (Lichess Puzzle Storm / Puzzle Streak), pure so node can test them (scripts/test-rush.mjs):
// judging a move by the puzzle's line, where an off-line move goes next (the puzzle page's adjudication: route,
// playOutOutcome), the clock and its pauses, the combo and its time bonuses, and the end-of-run numbers.
// public/rush.js owns the screen and the engines and calls these with the time it read.
import { Game, colorOf, typeOf } from './shared/tak.js?v=1795581690';
import { quickOutcome, provenPlayOut, provenLossLead, ENGINE_MS, CAP_WAIT_MS } from './playon.js?v=1795581690';
import * as SYM from './shared/sym.js?v=1795581690';
import { moveShape } from './analysis.js?v=1795581690';

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
//   { kind: 'wrong', canon }                 a mistake: the move ends the game without the player's win
//   { kind: 'solved', canon, how: 'road' }   wins on the spot (or ends the stored line)
//   { kind: 'ok', canon, reply }             in the tree; the reply is played and the puzzle goes on
//   { kind: 'off', canon }                   any other legal move: adjudicated as the puzzle page does (route)
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
  // Anything else is judged as the puzzle page judges it (Sasha, 2026-11-18: "use the same adjudication flows"): a listed
  // alternative or a proof is a win to play out, a refutation a mistake, and an undecided move is played out (route).
  return { kind: 'off', canon };
}

// ---------- adjudicating a move off the line (app.js userMove, step for step) ----------
// Where an off-line move goes, from what the puzzle page would know at that point:
//   alt    the move is a listed alternative here (playon.js slowerWinsAt: no check runs, as on the puzzle page)
//   quick  the first still-wins check's quick answer ('wins' | 'no' | 'pending'), when one ran
//   def    who defends (playon.js defender: 'syntaks' | 'tiltak' | null)
// Returns 'mistake' (refuted), 'solved' (proven where there is no proven play-out: the puzzle page's slowSolve),
// 'proven' (a proven play-out: "That wins: play it out"), 'playout' (undecided: "Play it out"), or 'wait' (undecided
// with no engine to defend: the check's final answer decides, as settleCheck does).
export function route({ alt = false, quick = null, def = null }) {
  const out = alt ? 'wins' : quickOutcome(quick, false);
  if (out === 'no') return 'mistake';
  if (out === 'wins') return provenPlayOut(def) ? 'proven' : 'solved';
  return def ? 'playout' : 'wait';
}
// Every ending a play-out can have in a run (server/rush.js takes the same).
export const PO_ENDS = ['win', 'proved', 'road', 'held', 'out', 'gaveup', 'noengine', 'left', 'time'];
// How a play-out's ending (its kind, as the puzzle page's endPlayOn gets it) counts in a run: 'solved' for the
// player's win ('win') or a proof ('proved': Syntaks dropped out of a proven play-out, or a proof landed while Tiltak
// defended); 'wait' when no engine could move in an unproven game ('noengine': the check's final answer decides, as
// on the puzzle page); 'mistake' for anything else (the defender's road, flats or draw: 'road' / 'held'; out of
// moves: 'out'; Give up: 'gaveup'). Rush's own 'left' (the run left mid-game) and 'time' (the clock ran out on the
// player's turn) leave the puzzle unfinished: 'open'.
export function playOutOutcome(kind, proven = false) {
  if (kind === 'win' || kind === 'proved') return 'solved';
  if (kind === 'noengine') return proven ? 'solved' : 'wait';
  if (kind === 'left' || kind === 'time') return 'open';
  return 'mistake';
}
// The check's final answer, where it decides ('wait'): a proof is a solve; 'no' or no answer is a mistake (Rush has
// no unrated miss: nothing in it is rated).
export const finalOutcome = (v) => (v === 'wins' ? 'solved' : 'mistake');

// The most engine time a move off the line can have paused the clock for (ms), by what it went through: the puzzle
// page's own engine limits (playon.js ENGINE_MS, CAP_WAIT_MS) plus slack. Shared with the server (server/rush.js),
// which refuses more; the client credits no more (resume's room). m: the move as posted ({ check, po: { line, end } }).
//   check     'alt' (no check ran) next to nothing; 'checking' (left before it answered), 'no', 'wins' the quick
//             check; 'pending' or 'unknown' with no play-out, or one no engine could play ('noengine'), the check's
//             run-on, which then decided (its 60 s count from the check's start).
//   play-out  each defender reply (one more may have been on its way), and the waits at the move limit (a proof, then
//             its length).
//   hidden    a page hidden meanwhile stretches the engines' clocks (they count visible time only): 10 minutes more.
const SLACK_MS = 5000;
export const PAUSE_MS = { slack: SLACK_MS, check: ENGINE_MS.quick + SLACK_MS, final: ENGINE_MS.final + SLACK_MS,
  reply: ENGINE_MS.local + ENGINE_MS.crux + ENGINE_MS.local + ENGINE_MS.download + ENGINE_MS.tiltakUp + ENGINE_MS.tiltak + SLACK_MS,
  capWait: Object.values(CAP_WAIT_MS).reduce((t, x) => t + x, 0) + SLACK_MS, hidden: 10 * 60e3 };
export const CHECKS = ['checking', 'wins', 'no', 'pending', 'unknown', 'alt'], FINALS = ['wins', 'no', 'unknown'];
export const waitsOnFinal = (m) => (m.check === 'pending' || m.check === 'unknown') && (!m.po || m.po.end === 'noengine');
export function pauseMax(m, hidden = false) {
  const check = m.check === 'alt' ? PAUSE_MS.slack : waitsOnFinal(m) ? PAUSE_MS.final : PAUSE_MS.check;
  const game = m.po ? (Math.ceil(m.po.line.length / 2) + 1) * PAUSE_MS.reply + PAUSE_MS.capWait : 0;
  return check + game + (hidden ? PAUSE_MS.hidden : 0);
}
// A move off the line as it is made (rush.js adjudicate): closed open (decide() settles it), with the position it was
// judged in (path: the puzzle's moves before it) and the check's state: 'alt' (a listed alternative, none runs) or
// 'checking' until the quick answer comes (checked), so a run left meanwhile posts it as it stood.
export function openAdj(c, now, weight, canon, alt = false) {
  closeMove(c, now, weight, null, canon);
  const m = c.moves.at(-1);
  m.path = [...(c.line || [])]; m.check = alt ? 'alt' : 'checking';
  return m;
}
// The check's quick answer as it came ('wins' | 'no' | 'pending' | 'unknown': the worker failed or was stopped) and
// its time, within the bound the server takes (a frozen page's longer wait isn't the engine's).
export function checked(m, quick, ms, hidden = false) {
  m.check = quick; m.checkMs = Math.min(Math.round(ms), PAUSE_MS.check + (hidden ? PAUSE_MS.hidden : 0));
}
// The check's final answer, once it came while the move was still open (an unproven play-out's proof or refutation, or
// the answer that decided a wait), and its time from the check's start, bounded as above.
export function finalAnswer(m, v, ms, hidden = false) {
  m.final = FINALS.includes(v) ? v : 'unknown'; m.finalMs = Math.min(Math.round(ms), PAUSE_MS.final + (hidden ? PAUSE_MS.hidden : 0));
}

// ---------- the run ----------
// mode 'rush': the clock starts at the first move; 'streak': no clock, the first wrong move ends it, one skip.
export function newRun(mode) {
  return { mode, startedAt: null, endedAt: null, over: false, bonusMs: 0, penaltyMs: 0, combo: 0, bestCombo: 0,
    moves: 0, errors: 0, score: 0, skipUsed: false, results: [], units: 0, // units: combo earned in all (see weight)
    pausedMs: 0, pausedAt: null }; // the engine's time, never charged (pause / resume)
}
export function startClock(run, now) { if (run.startedAt == null) run.startedAt = now; }
// Engine time isn't the player's (Sasha, 2026-11-18: "time that Syntaks spends thinking should not be held against the
// user"): the clock stops while a check runs or the defender thinks, and runs whenever it is the player's turn. Only a
// move that needs the engine pauses it (rush.js). In Streak, with no clock, the pauses are still counted (data).
export function pause(run, now) { if (run.pausedAt == null && !run.over) run.pausedAt = now; }
// Ends a pause; returns the time credited to it (0 if none was running). room: the most it may credit (pauseMax less
// what the move already had): a pause past its bound, e.g. a page frozen while the engine worked, is charged to the
// clock beyond it, so a post never claims more engine time than the server takes.
export function resume(run, now, room = Infinity) {
  if (run.pausedAt == null) return 0;
  const d = Math.max(0, Math.min(now - run.pausedAt, room));
  run.pausedMs += d; run.pausedAt = null;
  return d;
}
// Real time paused up to `now` (the one running included).
export const pausedTo = (run, now) => run.pausedMs + (run.pausedAt != null ? Math.max(0, (run.endedAt ?? now) - run.pausedAt) : 0);
// Clock time used by `now`: real time since the first move less the pauses.
export const clockUsed = (run, now) => (run.startedAt == null ? 0 : Math.max(0, (run.endedAt ?? now) - run.startedAt - pausedTo(run, now)));
// Rush time left (ms) at `now`; the full 3:00 until the first move.
export function timeLeft(run, now) {
  if (run.mode !== 'rush') return Infinity;
  return Math.max(0, RUSH_MS + run.bonusMs - run.penaltyMs - clockUsed(run, now));
}
// Called before acting on a move, with the time it was made: true when the clock ran out first, which ends the run
// (the move doesn't count). A paused clock never runs out.
export function expired(run, now) {
  if (run.mode !== 'rush' || run.over || run.startedAt == null || timeLeft(run, now) > 0) return run.over;
  end(run, run.startedAt + run.pausedMs + RUSH_MS + run.bonusMs - run.penaltyMs);
  return true;
}
export function end(run, now) { if (!run.over) { if (run.pausedAt != null) resume(run, now); run.over = true; run.endedAt = now; } }

// A move's weight toward the combo (Shy, 2026-11-18: each placement in a stack counts): the squares a stack move drops
// on, e.g. 4a2>112 is 3 and a2> (one square, its count implied) is 1; a placement is 1. At most MAX_DROPS on 6×6.
export const MAX_DROPS = SIZE - 1;
export function weight(ptn) {
  const m = /^([1-8])?[a-h][1-8][<>+-]([1-8]*)\*?$/.exec(String(ptn ?? ''));
  return m && m[2] ? m[2].length : 1;
}
// The combo a move off the line earns when it counts as solved (a won or proved play-out, or a proof with no play-out;
// Sasha, 2026-11-19: "play out should get the intended solution combo (minus however many moves have already been
// made)"): what the puzzle's own solution would still have earned from where the player left it, i.e. the sum of
// weight() over the solver's moves on the principal line from the node at `path` (that node's own move included). The
// principal line is the one the puzzle page's View solution plays (app.js showSolution): the first-listed move at each
// node, and at a 'win' node the first legal move that wins on the spot (its finisher, as answerAt). So a slower win
// earns what the stored solution would have, however long its play-out; the moves played before it were counted as
// they were made. Computed in the puzzle's own orientation (a puzzle under a symmetry, p.sym, with path as the board
// showed it, is turned back first), as the finisher depends on move order, so the credit is the same whichever way it
// was shown, and the server recomputes it from the stored tree and the posted path (server/rush.js). null when the
// path leaves the tree or the line can't be followed (the caller then counts the move's own weight).
export function lineCredit(p, path = []) {
  if (!p || !Array.isArray(path)) return null;
  if (p.sym) { const back = SYM.inverse(p.sym); return lineCredit(SYM.unorient(p), path.map((m) => SYM.move(back, p.size, m))); }
  if (path.length % 2) return null;
  let node = nodeAt(p, path), credit = 0;
  const line = [...path];
  if (node == null) return null;
  for (let guard = 0; guard < 200; guard++) {
    if (node === 'win') {
      let fin = null;
      try { fin = answerAt(p, line); } catch {}
      return fin ? credit + weight(fin) : null;
    }
    if (typeof node !== 'object') return null;
    const mv = Object.keys(node)[0];
    if (mv == null) return credit || null;
    credit += weight(mv);
    const e = node[mv];
    if (!e?.r || e.n == null) return credit; // (the line ends with this move: judge counts it as the end)
    line.push(mv, e.r); node = e.n;
  }
  return null;
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
// ms is real time from the first move (posted: the server bounds it with paused); clockMs leaves out the engine's
// pauses, and is what the end screen shows as time played (and per move).
export function summary(run) {
  const played = run.startedAt == null ? 0 : (run.endedAt ?? run.startedAt) - run.startedAt, clock = Math.max(0, played - (run.pausedMs || 0));
  const solved = run.results.filter((r) => r.solved);
  return {
    score: run.score, moves: run.moves, errors: run.errors, bestCombo: run.bestCombo,
    accuracy: run.moves ? (run.moves - run.errors) / run.moves : null,
    ms: Math.max(0, Math.round(played)), clockMs: Math.round(clock), perMove: run.moves ? clock / run.moves : null,
    highest: solved.length ? Math.max(...solved.map((r) => r.rating)) : null,
  };
}
// Time played as the end screen shows it. Rush: the clock, which starts at the first move. Streak has no clock, so the
// clock's start would leave out the thinking before the first move: its time is the puzzles' own (the list under it),
// less the engine's pauses, which are never the player's.
export function timePlayed(rec) {
  const s = rec.sum, clock = s.clockMs ?? s.ms;
  return rec.mode === 'rush' ? clock : Math.max(0, rec.puzzles.reduce((t, p) => t + p.ms, 0) - (s.ms - clock));
}
// Moves are posted in the puzzle's own orientation (sym: the symmetry it was shown under, shared/sym.js), so rows from
// different runs line up; the player saw them turned. paused: the run's engine time, never on its clock.
export function resultBody(run, build = 0, env = null) {
  const s = summary(run);
  return { mode: run.mode, size: SIZE, score: s.score, moves: s.moves, errors: s.errors, bestCombo: s.bestCombo, units: run.units || 0, ms: s.ms, build,
    paused: Math.round(run.pausedMs || 0), ...(env ? { env } : {}),
    puzzles: run.results.map((r) => { const back = (m) => SYM.move(SYM.inverse(r.sym || 0), SIZE, m); return { id: r.id, solved: r.solved, ...(r.skipped ? { skipped: true } : {}), ...(r.unfinished ? { unfinished: true } : {}), ms: Math.round(r.ms),
      ...(r.wrong ? { wrong: back(r.wrong) } : {}), ...(r.clock != null ? { clock: Math.round(r.clock) } : {}), ...(r.combo != null ? { combo: r.combo } : {}),
      ...(r.mv ? { mv: r.mv.map((m) => postMove(m, back)) } : {}), ...(r.hidden != null ? { hidden: r.hidden } : {}), ...(r.sym != null ? { sym: r.sym } : {}) }; }) };
}
// A move as posted: its PTN and its play-out's moves turned back (back), times whole.
function postMove(m, back) {
  const { po, ...rest } = m, out = { ...rest, ...(m.ptn ? { ptn: back(m.ptn) } : {}), ...(m.path ? { path: m.path.map(back) } : {}) };
  if (out.checkMs != null) out.checkMs = Math.round(out.checkMs);
  if (out.paused != null) out.paused = Math.round(out.paused);
  if (po) out.po = { proven: !!po.proven, cap: po.cap, end: po.end ?? null, paused: Math.round(po.paused || 0), line: po.line.map((x) => ({ m: back(x.m), ms: Math.round(x.ms) })) };
  return out;
}

// ---------- timing data, for calibrating puzzle difficulty (server/rush.js rush_moves) ----------
// Per puzzle c: c.mv, the move the board is waiting for ({ t0: when the board took input, first: the first tap, click
// or key toward it, held: Confirm moves' hold }), and c.moves, those made: { first, ms, held?, weight, correct } in whole
// ms from t0. performance.now() times throughout.
export function openMove(c, t0) { c.moves ||= []; c.mv = { t0, first: null, held: null }; }
export function touchMove(c, now) { if (c?.mv && c.mv.first == null && now >= c.mv.t0) c.mv.first = now; }
export function holdMove(c, now) { if (c?.mv && c.mv.held == null) c.mv.held = now; }
// correct null: a move off the line, being adjudicated (rush.js): open until decide() says which (an open move left
// with the run is posted as open, neither right nor wrong).
export function closeMove(c, now, weight, correct, ptn = null) {
  const m = c.mv, t0 = m ? m.t0 : now, d = (t) => Math.max(0, Math.round(Math.min(t, now) - t0));
  (c.moves ||= []).push({ first: m?.first != null ? d(m.first) : null, ms: d(now), ...(m?.held != null ? { held: d(m.held) } : {}), weight,
    ...(correct == null ? { correct: false, open: true } : { correct }), ...(ptn ? { ptn } : {}) });
  c.mv = null;
}
// The adjudicated move once decided: right or wrong, and no longer open.
export function decide(c, correct) {
  const m = c.moves?.findLast((x) => x.open);
  if (m) { m.correct = correct; delete m.open; }
  return m;
}
// Whether the board takes a move now: not during the intro, the reply beat, or a pause (c.ready is Infinity while the
// engine works: rush.js), and not while a move is being adjudicated outside a play-out's turn.
export const takesMove = (c, now) => !!c && now >= c.ready && !(c.adj && !c.adj.turn);
// The trajectory of the move just made, once the run has counted it (after correct / wrong): at, whole ms from the
// run's clock start (its first move), and in Rush the clock left with any bonus or penalty applied.
// at: when the move was made, if earlier than now (an adjudicated move is stamped once decided, its at still the move's).
export function stampMove(c, run, now, at = now) {
  const m = c.moves?.at(-1);
  if (!m || run.startedAt == null) return;
  m.at = Math.max(0, Math.round(at - run.startedAt));
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
// (cur: the puzzle on the board; a move on it being adjudicated counts, though not decided yet)
export const canAbandon = (run, cur = null) => !run.over && (run.moves > 0 || !!cur?.adj);
// A Rush whose clock had already run out (a tab hidden or closed past it) is no abandoned run but a finished one: it
// ends where its clock did, without the puzzle open then (as any time-out), and null when nothing was finished, so it
// never replaces a queued snapshot with a body the server would refuse as too long. wall: Date.now() at `now`, for
// playedAt (when the run ended, wall clock).
export function abandonBody(run, cur, now, build = 0, env = null, wall = null) {
  const r = { ...run, results: [...run.results] };
  // (a move still being adjudicated goes as open, with the engine time paused on it so far: its pause is running, and
  // is credited as resume would, within the move's bound, the rest on the clock; a play-out going on ends 'left', or
  // 'time' if the clock ran out over a frozen page's pause, the pause its own too)
  const open = cur?.moves?.findLast((m) => m.open), hidden = !!cur?.hidden;
  const running = run.pausedAt != null && open ? Math.max(0, Math.min(now - run.pausedAt, pauseMax(open, hidden) - (open.paused || 0))) : 0;
  r.pausedMs += running; r.pausedAt = null;
  const out = expired(r, now);
  const mv = cur?.moves?.map((m) => {
    if (m !== open) return m;
    const po = m.po && (m.po.end == null || m.po.end === 'left') ? { ...m.po, end: out ? 'time' : 'left', paused: (m.po.paused || 0) + running } : m.po;
    return { ...m, paused: (m.paused || 0) + running, ...(po ? { po } : {}) };
  });
  if (out) { closeOpen(r, cur && { ...cur, moves: mv }); if (!r.results.length) return null; } else {
    if (mv?.length) r.results.push({ id: cur.p.id, rating: cur.p.rating, solved: false, unfinished: true, ms: now - cur.born, mv, hidden, ...(cur.p.sym != null ? { sym: cur.p.sym } : {}) });
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
    mv: cur.moves || [], hidden: !!cur.hidden, at: [...(cur.line || [])], clock: 0, combo: run.combo, ...(cur.p.sym != null ? { sym: cur.p.sym } : {}),
    ...(cur.adj ? { played: cur.adj.canon, ...(cur.adj.look ? { po: cur.adj.look } : {}) } : {}) });
  return run;
}
// A result's mark on the end screen's cards: the glyph, its colour, its word for screen readers, and the text after it
// (a word, or the move played: a miss's, or a play-out's that was lost).
export function resultMark(r) {
  if (r.skipped) return { cls: 'muted', glyph: '–', sr: 'skipped', text: 'skipped' };
  if (r.unfinished) return { cls: 'muted', glyph: '·', sr: 'unfinished', text: 'unfinished' };
  if (r.solved) return { cls: 'good', glyph: '✓', sr: 'solved', text: 'solved' };
  return { cls: 'bad', glyph: '✗', sr: 'failed, played', text: r.wrong || r.played || '' };
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
// name: the side in a word (text, the line under the board and what is said, starts with it).
export function turn(solver, prev = null) {
  const white = solver === 1, name = white ? 'White' : 'Black';
  return { color: white ? 'white' : 'black', name, text: `${name} to play.`, changed: prev != null && prev !== solver };
}
// The line under the board. While a move is adjudicated: the puzzle page's card heading and status (adj). Otherwise
// the side to move comes first, always: a player reads it before anything else, and the last puzzle's ending (head,
// after a play-out) follows it, named as the last puzzle's, never in front of it (Discord, 2026-11-21: "a bunch of
// text that appears before the actually important info of who is to play").
export function noteText({ toMove = '', head = null, adj = null, waiting = false }) {
  if (adj) return adj;
  if (head) return `${toMove} Last puzzle: ${head}.`;
  return waiting ? `${toMove} The clock starts with your first move.` : toMove;
}
// The puzzle just finished, as Storm shows it: a mark and its rating (whole; ratings are stored as reals).
export function lastText(r) {
  if (!r) return null;
  const n = Math.round(r.rating);
  if (r.skipped) return { text: `Skipped ${n}`, cls: 'skip', label: `Last puzzle skipped, rated ${n}` };
  return r.solved ? { text: `✓ ${n}`, cls: 'good', label: `Last puzzle solved, rated ${n}` }
    : { text: `✗ ${n}`, cls: 'bad', label: `Last puzzle failed, rated ${n}` };
}
// What a screen reader hears once per puzzle (rush.js say()), in the order the screen shows it: whose turn it is next
// first (as the line under the board), then the last puzzle's ending after a play-out (head, as that line), then the
// result (lastText's) and in Rush the time it moved the clock by. At the run's end there is no next: the ending, the
// result, how the run ended. bonus: ms gained on the puzzle (0 or more).
// 'Black to play. Solved. 3 seconds added.' · 'White to play. Wrong. 10 seconds lost.' · 'Wrong. Streak over.'
export function sayText({ r = null, mode, bonus = 0, next = null, over = false, head = null }) {
  const v = lastText(r), rush = mode === 'rush';
  const parts = v ? [{ good: 'Solved.', bad: 'Wrong.', skip: 'Skipped.' }[v.cls]] : [];
  if (v && rush && v.cls === 'good' && bonus > 0) parts.push(`${bonus / 1000} seconds added.`);
  if (v && rush && v.cls === 'bad') parts.push(`${WRONG_MS / 1000} seconds lost.`);
  if (over) return [head ? `${head}.` : null, ...parts, rush ? 'Time’s up.' : 'Streak over.'].filter(Boolean).join(' ');
  return [next, head ? `Last puzzle: ${head}.` : null, ...parts].filter(Boolean).join(' ');
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
// The end screen's line for a new best (the post's newBest): plain, and no "score", which Streak doesn't have.
export const newBestText = (nb) => ({ all: 'New all-time best', week: 'New best this week', today: 'New best today' })[nb] ?? '';
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
// One row of the list, looked back at. A miss shows the position it was made in (the start, for a miss on the first
// move), so the player sees the side and the squares they had; a solve or a skip shows the start and its first move.
// r: the run's result with `at`, the moves accepted before the miss (rush.js keeps it; it isn't posted), and
// `answer` when already known (a stored run keeps it, not the puzzle's tree).
// Returns { size, toMove, cells (rank size first, file a first: { sq, stack: the whole stack, bottom first,
// [{ color, type }] }), you (what was played, '' for a solve), want (the puzzle's move), and for the end screen's picture
// (rush-look.js): tint ({ sqs, prim }: the squares the board tints for the move that led to the position, as board.js
// stepSnap marks them; null: none) and marks ([{ shape (analysis.js moveShape), role: 'bad' | 'good', color: the stone a
// placement would be }], the move played when wrong, then the puzzle's move) }. Squares are named in the position's own
// labels: those the run showed it in.
// A move adjudicated off the line (played: the move; po: how its play-out went, playOutLook) shows the position it was
// played in and how the game ended, solved or not.
export function review(p, r) {
  const off = r.played != null;
  const at = off ? r.at || [] : r.solved || r.skipped ? [] : r.at || [];
  const g = startGame(p, at), answer = r.answer !== undefined ? r.answer : answerAt(p, at), n = p.size, cells = [];
  for (let row = n - 1; row >= 0; row--) for (let col = 0; col < n; col++) {
    const sq = row * n + col;
    cells.push({ sq: g.sqName(sq), stack: g.board[sq].map((x) => ({ color: colorOf(x), type: typeOf(x) })) });
  }
  const after = at.length ? `After ${at.join(' ')}, ` : '';
  const you = off ? (r.unfinished ? `${after ? after + 'you' : 'You'} played ${r.played}${r.po ? ` (move ${r.po.n} of ${r.po.cap})` : ''}; time ran out` : (after ? after + 'y' : 'Y') + 'ou played ' + r.played + '. ' + gameText(r.po, r.played, r.solved) + '.')
    : r.solved ? '' : r.skipped ? 'Skipped' : r.unfinished ? (at.length ? `After ${at.join(' ')}, time ran out` : 'Time ran out')
    : (at.length ? `After ${at.join(' ')}, you played ` : 'You played ') + (r.wrong || '?');
  const want = !answer ? '' : (r.solved && !off) || r.skipped ? `The first move was ${answer}` : off && r.solved ? `The puzzle’s line plays ${answer}` : `The move was ${answer}`;
  const led = at.length ? at.at(-1) : p.last; // the move that led here (none: no game on record)
  // (a move off the line that won is the one marked good: the line's own move is only named)
  const bad = off && !r.solved ? r.played : r.solved || r.skipped ? null : r.wrong, good = off && r.solved ? r.played : answer;
  const shape = (m, game) => { try { return m ? moveShape(m, n, game) : null; } catch { return null; } };
  const ls = shape(led, new Game(n)), tint = !ls ? null : ls.kind === 'place' ? { sqs: [ls.sq], prim: [ls.sq] }
    : { sqs: [ls.from, ...ls.drops.map((d) => d.sq)], prim: ls.drops.map((d) => d.sq) };
  const marks = [[bad, 'bad'], [good, 'good']].map(([m, role]) => ({ shape: shape(m, g), role, color: g.toMove })).filter((x) => x.shape);
  return { size: n, toMove: g.toMove, cells, tint, marks, you, want };
}

// ---------- Rush's words for a play-out ----------
// Its own since 2026-11-21: the puzzle page's play-outs went over to the Tak rule (shared/judge.js), whose words are
// playon-copy.js's; Rush keeps the move cap, and these words with it, until its server takes longer play-outs.
// What the look-back and the run screen keep of a play-out: { end (its kind), engine ('Syntaks' | 'Tiltak'), proven,
// n (the player's moves in it, counting the move played out), cap, byYou (the last ply was the player's) }.
export const playOutLook = (po, engine) => ({ end: po.end, engine, proven: !!po.proven, n: po.mine, cap: po.cap, byYou: po.line.length % 2 === 1 });
// Rush's turn line while a move is adjudicated (a: rush.js c.adj): the check's heading while it runs or decides (a wait,
// also after a game no engine could answer), else the play-out's heading and status line.
export function adjHead(a, engine) {
  if (!a.po || a.phase === 'wait') return cardHead(a.phase === 'wait' ? 'wait' : 'checking', { move: a.canon });
  return `${cardHead('play', { proven: a.po.proven, late: a.po.provedLate })}. ${playOutStatus(a.po, engine)}`;
}
// The heading for each state, as Rush's turn line shows it.
export function cardHead(state, { move = '', proven = false, late = false } = {}) {
  if (state === 'checking') return `Checking ${move}`;
  if (state === 'wait') return `Checking ${move}`;
  return proven ? (late ? 'Proved: play it out' : 'That wins: play it out') : 'Play it out';
}
// The card's status line in a play-out: move n of cap, the defender thinking, or a wait at the cap.
export function playOutStatus(po, engine) {
  if (po.waiting === 'length') return `Out of moves at ${po.cap} unless the proven win is longer: measuring it…`;
  if (po.waiting === 'proof') return `Out of moves at ${po.cap} unless ${po.miss} is proven to win: still checking…`;
  return `Move ${po.thinking ? po.mine : po.mine + 1} of ${po.cap}${po.thinking ? ` · ${engine} is thinking…` : ''}`;
}
// How it ended, as a heading says it after a lost game, or a solve's words.
export function endingHead(look, move) {
  if (!look) return '';
  const E = look.engine, how = look.end;
  if (how === 'win' || how === 'proved') return look.proven && how !== 'proved' ? `${move} forces a win, and you played it out against ${E}, so it counts as solved`
    : how === 'win' ? `${move} won against ${E}, so it counts as solved` : `${move} forces a win too, so it counts as solved`;
  if (how === 'gaveup' || how === 'left') return 'You gave up';
  if (how === 'out') return 'Out of moves';
  if (how === 'road') return look.byYou ? `Your move completed ${E}’s road` : `${E} made a road`;
  if (how === 'noengine') return 'No engine could answer';
  return `${E} held`;
}
// The look-back's sentence for a move adjudicated off the line: how a lost game went, a solve's words
// after a win. look null: decided without a play-out (a proof where no
// proven play-out is played, or no engine to defend: the check decided).
export function gameText(look, move, solved) {
  if (!look) return solved ? `${move} forces a win too, so it counts as solved` : `${move} doesn’t force the win`;
  const how = look.end, E = look.engine, mv = `${look.n} move${look.n === 1 ? '' : 's'}`;
  if (how === 'win' || how === 'proved' || solved) return endingHead({ ...look, end: how === 'noengine' ? 'proved' : how }, move);
  if (how === 'gaveup' || how === 'left') return `You gave up on ${move} after ${mv}`;
  if (how === 'noengine') return `${move} doesn’t force the win: no engine could answer`;
  if (look.proven) return { unfinished: `${move} wins, but you didn’t finish it in ${mv}: ${E} held`, escaped: `${move} wins, but ${E} got out of it after ${mv}`,
    'own-road': `${move} wins, but your move ${look.n} completed ${E}’s road` }[provenLossLead(how, look.byYou)];
  return `${E} defended ${move} for ${mv}`;
}

// ---------- this browser's history of runs (local only: never posted, not tied to an account) ----------
// A finished run as stored: { v, t (ms, when it ended), mode, score, sum (summary), puzzles: [{ id, rating, solved,
// skipped?, ms, wrong?, at?, answer, size, tps, komi, last?, sym? }] }: each puzzle carries what the look-back draws from
// (its start, the moves before a miss, the puzzle's move there), not its tree, and the symmetry it was shown under (so
// its link opens the puzzle page as the player saw it: puzzleLink). Runs stored before 2026-11-19 have no sym. The newest HIST_MAX, in HIST_CHARS of
// JSON (about 400 kB as stored), newest first.
export const HIST_V = 1, HIST_MAX = 30, HIST_CHARS = 400e3;
export function recordOf(run, puzzles, t) {
  const byId = new Map(puzzles.map((p) => [p.id, p]));
  return { v: HIST_V, t, mode: run.mode, score: run.score, sum: summary(run), puzzles: run.results.map((r) => {
    const p = byId.get(r.id) || {}, at = r.played != null ? r.at || [] : r.solved || r.skipped ? [] : r.at || [];
    let answer = null;
    try { answer = answerAt(p, at); } catch {}
    // (as the player saw it: p is the puzzle under its symmetry, and so is the puzzle page its link opens)
    const sym = r.sym ?? p.sym;
    return { id: r.id, rating: Math.round(r.rating), solved: r.solved, ...(r.skipped ? { skipped: true } : {}), ms: Math.round(r.ms),
      ...(r.wrong ? { wrong: r.wrong, at } : {}), ...(r.unfinished ? { unfinished: true, at } : {}), ...(r.played != null ? { played: r.played, at, ...(r.po ? { po: r.po } : {}) } : {}),
      answer, size: p.size, tps: p.tps, komi: p.komi || 0, ...(p.last ? { last: p.last } : {}),
      ...(SYM.SYMS.includes(sym) ? { sym } : {}) };
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
    && (q.answer === null || str(q.answer, 24)) && (q.last === undefined || str(q.last, 24))
    && (q.played === undefined || str(q.played, 24)) && (q.po === undefined || validLook(q.po))
    && (q.sym === undefined || SYM.SYMS.includes(q.sym));
}
const ENDS = new Set(PO_ENDS);
const validLook = (l) => !!l && typeof l === 'object' && (l.end === null || ENDS.has(l.end)) && (l.engine === 'Syntaks' || l.engine === 'Tiltak')
  && typeof l.proven === 'boolean' && Number.isInteger(l.n) && Number.isInteger(l.cap) && typeof l.byYou === 'boolean';
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

// ---------- a stored puzzle's link to the puzzle page ----------
// The puzzle page under the symmetry the run showed it in (app.js reads #/puzzle/<id>/<s>: public/pagesym.js), s = 0
// too: an explicit /0 opens the puzzle unturned even while a turned visit of it is on screen (a plain link returns to
// that visit as it stands). A record without sym (stored before records kept it) links plainly; rush.js then leaves
// the page a note (lookFrom) so the page can work the symmetry out (symFromRecord).
export const puzzleLink = (q) => '#/puzzle/' + encodeURIComponent(q.id) + (SYM.SYMS.includes(q.sym) ? '/' + q.sym : '');
// What the puzzle page needs to recognise a stored puzzle's picture: its start, the move before it, the line up to the
// answer shown, and that answer (all in the run's labels).
export const lookFrom = (q) => ({ id: q.id, tps: q.tps, ...(q.last ? { last: q.last } : {}), at: q.at || [], answer: q.answer ?? null });
// The symmetry a stored puzzle without one was shown under, from the puzzle as the server sends it (p: tps, tree,
// meta.history) and the record's lookFrom: the symmetries that turn the puzzle's start into the record's, then (a
// symmetric start draws the same picture under several, labelled differently) the one whose last move matches, then
// whose tree replays the record's line (each move of the solver's a branch of it, each reply the one it names: the
// line tells two mirror-equivalent replies apart where the answer alone cannot), then whose answer matches, the
// smallest first. 0 when none does (a record from before Rush's symmetries, or a puzzle revised since).
export function symFromRecord(p, look) {
  const norm = (t) => { try { return Game.fromTPS(t).toTPS(); } catch { return null; } };
  const want = norm(look?.tps);
  if (!p || !want || typeof p.tps !== 'string') return 0;
  const last = Array.isArray(p.meta?.history) ? p.meta.history.at(-1) : null;
  const fits = SYM.SYMS.filter((s) => norm(SYM.tps(s, p.tps)) === want);
  const at = Array.isArray(look.at) ? look.at : [];
  const replays = (q) => {
    let node = q.tree;
    for (let i = 0; i < at.length; i += 2) {
      const e = node && node !== 'win' ? node[at[i]] : null;
      if (!e || (i + 1 < at.length && e.r !== at[i + 1])) return false;
      node = e.n;
    }
    return true;
  };
  const score = (s) => {
    let k = 0;
    if (look.last != null && typeof last === 'string' && SYM.move(s, p.size, last) === look.last) k += 4;
    try {
      const q = SYM.orient(p, s);
      if (at.length && replays(q)) k += 2;
      if (look.answer != null && answerAt(q, at) === look.answer) k += 1;
    } catch {}
    return k;
  };
  let best = 0, top = -1;
  for (const s of fits) { const k = score(s); if (k > top) { best = s; top = k; } }
  return best;
}

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
