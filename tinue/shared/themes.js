// Puzzle themes. `hint: true` themes give away part of the answer, so (like Lichess) results
// from theme-filtered sessions move puzzle ratings less.
export const THEMES = {
  roadIn1:   { name: 'Road in 1',     group: 'Length', desc: 'You can complete a road right now. Find it.', hint: true },
  tinueIn2:  { name: 'Tinuë in 2',    group: 'Length', desc: 'Force a road in two of your moves, whatever the opponent does in between.' },
  tinueIn3:  { name: 'Tinuë in 3',    group: 'Length', desc: 'Force a road in three of your moves.' },
  tinueIn4:  { name: 'Tinuë in 4+',   group: 'Length', desc: 'Longer forced wins.' },
  gaelet:    { name: 'Flat win',      group: 'Goal',   desc: 'Win on flat count instead of a road: the board fills up or someone runs out of pieces, and you have more flats on top. Tak players call a forced flat win a "gaelet".', hint: true },
  fork:      { name: 'Double threat', group: 'Motif',  desc: 'Your move creates two road threats through two different empty squares. The opponent can only block one.', hint: true },
  quietMove: { name: 'Quiet move',    group: 'Motif',  desc: 'Somewhere in the solution you make a move that threatens nothing immediately, yet the opponent still can’t escape. Usually the hardest kind.', hint: true },
  smash:     { name: 'Smash',         group: 'Motif',  desc: 'Your capstone moves onto a wall and flattens it, opening a path for your road.', hint: true },
  spread:    { name: 'Spread',        group: 'Motif',  desc: 'You pick up a stack and drop pieces along a line so that every square you drop on ends up showing your colour. You gain several squares at once.', hint: true },
  throw:     { name: 'Throw',         group: 'Motif',  desc: 'Like a spread, but you don’t care about the near squares — some end up showing your opponent’s colour. What matters is the piece that lands at the far end.', hint: true },
  stackRoad: { name: 'Stack road',    group: 'Motif',  desc: 'The winning move unrolls a stack into two or more squares of the road itself.', hint: true },
  reveal:    { name: 'Reveal',        group: 'Motif',  desc: 'You move a wall off its stack, uncovering your own flat underneath, which completes the road.', hint: true },
  capture:   { name: 'Capture',       group: 'Motif',  desc: 'Your first move lands on top of an opponent’s piece, taking that square over.', hint: true },
  wallBlock: { name: 'Defend first',  group: 'Motif',  desc: 'The opponent is threatening a road too. Your winning line has to deal with that threat while building yours.', hint: true },
  placement: { name: 'Placement only', group: 'Motif', desc: 'Every move in the solution places a new piece; no stack moves needed.', hint: true },
  dragon:    { name: 'Dragon clause', group: 'Motif',  desc: 'The winning move completes roads for both players at once. By the rules, the player who moved wins.', hint: true },
  s4: { name: '4×4', group: 'Board', desc: 'Small board.' },
  s5: { name: '5×5', group: 'Board', desc: 'The most-played size online.' },
  s6: { name: '6×6', group: 'Board', desc: 'Standard tournament size.' },
  s7: { name: '7×7', group: 'Board', desc: 'Big board.' },
  s8: { name: '8×8', group: 'Board', desc: 'Huge board.' },
};

// Basic Tak vocabulary for the glossary page.
export const GLOSSARY = [
  ['Road', 'A connected line of your pieces linking two opposite edges of the board (left–right or top–bottom). Only flats and capstones count; walls don’t. Diagonals don’t connect. Making a road wins.'],
  ['Flat', 'A piece lying flat. It counts for roads and for the flat count, and anything can be stacked on it.'],
  ['Wall', 'A piece stood on its edge (also "standing stone"). It blocks roads — yours and theirs — and nothing can move onto it except a capstone. It doesn’t count toward a road or the flat count.'],
  ['Capstone', 'The special round piece (one per player on 5×5 and 6×6, two on 7×7 and 8×8). It counts for roads, can’t be covered, and can flatten a wall by moving onto it alone.'],
  ['Stack', 'Pieces piled on one square. Whoever’s piece is on top controls the stack and can move it.'],
  ['Carry limit', 'You can pick up at most as many pieces as the board is wide (5 on 5×5). That’s why the board shows only the top pieces of a tall stack on the square itself; anything deeper is drawn in the little column at the side.'],
  ['Stack move', 'Pick up pieces from the top of a stack you control, move in a straight line, and drop at least one piece on each square you pass. The bottom pieces of your hand are dropped first.'],
  ['Tak', 'A threat to complete a road on your next move — Tak’s version of "check".'],
  ['Tinuë', 'A position where you can force a road no matter what the opponent does — Tak’s version of checkmate. Most puzzles here are "find the tinuë".'],
  ['Reserves', 'Pieces not yet placed. If either player runs out, the game ends and is decided by flat count.'],
  ['Flat count', 'When the board fills or someone runs out of pieces, the player with more flats showing on top wins. Walls and capstones don’t count.'],
  ['Komi', 'Bonus flat points given to the second player to balance the first-move advantage. Only matters for flat wins.'],
  ['Hard cap / soft cap', 'A capstone sitting on your own piece (hard) or on an opponent’s piece (soft). A hard cap can smash a wall and still leave your colour behind.'],
  ['Dragon clause', 'If one move completes roads for both players, the player who moved wins.'],
];
