// Play on: a move the still-wins check couldn't decide in time is played out on the board against an engine defending
// (Shy, 2026-11-15). The rules that don't need the page live here, so they can be tested (scripts/test-playon.mjs).

// The rules the judge needs (the move cap, who defends, how a game ends, which games count) live in shared/judge.js
// (plan step S1) and are re-exported here unchanged, so the page and scripts/test-playon.mjs see the same functions.
import { capMoves, proofMoves, provenCap, countTak, outOfMoves, endsOnNo } from './shared/judge.js?v=1795581690';
export { pliesLeftOf, capMoves, proofMoves, provenCap, isTak, countTak, outOfTak, takLeft, outOfMoves, TAK_COUNTDOWN, REPLY_MARK, replyEntry, isReplyEntry, defender, ending, STALL_MS, gameRated, unratedWhy, winRated, lossRated, lossWhy, stalls, endsOnNo, REFUTED } from './shared/judge.js?v=1795581690';

// The cap's explanation, one plain sentence shown on the card (and as the number's tooltip). capNote: the puzzle's
// bound (the moves it had left at that node, plus the spare: capMoves).
const moves = (n) => (n === 1 ? '1 move of yours' : `${n} of your moves`);
export const capNote = (pliesLeft) => {
  const left = Math.max(1, Math.ceil(pliesLeft / 2)), extra = capMoves(pliesLeft) - left;
  return `The puzzle had ${moves(left)} left, and you get ${extra} spare.`;
};
// A proven play-out's: true for whichever bound set the cap (provenCap). The puzzle's bound wins ties; a proof longer
// than it sets the cap to the proof's own moves. (The proof isn't minimal, so its length is an upper bound on the
// shortest forced win, and the sentence says "at most".) `shown`: the cap already on screen when the proof's length arrived;
// if it is more than both bounds it stays, and the note says so (the page keeps its earlier note then: app.js).
export function provenCapNote(pliesLeft, proofPlies, move, shown = 0) {
  const pm = proofMoves(proofPlies), usual = capMoves(pliesLeft), cap = provenCap(pliesLeft, proofPlies, shown);
  if (cap > Math.max(usual, pm ?? 0)) return `You keep the ${cap} moves you were already given.`;
  if (pm == null || cap === usual) return capNote(pliesLeft);
  return `Our proof that ${move} wins needs at most ${moves(pm)}, counting ${move}, so you get ${pm}.`;
}

// Proven off-tree wins at an attacker node: alts at the root, altsAt[path of the puzzle's moves so far] deeper in.
// path: the moves played from the puzzle's position, both sides. (Moved from app.js slowerWins.)
export function slowerWinsAt(p, path) {
  const key = path.join(' ');
  return (key ? p.altsAt?.[key] : p.alts) || [];
}
// A play-out as it starts (app.js startPlayOn; Rush's driver makes the same): the move played out (miss) at ply `at`
// of the puzzle's line, the line before it (base), the game after it (g), the puzzle's plies left there (left: the
// usual cap, capMoves) and who defends. A proven one's cap is raised by applyProofLength. tak (the puzzle page): the
// play-out runs under the Tak rule instead of the cap (judge.js TAK_COUNTDOWN; rule 'tak', no cap), tak being whether
// the move played out is Tak (isTak). Rush passes none and keeps the cap.
export const playOutOf = ({ miss, at, base, g, proven, left, key, engine, tak }) => {
  const po = { miss, at, base, line: [miss], g, proven, mine: 1, cap: capMoves(left), capNote: capNote(left), left, proofPlies: null, key,
    engine, fallback: false, thinking: false, end: null };
  return typeof tak === 'boolean' ? countTak(Object.assign(po, { rule: 'tak', cap: null, capNote: null }), tak) : po;
};
// A proven play-out's cap once its proof's length is known (provenCap: never lower than the cap shown, whose note then
// stays). Returns false when plies isn't a length (nothing changed). (Moved from app.js setProofLength.)
export function applyProofLength(po, plies) {
  if (!Number.isFinite(plies)) return false;
  po.proofPlies = plies;
  if (po.rule === 'tak') return true; // (no cap to raise: the length only decides whether running out is rated, lossRated)
  const cap = provenCap(po.left, plies, po.cap);
  // Today the cap shown here is always capMoves(po.left) (no earlier length raised it), so this always rewrites the
  // note. If a later change lets the cap rise twice, a cap above both bounds keeps the note that set it.
  if (cap === provenCap(po.left, plies)) po.capNote = provenCapNote(po.left, plies, po.miss); // (else the shown cap and its note stay)
  po.cap = cap;
  return true;
}

