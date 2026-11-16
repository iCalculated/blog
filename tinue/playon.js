// Play on: a move the still-wins check couldn't decide in time is played out on the board against an engine defending
// (Shy, 2026-11-15). The rules that don't need the page live here, so they can be tested (scripts/test-playon.mjs).

// How many of your moves you get, counting the move being played out. The puzzle had `pliesLeft` plies to go at that
// node (an attacker node, so an odd number: your moves and the replies between them); you get those moves plus the
// larger of 3 moves and 30% of them, rounded up ("plus max of 3 and 30%", Shy).
//   5 moves left -> 8; 7 -> 10; 10 -> 13; 11 -> 15; 15 -> 20; a road-in-1 node (1 move) -> 4.
export function capMoves(pliesLeft) {
  const left = Math.max(1, Math.ceil(pliesLeft / 2));
  return left + Math.max(3, Math.ceil(0.3 * left - 1e-9));
}
export const capNote = (pliesLeft) => {
  const left = Math.max(1, Math.ceil(pliesLeft / 2)), extra = capMoves(pliesLeft) - left;
  return `The puzzle had ${left} of your moves left; you get ${extra} more (3, or 30% when that is more).`;
};

// Who defends: Syntaks on the server for 6×6 (any half-point komi it knows), else Tiltak in the browser where it plays
// (4×4–6×6). null: no engine for this board, so the move is handled as before play-on.
export function defender(size, komi, tiltakSupports) {
  if (size === 6 && Math.abs(komi) <= 3.5 && Number.isInteger(komi * 2)) return 'syntaks';
  return tiltakSupports(size, komi) ? 'tiltak' : null;
}

// How a game result ends play-on, for the player `solver`: their road or flat win, else the defender holds.
export const ending = (res, solver) => !res ? null : res.winner === solver ? 'win' : res.winner && res.kind === 'road' ? 'road' : 'held';

// Syntaks reports a forced win (mate, signed from White's side) for the player: it resigns.
export const resigns = (mate, solver) => mate != null && mate !== 0 && (mate > 0 ? 1 : 2) === solver;

// An engine's move, checked and canonical in this game; null if it isn't a legal move here.
export function legalMove(g, ptn) {
  if (typeof ptn !== 'string' || !ptn) return null;
  try {
    const c = g.canon(ptn);
    return g.legalMoves().some((m) => g.moveToPTN(m) === c) ? c : null;
  } catch { return null; }
}

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
// A win counts when the check proved it, or when Syntaks defended throughout (resigning counts as its move: it searched
// the position and found your forced win).
export const winRated = (po, how) => how === 'proved' || (po.engine === 'syntaks' && !po.fallback && (how === 'resign' || po.line.length >= 2));
// Whether a game ending now (kind, as endPlayOn gets it) is stalled: only the player leaving ('gaveup': Give up or
// Solution; 'left') while the defender has owed a reply for more than STALL_MS. The defender's own ending (its road,
// flats, a draw, resigning) never is, however slow the reply was, and neither is leaving once the reply is in hand
// (po.thinking is cleared as soon as a legal reply arrives, before the board animates it).
export const stalls = (po, kind, now) => (kind === 'gaveup' || kind === 'left') && !!po.thinking && now - po.thinkingSince > STALL_MS;

// What a held result (app.js heldRec) is sent as when a later page load finds it (flushHeld); null drops it unsent.
// h: { id, ms, win?, casual?, theme?, b, owner, page }. Dropped: a record of another account (owner: a hash of the
// token it was played under; after a logout or login it isn't this account's to send), or one whose page is still open
// (alive: a duplicated tab copies sessionStorage, and the original sends its own). Settled before the page went: as it
// was settled, under the build that settled it (the server's stale-miss guard reads it; no build, no trust). Never
// settled (the page died mid-check): the move was never decided, so an unrated miss.
export function heldResend(h, owner, alive) {
  if (!h?.id || alive || h.owner !== owner) return null;
  const result = typeof h.win === 'boolean' ? { win: h.win, ...(h.casual ? { casual: true } : { theme: h.theme }) } : { win: false, casual: true };
  return { build: +h.b || 0, body: { puzzleId: h.id, ...result, ms: h.ms } };
}
