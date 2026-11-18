// The input lock (CLEANUP §6 "one input lock, busyUntil"): every accident guard of the puzzle screen is one class here,
// with its duration, counted from the moment app.js already records for it. Durations as they were (X3 changed none).
//   board    500 ms from S.born (start): a move on a new puzzle's board is dropped; the second tap of a double tap
//            on Next lands on the board where the dock was
//   actions  1000 ms from S.t0 (startClock, the board playable): Hint and Solution take no press and show disabled;
//            the second tap on Next lands on Solution (rabbitboy84, 2026-11-16)
//   next     600 ms from S.viewT0 (Solution pressed): Next puzzle (card and dock) takes no press; Enter isn't locked
//   giveup   1500 ms from po.t0 (the play-out started): Give up takes no press and shows disabled; a tap meant for
//            Hint, which sat in the same spot
// Each lock is held while now - since < ms, the comparison every guard made before (not now < since + ms, which can
// round differently). What a missing `since` means stays at the call site, as before.
export const BUSY_MS = Object.freeze({ board: 500, actions: 1000, next: 600, giveup: 1500 });
export const busy = (cls, since, now = performance.now()) => now - since < BUSY_MS[cls];
// When the lock lets go (for a timer that redraws what it disabled).
export const busyUntil = (cls, since) => since + BUSY_MS[cls];
