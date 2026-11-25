// The board: PTN Ninja (ptn.ninja) in an iframe, driven over postMessage the way PlayTak embeds it. It is tinue's only
// board (tinue's own, board.js, is retired). index.html starts the iframe as the page loads; this module takes it over.
// When PTN Ninja can't be loaded, is too slow, or stops answering, a plain message with Retry takes the board's place:
// nothing is judged meanwhile (no move can be made), and nothing else is put there.
// PTN Ninja's embed API: https://github.com/gruppler/PTN-Ninja#api
import { Game } from './shared/tak.js?v=1795581795';
import { parsePTN } from './shared/ptn.js?v=1795581795';
import { buildPTN, focusedByPointer, landOf, hooks } from './board-kit.js?v=1795581795';
import { frameParams, lookUi, frameBox, frameGeom, cleanTheme, THEMES } from './ninja-look.js?v=1795581795';

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
const withLook = (look) => ({ ...LOOK_BASE, ...UI, ...look, ...themeId(look) });
// A built-in theme goes as themeID too, so GET_THEME answers with it (see heardTheme)
const themeId = (look) => (typeof look.theme === 'string' ? { themeID: look.theme } : {});
// The frame asks for no permissions: PTN Ninja shows its fullscreen button only when it may go fullscreen (so it is gone),
// and nothing of its embed that tinue shows copies to the clipboard (that is its share and notes panels, all off here).
const FRAME_CSS = 'display:block;border:0;background:#262421;';
const OLD_SHAPE = { host: '', frame: 'width:100%;aspect-ratio:1/1.3' }; // a 3D board: the whole frame shown
// tinue's orientation keys, for when focus is on the page rather than inside the iframe (PTN Ninja's own hotkeys
// handle them there).
const TRANSFORM = { '[': 'ROTATE_LEFT', ']': 'ROTATE_RIGHT', '-': 'ROTATE_180', ';': 'FLIP_HORIZONTAL', ':': 'FLIP_VERTICAL', '=': 'RESET_TRANSFORM' };
// How long PTN Ninja gets, and when it counts as not there (NinjaBoard.MS; tests shorten them):
// up      at most this long from the frame's start (index.html's data-t0) for PTN Ninja to come up (its first GAME_STATE)
//         while its page is still loading. A cached PTN Ninja is up in ~0.1 s, a first visit on a desktop in ~0.7 s, on
//         Slow 4G in ~6.5 s, at 500 kbps with a slow CPU in ~26 s: a page still arriving is slow, not gone, so this is
//         long (only a connection that hangs outright waits it out; a blocked ptn.ninja is caught by loaded).
// loaded  once the frame's page has loaded (its load event: a blocked or failing ptn.ninja loads an error page, and then
//         nothing comes), this long more at most. PTN Ninja boots ~1 s after its page loads on a slow phone.
// note    "Loading the board…" from this long on (before it, the empty board's box says nothing).
// heart   a board in use asks PTN Ninja for its theme (GET_THEME, answered in ~2 ms whatever it shows) this often;
// dead    and after that, or after a load, waits this long for the answer. No answer: the board has stopped answering.
// A hidden tab is never held to these (its timers and the frame's are slowed): it is checked again once shown, with
// GRACE more at least (a frame throttled while hidden gets a moment to come up before it is called down).
// PTN Ninja coming up or answering later, at any time, puts the board back in the message's place, as it was.
const MS = { up: 45000, loaded: 8000, note: 4000, heart: 1000, dead: 3000, grace: 3000 };
// Reduced motion (the system's setting): PTN Ninja's pieces don't move, as tinue's own board didn't.
const still = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
// What the board's place says (minimal, in tinue's voice). load: never came up; stopped: stopped answering.
export const SAYS = { note: 'Loading the board…', load: 'The board (PTN Ninja) didn’t load.', stopped: 'The board (PTN Ninja) stopped answering.' };
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('tinue.' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('tinue.' + k, JSON.stringify(v)); } catch {} },
};

