// Ratings are Glicko-2 for both players and puzzles (shared/glicko.js), one rating period per attempt.
// New players start at 1500 ± 500 (as on Lichess) and puzzles at their prior ± 250: uncertain ratings move fast,
// settled ones slowly, and a result from an uncertain player moves a puzzle less.
// scripts/simulate-newcomers.mjs (and, for Glicko over Elo, scripts/archive/simulate-glicko.mjs) show why these numbers were picked.
import { update, cap, blend, PLAYER_START, PUZZLE_START, PROVISIONAL_RD, provisional } from './glicko.js?v=1795581795';

const CLUELESS_RD = 230;

export { PLAYER_START, provisional };

// The one deviation test for "settled", for players and puzzles alike: a rating is provisional (shown "1650?") while
// rd >= PROVISIONAL_RD, and the picker treats a played puzzle as still needing data (server.js PLAYED) on the same
// test. UNSETTLED_SQL is that test in SQL, for a table with an rd column.
export const settled = (r) => !provisional(r);
export const UNSETTLED_SQL = `rd >= ${PROVISIONAL_RD}`;

// Drilling a theme gives part of the answer away (you know it's a fork, or a forced win in 2), so a themed
// result moves ratings less, and a win far less than a loss: it's still telling when you miss despite the
// hint. Lichess does the same with milder weights; ours are sharper because in Tak the theme is a big hint.
// Mix/no theme = full weight, and so is a theme marked fullWeight (Deep tinuë: knowing a win is six to eight moves
// deep is no hint worth a discount).
export const THEME_WIN_WEIGHT = 0.1, THEME_LOSS_WEIGHT = 0.7;
export function themeWeight(themeKey, themes, win) {
  if (!themeKey || !themes[themeKey] || themes[themeKey].fullWeight) return 1; // (fullWeight: a challenge theme, shared/themes.js)
  return win ? THEME_WIN_WEIGHT : THEME_LOSS_WEIGHT;
}

const asRating = (o, start) => ({ rating: o.rating, rd: o.rd ?? start.rd, vol: o.vol ?? start.vol });

// A guest (no name yet) moves a puzzle at half the weight an account does (Shy, 2026-11-15): its rating is still
// provisional, and guests are cheap to make. Applied on top of the theme weight.
export const GUEST_PUZZLE_WEIGHT = 0.5;

// New ratings for a user and a puzzle after one rated first attempt. weight: how much the result counts (themes);
// puzzleWeight: the same for the puzzle's side, if different (guests).
export function rate(user, puzzle, win, weight = 1, puzzleWeight = weight) {
  const u = asRating(user, PLAYER_START), p = asRating(puzzle, PUZZLE_START);
  const s = win ? 1 : 0;
  const nu = blend(u, cap(update(u, p, s)), weight);
  // Like Lichess, a player whose rating is still a near-total guess (their first puzzle) doesn't move the puzzle.
  const np = u.rd >= CLUELESS_RD ? p : blend(p, cap(update(p, u, 1 - s)), puzzleWeight);
  return { user: nu, puzzle: np, userDelta: nu.rating - u.rating, puzzleDelta: np.rating - p.rating };
}

// A guest from before 2026-11-15 (rated in its browser then) gets its server rating by replaying the first tries
// that browser reported (guest_attempts: the result and the puzzle's rating at the time, recorded by the server), from
// PLAYER_START, as the server would have rated them; hinted tries stay unrated. Not the rating the browser kept: that
// was self-reported, and a guest's rating now moves puzzles. rows: oldest first, with prd = the puzzle's deviation.
// Returns the rating and, per row, the attempt to record.
export function replayGuest(rows) {
  let r = { ...PLAYER_START }, games = 0, wins = 0;
  const attempts = rows.map((a) => {
    const before = r.rating;
    if (a.hinted || a.puzzle_rating == null) return { ...a, rated: 0, user_rating: before, user_delta: 0 };
    r = rate(r, { rating: a.puzzle_rating, rd: a.prd ?? PUZZLE_START.rd, vol: PUZZLE_START.vol }, !!a.win).user;
    games++; wins += a.win ? 1 : 0;
    return { ...a, rated: 1, user_rating: before, user_delta: r.rating - before };
  });
  return { rating: r, games, wins, attempts };
}

// Deviation for a rating that predates Glicko, from how much it has been played.
export const rdFromCount = (n, start) => Math.max(70, start / Math.sqrt(1 + n / 4));

export const DIFFICULTY = { easiest: -600, easier: -300, normal: 0, harder: 300, hardest: 600 };

