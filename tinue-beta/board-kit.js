// What the page needs from a board that isn't the board itself: the move sounds' hooks, what a move sets down (landOf),
// a game as PTN (buildPTN), the side the flat-count bar marks (turnMark) and which elements a pointer focused. The board
// is PTN Ninja's (ninja.js); tinue's own (board.js) is retired and is never loaded by the page.
import { FLAT, WALL, CAP, typeOf } from './shared/tak.js?v=1795581795';

// The sound hooks, set by app.js to sound.js (kept out of the board, which node tests import):
// onPly(ptn, smash, info, board) on every move played or appended at the line's end; info is landOf's { piece } or
//   { top, onto }.
// onLand(list, board) as pieces of a stack moved by hand land (PTN Ninja reports only whole moves: unused today).
// onCut(board) when the board jumps to another position (a load, a step back, a jump): queued drops stop.
export const hooks = { onPly: null, onLand: null, onCut: null };

// The side to move as the flat-count bar marks it: 1 or 2, or 0 once the game is over (nobody moves).
export const turnMark = (g) => (g.result() ? 0 : g.toMove);

// What a move sets down, for its sound (sound.js playMove's info), read off the position before it: a placement's piece;
// a stack move's top piece (the last to land) and, per square dropped on, what it lands on ('board': the square was
// empty, 'piece').
const STEP = { '+': [1, 0], '-': [-1, 0], '>': [0, 1], '<': [0, -1] }; // [dRow, dCol]
const KIND = { [FLAT]: 'flat', [WALL]: 'wall', [CAP]: 'cap' };
export function landOf(g, mv) {
  if (mv.kind === 'p') return { piece: KIND[mv.type] || 'flat' };
  const size = g.size, from = g.board[mv.sq], [dr, dc] = STEP[mv.dir], onto = [];
  let r = Math.floor(mv.sq / size), c = mv.sq % size;
  for (let i = 0; i < mv.drops.length; i++) { r += dr; c += dc; onto.push(g.board[r * size + c].length ? 'piece' : 'board'); }
  return { top: KIND[typeOf(from[from.length - 1])] || 'flat', onto };
}

// Elements that got focus from a pointer press (a click leaves buttons focused in Chrome and Firefox).
const pointerFocused = new WeakSet();
let lastPointer = -1e9;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => { lastPointer = performance.now(); }, true);
  document.addEventListener('focusin', (e) => { if (performance.now() - lastPointer < 500) pointerFocused.add(e.target); else pointerFocused.delete(e.target); }, true);
}
export const focusedByPointer = (el) => pointerFocused.has(el);

// Build a PTN game. `moves` are played from `tps` (or the empty board when tps is null).
export function buildPTN({ size, komi = 0, tps = null, moves = [], white = 'White', black = 'Black' }) {
  const head = [`[Size "${size}"]`, `[Komi "${komi}"]`, `[Player1 "${white}"]`, `[Player2 "${black}"]`, `[Opening "swap"]`];
  let moveNo = 1, color = 1;
  if (tps) {
    head.push(`[TPS "${tps}"]`);
    const [, turn, num] = tps.split(' ');
    color = +turn; moveNo = +num;
  }
  let out = '';
  for (const m of moves) {
    if (color === 1) out += `${moveNo}. ${m} `;
    else out += (out ? '' : `${moveNo}. -- `) + `${m}\n`;
    if (color === 2) moveNo++;
    color = 3 - color;
  }
  return head.join('\n') + '\n\n' + out.trim();
}