// What the server keeps of a result's move log (server.js cleanLog): at most LOG.max entries, each
// with ms within LOG.ms (an hour); one entry over either and it stores no log at all. A play-out has no ceiling now, so
// the page stops adding entries before either (logOk), keeping the head of the log rather than losing all of it.
export const LOG = { max: 512, ms: 3600e3 };
export const logOk = (log, ms) => log.length < LOG.max && Number.isFinite(ms) && ms >= 0 && ms <= LOG.ms;

// Who defended, by name, for the cards (Syntaks only while it defends; once it drops out, Tiltak). (Moved from app.js.)
export const defenderName = (po) => (po.engine === 'syntaks' && !po.fallback ? 'Syntaks' : 'Tiltak');

// An engine's move, checked and canonical in this game; null if it isn't a legal move here.
export function legalMove(g, ptn) {
  if (typeof ptn !== 'string' || !ptn) return null;
  try {
    const c = g.canon(ptn);
    return g.legalMoves().some((m) => g.moveToPTN(m) === c) ? c : null;
  } catch { return null; }
}

// An engine's line from game g, cut at its first move that isn't legal there (or isn't a move at all): nothing checks
// a printed line before the analysis panel plays it onto the board, and one bad move in an explored branch would leave
// that branch unplayable. Moves come back canonical; g is left as it was.
export function legalPrefix(g, pv) {
  const h = g.clone(), out = [];
  for (const m of pv || []) { const c = legalMove(h, m); if (!c) break; h.play(c); out.push(c); }
  return out;
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
  const settled = typeof h.win === 'boolean';
  const result = settled ? { win: h.win, ...(h.casual ? { casual: true } : { theme: h.theme }) } : { win: false, casual: true };
  // A record keeps its move log: a settled one always (settledHeld), an unsettled one when it has one (runOnHeld: out
  // under the Tak rule, the check still running). The server stores only the first result for a puzzle, so a resend
  // without it would lose that attempt's log for good.
  return { build: +h.b || 0, body: { puzzleId: h.id, ...result, ms: h.ms, ...(Array.isArray(h.log) && h.log.length ? { log: h.log } : {}) } };
}
// The held record of a play-out that ran out under the Tak rule while its check runs on (app.js endPlayOn): still
// unsettled (a crash before the check answers resends an unrated miss: heldResend), but with the game's log, which is
// complete by then. prev: the record startPlayOn held ({ id, ms }); log: as report() would send it (oriented).
export const runOnHeld = (prev, log) => ({ id: prev.id, ms: prev.ms, ...(log?.length ? { log } : {}) });

// Leaving a puzzle (kind 'left': on to another puzzle in this page) after its play-out ran out under the Tak rule while
// the check still runs: the check is not stopped, and settles the old puzzle in the background (app.js abandonCheck),
// so running out never pre-empts a proof, wherever the player goes next in this page (2026-11-21 review). Leaving any
// other way ('unload': the page going away, 'auth': a log-out or log-in, which must send it under the identity that
// played it, 'again': the same puzzle opened again, whose new result would otherwise land first and stand, as the server
// keeps the first) settles it now, as a rated miss (lossRated: the move isn't proven), and the card says so (end.note.checking).
// Mid-game (no end yet) leaving is still giving up, and a proven or decided one has nothing to wait for.
export const leftRunsOn = (c, kind) => kind === 'left' && !!c?.playOn && c.playOn.rule === 'tak' && c.playOn.end === 'out'
  && !c.playOn.proven && c.final == null;
// The record report() keeps for a settled result until the server has it (app.js heldRec): what heldResend sends.
// timing: { ms, log } as report() sends them.
export const settledHeld = (id, timing, win, casual, theme) =>
  ({ id, ms: timing.ms, win, casual: !!casual, theme: casual ? undefined : theme || undefined, ...(timing.log ? { log: timing.log } : {}) });

// heldRec is one slot: a record for another puzzle that was settled (its result known, its upload failed, kept for a
// resend) must be sent before a new record replaces it, or that result is lost. What to send (heldResend with alive
// false: the record is this page's own), or null when nothing is lost (no record, the same puzzle, or never settled).
export const heldDisplaced = (prev, nextId, owner) =>
  prev?.id && prev.id !== nextId && typeof prev.win === 'boolean' ? heldResend(prev, owner, false) : null;

// What the quick (2.5 s) still-wins check's answer means for the move (app.js userMove): 'wins' (a proven win),
// 'no' (refuted: a miss as usual, never played out), or, undecided, 'pending' (the first check: held, or played out)
// or 'unchecked' (a later, minor check: dropped, the move noted as unchecked).
export const quickOutcome = (quick, minor) => quick === 'wins' || quick === 'no' ? quick : minor ? 'unchecked' : 'pending';

