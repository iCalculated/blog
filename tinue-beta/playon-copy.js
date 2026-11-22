// Every player-facing string of the play-out's Tak rule (judge.js TAK_COUNTDOWN), in one place and keyed by the ids of
// the copy brief, so the final wording drops in as JSON keyed the same way. Placeholder wording (2026-11-21): the final
// copy is being written separately. Strings are plain text with {name} slots; the caller escapes the values (moves are
// PTN, E is the defender's name) and turns the result into HTML. Slots used: {m} the move played out, {E} the defender,
// {n} the move number shown, {k} TAK_COUNTDOWN and {k1} one more (the moves in a row without Tak that end it; never
// write the numbers themselves: they live in one constant), {left} moves left in the countdown, {mv} "N moves" (already pluralised), {move} the player's last move.
export const COPY = {
  // the card while playing out
  'po.title.proven': 'That wins: play it out',
  'po.title.provedLate': 'Proved: play it out',
  'po.title.unproven': 'Play it out',
  'po.intro.proven': '{m} forces a win. Now show it on the board: {E} defends to the end. Win and it counts as solved. If {E} holds{orGiveUp}, it’s a miss.',
  'po.intro.orGiveUp': ', or you give up or view the solution',
  'po.intro.unproven': 'We couldn’t check {m} in time, so show it on the board: {E} defends. Win and it counts as solved. If {E} holds, it’s a miss.',
  'po.rule': 'Keep making Tak threats. After a move that isn’t Tak you have {k} more moves to make one, or the play-out ends.',
  'po.tip.tak': 'Tak: a move after which you could win on your next move if {E} did nothing.',
  // the status line (the card is a live region: screen readers announce it as it changes)
  'po.status.tak': 'Move {n} · keep making Tak threats',
  'po.status.countdown': '{move} isn’t Tak · {left} moves left to make a Tak threat',
  'po.status.countdown1': '{move} isn’t Tak · 1 move left to make a Tak threat',
  'po.status.thinking': ' · {E} is thinking…',
  'po.wait.proof': 'No Tak threat in {k1} moves. Still checking whether {m} wins…',
  'po.wait.length': 'No Tak threat in {k1} moves. Measuring the proven win before this counts…',
  // the card once it ended this way
  'end.h2.out': 'No Tak threat',
  'end.lead.out': '{E} defended {m} for {mv}, and your last {k1} moves weren’t Tak',
  'end.lead.outProven': '{m} wins, but your last {k1} moves weren’t Tak and the play-out ended after {mv}',
  'end.note.checking': 'Still checking whether {m} forces a win; if it does, this miss won’t count. Another puzzle is fine meanwhile; closing or reloading the page first makes it a rated miss.',
  'end.unrated.provenLate': 'Not rated: {m} was proven to win only after the play-out ended.',
  'end.unrated.provenLength': 'Not rated: {m} is proven to win, and how long its win is wasn’t known in time.',
  // the solved card after a play-out won (the same however long it ran)
  'solved.proven': '{m} forces a win, and you played it out against {E}, so it counts as solved',
  'solved.unproven': '{m} won against {E}, so it counts as solved',
};
// The string for id with its slots filled (a slot with no value is left as written, so a missing one shows in tests).
export const copy = (id, v = {}) => (COPY[id] ?? id).replace(/\{(\w+)\}/g, (s, k) => (v[k] != null ? String(v[k]) : s));
