// Opt-in board (?board=ninja): PTN Ninja (ptn.ninja) in an iframe, driven over postMessage the way PlayTak
// embeds it. Same API as Board (board.js), so app.js doesn't care which one it has. Only loaded via import()
// when the flag is set: everyone else fetches nothing from here or from ptn.ninja.
// PTN Ninja's embed API: https://github.com/gruppler/PTN-Ninja#api
import { Game } from './shared/tak.js?v=1795073685';
import { parsePTN } from './shared/ptn.js?v=1795073685';
import { buildPTN, focusedByPointer } from './board.js?v=1795073685';

const ORIGIN = 'https://ptn.ninja';
// tinue's palette as a PTN Ninja theme (the schema of its built-in "classic" theme, which PlayTak uses).
const THEME = {
  id: 'tinue', name: 'tinue', boardStyle: 'blank', boardChecker: true,
  vars: { 'piece-border-width': 1 },
  colors: {
    primary: '#9cb83a', secondary: '#161512', ui: '#262421', accent: '#302e2c', panel: '#262421c0',
    board1: '#f0d9b5', board2: '#b58863', board3: '#262421',
    player1: '#f6f1e7', player1road: '#f6f1e7', player1flat: '#f6f1e7', player1special: '#ffffff', player1border: '#8f8473',
    player2: '#2f2c29', player2road: '#4a4540', player2flat: '#2f2c29', player2special: '#3d3935', player2border: '#0d0c0b',
    textLight: '#fafafacd', textDark: '#212121cd', umbra: '#00000033',
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
};
// PTN Ninja reads URL settings from the path as /&key=value (not a ?query, which it ignores)
const PARAMS = '&' + Object.entries(UI).filter(([k]) => k !== 'theme').map(([k, v]) => `${k}=${v}`).join('&');
const FRAME_CSS = 'display:block;width:100%;aspect-ratio:1/1.3;border:0;border-radius:var(--corner,6px);background:#262421';
// tinue's orientation keys, for when focus is on the page rather than inside the iframe (PTN Ninja's own hotkeys
// handle them there).
const TRANSFORM = { '[': 'ROTATE_LEFT', ']': 'ROTATE_RIGHT', '-': 'ROTATE_180', ';': 'FLIP_HORIZONTAL', ':': 'FLIP_VERTICAL', '=': 'RESET_TRANSFORM' };
const READY_TIMEOUT = 15000; // no PTN Ninja by then (blocked, offline, down): use tinue's own board instead
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('tinue.' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('tinue.' + k, JSON.stringify(v)); } catch {} },
};

export class NinjaBoard {
  constructor(el, { onMove } = {}) {
    this.el = el; this.onMove = onMove;
    this.opts = { disableBoard: false, showRoads: false, animateBoard: true, dropOnStray: false };
    this.lockUntil = 0;
    this.games = [new Game(5)]; this.snaps = [{}]; this.cur = 0; this.peeking = false;
    this.ptn = null; this.player = null; this.hl = [];
    // index.html usually started the iframe already (before the page's modules loaded); otherwise start it now
    let f = el.querySelector('iframe');
    if (!f) { f = document.createElement('iframe'); f.allow = 'fullscreen; clipboard-write'; f.src = ORIGIN + '/' + PARAMS; f.style.opacity = '0'; el.replaceChildren(f); }
    this.iframe = f;
    f.title = 'Tak board (PTN Ninja)';
    f.style.cssText = FRAME_CSS + ';opacity:' + f.style.opacity + ';transition:opacity .15s';
    this.ready = new Promise((resolve) => { this._resolve = resolve; });
    this._failTimer = setTimeout(() => this._fallback(), READY_TIMEOUT);
    // PTN Ninja is up (its game exists) once it posts GAME_STATE, which it does once at boot. That can happen before
    // this module has even loaded: index.html starts the iframe early and a cached PTN Ninja boots in ~0.3 s, so
    // index.html notes that first GAME_STATE in window.__ninjaUp. (Anything sooner isn't safe: PTN Ninja answers
    // messages before its game exists, and a game sent then throws.)
    if (window.__ninjaUp) queueMicrotask(() => this._up());
    window.addEventListener('message', (e) => {
      if (e.source !== f.contentWindow || this.fb) return;
      const { action, value } = e.data || {};
      if (action === 'GAME_STATE') this._up();
      else if (action === 'SET_UI' && value?.boardTransform) store.set('ninjaTransform', value.boardTransform); // kept per browser
      else if (action === 'INSERT_PLY') this._played(typeof value === 'string' ? value : value?.ptn ?? value?.text);
      else if (action === 'UNHANDLED_KEY' && value?.key) {
        // keys PTN Ninja didn't use (arrows etc. with its navigation off) work as if pressed on the page
        const { key, code, shiftKey, ctrlKey, altKey, metaKey } = value;
        window.dispatchEvent(new KeyboardEvent('keydown', { key, code, shiftKey, ctrlKey, altKey, metaKey, bubbles: true, cancelable: true }));
      }
    });
    window.addEventListener('keydown', (e) => {
      if (this.fb || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !(e.key in TRANSFORM)) return;
      if (e.target.closest?.('input, select, textarea, [contenteditable]')) return;
      e.preventDefault(); this._send(TRANSFORM[e.key]);
    });
    // Callers hold this object; after a fallback every call goes to tinue's own board instead.
    return new Proxy(this, {
      get: (t, k) => { const o = t.fb && k in t.fb ? t.fb : t; const v = o[k]; return typeof v === 'function' ? v.bind(o) : v; },
    });
  }

