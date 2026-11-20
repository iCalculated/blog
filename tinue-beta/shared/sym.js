// The 8 symmetries of the square board (Rush shows each puzzle under one at random, so a remembered picture doesn't give
// the answer away; Sasha, 2026-11-18). A true relabelling: the board still reads a1 at the bottom left, and squares,
// moves, TPS and whole puzzles are mapped to the square they land on. Colours are never swapped, so the side to move,
// the move number and komi stay as they are, and every rule of Tak (roads, flats, spreads) is unchanged by it.
//
// s in 0..7: mirror = s >> 2 (files reversed: a <-> f on 6×6), then s & 3 quarter turns clockwise. 0 is the identity.
// Pure, no deps: node tests in scripts/test-rush.mjs.
export const SYMS = [0, 1, 2, 3, 4, 5, 6, 7];
const FILES = 'abcdefgh';
// [dCol, dRow] of each PTN direction, and back
const DIR = { '+': [0, 1], '-': [0, -1], '>': [1, 0], '<': [-1, 0] };
const DIR_OF = (dc, dr) => (dr === 1 ? '+' : dr === -1 ? '-' : dc === 1 ? '>' : '<');

// A square (col, row from a1 = 0, 0) under s on an n×n board.
export function mapSq(s, n, c, r) {
  if (s >> 2) c = n - 1 - c;
  for (let k = 0; k < (s & 3); k++) [c, r] = [r, n - 1 - c]; // clockwise: a1 -> a6, a6 -> f6
  return [c, r];
}
// A direction's vector: the same linear part, without the shift.
function mapDir(s, d) {
  let [dc, dr] = DIR[d];
  if (s >> 2) dc = -dc;
  for (let k = 0; k < (s & 3); k++) [dc, dr] = [dr, -dc];
  return DIR_OF(dc, dr);
}
// The symmetry that undoes s (mirrors are their own inverse; a turn's is the opposite turn).
export const inverse = (s) => (s >> 2 ? s : (4 - (s & 3)) & 3);

// A square name ('c3') under s.
export function square(s, n, name) {
  const [c, r] = mapSq(s, n, FILES.indexOf(name[0]), +name.slice(1) - 1);
  return FILES[c] + (r + 1);
}
// A PTN move under s: a placement keeps its piece, a stack move its count and drops (they run along its direction,
// which turns with the board); any suffix (*, ', !, ?) is kept. Anything else is returned as it is.
export function move(s, n, ptn) {
  if (!s || typeof ptn !== 'string') return ptn;
  let m = /^([1-8]?)([a-h][1-8])([<>+-])([1-8]*)(.*)$/.exec(ptn);
  if (m) return m[1] + square(s, n, m[2]) + mapDir(s, m[3]) + m[4] + m[5];
  m = /^([FSC]?)([a-h][1-8])(.*)$/.exec(ptn);
  return m ? m[1] + square(s, n, m[2]) + m[3] : ptn;
}
// A TPS under s, written as Game.toTPS writes one (runs of empty squares as x / xN); the side to move and the move
// number are kept.
export function tps(s, t) {
  if (!s || typeof t !== 'string') return t;
  const [board, ...rest] = t.trim().split(/\s+/);
  const rows = board.split('/'), n = rows.length, grid = Array.from({ length: n }, () => Array(n).fill(''));
  rows.forEach((row, ri) => {
    let c = 0;
    for (const cell of row.split(',')) {
      if (/^x\d*$/.test(cell)) { c += cell.length > 1 ? +cell.slice(1) : 1; continue; }
      const [nc, nr] = mapSq(s, n, c, n - 1 - ri);
      grid[nr][nc] = cell; c++;
    }
  });
  const out = [];
  for (let r = n - 1; r >= 0; r--) {
    const cells = [];
    let empty = 0;
    for (let c = 0; c < n; c++) {
      if (!grid[r][c]) { empty++; continue; }
      if (empty) { cells.push(empty > 1 ? 'x' + empty : 'x'); empty = 0; }
      cells.push(grid[r][c]);
    }
    if (empty) cells.push(empty > 1 ? 'x' + empty : 'x');
    out.push(cells.join(','));
  }
  return [out.join('/'), ...rest].join(' ');
}
// A solution tree ({ move: { r: reply, n: subtree | 'win' } }) under s, its key order kept.
export function tree(s, n, t) {
  if (!s || !t || typeof t !== 'object') return t;
  const out = {};
  for (const [k, e] of Object.entries(t)) out[move(s, n, k)] = e && typeof e === 'object' ? { ...e, ...(e.r != null ? { r: move(s, n, e.r) } : {}), ...('n' in e ? { n: tree(s, n, e.n) } : {}) } : e;
  return out;
}
const line = (s, n, key) => key.split(' ').map((m) => move(s, n, m)).join(' ');
// A whole puzzle as Rush gets it (GET /api/rush/run: tps, tree, alts, altsAt, before, last) under s, with sym: s.
// Everything else is kept as it is. orient(orient(p, s), inverse(s)) gives p back (sym aside: unorient drops it).
export function orient(p, s) {
  const n = p.size;
  const q = { ...p, sym: s };
  if (!s) return q;
  q.tps = tps(s, p.tps);
  q.tree = tree(s, n, p.tree);
  if (Array.isArray(p.alts)) q.alts = p.alts.map((m) => move(s, n, m));
  if (p.altsAt && typeof p.altsAt === 'object') q.altsAt = Object.fromEntries(Object.entries(p.altsAt).map(([k, v]) => [line(s, n, k), Array.isArray(v) ? v.map((m) => move(s, n, m)) : v]));
  if (p.before != null) q.before = tps(s, p.before);
  if (p.last != null) q.last = move(s, n, p.last);
  return q;
}
// The puzzle as it was handed out (sym removed).
export function unorient(q) {
  const { sym, ...p } = orient(q, inverse(q.sym || 0));
  return p;
}
// A random symmetry: rnd () => [0, 1).
export const pick = (rnd = Math.random) => Math.min(7, Math.floor(rnd() * 8));
