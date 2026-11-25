// The analysis page's pure parts (after a puzzle): no DOM, no engines, so scripts/test-analysis.mjs runs them in node.
// solverLines runs in the tactics worker (public/engine-worker.js, engine.lines) and in tests.
import { Game, winningMoves, DIRS, WALL, CAP, typeOf } from './shared/tak.js?v=1795581690';

// A link that opens a line in PTN Ninja: the PTN, lz-string compressed (compressToEncodedURIComponent, passed in so
// the compressor loads only when a link is shown), at `ply` plies shown (0: the start, so no ply parameter), with an
// optional title. PTN Ninja's `ply=N!` is the position after its ply index N (0-based), hence ply - 1.
export function ninjaUrl({ ptn, ply = 0, name }, compress) {
  return 'https://ptn.ninja/' + compress(ptn) + (name ? '&name=' + encodeURIComponent(name) : '') + (ply > 0 ? '&ply=' + (ply - 1) + '!' : '');
}

// Every move that wins on the spot for the side to move in g (a road, or a flat win by filling the board or the last
// stone; a move that completes both sides' roads counts as the mover's when the rules say so). g is left as it was.
// road: only the wins by a road (tinuë is an unstoppable road; a win on flats is not one).
function immediateWins(g, road = false) {
  const me = g.toMove, out = [];
  for (const m of g.legalMoves()) { const u = g.apply(m); const r = g.result(); g.undo(u); if (r && r.winner === me && (!road || r.kind === 'road')) out.push(g.moveToPTN(m)); }
  return out;
}

// Placements: one per square, the flat if it is there, else the wall, else the capstone (in the order given otherwise).
const PLACE = /^[SC]?[a-z][1-9]$/;
function onePerSquare(moves) {
  const rk = (m) => (m[0] === 'S' ? 1 : m[0] === 'C' ? 2 : 0), sq = (m) => m.replace(/^[SC]/, ''), pick = new Map();
  for (const m of moves) if (PLACE.test(m) && !(pick.has(sq(m)) && rk(pick.get(sq(m))) <= rk(m))) pick.set(sq(m), m);
  return moves.filter((m) => !PLACE.test(m) || pick.get(sq(m)) === m);
}

// What our own solver knows about a position (every size; exact within its plies), for the analysis panel:
//   wins1:   moves that win at once (canonical PTN)
//   wins3:   moves that force a win in 3 plies (win in 2 moves) and don't win at once; null when the search ran out of
//            `budget` nodes (partial: true)
//   threats: the moves the side NOT to move would win with at once if it were its turn (a road threat: "Tak"), one per
//            square for placements: a flat rather than a capstone or a wall there ('Cf1' beside 'f1' is the same road; a
//            wall makes no road but fills the board as well as a flat does, so 'Sd1' beside 'd1' is the same flat win)
//   tinue:   the side to move can't win at once and every move it has leaves a road win (exact, 2 plies): a forced win
//            on flats (the board filling, the last stone) is a threat to win, not tinuë
//   pinned:  for each move asked about (as given): 'win1' | 'win3' | 'no3' (no win within 3 plies) | '?' (unknown:
//            partial, or not a legal move here)
//   over:    the game's result when the position is already over (then everything else is empty), else null
export function solverLines(g, { budget = 3e5, pinned = [] } = {}) {
  const res = g.result();
  const ask = (verdict) => Object.fromEntries((pinned || []).map((p) => [p, verdict(p)]));
  if (res) return { wins1: [], wins3: [], partial: false, threats: [], tinue: false, pinned: ask(() => '?'), over: { winner: res.winner, kind: res.kind } };
  const wins1 = winningMoves(g, 1).moves;
  let wins3 = null, partial = false;
  try { wins3 = winningMoves(g, 3, { maxNodes: budget }).moves.filter((m) => !wins1.includes(m)); } catch (e) {
    if (e.message !== 'budget') throw e;
    partial = true;
  }
  const me = g.toMove, them = 3 - me;
  const h = g.clone(); h.toMove = them;
  const all = immediateWins(h), threats = onePerSquare(all);
  let tinue = !wins1.length && immediateWins(h, true).length > 0;
  if (tinue) for (const m of g.legalMoves()) {
    const u = g.apply(m);
    const r = g.result();
    const lost = r ? r.winner === them : immediateWins(g, true).length > 0;
    g.undo(u);
    if (!lost) { tinue = false; break; }
  }
  const verdict = (p) => {
    let c;
    try { const mv = g.parseMove(p); if (!g.isLegal(mv)) return '?'; c = g.moveToPTN(mv); } catch { return '?'; }
    return wins1.includes(c) ? 'win1' : !wins3 ? '?' : wins3.includes(c) ? 'win3' : 'no3';
  };
  return { wins1, wins3, partial, threats, tinue, pinned: ask(verdict), over: null };
}