  _up() {
    if (!this._resolve || this.fb) return;
    clearTimeout(this._failTimer);
    // tinue shows names nowhere else on the board, and they crowd the flat counts
    this._post('SET_UI', { ...UI, boardTransform: store.get('ninjaTransform') || [0, 0] });
    this._post('SHOW_NAMES', false);
    this._resolve(); this._resolve = null;
    this._settle();
  }

  // PTN Ninja's hotkeys (number keys, Enter, `) only work while its iframe has keyboard focus, so a puzzle that
  // becomes playable gets it, unless the player has focus somewhere on purpose (a field, a button reached by
  // keyboard). Once the puzzle is over (exploring, or the board off) the page takes it back, so Enter = Continue.
  _focus(on) {
    if (this.fb) return;
    const a = document.activeElement, f = this.iframe;
    if (!on) { if (a === f) f.blur(); return; }
    if (!matchMedia('(any-pointer: fine)').matches) return; // phones: nothing to type with
    if (a === f || !(a == null || a === document.body || (focusedByPointer(a) && a.closest('button, a, summary')))) return;
    this.ready.then(() => { if (!this.fb && !this.opts.disableBoard && !this.opts.dropOnStray) f.focus({ preventScroll: true }); });
  }

  // ---------- messaging ----------
  _post(action, value) { if (!this.fb) this.iframe.contentWindow.postMessage(value === undefined ? { action } : { action, value }, ORIGIN); }
  async _send(action, value) { await this.ready; this._post(action, value); }

