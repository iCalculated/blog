// The judge (docs/plan/PLAN.md §1.2): one pure function from an attempt's state, one ply, and the facts the I/O layer
// gathered for that ply, to an answer. No I/O and no clock: the tree lookup, the book row, a prover's verdict,
// Syntaks's reply and the time `now` all come in through `inputs`, so any logged attempt can be judged again (I4).
// Called by server/move.js and server/shadow.js, both off by default (TINUE_JUDGE), never by /api/result or the client.
//
// The play-on rules below moved here unchanged from public/playon.js, which re-exports them, so the page behaves as
// before (scripts/test-playon.mjs).
import { winMove } from './pns.js?v=1795581795';

// ---- play-on rules (moved from public/playon.js) ----

// The Tak rule (Sasha, 2026-11-21, a player's proposal on Discord: "if move is Tak, continue; if move is not Tak, 2 move
// countdown. If Tak move comes in countdown, restart"; Sasha: no ceiling, "as long as you keep making Tak threats, it's
// okay"). It replaces the move cap on the puzzle page (Rush keeps capMoves until its server takes longer play-outs).
// Every move of the player's in the play-out, the move played out included, is Tak or not. A Tak move clears the
// countdown; one that isn't starts it (or runs it down): TAK_COUNTDOWN more moves to make Tak, and if none of those is
// Tak either, the play-out is over ('out') after the last of them. So quiet, quiet, quiet is out at the third; quiet,
// quiet, Tak goes on; Tak forever never runs out. Deliberately no ceiling, repetition rule or progress test (Sasha).
export const TAK_COUNTDOWN = 2;
// Tak: after the mover's move (g: the game after it, not over), the mover would win on their next move if the opponent
// did nothing: a road, or the flat count where a placement ends the game (winMove; the threats the prover searches).
export const isTak = (g, mover) => !!winMove(g, mover);
// po.quiet: how many of the player's moves in a row, up to the last, weren't Tak (0: the last was Tak). tak: the move
// just counted was Tak. A missing answer (not a boolean) counts as Tak: never evidence for running out (I2).
export function countTak(po, tak) { po.quiet = tak === false ? (po.quiet || 0) + 1 : 0; return po; }
// Out: the countdown ran down without a Tak move.
export const outOfTak = (po) => (po.quiet || 0) > TAK_COUNTDOWN;
// Moves left to make Tak while the countdown runs (2 right after a quiet move, then 1), else null (no countdown).
export const takLeft = (po) => (po.quiet > 0 && !outOfTak(po) ? TAK_COUNTDOWN + 1 - po.quiet : null);
// The defender's replies in a play-out go into the attempt's move log (app.js logMove) from 2026-11-21, as 'po' entries
// like the player's own, told apart by this PTN annotation on the move: the production server's log check
// (server.js cleanLog: kinds ok|slow|miss|view|hint|po, a move matching its PTN pattern, which allows a trailing
// [*'!?]) keeps them as they are, so no server change is needed, and Game.parseMove ignores the mark. Logs before
// that date hold the player's play-out moves only. replyEntry: the logged move; isReplyEntry: whether an entry is one.
export const REPLY_MARK = '!';
export const replyEntry = (m) => m + REPLY_MARK;
export const isReplyEntry = (e) => !!e && e.k === 'po' && typeof e.m === 'string' && e.m.endsWith(REPLY_MARK);
// Whether the play-out has run out of moves under its rule: po.rule 'tak' (the puzzle page) or the move cap (Rush).
export const outOfMoves = (po) => (po.rule === 'tak' ? outOfTak(po) : po.mine >= po.cap);
// A 'no' ends the play-out (Sasha, 2026-11-21, review point F2: "yeah we should terminate playout early on miss"). The
// check of the move played out answering 'no' (it doesn't force a win) while the play-out is still going ends it there
// as a miss, its ending 'refuted', rated exactly as any other ending without the player's win (lossRated: the game
// Syntaks defended counts, gameRated), so a 'no' no longer leaves unlimited rated tries at catching the engine out.
// Only under the Tak rule (the puzzle page; Rush keeps the cap and its own handling), only a live play-out (one already
// over keeps its ending), and never a proven one (a move proven to win is never refuted). 'unknown' (a timeout or a
// failure) is not a 'no' and changes nothing.
export const REFUTED = 'refuted';
export const endsOnNo = (po, verdict) => verdict === 'no' && !!po && po.rule === 'tak' && !po.end && !po.proven;

