// Parse a PTN game (headers + moves) and replay it.
import { Game } from './tak.js?v=1794165982';

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