// ---------- the line model (app.js runEngine; the panel and the board's shapes read it) ----------
// A line: { move, pv: [ptn], ev, src: 'syntaks'|'tiltak'|'solver'|'puzzle', depth?, tags: ['puzzle'|'yours'|'played'],
// cand?: true }. ev is from the MOVER's side (the side to move at the position shown):
//   { kind: 'win', n, proven }   the mover wins in n of its own moves (proven: by our solver or the puzzle's line)
//   { kind: 'loss', n, proven }  the opponent wins in n of its moves
//   { kind: 'prob', p }          the mover's chance, 0..1 (Syntaks: practical, from human games; Tiltak: MCTS score)
//   { kind: 'nowin', n }         our solver: no forced win within n moves (and nothing else known)
//   { kind: 'pending' }          not searched yet
const side = (x, mover) => (mover === 1 ? x : 1 - x);
const mateEv = (mate, mover, extra = 0) => {
  const m = mover === 1 ? mate : -mate; // > 0: the mover mates
  return m > 0 ? { kind: 'win', n: m + extra, proven: false } : { kind: 'loss', n: -m, proven: false };
};

// One line of the server's /api/analyze answer (White's view: mate signed for White, in moves; winProb White's).
// mpv: its index in the answer's lines (0: line 1), which mergeLines keeps as the engine's order.
export function fromSyntaks(l, mover, mpv = null) {
  const pv = l.pv || [];
  const ev = l.mate ? mateEv(l.mate, mover) : l.winProb == null ? { kind: 'pending' } : { kind: 'prob', p: side(l.winProb, mover) };
  return { move: l.move ?? pv[0] ?? l.best ?? null, pv, ev, src: 'syntaks', depth: l.depth, tags: [], ...(mpv != null ? { mpv } : {}) };
}
// Tiltak's answer (public/tiltak.js: winProb is White's).
export function fromTiltak(r, mover) {
  const pv = r.pv || [];
  return { move: pv[0] ?? r.bestmove ?? null, pv, ev: r.winProb == null ? { kind: 'pending' } : { kind: 'prob', p: side(r.winProb, mover) },
    src: 'tiltak', depth: r.depth, tags: [] };
}
// A search of the position after `move` (the opponent to move there), Syntaks's or Tiltak's shape (both White's view),
// read as the mover's line: the move, then the child's line. A mate the mover gives from the child is one move longer
// from here (its own move first); one the opponent gives is as long.
export function fromChild(r, move, mover) {
  const ev = r.mate ? mateEv(r.mate, mover, 1) : r.winProb == null ? { kind: 'pending' } : { kind: 'prob', p: side(r.winProb, mover) };
  return { move, pv: [move, ...(r.pv || [])], ev, src: r.engine === 'syntaks' ? 'syntaks' : 'tiltak', depth: r.depth, tags: [] };
}

