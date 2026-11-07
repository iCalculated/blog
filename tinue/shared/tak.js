// Tak rules engine: TPS/PTN parsing, move generation, road/flat wins, forced-win search.
// Runs unchanged in the browser and in Node (ES module, no deps).

// Pieces are small ints: type*2 + (color-1).  type: 0 flat, 1 wall, 2 cap.
export const FLAT = 0, WALL = 1, CAP = 2;
export const pieceOf = (color, type) => type * 2 + (color - 1);
export const colorOf = (p) => (p & 1) + 1;
export const typeOf = (p) => p >> 1;

export const RESERVES = { 3: [10, 0], 4: [15, 0], 5: [21, 1], 6: [30, 1], 7: [40, 2], 8: [50, 2] };
export const DIRS = { '+': [1, 0], '-': [-1, 0], '>': [0, 1], '<': [0, -1] }; // [dRow, dCol]
const DIR_LIST = ['+', '-', '>', '<'];
const FILES = 'abcdefgh';

// ---------- Zobrist hashing (two 32-bit halves) ----------
const MAXH = 110;
const ZA = new Uint32Array(64 * MAXH * 6), ZB = new Uint32Array(64 * MAXH * 6);
{
  let s = 0x9e3779b9 >>> 0;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  for (let i = 0; i < ZA.length; i++) { ZA[i] = rnd(); ZB[i] = rnd(); }
}
const zi = (sq, h, p) => (sq * MAXH + Math.min(h, MAXH - 1)) * 6 + p;

export class Game {
  constructor(size) {
    this.size = size;
    this.n = size * size;
    this.board = Array.from({ length: this.n }, () => []);
    const [st, cp] = RESERVES[size];
    this.stones = [0, st, st];
    this.caps = [0, cp, cp];
    this.toMove = 1;
    this.ply = 0; // half-moves since game start (for opening swap rule)
    this.ha = 0; this.hb = 0;
    this.komi = 0;
    this._seen = new Uint8Array(this.n); this._stack = new Int32Array(this.n);
  }

  clone() {
    const g = new Game(this.size);
    g.board = this.board.map((s) => s.slice());
    g.stones = this.stones.slice(); g.caps = this.caps.slice();
    g.toMove = this.toMove; g.ply = this.ply; g.ha = this.ha; g.hb = this.hb; g.komi = this.komi;
    return g;
  }

  // ---- hashing helpers ----
  _x(sq, h, p) { const k = zi(sq, h, p); this.ha ^= ZA[k]; this.hb ^= ZB[k]; }
  key() { return (this.toMove === 1 ? 'a' : 'b') + this.ha.toString(36) + '.' + this.hb.toString(36); }

  top(sq) { const s = this.board[sq]; return s.length ? s[s.length - 1] : -1; }
  sqName(sq) { return FILES[sq % this.size] + (Math.floor(sq / this.size) + 1); }
  sqIndex(name) { return (parseInt(name.slice(1), 10) - 1) * this.size + FILES.indexOf(name[0]); }

  // ---------- TPS ----------
  static fromTPS(tps, komi = 0) {
    tps = tps.trim().replace(/^\[TPS\s+"?/i, '').replace(/"?\]$/, '').trim();
    const [boardStr, turnStr, moveStr] = tps.split(/\s+/);
    const rows = boardStr.split('/');
    const size = rows.length;
    if (!RESERVES[size]) throw new Error('bad TPS size ' + size);
    const g = new Game(size);
    g.komi = komi;
    rows.forEach((row, ri) => {
      const r = size - 1 - ri;
      let c = 0;
      for (const cell of row.split(',')) {
        if (/^x\d*$/.test(cell)) { c += cell.length > 1 ? parseInt(cell.slice(1), 10) : 1; continue; }
        const m = /^([12]+)([SC])?$/.exec(cell);
        if (!m) throw new Error('bad TPS cell ' + cell);
        const sq = r * size + c;
        const digits = m[1];
        for (let i = 0; i < digits.length; i++) {
          const color = +digits[i];
          let type = FLAT;
          if (i === digits.length - 1 && m[2]) type = m[2] === 'S' ? WALL : CAP;
          const p = pieceOf(color, type);
          g._x(sq, g.board[sq].length, p);
          g.board[sq].push(p);
          if (type === CAP) g.caps[color]--; else g.stones[color]--;
        }
        c++;
      }
      if (c !== size) throw new Error(`TPS row ${ri} has ${c} squares, expected ${size}`);
    });
    g.toMove = +(turnStr || 1);
    const moveNo = +(moveStr || 1);
    g.ply = (moveNo - 1) * 2 + (g.toMove - 1);
    if (g.toMove === 2) { g.ha ^= 0x5bd1e995; g.hb ^= 0x1b873593; }
    if (Math.min(g.stones[1], g.stones[2], g.caps[1], g.caps[2]) < 0) throw new Error('TPS uses more pieces than reserves');
    return g;
  }

