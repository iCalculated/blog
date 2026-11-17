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
// A proven play-out's cap must cover its proof, which can be longer than the puzzle's own line (a proof has no length
// bound): proofPlies is the proof's length after the move (defender to move, proofTreeLine), so the player's moves it
// takes, counting the move itself, are 1 + ⌈plies/2⌉, and the cap is the larger of the usual one and those moves plus
// the same margin (3, or 30%). proofPlies null: not known (yet), the usual cap. Never smaller than `shown`.
export const proofMoves = (proofPlies) => (Number.isFinite(proofPlies) && proofPlies >= 0 ? 1 + Math.ceil(proofPlies / 2) : null);
export function provenCap(pliesLeft, proofPlies, shown = 0) {
  const pm = proofMoves(proofPlies);
  return Math.max(shown, capMoves(pliesLeft), pm == null ? 0 : pm + Math.max(3, Math.ceil(0.3 * pm - 1e-9)));
}
// The cap's explanation (the card's tooltip), true for whichever bound set it.
export function provenCapNote(pliesLeft, proofPlies) {
  const pm = proofMoves(proofPlies), cap = provenCap(pliesLeft, proofPlies);
  if (pm == null || cap === capMoves(pliesLeft)) return capNote(pliesLeft);
  return `The proven win takes ${pm} of your moves against the longest defence; you get ${cap - pm} more (3, or 30% when that is more).`;
}

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
// the position and found your forced win; only reachable with RESIGN_UNPROVEN). In a proven play-out (po.proven: the
// move was proven to win before or during the game, and the game only demonstrates it) the win always counts.
export const winRated = (po, how) => how === 'proved' || !!po.proven
  || (po.engine === 'syntaks' && !po.fallback && (how === 'resign' || po.line.length >= 2));

// ---- proven play-out (Shy, 2026-11-16: "Make people prove winning sequences! Just fine if they are slower";
// "Rated miss when defended. No play out w tiltak") ----
// A proven off-tree win isn't solved on the spot where Syntaks defends (6×6): it's played out to a road (or a flat
// win) within the cap. Its win is a full rated solve, however slow. Failing to finish it (out of moves, or Syntaks's
// road, flats or a draw) is a rated miss when Syntaks defended throughout (gameRated), and so are Give up, Solution
// and leaving for another puzzle, as in an ordinary play-on (else stopping would dodge the miss). Only the page going
// away (a reload, a closed tab, a crash: 'unload') is unrated in a proven play-out: that can happen to a phone through
// no fault of the player, and the move is proven. Against Tiltak there is no proven play-out:
// a proven win on 4×4/5×5 is solved on the spot (as on 7×7/8×8), and one whose Syntaks drops out mid-game, or a
// proof that arrives while Tiltak defends, ends as a solve then (app.js).
export const provenPlayOut = (engine) => engine === 'syntaks';
// RESIGN_UNPROVEN: whether Syntaks may resign an ordinary (unproven) play-on on its own search, ending it as a solve.
// Default false: no resigning anywhere, every game runs to a road, a flat win, the defender's win or the cap ("make
// people prove winning sequences"). true: the old behaviour (resign = a solve, rated when Syntaks defended: winRated).
export const RESIGN_UNPROVEN = false;
export const mayResign = (po, allow = RESIGN_UNPROVEN) => !po.proven && allow;
// Whether a game that ended without the player's win (kind, as endPlayOn gets it) is a rated miss. kind 'unload' is
// the page going away (pagehide: reload, closed tab); 'left' is moving on to another puzzle in the page. Running out
// of moves in a proven play-out whose proof length isn't known (po.proofPlies null) is unrated: the cap may not have
// covered the proof.
export const lossRated = (po, kind) => gameRated(po) && !(po.proven && (kind === 'unload' || (kind === 'out' && po.proofPlies == null)));
// Why such a game doesn't count, for the cards: unratedWhy's reasons, or 'proven-unload' (a proven play-out whose page
// went away).
export const lossWhy = (po, kind) => lossRated(po, kind) ? null
  : po.proven && kind === 'unload' && gameRated(po) ? 'proven-unload'
  : po.proven && kind === 'out' && gameRated(po) ? 'proven-length' : unratedWhy(po);
