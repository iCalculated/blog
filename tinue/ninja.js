// Opt-in board (?board=ninja): PTN Ninja (ptn.ninja) in an iframe, driven over postMessage the way PlayTak
// embeds it. Same API as Board (board.js), so app.js doesn't care which one it has. Only loaded via import()
// when the flag is set: everyone else fetches nothing from here or from ptn.ninja.
// PTN Ninja's embed API: https://github.com/gruppler/PTN-Ninja#api
import { Game } from './shared/tak.js?v=1795367575';
import { parsePTN } from './shared/ptn.js?v=1795367575';
import { Board, buildPTN, focusedByPointer, landOf } from './board.js?v=1795367575';
import { frameParams, lookUi, frameBox, frameGeom } from './ninja-look.js?v=1795367575';

const ORIGIN = 'https://ptn.ninja';
// tinue's palette as a PTN Ninja theme (the schema of its built-in "classic" theme, which PlayTak uses). The board as
// near tinue's own felt board (board.css) as the format goes: not checkered, PTN Ninja's grid1 (one board1 field ruled
// in board2 lines: the cloth and its thread), no rings, board.css's stone colours. What it can't carry: the weave, the
// stitches' dashes, the stones' proportions, and a last move drawn as a line: PTN Ninja fills the square with primary,
// so primary is the thread's straw, which also draws its turn indicator (on Black's half of its bar; on White's cream
// it is faint, a limit of the one colour).
const THEME = {
  id: 'tinue', name: 'tinue', boardStyle: 'grid1', boardChecker: false, rings: 0,
  vars: { 'piece-border-width': 1 },
  colors: {
    primary: '#e3d3a1', secondary: '#161512', ui: '#262421', accent: '#302e2c', panel: '#262421c0',
    board1: '#4a6761', board2: '#8fa9a1', board3: '#344b46',
    player1: '#ece7db', player1road: '#ece7db', player1flat: '#ece7db', player1special: '#f5f1e8', player1border: '#9a948a',
    player2: '#151b1a', player2road: '#121817', player2flat: '#151b1a', player2special: '#1d2524', player2border: '#5f6b67',
    textLight: '#ece7dbcc', textDark: '#1a2120cc', umbra: '#0000004d',
  },
};
// PlayTak's embed settings, but with PTN Ninja's own turn indicator + flat-count bar (Shy: use the built-in one).
// index.html starts the iframe with these in its URL (keep the two in step); they're sent again over postMessage
// once PTN Ninja is up, since Firefox doesn't reliably apply URL settings and the theme only goes that way.
const UI = {
  theme: THEME, moveNumber: false, unplayedPieces: true, disableStoneCycling: true, showBoardPrefsBtn: false,
  disableNavigation: true, disablePTN: true, disableText: true, flatCounts: true, turnIndicator: true,
  gameTimer: false, showHeader: false, showEval: false, showRoads: false, stackCounts: false, notifyGame: false,
  disableUndo: true, showPTN: false, showText: false, showControls: false, showScrubber: false, animateBoard: true,
  showBoardTransformBtn: false, // (as by default; tinue turns the board with its own keys, kept per browser)
};
// PTN Ninja reads URL settings from the path as /&key=value (not a ?query, which it ignores)
const PARAMS = '&' + Object.entries(UI).filter(([k]) => k !== 'theme').map(([k, v]) => `${k}=${v}`).join('&');
// The player's own PTN Ninja look (Settings page, ninja-look.js): its settings over these, its theme (if it has one)
// instead of tinue's. Without one, exactly tinue's. Those of UI's keys a look can change, for putting back when it goes.
const LOOK_BASE = { axisLabels: true, axisLabelsSmall: true, board3D: false, orthographic: false, perspective: 5, centerStackCounts: false, flatWinHighlights: true, verticalLayout: true, verticalLayoutAuto: true }; // PTN Ninja's own defaults (its src/store/ui/state.js)
// Every look key goes out at start, PTN Ninja's default under the player's look: a frame can carry a look tinue never
// asked for (a 3D board seen after an earlier look was cleared), and a key left out keeps it.
const withLook = (look) => ({ ...LOOK_BASE, ...UI, ...look });
// The frame asks for no permissions: PTN Ninja shows its fullscreen button only when it may go fullscreen (so it is gone),
// and nothing of its embed that tinue shows copies to the clipboard (that is its share and notes panels, all off here).
const FRAME_CSS = 'display:block;border:0;background:#262421;';
const OLD_SHAPE = { host: '', frame: 'width:100%;aspect-ratio:1/1.3' }; // a 3D board: the whole frame shown
// tinue's orientation keys, for when focus is on the page rather than inside the iframe (PTN Ninja's own hotkeys
// handle them there).
const TRANSFORM = { '[': 'ROTATE_LEFT', ']': 'ROTATE_RIGHT', '-': 'ROTATE_180', ';': 'FLIP_HORIZONTAL', ':': 'FLIP_VERTICAL', '=': 'RESET_TRANSFORM' };
// No PTN Ninja by then (blocked, offline, down, or a slow first visit): tinue's own board takes its place, so nobody
// looks at an empty box for long. A cached PTN Ninja is up in ~0.1 s, a first visit on a desktop in ~0.5 s and on the
// benchmark's slow phone in ~2 s. The time counts from when the frame started (index.html's data-t0), not from when
// this module got going, which on a slow phone is already ~2.5 s in.
// If it comes up later after all, it takes over at the next puzzle (load()), never in
// the middle of one: a move begun on tinue's board is never lost to a swap.
// (The other way, tinue's board at once and PTN Ninja swapped in when up, was not taken: on every visit, warm ones too,
// the player would see one board, then another, and a swap mid-puzzle would have to carry a move half made.)
const FALLBACK_MS = 2500;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('tinue.' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('tinue.' + k, JSON.stringify(v)); } catch {} },
};

