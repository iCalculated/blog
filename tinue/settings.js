// The Settings block on the puzzle page (beside Theme, Difficulty and size): which board, and whether a finished move
// waits to be confirmed. Both live in the browser's prefs with the others (not synced to the account); off and tinue's
// own board are the defaults, under which the page behaves as it did before. What app.js decides is here, so node can
// test it (scripts/test-settings.mjs).
import { busy } from './busy.js?v=1795239942';

// ---- board ----
// ?board= in the address wins, so a shared ?board=ninja link keeps working (any other value is tinue's board, as
// before); without it, the setting. index.html makes the same choice before the modules load (window.__tinueNinja,
// to start PTN Ninja early); scripts/test-settings.mjs runs that copy against this one.
export function boardFrom(search, prefs) {
  const q = new URLSearchParams(search || '');
  if (q.has('board')) return q.get('board') === 'ninja' ? 'ninja' : 'tinue';
  return prefs?.board === 'ninja' ? 'ninja' : 'tinue';
}
export const confirmOn = (prefs) => prefs?.confirm === true;
// The address's query without ?board=: a switch reloads without it, or the flag the page was opened with would win.
export function withoutBoardFlag(search) {
  const q = new URLSearchParams(search || '');
  q.delete('board');
  const s = q.toString();
  return s ? '?' + s : '';
}
// The board is chosen at boot, so switching reloads. Now only if nothing would be sent or lost by it: no puzzle, or
// one not begun (no move, miss, hint or result; nothing being checked or played out). Otherwise the reload waits for
// the next puzzle (app.js loadNext), so switching mid-puzzle never sends a result, never ends a play-out, and isn't a
// free restart.
// Nor while a result is still uploading (uploading: app.js reporting.size): the reload would cut it off, and an
// ordinary result isn't kept anywhere for a resend.
export const switchNow = (s, uploading = 0) => !uploading && (!s || !!s.placeholder
  || (s.status === 'play' && !s.moves?.length && !s.misses?.length && !s.hinted && !s.resultSent && !s.checkPending && !s.quickCheck && !s.playOn));
// A switch made mid-puzzle reloads as the next puzzle loads (app.js loadNext), when nothing is held or still uploading,
// as a newer build does by itself; otherwise it waits for the Next after that.
export const switchAtNext = ({ wanted, leaving, held, uploading }) => !!wanted && !leaving && !held && !uploading;
// Whether a Board style choice was really stored (read back): where site storage is blocked the write is silently
// dropped, and a reload would come back on the old board, signed out (the token was kept in memory only).
export const boardSaved = (stored, board) => boardFrom('', stored) === board;
// The line under the Settings block: what isn't plain from the selects.
export function settingsNote({ unsaved, switching, linkBoard, ninja, confirm }) {
  if (unsaved) return "Settings can't be saved in this browser.";
  const out = [];
  if (switching) out.push('The board changes with the next puzzle.');
  else if (linkBoard) out.push(`This link opens ${linkBoard === 'ninja' ? 'PTN Ninja' : 'tinue'}.`); // (?board=, over the setting)
  if (ninja && confirm) out.push('With PTN Ninja, confirm with the button or Enter.');
  return out.join(' ');
}

// ---- confirm moves ----
// With the setting on, a finished move (a placement, or a spread once its last drop is made) stays on the board as
// pending and is not given to the solving flow until confirmed: Confirm, Enter, or the move's final square tapped
// again. Cancel, Esc, a tap anywhere else, or anything that changes the puzzle (another puzzle, the play-out ending,
// a check settling it, the page hidden) drops it and puts the board back; nothing was judged, logged or timed.

// Square names as tinue's board numbers them (board.js: sq = rank index · n + file index).
export const squareName = (sq, n) => 'abcdefgh'[sq % n] + (Math.floor(sq / n) + 1);
// Where a move ends: the square placed on, or a spread's last drop.
export function finalSquare(ptn) {
  const m = /^(\d?)([a-h])([1-8])([<>+-])?(\d*)/.exec(String(ptn).replace(/^[FSC]/, ''));
  if (!m) return null;
  if (!m[4]) return m[2] + m[3];
  const k = m[5] ? m[5].length : 1, [df, dr] = { '+': [0, 1], '-': [0, -1], '>': [1, 0], '<': [-1, 0] }[m[4]];
  return String.fromCharCode(m[2].charCodeAt(0) + df * k) + (+m[3] + dr * k);
}
// Whether a move from the board is held for confirmation: only a move the solving flow would take now (a puzzle move,
// or the player's move in a play-out). Anything else goes straight on, as without the setting: exploring after the
// puzzle is free, and a move the flow refuses (busy, browsing, the new puzzle's first 700 ms) is refused there.
export function holds(on, s, tooSoon) {
  if (!on || !s || s.placeholder || s.busy || s.view != null) return false;
  if (s.playOn) return !s.playOn.end && !s.playOn.thinking;
  if (s.free) return !s.free.over && !s.free.thinking; // (the free game after a miss: its moves are held the same way)
  return (s.status === 'play' || s.status === 'retry') && !tooSoon;
}
// The puzzle's state as far as a held move cares: when it changes, the move was made in a position that's gone.
export const phaseKey = (s) => !s ? '' : [s.p?.id, s.status, s.moves?.length, s.misses?.length, s.busy ? 1 : 0, s.view ?? '',
  s.playOn ? `${s.playOn.line.length}:${s.playOn.end || ''}:${s.playOn.thinking ? 1 : 0}` : '',
  s.free ? `${s.free.line.length}:${s.free.over ? 1 : 0}:${s.free.thinking ? 1 : 0}` : ''].join('|');