// The plies a puzzle had left at a tree node, for the cap: 1 at a 'win' node (road in 1), 0 past the tree, else 2 plus
// the longest line below. (book.js treeDepth is the book's own, stricter: it throws on a malformed tree.)
export const pliesLeftOf = (node) => (node === 'win' ? 1 : node == null || typeof node !== 'object' ? 0
  : 2 + Math.max(0, ...Object.values(node).map((v) => (v ? pliesLeftOf(v.n) : 0))));

// How many of your moves you get, counting the move being played out. The puzzle had `pliesLeft` plies to go at that
// node (an attacker node, so an odd number: your moves and the replies between them); you get those moves plus the
// larger of 3 moves and 30% of them, rounded up ("plus max of 3 and 30%", Shy).
//   5 moves left -> 8; 7 -> 10; 10 -> 13; 11 -> 15; 15 -> 20; a road-in-1 node (1 move) -> 4.
export function capMoves(pliesLeft) {
  const left = Math.max(1, Math.ceil(pliesLeft / 2));
  return left + Math.max(3, Math.ceil(0.3 * left - 1e-9));
}
// A proven play-out's cap. The spare moves (capMoves: 3, or 30%) apply once, to the moves the PUZZLE had left at the
// node where the move was played (Sasha, 2026-11-17: a proof's own length plus spare gave 8 moves where the puzzle had
// 2 left). The proof's length only acts as a floor, so a proven win is never out of reach: proofPlies is the proof's
// length after the move (defender to move, proofTreeLine), so the player's moves it takes, counting the move itself,
// are 1 + ⌈plies/2⌉ (proofMoves; the proof isn't minimal, so this can exceed the shortest win). The cap is the larger
// of capMoves(pliesLeft) and those moves, never smaller than `shown` (a cap already on screen is never lowered).
// proofPlies null: not known (yet), the usual cap (and running out is then unrated: lossRated / capWait).
//   left 3 plies (cap 5), proof 8 plies (5 moves) -> 5; proof 12 plies (7 moves) -> 7.
export const proofMoves = (proofPlies) => (Number.isFinite(proofPlies) && proofPlies >= 0 ? 1 + Math.ceil(proofPlies / 2) : null);
export function provenCap(pliesLeft, proofPlies, shown = 0) {
  return Math.max(shown, capMoves(pliesLeft), proofMoves(proofPlies) ?? 0);
}

// The boards Syntaks plays: 6×6 at any half-point komi it knows.
export const syntaksBoard = (size, komi) => size === 6 && Math.abs(komi) <= 3.5 && Number.isInteger(komi * 2);
// Who defends: Syntaks on the server for 6×6 (any half-point komi it knows), else Tiltak in the browser where it plays
// (4×4/5×5). null: no engine for this board, so the move is handled as before play-on. 6×6 is never Tiltak's, whatever
// tiltakSupports says (Sasha, 2026-11-21: no Tiltak on 6×6): a komi Syntaks doesn't know is null, as on 7×7.
export function defender(size, komi, tiltakSupports) {
  if (size === 6) return syntaksBoard(size, komi) ? 'syntaks' : null;
  return tiltakSupports(size, komi) ? 'tiltak' : null;
}

// How a game result ends play-on, for the player `solver`: their road or flat win, else the defender holds.
export const ending = (res, solver) => !res ? null : res.winner === solver ? 'win' : res.winner && res.kind === 'road' ? 'road' : 'held';