  toTPS() {
    const rows = [];
    for (let r = this.size - 1; r >= 0; r--) {
      const cells = [];
      let empty = 0;
      for (let c = 0; c < this.size; c++) {
        const s = this.board[r * this.size + c];
        if (!s.length) { empty++; continue; }
        if (empty) { cells.push(empty > 1 ? 'x' + empty : 'x'); empty = 0; }
        let str = s.map(colorOf).join('');
        const t = typeOf(s[s.length - 1]);
        if (t === WALL) str += 'S'; else if (t === CAP) str += 'C';
        cells.push(str);
      }
      if (empty) cells.push(empty > 1 ? 'x' + empty : 'x');
      rows.push(cells.join(','));
    }
    return `${rows.join('/')} ${this.toMove} ${Math.floor(this.ply / 2) + 1}`;
  }

  // ---------- moves ----------
  // move: {kind:'p', sq, type} | {kind:'m', sq, dir, drops:[...]}
  parseMove(ptn) {
    const s = ptn.trim().replace(/['"!?]+$/, '');
    let m = /^([FSC])?([a-h])([1-8])$/.exec(s);
    if (m) return { kind: 'p', sq: this.sqIndex(m[2] + m[3]), type: m[1] === 'S' ? WALL : m[1] === 'C' ? CAP : FLAT };
    m = /^([1-8])?([a-h])([1-8])([<>+-])([1-8]*)\*?$/.exec(s);
    if (m) {
      const count = m[1] ? +m[1] : 1;
      const drops = m[5] ? m[5].split('').map(Number) : [count];
      if (drops.reduce((a, b) => a + b, 0) !== count) throw new Error('drop counts do not sum: ' + ptn);
      return { kind: 'm', sq: this.sqIndex(m[2] + m[3]), dir: m[4], drops };
    }
    throw new Error('unparseable move: ' + ptn);
  }

  // Canonical PTN (no '*'); use for equality.
  moveToPTN(mv, withSmash = false) {
    if (mv.kind === 'p') return (mv.type === WALL ? 'S' : mv.type === CAP ? 'C' : '') + this.sqName(mv.sq);
    const count = mv.drops.reduce((a, b) => a + b, 0);
    let s = (count > 1 ? count : '') + this.sqName(mv.sq) + mv.dir;
    if (mv.drops.length > 1) s += mv.drops.join('');
    if (withSmash && mv.smash) s += '*';
    return s;
  }

  canon(ptn) { return this.moveToPTN(this.parseMove(ptn)); }

  isLegal(mv) {
    const want = this.moveToPTN(mv);
    return this.legalMoves().some((m) => this.moveToPTN(m) === want);
  }

  legalMoves() {
    const out = [];
    const me = this.toMove, size = this.size;
    const opening = this.ply < 2;
    for (let sq = 0; sq < this.n; sq++) {
      const st = this.board[sq];
      if (!st.length) {
        if (opening) { out.push({ kind: 'p', sq, type: FLAT }); continue; }
        if (this.stones[me] > 0) { out.push({ kind: 'p', sq, type: FLAT }); out.push({ kind: 'p', sq, type: WALL }); }
        if (this.caps[me] > 0) out.push({ kind: 'p', sq, type: CAP });
        continue;
      }
      if (opening) continue;
      const topP = st[st.length - 1];
      if (colorOf(topP) !== me) continue;
      const isCap = typeOf(topP) === CAP;
      const carry = Math.min(size, st.length);
      const r0 = Math.floor(sq / size), c0 = sq % size;
      for (const dir of DIR_LIST) {
        const [dr, dc] = DIRS[dir];
        // free distance before hitting edge / wall / cap
        let dist = 0, smashOK = false;
        for (let r = r0 + dr, c = c0 + dc; r >= 0 && r < size && c >= 0 && c < size; r += dr, c += dc) {
          const t = this.top(r * size + c);
          if (t >= 0 && typeOf(t) !== FLAT) { if (isCap && typeOf(t) === WALL) smashOK = true; break; }
          dist++;
        }
        if (dist === 0 && !smashOK) continue;
        for (let count = 1; count <= carry; count++) {
          // compositions of count into k parts, k <= dist
          const rec = (left, parts) => {
            if (left === 0) { out.push({ kind: 'm', sq, dir, drops: parts.slice() }); return; }
            if (parts.length >= dist) return;
            for (let d = 1; d <= left; d++) { parts.push(d); rec(left - d, parts); parts.pop(); }
          };
          rec(count, []);
          // smash: compositions of count-1 into exactly `dist` parts, then a final 1 (the cap alone)
          if (smashOK) {
            const need = dist;
            const rec2 = (left, parts) => {
              if (parts.length === need) { if (left === 0) out.push({ kind: 'm', sq, dir, drops: [...parts, 1], smash: true }); return; }
              for (let d = 1; d <= left; d++) { parts.push(d); rec2(left - d, parts); parts.pop(); }
            };
            if (count - 1 >= need) rec2(count - 1, []);
          }
        }
      }
    }
    return out;
  }

  // Apply a move (assumed legal). Returns an undo record.
  apply(mv) {
    const me = this.toMove, size = this.size;
    const u = { mv, smashed: false, ply: this.ply };
    if (mv.kind === 'p') {
      const color = this.ply < 2 ? 3 - me : me;
      const p = pieceOf(color, mv.type);
      this._x(mv.sq, 0, p);
      this.board[mv.sq].push(p);
      if (mv.type === CAP) this.caps[color]--; else this.stones[color]--;
      u.color = color;
    } else {
      const src = this.board[mv.sq];
      const count = mv.drops.reduce((a, b) => a + b, 0);
      const base = src.length - count;
      for (let h = base; h < src.length; h++) this._x(mv.sq, h, src[h]);
      const hand = src.splice(base, count);
      const [dr, dc] = DIRS[mv.dir];
      let r = Math.floor(mv.sq / size), c = mv.sq % size, i = 0;
      for (const d of mv.drops) {
        r += dr; c += dc;
        const dst = this.board[r * size + c];
        if (dst.length) {
          const t = dst[dst.length - 1];
          if (typeOf(t) === WALL) {
            const flat = pieceOf(colorOf(t), FLAT);
            this._x(r * size + c, dst.length - 1, t); this._x(r * size + c, dst.length - 1, flat);
            dst[dst.length - 1] = flat; u.smashed = true; mv.smash = true;
          }
        }
        for (let k = 0; k < d; k++) { this._x(r * size + c, dst.length, hand[i]); dst.push(hand[i++]); }
      }
    }
    this.toMove = 3 - me; this.ply++;
    this.ha ^= 0x5bd1e995; this.hb ^= 0x1b873593;
    return u;
  }

  undo(u) {
    const mv = u.mv, size = this.size;
    this.toMove = 3 - this.toMove; this.ply = u.ply;
    this.ha ^= 0x5bd1e995; this.hb ^= 0x1b873593;
    if (mv.kind === 'p') {
      const p = this.board[mv.sq].pop();
      this._x(mv.sq, 0, p);
      if (mv.type === CAP) this.caps[u.color]++; else this.stones[u.color]++;
      return;
    }
    const [dr, dc] = DIRS[mv.dir];
    const sqs = [];
    let r = Math.floor(mv.sq / size), c = mv.sq % size;
    for (let j = 0; j < mv.drops.length; j++) { r += dr; c += dc; sqs.push(r * size + c); }
    const hand = [];
    for (let j = mv.drops.length - 1; j >= 0; j--) {
      const dst = this.board[sqs[j]];
      const part = dst.splice(dst.length - mv.drops[j], mv.drops[j]);
      for (let k = 0; k < part.length; k++) this._x(sqs[j], dst.length + k, part[k]);
      hand.unshift(...part);
      if (j === mv.drops.length - 1 && u.smashed) {
        const t = dst[dst.length - 1];
        const wall = pieceOf(colorOf(t), WALL);
        this._x(sqs[j], dst.length - 1, t); this._x(sqs[j], dst.length - 1, wall);
        dst[dst.length - 1] = wall;
      }
    }
    const src = this.board[mv.sq];
    for (const p of hand) { this._x(mv.sq, src.length, p); src.push(p); }
  }

  play(ptn) {
    const mv = typeof ptn === 'string' ? this.parseMove(ptn) : ptn;
    if (!this.isLegal(mv)) throw new Error('illegal move ' + (typeof ptn === 'string' ? ptn : this.moveToPTN(mv)) + ' in ' + this.toTPS());
    return this.apply(mv);
  }

  // ---------- wins ----------
  hasRoad(color) {
    const size = this.size, n = this.n, seen = this._seen, stack = this._stack;
    seen.fill(0);
    const road = (sq) => { const t = this.top(sq); return t >= 0 && colorOf(t) === color && typeOf(t) !== WALL; };
    // two passes: start from west edge (want east), from south edge (want north)
    for (let pass = 0; pass < 2; pass++) {
      seen.fill(0);
      let sp = 0;
      for (let i = 0; i < size; i++) {
        const sq = pass === 0 ? i * size : i; // west column / south row
        if (road(sq)) { seen[sq] = 1; stack[sp++] = sq; }
      }
      while (sp) {
        const sq = stack[--sp];
        const r = (sq / size) | 0, c = sq % size;
        if (pass === 0 ? c === size - 1 : r === size - 1) return true;
        if (r > 0 && !seen[sq - size] && road(sq - size)) { seen[sq - size] = 1; stack[sp++] = sq - size; }
        if (r < size - 1 && !seen[sq + size] && road(sq + size)) { seen[sq + size] = 1; stack[sp++] = sq + size; }
        if (c > 0 && !seen[sq - 1] && road(sq - 1)) { seen[sq - 1] = 1; stack[sp++] = sq - 1; }
        if (c < size - 1 && !seen[sq + 1] && road(sq + 1)) { seen[sq + 1] = 1; stack[sp++] = sq + 1; }
      }
    }
    return false;
  }

  // The squares of a winning road for `color` (for highlighting), or null.
  roadSquares(color) {
    if (!this.hasRoad(color)) return null;
    const size = this.size;
    const road = (sq) => { const t = this.top(sq); return t >= 0 && colorOf(t) === color && typeOf(t) !== WALL; };
    const comps = new Int32Array(this.n).fill(-1);
    let id = 0;
    for (let s = 0; s < this.n; s++) {
      if (!road(s) || comps[s] >= 0) continue;
      const q = [s]; comps[s] = id;
      while (q.length) {
        const x = q.pop(), r = (x / size) | 0, c = x % size;
        for (const y of [r > 0 ? x - size : -1, r < size - 1 ? x + size : -1, c > 0 ? x - 1 : -1, c < size - 1 ? x + 1 : -1])
          if (y >= 0 && comps[y] < 0 && road(y)) { comps[y] = id; q.push(y); }
      }
      id++;
    }
    for (let k = 0; k < id; k++) {
      const sqs = []; for (let s = 0; s < this.n; s++) if (comps[s] === k) sqs.push(s);
      const rs = sqs.map((s) => (s / size) | 0), cs = sqs.map((s) => s % size);
      if ((rs.includes(0) && rs.includes(size - 1)) || (cs.includes(0) && cs.includes(size - 1))) return sqs;
    }
    return null;
  }

  flatCounts() {
    const f = [0, 0, 0];
    for (const s of this.board) if (s.length && typeOf(s[s.length - 1]) === FLAT) f[colorOf(s[s.length - 1])]++;
    return f;
  }

  // Result after the last move: null (ongoing) or {winner: 0|1|2, kind: 'road'|'flat'|'draw'}.
  // `mover` = the player who just moved (dragon clause: mover wins double roads).
  result() {
    const mover = 3 - this.toMove;
    const rm = this.hasRoad(mover), ro = this.hasRoad(3 - mover);
    if (rm) return { winner: mover, kind: 'road' };
    if (ro) return { winner: 3 - mover, kind: 'road' };
    let full = true;
    for (const s of this.board) if (!s.length) { full = false; break; }
    const out = (c) => this.stones[c] + this.caps[c] === 0;
    if (full || out(1) || out(2)) {
      const f = this.flatCounts();
      const d = f[1] - f[2] - this.komi;
      return d > 0 ? { winner: 1, kind: 'flat' } : d < 0 ? { winner: 2, kind: 'flat' } : { winner: 0, kind: 'draw' };
    }
    return null;
  }
}

// ---------- forced-win search ----------
// winIn(g, plies): can side to move force a win (any kind) within `plies` plies (odd)?
// Uses a transposition table; `budget` caps node count (returns undefined if exceeded).
export class Solver {
  constructor(g, { maxNodes = 5e6 } = {}) {
    this.g = g; this.tt = new Map(); this.nodes = 0; this.maxNodes = maxNodes;
  }
  _check() { if (++this.nodes > this.maxNodes) throw new Error('budget'); }

  // Orders attacker moves: placements and moves near own pieces first is cheap enough; we just try
  // immediate wins first in winIn anyway.
  winIn(plies) {
    const g = this.g, me = g.toMove;
    const k = g.key() + ':' + plies;
    const hit = this.tt.get(k);
    if (hit !== undefined) return hit;
    const moves = g.legalMoves();
    // 1) immediate win
    for (const mv of moves) {
      this._check();
      const u = g.apply(mv);
      const res = g.result();
      g.undo(u);
      if (res && res.winner === me) { this.tt.set(k, true); return true; }
    }
    if (plies < 3) { this.tt.set(k, false); return false; }
    // 2) moves after which every reply loses within plies-1
    const ordered = this._orderAttack(moves);
    for (const mv of ordered) {
      const u = g.apply(mv);
      const res = g.result();
      let ok = false;
      if (!res) ok = this.allLose(plies - 1);
      g.undo(u);
      if (ok) { this.tt.set(k, true); return true; }
    }
    this.tt.set(k, false);
    return false;
  }

  // Defender to move; true if every reply leaves attacker a win within plies-1.
  allLose(plies) {
    const g = this.g, def = g.toMove, att = 3 - def;
    const k = g.key() + ':' + plies;
    const hit = this.tt.get(k);
    if (hit !== undefined) return hit;
    // Quick necessary condition: attacker must currently threaten a win-in-1 (else a null-ish reply escapes).
    // (Zugzwang is essentially absent in Tak, but we still verify every reply for correctness.)
    const replies = this._orderDefense(g.legalMoves());
    for (const r of replies) {
      this._check();
      const u = g.apply(r);
      const res = g.result();
      let lost;
      if (res) lost = res.winner === att;
      else lost = this.winIn(plies - 1);
      g.undo(u);
      if (!lost) { this.tt.set(k, false); return false; }
    }
    this.tt.set(k, true);
    return true;
  }

  // Attack ordering: stack moves and placements adjacent to own road pieces first.
  _orderAttack(moves) {
    const g = this.g, me = g.toMove, size = g.size;
    const near = (sq) => {
      const r = (sq / size) | 0, c = sq % size;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const t = g.top(rr * size + cc);
        if (t >= 0 && colorOf(t) === me && typeOf(t) !== WALL) return true;
      }
      return false;
    };
    const score = (mv) => (mv.kind === 'm' ? 2 : 0) + (mv.kind === 'p' && mv.type === FLAT ? 1 : 0) + (mv.kind === 'p' && near(mv.sq) ? 2 : 0) - (mv.kind === 'p' && mv.type === WALL ? 1 : 0);
    return moves.map((m) => [score(m), m]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  }

  // Defense ordering: blocking moves (walls/caps/flats onto empty squares, captures) first.
  _orderDefense(moves) {
    const score = (mv) => (mv.kind === 'p' ? (mv.type === WALL ? 3 : mv.type === CAP ? 3 : 1) : 2);
    return moves.map((m) => [score(m), m]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  }
}

// All moves for side to move that force a win within `plies` plies. Returns array of PTN.
export function winningMoves(g, plies, opts) {
  const s = new Solver(g, opts);
  const me = g.toMove, out = [];
  for (const mv of g.legalMoves()) {
    const u = g.apply(mv);
    const res = g.result();
    let ok;
    if (res) ok = res.winner === me;
    else ok = plies >= 3 ? s.allLose(plies - 1) : false;
    g.undo(u);
    if (ok) out.push(g.moveToPTN(mv));
  }
  return { moves: out, nodes: s.nodes };
}

// Fastest forced win distance (in plies, odd) up to maxPlies, else 0.
export function mateDistance(g, maxPlies, opts) {
  const s = new Solver(g, opts);
  for (let p = 1; p <= maxPlies; p += 2) if (s.winIn(p)) return p;
  return 0;
}
