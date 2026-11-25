// Parse a PTN game (headers + moves) and replay it.
import { Game } from './tak.js?v=1795581795';

export function parsePTN(text) {
  const headers = {};
  text = text.replace(/\[(\w+)\s+"([^"]*)"\]/g, (_, k, v) => { headers[k] = v; return ' '; });
  text = text.replace(/\{[^}]*\}/g, ' ');
  const moves = text.split(/\s+/).filter((t) => t && !/^\d+\.$/.test(t) && !/^(R-0|0-R|F-0|0-F|1-0|0-1|1\/2-1\/2|--)$/.test(t)).map((t) => t.replace(/^\d+\./, ''));
  return { headers, moves: moves.filter(Boolean) };
}

export function replay(text, uptoPly = Infinity) {
  const { headers, moves } = parsePTN(text);
  const size = +headers.Size || 5;
  const g = headers.TPS ? Game.fromTPS(headers.TPS) : new Game(size);
  g.komi = +(headers.Komi || 0);
  const played = [];
  for (const m of moves.slice(0, uptoPly)) { g.play(m); played.push(m); }
  return { g, headers, moves, played };
}

// PlayTak server notation ("P A1 W", "M C5 C4 3") → PTN.
export function ptnFromServer(move) {
  const [type, ...rest] = move.trim().split(' ');
  if (type === 'P') {
    const [pos, st] = rest; const sq = pos.toLowerCase();
    return st === 'C' ? 'C' + sq : st === 'W' ? 'S' + sq : sq;
  }
  const [a, b, ...drops] = rest;
  const carry = drops.reduce((s, d) => s + +d, 0);
  const dir = a[0] === b[0] ? (a[1] < b[1] ? '+' : '-') : (a[0] < b[0] ? '>' : '<');
  return `${carry > 1 ? carry : ''}${a.toLowerCase()}${dir}${drops.length > 1 ? drops.join('') : ''}`;
}

// Canonical PTN for engine output (Tiltak in the browser, Syntaks on the server), so their moves compare equal to
// Game.moveToPTN(): no "F", no count of 1, no lone drop equal to the count, no trailing marks.
export function canonPTN(m) {
  if (!m) return m;
  const s = m.replace(/['"!?*]+$/, '').replace(/^F/, '');
  const mv = /^(\d?)([a-h][1-8])([<>+-])(\d*)$/.exec(s);
  if (!mv) return s;
  let [, c, sq, dir, drops] = mv;
  const count = c ? +c : 1;
  if (drops.length === 1 && +drops === count) drops = '';
  return (count > 1 ? count : '') + sq + dir + drops;
}

// How many of the last plies of meta.history were never played in the source game. A dragon sub-position is reached
// by a line of analysis (meta.dragon.path) that leaves the real game; its history is the game so far plus that line,
// so the game's players and moves are credited only up to history.length minus this. 0 for every ordinary puzzle.
export function unplayedPlies(meta) {
  const path = meta?.dragon?.path, n = Array.isArray(meta?.history) ? meta.history.length : 0;
  return Array.isArray(path) && path.length ? Math.min(path.length, n) : 0;
}
