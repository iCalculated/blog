// Tinue prover: depth-first proof-number search (df-pn) over "Tak threat" attacker moves.
//
// Model (after Tiltak's tinue_search.rs and Topaz's proof.rs):
//   - Attacker = side to move at the root. At an attacker (OR) node, an immediate win proves it;
//     otherwise the attacker may only play moves after which, if it were their turn again, they
//     could win immediately (a null-move "Tak" test). No such move => disproved.
//   - Defender (AND) nodes consider every move that could matter: an immediate defender win
//     disproves; otherwise only moves touching one attacker win W or the road C it would complete
//     (anything else leaves W winning). Every legal move near flat-count endings, where that
//     argument breaks; {fullDefense:true} forces every legal move (used to validate the pruning).
//   - Restricting the attacker is sound for proofs (a found tinue is a real forced win) but
//     incomplete: wins that need a quiet (non-threat) attacker move or a flat count are missed.
//
// API:
//   proveTinue(g, {maxNodes})            → {result, plies, pv, nodes}       unlimited df-pn
//   shortestTinue(g, maxPlies, {maxNodes}) → {result, plies, exact, lowerBound, pv, nodes}
//   allTinueMoves(g, plies, {maxNodes, detail}) → [ptn…] (or {moves:[{move,plies}], unknown, nodes})
//   winMove(g, color) / threatMoves(g) / defenderMoves(g, attacker) / TinueSearch (low level)
// result is 'proved' | 'disproved' (no Tak-threat tinue) | 'unknown' (budget). maxNodes counts df-pn
// MID calls; one node costs roughly 0.2–0.5 ms CPU on 6x6 midgames.
import { colorOf, typeOf, FLAT, WALL, CAP, DIRS } from './tak.js?v=1794121741';

const INF = 1e9;
const DIR_LIST = ['+', '-', '>', '<'];
const reserves = (g, c) => g.stones[c] + g.caps[c];
// 53-bit numeric position key from the engine's two 32-bit Zobrist halves (side to move is folded in).
export const keyNum = (g) => g.ha * 2097152 + (g.hb & 0x1fffff);

// ---------------------------------------------------------------------------------------------
// Fast "can `c` win right now (as if it were their move)?" — returns a winning move or null.
// Assumes neither side already has a road (true of any position where the game is still on).
//   - Placements: label c's road components with edge masks; an empty square completes a road iff
//     its own edges plus its neighbours' component masks span N–S or E–W.
//   - Stack moves: for each (stack, direction) an optimistic bound (source stays ours, every
//     reachable square becomes ours) is checked with the same masks; survivors are enumerated
//     exactly, each candidate spread costing O(segment length).
//   - Near flat-count endings (or in the opening) it falls back to the exact legalMoves+result loop;
//     spreads that would fill the board's last empty squares are also checked exactly.
// ---------------------------------------------------------------------------------------------
const MAXN = 64;
const N_ = 1, S_ = 2, E_ = 4, W_ = 8;
const spansMask = (m) => (m & 3) === 3 || (m & 12) === 12;
const GEO = {};
function geo(size) {
  if (GEO[size]) return GEO[size];
  const n = size * size, edge = new Int32Array(n), step = new Int32Array(n * 4);
  const D = [[1, 0], [-1, 0], [0, 1], [0, -1]]; // '+', '-', '>', '<'
  for (let sq = 0; sq < n; sq++) {
    const r = (sq / size) | 0, c = sq % size;
    edge[sq] = (r === size - 1 ? N_ : 0) | (r === 0 ? S_ : 0) | (c === size - 1 ? E_ : 0) | (c === 0 ? W_ : 0);
    for (let d = 0; d < 4; d++) {
      const rr = r + D[d][0], cc = c + D[d][1];
      step[sq * 4 + d] = rr >= 0 && rr < size && cc >= 0 && cc < size ? rr * size + cc : -1;
    }
  }
  return (GEO[size] = { edge, step });
}

const sRoad = new Uint8Array(MAXN), sTop = new Int32Array(MAXN), sComp = new Int32Array(MAXN), sMask = new Int32Array(MAXN);
const sStack = new Int32Array(MAXN), sSeen = new Uint8Array(MAXN), sPath = new Int32Array(16);

// Does the road map contain a spanning road? (fallback only)
function floodRoad(road, size) {
  const { edge, step } = geo(size), n = size * size;
  for (let pass = 0; pass < 2; pass++) {
    const from = pass === 0 ? W_ : S_, to = pass === 0 ? E_ : N_;
    sSeen.fill(0, 0, n);
    let sp = 0;
    for (let sq = 0; sq < n; sq++) if ((edge[sq] & from) && road[sq]) { sSeen[sq] = 1; sStack[sp++] = sq; }
    while (sp) {
      const x = sStack[--sp];
      if (edge[x] & to) return true;
      for (let d = 0; d < 4; d++) { const y = step[x * 4 + d]; if (y >= 0 && !sSeen[y] && road[y]) { sSeen[y] = 1; sStack[sp++] = y; } }
    }
  }
  return false;
}

