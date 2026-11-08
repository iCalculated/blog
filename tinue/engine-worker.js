// Tactics engine in a Web Worker: our own Tak solver, running locally in the browser.
//   still:   does a move outside the solution still force a win (just slower)? Proof or 'no'.
//   refute:  why was a move wrong? Find the opponent's reply after which the attack fails.
//   analyze: does the side to move have a forced win (road or flats), and how?
// It's a forced-win prover, not an evaluator: it answers "win in N" or "nothing forced within N".
import { Game, Solver } from './shared/tak.js?v=1794178081';
import { shortestTinue, TinueSearch } from './shared/pns.js?v=1794178081';

function gameFrom({ size, komi, tps, plies }) {
  const g = tps ? Game.fromTPS(tps, komi || 0) : Object.assign(new Game(size), { komi: komi || 0 });
  for (const m of plies) g.play(m);
  return g;
}

const immediateWin = (g) => {
  const me = g.toMove;
  for (const m of g.legalMoves()) { const u = g.apply(m); const r = g.result(); g.undo(u); if (r && r.winner === me) return g.moveToPTN(m); }
  return null;
};

// Shortest forced win for the side to move, up to maxPlies.
// Returns { plies, pv } for a win, { none: true, exact } when there is none, or { inconclusive: true }.
// `exact` means every move was searched (exhaustive search up to 5 plies, with no budget cut-off);
// beyond 5 plies the prover only follows road threats, so "none" there is "none found".
function forcedWin(g, maxPlies, budget) {
  const s = new Solver(g, { maxNodes: budget });
  let shortExact = true;
  try {
    for (let p = 1; p <= Math.min(5, maxPlies); p += 2) if (s.winIn(p)) return { plies: p, pv: pvFrom(g, p) };
  } catch (e) { if (e.message !== 'budget') throw e; shortExact = false; }
  if (maxPlies > 5) {
    const r = shortestTinue(g, maxPlies, { maxNodes: budget });
    if (r.result === 'proved' && r.plies > 5) return { plies: r.plies, pv: r.pv || [] };
    if (r.result === 'unknown' || !shortExact) return { inconclusive: true };
    return { none: true, exact: false };
  }
  return shortExact ? { none: true, exact: true } : { inconclusive: true };
}

// A principal variation for a short forced win: winning move, stubborn reply, … (exact search, ≤5 plies).
function pvFrom(g0, plies) {
  const g = g0.clone(), pv = [];
  for (let left = plies; left >= 1; left -= 2) {
    const me = g.toMove;
    let pick = null;
    const s = new Solver(g, { maxNodes: 2e6 });
    for (const m of g.legalMoves()) {
      const u = g.apply(m); const r = g.result();
      let ok = r && r.winner === me;
      if (!ok && !r && left >= 3) { try { ok = s.allLose(left - 1); } catch { ok = false; } }
      g.undo(u);
      if (ok) { pick = m; break; }
    }
    if (!pick) break;
    pv.push(g.moveToPTN(pick)); g.apply(pick);
    if (g.result() || left === 1) break;
    // stubborn reply: one after which the attacker's win is longest (cheap: avoid immediate loss)
    let reply = null;
    for (const r of g.legalMoves()) { const u = g.apply(r); const lost = !!immediateWin(g); g.undo(u); if (!lost || !reply) reply = r; if (!lost) break; }
    if (!reply) break;
    pv.push(g.moveToPTN(reply)); g.apply(reply);
  }
  return pv;
}

self.onmessage = ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'still') {
      // Position after the player's off-tree move, defender to move: does the attacker still force a road (at any
      // length)? df-pn over threat moves, then confirmed with every defender reply considered, so "wins" is a proof.
      const g = gameFrom(data);
      if (g.result()) { self.postMessage({ id, kind: 'no' }); return; }
      const run = (n, full) => { const s = new TinueSearch(g.clone(), { maxNodes: n, fullDefense: full }); s.att = data.attacker; try { return s.solve(Infinity); } catch (e) { if (e.message === 'budget') return null; throw e; } };
      const won = run(3e4, false) === true && run(3e5, true) === true;
      self.postMessage({ id, kind: won ? 'wins' : 'no' });
    } else if (type === 'refute') {
      // Position after the player's wrong move; the defender is to move.
      const g = gameFrom(data);
      const res = g.result();
      if (res) { self.postMessage({ id, kind: res.winner === data.attacker ? 'wins' : 'lost' }); return; }
      const theirWin = immediateWin(g);
      if (theirWin) { self.postMessage({ id, kind: 'gives-road', reply: theirWin }); return; }
      const left = Math.max(1, data.remaining - 2); // attacker plies left after the defender's reply
      // Prefer replies that block (walls/caps/placements), then the rest.
      const replies = g.legalMoves().sort((a, b) => (b.kind === 'p') - (a.kind === 'p') || (b.type || 0) - (a.type || 0));
      // A refutation must be proven: after it, the attacker has no forced win at all within the plies left.
      let best = null;
      for (const r of replies) {
        const u = g.apply(r);
        const res = g.result() ? null : forcedWin(g, left, 3e5);
        g.undo(u);
        if (res?.none && res.exact) { self.postMessage({ id, kind: 'refuted', reply: g.moveToPTN(r), exact: true }); return; }
        if (res?.none && !best) best = g.moveToPTN(r);
      }
      self.postMessage(best ? { id, kind: 'refuted', reply: best, exact: false } : { id, kind: 'unknown' });
    } else if (type === 'analyze') {
      const g = gameFrom(data);
      const res = g.result();
      if (res) { self.postMessage({ id, kind: 'over', winner: res.winner, how: res.kind }); return; }
      const win = forcedWin(g, data.maxPlies || 9, data.budget || 4e5);
      // Is the side NOT to move threatening an immediate road ("Tak")?
      const h = g.clone(); h.toMove = 3 - g.toMove;
      const threat = immediateWin(h);
      const isWin = win && win.plies;
      self.postMessage({ id, kind: isWin ? 'win' : 'none', side: g.toMove, plies: win?.plies, pv: win?.pv, exact: !!win?.exact, threat, maxPlies: data.maxPlies || 9 });
    }
  } catch (e) {
    self.postMessage({ id, kind: 'error', error: String(e.message || e) });
  }
};