const OWN = new Set(['load', 'destroy', 'forget']);
// After a load: how long to wait at most for PTN Ninja to say it has drawn it (its GAME_STATE), and how long its board
// must have kept its size before the frame is first shown. (Before, a fixed 60 ms and then 250 ms.)
const DRAW_MS = 100, QUIET_MS = 40;
const frames = () => new Promise((r) => { const t = setTimeout(r, 50); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(); })); }); // (two frames; a hidden tab has none)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ---------- Rush on this frame (borrow) ----------
// The page has one PTN Ninja frame, the puzzle page's (index.html starts it in #board). Rush borrows it (lend(): a second
// NinjaBoard on the same iframe), rather than loading ptn.ninja again: a second frame costs another cold load and
// ~350 MB. The iframe never moves in the page (moving an iframe reloads it): while Rush has it, the puzzle page stays laid
// out but out of sight (style.css .lend; display:none would stop the frame drawing) and the iframe is laid over Rush's own
// board, which stays underneath, out of sight (.lent): the frame's box is tinue's board's box at every window size, and
// tinue's board is there to take over at once. One NinjaBoard at a time owns the frame (iframe.ninjaOwner): only it posts
// and hears moves; the other keeps track of its calls and puts its position back when it gets the frame again.
// READY_MS: Start waits this long at most for PTN Ninja to be up (then the run is on tinue's board). PTN Ninja sends
// nothing on its own while nothing changes, so a borrowed frame is asked for its theme (GET_THEME, answered in ~2 ms)
// every HEART_MS, and after every load its GAME_STATE is waited for: no answer within DEAD_MS and tinue's board takes
// over for the rest of the run, in the same position (the frame may have crashed, or hung).
const RUSH_MS = { ready: 6000, heart: 500, dead: 1000 }; // READY_MS, HEART_MS, DEAD_MS (NinjaBoard.RUSH_MS: tests shorten them)
// PTN Ninja's boardTransform [turns, flip] as tinue's orientation matrix (board.js M), read off PTN Ninja's own board
// (where its a1, b1 and a2 squares are drawn under each of the eight; 2026-11-22).
const TRANSFORM_M = { '0,0': [1, 0, 0, 1], '0,1': [-1, 0, 0, 1], '1,0': [0, 1, -1, 0], '1,1': [0, -1, -1, 0],
  '2,0': [-1, 0, 0, -1], '2,1': [1, 0, 0, -1], '3,0': [0, -1, 1, 0], '3,1': [0, 1, 1, 0] };

export class NinjaBoard {
  static FALLBACK_MS = FALLBACK_MS; // (tests shorten it)
  static RUSH_MS = RUSH_MS;
  // look: the stored PTN Ninja look (prefs.ninja); index.html started the iframe with the same one in its address.
  // lender, under, onDead: a borrower (lend()).
  constructor(el, { onMove, look = '', lender = null, under = null, onDead = null } = {}) {
    this.el = el; this.onMove = onMove; this.look = lookUi(look);
    this.opts = { disableBoard: false, showRoads: false, animateBoard: true, dropOnStray: false };
    this.lockUntil = 0;
    this.games = [new Game(5)]; this.snaps = [{}]; this.cur = 0; this.peeking = false;
    this.ptn = null; this.player = null; this.hl = [];
    if (lender) return this._borrower(lender, under, onDead);
    // index.html usually started the iframe already (before the page's modules loaded); otherwise start it now
    let f = el.querySelector('iframe');
    if (!f) { f = document.createElement('iframe'); f.src = ORIGIN + '/' + frameParams(PARAMS, look); f.style.opacity = '0'; f.dataset.t0 = performance.now(); el.replaceChildren(f); }
    this.iframe = f;
    f.title = 'Tak board (PTN Ninja)';
    this._shape(6);
    this.ready = new Promise((resolve) => { this._resolve = resolve; });
    const spent = performance.now() - (+f.dataset.t0 || performance.now());
    this._failTimer = setTimeout(() => this._fallback(), Math.max(0, NinjaBoard.FALLBACK_MS - spent));
    // PTN Ninja is up (its game exists) once it posts GAME_STATE, which it does once at boot. That can happen before
    // this module has even loaded: index.html starts the iframe early and a cached PTN Ninja boots in ~0.3 s, so
    // index.html notes that first GAME_STATE on that frame (data-up). It is the frame's own: a board that made its
    // frame here (a second board, Rush's) waits for its own GAME_STATE. (Anything sooner isn't safe: PTN Ninja answers
    // messages before its game exists, and a game sent then throws.)
    if (f.dataset.up) queueMicrotask(() => this._up());
    // (every listener and timer of this board is let go by destroy())
    this._offs = [];
    const on = (t, type, fn) => { t.addEventListener(type, fn); this._offs.push(() => t.removeEventListener(type, fn)); };
    on(window, 'message', (e) => {
      if (e.source !== f.contentWindow) return;
      const { action, value } = e.data || {};
      if (this.fb) { if (action === 'GAME_STATE') this.lateUp = true; return; } // (it takes over at the next puzzle)
      if (action === 'GAME_STATE') this._up();
      if (this._owns()) this._heard(action, value); // (lent to Rush: the moves are Rush's)
    });
    on(window, 'keydown', (e) => this._key(e));
    // Callers hold this object; after a fallback every call goes to tinue's own board instead (but load, which may hand
    // the board back to PTN Ninja, and destroy).
    return new Proxy(this, {
      get: (t, k) => { const o = t.fb && k in t.fb && !OWN.has(k) ? t.fb : t; const v = o[k]; return typeof v === 'function' ? v.bind(o) : v; },
    });
  }