// Exact but slow: try every legal move for `c`.
export function slowWinMove(g, c) {
  const saved = g.toMove;
  g.toMove = c;
  try {
    for (const mv of g.legalMoves()) {
      const u = g.apply(mv);
      const r = g.result();
      g.undo(u);
      if (r && r.winner === c) return mv;
    }
    return null;
  } finally { g.toMove = saved; }
}

// label connected components of road[] (skipping squares with skip[]=1) into comp[]/mask[]
function label(n, edge, step, road, comp, mask, skip) {
  let nc = 0;
  for (let x = 0; x < n; x++) comp[x] = -1;
  for (let x0 = 0; x0 < n; x0++) {
    if (!road[x0] || comp[x0] >= 0 || (skip && skip[x0])) continue;
    let sp = 0, m = 0;
    sStack[sp++] = x0; comp[x0] = nc;
    while (sp) {
      const x = sStack[--sp];
      m |= edge[x];
      for (let d = 0; d < 4; d++) {
        const y = step[x * 4 + d];
        if (y >= 0 && road[y] && comp[y] < 0 && !(skip && skip[y])) { comp[y] = nc; sStack[sp++] = y; }
      }
    }
    mask[nc++] = m;
  }
  return nc;
}

// `touched` (optional, Uint8Array over squares): the squares changed by the move just played, when
// `c` had no winning move before it. Then a spread can only newly win if its segment meets a
// touched square or a component holding a newly-ours touched square, so others skip enumeration.
const sNew = new Uint8Array(MAXN), sTouched = new Uint8Array(MAXN);
export function winMove(g, c, touched = null) {
  const size = g.size, n = g.n, B = g.board;
  const { edge, step } = geo(size);
  const road = sRoad, tp = sTop, comp = sComp, mask = sMask;
  let empties = 0;
  for (let s = 0; s < n; s++) {
    const st = B[s], L = st.length;
    if (!L) { empties++; tp[s] = -1; road[s] = 0; continue; }
    const t = st[L - 1];
    tp[s] = t;
    road[s] = (t & 1) + 1 === c && (t >> 1) !== WALL ? 1 : 0;
  }
  if (g.ply < 2 || empties <= 1 || reserves(g, c) <= 1) return slowWinMove(g, c);
  const nc = label(n, edge, step, road, comp, mask, null);
  if (touched) {
    sNew.fill(0, 0, nc);
    for (let s = 0; s < n; s++) if (touched[s] && road[s]) sNew[comp[s]] = 1;
  }
  // 1) placements
  if (g.stones[c] > 0 || g.caps[c] > 0) {
    for (let s = 0; s < n; s++) {
      if (tp[s] >= 0) continue;
      let m = edge[s];
      for (let d = 0; d < 4; d++) { const y = step[s * 4 + d]; if (y >= 0 && road[y]) m |= mask[comp[y]]; }
      if (spansMask(m)) return { kind: 'p', sq: s, type: g.stones[c] > 0 ? FLAT : CAP };
    }
  }
  // 2) stack moves
  const path = sPath;
  for (let s = 0; s < n; s++) {
    const t0 = tp[s];
    if (t0 < 0 || (t0 & 1) + 1 !== c) continue;
    const st = B[s], h = st.length;
    const isCap = (t0 >> 1) === CAP;
    const carry = h < size ? h : size;
    let srcPot = false;
    for (let j = Math.max(0, h - 1 - carry); j <= h - 2; j++) if ((st[j] & 1) + 1 === c) { srcPot = true; break; }
    for (let d = 0; d < 4; d++) {
      let dist = 0, smashOK = false, plen = 0;
      for (let y = step[s * 4 + d]; y >= 0; y = step[y * 4 + d]) {
        const t = tp[y];
        if (t >= 0 && (t >> 1) !== FLAT) { if (isCap && (t >> 1) === WALL) { smashOK = true; path[plen++] = y; } break; }
        path[plen++] = y; dist++;
      }
      if (dist === 0 && !smashOK) continue;
      const smashReach = smashOK && carry >= dist + 1;
      const top = smashReach ? dist + 1 : Math.min(dist, carry);
      // optimistic bound: any new road runs through the (source +) path segment
      let m = 0, emptyOnPath = 0, fresh = !touched || touched[s];
      for (let i = srcPot ? -1 : 0; i < top; i++) {
        const x = i < 0 ? s : path[i];
        if (i >= 0 && tp[x] < 0) emptyOnPath++;
        if (touched && touched[x]) fresh = true;
        m |= edge[x];
        for (let e = 0; e < 4; e++) {
          const y = step[x * 4 + e];
          if (y >= 0 && road[y]) { m |= mask[comp[y]]; if (touched && sNew[comp[y]]) fresh = true; }
        }
      }
      const mayFill = emptyOnPath === empties; // a spread could fill the board: check exactly
      if (!spansMask(m) && !mayFill) continue;
      if (!fresh && !mayFill) continue; // nothing this pair could do now that it couldn't before
      const found = enumerateSpreads(g, c, st, s, d, dist, smashReach, carry, top, mayFill, empties);
      if (found) return found;
    }
  }
  return null;
}