// Out of moves (outOfMoves: at the cap, or the Tak rule's countdown run down), whether to wait before ending the game
// 'out' (a wait for what could change that ending):
//   'length': a proven play-out whose proof length is still being measured (lengthPending) and isn't known (under the
//   cap it could raise the cap; under the Tak rule it only decides whether the 'out' is rated, lossRated);
//   'proof': an unproven Syntaks play-on (no fallback) whose full check is still running (checkLive): a proof would
//   make it a proven play-out (under the cap: with a cap covering the proof; under the Tak rule: an unrated out,
//   lossRated provedAtOut). (With Tiltak a proof ends the game as a solve by itself.)
// null: end it now. CAP_WAIT_MS: how long each wait may take (the same under both rules). Under the Tak rule a check
// still running after the 'proof' wait is not stopped by the ending (app.js endPlayOn): the result is held until it
// answers, so running out never pre-empts a proof.
export const CAP_WAIT_MS = { length: 30e3, proof: 20e3 };
export function capWait(po, { lengthPending = false, checkLive = false } = {}) {
  if (!outOfMoves(po) || po.end) return null;
  if (po.proven) return po.proofPlies == null && lengthPending ? 'length' : null;
  return checkLive && provenPlayOut(po.engine) && !po.fallback ? 'proof' : null;
}
// When the page ends a play-out on a 'no' (judge.js endsOnNo; app.js startPlayOn's handler and defenderTurn). The
// event-order rule: the page judges events in the order it handles them, and a move counts once the page has accepted
// it (playOnMove plays it onto the game, synchronously from the board's input). So a winning move accepted before the
// 'no' is handled is a solve (the play-out is over, and the 'no' finds nothing to end); a 'no' handled first ends the
// play-out, and a move not yet accepted (stones in hand, or one waiting for Confirm) never counts. What happens, by
// what the page is doing when the 'no' is handled:
//   'now':   the player's turn (stones in hand, a move waiting for Confirm, a hidden tab included): it ends now.
//   'reply': the defender's reply is being chosen or played onto the board (po.thinking, or s.busy while it animates):
//            the play-out ends as soon as that reply is on the board, before the player's turn opens, unless the reply
//            itself ended the game (the defender's road, flats or a draw: that ending stands, rated the same way).
//   'wait':  the countdown has run down and the page is waiting for the check at the end (capWait 'proof'): the wait
//            ends with the 'no' and the play-out ends 'out', as before this rule (the same rating).
//   null:    nothing ends: not a 'no' (an 'unknown' changes nothing), not the Tak rule (Rush), already over, or proven.
// busy: the page's s.busy (the board is mid-animation or locked for the defender).
export function noEnding(po, verdict, { busy = false } = {}) {
  if (!endsOnNo(po, verdict)) return null;
  if (po.waiting) return 'wait';
  return po.thinking || busy ? 'reply' : 'now';
}
// The engines' time limits, in one place so Rush's server can bound its pauses by them (server/rush.js, rush-rules.js
// pauseMax): the first still-wins check's quick answer and its run-on (engine.js checkStill's defaults, pinned there
// by scripts/test-prover.mjs and here by test-rush.mjs), and the defender's (defend.js): an in-browser Syntaks search
// and its grace, crux's /api/defend, the wait for Syntaks's download, Tiltak's start and its reply.
export const ENGINE_MS = { quick: 2500, final: 60e3, local: 4500, crux: 8000, download: 20e3, tiltakUp: 20e3, tiltak: 6000 };
// A proof that lands mid-game (app.js makeProven; Rush the same): against Syntaks the game goes on as a proven
// play-out (true: po is marked so); against Tiltak, from the start or after Syntaks dropped out, there is no proven
// play-out (false: it ends as a solve now, 'proved').
export function upgradeToProven(po) {
  if (!provenPlayOut(po.engine) || po.fallback) return false;
  po.proven = po.provedLate = true;
  return true;
}
// Measuring a proof's length (app.js setProofLength; Rush the same): po.lengthP while it runs (at the cap the game
// waits for it: capWait), cleared when it settles; done(r) with the engine's answer. ask: () => engine.proofLength(...).
export function measureProof(po, ask, done) {
  const lp = po.lengthP = ask().then((r) => {
    if (po.lengthP === lp) po.lengthP = null;
    done(r);
  }, () => { if (po.lengthP === lp) po.lengthP = null; });
  return lp;
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