// Whether a play-on game counts toward rating (the main session's rule, 2026-11-15): only a game Syntaks defended
// throughout, where it made at least one move and the player didn't leave while it was overdue with a reply. Anything Tiltak
// defended (from the start on 4×4/5×5, or after Syntaks dropped out) is unrated both ways, and so is a game no defender
// ever moved in, or one left while Syntaks was stuck (STALL_MS). A proof that the move wins counts regardless (winRated).
// po: { engine, fallback, line, stalled } (line[0] is the player's move, so a defender move means line.length ≥ 2).
export const STALL_MS = 6000;
export const gameRated = (po) => po.engine === 'syntaks' && !po.fallback && !po.stalled && po.line.length >= 2;
// Why a game doesn't count, for the cards: 'nomove' (no defender moved), 'tiltak' (Tiltak defended from the start),
// 'dropped' (Syntaks dropped out for Tiltak), 'stalled' (left while Syntaks was overdue: stalls), or null when it counts.
export const unratedWhy = (po) => gameRated(po) ? null : po.line.length < 2 ? 'nomove' : po.engine !== 'syntaks' ? 'tiltak'
  : po.fallback ? 'dropped' : 'stalled';
// A win counts when the check proved it, or when Syntaks defended throughout. In a proven play-out (po.proven: the
// move was proven to win before or during the game, and the game only demonstrates it) the win always counts.
// (Syntaks never resigns: every game runs to a road, a flat win, the defender's win or the cap, "make people prove
// winning sequences", Shy 2026-11-16.)
export const winRated = (po, how) => how === 'proved' || !!po.proven
  || (po.engine === 'syntaks' && !po.fallback && po.line.length >= 2);
// Whether a game that ended without the player's win (kind, as endPlayOn gets it) is a rated miss. kind 'unload' is
// the page going away (pagehide: reload, closed tab); 'left' is moving on to another puzzle in the page. Running out
// of moves in a proven play-out whose proof length isn't known (po.proofPlies null) is unrated: the cap may not have
// covered the proof. So is running out when the proof arrived only once the moves had run out (po.provedAtOut: during
// the wait at the end, or after it while the check ran on): a move proven to win is never turned into a rated miss by
// running out before its proof was known (the checker's attack on the quiet allowance, 2026-11-21).
export const lossRated = (po, kind) => gameRated(po)
  && !(po.proven && (kind === 'unload' || (kind === 'out' && (po.proofPlies == null || po.provedAtOut))));
// Why such a game doesn't count, for the cards: unratedWhy's reasons, or 'proven-unload' (a proven play-out whose page
// went away), 'proven-late' (proven only once out of moves), 'proven-length'.
export const lossWhy = (po, kind) => lossRated(po, kind) ? null
  : po.proven && kind === 'unload' && gameRated(po) ? 'proven-unload'
  : po.proven && kind === 'out' && gameRated(po) ? (po.provedAtOut ? 'proven-late' : 'proven-length') : unratedWhy(po);
// Whether a game ending now (kind, as endPlayOn gets it) is stalled: only the player leaving ('gaveup': Give up or
// Solution; 'left' or 'unload') while the defender has owed a reply for more than STALL_MS. The defender's own ending (its road,
// flats, a draw) never is, however slow the reply was, and neither is leaving once the reply is in hand
// (po.thinking is cleared as soon as a legal reply arrives, before the board animates it).
export const stalls = (po, kind, now) => (kind === 'gaveup' || kind === 'left' || kind === 'unload') && !!po.thinking && now - po.thinkingSince > STALL_MS;

// ---- the judge ----

// Whether a rated defender (Syntaks) exists for this board: the play-out rows (4, 6, 7) apply.
export const defended = (size, komi) => defender(size, komi || 0, () => false) === 'syntaks';
// Puzzle statuses whose attempts are judged but never rated (row 15; the column arrives at P1/P3).
const UNRATED_STATUS = new Set(['paused', 'rejected']);
const ACTS = new Set(['hint', 'view', 'giveup', 'leave', 'unload', 'expire']);

// A fresh attempt. solver: the attacker (1 white, 2 black). first: no decided result of this user on this puzzle exists
// yet (Decision 15). status: the puzzle's status (row 15).
export function newAttempt({ size, komi = 0, solver, first = true, status = 'served' }) {
  return { size, komi: komi || 0, solver, defended: defended(size, komi), first: !!first, status: status || 'served',
    hintAt: null, plies: [], playout: null };
}