  // Show the iframe only once PTN Ninja has drawn what tinue last loaded and stopped resizing: no white page,
  // no board jumping size. Each load restarts the short wait.
  _settle() {
    if (this.shown) return;
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      if (this._resolve || this.fb) return;
      this.shown = true;
      requestAnimationFrame(() => { this.iframe.style.opacity = '1'; });
    }, 250);
  }

  // PTN Ninja never came up: put tinue's own board in its place, in the same state, and hand it every call.
  async _fallback() {
    if (this.fb || !this._resolve) return;
    const { Board } = await import('./board.js?v=1795073685');
    this.el.style.cssText = ''; // index.html's placeholder background
    const fb = new Board(this.el, { onMove: this.onMove });
    this.fb = fb;
    console.warn('PTN Ninja did not load; using tinue\'s board');
    await fb.ui(this.opts);
    if (this.player != null) await fb.setPlayer(this.player);
    if (this.ptn) { await fb.load(this.ptn); await fb.goTo(this.cur - 1); }
    if (this.hl.length) await fb.highlight(this.hl);
    this._resolve(); this._resolve = null; // calls already waiting on PTN Ninja go nowhere now
  }

  // ---------- what the board shows (tracked here, since PTN Ninja doesn't report it) ----------
  get g() { return this.games[this.cur]; }
  get holding() { return false; } // PTN Ninja doesn't say whether stones are in hand
  _canon(g, ptn) { try { const mv = g.parseMove(ptn); return g.isLegal(mv) ? g.moveToPTN(mv) : null; } catch { return null; } }
  _push(ptn) { const g = this.games.at(-1).clone(); g.apply(g.parseMove(ptn)); this.games.push(g); this.snaps.push({ ptn }); }
  // A move made on PTN Ninja's board (or typed): like Board's _commit, the next move in line just steps forward.
  _played(ptn) {
    const canon = ptn && this._canon(this.g, ptn);
    if (!canon) return;
    const next = this.snaps[this.cur + 1]?.ptn;
    if (next !== canon) { this.games.length = this.snaps.length = this.cur + 1; this._push(canon); }
    this.cur++; this.peeking = false;
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
    const komi = +(headers.Komi || 0);
    const g = headers.TPS ? Game.fromTPS(headers.TPS, komi) : new Game(+headers.Size || 5);
    g.komi = komi;
    this.games = [g]; this.snaps = [{}]; this.ptn = ptn; this.headers = headers;
    for (const m of moves) { const c = this._canon(this.games.at(-1), m); if (!c) break; this._push(c); }
    this.cur = this.snaps.length - 1; this.peeking = false;
    // without PTN Ninja's fly-in animation for the whole game
    await this._send('SET_UI', { animateBoard: false });
    this._post('HIGHLIGHT_SQUARES', []);
    this._post('SET_CURRENT_PTN', ptn);
    this._post('LAST');
    await new Promise((r) => setTimeout(r, 60));
    this._post('SET_UI', { animateBoard: this.opts.animateBoard });
    this._settle();
  }
  async append(ply) {
    const c = this._canon(this.games.at(-1), ply);
    if (!c) return;
    this._push(c); this.cur = this.snaps.length - 1; this.peeking = false;
    await this._send('APPEND_PLY', c);
  }
  goTo(plyID) { this.cur = Math.max(0, Math.min(this.snaps.length - 1, plyID + 1)); this.peeking = false; return this._send('GO_TO_PLY', { plyID: this.cur - 1, isDone: true }); }
  first() { this.cur = 0; this.peeking = false; return this._send('FIRST'); }
  last() { this.cur = this.snaps.length - 1; this.peeking = false; return this._send('LAST'); }
  // Half-step: the position before the next move, that move's squares highlighted (PTN Ninja's not-done ply).
  peek() { if (!this.snaps[this.cur + 1]) return false; this.peeking = true; this._send('GO_TO_PLY', { plyID: this.cur, isDone: false }); return true; }
  setPlayer(p) { this.player = p; return this._send('SET_PLAYER', p); }
  ui(v = {}) {
    Object.assign(this.opts, v);
    const out = {};
    for (const k of ['disableBoard', 'showRoads', 'animateBoard']) if (k in v) out[k] = v[k];
    // A new puzzle's first moments (lock): PTN Ninja's taps never reach the page, so its board is turned on only then.
    const wait = this.lockUntil - performance.now();
    if (out.disableBoard === false && wait > 0) {
      out.disableBoard = true; clearTimeout(this._lockT);
      this._lockT = setTimeout(() => { if (!this.opts.disableBoard) this.ui({ disableBoard: false }); }, wait + 1);
    }
    if ('disableBoard' in v || 'dropOnStray' in v) this._focus(!(out.disableBoard ?? this.opts.disableBoard) && !this.opts.dropOnStray);
    return Object.keys(out).length ? this._send('SET_UI', out) : this.ready;
  }
  highlight(squares = []) { this.hl = squares || []; return this._send('HIGHLIGHT_SQUARES', this.hl); }
  cancel() { return this._send('CANCEL_MOVE'); }
  // Another puzzle (Board's forget): a move half-entered on PTN Ninja's board is dropped. Its taps and keys never reach
  // the page, so nothing else of it can be held here; the new position (SET_CURRENT_PTN) follows anyway.
  forget() { return this.cancel(); }
  // Board's lock: here the board stays off until then (ui), as it is during an intro. A move typed meanwhile still
  // reaches app.js, whose tooSoon drops it.
  lock(until) { this.lockUntil = until; }
  // A typed move: checked here, then played on PTN Ninja's board, which reports it back like a click.
  play(ptn) {
    // the same checks as Board's _canInput: input on, the mover's turn, game not over
    if (this.opts.disableBoard || (this.player != null && this.player !== this.g.toMove) || this.g.result()) return false;
    const c = this._canon(this.g, ptn);
    if (!c) return false;
    this._send('INSERT_PLY', c);
    return true;
  }
}