// After a load: how long to wait at most for PTN Ninja to say it has drawn it (its GAME_STATE) before its animation goes
// back on, and how long its board must have kept its size before the frame is first shown.
const DRAW_MS = 100, QUIET_MS = 40;
const frames = () => new Promise((r) => { const t = setTimeout(r, 50); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(); })); }); // (two frames; a hidden tab has none)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ---------- the player's built-in theme, for Rush's pictures (rush.js, rush-theme.js) ----------
// tinue keeps every colour of tinue felt, tinue classic and a pasted theme, but of PTN Ninja's built-in themes only their
// ids. Their colours come from the embed itself: it answers GET_THEME (sent anyway as the heartbeat) with the theme of
// its themeID setting. Note that themeID is set only when a theme is sent as themeID: a theme given as `theme` (by
// SET_UI, or compressed in the frame's address) is drawn but leaves themeID as it was (seen 2026-11-23: a frame started
// with zen in its address answers Classic), so tinue sends a built-in theme as both (withLook). An answer is that
// theme's own colours whatever the board shows, so it is kept under its own id: in memory and in this browser
// (THEMES_KEY), so the next end screen has it at once.
const THEMES_KEY = 'ninjaThemes';
let builtIns = null;
const themeFns = new Set();
const cached = () => { if (!builtIns) { builtIns = new Map(); const o = store.get(THEMES_KEY); if (o && typeof o === 'object') for (const [id, t] of Object.entries(o)) { const c = THEMES.includes(id) && cleanTheme(t); if (c) builtIns.set(id, { ...c, id }); } } return builtIns; };
// A built-in theme's colours, as its embed last gave them (null: never heard in this browser).
export const knownTheme = (id) => cached().get(id) || null;
// fn() whenever the player's theme may look different: a built-in theme's colours first heard or changed, or a new look
// (Settings, another tab, the account: setLook). Returns a function that stops it.
export function onNinjaTheme(fn) { themeFns.add(fn); return () => themeFns.delete(fn); }
const toldTheme = (id) => { for (const fn of themeFns) { try { fn(id); } catch (e) { console.warn(e); } } };
function heardTheme(value) {
  if (!value || typeof value !== 'object' || !THEMES.includes(value.id)) return;
  const t = cleanTheme(value);
  if (!t) return;
  const theme = { ...t, id: value.id }, m = cached(), was = m.get(value.id);
  if (was && JSON.stringify(was) === JSON.stringify(theme)) return;
  m.set(value.id, theme);
  store.set(THEMES_KEY, Object.fromEntries(m));
  toldTheme(value.id);
}
// ---------- Rush on this frame (borrow) ----------
// The page has one PTN Ninja frame, the puzzle page's (index.html starts it in #board). Rush borrows it (lend(): a second
// NinjaBoard on the same iframe), rather than loading ptn.ninja again: a second frame costs another cold load and
// ~350 MB. The iframe never moves in the page (moving an iframe reloads it): while Rush has it, the puzzle page stays laid
// out but out of sight (style.css .lend; display:none would stop the frame drawing) and the iframe is laid over Rush's
// board box (#rush-board, sized for the frame). One NinjaBoard at a time owns the frame (iframe.ninjaOwner): only it
// posts and hears moves; the other keeps track of its calls and puts its position back when it gets the frame again.
// The frame's state is kept on the iframe, for both: data-up (PTN Ninja has said GAME_STATE since it last loaded) and
// data-down ('load' or 'stopped': the page has said so).
// PTN Ninja's boardTransform [turns, flip] as tinue's orientation matrix (Rush's pictures, rush-look.js), read off PTN
// Ninja's own board (where its a1, b1 and a2 squares are drawn under each of the eight; 2026-11-22).
const TRANSFORM_M = { '0,0': [1, 0, 0, 1], '0,1': [-1, 0, 0, 1], '1,0': [0, 1, -1, 0], '1,1': [0, -1, -1, 0],
  '2,0': [-1, 0, 0, -1], '2,1': [1, 0, 0, -1], '3,0': [0, -1, 1, 0], '3,1': [0, 1, 1, 0] };

export class NinjaBoard {
  static MS = MS;
  // look: the stored PTN Ninja look (prefs.ninja); index.html started the iframe with the same one in its address.
  // onState(): the board came up, went down, or is loading again (app.js redraws what depends on it).
  // lender, onDead: a borrower (lend()).
  constructor(el, { onMove, look = '', lender = null, onDead = null, onState = null } = {}) {
    this.el = el; this.onMove = onMove; this.lookStored = look; this.look = lookUi(look); this.onState = onState;
    // (dropOnStray, board.js's name: here only whether the page, not PTN Ninja's frame, keeps keyboard focus: true while exploring)
    this.opts = { disableBoard: false, showRoads: false, animateBoard: true, dropOnStray: false };
    this.lockUntil = 0;
    this.games = [new Game(5)]; this.snaps = [{}]; this.cur = 0; this.peeking = false;
    this.ptn = null; this.player = null; this.hl = [];
    if (lender) return this._borrower(lender, onDead);
    // index.html usually started the iframe already (before the page's modules loaded); otherwise start it now
    let f = el.querySelector('iframe');
    if (!f) { f = document.createElement('iframe'); f.src = this._src(); f.style.opacity = '0'; f.dataset.t0 = performance.now(); el.replaceChildren(f); }
    this.iframe = f;
    f.title = 'Tak board (PTN Ninja)';
    this._shape(6);
    this.ready = new Promise((resolve) => { this._resolve = resolve; });
    this._waiters = []; this._ups = [];
    // (every listener and timer of this board is let go by destroy())
    this._offs = [];
    const on = (t, type, fn) => { t.addEventListener(type, fn); this._offs.push(() => t.removeEventListener(type, fn)); };
    // PTN Ninja is up (its game exists) once it posts GAME_STATE, which it does once at boot. That can happen before
    // this module has even loaded: index.html starts the iframe early and a cached PTN Ninja boots in ~0.3 s, so
    // index.html notes that first GAME_STATE on that frame (data-up). (Anything sooner isn't safe: PTN Ninja answers
    // messages before its game exists, and a game sent then throws.) After that, any word from it says it's answering.
    on(window, 'message', (e) => {
      if (e.source !== f.contentWindow || this.dead) return;
      const { action, value } = e.data || {};
      if (action === 'GAME_STATE') f.dataset.up = '1';
      if (action === 'GET_THEME') { if (e.origin === ORIGIN) heardTheme(value); this._pong?.(); }
      if (f.dataset.up) this._alive();
      if (this._owns()) this._heard(action, value); // (lent to Rush: the moves are Rush's)
    });
    on(f, 'load', () => { f.dataset.loaded = performance.now(); this._wait(); });
    on(window, 'keydown', (e) => this._key(e));
    on(document, 'visibilitychange', () => { if (!document.hidden) { this._wait(); this._beat(); } });
    // reduced motion turned on or off: PTN Ninja follows (whichever board has the frame)
    const mq = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (mq?.addEventListener && mq.removeEventListener) on(mq, 'change', () => { const o = f.ninjaOwner || this; o._post('SET_UI', { animateBoard: o._anim() }); });
    if (f.dataset.up) queueMicrotask(() => this._alive()); else this._wait();
  }
  _src() { return ORIGIN + '/' + frameParams(still() ? PARAMS.replace('&animateBoard=true', '&animateBoard=false') : PARAMS, this.lookStored); }
  // Whether PTN Ninja animates moves: tinue's setting for now (off while loading a whole game), never with reduced motion.
  _anim() { return !!this.opts.animateBoard && !still(); }