// The attempt's result under I6: set once, by the earliest ply (in ply order) with a decisive verdict. A pending ply
// blocks every later ply from deciding. Hint status is taken as of the deciding ply.
//   { state: 'open' } | { state: 'blocked', ply } | { state: 'decided', ply, outcome, rated, unratedWhy, evidence }
export function result(a) {
  for (const p of [...a.plies].sort((x, y) => x.n - y.n)) {
    if (p.pending) return { state: 'blocked', ply: p.n };
    if (!p.outcome) continue;
    const why = !p.base ? (p.why || 'unrated') : !a.first ? 'repeat' : UNRATED_STATUS.has(a.status) ? a.status
      : a.hintAt != null && a.hintAt < p.n ? 'hint' : null;
    return { state: 'decided', ply: p.n, outcome: p.outcome, rated: !why, unratedWhy: why, evidence: p.evidence };
  }
  return { state: 'open' };
}

// judge(attempt, ply, inputs) -> answer. attempt is not changed; the answer carries the next state (`attempt`) and the
// attempt's result after this ply (`result`).
//   ply:  { n, move } a player move (canonical PTN, legal: checked by the caller)
//       | { n, act, seen? } act ∈ hint | view | giveup | leave | unload | expire; seen: replies shown (play-out stalls)
//       | { n, final }      the final verdict of the earlier ply n (a pending pns search, or a proof landing mid-game)
//   inputs (all optional; anything missing or malformed is undecided, never evidence for a miss: I2):
//     game   Game.result() right after the player's move ({ winner, kind } or null)
//     tree   { key: true, reply } when the move is a key at the node, for the rev the client loaded
//     left   plies left at the node (kept with the play-out; the puzzle page's play-outs have no cap now)
//     tak    whether the player's move makes Tak (isTak, from the game after it), for the Tak rule; missing: counts as Tak
//     book   { pos, ver, win_len, exact, checked } the book row of the position after the move
//     node   { pos, ver, model, refuted } the book_node verdict on the move
//     deep   { kind: 'proved', plies, checked: true } | { kind: 'disproved' | 'undecided', reason }   (6×6, live)
//     pns    { kind: 'wins', plies, fullDefense: true } | { kind: 'no' } | { kind: 'pending' } | { kind: 'undecided', reason }
//     fault  { reason } anything that failed on the way (rev unknown, book version unknown, queue, crash, ...)
//     reply  { move, game } Syntaks's reply in a play-out and Game.result() after it; anything else: none
//     hint   the hint's target, echoed
//     now    the server's receipt time of this ply (ms), for stalls
export function judge(attempt, ply, inputs = {}) {
  const a = structuredClone(attempt), inp = inputs || {};
  let ans;
  if (!ply || !Number.isInteger(ply.n)) ans = { verdict: 'ignored' };
  // Plies come in ply order: one numbered at or before a ply already judged (a replay, a reorder, a forged number)
  // changes nothing, so a decided result never moves to an earlier ply (I6).
  else if (!('final' in ply) && a.plies.some((p) => p.n >= ply.n)) ans = { verdict: 'stale' };
  else if ('final' in ply) ans = settle(a, ply.n, ply.final);
  else if (a.playout && !a.playout.end) ans = playoutPly(a, ply, inp);
  else if (ply.act != null) ans = act(a, ply, inp);
  else if (typeof ply.move === 'string' && ply.move) ans = move(a, ply, inp);
  else ans = { verdict: 'ignored' };
  return { ...ans, attempt: a, result: result(a) };
}

const isObj = (x) => !!x && typeof x === 'object';
const posInt = (x) => Number.isInteger(x) && x > 0;
const record = (a, p) => { a.plies.push(p); return p; };
const validBook = (b) => isObj(b) && typeof b.pos === 'string' && !!b.pos && Number.isInteger(b.ver)
  && (b.win_len == null || posInt(b.win_len));
// A game result as Game.result() gives it: null (going on), or { winner: 0|1|2, kind: 'road'|'flat'|'draw' } with
// winner 0 exactly for a draw. Anything else is malformed (BAD): never evidence (I2), so never an ending that rates.
const BAD = { bad: true };
const gameResult = (g) => g == null ? null
  : isObj(g) && !Array.isArray(g) && [0, 1, 2].includes(g.winner) && ['road', 'flat', 'draw'].includes(g.kind)
    && (g.winner === 0) === (g.kind === 'draw') ? g : BAD;