// A move that ends the game where it is played (res: the game's result after it): a win in 1, a loss on the spot (it
// completes only the opponent's road, say) or a draw. Both engine paths use it for a candidate or a miss like that.
export function endLine(move, res, mover, src = 'solver') {
  const ev = res.winner === mover ? { kind: 'win', n: 1, proven: true } : res.winner ? { kind: 'loss', n: 0, proven: true } : { kind: 'prob', p: 0.5 };
  return { move, pv: [move], ev, src, tags: [] };
}
// A candidate or a miss judged without a search, from c (the position after `move`): one that ends the game (endLine),
// or one that leaves the opponent a win on the spot, a proven "loses in 1" with that reply. Tiltak never reports a
// mate, so a search of such a move only ever said "0%". null: nothing exact to say, search it.
// The reply shown: a flat rather than the capstone on the same square, then the first by back(m) (pagesym.js toServer
// back: the move in the puzzle's own orientation), so every turn of the board shows the same reply, turned.
export function quickLine(c, move, mover, back = (m) => m) {
  const res = c.result();
  if (res) return endLine(move, res, mover);
  const all = winningMoves(c, 1).moves, ws = all.filter((m) => !(m[0] === 'C' && all.includes(m.slice(1))));
  if (!ws.length) return null;
  const reply = ws.reduce((a, b) => (back(b) < back(a) ? b : a));
  return { move, pv: [move, reply], ev: { kind: 'loss', n: 1, proven: true }, src: 'solver', tags: [] };
}

// The chip's words, from the mover's side.
export function evalLabel(ev) {
  if (!ev) return '…';
  if (ev.kind === 'win') return `wins in ${ev.n}`;
  if (ev.kind === 'loss') return ev.n ? `loses in ${ev.n}` : 'loses at once';
  if (ev.kind === 'prob') return Math.abs(ev.p - 0.5) < 0.05 ? 'even' : `${Math.round(ev.p * 100)}%`;
  if (ev.kind === 'nowin') return `no win ≤${ev.n ?? 2}`;
  return '…';
}

// The chip's words spoken for the side ahead (the header speaks in colours too, so a chip never says "1%" under
// "White 99%"): { text, side: 1 | 2 (whose colour the chip is filled with) | 0 (nobody ahead, or nothing known) }.
// mover: the side to move at the position shown (ev is its view).
export function chipLabel(ev, mover) {
  if (!ev) return { text: '…', side: 0 };
  if (ev.kind === 'win') return { text: `wins in ${ev.n}`, side: mover };
  if (ev.kind === 'loss') return { text: ev.n ? `wins in ${ev.n}` : 'wins', side: 3 - mover };
  if (ev.kind === 'prob') {
    const w = mover === 1 ? ev.p : 1 - ev.p;
    return Math.abs(w - 0.5) < 0.05 ? { text: 'even', side: 0 } : { text: `${Math.round(Math.max(w, 1 - w) * 100)}%`, side: w > 0.5 ? 1 : 2 };
  }
  if (ev.kind === 'nowin') return { text: `no win ≤${ev.n ?? 2}`, side: 0 };
  return { text: '…', side: 0 };
}

// A line's moves with their numbers, as the move list writes them: "25." before White's move, "25…" only when the line
// opens on Black's. ply: the plies played before the line's first move (Game.ply). [{ num: '25.' | '25…' | '', ptn }]
export function numberedPV(pv, ply) {
  return (pv || []).map((ptn, k) => {
    const p = ply + k, n = Math.floor(p / 2) + 1;
    return { num: p % 2 === 0 ? `${n}.` : k === 0 ? `${n}…` : '', ptn };
  });
}
// A move's parts, for a quiet colouring: [{ t: text, c: 'n' (count, drops) | 'q' (square) | 'd' (direction) | 'k'
// (S, C, the smash's *) }]. Anything that doesn't parse is one plain part.
export function ptnParts(ptn) {
  const m = /^([1-9]?)([SC]?)([a-z][1-9])([<>+-]?)([1-9]*)(\*?)$/.exec(ptn || '');
  if (!m) return [{ t: ptn || '', c: 'q' }];
  return [[m[1], 'n'], [m[2], 'k'], [m[3], 'q'], [m[4], 'd'], [m[5], 'n'], [m[6], 'k']].filter(([t]) => t).map(([t, c]) => ({ t, c }));
}