// Whether a game ending now (kind, as endPlayOn gets it) is stalled: only the player leaving ('gaveup': Give up or
// Solution; 'left' or 'unload') while the defender has owed a reply for more than STALL_MS. The defender's own ending (its road,
// flats, a draw, resigning) never is, however slow the reply was, and neither is leaving once the reply is in hand
// (po.thinking is cleared as soon as a legal reply arrives, before the board animates it).
export const stalls = (po, kind, now) => (kind === 'gaveup' || kind === 'left' || kind === 'unload') && !!po.thinking && now - po.thinkingSince > STALL_MS;

// What a held result (app.js heldRec) is sent as when a later page load finds it (flushHeld); null drops it unsent.
// h: { id, ms, win?, casual?, theme?, b, owner, page }. Dropped: a record of another account (owner: a hash of the
// token it was played under; after a logout or login it isn't this account's to send), or one whose page is still open
// (alive: a duplicated tab copies sessionStorage, and the original sends its own). Settled before the page went: as it
// was settled, under the build that settled it (the server's stale-miss guard reads it; no build, no trust). Never
// settled (the page died mid-check): the move was never decided, so an unrated miss.
export function heldResend(h, owner, alive) {
  if (!h?.id || alive || h.owner !== owner) return null;
  // (unsettled, including a proven play-out the page died in: an unrated miss, recorded so it isn't a free retry and
  // never a rated miss for a move proven to win)
  const result = typeof h.win === 'boolean' ? { win: h.win, ...(h.casual ? { casual: true } : { theme: h.theme }) } : { win: false, casual: true };
  return { build: +h.b || 0, body: { puzzleId: h.id, ...result, ms: h.ms } };
}

// heldRec is one slot: a record for another puzzle that was settled (its result known, its upload failed, kept for a
// resend) must be sent before a new record replaces it, or that result is lost. What to send (heldResend with alive
// false: the record is this page's own), or null when nothing is lost (no record, the same puzzle, or never settled).
export const heldDisplaced = (prev, nextId, owner) =>
  prev?.id && prev.id !== nextId && typeof prev.win === 'boolean' ? heldResend(prev, owner, false) : null;

// What the quick (2.5 s) still-wins check's answer means for the move (app.js userMove): 'wins' (a proven win),
// 'no' (refuted: a miss as usual, never played out), or, undecided, 'pending' (the first check: held, or played out)
// or 'unchecked' (a later, minor check: dropped, the move noted as unchecked).
export const quickOutcome = (quick, minor) => quick === 'wins' || quick === 'no' ? quick : minor ? 'unchecked' : 'pending';

// At the cap, whether to wait before ending the game 'out' (a wait that can only raise the cap):
//   'length': a proven play-out whose proof length is still being measured (lengthPending) and isn't known;
//   'proof': an unproven Syntaks play-on (no fallback) whose full check is still running (checkLive): a proof would
//   make it a proven play-out with a cap covering the proof. (With Tiltak a proof ends the game as a solve by itself.)
// null: end it now. CAP_WAIT_MS: how long each wait may take.
export const CAP_WAIT_MS = { length: 30e3, proof: 20e3 };
export function capWait(po, { lengthPending = false, checkLive = false } = {}) {
  if (po.mine < po.cap || po.end) return null;
  if (po.proven) return po.proofPlies == null && lengthPending ? 'length' : null;
  return checkLive && provenPlayOut(po.engine) && !po.fallback ? 'proof' : null;
}
// The lead of a failed proven play-out's card, by how it ended: 'unfinished' (out of moves), 'own-road' (the player's
// move completed only Syntaks's road), else 'escaped' (Syntaks's road, flats or a draw).
export const provenLossLead = (how, byYou) => how === 'out' ? 'unfinished' : how === 'road' && byYou ? 'own-road' : 'escaped';
// A displaced held record whose first upload was still in flight: resend it only if that upload failed or the server
// didn't record it (no user in the answer). settled: { ok, r } of the first upload.
export const resendAfterUpload = (settled) => !settled.ok || !settled.r?.user;

// A displaced record's deferred resend (heldRec.set) goes out only if the player is still the one who played it: no
// login, logout or account switch since it was displaced (authEpoch, app.js; a first token minted for this browser
// isn't a switch), and only if the first upload didn't land (resendAfterUpload).
export const deferredResendOk = (settled, epochThen, epochNow) => epochThen === epochNow && resendAfterUpload(settled);

// A result's answer can carry a token minted for this browser (its first result made it a guest). Stored (and `me`
// taken from the answer) only if nobody signed in, out or claimed a name while it was on its way (signIn, app.js),
// else the late guest token would replace the account just signed into.
export const answerOwnsToken = (signInThen, signInNow) => signInThen === signInNow;