  // ---------- up, loading, down ----------
  // 'loading' (not up yet, or reloading after Retry), 'up', or 'down' (the message is shown).
  get state() { const f = this.iframe.dataset; return f.down ? 'down' : f.up ? 'up' : 'loading'; }
  get available() { return this.state === 'up'; }
  // Resolves once the frame is up or down (Rush's Start waits on it).
  settled() { return this.state === 'loading' ? new Promise((r) => this._waiters.push(r)) : Promise.resolve(); }
  // Resolves once the frame is up (now, or whenever PTN Ninja comes up or answers again; Rush clears its message then).
  whenUp() { if (this.lender) return this.lender.whenUp(); return this.state === 'up' ? Promise.resolve() : new Promise((r) => this._ups.push(r)); }
  _changed() { for (const r of this._waiters.splice(0)) r(); if (this.state === 'up') for (const r of this._ups.splice(0)) r(); try { this.onState?.(this.state); } catch (e) { console.warn(e); } }

  // Not up yet: the message once it has been too long (MS.up from the frame's start, or MS.loaded from its page loading),
  // "Loading the board…" from MS.note on.
  _wait() {
    const f = this.iframe;
    clearTimeout(this._waitT); clearTimeout(this._noteT);
    if (this.dead || f.dataset.up || f.dataset.down) return;
    const now = performance.now(), t0 = +f.dataset.t0 || now;
    let by = Math.min(t0 + NinjaBoard.MS.up, f.dataset.loaded ? +f.dataset.loaded + NinjaBoard.MS.loaded : Infinity);
    if (this._hiddenAt) by = Math.max(by, now + (NinjaBoard.MS.grace ?? 3000)); // (the deadline passed while the tab was hidden)
    this._hiddenAt = false;
    this._waitT = setTimeout(() => {
      if (this.dead || f.dataset.up || f.dataset.down) return;
      if (document.hidden) { this._hiddenAt = true; return; } // (checked again once shown, with a grace: visibilitychange)
      this._down('load');
    }, Math.max(0, by - now));
    if (this._owns()) this._noteT = setTimeout(() => { if (!f.dataset.up && !f.dataset.down && !this.dead) this._say('note'); }, Math.max(0, t0 + NinjaBoard.MS.note - now));
  }
  // PTN Ninja is up, or answering again: the board in its place, as it was.
  _alive() {
    const f = this.iframe, was = f.dataset.down;
    clearTimeout(this._waitT); clearTimeout(this._noteT);
    if (was) { delete f.dataset.down; f.removeAttribute('tabindex'); console.warn('PTN Ninja is answering again'); }
    if (this._resolve) { // the first time
      this._resolve(); this._resolve = null;
      this._say(null);
      if (this._owns()) { this._greet(); if (!this._want) this._settle(250); }
      this._beat();
      return this._changed();
    }
    if (!was && !this._reloaded) return;
    this._reloaded = false;
    this._say(null);
    if (this._owns()) this._restore();
    this._beat();
    this._changed();
  }
  // The board can't be used: the message in its place (why: 'load' or 'stopped'), its frame out of sight. Nothing
  // reaches PTN Ninja meanwhile (_post), and no move can come from it.
  _down(why) {
    const f = this.iframe;
    if (this.dead || f.dataset.down) return;
    f.dataset.down = why;
    f.tabIndex = -1; // (out of the Tab order while it's out of sight: Tab goes to Retry)
    clearTimeout(this._waitT); clearTimeout(this._noteT); clearTimeout(this._beatT);
    console.warn(why === 'load' ? 'PTN Ninja did not load' : 'PTN Ninja stopped answering');
    if (this._owns()) this._say(why);
    this._changed();
  }
  // Retry: the frame loads PTN Ninja again (with the look as it is now), and the wait starts over. Once up, the board
  // gets back everything it was showing (_restore).
  // A frame that came up meanwhile (late, but healthy) isn't loaded again.
  retry() {
    if (this.lender) return this.lender.retry();
    const f = this.iframe;
    if (this.dead || this.state === 'up') return;
    delete f.dataset.up; delete f.dataset.down; delete f.dataset.loaded; f.removeAttribute('tabindex');
    f.dataset.t0 = performance.now();
    this._reloaded = !this._resolve; // (up before: everything goes again once it is up)
    this.shown = false; f.style.opacity = '0';
    if (this._owns()) this._say('note');
    if (!f.isConnected) this.el.prepend(f); // (a frame taken out of the page goes back in its place)
    f.src = this._src();
    this._wait();
    this._changed();
  }
  // The message in the board's place: null (none), 'note', 'load' or 'stopped'. Plain text and, when it's down, Retry.
  _say(kind) {
    if (this.lender) return;
    let box = this.msgEl;
    if (!kind) { box?.remove(); this.msgEl = null; return; }
    if (!box) {
      box = this.msgEl = document.createElement('div');
      box.className = 'board-down';
      box.setAttribute('role', 'status');
      const p = document.createElement('p'), b = document.createElement('button');
      b.type = 'button'; b.className = 'board-retry'; b.textContent = 'Retry';
      b.onclick = () => this.retry();
      box.append(p, b); this.msgP = p; this.msgB = b;
      this.el.append(box);
    }
    box.dataset.kind = kind;
    this.msgP.textContent = SAYS[kind];
    this.msgB.hidden = kind === 'note';
  }

