// Elo without rating deviation. Both players and puzzles move after each rated (first) attempt.
// Instead of a deviation, K shrinks with experience: new players/puzzles move fast, veterans slowly.

export const expected = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));

// Small, steady changes (like Lichess once you're established): K 40 for your first puzzle
// (±20 against an even puzzle), 20 after 10 puzzles, floor 12 (±6) from ~25 puzzles on.
export const userK = (games) => Math.max(12, 40 / (1 + games / 10));

// Puzzles start from a heuristic guess, so they need to move early too, but one fluke solve shouldn't
// swing them much. 32 → 16 after 10 rated attempts → floor 6.
export const puzzleK = (attempts) => Math.max(6, 32 / (1 + attempts / 10));

// Lichess "ponder" weights: when you're drilling a theme, the theme name partly gives the answer away,
// so results move ratings less (more so for wins). Mix/no theme = full weight.
export function themeWeight(themeKey, themes, win) {
  if (!themeKey) return 1;
  const t = themes[themeKey];
  if (!t) return 1;
  return t.hint ? (win ? 0.2 : 0.7) : (win ? 0.7 : 0.8);
}

export function rate(user, puzzle, win, weight = 1) {
  const e = expected(user.rating, puzzle.rating);
  const s = win ? 1 : 0;
  const du = weight * userK(user.games) * (s - e);
  const dp = weight * puzzleK(puzzle.attempts) * (e - s);
  return { userDelta: du, puzzleDelta: dp };
}

export const DIFFICULTY = { easiest: -600, easier: -300, normal: 0, harder: 300, hardest: 600 };
