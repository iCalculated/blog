// tinue's own Tak board: looks and plays like PTN Ninja's 2D board (what PlayTak embeds), at a tiny fraction
// of the weight. Rules come from shared/tak.js; the visual and interaction spec is summarized at the top of
// board.css (which the page links).
import { Game, FLAT, WALL, CAP, RESERVES, colorOf, typeOf } from './shared/tak.js?v=1794178081';
import { parsePTN } from './shared/ptn.js?v=1794178081';

const SP = 7, GAP = 3; // stack step (% of a square) and how many steps a carried hand is lifted
const STEP = { '+': [1, 0], '-': [-1, 0], '>': [0, 1], '<': [0, -1] }; // [dRow, dCol]
const FILES = 'abcdefgh';

// ---------- positions with piece identities (so a move can be animated piece by piece) ----------
// Piece ids: per color, stones 0..F-1 then caps; id = (color-1)*T + k. A position (snapshot) keeps
// stacks of ids, each id's current type, the rules Game, and the squares the last ply touched.
function pieceSet(size) {
  const [F, C] = RESERVES[size];
  return { F, C, T: F + C, color: (id) => (id < F + C ? 1 : 2), isCap: (id) => id % (F + C) >= F };
}

function nextFromTray(P, st, color, cap) {
  const used = new Set(st.flat());
  const base = (color - 1) * P.T;
  for (let k = cap ? P.F : 0; k < (cap ? P.T : P.F); k++) if (!used.has(base + k)) return base + k;
  return -1;
}

function initialSnap(g, P) {
  const st = Array.from({ length: g.n }, () => []);
  const ty = new Int8Array(2 * P.T);
  const used = new Set();
  for (let sq = 0; sq < g.n; sq++) for (const p of g.board[sq]) {
    const color = colorOf(p), cap = typeOf(p) === CAP, base = (color - 1) * P.T;
    let k = cap ? P.F : 0;
    while (used.has(base + k)) k++;
    used.add(base + k); st[sq].push(base + k); ty[base + k] = typeOf(p);
  }
  return { g, st, ty, hl: null };
}

function stepSnap(s, P, ptn) {
  const g = s.g.clone();
  const mv = g.parseMove(ptn);
  if (!g.isLegal(mv)) throw new Error('illegal move ' + ptn + ' in ' + g.toTPS());
  const st = s.st.map((a) => a.slice()), ty = s.ty.slice(), size = g.size;
  let hl;
  if (mv.kind === 'p') {
    const color = g.ply < 2 ? 3 - g.toMove : g.toMove;
    const id = nextFromTray(P, st, color, mv.type === CAP);
    ty[id] = mv.type; st[mv.sq].push(id);
    hl = { sqs: [mv.sq], prim: [mv.sq] };
  } else {
    const count = mv.drops.reduce((a, b) => a + b, 0);
    const hand = st[mv.sq].splice(st[mv.sq].length - count);
    const [dr, dc] = STEP[mv.dir];
    let r = Math.floor(mv.sq / size), c = mv.sq % size;
    const sqs = [mv.sq];
    for (const d of mv.drops) {
      r += dr; c += dc;
      const sq = r * size + c, dst = st[sq];
      if (dst.length && ty[dst[dst.length - 1]] === WALL) ty[dst[dst.length - 1]] = FLAT;
      dst.push(...hand.splice(0, d)); sqs.push(sq);
    }
    hl = { sqs, prim: sqs.slice(1) };
  }
  const canon = g.moveToPTN(mv);
  g.apply(mv);
  return { g, st, ty, hl, ptn: canon };
}

// Squares of a finished road with dead ends pruned (what gets drawn at full strength), plus its axes.
function roadOf(g, color) {
  const comp = g.roadSquares(color);
  if (!comp) return null;
  const n = g.size, set = new Set(comp);
  const rows = comp.map((s) => (s / n) | 0), cols = comp.map((s) => s % n);
  const ns = rows.includes(0) && rows.includes(n - 1), ew = cols.includes(0) && cols.includes(n - 1);
  for (let changed = true; changed;) {
    changed = false;
    for (const s of [...set]) {
      const r = (s / n) | 0, c = s % n;
      let links = (r > 0 && set.has(s - n)) + (r < n - 1 && set.has(s + n)) + (c > 0 && set.has(s - 1)) + (c < n - 1 && set.has(s + 1));
      if (ns && (r === 0 || r === n - 1)) links++;
      if (ew && (c === 0 || c === n - 1)) links++;
      if (links < 2) { set.delete(s); changed = true; }
    }
  }
  return { set, ns, ew };
}

