// Settings of the Settings page (#/settings): whether a finished move waits to be confirmed, and Sound (the board's
// look is ninja-look.js). They live in the browser's prefs with the others (and an account's settings: prefsync.js);
// off is the default. What app.js decides is here, so node can test it (scripts/test-settings.mjs).
// There is no Board setting any more (2026-11-22): PTN Ninja is the only board, whatever a stored setting or a
// ?board= in the address says.
import { busy } from './busy.js?v=1795483466';

export const confirmOn = (prefs) => prefs?.confirm === true;
// Sound: 'off', or the voice of the move sounds, 'light' | 'thunk' | 'deep' (sound.js VOICES). Nothing is stored until
// the setting changes; a value from before the voices (true, 'on') or none is the default voice, false or 'off' is off.
export const SOUND_DEFAULT = 'thunk';
export const soundOf = (prefs) => { const s = prefs?.sound; return s === false || s === 'off' ? 'off' : s === 'light' || s === 'thunk' || s === 'deep' ? s : SOUND_DEFAULT; };
export const soundOn = (prefs) => soundOf(prefs) !== 'off';
// The line under the Settings page's list: what isn't plain from the controls.
export function settingsNote({ unsaved } = {}) {
  return unsaved ? "Settings can't be saved in this browser." : '';
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

// Taps on the board's element while a move is held (app.js; PTN Ninja's taps are inside its frame, out of the page's reach, so these are taps around it): its
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
