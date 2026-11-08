// Glicko-2 (Glickman, "Example of the Glicko-2 system"), with each attempt as its own rating period,
// as Lichess does for puzzles. A rating is { rating, rd, vol }: rd is the deviation (how unsure we are),
// vol the volatility (how erratic results have been). Uncertain ratings move fast; settled ones slowly.
// The opponent's rd matters too: a result against an uncertain opponent counts for less (g(φ) below).

const SCALE = 400 / Math.LN10; // 173.7: Glicko-2's internal scale, so the curve matches 10^(Δ/400)
const TAU = 0.75; // how fast volatility may change (Lichess)

export const RD_MIN = 45;
export const PROVISIONAL_RD = 110; // above this a rating is shown as "1650?"
export const PLAYER_START = { rating: 1500, rd: 250, vol: 0.09 };
export const PUZZLE_RD = 250; // starting deviation for a puzzle around its prior rating
const RD_MAX = 500, VOL_MAX = 0.1;

const g = (phi) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
export const expected = (a, b) => 1 / (1 + 10 ** ((b.rating - a.rating) / 400 * g(b.rd / SCALE)));

// a's rating after scoring s (1 win, 0 loss) against b.
export const update = (a, b, s) => updateMany(a, [[b, s]]);

// One rating period with several games: games = [[opponent, score], …]. tau: volatility constraint.
export function updateMany(a, games, tau = TAU) {
  const mu = (a.rating - 1500) / SCALE, phi = a.rd / SCALE, sigma = a.vol;
  let vInv = 0, sum = 0;
  for (const [b, s] of games) {
    const gJ = g(b.rd / SCALE), E = 1 / (1 + Math.exp(-gJ * (mu - (b.rating - 1500) / SCALE)));
    vInv += gJ * gJ * E * (1 - E); sum += gJ * (s - E);
  }
  const v = 1 / vInv, delta = v * sum;

  // New volatility: root of f by the Illinois method (step 5 of the paper).
  const A0 = Math.log(sigma * sigma), p2 = phi * phi;
  const f = (x) => { const ex = Math.exp(x); return (ex * (delta * delta - p2 - v - ex)) / (2 * (p2 + v + ex) ** 2) - (x - A0) / (tau * tau); };
  let A = A0, B;
  if (delta * delta > p2 + v) B = Math.log(delta * delta - p2 - v);
  else { let k = 1; while (f(A0 - k * tau) < 0) k++; B = A0 - k * tau; }
  let fA = f(A), fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA), fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
    B = C; fB = fC;
  }
  const vol = Math.exp(A / 2);

  const phiNew = 1 / Math.sqrt(1 / (p2 + vol * vol) + 1 / v);
  const muNew = mu + phiNew * phiNew * sum;
  return { rating: muNew * SCALE + 1500, rd: phiNew * SCALE, vol };
}

// Lichess-style bounds: deviation within [45, 500], volatility at most 0.1.
export const cap = (r) => ({ rating: r.rating, rd: Math.min(RD_MAX, Math.max(RD_MIN, r.rd)), vol: Math.min(VOL_MAX, r.vol) });

// Move only part of the way from old to new (theme "ponder" weights, as on Lichess).
export const blend = (o, n, w) => (w >= 1 ? n : { rating: o.rating + w * (n.rating - o.rating), rd: o.rd + w * (n.rd - o.rd), vol: o.vol + w * (n.vol - o.vol) });

export const provisional = (r) => r.rd >= PROVISIONAL_RD;
