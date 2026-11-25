// RETIRED (2026-11-22): tinue's own Tak board. PTN Ninja (ninja.js) is the only board; constructing this one throws
// at once, in every build. The code stays in the repository for now and the page never loads this file: what the page
// needs of it (buildPTN, landOf, turnMark, focusedByPointer, the sound hooks) is in board-kit.js, re-exported here.
// (Was: tinue's own board, modeled on PTN Ninja's 2D board; spec at the top of board.css.)
import { Game, FLAT, WALL, CAP, RESERVES, colorOf, typeOf } from './shared/tak.js?v=1795581690';
import { parsePTN } from './shared/ptn.js?v=1795581690';
import { dispPoint, shapesSvg, stackPiece, SP, GAP } from './analysis.js?v=1795581690';
import { turnMark, landOf, focusedByPointer, buildPTN, hooks } from './board-kit.js?v=1795581690';
export { turnMark, landOf, focusedByPointer, buildPTN, hooks };

export const RETIRED = "tinue's own board is retired: PTN Ninja is the only board";

// (SP, GAP: the stack step, % of a square, and how many steps a carried hand is lifted; analysis.js stackPiece)
const STEP = { '+': [1, 0], '-': [-1, 0], '>': [0, 1], '<': [0, -1] }; // [dRow, dCol]
const FILES = 'abcdefgh';
// Board orientation: a 2×2 matrix [a, b, c, d] taking centred logical (file, rank) to display (x, y), y up.
// Keys compose a turn or mirror onto it, as in PTN Ninja: [ ] quarter turns, - half turn, ; : mirrors, = reset.
const ID = [1, 0, 0, 1];
const OPS = { ']': [0, 1, -1, 0], '[': [0, -1, 1, 0], '-': [-1, 0, 0, -1], ';': [-1, 0, 0, 1], ':': [1, 0, 0, -1], '=': null };
const mul = ([p, q, r, t], [a, b, c, d]) => [p * a + q * c, p * b + q * d, r * a + t * c, r * b + t * d];
const loadOrient = () => { try { const m = JSON.parse(localStorage.getItem('tinue.orient')); if (Array.isArray(m) && m.length === 4) return m; } catch {} return ID; };

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

