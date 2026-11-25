// The Rush end screen's pictures of a puzzle: a still copy of tinue's board (board.js, board.css) drawn as one string of
// HTML, so a run of 60 puzzles costs no Board, no key handler and no timer per picture. It draws what the board draws
// for a position: the felt and its seams, the coordinates where the board puts them, every stone of every stack placed
// by the board's own maths (analysis.js stackPiece: the top n stones up the square, the rest as slivers up its side),
// the tint on the move that led there, and the two moves that matter as the analysis overlay draws a line (analysis.js
// shapesSvg: a ring and a faint stone for a placement, an arrow with the stones carried for a spread): the move played
// when it was wrong in red, the puzzle's move in green.
// Pure (no DOM), so node tests it against the real Board's position: scripts/test-rush-look.mjs.
import { dispPoint, shapesSvg, stackPiece } from './analysis.js?v=1795581690';
import { bandOf, darkSq } from './rush-theme.js?v=1795581690';

const FILES = 'abcdefgh';
const ID = [1, 0, 0, 1];
// The board's orientation (board.js: M takes centred logical (file, rank) to display (x, y), y up), undone: the logical
// square drawn at display column dc, row dr (board.js _logical).
function logical(dc, dr, n, M) {
  const h = n - 1, [a, b, c, d] = M, X = 2 * dc - h, Y = 2 * dr - h;
  return ((b * X + d * Y + h) / 2) * n + (a * X + c * Y + h) / 2;
}
const rowOf = (sq, n) => (sq / n) | 0;
const sign = (x) => (x > 0) - (x < 0);
// A spread's direction on the board, as [dRow, dCol].
const dirOf = (s, n) => [sign(rowOf(s.to, n) - rowOf(s.from, n)), sign((s.to % n) - (s.from % n))];

// The picture as data: v is rush-rules.js review()'s answer (its cells, tint and marks, in the labels the run showed),
// M the board's orientation (Board#M: the player's own turn or mirror of the board, kept in this browser).
// Returns { n, squares (in the order the board lays them out, top row first: { sq: logical index, name, tint:
// '' | 'c' | 'cp' (the board's .c / .c.cp), lr, lc: the rank or file label drawn there, or null) }, pieces ([{ sq,
// name, color, type, x, y (the board's translate, % of a square), z, imm }], every stone drawn, bottom first), marks
// (review's, with r, shift or lead set where two moves share a square or a stack), svg (the marks drawn) }.
export function picture(v, M = ID) {
  const n = v.size, cell = (sq) => v.cells[(n - 1 - rowOf(sq, n)) * n + (sq % n)];
  const tint = v.tint || { sqs: [], prim: [] };
  const squares = [];
  for (let dr = n - 1; dr >= 0; dr--) for (let dc = 0; dc < n; dc++) {
    const sq = logical(dc, dr, n, M), r = rowOf(sq, n), c = sq % n;
    squares.push({ sq, name: FILES[c] + (r + 1), tint: tint.sqs.includes(sq) ? (tint.prim.includes(sq) ? 'cp' : 'c') : '',
      lr: dc === 0 ? (M[2] ? FILES[c] : String(r + 1)) : null, lc: dr === 0 ? (M[0] ? FILES[c] : String(r + 1)) : null });
  }
  const pieces = [];
  for (let sq = 0; sq < n * n; sq++) {
    const st = cell(sq).stack || [], [dc, dr] = dispPoint(sq, n, M);
    st.forEach((p, z) => {
      const { y, imm, ov, z: zi } = stackPiece(st.length, z, n, p.type === 1);
      if (!ov) pieces.push({ sq, name: cell(sq).sq, color: p.color, type: p.type, x: dc * 100, y: -(dr * 100 + y), z: zi, imm });
    });
  }
  // Two moves on one square, or along one line from one stack: the wrong one's ring outside the right one's, the arrows
  // side by side; otherwise each is drawn as the overlay draws a line.
  // (each with its casing, cs, drawn but hidden: a board theme other than felt shows it where its marks need an edge)
  const marks = (v.marks || []).map((m) => ({ ...m, cs: true }));
  const [b, g] = [marks.find((m) => m.role === 'bad'), marks.find((m) => m.role === 'good')];
  if (b && g && b.shape.kind === 'place' && g.shape.kind === 'place' && b.shape.sq === g.shape.sq) g.r = 0.3;
  if (b && g && b.shape.kind === 'spread' && g.shape.kind === 'spread' && b.shape.from === g.shape.from) {
    if (String(dirOf(b.shape, n)) === String(dirOf(g.shape, n))) { b.shift = -0.14; g.shift = 0.14; }
    else { b.lead = 0.3; g.lead = 0.3; } // (other ways: each count of stones carried a step out along its own arrow, off the other)
  }
  return { n, squares, pieces, marks, svg: shapesSvg(marks, n, M) };
}

// The picture as HTML, in board.css's own classes (a .tb marked still: no motion, no will-change per stone). Hidden
// from screen readers: the words beside it say the same.
// Each square also says its colour on a checkered board (d: a1's, the dark ones) and its band from the board's edge
// (k0 outermost), which a board theme other than tinue felt colours it by (rush-theme.js, style.css .rt).
export function pictureHTML(pic) {
  const n = pic.n;
  const sq = pic.squares.map((s) => `<div class="tb-sq k${bandOf(s.sq, n)}${darkSq(s.sq, n) ? ' d' : ''}${s.tint ? ' c' + (s.tint === 'cp' ? ' cp' : '') : ''}">${s.tint ? '<div class="tb-hl tb-cur"></div>' : ''}`
    + (s.lr != null ? `<span class="tb-lab tb-lr">${s.lr}</span>` : '') + (s.lc != null ? `<span class="tb-lab tb-lc">${s.lc}</span>` : '') + '</div>').join('');
  const pcs = pic.pieces.map((p) => `<div class="tb-pc" style="transform:translate(${p.x}%,${p.y}%);z-index:${p.z}"><div class="tb-st p${p.color}${p.type === 1 ? ' S' : p.type === 2 ? ' C' : ''}${p.imm ? ' im' : ''}"></div></div>`).join('');
  return `<div class="tb-host rush-pic" aria-hidden="true"><div class="tb still" style="--n:${n}"><div class="tb-board">${sq}<div class="tb-pcs">${pcs}</div>`
    + `<svg class="tb-ov" viewBox="0 0 ${n} ${n}">${pic.svg}</svg></div></div></div>`;
}