// Ordering: wins (fewest moves; proven first on a tie) > chances (highest first) > "no win ≤N" > losses (longest first)
// > not searched yet. Lines that tie keep the order they came in (the engine's). A chance ranks by l.rp when set
// (mergeLines: one search's lines keep the engine's order).
const rank = (l) => {
  const ev = l.ev;
  switch (ev?.kind) {
    case 'win': return [0, ev.n, ev.proven ? 0 : 1];
    case 'prob': return [1, -(l.rp ?? ev.p), 0];
    case 'nowin': return [2, 0, 0];
    case 'loss': return [3, -ev.n, ev.proven ? 1 : 0];
    default: return [4, 0, 0];
  }
};
const cmp = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const PINS = ['puzzle', 'yours'];

// The panel's lines: the engines' (`lines`, in their order), what our solver proved (`solver`: solverLines' answer, or
// null), and the moves pinned at this position (`pinned`: the puzzle's move, yours, the game's; pinnedAt). A move is
// one line: tags are merged, and the solver's or the puzzle's proof replaces an engine's opinion of it. Sorted (rank),
// at most `cap` lines, except that the puzzle's move and yours are never dropped. `canon` canonicalises a move (moves
// from every source already are; it is there for the tests and for safety).
export function mergeLines(lines, solver, pinned = [], cap = 3, canon = (m) => m) {
  const out = [], at = new Map();
  const key = (m) => { try { return canon(m); } catch { return m; } };
  const add = (l) => {
    if (!l?.move) return null;
    const k = key(l.move), have = at.get(k);
    if (!have) { const c = { ...l, tags: [...(l.tags || [])] }; at.set(k, c); out.push(c); return c; }
    for (const t of l.tags || []) if (!have.tags.includes(t)) have.tags.push(t);
    // A proof comes with the line that proves it: the puzzle's proven line replaces an engine's (perhaps slower) pv, and
    // the solver's one-move placeholder, whenever its proof is the row's.
    const puzzleProof = l.src === 'puzzle' && l.ev?.proven && l.pv?.length;
    if (better(l.ev, have.ev)) { have.ev = l.ev; if (puzzleProof || l.pv?.length > (have.pv?.length || 0) || have.ev.kind === 'pending') have.pv = l.pv; }
    else if (puzzleProof && have.ev?.proven && have.ev.kind === l.ev.kind && have.ev.n === l.ev.n) have.pv = l.pv;
    if (have.ev.kind === 'pending' && l.ev?.kind !== 'pending') { have.ev = l.ev; have.pv = l.pv; have.src = l.src; }
    return have;
  };
  // One MultiPV search's lines (mpv set, in index order) keep the engine's order among themselves: a search cut short
  // can leave a lower line at an older depth with a higher chance than the deeper line above it (shared/tei.js
  // bestLines), so each ranks at no more than the chances above it (rp; the chance shown is still its own).
  let floor = Infinity;
  for (const l of lines || []) add(l?.mpv != null && l.ev?.kind === 'prob' ? { ...l, rp: (floor = Math.min(floor, l.ev.p)) } : l);
  const proof = (n) => ({ kind: 'win', n, proven: true });
  for (const [ms, n] of [[solver?.wins1, 1], [solver?.wins3, 2]]) for (const m of ms || []) {
    const have = at.get(key(m));
    if (have) { if (!(have.ev.kind === 'win' && have.ev.proven && have.ev.n <= n)) have.ev = proof(n); continue; }
    // a road a flat completes a capstone completes too: 'Cf2' beside 'f2' is the same win, one line (as threats)
    const twin = m[0] === 'C' ? m.slice(1) : 'C' + m;
    if (ms.includes(twin) && (m[0] === 'C' || at.has(key(twin)))) continue;
    add({ move: m, pv: [m], ev: proof(n), src: 'solver', tags: [] });
  }
  for (const p of pinned || []) {
    let l = p;
    // the solver's verdict on a pinned move nobody has searched yet
    const v = solver?.pinned?.[p.move];
    if (p.ev?.kind === 'pending' && v && v !== '?') l = { ...p, ev: v === 'no3' ? { kind: 'nowin', n: 2 } : proof(v === 'win1' ? 1 : 2), src: 'solver' };
    if (p.tags?.includes('played') && !at.has(key(p.move))) continue; // the game's move: a tag on a line, never a line of its own
    add(l);
  }
  // A capstone and a flat on one square with the same proven result are one row (Cc3 beside c3, both "wins in 2"): the
  // one a pin is on (the puzzle's move, yours), else the flat, with the other's tags.
  for (const c of [...out]) {
    if (c.move?.[0] !== 'C') continue;
    const f = at.get(key(c.move.slice(1)));
    if (!f || !sameProof(c.ev, f.ev)) continue;
    const [keep, drop] = c.tags.some((t) => PINS.includes(t)) && !f.tags.some((t) => PINS.includes(t)) ? [c, f] : [f, c];
    for (const t of drop.tags) if (!keep.tags.includes(t)) keep.tags.push(t);
    out.splice(out.indexOf(drop), 1);
  }
  const sorted = out.sort(cmp);
  const kept = sorted.slice(0, cap);
  // past `cap`: the puzzle's move, and one of yours (the first by rank), never more
  let yours = kept.some((l) => l.tags.includes('yours'));
  for (const l of sorted.slice(cap)) {
    if (l.tags.includes('puzzle')) kept.push(l);
    else if (l.tags.includes('yours') && !yours) { kept.push(l); yours = true; }
  }
  return kept;
}
const sameProof = (a, b) => !!a?.proven && !!b?.proven && a.kind === b.kind && (a.kind === 'win' || a.kind === 'loss') && a.n === b.n;
// Whether `a` says more than `b` about a move: a proof beats an opinion; between proofs the shorter win.
function better(a, b) {
  if (!a || a.kind === 'pending') return false;
  if (!b || b.kind === 'pending') return true;
  const pa = a.proven && (a.kind === 'win' || a.kind === 'loss'), pb = b.proven && (b.kind === 'win' || b.kind === 'loss');
  if (pa !== pb) return pa;
  if (pa && a.kind === 'win' && b.kind === 'win') return a.n < b.n;
  return false;
}