// Enumerate the concrete spreads of stack `s` in direction d and return one that completes a road.
// The road map minus the affected segment (source + path) is labelled once; each candidate spread
// only needs which segment squares end up ours: maximal runs of those squares, merged when they
// touch a common component, span the board iff the spread wins.
const eSkip = new Uint8Array(MAXN), eComp = new Int32Array(MAXN), eCMask = new Int32Array(MAXN);
const eSeg = new Int32Array(16), eSqMask = new Int32Array(16), eSqSet = new Int32Array(16), eOn = new Uint8Array(16);
const eRMask = new Int32Array(16), eRSet = new Int32Array(16);
let eL = 0, eBits = true, eSize = 0;
const eMemo = new Int8Array(1 << 10); // segSpans result per eOn pattern (0 unknown, 1 no, 2 yes)
const popcount = (x) => { let k = 0; while (x) { x &= x - 1; k++; } return k; };

function segSpans() {
  const L = eL;
  let key = 0;
  for (let j = 0; j < L; j++) key = (key << 1) | eOn[j];
  const memo = eMemo[key];
  if (memo) return memo === 2;
  const ok = segSpansRaw(L);
  eMemo[key] = ok ? 2 : 1;
  return ok;
}

function segSpansRaw(L) {
  let nr = 0;
  for (let j = 0; j < L; j++) {
    if (!eOn[j]) continue;
    if (j === 0 || !eOn[j - 1]) { eRMask[nr] = 0; eRSet[nr] = 0; nr++; }
    eRMask[nr - 1] |= eSqMask[j]; eRSet[nr - 1] |= eSqSet[j];
  }
  if (!eBits && nr > 1) { // too many components for bitsets: flood the real map instead
    const saved = new Uint8Array(L);
    for (let j = 0; j < L; j++) { saved[j] = sRoad[eSeg[j]]; sRoad[eSeg[j]] = eOn[j]; }
    const ok = floodRoad(sRoad, eSize);
    for (let j = 0; j < L; j++) sRoad[eSeg[j]] = saved[j];
    return ok;
  }
  for (let merged = true; merged && nr > 1;) {
    merged = false;
    for (let a = 0; a < nr && !merged; a++) for (let b = a + 1; b < nr; b++) {
      if (eRSet[a] & eRSet[b]) { eRMask[a] |= eRMask[b]; eRSet[a] |= eRSet[b]; nr--; eRMask[b] = eRMask[nr]; eRSet[b] = eRSet[nr]; merged = true; break; }
    }
  }
  for (let i = 0; i < nr; i++) if (spansMask(eRMask[i])) return true;
  return false;
}

function dropsOf(count, cm, extra) {
  const d = []; let run = 0;
  for (let j = 0; j < count; j++) { run++; if (j === count - 1 || (cm >> j) & 1) { d.push(run); run = 0; } }
  if (extra) d.push(1);
  return d;
}

function exactSpread(g, c, s, d, drops) {
  const mv = { kind: 'm', sq: s, dir: DIR_LIST[d], drops };
  const saved = g.toMove; g.toMove = c;
  const u = g.apply(mv); const r = g.result(); g.undo(u);
  g.toMove = saved;
  return r && r.winner === c ? mv : null;
}

