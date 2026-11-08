// Ratings are Glicko-2 for both players and puzzles (shared/glicko.js), one rating period per attempt.
// New players start at 1500 ± 250, and puzzles start at their prior ± 250: uncertain ratings move fast,
// settled ones slowly, and a result from an uncertain player moves a puzzle less.
// scripts/simulate-glicko.mjs shows why these numbers were picked.
import { update, cap, blend, PLAYER_START, PUZZLE_RD, provisional } from './glicko.js?v=1794178081';

const CLUELESS_RD = 230;

export { PLAYER_START, provisional };

// Lichess "ponder" weights: when you're drilling a theme, the theme name partly gives the answer away,
// so results move ratings less (more so for wins). Mix/no theme = full weight.
export function themeWeight(themeKey, themes, win) {
  if (!themeKey) return 1;
  const t = themes[themeKey];
  if (!t) return 1;
  return t.hint ? (win ? 0.2 : 0.7) : (win ? 0.7 : 0.8);
}

const asRating = (o, rd) => ({ rating: o.rating, rd: o.rd ?? rd, vol: o.vol ?? PLAYER_START.vol });

// New ratings for a user and a puzzle after one rated first attempt.
export function rate(user, puzzle, win, weight = 1) {
  const u = asRating(user, PLAYER_START.rd), p = asRating(puzzle, PUZZLE_RD);
  const s = win ? 1 : 0;
  const nu = blend(u, cap(update(u, p, s)), weight);
  // Like Lichess, a player whose rating is still a near-total guess (their first puzzle) doesn't move the puzzle.
  const np = u.rd >= CLUELESS_RD ? p : blend(p, cap(update(p, u, 1 - s)), weight);
  return { user: nu, puzzle: np, userDelta: nu.rating - u.rating, puzzleDelta: np.rating - p.rating };
}

// Deviation for a rating that predates Glicko, from how much it has been played.
export const rdFromCount = (n, start) => Math.max(70, start / Math.sqrt(1 + n / 4));

export const DIFFICULTY = { easiest: -600, easier: -300, normal: 0, harder: 300, hardest: 600 };