// Moves worth a short search of their own on the Tiltak path, in order: yours, then the solver's wins in 2 (a search
// gives their defence a line; a win in 1 needs none), then Tiltak's runner-ups; never line 1's move nor one the puzzle
// already proves. At most `max`.
export function pickCandidates({ line1, solver, pinned = [], runnerUps = [], max = 2 }) {
  const out = [], skip = new Set([line1, ...(solver?.wins1 || [])]);
  for (const p of pinned) if (p.tags?.includes('puzzle')) skip.add(p.move);
  const yours = pinned.filter((p) => p.tags?.includes('yours')).map((p) => p.move);
  for (const m of [...yours, ...(solver?.wins3 || []), ...runnerUps]) {
    if (out.length >= max) break;
    if (m && !skip.has(m) && !out.includes(m)) out.push(m);
  }
  return out;
}

// The moves pinned at ply `at` of the line shown (the official line: the game's history, then the moves played):
//   puzzle: the puzzle's own move, when the solver (the side that solves the puzzle) is to move there and the move is
//           one of the puzzle's tree: proven, in as many of its moves as the tree has left there (no search)
//   yours:  a move you tried here and missed (searched like any other)
//   played: the game's move here (history), a tag only
// tree: the puzzle's own plies of the official line from histLen on (its tree's moves, up to the first that isn't: a slow
// win or a play-on game is not proven move by move), each solver ply holding the plies the tree has left there (app.js
// treePlies), the defender's null.
export function pinnedAt({ official, histLen, at, onBranch, solver, mover, misses = [], tree = [] }) {
  if (onBranch) return [];
  const out = [];
  if (at < histLen && official[at]) out.push({ move: official[at], pv: [official[at]], ev: { kind: 'pending' }, src: 'puzzle', tags: ['played'] });
  const left = at >= histLen ? tree[at - histLen] : null;
  if (left != null && mover === solver && official[at])
    out.push({ move: official[at], pv: official.slice(at, Math.min(at + 8, histLen + tree.length)), ev: { kind: 'win', n: Math.ceil(left / 2), proven: true }, src: 'puzzle', tags: ['puzzle'] });
  for (const x of misses) if (histLen + x.at === at && !out.some((p) => p.move === x.ptn))
    out.push({ move: x.ptn, pv: [x.ptn], ev: { kind: 'pending' }, src: 'puzzle', tags: ['yours'] });
  return out;
}

