// Every player-facing string of the play-out's Tak rule (judge.js TAK_COUNTDOWN), in one place and keyed by the ids of
// the copy brief. The wording is Neon's (tinue-neon copy/copy.json, 2026-11-21): each id's "text", except end.h2.out,
// Sasha's choice of the "alt" ("No threat"). Measured in the page at 390 and 1280 px against the brief's limits (one
// line for a status, two for a title, and so on), every "text" fits; end.note.checking takes four lines where the brief
// hoped for about three, as its "alt" does too, and is within its ≈170 characters, so the "text" stays. Apostrophes
// are typeset as ’ like the rest of the page; po.status.thinking keeps the space it is appended with. end.lead.refuted
// is not in Neon's file and keeps its placeholder. Strings are plain text with {name} slots; the caller escapes the
// values (moves are PTN, E is the defender's name) and turns the result into HTML. Slots used: {m} the move played out,
// {E} the defender, {n} the move number shown, {k} TAK_COUNTDOWN and {k1} one more (the moves in a row without Tak that
// end it; never write the numbers themselves: they live in one constant), {left} moves left in the countdown, {mv} "N
// moves" (already pluralised), {move} the player's last move.
export const COPY = {
  // the card while playing out
  'po.title.proven': 'That wins: play it out',
  'po.title.provedLate': 'Proven: keep playing',
  'po.title.unproven': 'Play it out',
  'po.intro.proven': '{m} forces a win. Show it on the board: {E} defends. Make a road or win on flats to solve the puzzle. If {E} holds{orGiveUp}, it’s a miss.',
  'po.intro.orGiveUp': ', you give up, or you view the solution',
  'po.intro.unproven': 'We couldn’t check {m} in time, so {E} defends from here. Make a road or win on flats to solve it; if {E} holds, it’s a miss.',
  'po.rule': 'Keep making Tak threats, with no move limit. The play-out ends after {k1} moves in a row that aren’t Tak.',
  'po.tip.tak': 'Tak: if {E} did nothing, you could win on your next move (road or flats).',
  // the status line (the card is a live region: screen readers announce it as it changes)
  'po.status.tak': 'Move {n} · keep making Tak',
  'po.status.countdown': '{move} isn’t Tak · {left} moves left',
  'po.status.countdown1': '{move} isn’t Tak · 1 move left',
  'po.status.thinking': ' · thinking…',
  'po.wait.proof': 'No Tak in {k1} moves. Still checking {m}: if it forces a win, this miss won’t count…',
  'po.wait.length': 'No Tak in {k1} moves. Checking whether this miss counts — one moment…',
  // the card once it ended this way
  'end.h2.out': 'No threat',
  'end.lead.out': '{E} held against {m} for {mv}, and your last {k1} weren’t Tak',
  'end.lead.outProven': '{m} wins, but the play-out ended after {mv} because your last {k1} weren’t Tak',
  // (ended by the check's 'no' mid-game: judge.js endsOnNo; the card's title is the ordinary miss card's)
  'end.lead.refuted': 'Our check found no forced win after {m}, and the game against {E} stops here',
  'end.note.checking': 'Still checking {m}: if it forces a win, this miss won’t count. Switching puzzles is safe, but closing or reloading before the check finishes makes it a rated miss.',
  'end.unrated.provenLate': 'Not rated: {m} wasn’t proven to win until after the play-out ended.',
  'end.unrated.provenLength': 'Not rated: {m} forces a win, and we couldn’t finish checking the winning line in time.',
  // the solved card after a play-out won (the same however long it ran)
  'solved.proven': '{m} forces a win, and you played it out against {E}, so it counts as solved',
  'solved.unproven': 'You played out {m} and beat {E}, so it counts as solved',
};
// The string for id with its slots filled (a slot with no value is left as written, so a missing one shows in tests).
export const copy = (id, v = {}) => (COPY[id] ?? id).replace(/\{(\w+)\}/g, (s, k) => (v[k] != null ? String(v[k]) : s));