// What a move sets down, for its sound (sound.js playMove's info), read off the position before it: a placement's piece;
// a stack move's top piece (the last to land) and, per square dropped on, what it lands on ('board': the square was
// empty, 'piece').
const KIND = { [FLAT]: 'flat', [WALL]: 'wall', [CAP]: 'cap' };

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
  const canon = g.moveToPTN(mv), land = landOf(g, mv);
  const u = g.apply(mv);
  return { g, st, ty, hl, ptn: canon, smash: u.smashed, land }; // (smash: a wall flattened; land: landOf; for the sound)
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
  // The sound hooks, set by app.js to sound.js (kept out of this file, which node tests import):
  // onPly(ptn, smash, info) on every move played or appended at the line's end, on any board; info is landOf's
  //   { piece } or { top, onto }, plus byHand when the move was a stack built by hand whose drops onLand already sounded.
  // onLand([{ piece, onto, drop: true, smash }]) as pieces of a stack being moved by hand land, one input at a time.
  // onCut() when the board jumps to another position (a load, a step back, a jump): queued drops stop.
  // Each gets the board it came from as its last argument (app.js: a board out of sight makes no sound).
  static onPly = null;
  static onLand = null;
  static onCut = null;
  constructor(el, { onMove } = {}) {
    throw new Error(RETIRED); // (PTN Ninja is the only board: nothing may put this one on screen)
    this.el = el; this.onMove = onMove;
    el.classList.add('tb-host');
    this.opts = { disableBoard: false, showRoads: false, animateBoard: true, dropOnStray: false };
    this.player = null; this.M = loadOrient(); this.sel = null; this.hlSquares = []; this.hover = -1; this.peekHl = null;
    this.gen = 0; // bumped by forget(): a touch begun before it is not a tap on what came after
    this.lockUntil = 0; this.forgotAt = -Infinity; this.keysDown = new Map(); // lock(), forget(): a new puzzle's first moments
    this.ready = Promise.resolve();
    this._setup(new Game(5), []);
    el.addEventListener('click', (e) => this._onClick(e, false));
    // Phones: a tap is handled on touchend, whose default is cancelled. iOS Safari ignores touch-action: manipulation
    // for a quick second tap on the same spot (taking more stones off a stack) and zooms; cancelling touchend stops
    // the zoom and the synthetic click, so each tap is handled exactly once. Scrolls (the finger moved) and pinches
    // (two fingers) are left alone.
    // A long press (500 ms, one finger, under 10 px of drift) is the touch right-click; its release is not a tap.
    let t0 = null, lp = 0, lastTouch = 0;
    const at = (x, y) => { const t = document.elementFromPoint(x, y); return t && el.contains(t) ? t : null; };
    el.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      clearTimeout(lp); lastTouch = Date.now();
      const s = t0 = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, long: false, gen: this.gen } : null;
      if (s) lp = setTimeout(() => { if (t0 !== s || s.gen !== this.gen) return; s.long = true; const target = at(s.x, s.y); if (target) this._onClick({ target }, true); }, 500);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (t0 && !t0.long && Math.hypot(t.clientX - t0.x, t.clientY - t0.y) > 10) { clearTimeout(lp); t0 = null; }
    }, { passive: true });
    el.addEventListener('touchcancel', () => { clearTimeout(lp); t0 = null; });
    el.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0], s = t0;
      clearTimeout(lp); lastTouch = Date.now(); t0 = null;
      // (begun before forget(): swallowed, so it isn't a click on the new position either)
      if (s?.long || (s && s.gen !== this.gen)) { if (e.cancelable) e.preventDefault(); return; }
      if (!s || e.touches.length || Math.hypot(t.clientX - s.x, t.clientY - s.y) > 10) return;
      const target = document.elementFromPoint(t.clientX, t.clientY);
      if (!target || !el.contains(target)) return;
      e.preventDefault();
      this._onClick({ target }, false);
    }, { passive: false });
    // Android fires its own contextmenu on a long press: the timer above already handled that one.
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (e.pointerType !== 'touch' && !t0 && Date.now() - lastTouch > 800) this._onClick(e, true); });
    el.addEventListener('mouseover', (e) => { const sq = this._sqAt(e); if (sq !== this.hover) { this.hover = sq; this._render(); } });
    el.addEventListener('mouseleave', () => { if (this.hover >= 0) { this.hover = -1; this._render(); } });
    window.addEventListener('keydown', (e) => { if (!e.repeat) this.keysDown.set(e.key, performance.now()); this._onKey(e); });
    window.addEventListener('keyup', (e) => this.keysDown.delete(e.key));
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
  // The analysis page's shapes (app.js paintShapes; analysis.js shapesSvg draws them): arrows, rings and ghosts for the
  // engine's lines and the opponent's threats. They belong to the position they were set on: drawn only while that
  // position is shown, and not while stones are in hand or the next move is peeked at; an empty list clears them.
  shapes(list = []) {
    this.shapesList = list || []; this.shapesSnap = this.snaps[this.cur];
    this._drawShapes();
  }
  get shapesVisible() { return !!this.shapesList?.length && this.snaps[this.cur] === this.shapesSnap && !this.sel && !this.peekHl; }
  // Another puzzle: drop whatever input was under way on the last one (stones in hand, a number key kept for when input
  // opens (_flushKey), a touch or long press in progress), so none of it lands on the new position.
  forget() { this.sel = null; this.pendKey = null; this.gen++; this.forgotAt = performance.now(); this._render(false); }
  // A touch under way ends here without a tap or a long press (made for taps
  // taken elsewhere while a move is held for confirmation). The position and anything in hand stay.
  dropGesture() { this.gen++; }
  // A new puzzle's first moments (app.js start: busy.js 'board'): no tap, long press, tray pick or Enter at all, not just
  // no finished move. A stack lifted or a cap picked then (the second tap of a double tap on Next, landing where the
  // dock was) stayed in hand and turned the player's first deliberate tap into another move, a miss. A number key is
  // kept for the lock's end, as during an intro (_flushKey). Nothing is drawn differently meanwhile.
  lock(until) {
    this.lockUntil = until; clearTimeout(this._lockT);
    this._lockT = setTimeout(() => this._flushKey(), Math.max(0, until - performance.now()) + 1);
  }
  _locked() { return performance.now() < this.lockUntil; }
  get holding() { return !!this.sel; } // stones in hand (or a tray stone picked): navigation waits
  get peeking() { return !!this.peekHl; }
  // Half-step: keep this position but highlight the squares the next move touches (Shift+arrow, as in PTN Ninja).
  peek() { const nx = this.snaps[this.cur + 1]; if (nx) { this.peekHl = nx.hl; this._render(false); } return !!nx; }
  // Play a move given as PTN (typed instead of clicked), exactly as if it had been entered on the board.
  play(ptn) {
    if (!this._canInput()) return false;
    try { stepSnap(this.snaps[this.cur], this.P, ptn); } catch { return false; }
    this.sel = null;
    this._commit(ptn);
    return true;
  }
  // key: one of OPS ('=' resets). Kept in this browser, like PTN Ninja's setting.
  orient(key) {
    this.M = OPS[key] ? mul(OPS[key], this.M) : ID;
    try { localStorage.setItem('tinue.orient', JSON.stringify(this.M)); } catch {}
    this._build(); this._render(false);
  }

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
    // Flat-count bar on top (as PTN Ninja's): each side's width is its share of top flats, komi hatched in.
    this.el.innerHTML = `<div class="tb" style="--n:${n}"><div class="tb-fc" aria-hidden="true"><div class="tb-f1"><i></i><b></b></div><div class="tb-f2"><i></i><b></b></div></div>` +
      '<div class="tb-board" role="img"></div><div class="tb-tray"></div></div>';
    this.root = this.el.firstChild;
    [this.fcEl, this.boardEl, this.trayEl] = this.root.children;
    this.sqEls = []; this.cache = new Map();
    const order = [];
    for (let dr = n - 1; dr >= 0; dr--) for (let dc = 0; dc < n; dc++) order.push(this._logical(dc, dr));
    for (const sq of order) {
      const r = (sq / n) | 0, c = sq % n, [dc, dr] = this._disp(sq);
      const d = document.createElement('div');
      d.className = 'tb-sq';
      d.dataset.sq = sq;
      d.innerHTML = '<div class="tb-hl tb-cur"></div><div class="tb-hl tb-pl"></div><div class="tb-rd"><i class="m"></i><i class="n"></i><i class="e"></i><i class="s"></i><i class="w"></i></div>' +
        (dc === 0 ? `<span class="tb-lab tb-lr">${this.M[2] ? FILES[c] : r + 1}</span>` : '') + (dr === 0 ? `<span class="tb-lab tb-lc">${this.M[0] ? FILES[c] : r + 1}</span>` : '');
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
    // the shapes' layer: above the pieces, never in the way of a tap (pointer-events: none, board.css)
    this.boardEl.insertAdjacentHTML('beforeend', `<svg class="tb-ov" aria-hidden="true" viewBox="0 0 ${n} ${n}"></svg>`);
    this.ovEl = this.boardEl.lastChild; this._ovHtml = '';
    this._drawShapes();
  }
  _drawShapes() {
    if (!this.ovEl) return;
    const html = this.shapesVisible ? shapesSvg(this.shapesList, this.n, this.M) : '';
    if (html !== this._ovHtml) { this.ovEl.innerHTML = html; this._ovHtml = html; }
  }

  // Coordinates doubled and centred (2i − (n−1)) so every turn and mirror stays in integers.
  _disp(sq) { return dispPoint(sq, this.n, this.M); } // (analysis.js: the shapes are placed with the same maths)
  _logical(dc, dr) {
    const h = this.n - 1, [a, b, c, d] = this.M, X = 2 * dc - h, Y = 2 * dr - h;
    return ((b * X + d * Y + h) / 2) * this.n + (a * X + c * Y + h) / 2;
  }

  _show(i, animate = false, byHand = false) {
    this.cur = i; this.sel = null; this.peekHl = null;
    this._render(animate);
    // A move played or appended at the end of the line (animate): its sound. Loads, jumps and restores are silent, and
    // stop the drops of a move still sounding, unless the position shown is the same (last() after append()).
    const sn = this.snaps[i], key = sn.g.toTPS();
    if (animate && i > 0) Board.onPly?.(sn.ptn, sn.smash, { ...sn.land, ...(byHand ? { byHand: true } : {}) }, this);
    else if (key !== this._shownKey) Board.onCut?.(this);
    this._shownKey = key;
  }

  // The pieces of a stack in hand that have landed since the last call: one sound per input, the moment it lands (a
  // tap, a click, a key). sel.heard is what has sounded, per drop square; a stone taken back off a square (right click)
  // sounds again when it is set down again. Putting stones back on the origin before leaving it is silent, as are
  // picking up and cancelling.
  _landings(sel = this.sel) {
    if (sel?.t !== 'stack' || sel.path.length < 2) return;
    const s = this.snaps[this.cur], o = s.st[sel.path[0]], hand = o.slice(o.length - sel.picked), heard = sel.heard || [], out = [];
    let off = 0;
    sel.drops.forEach((d, j) => {
      const prev = Math.min(heard[j] || 0, d);
      if (d > prev) {
        const grp = hand.slice(off + prev, off + d), top = grp[grp.length - 1], sq = sel.path[j + 1];
        const piece = KIND[s.ty[top]] || 'flat', last = j === sel.drops.length - 1;
        out.push({ piece, onto: prev || s.st[sq].length ? 'piece' : 'board', drop: true, smash: last && sel.flat != null && piece === 'cap' });
      }
      off += d;
    });
    sel.heard = sel.drops.slice();
    if (out.length) Board.onLand?.(out, this);
  }

  // A number key (or `) pressed while the board is briefly busy (the intro, the reply, the reset after a miss) is
  // kept and played once input opens, if that's within 1.5 s.
  _flushKey() {
    const pk = this.pendKey;
    if (!pk || !this._canInput() || this._locked()) return;
    this.pendKey = null;
    if (performance.now() - pk.t < 1500) this._keyCount(pk.k);
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
    if (this._locked()) return;
    if (e.target.closest('.tb-tray')) { if (this.sel?.t === 'tray' || this._unmovedStack()) this.cancel(); return; }
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

  // A stack picked up but not moved yet. One stray tap on your own stone used to freeze the board (no Esc on phones).
  // Now tapping another of your stacks switches to it and tapping the tray puts it down, everywhere; tapping any other
  // square puts it down only with opts.dropOnStray (free analysis). While solving a puzzle such taps stay ignored, since
  // a slipped finger mid-entry would otherwise turn the next intended tap into a different move, i.e. a miss.
  _unmovedStack() { return this.sel?.t === 'stack' && this.sel.path.length === 1; }

  _squareClick(sq, alt) {
    const r = this._squareClick1(sq, alt);
    this._landings();
    return r;
  }
  _squareClick1(sq, alt) {
    if (!this._canInput()) return;
    const v = this._view();
    if (!this._valid(v).has(sq)) {
      if (!this._unmovedStack()) return;
      const held = this.sel;
      this.sel = null;
      if (this.snaps[this.cur].st[sq].length && this._valid(this._view()).has(sq)) return this._squareClick(sq, alt); // another own stack
      if (!this.opts.dropOnStray) { this.sel = held; return; }
      return this._render();
    }
    const s = this.snaps[this.cur], g = s.g, sel = this.sel;
    if (!sel || sel.t === 'tray') {
      if (!s.st[sq].length) {
        // Left: a flat (a cap once flats run out). Right / long press: a cap while you have one, else a wall.
        let type = FLAT;
        if (sel) type = sel.cap ? CAP : sel.wall ? WALL : FLAT;
        else if (g.ply < 2) type = FLAT;
        else if (alt) type = g.caps[g.toMove] ? CAP : WALL;
        else if (!g.stones[g.toMove]) type = CAP;
        return this._commit(g.moveToPTN({ kind: 'p', sq, type }));
      }
      this.sel = { t: 'stack', path: [sq], picked: alt ? 1 : Math.min(this.n, s.st[sq].length), drops: [], dir: null, flat: null };
      return this._render();
    }
    const cur = sel.path.at(-1), moved = sel.path.length > 1;
    let hand = sel.picked - sel.drops.reduce((a, b) => a + b, 0);
    if (sq === cur) {
      if (!moved) {
        // origin: left puts one back, right lifts one more (all lifted already: put the stack down)
        if (!alt) { if (--sel.picked === 0) this.sel = null; }
        else if (sel.picked < Math.min(this.n, s.st[cur].length)) sel.picked++;
        else this.sel = null;
        return this._render();
      }
      // drop square: left drops one more; right takes the last one back, or with one here drops the whole hand
      if (alt) {
        if (sel.drops.at(-1) > 1) { sel.drops[sel.drops.length - 1]--; return this._render(); }
        sel.drops[sel.drops.length - 1] += hand;
        return this._finish();
      }
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

  // ---------- keys ----------
  _onKey(e) {
    if (e.defaultPrevented) return;
    // a key held down since the last puzzle (Enter = Continue held, or a number key) repeats into nothing here
    if (e.repeat && !(this.keysDown.get(e.key) > this.forgotAt)) return;
    if (e.key === 'Escape') { if (this.sel) this.cancel(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || !this.el.getClientRects().length) return; // modified, or the board is hidden
    if (e.target.closest?.('input, select, textarea, [contenteditable]')) return;
    if (e.key in OPS) { e.preventDefault(); return this.orient(e.key); }
    // Enter on a button/link the keyboard focused presses it; one merely left focused by a mouse click doesn't take it
    // (Chrome marks it :focus-visible on any key press, so that can't tell the two apart)
    if (e.key === 'Enter' && e.target.closest?.('a, button, summary') && !focusedByPointer(e.target)) return;
    const k = e.key === 'Enter' ? 'all' : e.key === '`' ? 'own' : /^[1-8]$/.test(e.key) ? +e.key : 0;
    if (!k) return;
    if (k === 'all' && this._locked()) return; // (the second press of a double Enter = Continue)
    if (k !== 'all' && (!this._canInput() || this._locked()) && this.cur === this.snaps.length - 1 && !this.snaps[this.cur].g.result() && this.hover >= 0) {
      this.pendKey = { k, t: performance.now() }; e.preventDefault(); return;
    }
    if (this._keyCount(k)) e.preventDefault();
  }

  // How many of `ids` (bottom first) a key means: k, all of them, or 'own': up to and including the first stone
  // of the mover's colour, so that colour ends on top. 0 = nothing to do.
  _count(k, ids) {
    if (k === 'all') return ids.length;
    if (k !== 'own') return Math.min(k, ids.length);
    const me = this.snaps[this.cur].g.toMove, j = ids.findIndex((id) => this.P.color(id) === me);
    return j + 1;
  }

  // Number keys, Enter and ` (PTN Ninja's hotkeys). They lift from the stack under the pointer, then drop on the
  // square under the pointer until the first drop, then on the next square along the line. Never place a stone.
  _keyCount(k) {
    const r = this._keyCount1(k);
    this._landings();
    return r;
  }
  _keyCount1(k) {
    const sel = this.sel, s = this.snaps[this.cur], g = s.g, n = this.n;
    if (!this._canInput() || this._locked() || sel?.t === 'tray') return false;
    if (!sel) {
      const sq = this.hover, st = s.st[sq];
      if (sq < 0 || !st.length || !this._valid(this._view()).has(sq)) return false;
      const max = Math.min(n, st.length);
      let c = 0;
      if (k === 'own') { for (c = max; c && !(c < st.length && this.P.color(st[st.length - 1 - c]) === g.toMove); c--); }
      else c = k === 'all' ? max : Math.min(k, max);
      if (!c) return false;
      this.sel = { t: 'stack', path: [sq], picked: c, drops: [], dir: null, flat: null };
      this._render();
      return true;
    }
    const o = s.st[sel.path[0]], cur = sel.path.at(-1), moved = sel.path.length > 1;
    const ids = o.slice(o.length - sel.picked).slice(sel.drops.reduce((a, b) => a + b, 0)); // the hand, bottom first
    const tgt = moved ? this._next(cur, sel.dir) : this.hover;
    if (tgt < 0) return false;
    const dropHere = () => { // on the current square (the origin: put stones back)
      const c = this._count(k, ids);
      if (c <= 0) return false;
      if (!moved) { sel.picked -= c; if (!sel.picked) this.sel = null; return this._render(), true; }
      sel.drops[sel.drops.length - 1] += c;
      return (c === ids.length ? this._finish() : this._render()), true;
    };
    if (tgt === cur) return dropHere();
    const dir = Object.keys(STEP).find((d) => this._next(cur, d) === tgt);
    if (!dir || !this._enterable(tgt, s)) return false;
    const top = s.st[tgt].at(-1);
    if (top != null && s.ty[top] === WALL) {
      // a wall ahead: as in PTN Ninja, the key drops here instead (the capstone too, if the count reaches it);
      // once the capstone is alone in hand, it flattens the wall
      if (ids.length > 1) return dropHere();
      this._squareClick(tgt, false);
      return true;
    }
    const c = this._count(k, ids);
    if (!c) return false;
    let hand = ids.length - c;
    sel.path.push(tgt); sel.dir = dir; sel.drops.push(c);
    if (hand > 0) {
      const nx = this._next(tgt, dir);
      if (nx < 0 || !this._enterable(nx, s)) { sel.drops[sel.drops.length - 1] += hand; hand = 0; }
    }
    if (hand === 0) this._finish(); else this._render();
    return true;
  }

  _finish() {
    const sel = this.sel, g = this.snaps[this.cur].g;
    const ptn = g.moveToPTN({ kind: 'm', sq: sel.path[0], dir: sel.dir, drops: sel.drops });
    this._landings(sel); // (the last stones, now: the move is complete and plays nothing more)
    this._commit(ptn, true);
  }

  _commit(ptn, byHand = false) {
    let next;
    try { next = stepSnap(this.snaps[this.cur], this.P, ptn); } catch { this.cancel(); return; }
    // Like PTN Ninja: playing the move that already comes next just steps forward (the rest of the line is
    // kept, so history browsing still works); any other move replaces what followed.
    if (this.snaps[this.cur + 1]?.ptn === next.ptn) next = this.snaps[this.cur + 1];
    else { this.snaps.length = this.cur + 1; this.snaps.push(next); }
    this.hlSquares = [];
    this._show(this.cur + 1, true, byHand);
    this.onMove?.(next.ptn);
  }

  // ---------- drawing ----------
  _set(el, key, val, apply) { if (this.cache.get(el)?.[key] === val) return; let c = this.cache.get(el); if (!c) this.cache.set(el, (c = {})); c[key] = val; apply(val); }

  _render(animate = true) {
    if (!this.root) return;
    // (a task later: the app's own follow-up calls, e.g. last() after append(), would drop the lift)
    if (this.pendKey && this._canInput()) setTimeout(() => this._flushKey());
    const anim = animate && this.opts.animateBoard;
    if (!anim) this.root.classList.add('na');
    const v = this._view(), { s, st, ty } = v, g = s.g, n = this.n, P = this.P;
    this.root.classList.toggle('t2', g.toMove === 2);
    const valid = this._valid(v);
    const res = g.result();
    const roads = this._roads(g, res);
    const who = (c) => (c === 1 ? 'White' : 'Black');
    const f = g.flatCounts(), k = g.komi || 0, kTxt = String(Math.abs(k)).replace(/^0?\.5$/, '½').replace('.5', '½');
    const label = `Tak board, ${res ? (res.winner ? `${who(res.winner)} won` : 'drawn') : `${who(g.toMove)} to move`}. ` +
      `Flats: White ${f[1]}${k < 0 ? ` + ${kTxt} komi` : ''}, Black ${f[2]}${k > 0 ? ` + ${kTxt} komi` : ''}. Position: ${g.toTPS()}`;
    this._set(this.boardEl, 'l', label, (x) => this.boardEl.setAttribute('aria-label', x));

    // flat-count bar
    const w1 = f[1] + Math.max(0, -k), w2 = f[2] + Math.max(0, k), tot = w1 + w2;
    const pct = tot ? Math.min(88, Math.max(12, (100 * w1) / tot)) : 50;
    const [s1, s2] = this.fcEl.children;
    this._set(this.fcEl, 'tm', turnMark(g), (x) => { this.fcEl.className = 'tb-fc' + (x ? ' tm' + x : ''); });
    this._set(s1, 'w', pct, (x) => { s1.style.width = x + '%'; });
    this._set(s2, 'w', 100 - pct, (x) => { s2.style.width = x + '%'; });
    [[s1, f[1], -k, w1], [s2, f[2], k, w2]].forEach(([el, flats, km, w]) => {
      const t = flats + (km > 0 ? ' +' + kTxt : ''), hatch = km > 0 && w ? (100 * km) / w : 0;
      this._set(el.lastChild, 't', t, (x) => { el.lastChild.textContent = x; });
      this._set(el.firstChild, 'w', hatch, (x) => { el.firstChild.style.width = x + '%'; });
    });

    // squares
    const hl = this.peekHl || (this.cur > 0 ? s.hl : null);
    const selSqs = this.sel?.t === 'stack' ? this.sel.path : [];
    for (let sq = 0; sq < n * n; sq++) {
      const top = g.top(sq);
      let cls = 'tb-sq';
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
      for (let z = 0; z < len; z++) {
        const id = stack[z], wall = ty[id] === WALL, { y, imm, ov, z: zi } = stackPiece(len, z, n, wall, v.lifted.has(id));
        onBoard.add(id);
        this._piece(id, dc * 100, -(dr * 100 + y), zi,
          (wall ? ' S' : ty[id] === CAP ? ' C' : '') + (imm ? ' im' : '') + (ov ? ' ov' : '') + (id === v.first ? ' fs' : ''));
      }
      if (sq === this.hover || selSqs.includes(sq)) counts.set(stack[len - 1], len);
    }
    if (v.cnt) counts.set(st[v.cnt[0]].at(-1), v.cnt[1]);

    // tray
    const canPick = this._canInput() && (!this.sel || this.sel.t === 'tray' || this._unmovedStack());
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

    this._drawShapes();
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
      // display side k (n, e, s, w) shows logical side ord[k]
      const ord = [];
      [[0, 1], [1, 0], [0, -1], [-1, 0]].forEach(([x, y], i) => {
        const [a, b, c, d] = this.M, X = a * x + b * y, Y = c * x + d * y;
        ord[Y === 1 ? 0 : X === 1 ? 1 : Y === -1 ? 2 : 3] = i;
      });
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