export class Board {
  constructor(el, { onMove, onState } = {}) {
    this.el = el; this.onMove = onMove; this.onState = onState;
    el.classList.add('tb-host');
    this.opts = { disableBoard: false, showRoads: false, animateBoard: true };
    this.player = null; this.rot = false; this.sel = null; this.hlSquares = []; this.hover = -1;
    this.ready = Promise.resolve();
    this._setup(new Game(5), []);
    el.addEventListener('click', (e) => this._onClick(e, false));
    // Phones: a tap is handled on touchend, whose default is cancelled. iOS Safari ignores touch-action: manipulation
    // for a quick second tap on the same spot (taking more stones off a stack) and zooms; cancelling touchend stops
    // the zoom and the synthetic click, so each tap is handled exactly once. Scrolls (the finger moved) and pinches
    // (two fingers) are left alone.
    let t0 = null;
    el.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      t0 = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
    }, { passive: true });
    el.addEventListener('touchcancel', () => { t0 = null; });
    el.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0], s = t0;
      t0 = null;
      if (!s || e.touches.length || Math.hypot(t.clientX - s.x, t.clientY - s.y) > 10) return;
      const target = document.elementFromPoint(t.clientX, t.clientY);
      if (!target || !el.contains(target)) return;
      e.preventDefault();
      this._onClick({ target }, false);
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); this._onClick(e, true); });
    el.addEventListener('mouseover', (e) => { const sq = this._sqAt(e); if (sq !== this.hover) { this.hover = sq; this._render(); } });
    el.addEventListener('mouseleave', () => { if (this.hover >= 0) { this.hover = -1; this._render(); } });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.sel) this.cancel(); });
  }

  // ---------- public API ----------
  async load(ptn) {
    const { headers, moves } = parsePTN(ptn);
    const komi = +(headers.Komi || 0);
    const g = headers.TPS ? Game.fromTPS(headers.TPS, komi) : new Game(+headers.Size || 5);
    g.komi = komi;
    this._setup(g, moves);
  }
  async append(ply) {
    const s = this.snaps.at(-1);
    let next;
    try { next = stepSnap(s, this.P, ply); } catch (e) { console.warn(e.message); return; }
    const atEnd = this.cur === this.snaps.length - 1;
    this.snaps.push(next); this.sel = null;
    this._show(this.snaps.length - 1, atEnd);
  }
  async goTo(plyID) { this._show(Math.max(0, Math.min(this.snaps.length - 1, plyID + 1))); }
  async first() { this._show(0); }
  async last() { this._show(this.snaps.length - 1); }
  async setPlayer(p) { this.player = p; this._render(); }
  async ui(v = {}) {
    Object.assign(this.opts, v);
    if (this.opts.disableBoard) this.sel = null;
    this._render();
  }
  async highlight(squares = []) {
    this.hlSquares = (squares || []).map((n) => this.g0.sqIndex(n)).filter((i) => i >= 0 && i < this.n * this.n);
    this._render();
  }
  async cancel() { this.sel = null; this._render(); }
  // Play a move given as PTN (typed instead of clicked), exactly as if it had been entered on the board.
  play(ptn) {
    if (!this._canInput()) return false;
    try { stepSnap(this.snaps[this.cur], this.P, ptn); } catch { return false; }
    this.sel = null;
    this._commit(ptn);
    return true;
  }
  async rotate180() { this.rot = !this.rot; this._build(); this._render(false); }

  // ---------- setup / DOM ----------
  _setup(g, moves) {
    const sizeChanged = !this.g0 || this.g0.size !== g.size;
    this.g0 = g; this.n = g.size; this.P = pieceSet(g.size);
    this.snaps = [initialSnap(g, this.P)];
    for (const m of moves) {
      try { this.snaps.push(stepSnap(this.snaps.at(-1), this.P, m)); } catch (e) { console.warn(e.message); break; }
    }
    this.sel = null; this.hlSquares = [];
    if (sizeChanged || !this.root) this._build();
    this._show(this.snaps.length - 1);
  }

  _build() {
    const n = this.n;
    this.el.innerHTML = `<div class="tb" style="--n:${n}"><div class="tb-board" role="img"></div><div class="tb-tray"></div></div>`;
    this.root = this.el.firstChild;
    this.boardEl = this.root.firstChild; this.trayEl = this.root.lastChild;
    this.sqEls = []; this.cache = new Map();
    const order = [];
    for (let dr = n - 1; dr >= 0; dr--) for (let dc = 0; dc < n; dc++) order.push(this._logical(dc, dr));
    for (const sq of order) {
      const r = (sq / n) | 0, c = sq % n, [dc, dr] = this._disp(sq);
      const d = document.createElement('div');
      d.className = 'tb-sq ' + (c % 2 !== r % 2 ? 'lt' : 'dk');
      d.dataset.sq = sq;
      // round the board's top corners to match the page's panels (pieces live in their own layer, so nothing clips)
      if (dr === n - 1 && (dc === 0 || dc === n - 1)) { d.style[dc === 0 ? 'borderTopLeftRadius' : 'borderTopRightRadius'] = 'var(--corner, 6px)'; d.style.overflow = 'hidden'; }
      d.innerHTML = '<div class="tb-hl tb-cur"></div><div class="tb-hl tb-pl"></div><div class="tb-rd"><i class="m"></i><i class="n"></i><i class="e"></i><i class="s"></i><i class="w"></i></div>' +
        (dc === 0 ? `<span class="tb-lab tb-lr">${r + 1}</span>` : '') + (dr === 0 ? `<span class="tb-lab tb-lc">${FILES[c]}</span>` : '');
      d._rd = d.children[2].children;
      this.boardEl.append(d);
      this.sqEls[sq] = d;
    }
    const pcs = document.createElement('div');
    pcs.className = 'tb-pcs';
    this.pcEls = [];
    for (let id = 0; id < 2 * this.P.T; id++) {
      const p = document.createElement('div');
      p.className = 'tb-pc';
      p.innerHTML = '<div class="tb-st"></div><span class="tb-cnt"></span>';
      p.dataset.id = id;
      this.pcEls.push(p); pcs.append(p);
    }
    this.boardEl.append(pcs);
  }

  _disp(sq) { const n = this.n, r = (sq / n) | 0, c = sq % n; return this.rot ? [n - 1 - c, n - 1 - r] : [c, r]; }
  _logical(dc, dr) { const n = this.n; return this.rot ? (n - 1 - dr) * n + (n - 1 - dc) : dr * n + dc; }

  _show(i, animate = false) {
    this.cur = i; this.sel = null;
    this._render(animate);
    this.onState?.({ plyID: i - 1, plies: this.snaps.length - 1, tps: this.snaps[i].g.toTPS() });
  }

  _canInput() {
    const g = this.snaps[this.cur].g;
    return !this.opts.disableBoard && (this.player == null || this.player === g.toMove) && !g.result();
  }

  // ---------- the position as drawn: snapshot + the move being entered ----------
  _view() {
    const s = this.snaps[this.cur], sel = this.sel;
    let st = s.st, ty = s.ty;
    const lifted = new Set();
    let traySel = -1, cnt = null;
    if (sel?.t === 'tray') {
      traySel = nextFromTray(this.P, st, this._placeColor(), sel.cap);
      if (sel.wall) { ty = ty.slice(); ty[traySel] = WALL; }
    } else if (sel?.t === 'stack') {
      st = st.map((a) => a.slice());
      if (sel.flat != null) { ty = ty.slice(); ty[sel.flat] = FLAT; }
      const o = sel.path[0];
      const hand = st[o].splice(st[o].length - sel.picked);
      for (let j = 1; j < sel.path.length; j++) st[sel.path[j]].push(...hand.splice(0, sel.drops[j - 1]));
      const cur = sel.path.at(-1);
      st[cur].push(...hand);
      for (const id of hand) lifted.add(id);
      cnt = [cur, sel.path.length === 1 ? sel.picked : sel.drops.at(-1)];
    }
    return { s, st, ty, lifted, first: lifted.size ? [...lifted][0] : -1, traySel, cnt };
  }

  _placeColor() { const g = this.snaps[this.cur].g; return g.ply < 2 ? 3 - g.toMove : g.toMove; }

  // Squares a click would act on (also drives the hover tint).
  _valid(v) {
    const out = new Set();
    if (!this._canInput()) return out;
    const { s, st } = v, g = s.g, n = this.n, sel = this.sel;
    if (!sel || sel.t === 'tray') {
      const canPlace = g.ply < 2 || g.stones[g.toMove] + g.caps[g.toMove] > 0;
      for (let sq = 0; sq < n * n; sq++) {
        if (!st[sq].length) { if (canPlace) out.add(sq); }
        else if (!sel && g.ply >= 2 && colorOf(g.top(sq)) === g.toMove) out.add(sq);
      }
      return out;
    }
    const cur = sel.path.at(-1);
    out.add(cur);
    if (sel.path.length > 1) out.add(sel.path[0]);
    for (const d of sel.path.length > 1 ? [sel.dir] : Object.keys(STEP)) {
      const t = this._next(cur, d);
      if (t >= 0 && this._enterable(t, s)) out.add(t);
    }
    return out;
  }
  _next(sq, d) {
    const n = this.n, r = ((sq / n) | 0) + STEP[d][0], c = (sq % n) + STEP[d][1];
    return r < 0 || c < 0 || r >= n || c >= n ? -1 : r * n + c;
  }
  _capInHand(s) { const o = s.st[this.sel.path[0]]; return s.ty[o[o.length - 1]] === CAP; }
  _enterable(t, s) {
    const top = s.st[t].at(-1);
    if (top == null || s.ty[top] === FLAT) return true;
    return s.ty[top] === WALL && this._capInHand(s);
  }

  // ---------- input ----------
  _sqAt(e) { const d = e.target.closest?.('.tb-sq'); return d && this.el.contains(d) ? +d.dataset.sq : -1; }

  _onClick(e, alt) {
    if (e.target.closest('.tb-tray')) { if (this.sel?.t === 'tray') this.cancel(); return; }
    const st = e.target.closest('.tb-st.pick');
    if (st) return this._trayClick(+st.parentNode.dataset.id, alt);
    const sq = this._sqAt(e);
    if (sq >= 0) this._squareClick(sq, alt);
  }

  _trayClick(id, alt) {
    if (!this._canInput()) return;
    const cap = this.P.isCap(id), sel = this.sel, opening = this.snaps[this.cur].g.ply < 2;
    if (opening && cap) return;
    if (sel?.t === 'tray' && sel.cap === cap) {
      const isSel = id === nextFromTray(this.P, this.snaps[this.cur].st, this._placeColor(), cap);
      if (isSel && !cap && !opening) sel.wall = !sel.wall; else this.sel = null;
    } else this.sel = { t: 'tray', cap, wall: alt && !cap && !opening };
    this._render();
  }

  _squareClick(sq, alt) {
    if (!this._canInput()) return;
    const v = this._view();
    if (!this._valid(v).has(sq)) return;
    const s = this.snaps[this.cur], g = s.g, sel = this.sel;
    if (!sel || sel.t === 'tray') {
      if (!s.st[sq].length) {
        let type = FLAT;
        if (sel) type = sel.cap ? CAP : sel.wall ? WALL : FLAT;
        else if (g.ply >= 2 && !g.stones[g.toMove]) type = CAP;
        return this._commit(g.moveToPTN({ kind: 'p', sq, type }));
      }
      this.sel = { t: 'stack', path: [sq], picked: alt ? 1 : Math.min(this.n, s.st[sq].length), drops: [], dir: null, flat: null };
      return this._render();
    }
    const cur = sel.path.at(-1), moved = sel.path.length > 1;
    let hand = sel.picked - sel.drops.reduce((a, b) => a + b, 0);
    if (sq === cur) {
      if (!moved) { if (--sel.picked === 0) this.sel = null; return this._render(); }
      sel.drops[sel.drops.length - 1]++;
      return hand === 1 ? this._finish() : this._render();
    }
    if (moved && sq === sel.path[0]) return this.cancel();
    const dir = Object.keys(STEP).find((d) => this._next(cur, d) === sq);
    const top = s.st[sq].at(-1);
    if (top != null && s.ty[top] === WALL) {
      // Only the capstone may flatten a wall: whatever else is in hand drops here first.
      if (hand > 1) { if (moved) sel.drops[sel.drops.length - 1] += hand - 1; else sel.picked -= hand - 1; }
      sel.path.push(sq); sel.dir = dir; sel.drops.push(1); sel.flat = top;
      return this._finish();
    }
    const drop = alt ? hand : 1;
    sel.path.push(sq); sel.dir = dir; sel.drops.push(drop); hand -= drop;
    if (hand > 0) {
      const nx = this._next(sq, dir);
      if (nx < 0 || !this._enterable(nx, s)) { sel.drops[sel.drops.length - 1] += hand; hand = 0; }
    }
    return hand === 0 ? this._finish() : this._render();
  }

  _finish() {
    const sel = this.sel, g = this.snaps[this.cur].g;
    const ptn = g.moveToPTN({ kind: 'm', sq: sel.path[0], dir: sel.dir, drops: sel.drops });
    this._commit(ptn);
  }

  _commit(ptn) {
    let next;
    try { next = stepSnap(this.snaps[this.cur], this.P, ptn); } catch { this.cancel(); return; }
    // Like PTN Ninja: playing the move that already comes next just steps forward (the rest of the line is
    // kept, so history browsing still works); any other move replaces what followed.
    if (this.snaps[this.cur + 1]?.ptn === next.ptn) next = this.snaps[this.cur + 1];
    else { this.snaps.length = this.cur + 1; this.snaps.push(next); }
    this.hlSquares = [];
    this._show(this.cur + 1, true);
    this.onMove?.(next.ptn);
  }

  // ---------- drawing ----------
  _set(el, key, val, apply) { if (this.cache.get(el)?.[key] === val) return; let c = this.cache.get(el); if (!c) this.cache.set(el, (c = {})); c[key] = val; apply(val); }

  _render(animate = true) {
    if (!this.root) return;
    const anim = animate && this.opts.animateBoard;
    if (!anim) this.root.classList.add('na');
    const v = this._view(), { s, st, ty } = v, g = s.g, n = this.n, P = this.P;
    this.root.classList.toggle('t2', g.toMove === 2);
    const valid = this._valid(v);
    const res = g.result();
    const roads = this._roads(g, res);
    const who = (c) => (c === 1 ? 'White' : 'Black');
    const label = `Tak board, ${res ? (res.winner ? `${who(res.winner)} won` : 'drawn') : `${who(g.toMove)} to move`}. Position: ${g.toTPS()}`;
    this._set(this.boardEl, 'l', label, (x) => this.boardEl.setAttribute('aria-label', x));

    // squares
    const hl = this.cur > 0 ? s.hl : null;
    const selSqs = this.sel?.t === 'stack' ? this.sel.path : [];
    for (let sq = 0; sq < n * n; sq++) {
      const top = g.top(sq);
      let cls = 'tb-sq ' + (sq % n % 2 !== ((sq / n) | 0) % 2 ? 'lt' : 'dk');
      if (top >= 0) cls += ' o' + colorOf(top);
      if (hl?.sqs.includes(sq)) cls += ' c' + (hl.prim.includes(sq) ? ' cp' : '');
      const hi = this.hlSquares.indexOf(sq);
      if (hi >= 0) cls += ' s' + (hi === 0 ? ' sp' : '');
      const si = selSqs.indexOf(sq);
      if (si >= 0) cls += ' sel' + (si === 0 && selSqs.length > 1 ? ' selp' : '');
      if (res?.kind !== 'road' && res && top >= 0 && typeOf(top) === FLAT) cls += ' fw';
      if (valid.has(sq)) cls += ' v';
      const el = this.sqEls[sq];
      this._set(el, 'c', cls, (x) => { el.className = x; });
      const arms = roads[sq] || ['m', 'n x', 'e x', 's', 'w'];
      for (let k = 0; k < 5; k++) this._set(el._rd[k], 'c', arms[k], (x) => { el._rd[k].className = x; });
    }

    // board pieces
    const onBoard = new Set();
    const counts = new Map();
    for (let sq = 0; sq < n * n; sq++) {
      const stack = st[sq], len = stack.length;
      if (!len) continue;
      const [dc, dr] = this._disp(sq);
      const over = Math.max(0, len - 10 - n);
      for (let z = 0; z < len; z++) {
        const id = stack[z], up = v.lifted.has(id), wall = ty[id] === WALL, imm = len - z > n;
        let y = SP * (z + (up ? GAP : 0));
        if (len > n && z >= len - n) y -= SP * (len - n);
        if (wall && len > 1) y -= SP;
        if (imm) y -= SP * over;
        onBoard.add(id);
        this._piece(id, dc * 100, -(dr * 100 + y), 10000 + z + (up ? GAP : 0) - (imm ? over : 0),
          (wall ? ' S' : ty[id] === CAP ? ' C' : '') + (imm ? ' im' : '') + (z < over ? ' ov' : '') + (id === v.first ? ' fs' : ''));
      }
      if (sq === this.hover || selSqs.includes(sq)) counts.set(stack[len - 1], len);
    }
    if (v.cnt) counts.set(st[v.cnt[0]].at(-1), v.cnt[1]);

    // tray
    const canPick = this._canInput() && (!this.sel || this.sel.t === 'tray');
    const pc = this._placeColor(), opening = g.ply < 2;
    for (let id = 0; id < 2 * P.T; id++) {
      if (onBoard.has(id)) continue;
      const color = P.color(id), k = id % P.T, cap = P.isCap(id);
      const f = (cap ? P.T - (k - P.F) - 1 : P.F - 1 - k) / (P.T - 1);
      const x = (n / 2 - 0.875) * f, X = color === 1 ? n / 2 - 0.875 - x : n / 2 - 0.125 + x;
      const up = id === v.traySel;
      const z = (P.T - (cap ? k - P.F : k)) / P.T - (cap ? 0 : P.C) + (color === 1 ? 1 : n - 1);
      this._piece(id, X * 100, 100 - (up ? SP * GAP : 0), Math.round(z * 1000) + (up ? 3000 : 0),
        (ty[id] === WALL && up ? ' S' : cap ? ' C' : '') + (up ? ' fs' : '') +
        (canPick && color === pc && !(opening && cap) ? ' pick' : ''));
    }

    for (let id = 0; id < 2 * P.T; id++) {
      const c = this.pcEls[id].lastChild, t = counts.get(id);
      this._set(c, 't', t > 1 || (t && this.sel) ? String(t) : '', (x) => { c.textContent = x; });
    }

    if (!anim) { void this.root.offsetWidth; this.root.classList.remove('na'); }
  }

  _piece(id, x, y, z, extra) {
    const el = this.pcEls[id], stn = el.firstChild;
    this._set(el, 't', `translate(${x}%,${y}%)`, (t) => { el.style.transform = t; });
    this._set(el, 'z', z, (t) => { el.style.zIndex = t; });
    this._set(stn, 'c', 'tb-st p' + this.P.color(id) + extra, (t) => { stn.className = t; });
  }

  // Road arm classes per logical square, in display directions: [center, n, e, s, w].
  _roads(g, res) {
    const out = [], n = this.n;
    const showAll = this.opts.showRoads && res?.kind !== 'flat';
    const won = res?.kind === 'road' ? [1, 2].map((c) => (g.hasRoad(c) ? roadOf(g, c) : null)) : [null, null];
    if (!showAll && !won[0] && !won[1]) return out;
    const road = (sq) => { const t = g.top(sq); return t >= 0 && typeOf(t) !== WALL ? colorOf(t) : 0; };
    for (let sq = 0; sq < n * n; sq++) {
      const color = road(sq);
      if (!color) continue;
      const r = (sq / n) | 0, c = sq % n, R = won[color - 1];
      const inRoad = R?.set.has(sq);
      // logical N, E, S, W: [edge?, neighbor]
      const sides = [[r === n - 1, sq + n, 'ns'], [c === n - 1, sq + 1, 'ew'], [r === 0, sq - n, 'ns'], [c === 0, sq - 1, 'ew']];
      const conn = sides.map(([edge, nb]) => edge || road(nb) === color);
      const isRd = sides.map(([edge, nb, ax], i) => inRoad && conn[i] && (edge ? R[ax] : R.set.has(nb)));
      let ord = [0, 1, 2, 3];
      if (this.rot) ord = [2, 3, 0, 1];
      const edges = ord.map((i) => sides[i][0]), cn = ord.map((i) => conn[i]), rd = ord.map((i) => isRd[i]);
      const cls = (on, isR) => (on && showAll ? ' on' : '') + (isR ? ' rd' : '');
      const any = conn.some(Boolean);
      out[sq] = [
        'm' + cls(any, inRoad && rd.some(Boolean)),
        'n' + (edges[0] ? ' x' : '') + cls(cn[0], rd[0]),
        'e' + (edges[1] ? ' x' : '') + cls(cn[1], rd[1]),
        's' + (edges[2] ? cls(cn[2], rd[2]) : ''),
        'w' + (edges[3] ? cls(cn[3], rd[3]) : ''),
      ];
    }
    return out;
  }
}

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