// ---------- the board's shapes (board.js draws them in an SVG over the squares; ninja.js highlights line 1) ----------
// A move's geometry on the board (logical squares, r * n + c with rank 1 as r = 0), from the position it is played in
// (game: only for a smash, a cap's last drop of 1 onto a wall; '*' in the PTN says so too):
//   { kind: 'place', sq, type: 'F' | 'S' | 'C' }
//   { kind: 'spread', from, to, carry, drops: [{ sq, k }], smash }
// null for a spread that would leave the board.
export function moveShape(ptn, n, game) {
  // (parseMove throws for a square or spread off the board, shared/tak.js; here that is the null this promises)
  let mv;
  try { mv = (game || new Game(n)).parseMove(ptn); } catch (e) { if (/off the board|leaves the board/.test(e.message)) return null; throw e; }
  if (mv.kind === 'p') return { kind: 'place', sq: mv.sq, type: mv.type === WALL ? 'S' : mv.type === CAP ? 'C' : 'F' };
  const [dr, dc] = DIRS[mv.dir];
  let r = (mv.sq / n) | 0, c = mv.sq % n;
  const drops = [];
  for (const k of mv.drops) {
    r += dr; c += dc;
    if (r < 0 || c < 0 || r >= n || c >= n) return null;
    drops.push({ sq: r * n + c, k });
  }
  const to = drops.at(-1).sq, top = game?.board?.[to]?.at(-1);
  const smash = /\*$/.test(ptn.trim()) || (top != null && typeOf(top) === WALL && mv.drops.at(-1) === 1);
  return { kind: 'spread', from: mv.sq, to, carry: mv.drops.reduce((a, b) => a + b, 0), drops, smash };
}

// Where a square is drawn: [display column, display row (up)] under the orientation matrix M (board.js OPS): the
// logical coordinates doubled and centred, so every turn and mirror stays in integers. Board._disp is this.
export function dispPoint(sq, n, M) {
  const h = n - 1, [a, b, c, d] = M, X = 2 * (sq % n) - h, Y = 2 * ((sq / n) | 0) - h;
  return [(a * X + b * Y + h) / 2, (c * X + d * Y + h) / 2];
}

// Where piece z (0: the bottom) of a stack of len is drawn on an n×n board (board.js _render; the end screen's still
// pictures, rush-look.js, use it too, so a stack looks the same in both): its lift in % of a square, SP per step (a
// wall on a stack one step lower; up: a carried hand, GAP steps higher); imm, one of the slivers up the side below the
// top n; ov, a sliver hidden below the lowest ten; z, its stacking order.
export const SP = 7, GAP = 3;
export function stackPiece(len, z, n, wall = false, up = false) {
  const over = Math.max(0, len - 10 - n), imm = len - z > n;
  let y = SP * (z + (up ? GAP : 0));
  if (len > n && z >= len - n) y -= SP * (len - n);
  if (wall && len > 1) y -= SP;
  if (imm) y -= SP * over;
  return { y, imm, ov: z < over, z: 10000 + z + (up ? GAP : 0) - (imm ? over : 0) };
}

