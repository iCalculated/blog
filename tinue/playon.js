// Play on: a move the still-wins check couldn't decide in time is played out on the board against an engine defending
// (Shy, 2026-11-15). The rules that don't need the page live here, so they can be tested (scripts/test-playon.mjs).

// The rules the judge needs (the move cap, who defends, how a game ends, which games count) live in shared/judge.js
// (plan step S1) and are re-exported here unchanged, so the page and scripts/test-playon.mjs see the same functions.
import { capMoves, proofMoves, provenCap } from './shared/judge.js?v=1794960613';
export { capMoves, proofMoves, provenCap, defender, ending, STALL_MS, gameRated, unratedWhy, winRated, lossRated, lossWhy, stalls } from './shared/judge.js?v=1794960613';

export const capNote = (pliesLeft) => {
  const left = Math.max(1, Math.ceil(pliesLeft / 2)), extra = capMoves(pliesLeft) - left;
  return `The puzzle had ${left} of your moves left; you get ${extra} more (3, or 30% when that is more).`;
};
// The cap's explanation (the card's tooltip), true for whichever bound set it.
export function provenCapNote(pliesLeft, proofPlies) {
  const pm = proofMoves(proofPlies), cap = provenCap(pliesLeft, proofPlies);
  if (pm == null || cap === capMoves(pliesLeft)) return capNote(pliesLeft);
  return `The proven win takes ${pm} of your moves against the longest defence; you get ${cap - pm} more (3, or 30% when that is more).`;
}

// An engine's move, checked and canonical in this game; null if it isn't a legal move here.
export function legalMove(g, ptn) {
  if (typeof ptn !== 'string' || !ptn) return null;
  try {
    const c = g.canon(ptn);
    return g.legalMoves().some((m) => g.moveToPTN(m) === c) ? c : null;
  } catch { return null; }
}

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