  // Keeps asking a board in use whether PTN Ninja is still answering (MS.heart; never a hidden tab or a board out of
  // sight); no answer within MS.dead and the board is down (Rush's: its run ends, onDead).
  _beat() {
    clearTimeout(this._beatT);
    this._beatT = setTimeout(async () => {
      if (this.dead || this.state !== 'up' || !this._owns() || (this.lender && !this.borrowed)) return;
      if (document.hidden) return this._beat(); // (asked again once shown)
      if (!this.el.getClientRects().length && !this.lender) return this._beat(); // (the puzzle page out of sight: its frame is Rush's or idle)
      const ok = await this._ping();
      if (this.dead || this.state !== 'up') return;
      if (ok || document.hidden) return this._beat();
      this._lost();
    }, NinjaBoard.MS.heart);
  }
  // GET_THEME, which PTN Ninja answers at once whatever it is showing: true if it did within MS.dead.
  _ping() {
    return new Promise((r) => {
      const t = setTimeout(() => { this._pong = null; r(false); }, NinjaBoard.MS.dead);
      this._pong = () => { clearTimeout(t); this._pong = null; r(true); };
      // (a frame taken out of the page: no answer, so down after MS.dead like a hung one)
      try { this.iframe.contentWindow?.postMessage({ action: 'GET_THEME' }, ORIGIN); } catch {}
    });
  }
  // PTN Ninja's answer to a Rush load (seen: its GAME_STATE for the position): none within MS.dead and it has stopped
  // answering.
  async _answered(seen) {
    const ok = await Promise.race([seen.then(() => true), sleep(NinjaBoard.MS.dead).then(() => false)]);
    if (!ok && !document.hidden && this.state === 'up' && this._owns()) this._lost();
  }
  _lost() { if (this.lender) this._die(); else this._down('stopped'); }