// SVG markup for a viewBox of 0 0 n n (one unit a square, y down) over the board. list: [{ shape (moveShape), role,
// color: 1 | 2 (whose stone a placement would be) }]. A placement is a ring and a faint ghost of the stone; a spread an
// arrow from the stack to its last drop square, with the number carried at its tail, and a count on each drop square
// when the stones are split over more than one (3d3>12 and 3d3>21 differ only there); a smash is a bar across the head.
// Colours and strengths are board.css's (.tb-ov).
// The analysis page's roles on tinue's own board (board.js, retired: PTN Ninja draws none of them), drawn bottom to top: 'alt' (the line selected below line 1), 'yours'
// (your move, selected), 'best' (line 1), then the opponent's threats on top of them all, thin, so the threat a move
// blocks is never hidden under that move's own ring or arrow. Each of these marks is drawn over a dark casing (.cs), so
// it reads on the cloth and across a cream stone alike. A threat is a small ring inside the square it wins on (inside an
// engine ring, which is larger), one ring per square however many threats end there, and a spread's threat an arrow
// that stops at that ring, so three threats into one square read as one target with tails. The stones an analysis
// line's spread carries and drops (its count discs) are drawn last of all (.lb), so no threat covers a count.
// The Rush end screen's pictures (rush-look.js) add two roles drawn as strongly as line 1, without casings unless the
// item asks for one (cs; shown only where a board theme needs it, rush-theme.js): 'bad', the
// move played when it was wrong (red), under 'good', the puzzle's move (green); there two moves can share a square or a
// line, so an item may carry r (a placement ring's radius, .42 unless given), shift (a spread's arrow moved sideways by that much of a square, so two along one
// line both show) and lead (the count of stones carried moved that far along its own arrow, so two spreads off one
// stack each show theirs).
const ORDER = { alt: 1, yours: 2, bad: 3, best: 4, good: 4, threat: 5 };
const STRONG = new Set(['best', 'good', 'bad']);
const CASED = { best: 0.07, alt: 0.055, yours: 0.06, threat: 0.045 }; // (the ring's stroke width, for the roles with a casing;
// Rush's good and bad have one only when the item asks (cs: rush-look.js), shown only where a board theme needs it)
// Ring radii, so that rings on one square never share a band (radius ± (stroke + casing) / 2): line 1's .42 (.36-.48),
// a selected line placing on line 1's square inset at ALT_IN (.26-.36), a threat on an empty square THREAT_R (.15-.25,
// over the ghost stone). A threat that ends on a stone rings it from outside, THREAT_ON (.35-.45: past a flat's rounded
// corners, ~.34 from the centre, so a flat never reads as a capstone); no engine ring can be on an occupied square.
export const THREAT_R = 0.2, THREAT_ON = 0.4, ALT_IN = 0.31, CASE_W = 0.05;
const f2 = (x) => +x.toFixed(3);
export function shapesSvg(list, n, M) {
  const at = (sq) => { const [dc, dr] = dispPoint(sq, n, M); return [dc + 0.5, n - 1 - dr + 0.5]; };
  const out = [], ringed = new Set(), labels = [];
  for (const { shape: s, role = 'alt', color = 1, r: r0, shift = 0, lead = 0, cs: wantCs = false } of [...(list || [])].filter((x) => x?.shape).sort((a, b) => (ORDER[a.role] ?? 1) - (ORDER[b.role] ?? 1))) {
    const strong = STRONG.has(role), thin = role === 'threat', rw = CASED[role] ?? (wantCs ? 0.09 : undefined), cased = rw != null;
    const lay = cased && !wantCs; // (an asked-for casing (Rush's) leaves the counts and drops where they were)
    const r = r0 ?? (thin ? THREAT_R : 0.42);
    let g = '', cs = '', lb = '';
    // a ring: cased, its width inline (board.css's .rg width is for the Rush roles)
    const ring = (x, y) => {
      if (!cased) return `<circle class="rg" cx="${x}" cy="${y}" r="${r}"/>`;
      cs += `<circle class="cs" cx="${x}" cy="${y}" r="${r}" style="stroke-width:${f2(rw + CASE_W)}"/>`;
      return `<circle class="rg" cx="${x}" cy="${y}" r="${r}" style="stroke-width:${rw}"/>`;
    };
    if (s.kind === 'place') {
      const [x, y] = at(s.sq);
      if (!thin) g += ring(x, y);
      else if (!ringed.has(s.sq)) { ringed.add(s.sq); g += ring(x, y); }
      if (!thin) {
        if (s.type === 'C') g += `<circle class="gh p${color}" cx="${x}" cy="${y}" r=".25"/>`;
        else if (s.type === 'S') g += `<rect class="gh p${color}" x="${f2(x - 0.094)}" y="${f2(y - 0.25)}" width=".19" height=".5" rx=".04" transform="rotate(${color === 1 ? -45 : 45} ${x} ${y})"/>`;
        else g += `<rect class="gh p${color}" x="${f2(x - 0.25)}" y="${f2(y - 0.25)}" width=".5" height=".5" rx=".05"/>`;
      }
    } else {
      let [x0, y0] = at(s.from), [x1, y1] = at(s.to);
      const len = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / len, uy = (y1 - y0) / len, px = -uy, py = ux;
      if (shift) { x0 += px * shift; y0 += py * shift; x1 += px * shift; y1 += py * shift; }
      const w = thin ? 0.07 : strong ? 0.16 : 0.09, hl = thin ? 0.22 : strong ? 0.34 : 0.26, hw = thin ? 0.14 : strong ? 0.27 : 0.19;
      // (a threat's head stops at its target's ring; the others' tip .12 past the target's centre)
      const tx = thin ? x1 - ux * (r + 0.02) : x1 + ux * 0.12, ty = thin ? y1 - uy * (r + 0.02) : y1 + uy * 0.12, bx = tx - ux * hl, by = ty - uy * hl;
      if (thin && !ringed.has(s.to)) { ringed.add(s.to); g += ring(x1, y1); }
      const shaft = `x1="${f2(x0)}" y1="${f2(y0)}" x2="${f2(bx + ux * 0.02)}" y2="${f2(by + uy * 0.02)}"`;
      const head = `points="${f2(tx)},${f2(ty)} ${f2(bx + px * hw)},${f2(by + py * hw)} ${f2(bx - px * hw)},${f2(by - py * hw)}"`;
      const bar = `x1="${f2(tx + ux * 0.04 + px * 0.3)}" y1="${f2(ty + uy * 0.04 + py * 0.3)}" x2="${f2(tx + ux * 0.04 - px * 0.3)}" y2="${f2(ty + uy * 0.04 - py * 0.3)}"`;
      if (cased) {
        cs += `<line class="cs" ${shaft} stroke-width="${f2(w + CASE_W)}"/><polygon class="cs" ${head} stroke-width="${CASE_W}"/>`;
        if (s.smash) cs += `<line class="cs" ${bar} stroke-width="${f2(0.08 + CASE_W)}"/>`;
      }
      g += `<line class="sf" ${shaft} stroke-width="${w}"/>`;
      g += `<polygon class="hd" ${head}/>`;
      if (s.smash) g += `<line class="sm" ${bar}/>`;
      const cx0 = x0 + ux * lead, cy0 = y0 + uy * lead;
      // (the counts of an analysis line go on a layer of their own over the threats, so a threat ring never hides one)
      const put = (m) => { if (lay) lb += m; else g += m; };
      if (!thin && s.carry > 1) put(`<circle class="dc" cx="${f2(cx0)}" cy="${f2(cy0)}" r=".17"/><text x="${f2(cx0)}" y="${f2(cy0)}">${s.carry}</text>`);
      if (!thin && s.drops.length > 1) for (const { sq, k } of s.drops) {
        // (an analysis line's drop counts follow its shift, so two collinear lines' counts sit apart)
        const [x, y] = at(sq), o = 0.3 + (lay ? 2 * shift : 0), cx = x + px * o, cy = y + py * o;
        put(`<circle class="dd" cx="${f2(cx)}" cy="${f2(cy)}" r=".14"/><text x="${f2(cx)}" y="${f2(cy)}">${k}</text>`);
      }
    }
    out.push(`<g class="sh ${role}">${cs}${g}</g>`);
    if (lb) labels.push(`<g class="sh lb ${role}">${lb}</g>`);
  }
  return out.join('') + labels.join('');
}

// The opponent's threats as shown: one per square for placements (the flat; solverLines already) and one per stack and
// direction for spreads (2f6<, 3f6<12, f6< ... are one threat: that stack going left), the one carrying fewest stones.
export function threatGroups(threats, n) {
  const out = new Map(), g = new Game(n);
  for (const t of threats || []) {
    let k = t, w = 0;
    try { const mv = g.parseMove(t); if (mv.kind === 'm') { k = mv.sq + mv.dir; w = mv.drops.reduce((a, b) => a + b, 0) * 10 + mv.drops.length; } else { k = 'p' + mv.sq; w = mv.type === WALL ? 1 : mv.type === CAP ? 2 : 0; } } catch {}
    const have = out.get(k);
    if (!have || w < have.w) out.set(k, { t, w });
  }
  return [...out.values()].map((x) => x.t);
}
