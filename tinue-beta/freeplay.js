// Play on after a miss (players' ask, 2026-11-18: "just play against Syntaks until I see why it didn't work"). Once a
// miss is decided and sent, the player can play on from the position after their move against the engine that defends
// that board, as a free game: no move limit, no rating, no log, no result. It is not a play-out (playon.js): a rated
// play-out is the move being judged, this is a game after the judging is over. app.js keeps the two apart (S.playOn vs
// S.free); the decisions are here, so node can test them (scripts/test-freeplay.mjs).

// Which engine the free game would be played against, or null when there's no "Play on" button. s: the puzzle state
// (app.js S). defender: playon.js defender() for this board ('syntaks' | 'tiltak' | null). held: a held result record
// for this puzzle exists (heldRec: a resend is owed); uploading: its result is still on its way. (app.js freeEngine checks
// that the miss didn't end the game.) Offered only on the plain miss card, once the
// miss is decided and sent and nothing about the result is still open, and never with a play-out or a free game under way.
export function freeOffer(s, { defender, held = false, uploading = false } = {}) {
  if (!s || s.placeholder || !defender || held || uploading) return null;
  if (s.status !== 'retry' || !s.resultSent || s.busy || s.view != null) return null;
  if (s.checkPending || s.quickCheck || s.held?.length || s.playOn || s.free || s.checking) return null;
  if (s.refutation?.kind === 'playon') return null; // (a lost play-out's own card)
  const m = s.misses?.at(-1);
  if (!m || m.at !== s.moves?.length) return null; // the latest miss is at this position
  return defender;
}
// The engine a free game is played against on this device. defender: playon.js defender() for the board; syntaksHere /
// tiltakHere: that engine runs in this browser (syntaks.js / tiltak.js supports). A free game stays in the browser:
// crux's /api/defend is the rated play-outs' lane (a priority job on a two-process pool, and a per-player allowance
// they share), and a game that counts for nothing mustn't slow, crowd out or unrate one that counts. So Syntaks only
// where it runs here, else Tiltak (on 4×4 and 5×5 only: never a 6×6 game), else no button. syntaksStatus: syntaks.js
// status(); once 'failed' it won't answer on this page, so the free game would be Tiltak's (freeTurn swaps): the card
// names that. failed: engines that didn't answer a free game from this miss already (freeFails): not offered again,
// or the button would wait out the same broken engine.
export function freeDefender(defender, { syntaksHere = false, tiltakHere = false, syntaksStatus = 'idle', failed = [] } = {}) {
  const tiltak = tiltakHere && !failed.includes('tiltak') ? 'tiltak' : null;
  if (defender === 'syntaks') return syntaksHere && syntaksStatus !== 'failed' && !failed.includes('syntaks') ? 'syntaks' : tiltak;
  if (defender === 'tiltak') return tiltak;
  return null;
}
// The key a failed free game is remembered by, for this page: the puzzle, the position, the missed move.
export const freeFailKey = (id, base, miss) => `${id}|${base.join(' ')}|${miss}`;

// Redrawing the miss card (an aria-live region) without its buttons row: which side of that row changed. old / next:
// the card's HTML before and after; mid: the row's own HTML. null: redraw it all. Otherwise before / after are the new
// HTML for that side, or null where it is unchanged, so it stays in the page and isn't read out again (Play on's row
// appearing after the reset is only an "after").
export function cardSplice(old, next, mid) {
  const i = old?.lastIndexOf(mid) ?? -1, j = next.lastIndexOf(mid);
  if (i < 0 || j < 0) return null;
  const b = next.slice(0, j), a = next.slice(j + mid.length);
  return { before: old.slice(0, i) === b ? null : b, after: old.slice(i + mid.length) === a ? null : a };
}

// The move to play on from (the latest miss here); freeOffer already said there is one.
export const freeFrom = (s) => s.misses.at(-1).ptn;

// What leaving the free game does. how: 'back' (Back to the puzzle), 'hint', 'solution', 'failed' (the engine didn't
// answer), 'left' (another puzzle or the page going: start() takes over). restore: put the retry position back on the
// board; press: the puzzle action to run there, by the same path as a press during the reset after a miss
// (pendingHint / pendingSolution, then flushHint); note: a line for the miss card. Nothing here sends anything.
export function freeExit(how, engine) {
  switch (how) {
    case 'back': return { restore: true, press: null, note: null };
    case 'hint': return { restore: true, press: 'hint', note: null };
    case 'solution': return { restore: true, press: 'solution', note: null };
    // (says only what happened to the game: the card around it says the miss counts, so "nothing was recorded" read as a refund)
    case 'failed': return { restore: true, press: null, note: `${engine} didn’t answer, so the game stopped.` };
    case 'left': return { restore: false, press: null, note: null };
    default: throw new Error('freeExit: ' + how);
  }
}

// The game over, in one plain sentence. res: Game.result() ({ winner, kind }); solver: the player's colour (1 White,
// 2 Black); byYou: the last ply was the player's (a move that completed only the engine's road).
const colour = (c) => (c === 1 ? 'White' : 'Black');
export function freeOverText(res, solver, engine, byYou) {
  if (!res) return '';
  if (!res.winner) return 'The game ended in a draw.';
  const other = colour(3 - solver);
  if (res.winner === solver) return res.kind === 'road' ? `You made a road against ${engine}.` : `You won on flats against ${engine}.`;
  if (res.kind === 'road') return byYou ? `Your move completed ${other}’s road.` : `${other} made a road.`;
  return `${other} won on flats.`;
}

// Take back: the line's new length (the game's plies after the player's missed move, line[0]), or null when there's
// nothing to take back. It goes back to the player's last turn: their move and the engine's answer (or only their
// move, if it ended the game). Never past the engine's first answer to the miss: that is where the game starts.
export function takeBack(len) {
  if (!(len >= 3)) return null;
  return len % 2 === 0 ? len - 2 : len - 1;
}

// Keyboard focus across the switch: the button pressed (data-act) isn't on the next card, so focus goes to the one
// that undoes it, not to the page (Play on <-> Back to the puzzle). null: no stand-in.
export const freeFocus = (act) => ({ free: 'free-back', 'free-back': 'free' })[act] ?? null;
