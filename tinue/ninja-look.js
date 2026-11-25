// The PTN Ninja look (Settings page): a player pastes a theme's code (PTN Ninja's theme editor shares it as JSON), a
// theme's name, a ptn.ninja link or just its settings (&axisLabels=false&theme=…), and tinue's embedded PTN Ninja
// (ninja.js) takes the settings that only change how the board looks. Pure, so node
// tests it (scripts/test-ninja-look.mjs). Nothing pasted ever reaches the page as HTML, and the iframe's address is
// only ever https://ptn.ninja/ plus the settings below, each value checked.
//
// How PTN Ninja reads its address (its README "URLs" and src/router/routes.js, read 2026-11-20; behaviour only, no code
// taken): https://ptn.ninja/<PTN>&key=value&key=value. Everything from the first & on is split at & and =; the values
// true and false become booleans and anything else stays text (so a number is "7", which its sliders read as 7).
// name and targetBranch are lz-string compressed; theme is a built-in theme's id or a theme as JSON, either one usually
// lz-string compressed (its own Share links compress even an id), and it falls back to the default when unreadable.
// The same settings can be sent later as one SET_UI message (README "API"), where theme is an id or a theme object.
import { compressToEncodedURIComponent as lz, decompressFromEncodedURIComponent as unlz } from './vendor/lz-string.js?v=1795581690';

// The settings tinue passes on, with the kind of value each takes (b: true/false, p: a whole number 1 to 10, t: a
// theme). index.html's early iframe start has the same table (scripts/test-ninja-look.mjs holds them together).
// All of them only change how the board is drawn. perspective is PTN Ninja's 3D slider (1 to 10).
export const LOOK = {
  axisLabels: 'b', axisLabelsSmall: 'b', board3D: 'b', orthographic: 'b', perspective: 'p', centerStackCounts: 'b',
  stackCounts: 'b', flatCounts: 'b', flatWinHighlights: 'b', moveNumber: 'b', turnIndicator: 'b', verticalLayout: 'b',
  verticalLayoutAuto: 'b', theme: 't',
};
// PTN Ninja settings tinue keeps to itself, because its embed needs them as they are (ninja.js UI and ui()): input
// and navigation off, panels hidden, notices and clocks off, its own animation switching, no road or square highlights
// of PTN Ninja's own (they would give puzzles away, and the square highlights carry tinue's hints and engine lines),
// the stone tray (the only way to pick a wall or a capstone with stone cycling off), and evaluations (tinue's own).
export const KEPT = new Set(['disableBoard', 'disableNavigation', 'disablePTN', 'disablePTNTools', 'disableText', 'disableUndo',
  'disableStoneCycling', 'showPTN', 'showText', 'showControls', 'showScrubber', 'showHeader', 'showEval', 'showMove',
  'showPlayButton', 'showAllBranches', 'showAnalysisBoard', 'showBoardPrefsBtn', 'showBoardTransformBtn', 'showToolbarAnalysis',
  'showHints', 'notifyGame', 'notifyNotes', 'notifyAnalysisNotes', 'gameTimer', 'animateBoard', 'animateScrub', 'showRoads',
  'highlightSquares', 'unplayedPieces', 'boardEvalBar', 'evalText', 'inlineBranches', 'playSpeed', 'boardTransform',
  'boardRotation', 'player', 'size', 'komi', 'firstMoveNumber', 'scrollNavigation', 'hapticNavControls', 'skipToEndOnLoad']);
// The game in a pasted link, not a setting: dropped without a word.
const GAME = new Set(['name', 'ply', 'targetBranch', 'tps', 'state']);
// PTN Ninja's built-in themes (src/themes.js).
export const THEMES = ['aaron', 'aer', 'aether', 'aqua', 'atlas', 'backlit', 'bubbletron', 'classic', 'discord', 'essence',
  'fresh', 'ignis', 'luna', 'paper', 'retro', 'stealth', 'terra', 'zen'];
export const MAX = 1500; // the stored string, at most (it is synced: server settings take 2000 characters a value)
const MAX_IN = 20000; // what a paste may be before it isn't read at all