const undecided = (inp, fallback) => ({ kind: 'undecided', reason: inp.fault?.reason || fallback });

// A player move outside a play-out: contract rows 1-11.
function move(a, ply, inp) {
  const n = ply.n, g = gameResult(inp.game);
  if (g === BAD) return closeUndecided(a, ply, { kind: 'undecided', reason: 'game' });
  const won = !!g && g.winner === a.solver;
  // Row 2 (a win by the rules; a key that wins is the same solve) and row 3 (the game ends without the player's win).
  if (won) {
    const evidence = { kind: inp.tree?.key === true ? 'tree' : 'rules' };
    record(a, { n, move: ply.move, verdict: 'solved', outcome: 'solved', base: true, evidence });
    return { verdict: 'solved', evidence };
  }
  if (g) {
    const evidence = { kind: 'rules', winner: g.winner, how: g.kind };
    record(a, { n, move: ply.move, verdict: 'missed', outcome: 'missed', base: true, evidence });
    return { verdict: 'missed', evidence };
  }
  // Row 1: a key at the node. (A key never ends the game without a win: app.js takes keys only while !res.)
  if (inp.tree?.key === true) {
    record(a, { n, move: ply.move, verdict: 'ok', outcome: null, evidence: { kind: 'tree' } });
    return { verdict: 'ok', reply: typeof inp.tree.reply === 'string' ? inp.tree.reply : null };
  }
  const fault = isObj(inp.fault);
  const book = !fault && validBook(inp.book) ? inp.book : null;
  if (a.defended) {
    // Rows 4, 6, 7: played out against Syntaks. A disproof never rates here (Decision 4).
    if (!posInt(inp.left)) return closeUndecided(a, ply, undecided(inp, 'left'));
    if (book) {
      const plies = book.exact === 1 || book.exact === true ? book.win_len ?? null : null;
      return startPlayout(a, ply, inp, true, plies,
        { kind: 'book', pos: book.pos, ver: book.ver, win_len: book.win_len ?? null, checked: !!book.checked });
    }
    const d = !fault && isObj(inp.deep) ? inp.deep : null;
    if (d?.kind === 'proved' && d.checked === true) {
      return startPlayout(a, ply, inp, true, Number.isFinite(d.plies) && d.plies >= 0 ? d.plies : null, { kind: 'prover', src: 'deep' });
    }
    const evidence = undecided(inp, d?.kind === 'disproved' ? 'disproof' : d?.reason || (d ? 'unchecked' : 'noprover'));
    const refutation = d?.kind === 'disproved' ? { src: 'deep' } : isObj(inp.node) && inp.node.refuted === true ? { src: 'node' } : null;
    return { ...startPlayout(a, ply, inp, false, null, evidence), ...(refutation ? { refutation } : {}) };
  }
  // Not defended: rows 5, 8-11.
  if (fault) return closeUndecided(a, ply, undecided(inp));
  if (book) return decide(a, ply, 'solved', true, { kind: 'book', pos: book.pos, ver: book.ver, win_len: book.win_len ?? null, checked: !!book.checked });
  const nd = isObj(inp.node) ? inp.node : null;
  if (nd && nd.model === 'full' && nd.refuted === true && typeof nd.pos === 'string' && Number.isInteger(nd.ver)) {
    return decide(a, ply, 'missed', true, { kind: 'refuted-full', pos: nd.pos, ver: nd.ver });
  }
  const pns = isObj(inp.pns) ? inp.pns : null;
  if (pns?.kind === 'wins' && pns.fullDefense === true) return decide(a, ply, 'solved', true, { kind: 'prover', src: 'pns' });
  if (pns?.kind === 'no') return decide(a, ply, 'missed', true, { kind: 'refuted-threat', src: 'pns' });
  if (pns?.kind === 'pending') {
    record(a, { n, move: ply.move, verdict: 'pending', outcome: null, pending: true, evidence: { kind: 'prover', src: 'pns' } });
    return { verdict: 'pending' };
  }
  return closeUndecided(a, ply, undecided(inp, pns?.reason || (pns ? 'garbage' : 'noprover')));
}