function enumerateSpreads(g, c, st, s, d, dist, smashReach, carry, top, mayFill, empties) {
  const size = g.size, n = g.n, h = st.length, path = sPath, road = sRoad, tp = sTop;
  const { edge, step } = geo(size);
  const L = top + 1; // segment: index 0 = source, i+1 = path[i]
  eL = L; eSize = size;
  eSeg[0] = s; for (let i = 0; i < top; i++) eSeg[i + 1] = path[i];
  for (let j = 0; j < L; j++) eSkip[eSeg[j]] = 1;
  const nc = label(n, edge, step, road, eComp, eCMask, eSkip);
  for (let j = 0; j < L; j++) eSkip[eSeg[j]] = 0;
  eBits = nc <= 31;
  eMemo.fill(0, 0, 1 << L);
  for (let j = 0; j < L; j++) {
    const x = eSeg[j];
    let m = edge[x], set = 0;
    for (let e = 0; e < 4; e++) {
      const y = step[x * 4 + e];
      if (y < 0) continue;
      const k = eComp[y];
      if (k >= 0) { m |= eCMask[k]; if (eBits) set |= 1 << k; }
    }
    eSqMask[j] = m; eSqSet[j] = set;
  }
  for (let count = 1; count <= carry; count++) {
    const base = h - count;
    eOn[0] = base > 0 && (st[base - 1] & 1) + 1 === c ? 1 : 0; // pieces under the top are flats
    // plain spreads: cut mask over the count-1 gaps, at most `dist` parts
    const lim = 1 << (count - 1);
    for (let cm = 0; cm < lim; cm++) {
      if (popcount(cm) + 1 > dist) continue;
      let q = 0;
      for (let j = 0; j < count; j++) if (j === count - 1 || (cm >> j) & 1) { const p = st[base + j]; eOn[++q] = (p & 1) + 1 === c && (p >> 1) !== WALL ? 1 : 0; }
      for (let i = q; i < top; i++) eOn[i + 1] = road[path[i]];
      if (mayFill) {
        let filled = 0;
        for (let i = 0; i < q; i++) if (tp[path[i]] < 0) filled++;
        if (filled === empties) { const mv = exactSpread(g, c, s, d, dropsOf(count, cm, false)); if (mv) return mv; continue; }
      }
      if (segSpans()) return { kind: 'm', sq: s, dir: DIR_LIST[d], drops: dropsOf(count, cm, false) };
    }
    // smashes: count-1 pieces into exactly `dist` parts, then the capstone alone onto the wall
    if (smashReach && count - 1 >= dist && (dist > 0 || count === 1)) {
      const m = count - 1;
      const lim2 = m > 0 ? 1 << (m - 1) : 1;
      for (let cm = 0; cm < lim2; cm++) {
        if (m > 0 && popcount(cm) !== dist - 1) continue;
        let q = 0;
        for (let j = 0; j < m; j++) if (j === m - 1 || (cm >> j) & 1) { const p = st[base + j]; eOn[++q] = (p & 1) + 1 === c && (p >> 1) !== WALL ? 1 : 0; }
        eOn[dist + 1] = 1; // capstone on the flattened wall
        const drops = m > 0 ? dropsOf(m, cm, true) : [1];
        if (mayFill) {
          let filled = 0;
          for (let i = 0; i <= dist; i++) if (tp[path[i]] < 0) filled++;
          if (filled === empties) { const mv = exactSpread(g, c, s, d, drops); if (mv) return mv; continue; }
        }
        if (segSpans()) return { kind: 'm', sq: s, dir: DIR_LIST[d], drops, smash: true };
      }
    }
  }
  return null;
}

// Attacker (side to move) moves that create a road-in-1 threat. Assumes no immediate win exists.
// Wall placements can't add a road square or an empty square, so they never create a road
// threat; they're only considered near flat endings (where a threat can be a flat-count win).
export function threatMoves(g) {
  const a = g.toMove, out = [];
  let empties = 0;
  for (let s = 0; s < g.n; s++) if (!g.board[s].length) empties++;
  const nearFlat = empties <= 3 || reserves(g, a) <= 3;
  const hint = winMove(g, a) ? null : sTouched; // touched-square hints need "no win before"
  for (const mv of g.legalMoves()) {
    if (mv.kind === 'p' && mv.type === WALL && !nearFlat && hint) continue; // with a win already on, a wall can keep it
    const u = g.apply(mv);
    // With no prior win and no flat ending near, the only way this move ends the game is by
    // uncovering an enemy road — possible only if a touched square now shows an enemy road piece.
    let r = null, sqs = null;
    if (nearFlat || !hint) r = g.result();
    else if (mv.kind === 'm') {
      sqs = moveSquares(g, mv);
      for (const sq of sqs) {
        const st = g.board[sq], t = st.length ? st[st.length - 1] : -1;
        if (t >= 0 && (t & 1) + 1 !== a && (t >> 1) !== WALL) { r = g.result(); break; }
      }
    }
    let keep = false;
    if (r) keep = r.winner === a;
    else if (hint) {
      sqs ||= moveSquares(g, mv);
      for (const sq of sqs) hint[sq] = 1;
      keep = !!winMove(g, a, hint);
      for (const sq of sqs) hint[sq] = 0;
    } else keep = !!winMove(g, a);
    g.undo(u);
    if (keep) out.push(mv);
  }
  // stack moves first, then caps, then flats — cheap ordering that tends to find proofs faster
  const sc = (m) => (m.kind === 'm' ? 0 : m.type === CAP ? 1 : 2);
  return out.sort((x, y) => sc(x) - sc(y));
}