  // What PTN Ninja says, to the board that owns the frame.
  _heard(action, value) {
    if (action === 'GAME_STATE') {
      const tps = String(value?.tps).split(' ')[0];
      if (this._want && tps === this._want.tps) this._want.fire();
      // (PTN Ninja's word that it has the last position loaded, however late it comes: a borrower's load waits on it up
      // to DEAD_MS, long after DRAW_MS has let _want go)
      if (this._seenFor && tps === this._seenFor.tps) { this._seenFor.seen(); this._seenFor = null; }
    }
    else if (action === 'SET_UI' && value?.boardSize) this.resizedAt = performance.now();
    else if (action === 'SET_UI' && value?.boardTransform) store.set('ninjaTransform', value.boardTransform); // kept per browser
    else if (action === 'INSERT_PLY') this._played(typeof value === 'string' ? value : value?.ptn ?? value?.text);
    else if (action === 'UNHANDLED_KEY' && value?.key) {
      // keys PTN Ninja didn't use (arrows etc. with its navigation off) work as if pressed on the page
      const { key, code, shiftKey, ctrlKey, altKey, metaKey } = value;
      window.dispatchEvent(new KeyboardEvent('keydown', { key, code, shiftKey, ctrlKey, altKey, metaKey, bubbles: true, cancelable: true }));
    }
  }
  _key(e) {
    if (this.fb || !this._owns() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !(e.key in TRANSFORM)) return;
    // a board out of sight (the puzzle page's while Rush is on screen) leaves the key to the board in sight, as Board does
    if (!this.el.getClientRects().length || e.target.closest?.('input, select, textarea, [contenteditable]')) return;
    e.preventDefault(); this._send(TRANSFORM[e.key]);
  }
  // Whether this board has the frame: the puzzle page's unless Rush has borrowed it.
  _owns() { const o = this.iframe.ninjaOwner; return this.lender ? o === this : !o || o === this; }
  // (app.js: a board out of sight makes no sound; the puzzle page's is laid out under Rush while Rush has its frame)
  get away() { return !this._owns(); }

  // The frame cut to PTN Ninja's board (ninja-look.js frameBox): squares as big as tinue's board's.
  _shape(size) {
    if (this.lender) return this._place();
    if (this.fb || !this._owns()) return;
    const b = frameBox(this.look, size) || OLD_SHAPE, f = this.iframe;
    if (b.frame === this.shapeCss) return;
    this.shapeCss = b.frame;
    // (the host's own other styles kept: Rush's board host, say)
    Object.assign(this.el.style, { borderRadius: 'var(--corner,6px)', background: '#262421', aspectRatio: b.ratio ? String(b.ratio) : '', overflow: b.ratio ? 'hidden' : '' });
    f.style.cssText = FRAME_CSS + b.frame + ';opacity:' + (f.style.opacity || '0') + ';transition:opacity .15s';
  }

  _up() {
    this.iframe.dataset.up = '1'; // (for a borrower: lend())
    if (!this._resolve || this.fb || this.dead) return;
    clearTimeout(this._failTimer);
    this._greet();
    this._resolve(); this._resolve = null;
    if (!this._want) this._settle(250);
  }
  // tinue's settings and the player's look (tinue shows names nowhere else on the board, and they crowd the flat counts)
  _greet() {
    this._post('SET_UI', { ...withLook(this.look), boardTransform: store.get('ninjaTransform') || [0, 0] });
    this._post('SHOW_NAMES', false);
  }

  // A new look from the Settings page (or the account): what the old one set and the new one doesn't goes back to
  // tinue's (or PTN Ninja's own default), the rest is the new one's. A page about to be shown waits for PTN Ninja anyway.
  setLook(stored) {
    const prev = this.look, look = this.look = lookUi(stored), out = {};
    this._shape(this.games[0].size);
    for (const k of Object.keys(prev)) if (!(k in look)) out[k] = k in UI ? UI[k] : LOOK_BASE[k];
    Object.assign(out, look);
    return Object.keys(out).length ? this._send('SET_UI', out) : this.ready;
  }