function decide(a, ply, outcome, base, evidence, why) {
  record(a, { n: ply.n, move: ply.move, act: ply.act, verdict: outcome, outcome, base, evidence, ...(why ? { why } : {}) });
  return { verdict: outcome, evidence };
}
// Failure is not evidence (I2): the move goes in as an unrated miss (today's "unchecked"), never a rated one.
const closeUndecided = (a, ply, evidence) => decide(a, ply, 'missed', false, evidence, 'undecided');

function startPlayout(a, ply, inp, proven, proofPlies, evidence) {
  const left = inp.left;
  // The Tak rule (no cap): the move played out is counted like every later one.
  const po = a.playout = countTak({ at: ply.n, engine: 'syntaks', fallback: false, line: [ply.move], proven, proofPlies,
    left, rule: 'tak', cap: null, mine: 1, replies: 0, owedSince: null, end: null, stalled: false }, inp.tak);
  // The move's verdict is the play-out's ending (I6: it decides as of this ply).
  record(a, { n: ply.n, move: ply.move, verdict: 'play', outcome: null, pending: true, evidence });
  const r = defenderReply(a, po, inp);
  return { verdict: 'play', cap: po.cap, proven, ...r };
}

// Syntaks's reply in a play-out (inputs.reply). None (unavailable, illegal, garbage): a proven play-out is solved
// (app.js:961), an unproven one ends 'noengine', unrated (app.js:975; no Tiltak fallback on the server).
function defenderReply(a, po, inp) {
  const r = isObj(inp.reply) && typeof inp.reply.move === 'string' && inp.reply.move ? inp.reply : null;
  if (!r) return endPlayout(a, po.proven ? 'proved' : 'noengine');
  // A malformed result after the reply (I2): the reply is unusable, as if none came (proven: solved; else unrated).
  const rg = gameResult(r.game);
  if (rg === BAD) return endPlayout(a, po.proven ? 'proved' : 'invalid');
  po.line.push(r.move); po.replies++; po.owedSince = Number.isFinite(inp.now) ? inp.now : null;
  const end = ending(rg, a.solver);
  if (end) return { reply: r.move, ...endPlayout(a, end) };
  return { reply: r.move };
}

// A ply inside a live play-out.
function playoutPly(a, ply, inp) {
  const po = a.playout;
  if (ply.act != null) {
    const kind = { giveup: 'gaveup', view: 'gaveup', leave: 'left', unload: 'unload', expire: 'expired' }[ply.act];
    if (ply.act === 'hint') { a.hintAt ??= ply.n; return { verdict: 'hint', hint: inp.hint ?? null }; } // (no Hint in a play-out today)
    if (!kind) return { verdict: 'ignored' };
    // Owed: a reply the client hasn't shown (seen < replies), counted from the server's receipt of the player's ply.
    // No time to compare: as if overdue (a missing clock never makes a rated miss).
    const thinking = !(Number.isInteger(ply.seen) && ply.seen >= po.replies);
    const now = Number.isFinite(inp.now) ? inp.now : Infinity, since = po.owedSince ?? -Infinity;
    if (stalls({ thinking, thinkingSince: since }, kind, now)) po.stalled = true;
    a.plies.push({ n: ply.n, act: ply.act, verdict: kind, outcome: null });
    return endPlayout(a, kind);
  }
  if (typeof ply.move !== 'string' || !ply.move) return { verdict: 'ignored' };
  po.line.push(ply.move); po.mine++; countTak(po, inp.tak);
  a.plies.push({ n: ply.n, move: ply.move, verdict: 'reply', outcome: null });
  const pg = gameResult(inp.game);
  if (pg === BAD) return endPlayout(a, 'invalid');
  const end = ending(pg, a.solver);
  if (end) return endPlayout(a, end);
  if (outOfMoves(po)) return endPlayout(a, 'out'); // (the caller waits for a proof first: capWait, playon.js)
  return { verdict: 'reply', ...defenderReply(a, po, inp) };
}