// A held move: { ptn, sq: its final square, t: when it was held, born: its puzzle's start }.
export const pending = (ptn, s, now) => ({ ptn, sq: finalSquare(ptn), t: now, born: s?.born ?? 0, key: phaseKey(s) });
// What an event does to a held move: 'confirm', 'cancel', 'replace' (Enter on a typed move) or 'ignore'. Confirming waits out busy.js 'confirm' after the
// move was held (the second tap of a double tap, a bounce, a held Enter's repeat) and the new puzzle's board lock;
// cancelling never waits (it costs nothing).
//   { type: 'tap', sq }          a tap on the board: its square, null off the squares (tray, flat counts)
//   { type: 'key', key, repeat, text } Enter confirms, Escape cancels; other keys are swallowed while a move is held.
//                                text: what the typed-move box holds when Enter is pressed there. Enter confirms only
//                                from an empty box; with a move typed, it 'replace's: the held move is cancelled and the
//                                typed one is held in its place (c3 held, d4 typed and Enter: the player means d4, and
//                                confirming c3 then would judge a move they had moved on from). Replacing never sends
//                                anything, so it doesn't wait like confirming does.
//   { type: 'button', which }    'confirm' or 'cancel'
//   { type: 'elsewhere' }        a tap anywhere else on the page
//   { type: 'leave' }            another puzzle, another page, the page hidden, the setting turned off
//   { type: 'phase', key }       the puzzle changed under it (phaseKey)
export function pendingAct(p, ev, now) {
  if (!p) return 'ignore';
  const ok = () => (busy('confirm', p.t, now) || busy('board', p.born, now) ? 'ignore' : 'confirm');
  switch (ev.type) {
    case 'tap': return ev.sq != null && ev.sq === p.sq ? ok() : 'cancel';
    case 'key': return ev.key === 'Escape' ? 'cancel' : ev.key !== 'Enter' || ev.repeat ? 'ignore' : ev.text ? 'replace' : ok();
    case 'button': return ev.which === 'confirm' ? ok() : 'cancel';
    case 'elsewhere': case 'leave': return 'cancel';
    case 'phase': return ev.key === p.key ? 'ignore' : 'cancel';
    default: return 'ignore';
  }
}

// Keys while a move is held (app.js): Enter confirms, Esc cancels; the board's other keys wait (arrows would browse away
// from the held position, number keys would lift stones); the rest (Tab to the buttons) work as usual. Enter isn't
// taken in a field, or on a button or link the keyboard focused (Confirm and Cancel included: Enter presses it, as
// always); Esc is taken everywhere but a field, those buttons too. The typed-move box (typed) is the board's.
//   { key, typed, field: in an input, select, textarea or contenteditable, bar: in the confirm bar,
//     control: on a keyboard-focused button or link }
export const HELD_KEYS = /^(Enter|Escape|Arrow(Left|Right|Up|Down)|Home|End|[1-8`])$/;
export function takesHeldKey({ key, typed, field, bar, control }) {
  if (!HELD_KEYS.test(key)) return false;
  if (typed) return key === 'Enter' || key === 'Escape'; // typing goes on
  if (field) return false;
  if (key === 'Escape') return true;
  return !bar && !control;
}

// Taps on tinue's board while a move is held (app.js; PTN Ninja's are inside its frame, out of the page's reach): its
// final square confirms, anything else on it cancels (tap(target)). Captured, so the board itself never sees them. A
// touch is decided on touchend as board.js does (a scroll or a pinch isn't a tap), and only one that began after the
// move was held.
export function holdTaps(el, board, { held, tap }) {
  let t0 = null;
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    t0 = held() && e.touches.length === 1 ? { x: t.clientX, y: t.clientY, p: held() } : null;
  }, { capture: true, passive: true });
  el.addEventListener('touchend', (e) => {
    const s = t0, t = e.changedTouches[0];
    t0 = null;
    if (!held() && !s) return;
    // board.js never sees this touch end, so its own record of the touch (and the long press it armed at touchstart)
    // is dropped here: else 500 ms on, once the board is back on, it placed a cap or wall (or lifted the stone just
    // confirmed). A touch begun while a move was held but ending after it went is swallowed by board.js for the same
    // reason (its touchend sees the new generation), so it isn't a tap on the position put back.
    board.dropGesture?.();
    if (!held()) return;
    e.stopPropagation(); if (e.cancelable) e.preventDefault(); // (no click follows)
    if (!s || s.p !== held() || e.touches.length || Math.hypot(t.clientX - s.x, t.clientY - s.y) > 10) return;
    tap(document.elementFromPoint(t.clientX, t.clientY));
  }, { capture: true, passive: false });
  el.addEventListener('click', (e) => { if (!held()) return; e.stopPropagation(); e.preventDefault(); tap(e.target); }, true);
}
