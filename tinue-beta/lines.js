// Showing a line on the board after the puzzle (app.js showLine), on either board. Pure enough for node to test
// (scripts/test-lines.mjs) with a fake board whose load really waits, as PTN Ninja's does.
let seq = 0;
// Load `line` onto the board (unless st.loadedKey says it is already there) and show the position after `idx` plies.
// PTN Ninja's load swaps its line at once but resolves 60 ms or more later, so a second switch made meanwhile must not
// trust the key of the line being replaced (it would skip its own load and step through the other line), and the
// older switch, once its load resolves, must not claim the board or move it: the newest switch wins.
export async function showLineOn(board, st, line, idx, ptnOf) {
  const key = line.join(' '), t = ++seq;
  if (st.loadedKey !== key) {
    st.loadedKey = null; // (being replaced)
    await board.load(ptnOf(line));
    if (t !== seq) return false;
    st.loadedKey = key;
  }
  if (idx >= line.length) await board.last(); else if (idx === 0) await board.first(); else await board.goTo(idx - 1);
  return true;
}

// Squares a move touches, as names: where it starts, then each square a stack drops onto.
export function moveSquares(ptn) {
  const m = /^(\d?)([a-h])([1-8])([<>+-])?(\d*)/.exec(ptn.replace(/^[FSC]/, ''));
  if (!m) return [];
  const sqs = [m[2] + m[3]];
  if (!m[4]) return sqs;
  const [df, dr] = { '+': [0, 1], '-': [0, -1], '>': [1, 0], '<': [-1, 0] }[m[4]];
  let f = m[2].charCodeAt(0), r = +m[3];
  for (let i = 0; i < (m[5] ? m[5].length : 1); i++) { f += df; r += dr; sqs.push(String.fromCharCode(f) + r); }
  return sqs;
}