// ---- a theme as JSON (PTN Ninja's export: id, name, boardStyle, boardChecker, fromCenter, rings, vars, colors) ----
// Kept only in that shape, every colour a #hex colour and every var a number or a short plain value: PTN Ninja writes
// them into CSS custom properties, and nothing else of a pasted theme goes anywhere.
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const NEED = ['primary', 'secondary', 'ui', 'player1', 'player2']; // what PTN Ninja works the rest of a theme out from
export function cleanTheme(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t) || !t.colors || typeof t.colors !== 'object' || Array.isArray(t.colors)) return null;
  const colors = {};
  for (const [k, v] of Object.entries(t.colors)) if (/^[a-zA-Z][a-zA-Z0-9]{0,23}$/.test(k) && typeof v === 'string' && HEX.test(v)) colors[k] = v;
  if (!NEED.every((k) => colors[k])) return null;
  const out = { id: typeof t.id === 'string' && /^[\w-]{1,40}$/.test(t.id) && !THEMES.includes(t.id) ? t.id : 'custom' };
  if (typeof t.name === 'string') { const nm = t.name.replace(/[^\w ’'.-]/g, '').slice(0, 40).trim(); if (nm) out.name = nm; }
  if (typeof t.boardStyle === 'string' && /^[a-z]{1,12}[0-9]?$/.test(t.boardStyle)) out.boardStyle = t.boardStyle;
  for (const k of ['boardChecker', 'fromCenter']) if (typeof t[k] === 'boolean') out[k] = t[k];
  if (Number.isInteger(t.rings) && t.rings >= 0 && t.rings <= 8) out.rings = t.rings;
  if (t.vars && typeof t.vars === 'object' && !Array.isArray(t.vars)) {
    const vars = {};
    for (const [k, v] of Object.entries(t.vars)) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(k)) continue;
      if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1000) vars[k] = v;
      else if (typeof v === 'string' && /^[\w .%#-]{1,24}$/.test(v)) vars[k] = v;
    }
    if (Object.keys(vars).length) out.vars = vars;
  }
  out.colors = colors;
  return out;
}
// tinue's board as it was until 2026-11-21 (Lichess-style brown checkers), as a PTN Ninja theme: the "tinue classic"
// choice of the theme select (named "tinue legacy" until 2026-11-22; looks stored then carry that name). Stored like a
// pasted theme (PTN Ninja doesn't know it by name).
export const LEGACY = cleanTheme({
  id: 'tinue-legacy', name: 'tinue classic', boardStyle: 'blank', boardChecker: true,
  vars: { 'piece-border-width': 1 },
  colors: {
    primary: '#9cb83a', secondary: '#161512', ui: '#262421', accent: '#302e2c', panel: '#262421c0',
    board1: '#f0d9b5', board2: '#b58863', board3: '#262421',
    player1: '#f6f1e7', player1road: '#f6f1e7', player1flat: '#f6f1e7', player1special: '#ffffff', player1border: '#8f8473',
    player2: '#2f2c29', player2road: '#4a4540', player2flat: '#2f2c29', player2special: '#3d3935', player2border: '#0d0c0b',
    textLight: '#fafafacd', textDark: '#212121cd', umbra: '#00000033',
  },
});
// Known by its id and one of its names, not its colours: a look stored before LEGACY last changed (or was renamed) still
// reads as tinue classic, and reading it (readTheme) gives today's LEGACY, so a change to it reaches everyone who picked it.
const LEGACY_NAMES = new Set(['tinue classic', 'tinue legacy']);
const isLegacy = (t) => !!t && typeof t === 'object' && t.id === LEGACY.id && LEGACY_NAMES.has(t.name);
// What can be typed for it, in any case and spacing: 'classic' alone is PTN Ninja's own Classic.
const LEGACY_SAID = new Set(['legacy', 'tinue-legacy', 'tinue legacy', 'tinue classic', 'classic tinue', 'tinue-classic']);
// A built-in theme by its id or by PTN Ninja's name for it, in any case ('Zen', 'BubbleTron'); or tinue classic.
const named = (v) => { const l = v.toLowerCase().trim().replace(/\s+/g, ' '); return THEMES.includes(l) ? { id: l } : LEGACY_SAID.has(l) ? { theme: LEGACY } : null; };
// A theme value as pasted: a built-in id or name, or an id or JSON, lz-compressed or plain (JSON as PTN Ninja's theme
// editor shares it, pretty-printed or not). { id } | { theme } | null.
function readTheme(v) {
  const b = named(v);
  if (b) return b;
  let s = null;
  if (v.startsWith('{')) s = v;
  else if (v.length <= MAX && /^[A-Za-z0-9+$ -]+$/.test(v)) {
    s = unlz(v);
    const id = s && named(s);
    if (id) return id;
    if (!(s && s.startsWith('{'))) return null;
  } else return null;
  try { const t = cleanTheme(JSON.parse(s)); return t ? { theme: isLegacy(t) ? LEGACY : t } : null; } catch { return null; }
}
// What tinue says to a link of PTN Ninja's own that has no look in it: none of its share links carry one.
export const NO_LOOK_LINK = 'PTN Ninja’s game links don’t carry its look. Choose a theme above, or paste a theme’s code from PTN Ninja’s theme editor.';

// ---- reading a paste ----
// { look: { key: value } as tinue keeps it, applied: [keys], kept: [keys], unknown: [keys], bad: [keys], error } where
// error is a plain sentence for a paste that isn't usable at all. A key repeated: the last one counts, as in PTN Ninja.
const safeKey = (k) => /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(k);
export function parseLook(input) {
  const res = { look: {}, applied: [], kept: [], unknown: [], bad: [], error: '' };
  let s = typeof input === 'string' ? input.trim() : '';
  if (!s) return res;
  if (s.length > MAX_IN) return { ...res, error: 'That is too long to be PTN Ninja settings.' };
  // tinue classic by name, spaces and all ('tinue classic', 'classic tinue')
  if (/^[A-Za-z -]+$/.test(s) && named(s)?.theme) { res.look.theme = LEGACY; res.applied.push('theme'); return res; }
  // a theme on its own: its code (JSON), a built-in theme's name, or a theme value as a link carries it (lz-compressed)
  if (s.startsWith('{') || /^[A-Za-z0-9+$-]+$/.test(s)) {
    const t = readTheme(s);
    if (t) { res.look.theme = t.id ?? t.theme; res.applied.push('theme'); }
    else if (s.startsWith('{')) return { ...res, error: 'That theme’s code could not be read.' };
    if (t) { if (encodeLook(res.look).length > MAX) return { ...res, look: {}, applied: [], error: 'That theme is too big to keep.' }; return res; }
  }
  // a link: only ptn.ninja's (with or without https://); anything else with a scheme is refused
  let link = false;
  if (/^(?:https?:\/\/)?(?:www\.)?ptn\.ninja(?:[/?#]|$)/i.test(s)) {
    let u;
    try { u = new URL(/^https?:/i.test(s) ? s : 'https://' + s); } catch { return { ...res, error: 'That link could not be read.' }; }
    if (!/^(www\.)?ptn\.ninja$/i.test(u.hostname) || u.username || u.password || u.port) return { ...res, error: 'Only ptn.ninja links can be used here.' };
    s = u.pathname.slice(1) + (u.hash.startsWith('#/') ? u.hash.slice(2) : '');
    const at = s.indexOf('&');
    s = at < 0 ? '' : s.slice(at);
    if (u.search.length > 1) s += '&' + u.search.slice(1); // settings written as a query (?theme=zen): read the same
    link = true;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//') || /^[\w-]+(\.[\w-]+)+\//.test(s)) {
    return { ...res, error: 'Only ptn.ninja links can be used here.' };
  } else if (!s.startsWith('&')) {
    if (/^[A-Za-z][A-Za-z0-9]*=/.test(s)) s = '&' + s; // just the settings, without the leading &
    else { const at = s.indexOf('&'); s = at < 0 ? '' : s.slice(at); } // a game's PTN first: the settings follow it
  }
  const seen = new Map(); // key -> raw value, the last one counting
  for (const item of s.split('&')) {
    if (!item) continue;
    const eq = item.indexOf('='), k = eq < 0 ? item : item.slice(0, eq);
    let v = eq < 0 ? '' : item.slice(eq + 1);
    try { v = decodeURIComponent(v); } catch {}
    if (!safeKey(k) || GAME.has(k)) continue;
    seen.delete(k); seen.set(k, v);
  }
  for (const [k0, v] of seen) {
    const k = k0 === 'themeID' ? 'theme' : k0;
    const kind = LOOK[k];
    if (!kind) { (KEPT.has(k) ? res.kept : res.unknown).push(k0); continue; }
    let val = null;
    if (kind === 'b') val = v === 'true' ? true : v === 'false' ? false : null;
    else if (kind === 'p') val = /^(?:[1-9]|10)$/.test(v) ? +v : null;
    else { const t = readTheme(v); val = t ? t.id ?? t.theme : null; }
    if (val == null) { res.bad.push(k0); delete res.look[k]; res.applied = res.applied.filter((x) => x !== k); continue; }
    res.look[k] = val;
    if (!res.applied.includes(k)) res.applied.push(k);
  }
  // the stored form must fit: a custom theme is the only thing that can make it too long
  if (encodeLook(res.look).length > MAX) { delete res.look.theme; res.applied = res.applied.filter((x) => x !== 'theme'); res.bad.push('theme'); }
  // a game link as PTN Ninja makes them (its Share, its short links ptn.ninja/s/…): PTN, name and ply only, never a look
  if (link && !res.applied.length && !res.kept.length && !res.unknown.length && !res.bad.length) res.error = NO_LOOK_LINK;
  return res;
}

// ---- the stored form: &key=value in LOOK's order, the theme lz-compressed as PTN Ninja writes its own links ----
export function encodeLook(look) {
  let out = '';
  for (const [k, kind] of Object.entries(LOOK)) {
    if (!(k in look)) continue;
    const v = look[k];
    out += '&' + k + '=' + (kind === 't' ? lz(typeof v === 'string' ? v : JSON.stringify(v)) : String(v));
  }
  return out;
}
// A stored string (this device's, or the account's from the server: never trusted) back in its stored form: what is
// usable of it, or ''.
export const cleanLook = (stored) => (typeof stored === 'string' && stored.length <= MAX ? encodeLook(parseLook(stored).look) : '');
// The stored string as SET_UI values (the theme as an id or an object), for ninja.js.
export const lookUi = (stored) => (typeof stored === 'string' && stored.length <= MAX ? parseLook(stored).look : {});
// The stored string as the paste box shows it: the same settings, a built-in theme by its id and tinue classic as
// tinue-classic (both read back as they are), only a theme of the player's own still compressed.
export function showLook(stored) {
  const look = lookUi(stored);
  let out = '';
  for (const [k, kind] of Object.entries(LOOK)) {
    if (!(k in look)) continue;
    const v = look[k];
    out += '&' + k + '=' + (kind !== 't' ? String(v) : typeof v === 'string' ? v : isLegacy(v) ? 'tinue-classic' : lz(JSON.stringify(v)));
  }
  return out;
}

// ---- the theme select (Settings page): the same stored string as the paste box, so the two stay one setting ----
// What it shows for a stored look: '' (tinue felt), a built-in id, 'legacy' (tinue classic) or 'custom' (a pasted
// theme of the player's own).
export const themeOf = (stored) => { const t = lookUi(stored).theme; return t == null ? '' : typeof t === 'string' ? t : isLegacy(t) ? 'legacy' : 'custom'; };
// The stored look with its theme changed to `id` ('' for tinue's own); its other settings kept. 'custom' or anything not
// built in changes nothing.
export function withTheme(stored, id) {
  const look = lookUi(stored);
  if (id === '') delete look.theme; else if (THEMES.includes(id)) look.theme = id; else if (id === 'legacy') look.theme = LEGACY; else return cleanLook(stored);
  return encodeLook(look);
}
// PTN Ninja's names for them (its en-us strings)
export const themeName = (id) => (id === 'bubbletron' ? 'BubbleTron' : id[0].toUpperCase() + id.slice(1));

// ---- the iframe's address ----
// tinue's own embed settings (base, '&k=v…') with the stored look laid over them: a key in both takes the look's value
// in place, the others follow. Only LOOK's keys with a value of the right form pass (true/false, 1 to 10, a compressed
// theme), so storage edited by hand can't put anything else into the address. index.html does the same before the
// modules load (its copy is tested against this one).
const FORM = { b: /^(true|false)$/, p: /^([1-9]|10)$/, t: /^[A-Za-z0-9$+-]{1,1500}$/ };
export function frameParams(base, stored) {
  let out = base;
  if (typeof stored !== 'string' || stored.length > MAX) return out;
  for (const item of stored.split('&')) {
    const eq = item.indexOf('='), k = item.slice(0, eq), v = item.slice(eq + 1);
    if (eq < 1 || !Object.prototype.hasOwnProperty.call(LOOK, k) || !FORM[LOOK[k]].test(v)) continue;
    out = out.replace(new RegExp('&' + k + '=[^&]*'), '') + '&' + k + '=' + v;
  }
  return out;
}

// ---- the frame's shape ----
// How PTN Ninja sizes its board to the frame (its src/components/board/Board.vue, read 2026-11-21; behaviour only): the
// whole board (flat-count row, squares, stone tray, labels) keeps one aspect ratio. In a frame taller than that it fills
// the width less a margin of 10% (at least 32 px), centred; in a wider one it fits the height and also keeps a 44 px row
// on top for its buttons. So the frame is made a little taller than the board and wider than the host by that margin,
// and the host shows only the board: its squares come out as big as tinue's own (the host's width over the size).
// The CSS for the host (#board) and the frame; null for a 3D board, which tilts into the margin and is shown whole.
const EM = 0.04375; // PTN Ninja's em, as a share of the board's width
const SLACK = 1.01; // the frame 1% taller than the board: still clearly "taller", whatever the rounding
export function frameBox(look = {}, size = 6) {
  if (look.board3D) return null;
  const on = (k, d) => (k in look ? look[k] === true : d);
  const labels = on('axisLabels', true) && !on('axisLabelsSmall', true) ? 1.5 * EM : 0;
  const turn = on('turnIndicator', true) ? 2.25 * EM : 0, num = on('moveNumber', false) ? 1.75 * EM : 0;
  // its vertical layout (the tray under the board) whenever it is on: tinue's frame is always taller than wide then
  const [w, h] = on('verticalLayout', true) ? [labels + 1, num + turn + 1 + 1 / size + labels] : [labels + 1 + 1.75 / size, Math.max(turn, num) + 1 + labels];
  const r = w / h, f = (x) => +x.toFixed(5);
  return { ratio: f(r), host: `aspect-ratio:${f(r)};overflow:hidden`,
    frame: `width:${f(100 / 0.9)}%;margin:${f(-(100 / r) * (SLACK / 0.9 - 1) / 2)}% 0 0 ${f(-100 / 0.9 * 0.05)}%;aspect-ratio:${f(r / SLACK)}` };
}
// The same shape as numbers, for a frame laid over a box rather than put in it (Rush, ninja.js borrow): per unit of the
// board's width, the frame's width and height and where its top left corner sits from the board's. null for 3D.
export function frameGeom(look = {}, size = 6) {
  const b = frameBox(look, size);
  if (!b) return null;
  const r = b.ratio;
  return { ratio: r, w: 1 / 0.9, h: SLACK / 0.9 / r, x: -0.05 / 0.9, y: -(1 / r) * (SLACK / 0.9 - 1) / 2 };
}

// ---- what the Settings page says under the field ----
const NAMES = { axisLabels: 'axis labels', axisLabelsSmall: 'axis labels inside the board', board3D: '3D board', orthographic: 'flat 3D view',
  perspective: '3D perspective', centerStackCounts: 'centred stack counts', stackCounts: 'stack counts', flatCounts: 'flat counts',
  flatWinHighlights: 'flat win highlights', moveNumber: 'move number', turnIndicator: 'turn indicator', verticalLayout: 'vertical layout',
  verticalLayoutAuto: 'automatic layout' };
const said = (k, v) => k === 'theme' ? (typeof v === 'string' ? `theme ${v}` : isLegacy(v) ? 'theme tinue classic' : 'a custom theme')
  : k === 'perspective' ? `3D perspective ${v}` : `${NAMES[k]} ${v ? 'on' : 'off'}`;
const list = (ks) => ks.slice(0, 12).join(', ') + (ks.length > 12 ? ` and ${ks.length - 12} more` : '');
// Plain text (the page sets it as textContent). The keys listed are only ever [A-Za-z0-9] (safeKey).
export function lookReport(res) {
  if (res.error) return res.error;
  const out = [];
  if (res.applied.length) out.push('Using ' + res.applied.map((k) => said(k, res.look[k])).join(', ') + '.');
  if (res.kept.length) out.push('Left out, because tinue sets these itself: ' + list(res.kept) + '.');
  if (res.bad.length) out.push('Could not read the value of ' + list(res.bad) + '.');
  if (res.unknown.length) out.push('Not PTN Ninja board settings: ' + list(res.unknown) + '.');
  if (!res.applied.length) out.unshift('No PTN Ninja look settings found in that, so nothing changed.');
  return out.join(' ');
}
