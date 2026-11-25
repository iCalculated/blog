// The input lock (CLEANUP §6 "one input lock, busyUntil"): every accident guard of the puzzle screen is one class here,
// with its duration, counted from the moment app.js already records for it. Durations as they were (X3 changed none;
// input-guard raised board from 500 to 700 and added ended; settings added confirm).
//   board    700 ms from S.born (start): a move on a new puzzle's board is dropped; the second tap of a double tap
//            on Next lands on the board where the dock was, and so does the tap after one that hit Next by accident
//            (input-guard: 500 until then; 700 also outlasts the 650 ms intro, so a puzzle with no intro takes its
//            first move no sooner than one with an intro does). input-guard: the board itself is locked as long
//            (board.js lock: no stack lifted or tray stone picked either; PTN Ninja's board stays off)
//   actions  1000 ms from S.t0 (startClock, the board playable): Hint and Solution take no press and show disabled;
//            the second tap on Next lands on Solution (rabbitboy84, 2026-11-16)
//   next     600 ms from S.viewT0 (Solution pressed): Next puzzle (card and dock) takes no press; Enter isn't locked
//   giveup   1500 ms from po.t0 (the play-out started): Give up takes no press and shows disabled; a tap meant for
//            Hint, which sat in the same spot
//   ended    1000 ms from S.endT0 (the result first drawn): Next puzzle (card, dock), Enter and the update bar's Reload
//            take no press; a tap aimed at the board as a play-out ends on the defender's instant last move lands on
//            the phone dock's Next, which appears over the board's lower rows. As long as 'actions': both are a press
//            made before the player could have seen what changed, not the second tap of a double tap (next, 600)
//   confirm  600 ms from the move held (Confirm moves, settings.js): it isn't confirmed (Confirm, Enter); the
//            second tap of a double tap or a bounce, as 'next'
// Each lock is held while now - since < ms, the comparison every guard made before (not now < since + ms, which can
// round differently). What a missing `since` means stays at the call site, as before.
export const BUSY_MS = Object.freeze({ board: 700, actions: 1000, next: 600, giveup: 1500, ended: 1000, confirm: 600 });
export const busy = (cls, since, now = performance.now()) => now - since < BUSY_MS[cls];
// When the lock lets go (for a timer that redraws what it disabled).
export const busyUntil = (cls, since) => since + BUSY_MS[cls];
// Next after a result: locked until the result has been on screen for a moment. No time yet (the status is 'solved'
// but no render has drawn the result) counts as just ended.
export const endLocked = (endT0, now = performance.now()) => endT0 == null || busy('ended', endT0, now);

// The update bar (app.js renderBuildBar) is a row above the board: appearing, it pushes the board down under the
// finger. Hidden without a newer build, once dismissed, and in the middle of a puzzle (a move or a miss made, a
// play-out). Before the first move it may stay up, or appear as the puzzle starts (fresh), but not newly appear later:
// the version check answers after the board is playable, on a slow phone network maybe just as the player taps.
export function barHide({ newBuild, dismissed, s, shown, fresh }) {
  const real = !!s && !s.placeholder, playing = real && (s.status === 'play' || s.status === 'retry');
  const mid = real && ((playing && (s.moves.length > 0 || s.misses.length > 0)) || s.status === 'playon');
  return !newBuild || !!dismissed || mid || (playing && !shown && !fresh);
}
