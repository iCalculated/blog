// The board is PTN Ninja (ptn.ninja), embedded exactly the way PlayTak embeds it: an iframe driven by
// postMessage. PTN Ninja draws the board and handles input; we judge moves with our own engine.
// API: https://github.com/gruppler/PTN-Ninja#api

// Our palette as a PTN Ninja theme (same schema as its built-in "classic" theme, which PlayTak uses):
// page-colored background, the brown checkered board, cream/charcoal pieces.
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

// PlayTak's embed parameters (playtak-ui src/js/main.js), minus the player-name bar, plus no undo.
const PARAMS = '&moveNumber=false&unplayedPieces=true&disableStoneCycling=true&showBoardPrefsBtn=false' +
  '&disableNavigation=true&disablePTN=true&disableText=true&flatCounts=false&turnIndicator=false&gameTimer=false' +
  '&showHeader=false&showEval=false&showRoads=false&stackCounts=false&notifyGame=false&disableUndo=true';
// The same settings again over postMessage once the board is up. Firefox doesn't reliably apply URL
// settings (the long theme JSON in the path breaks them), so the message is what actually counts there.
const UI = {
  theme: THEME, moveNumber: false, unplayedPieces: true, disableStoneCycling: true, showBoardPrefsBtn: false,
  disableNavigation: true, disablePTN: true, disableText: true, flatCounts: false, turnIndicator: false,
  gameTimer: false, showHeader: false, showEval: false, showRoads: false, stackCounts: false, notifyGame: false,
  disableUndo: true, showPTN: false, showText: false, showControls: false, showScrubber: false, animateBoard: false,
};
const ORIGIN = 'https://ptn.ninja';

export class NinjaBoard {
  constructor(iframe, { onMove, onState } = {}) {
    this.iframe = iframe;
    this.onMove = onMove;
    this.onState = onState;
    this.state = null;
    this.ready = new Promise((resolve) => { this._resolve = resolve; });
    this.queue = [];
    iframe.src = ORIGIN + '/' + PARAMS;
    window.addEventListener('message', (e) => {
      if (e.source !== iframe.contentWindow) return;
      const { action, value } = e.data || {};
      if (action === 'GAME_STATE') {
        this.state = value;
        if (this._resolve) {
          iframe.contentWindow.postMessage({ action: 'SET_UI', value: UI }, ORIGIN);
          this._resolve(); this._resolve = null;
        }
        this.onState?.(value);
      } else if (action === 'INSERT_PLY') this.onMove?.(value);
      else if (action === 'UNHANDLED_KEY') window.dispatchEvent(new KeyboardEvent('keydown', { key: value.key }));
    });
  }
  async send(action, value) {
    await this.ready;
    this.iframe.contentWindow.postMessage(value === undefined ? { action } : { action, value }, ORIGIN);
  }
  // Load a game without PTN Ninja's fly-in animation, then turn animation back on for the moves that follow.
  async load(ptn) {
    await this.send('SET_UI', { animateBoard: false });
    await this.send('SET_CURRENT_PTN', ptn);
    await this.send('LAST');
    await new Promise((r) => setTimeout(r, 60));
    await this.send('SET_UI', { animateBoard: true });
  }
  append(ply) { return this.send('APPEND_PLY', ply); }
  goTo(plyID) { return this.send('GO_TO_PLY', { plyID, isDone: true }); }
  first() { return this.send('FIRST'); }
  last() { return this.send('LAST'); }
  setPlayer(p) { return this.send('SET_PLAYER', p); }
  ui(v) { return this.send('SET_UI', v); }
  highlight(squares) { return this.send('HIGHLIGHT_SQUARES', squares); }
  cancel() { return this.send('CANCEL_MOVE'); }
  rotate180() { return this.send('ROTATE_180'); }
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