  // What PTN Ninja says, to the board that owns the frame.
  _heard(action, value) {
    if (action === 'GAME_STATE') {
      const tps = String(value?.tps).split(' ')[0];
      if (this._want && tps === this._want.tps) this._want.fire();
      // (PTN Ninja's word that it has the last position loaded, however late it comes: a load waits on it up to MS.dead,
      // long after DRAW_MS has let _want go)
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
    if (!this._owns() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !(e.key in TRANSFORM)) return;
    // a board out of sight (the puzzle page's while Rush is on screen) leaves the key to the board in sight
    if (!this.el.getClientRects().length || e.target.closest?.('input, select, textarea, [contenteditable]')) return;
    e.preventDefault(); this._send(TRANSFORM[e.key]);
  }
  // Whether this board has the frame: the puzzle page's unless Rush has borrowed it.
  _owns() { const o = this.iframe.ninjaOwner; return this.lender ? o === this : !o || o === this; }
  // (app.js: a board out of sight makes no sound; the puzzle page's is laid out under Rush while Rush has its frame)
  get away() { return !this._owns(); }

  // The frame cut to PTN Ninja's board (ninja-look.js frameBox): squares as big as tinue's board's were.
  _shape(size) {
    if (this.lender) return this._place();
    if (!this._owns()) return;
    const b = frameBox(this.look, size) || OLD_SHAPE, f = this.iframe;
    if (b.frame === this.shapeCss) return;
    this.shapeCss = b.frame;
    // (the host's own other styles kept)
    Object.assign(this.el.style, { borderRadius: 'var(--corner,6px)', background: '#262421', aspectRatio: b.ratio ? String(b.ratio) : '', overflow: b.ratio ? 'hidden' : '' });
    f.style.cssText = FRAME_CSS + b.frame + ';opacity:' + (f.style.opacity || '0') + ';transition:opacity .15s';
  }

  // tinue's settings and the player's look (tinue shows names nowhere else on the board, and they crowd the flat counts)
  _greet() {
    this._post('SET_UI', { ...withLook(this.look), animateBoard: this._anim(), boardTransform: store.get('ninjaTransform') || [0, 0] });
    this._post('SHOW_NAMES', false);
    if (typeof this.look.theme === 'string') this._post('GET_THEME'); // (its colours, for Rush's pictures)
  }

  // A new look from the Settings page (or the account): what the old one set and the new one doesn't goes back to
  // tinue's (or PTN Ninja's own default), the rest is the new one's. A page about to be shown waits for PTN Ninja anyway.
  setLook(stored) {
    const prev = this.look, look = this.look = lookUi(stored), out = {};
    this.lookStored = stored;
    this._shape(this.games[0].size);
    for (const k of Object.keys(prev)) if (!(k in look)) out[k] = k in UI ? UI[k] : LOOK_BASE[k];
    Object.assign(out, look, themeId(look));
    toldTheme(null); // (an end screen open meanwhile takes the new theme, or felt)
    if (!Object.keys(out).length) return this.ready;
    const sent = this._send('SET_UI', out);
    if (out.themeID) this._send('GET_THEME'); // (after it: its colours, for Rush's pictures)
    return sent;
  }

  // PTN Ninja's hotkeys (number keys, Enter, `) only work while its iframe has keyboard focus, so a puzzle that
  // becomes playable gets it, unless the player has focus somewhere on purpose (a field, a button reached by
  // keyboard). Once the puzzle is over (exploring, or the board off) the page takes it back, so Enter = Continue.
  _focus(on) {
    if (!this._owns()) return;
    const a = document.activeElement, f = this.iframe;
    if (!on) { if (a === f) f.blur(); return; }
    if (!matchMedia('(any-pointer: fine)').matches) return; // phones: nothing to type with
    if (a === f || !(a == null || a === document.body || (focusedByPointer(a) && a.closest('button, a, summary')))) return;
    this.ready.then(() => { if (this.available && !this.opts.disableBoard && !this.opts.dropOnStray) f.focus({ preventScroll: true }); });
  }

  // ---------- messaging ----------
  // Only to a frame that is up and owned by this board (a frame loading, down, or taken out of the page gets nothing).
  _post(action, value) { if (!this.dead && this.available && this._owns()) this.iframe.contentWindow?.postMessage(value === undefined ? { action } : { action, value }, ORIGIN); }
  async _send(action, value) { await this.ready; this._post(action, value); }

  // Show the iframe only once PTN Ninja has drawn what tinue last loaded (_afterDraw) and stopped resizing (it posts
  // its board's size as it changes): no white page, no board jumping size. Up with nothing loaded yet: shown after
  // 250 ms, empty.
  _settle(ms = 0) {
    if (this.shown) return;
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      if (this._resolve || this.dead || this.shown || !this._owns() || !this.available) return;
      const still = performance.now() - (this.resizedAt ?? -Infinity);
      if (still < QUIET_MS) return this._settle(QUIET_MS - still);
      this.shown = true;
      requestAnimationFrame(() => { if (this.lender) this._place(true); else this.iframe.style.opacity = '1'; });
    }, ms);
  }
  // A load has been sent: once PTN Ninja posts the GAME_STATE of the position it ends on (it posts one as it redraws),
  // or after DRAW_MS whatever it says, and two frames later, its animation goes back on (on any sooner, the whole game
  // would fly in) and the frame may be shown. load() doesn't wait for this; a move appended meanwhile does (append).
  _afterDraw(tps) {
    const gen = this.drawGen = (this.drawGen || 0) + 1;
    let fire, seen;
    const drawn = new Promise((r) => { fire = r; });
    // (PTN Ninja's own word that it has it: _answered waits for it. Kept apart from _want, which DRAW_MS lets go; a later
    // load's position replaces it, and the earlier wait counts as answered: the later load has its own.)
    this._seenFor?.seen();
    this.seen = new Promise((r) => { seen = r; });
    this._seenFor = { tps: tps.split(' ')[0], seen };
    this._want = { tps: tps.split(' ')[0], fire };
    clearTimeout(this._animT); this._animT = setTimeout(fire, DRAW_MS);
    this._drawn = drawn.then(frames).then(() => {
      if (gen !== this.drawGen || this.dead) return; // (a later load's turn)
      this._want = null; clearTimeout(this._animT);
      this._post('SET_UI', { animateBoard: this._anim() });
      this._settle();
    });
    if (this.lender) this._answered(this.seen); // (Rush: every puzzle's load is answered; the puzzle page has the heartbeat)
  }

  // Done with this board (another page takes its place): its listeners and timers go, and its frame with them (a
  // PTN Ninja frame costs memory). Calls after this do nothing.
  destroy() {
    if (this.dead) return;
    this.dead = true;
    for (const off of this._offs) off();
    for (const t of [this._waitT, this._noteT, this._beatT, this._settleTimer, this._lockT, this._animT]) clearTimeout(t);
    this.iframe.remove(); this.msgEl?.remove();
    this._resolve?.(); this._resolve = null; // (calls waiting on PTN Ninja go nowhere)
    for (const r of this._waiters?.splice(0) || []) r();
  }

  // ---------- what the board shows (tracked here, since PTN Ninja doesn't report it) ----------
  get g() { return this.games[this.cur]; }
  _canon(g, ptn) { try { const mv = g.parseMove(ptn); return g.isLegal(mv) ? g.moveToPTN(mv) : null; } catch { return null; } }
  // (land: what the move sets down, for its sound: board-kit.js landOf, read off the position before it)
  _push(ptn) { const g = this.games.at(-1).clone(), mv = g.parseMove(ptn), land = landOf(g, mv), u = g.apply(mv); this.games.push(g); this.snaps.push({ ptn, smash: u.smashed, land }); }
  // A move made on PTN Ninja's board (or typed): the next move in line just steps forward.
  _played(ptn) {
    const canon = ptn && this._canon(this.g, ptn);
    if (!canon) return;
    const next = this.snaps[this.cur + 1]?.ptn;
    if (next !== canon) { this.games.length = this.snaps.length = this.cur + 1; this._push(canon); }
    this.cur++; this.peeking = false;
    // (the move's sound. PTN Ninja reports only finished moves, so a stack moved by hand there sounds as a whole when it
    // is complete: its drops in a row, as a reply's would)
    hooks.onPly?.(canon, this.snaps[this.cur].smash, this.snaps[this.cur].land, this);
    // A different move mid-line: PTN Ninja made it a branch, so its ply numbers no longer match ours (stepping back
    // would show the old line). Give it the line as tinue has it, one straight line, at the same spot.
    if (next && next !== canon) this._relinearize();
    this.highlight([]); // a played move clears hint squares
    this.onMove?.(canon);
  }

  _line() {
    const h = this.headers || {};
    return buildPTN({ size: +h.Size || this.games[0].size, komi: +(h.Komi || 0), tps: h.TPS || null,
      moves: this.snaps.slice(1).map((s) => s.ptn), white: h.Player1 || 'White', black: h.Player2 || 'Black' });
  }
  _relinearize() {
    const ptn = this.ptn = this._line();
    this._post('SET_UI', { animateBoard: false });
    this._post('SET_CURRENT_PTN', ptn);
    this._post('GO_TO_PLY', { plyID: this.cur - 1, isDone: true });
    setTimeout(() => this._post('SET_UI', { animateBoard: this._anim() }), 60);
  }

  // ---------- the board's API (app.js, rush.js, lines.js) ----------
  async load(ptn) {
    const { headers, moves } = parsePTN(ptn);
    const komi = +(headers.Komi || 0);
    const g = headers.TPS ? Game.fromTPS(headers.TPS, komi) : new Game(+headers.Size || 5);
    g.komi = komi;
    // (another position shown: the same PTN can be another position: a move made here since the last load (a spread on
    // PTN Ninja, cancelled by Confirm moves) is not in it.)
    const was = this.games?.[this.cur]?.toTPS?.();
    this.games = [g]; this.snaps = [{}]; this.ptn = ptn; this.headers = headers;
    this._shape(g.size);
    for (const m of moves) { const c = this._canon(this.games.at(-1), m); if (!c) break; this._push(c); }
    this.cur = this.snaps.length - 1; this.peeking = false;
    if (this.games[this.cur].toTPS() !== was) hooks.onCut?.(this);
    // without PTN Ninja's fly-in animation for the whole game
    await this._send('SET_UI', { animateBoard: false });
    if (!this.available || !this._owns()) return; // (down, or the frame lent: what it shows goes to PTN Ninja later, _restore)
    this._post('HIGHLIGHT_SQUARES', []); this.hl = []; this.shapeKey = null; // (a hint's squares go with the old line)
    this._post('SET_CURRENT_PTN', ptn);
    this._post('LAST');
    this._afterDraw(this.games[this.cur].toTPS());
    if (this.lender) await this.seenOrLost; // (Rush: the position is on PTN Ninja's board, or the run is over)
  }
  // (Rush waits for PTN Ninja's answer to a load, or for MS.dead)
  get seenOrLost() { return Promise.race([this.seen, sleep(NinjaBoard.MS.dead + 20)]); }
  async append(ply) {
    const c = this._canon(this.games.at(-1), ply);
    if (!c) return;
    const atEnd = this.cur === this.snaps.length - 1;
    this._push(c); this.cur = this.snaps.length - 1; this.peeking = false;
    if (atEnd) hooks.onPly?.(c, this.snaps[this.cur].smash, this.snaps[this.cur].land, this); // (silent while browsing back)
    await this._drawn; // (animated, so not before the load's animation is back on)
    await this._send('APPEND_PLY', c);
  }
  // (a jump to another ply stops a move's drops still sounding)
  _jump(i) { if (i !== this.cur) hooks.onCut?.(this); this.cur = i; this.peeking = false; }
  goTo(plyID) { this._jump(Math.max(0, Math.min(this.snaps.length - 1, plyID + 1))); return this._send('GO_TO_PLY', { plyID: this.cur - 1, isDone: true }); }
  first() { this._jump(0); return this._send('FIRST'); }
  last() { this._jump(this.snaps.length - 1); return this._send('LAST'); }
  // Half-step: the position before the next move, that move's squares highlighted (PTN Ninja's not-done ply).
  peek() { if (!this.snaps[this.cur + 1]) return false; this.peeking = true; this._send('GO_TO_PLY', { plyID: this.cur, isDone: false }); return true; }
  setPlayer(p) { this.player = p; return this._send('SET_PLAYER', p); }
  ui(v = {}) {
    Object.assign(this.opts, v);
    const out = {};
    if ('showRoads' in v) out.showRoads = v.showRoads;
    if ('animateBoard' in v) out.animateBoard = this._anim();
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
  // The analysis page's shapes: PTN Ninja's embed has no arrows or rings, so line 1's squares are highlighted instead
  // (only while no hint is shown), and nothing else. An empty list clears them.
  shapes(list = []) {
    if (this.hl.length) return this.ready;
    const sqs = (list || []).find((x) => x.role === 'best')?.sqs || [], key = sqs.join(' ');
    if (key === (this.shapeKey ?? '')) return this.ready;
    this.shapeKey = key;
    return this._send('HIGHLIGHT_SQUARES', sqs);
  }
  cancel() { return this._send('CANCEL_MOVE'); }
  // Another puzzle: a move half-entered on PTN Ninja's board is dropped. Its taps and keys never reach the page, so
  // nothing else of it can be held here; the new position (SET_CURRENT_PTN) follows anyway.
  forget() { return this.cancel(); }
  // The board is off until then (_gated), as it is during an intro; a lock already past turns it back on. A move typed
  // meanwhile still reaches app.js, whose tooSoon drops it.
  lock(until) { this.lockUntil = until; return this.ui({ disableBoard: this.opts.disableBoard }); }
  // A typed move: checked here, then played on PTN Ninja's board, which reports it back like a click. None while the
  // board is down or loading (nothing would report it back).
  play(ptn) {
    if (!this.available || this.opts.disableBoard || (this.player != null && this.player !== this.g.toMove) || this.g.result()) return false;
    const c = this._canon(this.g, ptn);
    if (!c) return false;
    this._send('INSERT_PLY', c);
    return true;
  }

  // ---------- lending the frame to Rush ----------
  // A board on el (Rush's #rush-board, a box the frame is laid over) that plays on this frame while it has borrowed it.
  // Until borrow() and after giveBack() it only keeps track of its calls. onDead(): PTN Ninja stopped answering mid-run.
  lend(el, { onMove, onDead } = {}) { return new NinjaBoard(el, { onMove, onDead, lender: this }); }

  _borrower(lender, onDead) {
    this.lender = lender; this.onDead = onDead;
    const f = this.iframe = lender.iframe;
    this.ready = Promise.resolve();
    this._offs = [];
    const on = (t, type, fn) => { t.addEventListener(type, fn); this._offs.push(() => t.removeEventListener(type, fn)); };
    on(window, 'message', (e) => {
      if (e.source !== f.contentWindow) return;
      const { action, value } = e.data || {};
      if (action === 'GET_THEME') this._pong?.(); // (its theme is the lender's to keep: heardTheme)
      if (this.borrowed && this._owns()) this._heard(action, value);
    });
    on(window, 'keydown', (e) => this._key(e));
    on(document, 'visibilitychange', () => { if (!document.hidden) this._beat(); });
    this._size(6);
  }
  // Whether the frame can be used for a run: up (waiting for it while it loads, MS.up at most from its start) and
  // answering. Rush's Start waits for this, so its clock never starts while the board isn't playable.
  get frameUp() { return this.lender.state === 'up'; }
  async frameReady() {
    const L = this.lender, f = this.iframe;
    if (this.dead || L.dead || !f.isConnected) return false;
    await L.settled();
    if (L.state !== 'up') return false;
    if (await this._ping()) return true;
    L._down('stopped');
    return false;
  }
  // The run starts on the frame: laid over Rush's board box, sized now for the run's board (size) in the player's look.
  borrow(size = 6) {
    if (this.dead || this.borrowed || this.lender.state !== 'up') return false;
    const f = this.iframe, L = this.lender;
    f.ninjaOwner = this; this.borrowed = true;
    this.look = L.look; this.shown = false; this.dimmed = false; this.placed = null;
    this._size(size);
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
  // Rush's board box: the shape of PTN Ninja's board as frameBox cuts it on the puzzle page (a 3D look: the whole frame).
  _size(size) { const g = frameGeom(this.look || {}, size); this.el.style.aspectRatio = String(g ? g.ratio : 1 / 1.3); }
  // Over Rush's board box (this.el), in the document's own coordinates (index.html's #board and its wrap are made static
  // while lent, style.css .lend, so the frame is placed against the page and scrolls with it): PTN Ninja's board, as
  // frameBox cuts it on the puzzle page, as large as fits in the box and centred there; the frame clipped to that box,
  // corners and all.
  _place(force = false) {
    if (!this.borrowed || !this._owns()) return;
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
    if (key === this.placed && !force) return;
    this.placed = key;
    const op = !this.shown ? '0' : this.dimmed ? '.55' : '1';
    this.iframe.style.cssText = FRAME_CSS + `position:absolute;z-index:1;margin:0;visibility:visible;left:${px(fx)};top:${px(fy)};width:${px(fw)};height:${px(fh)};`
      + `clip-path:inset(${px(Y - fy)} ${px(fx + fw - X - W)} ${px(fy + fh - Y - H)} ${px(X - fx)} round ${corner});opacity:${op};transition:opacity .15s`;
  }
  // PTN Ninja stopped answering mid-run: the frame is down (the puzzle page shows the message, with Retry), and Rush hears
  // it (onDead: the run ends there, rush.js boardDied).
  _die() {
    if (this.dead || !this.borrowed) return;
    this.lender._down('stopped');
    this.giveBack();
    try { this.onDead?.(); } catch (e) { console.warn(e); }
  }
  // The run is over (or left): the frame goes back to the puzzle page.
  giveBack() { if (this.borrowed) { this.borrowed = false; this._unplace(); } }
  _unplace() {
    clearTimeout(this._beatT); this._ro?.disconnect(); this._ro = null; this._unresize?.(); this._unresize = null;
    for (const t of [this._settleTimer, this._lockT, this._animT]) clearTimeout(t);
    this._want = null; this._seenFor?.seen(); this._seenFor = null; this.placed = null;
    this.el.classList.remove('lent');
    this.lender.el.closest('main')?.classList.remove('lend');
    if (this.iframe.ninjaOwner === this) this.iframe.ninjaOwner = null;
    this.lender._reclaim();
  }
  // The end of a run, its board dimmed a moment (style.css #rush-board-wrap.rush-over)
  dim(on) { if (!this.borrowed) return; this.dimmed = on; if (this.shown) this.iframe.style.opacity = on ? '.55' : '1'; }
  // The orientation the player has given PTN Ninja's board (its [ ] - ; : = keys), as an orientation matrix, for Rush's
  // pictures of the run.
  frameM() { return TRANSFORM_M[String(store.get('ninjaTransform') || [0, 0])] || null; }
  // The player's board theme, for Rush's pictures (rush-theme.js pictureLook): { theme: null } for tinue felt, the
  // theme object (tinue classic, a pasted one, or a built-in one as its embed gave it), or { theme: null, pending: id }
  // for a built-in one not heard yet (it is asked for now; onNinjaTheme says when it comes).
  pictureTheme() {
    const L = this.lender || this, t = L.look?.theme;
    if (t == null) return { theme: null };
    if (typeof t === 'object') return { theme: t };
    const k = knownTheme(t);
    if (!k) L.askTheme();
    return k ? { theme: k } : { theme: null, pending: t };
  }
  // GET_THEME, whoever has the frame (only an answer: nothing on the board changes)
  askTheme() { if (!this.dead && this.state === 'up') try { this.iframe.contentWindow?.postMessage({ action: 'GET_THEME' }, ORIGIN); } catch {} }

  // The puzzle page's board has its frame back: its shape, tinue's settings and the position it was keeping (it went on
  // tracking its calls meanwhile), without the fly-in. A frame that is down shows the message in its place instead.
  _reclaim() {
    const f = this.iframe;
    if (this.dead) return;
    this.shapeCss = null; this._shape(this.games[0].size);
    if (f.dataset.down || !f.isConnected) { if (!f.dataset.down) this._down('stopped'); f.style.opacity = '0'; this._say(f.dataset.down || 'stopped'); return; }
    f.style.opacity = this.shown ? '1' : '0';
    if (this._resolve) return; // (not up yet: it greets when it is)
    this._restore();
    this._beat();
  }
  // Everything this board shows, sent to PTN Ninja again (it was reloaded, or lent, or is answering again).
  _restore() {
    this._greet();
    this._post('SET_UI', { disableBoard: this._gated(), showRoads: this.opts.showRoads, animateBoard: false });
    if (this.player != null) this._post('SET_PLAYER', this.player);
    if (this.headers) {
      this._post('SET_CURRENT_PTN', this._line());
      this._post('GO_TO_PLY', this.peeking ? { plyID: this.cur, isDone: false } : { plyID: this.cur - 1, isDone: true });
    }
    this._post('HIGHLIGHT_SQUARES', this.hl.length ? this.hl : []); this.shapeKey = null;
    this._afterDraw(this.games[this.cur].toTPS());
  }
}
