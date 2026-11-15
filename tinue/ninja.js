// Opt-in board (?board=ninja): PTN Ninja (ptn.ninja) in an iframe, driven over postMessage the way PlayTak
// embeds it. Same API as Board (board.js), so app.js doesn't care which one it has. Only loaded via import()
// when the flag is set: everyone else fetches nothing from here or from ptn.ninja.
// PTN Ninja's embed API: https://github.com/gruppler/PTN-Ninja#api
import { Game } from './shared/tak.js?v=1794773197';
import { parsePTN } from './shared/ptn.js?v=1794773197';

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
// Sent in the URL and again over postMessage: Firefox doesn't reliably apply URL settings.
const UI = {
  theme: THEME, moveNumber: false, unplayedPieces: true, disableStoneCycling: true, showBoardPrefsBtn: false,
  disableNavigation: true, disablePTN: true, disableText: true, flatCounts: true, turnIndicator: true,
  gameTimer: false, showHeader: false, showEval: false, showRoads: false, stackCounts: false, notifyGame: false,
  disableUndo: true, showPTN: false, showText: false, showControls: false, showScrubber: false, animateBoard: true,
};
const PARAMS = '?' + Object.entries(UI).filter(([k]) => k !== 'theme').map(([k, v]) => `${k}=${v}`).join('&');
// tinue's orientation keys, for when focus is on the page rather than inside the iframe (PTN Ninja's own hotkeys
// handle them there).
const TRANSFORM = { '[': 'ROTATE_LEFT', ']': 'ROTATE_RIGHT', '-': 'ROTATE_180', ';': 'FLIP_HORIZONTAL', ':': 'FLIP_VERTICAL', '=': 'RESET_TRANSFORM' };

export class NinjaBoard {
  constructor(el, { onMove } = {}) {
    this.onMove = onMove;
    this.opts = { disableBoard: false, showRoads: false, animateBoard: true, dropOnStray: false };
    this.games = [new Game(5)]; this.snaps = [{}]; this.cur = 0; this.peeking = false;
    const f = this.iframe = document.createElement('iframe');
    f.title = 'Tak board (PTN Ninja)';
    f.allow = 'clipboard-write';
    // the board plus PTN Ninja's turn indicator above it and its tray below
    f.style.cssText = 'display:block;width:100%;aspect-ratio:1/1.3;border:0;border-radius:var(--corner,6px);background:#161512';
    f.src = ORIGIN + '/' + PARAMS;
    el.replaceChildren(f);
    this.ready = new Promise((resolve) => { this._resolve = resolve; });
    window.addEventListener('message', (e) => {
      if (e.source !== f.contentWindow) return;
      const { action, value } = e.data || {};
      if (action === 'GAME_STATE') {
        if (this._resolve) { this._post('SET_UI', UI); this._resolve(); this._resolve = null; }
      } else if (action === 'INSERT_PLY') this._played(typeof value === 'string' ? value : value?.ptn ?? value?.text);
      else if (action === 'UNHANDLED_KEY' && value?.key) {
        // keys PTN Ninja didn't use (arrows etc. with its navigation off) work as if pressed on the page
        const { key, code, shiftKey, ctrlKey, altKey, metaKey } = value;
        window.dispatchEvent(new KeyboardEvent('keydown', { key, code, shiftKey, ctrlKey, altKey, metaKey, bubbles: true, cancelable: true }));
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !(e.key in TRANSFORM)) return;
      if (e.target.closest?.('input, select, textarea, [contenteditable]')) return;
      e.preventDefault(); this._send(TRANSFORM[e.key]);
    });
  }

  // ---------- messaging ----------
  _post(action, value) { this.iframe.contentWindow.postMessage(value === undefined ? { action } : { action, value }, ORIGIN); }
  async _send(action, value) { await this.ready; this._post(action, value); }

  // ---------- what the board shows (tracked here, since PTN Ninja doesn't report it) ----------
  get g() { return this.games[this.cur]; }
  get holding() { return false; } // PTN Ninja doesn't say whether stones are in hand
  _canon(g, ptn) { try { const mv = g.parseMove(ptn); return g.isLegal(mv) ? g.moveToPTN(mv) : null; } catch { return null; } }
  _push(ptn) { const g = this.games.at(-1).clone(); g.apply(g.parseMove(ptn)); this.games.push(g); this.snaps.push({ ptn }); }
  // A move made on PTN Ninja's board (or typed): like Board's _commit, the next move in line just steps forward.
  _played(ptn) {
    const canon = ptn && this._canon(this.g, ptn);
    if (!canon) return;
    if (this.snaps[this.cur + 1]?.ptn !== canon) { this.games.length = this.snaps.length = this.cur + 1; this._push(canon); }
    this.cur++; this.peeking = false;
    this.highlight([]); // like Board: a played move clears hint squares
    this.onMove?.(canon);
  }

  // ---------- Board API ----------
  async load(ptn) {
    const { headers, moves } = parsePTN(ptn);
    const komi = +(headers.Komi || 0);
    const g = headers.TPS ? Game.fromTPS(headers.TPS, komi) : new Game(+headers.Size || 5);
    g.komi = komi;
    this.games = [g]; this.snaps = [{}];
    for (const m of moves) { const c = this._canon(this.games.at(-1), m); if (!c) break; this._push(c); }
    this.cur = this.snaps.length - 1; this.peeking = false;
    // without PTN Ninja's fly-in animation for the whole game
    await this._send('SET_UI', { animateBoard: false });
    this._post('HIGHLIGHT_SQUARES', []);
    this._post('SET_CURRENT_PTN', ptn);
    this._post('LAST');
    await new Promise((r) => setTimeout(r, 60));
    this._post('SET_UI', { animateBoard: this.opts.animateBoard });
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
  setPlayer(p) { return this._send('SET_PLAYER', p); }
  ui(v = {}) {
    Object.assign(this.opts, v);
    const out = {};
    for (const k of ['disableBoard', 'showRoads', 'animateBoard']) if (k in v) out[k] = v[k];
    return Object.keys(out).length ? this._send('SET_UI', out) : this.ready;
  }
  highlight(squares = []) { return this._send('HIGHLIGHT_SQUARES', squares || []); }
  cancel() { return this._send('CANCEL_MOVE'); }
  // A typed move: checked here, then played on PTN Ninja's board, which reports it back like a click.
  play(ptn) {
    if (this.opts.disableBoard) return false;
    const c = this._canon(this.g, ptn);
    if (!c) return false;
    this._send('INSERT_PLY', c);
    return true;
  }
  rotate180() { return this._send('ROTATE_180'); }
}