  // PTN Ninja's hotkeys (number keys, Enter, `) only work while its iframe has keyboard focus, so a puzzle that
  // becomes playable gets it, unless the player has focus somewhere on purpose (a field, a button reached by
  // keyboard). Once the puzzle is over (exploring, or the board off) the page takes it back, so Enter = Continue.
  _focus(on) {
    if (this.fb || !this._owns()) return;
    const a = document.activeElement, f = this.iframe;
    if (!on) { if (a === f) f.blur(); return; }
    if (!matchMedia('(any-pointer: fine)').matches) return; // phones: nothing to type with
    if (a === f || !(a == null || a === document.body || (focusedByPointer(a) && a.closest('button, a, summary')))) return;
    this.ready.then(() => { if (!this.fb && !this.opts.disableBoard && !this.opts.dropOnStray) f.focus({ preventScroll: true }); });
  }

  // ---------- messaging ----------
  // (a frame taken out of the page has no window: nothing goes; a borrower's heartbeat finds it dead)
  _post(action, value) { if (!this.fb && !this.dead && this._owns()) this.iframe.contentWindow?.postMessage(value === undefined ? { action } : { action, value }, ORIGIN); }
  async _send(action, value) { await this.ready; this._post(action, value); }

  // Show the iframe only once PTN Ninja has drawn what tinue last loaded (_afterDraw) and stopped resizing (it posts
  // its board's size as it changes): no white page, no board jumping size. Up with nothing loaded yet: shown after
  // 250 ms, empty.
  _settle(ms = 0) {
    if (this.shown) return;
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      if (this._resolve || this.fb || this.dead || this.shown || !this._owns()) return;
      const still = performance.now() - (this.resizedAt ?? -Infinity);
      if (still < QUIET_MS) return this._settle(QUIET_MS - still);
      this.shown = true;
      requestAnimationFrame(() => { this.iframe.style.opacity = '1'; });
    }, ms);
  }
  // A load has been sent: once PTN Ninja posts the GAME_STATE of the position it ends on (it posts one as it redraws),
  // or after DRAW_MS whatever it says, and two frames later, its animation goes back on (on any sooner, the whole game
  // would fly in) and the frame may be shown. load() doesn't wait for this; a move appended meanwhile does (append).
  _afterDraw(tps) {
    const gen = this.drawGen = (this.drawGen || 0) + 1;
    let fire, seen;
    const drawn = new Promise((r) => { fire = r; });
    // (PTN Ninja's own word that it has it: a borrower waits for it. Kept apart from _want, which DRAW_MS lets go; a later
    // load's position replaces it, and the earlier wait counts as answered: the later load has its own.)
    this._seenFor?.seen();
    this.seen = new Promise((r) => { seen = r; });
    this._seenFor = { tps: tps.split(' ')[0], seen };
    this._want = { tps: tps.split(' ')[0], fire };
    clearTimeout(this._animT); this._animT = setTimeout(fire, DRAW_MS);
    this._drawn = drawn.then(frames).then(() => {
      if (gen !== this.drawGen || this.dead) return; // (a later load's turn)
      this._want = null; clearTimeout(this._animT);
      this._post('SET_UI', { animateBoard: this.opts.animateBoard });
      this._settle();
    });
  }

  // PTN Ninja isn't up in time: put tinue's own board in its place, in the same state, and hand it every call. The
  // frame stays, out of sight (moving or dropping it would reload it), in case PTN Ninja comes up after all.
  async _fallback() {
    if (this.fb || !this._resolve || this.dead) return;
    await this._toTinue(this.ptn);
    this._resolve(); this._resolve = null; // calls already waiting on PTN Ninja go nowhere now
  }
  // tinue's board in the frame's place, in this board's state. ptn: the position (default: its tracked line, at its ply)
  async _toTinue(ptn) {
    if (!ptn && this.headers) {
      const h = this.headers;
      ptn = buildPTN({ size: +h.Size || this.games[0].size, komi: +(h.Komi || 0), tps: h.TPS || null,
        moves: this.snaps.slice(1).map((x) => x.ptn), white: h.Player1 || 'White', black: h.Player2 || 'Black' });
    }
    Object.assign(this.el.style, { borderRadius: '', background: '', aspectRatio: '', overflow: '', position: 'relative' }); // (no placeholder or cut any more)
    this.iframe.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;border:0;visibility:hidden;pointer-events:none;opacity:0';
    this.iframe.tabIndex = -1; this.shapeCss = null; this.shown = false;
    const host = this.fbHost = document.createElement('div');
    host.className = 'board-host';
    this.el.append(host);
    const fb = new Board(host, { onMove: this.onMove });
    this.fb = fb;
    console.warn(this._resolve ? 'PTN Ninja did not load in time; using tinue\'s board' : 'PTN Ninja is not answering; using tinue\'s board');
    await fb.ui(this.opts);
    if (this.player != null) await fb.setPlayer(this.player);
    if (ptn) { await fb.load(ptn); await fb.goTo(this.cur - 1); }
    if (this.hl.length) await fb.highlight(this.hl);
  }

  // Done with this board (another page takes its place): its listeners and timers go, and its frame with them (a
  // PTN Ninja frame costs memory). Calls after this do nothing. tinue's own board in its place after a fallback has no
  // destroy of its own: its element goes, and a board out of the page takes no keys or clicks.
  destroy() {
    if (this.dead) return;
    this.dead = true;
    for (const off of this._offs) off();
    for (const t of [this._failTimer, this._settleTimer, this._lockT, this._animT]) clearTimeout(t);
    this.iframe.remove(); this.fbHost?.remove();
    this._resolve?.(); this._resolve = null; // (calls waiting on PTN Ninja go nowhere)
  }

  // PTN Ninja came up late: it takes the board back from tinue's (between puzzles: load()), with tinue's board's
  // settings. tinue's board goes with its element (a board out of the page takes no keys or clicks).
  _takeBack() {
    const fb = this.fb;
    this.fb = null; this.fbHost.remove(); this.fbHost = null;
    Object.assign(this.opts, fb.opts); this.player = fb.player; this.lockUntil = fb.lockUntil; this.hl = [];
    this.iframe.removeAttribute('tabindex');
    this._shape(6);
    this._greet();
    this._post('SET_UI', { disableBoard: this._gated(), showRoads: this.opts.showRoads });
    if (this.player != null) this._post('SET_PLAYER', this.player);
    console.warn('PTN Ninja is up: back to it');
  }

  // ---------- what the board shows (tracked here, since PTN Ninja doesn't report it) ----------
  get g() { return this.games[this.cur]; }
  get holding() { return false; } // PTN Ninja doesn't say whether stones are in hand
  _canon(g, ptn) { try { const mv = g.parseMove(ptn); return g.isLegal(mv) ? g.moveToPTN(mv) : null; } catch { return null; } }
  // (land: what the move sets down, for its sound: board.js landOf, read off the position before it)
  _push(ptn) { const g = this.games.at(-1).clone(), mv = g.parseMove(ptn), land = landOf(g, mv), u = g.apply(mv); this.games.push(g); this.snaps.push({ ptn, smash: u.smashed, land }); }
  // A move made on PTN Ninja's board (or typed): like Board's _commit, the next move in line just steps forward.
  _played(ptn) {
    const canon = ptn && this._canon(this.g, ptn);
    if (!canon) return;
    const next = this.snaps[this.cur + 1]?.ptn;
    if (next !== canon) { this.games.length = this.snaps.length = this.cur + 1; this._push(canon); }
    this.cur++; this.peeking = false;
    // (as Board's _commit: the move's sound. PTN Ninja reports only finished moves, so a stack moved by hand there sounds
    // as a whole when it is complete: its drops in a row, as a reply's would)
    Board.onPly?.(canon, this.snaps[this.cur].smash, this.snaps[this.cur].land, this);
    // A different move mid-line: PTN Ninja made it a branch, so its ply numbers no longer match ours (stepping back
    // would show the old line). Give it the line as tinue has it, one straight line, at the same spot.
    if (next && next !== canon) this._relinearize();
    this.highlight([]); // like Board: a played move clears hint squares
    this.onMove?.(canon);
  }

  _relinearize() {
    const h = this.headers || {};
    const ptn = buildPTN({ size: +h.Size || this.games[0].size, komi: +(h.Komi || 0), tps: h.TPS || null,
      moves: this.snaps.slice(1).map((s) => s.ptn), white: h.Player1 || 'White', black: h.Player2 || 'Black' });
    this.ptn = ptn;
    this._post('SET_UI', { animateBoard: false });
    this._post('SET_CURRENT_PTN', ptn);
    this._post('GO_TO_PLY', { plyID: this.cur - 1, isDone: true });
    setTimeout(() => this._post('SET_UI', { animateBoard: this.opts.animateBoard }), 60);
  }

  // ---------- Board API ----------
  async load(ptn) {
    const { headers, moves } = parsePTN(ptn);
    // tinue's board in PTN Ninja's place: PTN Ninja takes over now if it came up since, and this is another puzzle with
    // no stones in tinue's board's hand. "Another puzzle" is the caller's word (forget() just before), not the start
    // position: a puzzle with game history loads from the game's start, the same for every 6×6 one.
    const between = this.between; this.between = false;
    if (this.fb) {
      if (!(this.lateUp && between && !this.fb.holding)) return this.fb.load(ptn);
      this._takeBack();
    }
    const komi = +(headers.Komi || 0);
    const g = headers.TPS ? Game.fromTPS(headers.TPS, komi) : new Game(+headers.Size || 5);
    g.komi = komi;
    // (another position shown: as Board's load, which compares what it shows. The same PTN can be another position: a
    // move made here since the last load (a spread on PTN Ninja, cancelled by Confirm moves) is not in it.)
    const was = this.games?.[this.cur]?.toTPS?.();
    this.games = [g]; this.snaps = [{}]; this.ptn = ptn; this.headers = headers;
    this._shape(g.size);
    for (const m of moves) { const c = this._canon(this.games.at(-1), m); if (!c) break; this._push(c); }
    this.cur = this.snaps.length - 1; this.peeking = false;
    if (this.games[this.cur].toTPS() !== was) Board.onCut?.(this);
    // without PTN Ninja's fly-in animation for the whole game
    await this._send('SET_UI', { animateBoard: false });
    this._post('HIGHLIGHT_SQUARES', []); this.hl = []; this.shapeKey = null; // (a hint's squares go with the old line)
    this._post('SET_CURRENT_PTN', ptn);
    this._post('LAST');
    this._afterDraw(this.games[this.cur].toTPS());
    if (this.lender) await this._answered(this.seen, performance.now()); // (the position is on PTN Ninja's board, or tinue's)
  }
  async append(ply) {
    const c = this._canon(this.games.at(-1), ply);
    if (!c) return;
    const atEnd = this.cur === this.snaps.length - 1;
    this._push(c); this.cur = this.snaps.length - 1; this.peeking = false;
    if (atEnd) Board.onPly?.(c, this.snaps[this.cur].smash, this.snaps[this.cur].land, this); // (as Board's append: silent while browsing back)
    await this._drawn; // (animated, so not before the load's animation is back on)
    await this._send('APPEND_PLY', c);
  }
  // (a jump to another ply stops a move's drops still sounding, as Board's _show does)
  _jump(i) { if (i !== this.cur) Board.onCut?.(this); this.cur = i; this.peeking = false; }
  goTo(plyID) { this._jump(Math.max(0, Math.min(this.snaps.length - 1, plyID + 1))); return this._send('GO_TO_PLY', { plyID: this.cur - 1, isDone: true }); }
  first() { this._jump(0); return this._send('FIRST'); }
  last() { this._jump(this.snaps.length - 1); return this._send('LAST'); }
  // Half-step: the position before the next move, that move's squares highlighted (PTN Ninja's not-done ply).
  peek() { if (!this.snaps[this.cur + 1]) return false; this.peeking = true; this._send('GO_TO_PLY', { plyID: this.cur, isDone: false }); return true; }
  setPlayer(p) { this.player = p; return this._send('SET_PLAYER', p); }
  ui(v = {}) {
    Object.assign(this.opts, v);
    const out = {};
    for (const k of ['showRoads', 'animateBoard']) if (k in v) out[k] = v[k];
    if ('disableBoard' in v) out.disableBoard = this._gated();
    if ('disableBoard' in v || 'dropOnStray' in v) this._focus(!this._gated() && !this.opts.dropOnStray);
    return Object.keys(out).length ? this._send('SET_UI', out) : this.ready;
  }
  // Whether PTN Ninja's board is off: while tinue has it off, and through a lock (a new puzzle's first moments: PTN
  // Ninja's taps never reach the page, so its board is simply off then). A lock that runs out turns it back on, as
  // ui() would; lock(Infinity) holds until the next lock().
  _gated() {
    clearTimeout(this._lockT);
    const wait = this.lockUntil - performance.now();
    if (this.opts.disableBoard || !(wait > 0)) return this.opts.disableBoard;
    if (wait < Infinity) this._lockT = setTimeout(() => { if (!this.opts.disableBoard) this.ui({ disableBoard: false }); }, wait + 1);
    return true;
  }
  highlight(squares = []) { this.hl = squares || []; this.shapeKey = null; return this._send('HIGHLIGHT_SQUARES', this.hl); }
  // The analysis page's shapes (Board's shapes): PTN Ninja's embed has no arrows or rings, so line 1's squares are
  // highlighted instead (only while no hint is shown), and nothing else. An empty list clears them.
  shapes(list = []) {
    if (this.hl.length) return this.ready;
    const sqs = (list || []).find((x) => x.role === 'best')?.sqs || [], key = sqs.join(' ');
    if (key === (this.shapeKey ?? '')) return this.ready;
    this.shapeKey = key;
    return this._send('HIGHLIGHT_SQUARES', sqs);
  }
  cancel() { return this._send('CANCEL_MOVE'); }
  // Another puzzle (Board's forget): a move half-entered on PTN Ninja's board is dropped. Its taps and keys never reach
  // the page, so nothing else of it can be held here; the new position (SET_CURRENT_PTN) follows anyway.
  // It also marks the next load as another puzzle's, where PTN Ninja, up late, may take over from tinue's board.
  forget() { this.between = true; return this.fb ? this.fb.forget() : this.cancel(); }
  // Board's lock: here the board is off until then (_gated), as it is during an intro; a lock already past turns it
  // back on. A move typed meanwhile still reaches app.js, whose tooSoon drops it.
  lock(until) { this.lockUntil = until; return this.ui({ disableBoard: this.opts.disableBoard }); }
  // A typed move: checked here, then played on PTN Ninja's board, which reports it back like a click.
  play(ptn) {
    // the same checks as Board's _canInput: input on, the mover's turn, game not over
    if (this.opts.disableBoard || (this.player != null && this.player !== this.g.toMove) || this.g.result()) return false;
    const c = this._canon(this.g, ptn);
    if (!c) return false;
    this._send('INSERT_PLY', c);
    return true;
  }

  // ---------- lending the frame to Rush (see READY_MS above) ----------
  // A board on el (Rush's #rush-board) that plays on this frame while it has borrowed it, and is tinue's board `under`
  // (already in el, which keeps its size) the rest of the time: every call goes to `under` until borrow(), and again after
  // giveBack() or once PTN Ninja stops answering (onDead(ms): how long the run waited on it).
  lend(el, { onMove, under, onDead } = {}) { return new NinjaBoard(el, { onMove, under, onDead, lender: this }); }

  _borrower(lender, under, onDead) {
    this.lender = lender; this.under = under; this.onDead = onDead; this.fb = under; // (idle: tinue's board)
    const f = this.iframe = lender.iframe;
    this.ready = Promise.resolve();
    this._offs = [];
    const on = (t, type, fn) => { t.addEventListener(type, fn); this._offs.push(() => t.removeEventListener(type, fn)); };
    on(window, 'message', (e) => {
      if (e.source !== f.contentWindow) return;
      const { action, value } = e.data || {};
      if (action === 'GAME_STATE') { f.dataset.up = '1'; this._upWait?.(); }
      if (action === 'GET_THEME') this._pong?.();
      if (!this.fb && this._owns()) this._heard(action, value);
    });
    on(window, 'keydown', (e) => this._key(e));
    return new Proxy(this, {
      get: (t, k) => { const o = t.fb && k in t.fb && !OWN.has(k) ? t.fb : t; const v = o[k]; return typeof v === 'function' ? v.bind(o) : v; },
    });
  }
  // Whether the frame can be used: up (waiting up to READY_MS for it, once: a frame that never came up costs the wait one
  // Start only) and answering. Rush's Start waits for this, so its clock never runs while the board isn't playable.
  get frameUp() { return !!this.iframe.dataset.up && !this.iframe.dataset.dead; }
  async frameReady(ms = NinjaBoard.RUSH_MS.ready) {
    const f = this.iframe;
    if (this.dead || f.dataset.dead || !f.isConnected) return false;
    if (!f.dataset.up && !this.waited) {
      await new Promise((r) => { const t = setTimeout(r, ms); this._upWait = () => { clearTimeout(t); r(); }; });
      this._upWait = null;
      if (!f.dataset.up) { this.waited = true; console.warn('PTN Ninja is not up: Rush on tinue\'s board'); }
    }
    if (!f.dataset.up) return false;
    if (await this._ping()) return true;
    f.dataset.dead = '1'; console.warn('PTN Ninja is not answering: Rush on tinue\'s board');
    return false;
  }
  // GET_THEME, which PTN Ninja answers at once whatever it is showing: true if it did within DEAD_MS.
  _ping() {
    return new Promise((r) => {
      const t = setTimeout(() => { this._pong = null; r(false); }, NinjaBoard.RUSH_MS.dead);
      this._pong = () => { clearTimeout(t); this._pong = null; r(true); };
      // (a frame taken out of the page: no answer, so dead after DEAD_MS like a hung one)
      try { this.iframe.contentWindow?.postMessage({ action: 'GET_THEME' }, ORIGIN); } catch {}
    });
  }
  // The run starts on the frame: laid over tinue's board, which hides under it, with tinue's board's settings. size: the
  // run's board size, which tinue's board takes now (empty) if it shows another: its box, which the frame fills, is that
  // of a board of the size played.
  borrow(size = 6) {
    if (this.fb !== this.under || this.dead || !this.frameUp) return false;
    const f = this.iframe, u = this.under, L = this.lender;
    if (u.snaps?.[u.cur]?.g?.size !== size) u.load(buildPTN({ size, komi: 0, moves: [] }));
    f.ninjaOwner = this; this.fb = null;
    Object.assign(this.opts, u.opts); this.player = u.player; this.lockUntil = u.lockUntil; this.hl = [];
    this.look = L.look; this.shown = false; this.dimmed = false; this.placed = null;
    L.el.closest('main')?.classList.add('lend');
    this.el.classList.add('lent');
    this._place();
    const again = () => this._place();
    this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null;
    for (const x of [this.el, document.body]) this._ro?.observe(x);
    addEventListener('resize', again); this._unresize = () => removeEventListener('resize', again);
    this._greet();
    this._post('SET_UI', { disableBoard: this._gated(), showRoads: this.opts.showRoads, animateBoard: false });
    if (this.player != null) this._post('SET_PLAYER', this.player);
    this._beat();
    return true;
  }
  // Over tinue's board (this.el), in the document's own coordinates (index.html's #board and its wrap are made static
  // while lent, style.css .lend, so the frame is placed against the page and scrolls with it): PTN Ninja's board, as
  // frameBox cuts it on the puzzle page, as large as fits in tinue's board's box and centred there; the frame clipped
  // to that box, corners and all.
  _place() {
    if (this.fb || !this._owns()) return;
    const r = this.el.getBoundingClientRect();
    if (!r.width) return;
    const W = r.width, H = r.height, X = r.left + scrollX, Y = r.top + scrollY, g = frameGeom(this.look, this.games[0].size);
    let fx = X, fy = Y, fw = W, fh = H;
    if (g) {
      const w = Math.min(W, H * g.ratio), bx = X + (W - w) / 2, by = Y + (H - w / g.ratio) / 2;
      fx = bx + g.x * w; fy = by + g.y * w; fw = g.w * w; fh = g.h * w;
    }
    const px = (v) => +v.toFixed(2) + 'px', corner = getComputedStyle(this.el).getPropertyValue('--corner').trim() || '6px';
    const key = [fx, fy, fw, fh, X, Y, W, H].map((v) => v.toFixed(1)).join();
    if (key === this.placed) return;
    this.placed = key;
    const op = !this.shown ? '0' : this.dimmed ? '.55' : '1';
    this.iframe.style.cssText = FRAME_CSS + `position:absolute;z-index:1;margin:0;visibility:visible;left:${px(fx)};top:${px(fy)};width:${px(fw)};height:${px(fh)};`
      + `clip-path:inset(${px(Y - fy)} ${px(fx + fw - X - W)} ${px(fy + fh - Y - H)} ${px(X - fx)} round ${corner});opacity:${op};transition:opacity .15s`;
  }
  // PTN Ninja's answer to a load (seen: its GAME_STATE for the position), or to the heartbeat: none within DEAD_MS and
  // tinue's board takes over. A hidden tab isn't held against it (its timers and the frame's are slowed).
  async _answered(seen, since) {
    const ok = await Promise.race([seen.then(() => true), sleep(NinjaBoard.RUSH_MS.dead).then(() => false)]);
    if (!ok && !this.fb && !document.hidden) await this._die(since);
  }
  _beat() {
    clearTimeout(this._beatT);
    this._beatT = setTimeout(async () => {
      if (this.fb || this.dead) return;
      if (document.hidden) return this._beat();
      const t = performance.now();
      try { await this._answered(this._ping().then((ok) => (ok ? true : new Promise(() => {}))), t); } catch (e) { console.warn(e); await this._die(t); }
      if (!this.fb && !this.dead) this._beat();
    }, NinjaBoard.RUSH_MS.heart);
  }
  // PTN Ninja stopped answering mid-run: tinue's board takes over for the rest of it, in the same position (the puzzle's
  // moves so far, the side to move, input on or off, its lock and hint squares); the frame isn't used again on this page
  // load. onDead hears how long the run waited (rush.js gives some of it back to the clock).
  async _die(since) {
    if (this.fb || this.dead) return;
    const u = this.under, h = this.headers || {};
    this.iframe.dataset.dead = '1';
    console.warn('PTN Ninja stopped answering: tinue\'s board for the rest of the run');
    this._unplace();
    this.fb = u;
    await u.ui({ ...this.opts });
    u.lock(this.lockUntil);
    if (this.player != null) await u.setPlayer(this.player);
    if (this.snaps.length > 1 || h.TPS) {
      await u.load(buildPTN({ size: +h.Size || this.games[0].size, komi: +(h.Komi || 0), tps: h.TPS || null, moves: this.snaps.slice(1).map((x) => x.ptn) }));
      await u.goTo(this.cur - 1);
    }
    if (this.hl.length) await u.highlight(this.hl);
    this.onDead?.(performance.now() - since);
  }
  // The run is over (or left): the frame goes back to the puzzle page, tinue's board is Rush's again (out of sight).
  giveBack() { if (!this.fb) { this._unplace(); this.fb = this.under; } }
  _unplace() {
    clearTimeout(this._beatT); this._ro?.disconnect(); this._ro = null; this._unresize?.(); this._unresize = null;
    for (const t of [this._settleTimer, this._lockT, this._animT]) clearTimeout(t);
    this._want = null; this._seenFor = null; this.placed = null;
    this.el.classList.remove('lent');
    this.lender.el.closest('main')?.classList.remove('lend');
    if (this.iframe.ninjaOwner === this) this.iframe.ninjaOwner = null;
    this.lender._reclaim();
  }
  // The end of a run, its board dimmed a moment as tinue's is (style.css #rush-board-wrap.rush-over)
  dim(on) { if (this.fb) return; this.dimmed = on; if (this.shown) this.iframe.style.opacity = on ? '.55' : '1'; }
  // The orientation the player has given PTN Ninja's board (its [ ] - ; : = keys), as tinue's board's M, for Rush's
  // pictures of the run; null when the frame isn't Rush's board.
  frameM() { return this.iframe.dataset.dead ? null : TRANSFORM_M[String(store.get('ninjaTransform') || [0, 0])] || null; }

  // The puzzle page's board has its frame back: its shape, tinue's settings and the position it was keeping (it went on
  // tracking its calls meanwhile), without the fly-in. A board on tinue's own board since its fallback hides it again.
  _reclaim() {
    const f = this.iframe;
    if (this.dead) return;
    // Rush found the frame dead (it stopped answering, or left the page): the puzzle page goes to tinue's board too, in
    // its own position, rather than on with a board that may not answer. If PTN Ninja speaks again it takes over at the
    // next puzzle, as after a slow start (load()).
    if (!this.fb && !this._resolve && (f.dataset.dead || !f.isConnected)) return this._toTinue();
    if (this.fb) { f.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;border:0;visibility:hidden;pointer-events:none;opacity:0'; return; }
    f.style.opacity = this.shown ? '1' : '0';
    this.shapeCss = null; this._shape(this.games[0].size);
    if (this._resolve) return; // (not up yet: it greets when it is)
    this._greet();
    const h = this.headers;
    this._post('SET_UI', { disableBoard: this._gated(), showRoads: this.opts.showRoads, animateBoard: false });
    if (this.player != null) this._post('SET_PLAYER', this.player);
    if (h) {
      this._post('SET_CURRENT_PTN', buildPTN({ size: +h.Size || this.games[0].size, komi: +(h.Komi || 0), tps: h.TPS || null,
        moves: this.snaps.slice(1).map((x) => x.ptn), white: h.Player1 || 'White', black: h.Player2 || 'Black' }));
      this._post('GO_TO_PLY', this.peeking ? { plyID: this.cur, isDone: false } : { plyID: this.cur - 1, isDone: true });
    }
    this._post('HIGHLIGHT_SQUARES', this.hl.length ? this.hl : []); this.shapeKey = null;
    this._afterDraw(this.games[this.cur].toTPS());
  }
}