// Squares a move touches: the placement square, or the source plus every square it drops on.
export function moveSquares(g, mv) {
  if (mv.kind === 'p') return [mv.sq];
  const out = [mv.sq], [dr, dc] = DIRS[mv.dir];
  let r = (mv.sq / g.size) | 0, c = mv.sq % g.size;
  for (let i = 0; i < mv.drops.length; i++) { r += dr; c += dc; out.push(r * g.size + c); }
  return out;
}

// Defender (side to move) moves worth considering against attacker `a`. Pick one attacker win W;
// let C be the spanning road W would complete. A defender move that touches none of W's squares
// and none of C leaves W legal with the same effect and C intact, so W still wins: only moves
// touching W ∪ C can matter (plus a defender win, which the search checks first). Near flat-count
// endings this argument breaks, so every legal move is returned there.
export function defenderMoves(g, a) {
  const d = g.toMove;
  let empties = 0;
  for (let s = 0; s < g.n; s++) if (!g.board[s].length) empties++;
  const W = empties >= 3 && reserves(g, d) >= 2 && g.ply >= 2 ? winMove(g, a) : null;
  if (!W) return g.legalMoves();
  const touch = new Uint8Array(g.n);
  for (const sq of moveSquares(g, W)) touch[sq] = 1;
  const saved = g.toMove;
  g.toMove = a;
  const u = g.apply(W);
  const road = g.roadSquares(a);
  g.undo(u);
  g.toMove = saved;
  if (!road) return g.legalMoves(); // W wins some other way (shouldn't happen off flat endings)
  for (const sq of road) touch[sq] = 1;
  const out = [];
  for (let sq = 0; sq < g.n; sq++) {
    if (!touch[sq] || g.board[sq].length) continue;
    if (g.stones[d] > 0) { out.push({ kind: 'p', sq, type: WALL }); out.push({ kind: 'p', sq, type: FLAT }); }
    if (g.caps[d] > 0) out.push({ kind: 'p', sq, type: CAP });
  }
  for (const mv of g.legalMoves()) {
    if (mv.kind !== 'm') continue;
    if (moveSquares(g, mv).some((sq) => touch[sq])) out.push(mv);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// df-pn. Table entries are [phi, delta] from the side to move's perspective (phi = proof number
// that the side to move wins). Depth-limited mode keys entries on (position, remaining plies),
// which also rules out cycles; unlimited mode keys on position only and treats a repetition on
// the current path as a defender success (sound for proofs, may under-report).
// Per-position move lists and "can the side to move win now" bits are cached across iterations.
// ---------------------------------------------------------------------------------------------
class Budget extends Error { constructor() { super('budget'); } }
const WIN = [0, INF], LOSS = [INF, 0];

export class TinueSearch {
  constructor(g, { maxNodes = 2e5, epsilon = 0.25, init = 'flat', fullDefense = false } = {}) {
    this.init = init; this.ply = 0; this.fullDefense = fullDefense;
    this.g = g; this.att = g.toMove;
    this.tts = new Map(); this.info = new Map();
    this.nodes = 0; this.maxNodes = maxNodes; this.eps = epsilon;
    this.path = new Set();
  }

  _infoAt(k) {
    let I = this.info.get(k);
    if (!I) { I = { win: !!winMove(this.g, this.g.toMove), kids: null }; this.info.set(k, I); }
    return I;
  }

  // Children of the current position: [{mv, key | null, term: value-from-child's-view | null}]
  _kids(I) {
    if (I.kids) return I.kids;
    const g = this.g, isOr = g.toMove === this.att;
    const moves = isOr ? threatMoves(g) : this.fullDefense ? g.legalMoves() : defenderMoves(g, this.att);
    const kids = [];
    for (const mv of moves) {
      const u = g.apply(mv);
      const res = g.result();
      if (res) {
        if (!(isOr && res.winner !== this.att)) kids.push({ mv, key: null, term: res.winner === g.toMove ? WIN : LOSS });
      } else {
        const k = keyNum(g);
        this._infoAt(k);
        kids.push({ mv, key: k, term: null });
      }
      g.undo(u);
    }
    return (I.kids = kids);
  }

  _static(I, p, isOr) {
    if (I.win) return WIN;
    if (isOr ? p < 3 : p < 2) return isOr ? LOSS : WIN;
    return null;
  }

  // Table lookup with depth monotonicity: attacker-proved at p-2 => proved at p;
  // attacker-disproved at p+2 => disproved at p.
  _tt(p) { let m = this.tts.get(p); if (!m) { m = new Map(); this.tts.set(p, m); } return m; }
  _lookup(k, p, isOr) {
    const e = this._tt(p).get(k);
    if (e || p === Infinity) return e;
    const lo = this.tts.get(p - 2)?.get(k);
    if (lo && (isOr ? lo[0] === 0 : lo[1] === 0)) return lo;
    const hi = this.tts.get(p + 2)?.get(k);
    if (hi && (isOr ? hi[1] === 0 : hi[0] === 0)) return hi;
    return undefined;
  }

  // Initial bounds for an unexplored node. 'topaz': proof numbers grow with depth (favours short
  // proofs) and stack-move replies look cheaper to refute, after Topaz's init_pns.
  _init(isOr, kd) {
    if (this.init === 'flat') return [1, 1];
    const d = this.ply + 1, d2 = d * d;
    if (!isOr) return [1, 30 + d2];
    return [kd && kd.mv.kind === 'm' ? 10 + d2 : 20 + d2, 1];
  }

  // Value of a position (key k, side to move isOr) at depth p, without searching.
  value(k, p, isOr, kd) {
    const I = this.info.get(k);
    const st = I && this._static(I, p, isOr);
    if (st) return st;
    if (p === Infinity && this.path.has(k)) return isOr ? LOSS : WIN; // repetition: defender holds
    return this._lookup(k, p, isOr) || this._init(isOr, kd);
  }

  _store(k, p, phi, delta) {
    const t = this._tt(p), e = t.get(k);
    if (e && e !== WIN && e !== LOSS) { e[0] = phi; e[1] = delta; } else t.set(k, [phi, delta]);
  }

  mid(p, thPhi, thDelta) {
    if (++this.nodes > this.maxNodes) throw new Budget();
    const g = this.g, k = keyNum(g), isOr = g.toMove === this.att;
    const I = this._infoAt(k);
    const st = this._static(I, p, isOr);
    if (st) { this._store(k, p, st[0], st[1]); return; }
    const kids = this._kids(I);
    const cp = p - 1, childOr = !isOr;
    if (p === Infinity) this.path.add(k);
    try {
      for (;;) {
        let phi = INF, delta = 0, best = -1, d1 = INF, d2 = INF, bestPhi = 0;
        for (let i = 0; i < kids.length; i++) {
          const kd = kids[i];
          const v = kd.term || this.value(kd.key, cp, childOr, kd);
          if (v[1] < phi) phi = v[1];
          delta += v[0];
          if (v[1] < d1) { d2 = d1; d1 = v[1]; best = i; bestPhi = v[0]; } else if (v[1] < d2) d2 = v[1];
        }
        if (delta > INF) delta = INF;
        this._store(k, p, phi, delta);
        if (phi >= thPhi || delta >= thDelta || phi === 0 || delta === 0) return;
        const c = kids[best];
        const cPhiTh = Math.min(INF, thDelta + bestPhi - delta);
        const cDeltaTh = Math.min(thPhi, d2 >= INF ? INF : Math.max(d2 + 1, Math.ceil(d2 * (1 + this.eps))));
        const u = g.apply(c.mv);
        this.ply++;
        try { this.mid(cp, cPhiTh, cDeltaTh); } finally { g.undo(u); this.ply--; }
      }
    } finally { if (p === Infinity) this.path.delete(k); }
  }

  // Attacker-proven status of the current position at depth p from the table (no search).
  proven(p) {
    const isOr = this.g.toMove === this.att;
    const v = this.value(keyNum(this.g), p, isOr);
    return isOr ? v[0] === 0 : v[1] === 0;
  }
  disproven(p) {
    const isOr = this.g.toMove === this.att;
    const v = this.value(keyNum(this.g), p, isOr);
    return isOr ? v[1] === 0 : v[0] === 0;
  }

  // Solve the current position (either side to move) to depth p: true = attacker forces a road
  // within p plies using Tak threats; false = not within the model. Throws Budget.
  solve(p) {
    if (this.proven(p)) return true;
    if (this.disproven(p)) return false;
    this.mid(p, INF, INF);
    return this.proven(p);
  }
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

// Depth and main line of the proof tree an unlimited search found: the attacker picks its
// shortest proven continuation, the defender its longest. Requires s.solve(Infinity) === true.
//
// Computed as the least fixpoint over the proven sub-DAG (OR = 1 + min, AND = 1 + max), so
// transpositions and cycles can't poison the depths the way a memoised DFS with an on-path cut can.
// An AND node whose pruned move list is empty (no defender move touches the attacker's win) has
// depth 2: any reply, then the win.
function proofTreeLine(s) {
  const g = s.g, nodes = new Map(), order = [];
  // iterative DFS over proven edges (the graph can be deep; avoid recursion limits)
  const open = (frames) => {
    const k = keyNum(g);
    if (nodes.has(k)) return false;
    const isOr = g.toMove === s.att, I = s._infoAt(k);
    const N = { isOr, win: I.win, edges: [], d: INF };
    nodes.set(k, N); order.push(N);
    frames.push({ N, kids: I.win ? [] : s._kids(I), i: 0, u: null });
    return true;
  };
  const frames = [];
  open(frames);
  while (frames.length) {
    const F = frames[frames.length - 1];
    if (F.i >= F.kids.length) { frames.pop(); if (F.u) g.undo(F.u); continue; }
    const kd = F.kids[F.i++], N = F.N, isOr = N.isOr;
    if (kd.term) {
      const attWon = isOr ? kd.term[1] === 0 : kd.term[0] === 0;
      if (attWon) N.edges.push({ mv: kd.mv, key: null, d: 1 });
      else if (!isOr) N.edges.push({ mv: kd.mv, key: null, d: INF });
      continue;
    }
    const proven = isOr ? s.value(kd.key, Infinity, false)[1] === 0 : s.value(kd.key, Infinity, true)[0] === 0;
    if (!proven) { if (!isOr) N.edges.push({ mv: kd.mv, key: null, d: INF }); continue; }
    N.edges.push({ mv: kd.mv, key: kd.key, d: 0 });
    const u = g.apply(kd.mv);
    if (open(frames)) frames[frames.length - 1].u = u; else g.undo(u);
  }
  const ev = (e) => (e.key === null ? e.d : Math.min(INF, 1 + nodes.get(e.key).d));
  for (let changed = true; changed;) {
    changed = false;
    for (const N of order) {
      let d;
      if (N.win) d = N.isOr ? 1 : INF;
      else if (N.isOr) { d = INF; for (const e of N.edges) d = Math.min(d, ev(e)); }
      else if (!N.edges.length) d = 2;
      else { d = 0; for (const e of N.edges) d = Math.max(d, ev(e)); }
      if (d < N.d) { N.d = d; changed = true; }
    }
  }
  const root = nodes.get(keyNum(g));
  const pv = [], undos = [];
  try {
    for (let i = 0; i < 200; i++) {
      const N = nodes.get(keyNum(g));
      let mv = null;
      if (!N) { // off the proof graph (after an arbitrary reply to an unanswerable threat)
        const w = g.toMove === s.att ? winMove(g, s.att) : null;
        if (w) pv.push(g.moveToPTN(w));
        break;
      }
      if (N.d >= INF) break;
      if (N.win) mv = winMove(g, s.att);
      else if (!N.edges.length) mv = g.legalMoves()[0];
      else {
        let best = null;
        for (const e of N.edges) { const v = ev(e); if (!best || (N.isOr ? v < best.v : v > best.v)) best = { v, mv: e.mv }; }
        mv = best.mv;
      }
      if (!mv) break;
      pv.push(g.moveToPTN(mv));
      undos.push(g.apply(mv));
      if (g.result()) break;
    }
  } finally { while (undos.length) g.undo(undos.pop()); }
  return { plies: root.d >= INF ? 0 : root.d, pv };
}

// Unlimited-depth proof. plies = depth of the proof tree found — an upper bound on the
// threat-restricted mate distance (shortestTinue tightens it).
export function proveTinue(g, { maxNodes = 2e5, ...opts } = {}) {
  g = g.clone();
  const s = new TinueSearch(g, { maxNodes, ...opts });
  let ok;
  try { ok = s.solve(Infinity); }
  catch (e) { if (e instanceof Budget) return { result: 'unknown', plies: 0, pv: [], nodes: s.nodes }; throw e; }
  if (!ok) return { result: 'disproved', plies: 0, pv: [], nodes: s.nodes };
  const { plies, pv } = proofTreeLine(s);
  return { result: 'proved', plies, pv, nodes: s.nodes };
}

// Minimal plies of a forced road win under the threat restriction.
//   1. iterative deepening at 1, 3, 5 plies (cheap, catches short wins exactly);
//   2. otherwise an unlimited proof gives an upper bound U;
//   3. depth-limited searches at U-2, U-4, … tighten it until one fails (that failure certifies
//      minimality). Running out of budget in 3 returns the best bound with exact:false.
// Returns {result: 'proved'|'disproved'|'unknown', plies, exact, lowerBound, pv, nodes}.
// 'disproved' = no Tak-threat tinue at any depth (a quiet-move or flat win may still exist).
export function shortestTinue(g, maxPlies = 25, { maxNodes = 2e5, pv: wantPv = true, idPlies = 5, ...opts } = {}) {
  g = g.clone();
  const s = new TinueSearch(g, { maxNodes, ...opts });
  let best = 0, lo = -1, ubPv = null, exhausted = false;
  const run = (f) => { try { f(); } catch (e) { if (e instanceof Budget) exhausted = true; else throw e; } };
  run(() => {
    for (let p = 1; p <= Math.min(idPlies, maxPlies); p += 2) { if (s.solve(p)) { best = p; return; } lo = p; }
  });
  if (!best && !exhausted && maxPlies > idPlies) {
    run(() => {
      if (!s.solve(Infinity)) { lo = Infinity; return; }
      const t = proofTreeLine(s);
      if (!t.plies) { exhausted = true; return; } // proven but no finite proof line (shouldn't happen)
      best = t.plies; ubPv = t;
    });
    if (lo === Infinity) return { result: 'disproved', plies: 0, exact: true, lowerBound: Infinity, pv: [], nodes: s.nodes };
    if (best && !exhausted) run(() => {
      for (let d = best - 2; d > lo; d -= 2) { if (s.solve(d)) { best = d; ubPv = null; } else { lo = d; break; } }
    });
  }
  const nodes = s.nodes;
  if (!best) return { result: exhausted ? 'unknown' : 'disproved', plies: 0, exact: !exhausted, lowerBound: lo + 2, pv: [], nodes };
  let pv = ubPv ? ubPv.pv : [];
  if (wantPv && !ubPv) { try { pv = principalVariation(s, best); } catch (e) { if (!(e instanceof Budget)) throw e; } }
  return { result: 'proved', plies: best, exact: lo === best - 2, lowerBound: lo + 2, pv, nodes };
}

// PV of a depth-limited proof: attacker plays a move proven at the remaining depth; the defender
// plays the reply that resists longest (its minimal depth recomputed per reply).
export function principalVariation(s, p) {
  const g = s.g, pv = [], undos = [];
  s.maxNodes = s.nodes + 1e5; // headroom for per-reply depth queries
  try {
    while (p >= 1) {
      const k = keyNum(g), isOr = g.toMove === s.att, I = s._infoAt(k);
      if (isOr) {
        if (I.win) { pv.push(g.moveToPTN(winMove(g, s.att))); break; }
        let pick = null;
        for (const kd of s._kids(I)) {
          if (kd.term) continue;
          const u = g.apply(kd.mv);
          const ok = s.solve(p - 1);
          g.undo(u);
          if (ok) { pick = kd.mv; break; }
        }
        if (!pick) break;
        pv.push(g.moveToPTN(pick)); undos.push(g.apply(pick)); p -= 1;
      } else {
        let pick = null, pickD = -1;
        const kids = s._kids(I);
        if (!kids.length) { pick = g.legalMoves()[0]; pickD = 1; } // no reply touches the win: any move loses
        for (const kd of kids) {
          let d = 0;
          if (!kd.term) {
            const u = g.apply(kd.mv);
            for (d = 1; d <= p - 1; d += 2) if (s.solve(d)) break;
            g.undo(u);
          }
          if (d > pickD) { pickD = d; pick = kd.mv; }
          if (d >= p - 1) break;
        }
        if (!pick) break;
        pv.push(g.moveToPTN(pick)); undos.push(g.apply(pick));
        if (g.result()) break;
        p = Math.min(p - 1, pickD);
      }
    }
  } finally { while (undos.length) g.undo(undos.pop()); }
  return pv;
}

// All attacker first moves (PTN) that keep a forced win within `plies` (threat-restricted; each
// verified by a defender-to-move search at plies-1, with its own node budget). Immediate wins are
// always included. With {detail:true} returns {moves:[{move, plies}], unknown, nodes}, where plies
// is the move's own minimal win length (tightened downward; an upper bound if budget ran out).
export function allTinueMoves(g, plies, { maxNodes = 2e5, detail = false, ...opts } = {}) {
  g = g.clone();
  const a = g.toMove;
  const s = new TinueSearch(g, { maxNodes, ...opts });
  const out = [], seen = new Set();
  for (const mv of g.legalMoves()) {
    const u = g.apply(mv); const r = g.result(); g.undo(u);
    if (r && r.winner === a) { const ptn = g.moveToPTN(mv); seen.add(ptn); out.push({ move: ptn, plies: 1 }); }
  }
  let unknown = 0;
  if (plies >= 3) {
    for (const mv of threatMoves(g)) {
      const ptn = g.moveToPTN(mv);
      if (seen.has(ptn)) continue;
      const u = g.apply(mv);
      s.maxNodes = s.nodes + maxNodes; // per-candidate budget
      try {
        if (!g.result() && s.solve(plies - 1)) {
          let best = plies - 1;
          if (detail) {
            try { for (let d = best - 2; d >= 2; d -= 2) { if (s.solve(d)) best = d; else break; } }
            catch (e) { if (!(e instanceof Budget)) throw e; }
          }
          out.push({ move: ptn, plies: best + 1 });
        }
      } catch (e) { if (e instanceof Budget) unknown++; else throw e; }
      finally { g.undo(u); }
    }
  }
  out.sort((x, y) => x.plies - y.plies);
  if (detail) return { moves: out, unknown, nodes: s.nodes };
  return out.map((x) => x.move);
}