// The play-out's ending decides its first ply (the move played out): playon.js's rated rules.
function endPlayout(a, kind) {
  const po = a.playout, p = a.plies.find((x) => x.n === po.at);
  po.end = kind;
  const win = kind === 'win' || kind === 'proved';
  // 'invalid': a malformed game result in the play-out (I2): an unrated miss, like 'noengine'.
  const unrated = kind === 'noengine' || kind === 'expired' || kind === 'invalid';
  const base = win ? winRated(po, kind) : unrated ? false : lossRated(po, kind);
  const why = base ? null : win ? unratedWhy(po) : unrated ? kind : lossWhy(po, kind);
  Object.assign(p, { pending: false, outcome: win ? 'solved' : 'missed', base, ...(why ? { why } : {}),
    evidence: { ...p.evidence, playout: { why: kind, proven: !!po.proven, mine: po.mine, cap: po.cap, quiet: po.quiet, line: [...po.line] } } });
  return { verdict: win ? 'solved' : 'missed', why: kind, cap: po.cap };
}

// An act outside a play-out: rows 12-14.
function act(a, ply, inp) {
  if (!ACTS.has(ply.act)) return { verdict: 'ignored' };
  if (ply.act === 'hint') {
    a.hintAt = a.hintAt == null ? ply.n : Math.min(a.hintAt, ply.n);
    a.plies.push({ n: ply.n, act: 'hint', verdict: 'hint', outcome: null });
    return { verdict: 'hint', hint: inp.hint ?? null };
  }
  if (ply.act === 'view' || ply.act === 'giveup') return decide(a, ply, 'missed', true, { kind: ply.act });
  // leave / unload / expire: an undecided attempt with a move in it closes unrated; one without a move records nothing.
  if (!a.plies.some((p) => p.move)) { a.plies.push({ n: ply.n, act: ply.act, verdict: 'left', outcome: null }); return { verdict: 'left' }; }
  return decide(a, ply, 'missed', false, { kind: 'act', act: ply.act }, ply.act === 'expire' ? 'expired' : 'left');
}

// The final verdict of an earlier pending ply (row 11), or a proof landing in a live unproven play-out (it becomes a
// proven play-out, as makeProven does; the game goes on; with the Tak rule there is no cap to raise), or a 'no' landing
// in one (it ends there, 'refuted', as app.js does: endsOnNo). Plies are judged in the order they come, so a win
// judged before the 'no' stands (the play-out is over by then, and the 'no' is stale).
function settle(a, n, final) {
  const f = typeof final === 'string' ? { kind: final } : isObj(final) ? final : {};
  const kind = f.kind === 'wins' && (f.fullDefense === true || f.checked === true) ? 'wins'
    : f.kind === 'no' || f.kind === 'tiltak-win' || f.kind === 'tiltak-loss' ? f.kind : 'unknown';
  const p = a.plies.find((x) => x.n === n && x.pending);
  if (!p) return { verdict: 'stale' };
  const po = a.playout;
  if (po && po.at === n) {
    if (endsOnNo(po, kind)) return endPlayout(a, REFUTED);
    if (po.end || po.proven || kind !== 'wins') return { verdict: 'noted' }; // an unknown (or a 'no' outside the Tak rule): the game decides
    po.proven = true;
    if (Number.isFinite(f.plies) && f.plies >= 0) { po.proofPlies = f.plies; if (po.rule !== 'tak') po.cap = provenCap(po.left, f.plies, po.cap); }
    p.evidence = { kind: 'prover', src: f.src || 'pns', late: true };
    return { verdict: 'proven', cap: po.cap };
  }
  const set = (outcome, base, evidence, why) => { Object.assign(p, { pending: false, outcome, base, evidence, ...(why ? { why } : {}) }); return { verdict: outcome, ply: n, evidence }; };
  if (kind === 'wins') return set('solved', true, { kind: 'prover', src: f.src || 'pns' });
  if (kind === 'no') return set('missed', true, { kind: 'refuted-threat', src: f.src || 'pns' });
  if (kind === 'tiltak-win') return set('solved', false, { kind: 'playout', engine: 'tiltak' }, 'tiltak');
  if (kind === 'tiltak-loss') return set('missed', false, { kind: 'playout', engine: 'tiltak' }, 'tiltak');
  return set('missed', false, { kind: 'undecided', reason: f.reason || 'unknown' }, 'undecided');
}
