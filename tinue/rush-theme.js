// The Rush end screen's pictures (rush-look.js) in the player's board theme: a PTN Ninja theme (tinue classic, a pasted
// one, or a built-in one as the embedded board reports it: ninja.js GET_THEME) turned into CSS custom properties that
// style.css lays over board.css's colours inside the end screen only (#rush-end.rt). tinue felt, or no theme known: none,
// and the pictures keep board.css's own felt. Pure (no DOM), so node tests it: scripts/test-rush-theme.mjs.
//
// What PTN Ninja draws for a theme, read off its embed (computed styles and pixels of ptn.ninja, 2026-11-23; behaviour
// only, no code taken):
// - the board is board1 (over the page's colour, colors.bg, when board1 is see-through); each square is a base with a
//   tile on it, the tile inset by a gap and rounded per boardStyle: grid1 1% (lines), grid2 3% and 5% corners, grid3 6%
//   and 15% corners, diamonds1/2/3 no gap and 10%/25%/50% corners (board2 showing at the corners: the diamonds, or
//   circles), blank no tile at all. A square's base is board2 and its tile board1; on a checkered board the dark squares
//   (a1's colour) swap: board1 under a board2 tile (blank: board2 on dark squares, board1 on light).
// - rings (theme.rings > 0): each square's tile tinted ring1..ring4 at vars['rings-opacity'] (default .25) by its band,
//   counted from the edge (ring1 outermost), or from the centre with fromCenter; the bands past the last ring take it.
// - stones: flats player1flat / player2flat, walls and capstones player1special / player2special, outlined in
//   player1border / player2border, vars['piece-border-width'] (default 1) wide.
// - coordinates: textLight on a dark square, textDark on a light one (dark: WCAG luminance under .4; on an unchecked
//   board every square counts as board1).
// - a theme missing colours (a pasted one: only primary, secondary, ui, player1 and player2 are required) gets them from
//   others: board1/board2/board3 from secondary (dark: 30/27/15% toward white; light: 27/30/15% toward black); a
//   player's flat, special and border from that player's colour (dark: 15/15/35% toward white; light: 5/15/35% toward
//   black); rings white at 27/53/80/100%. PTN Ninja leaves missing text colours white; tinue uses its own readable pair
//   instead, so coordinates never vanish on a light board.
// tinue's own marks on the pictures (the puzzle's move green, the wrong move red) keep their felt shades where those read
// at 3:1 or better on every square of the board; otherwise the shade of the same hue that reads best there.

// ---- colours ----
const clamp = (x) => Math.max(0, Math.min(255, x));
export function parse(c) {
  if (typeof c !== 'string') return null;
  let h = c.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(h) || ![3, 4, 6, 8].includes(h.length)) return null;
  if (h.length <= 4) h = [...h].map((x) => x + x).join('');
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}
const hex2 = (x) => Math.round(clamp(x)).toString(16).padStart(2, '0');
export const hex = (c) => '#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + (c.a < 1 ? hex2(c.a * 255) : '');
export const css = (c) => (c.a >= 1 ? hex(c) : `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${+c.a.toFixed(3)})`);
const mix = (c, t, k) => ({ r: c.r + (t - c.r) * k, g: c.g + (t - c.g) * k, b: c.b + (t - c.b) * k, a: c.a });
// c laid over an opaque colour u
export const over = (c, u) => ({ r: c.r * c.a + u.r * (1 - c.a), g: c.g * c.a + u.g * (1 - c.a), b: c.b * c.a + u.b * (1 - c.a), a: 1 });
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export const isDark = (c) => lum(c) < 0.4;
const hsl = (h, s, l) => {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a: 1 };
};

// ---- a theme, every colour PTN Ninja would draw it with ----
const STYLES = { grid1: [1, 0], grid2: [3, 5], grid3: [6, 15], diamonds1: [0, 10], diamonds2: [0, 25], diamonds3: [0, 50] };
const WHITE = { r: 255, g: 255, b: 255, a: 1 }, BLACK = { r: 0, g: 0, b: 0, a: 1 };
const TEXT = { light: parse('#fafafacd'), dark: parse('#212121cd') };
export function resolve(t) {
  if (!t || typeof t !== 'object' || !t.colors) return null;
  const C = {};
  for (const [k, v] of Object.entries(t.colors)) { const c = parse(v); if (c) C[k] = c; }
  if (!C.secondary || !C.player1 || !C.player2) return null;
  const sec = C.secondary, sd = isDark(sec), toward = (c, dark, kd, kl) => (dark ? mix(c, 255, kd) : mix(c, 0, kl));
  C.board1 ??= toward(sec, sd, 0.3, 0.27);
  C.board2 ??= toward(sec, sd, 0.27, 0.3);
  C.board3 ??= toward(sec, sd, 0.15, 0.15);
  for (const p of ['player1', 'player2']) {
    const c = C[p], d = isDark(c);
    C[p + 'flat'] ??= toward(c, d, 0.15, 0.05);
    C[p + 'special'] ??= toward(c, d, 0.15, 0.15);
    C[p + 'border'] ??= toward(c, d, 0.35, 0.35);
  }
  ['ffffff44', 'ffffff88', 'ffffffcc', 'ffffffff'].forEach((v, i) => { C['ring' + (i + 1)] ??= parse(v); });
  C.textLight ??= TEXT.light; C.textDark ??= TEXT.dark;
  C.umbra ??= parse('#00000033');
  C.primary ??= parse('#8bc34a');
  const vars = t.vars || {}, num = (v, d) => (Number.isFinite(+v) && v !== '' && v != null ? +v : d);
  return {
    style: STYLES[t.boardStyle] ? t.boardStyle : 'blank', checker: t.boardChecker === true,
    rings: Number.isInteger(t.rings) ? Math.max(0, Math.min(8, t.rings)) : 0, fromCenter: t.fromCenter === true,
    ringsOpacity: Math.max(0, Math.min(1, num(vars['rings-opacity'], 0.25))), border: Math.max(0, Math.min(6, num(vars['piece-border-width'], 1))),
    page: over(C.bg || sec, BLACK), C,
  };
}

// a1 is dark (PTN Ninja's .square.dark); k: the square's band counted from the board's edge (0 outermost)
export const darkSq = (sq, n) => (((sq / n) | 0) + (sq % n)) % 2 === 0;
export const bandOf = (sq, n) => { const r = (sq / n) | 0, c = sq % n; return Math.min(r, c, n - 1 - r, n - 1 - c); };

// The board as drawn: for a light ('l') and a dark ('d') square, its base, its tile (null: none) and the colour each
// band's ring adds; and each square's colour as seen in its middle (where a mark's ring sits), for the contrast checks.
export function boardOf(R, n = 6) {
  const board = over(R.C.board1, R.page), bands = Math.ceil(n / 2);
  const kind = (dark) => {
    if (R.style === 'blank') return { base: over(R.checker && dark ? R.C.board2 : { ...R.C.board1, a: 0 }, board), tile: null };
    if (R.checker && dark) { const base = board; return { base, tile: over(R.C.board2, base) }; }
    const base = over(R.C.board2, board);
    return { base, tile: over(R.C.board1, base) };
  };
  const l = kind(false), d = kind(true);
  const ring = [];
  for (let k = 0; k < bands; k++) {
    if (!R.rings) { ring.push(null); continue; }
    const i = Math.min(R.fromCenter ? bands - k : k + 1, R.rings, 4), c = R.C['ring' + i];
    ring.push(c ? { ...c, a: c.a * R.ringsOpacity } : null);
  }
  const seen = [];
  for (let sq = 0; sq < n * n; sq++) {
    const s = darkSq(sq, n) && R.checker ? d : l, under = s.tile || s.base, rg = ring[bandOf(sq, n)];
    seen.push(rg ? over(rg, under) : under);
  }
  return { board, l, d, ring, seen };
}

// ---- tinue's marks ----
export const FELT_MARKS = { good: '#a6e88a', bad: '#ff9a90' };
const HUE = { good: [100, 0.62], bad: [5, 0.9] };
export const FLOOR = 3;
// The mark's colour on these squares: the felt shade if it reads at FLOOR on every one of them, else the shade of its hue
// whose worst contrast there is best (the one nearest the felt shade among equals), its lightness kept within 22-80%
// so it still reads as green or red (and the two apart): on a mid-tone board with light and dark squares that can be
// under FLOOR. Then the mark gets a casing (an edge drawn under it, as the analysis page's lines have): the grey that,
// with the mark's shade chosen with it, reads best on every square while standing 3:1 off the mark itself.
// A board whose squares run from dark to light can't give any one colour 3:1 on all of them (best(): the most any colour
// can reach there); then the best it allows.
// Returns { color, min (the mark's own worst contrast on the squares), casing: null | { color, min (the casing's worst
// contrast on the squares), onMark (its contrast with the mark) }, floor (what the mark shows the squares: the better) }.
const worstOn = (seen) => { const ls = seen.map(lum); return (c) => { const l = lum(c); let w = Infinity; for (const x of ls) w = Math.min(w, (Math.max(l, x) + 0.05) / (Math.min(l, x) + 0.05)); return w; }; };
// the most contrast any single colour reaches on every one of these squares (white or black, whichever is better)
export const best = (seen) => { const w = worstOn(seen); return Math.max(w(WHITE), w(BLACK)); };
export function markOn(role, seen) {
  const worst = worstOn(seen);
  const felt = parse(FELT_MARKS[role]);
  if (worst(felt) >= FLOOR) return { color: hex(felt), min: worst(felt), casing: null, floor: worst(felt) };
  const [h, s] = HUE[role], fl = 0.75, shades = [];
  for (let i = 22; i <= 80; i++) { const c = hsl(h, s, i / 100); shades.push({ c, l: i / 100, w: worst(c) }); }
  // (the nearest the felt shade among equals)
  const better = (x, y) => !y || x.floor > y.floor + 1e-9 || (Math.abs(x.floor - y.floor) <= 1e-9 && Math.abs(x.l - fl) < Math.abs(y.l - fl));
  let top = null;
  for (const m of shades) { const x = { ...m, floor: m.w, casing: null }; if (better(x, top)) top = x; }
  if (top.floor < FLOOR) {
    let cased = null;
    // (greys, and black and white themselves, which a board of loud colours can need)
    for (let g = -1; g <= 101; g++) {
      const v = g < 0 ? 0 : g > 100 ? 255 : 11 + g * 2.39, gc = { r: v, g: v, b: g < 0 || g > 100 ? v : v - 2, a: 1 }, gw = worst(gc);
      for (const m of shades) {
        const on = contrast(gc, m.c);
        if (on < FLOOR) continue;
        const x = { ...m, floor: Math.max(m.w, gw), casing: { color: hex(gc), min: gw, onMark: on } };
        if (better(x, cased)) cased = x;
      }
    }
    if (cased && cased.floor > top.floor + 0.05) top = cased;
  }
  return { color: hex(top.c), min: top.w, casing: top.casing, floor: top.floor };
}
// The last move's thread (board.css .tb-cur) in the theme's primary where that reads at FLOOR on every square (as felt's
// straw does, 4.14:1), else the shade of the primary's hue and saturation nearest its own lightness that does; where
// none does, the one of any lightness (black or white too) that reads best there.
const toHsl = (c) => {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1)), h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, Math.min(1, s), l];
};
export function lineOn(pri, seen) {
  const shown = (c) => Math.min(...seen.map((s) => contrast(over(c, s), s)));
  const own = shown(pri);
  if (own >= FLOOR) return { color: css(pri), min: own };
  const [h, s, l0] = toHsl(pri);
  let near = null, top = null;
  for (let i = 0; i <= 200; i++) {
    const l = i / 200, c = parse(hex(hsl(h, s, l))), w = shown(c), x = { color: hex(c), min: w, l }; // (as written)
    if (w >= FLOOR && (!near || Math.abs(l - l0) < Math.abs(near.l - l0))) near = x;
    if (!top || w > top.min + 1e-9) top = x;
  }
  const pick = near || top;
  return { color: pick.color, min: pick.min };
}
// the figures on a mark's count disc: black or white, whichever reads better on it
const inkOn = (c) => (contrast(parse(c), BLACK) >= contrast(parse(c), WHITE) ? '#111111' : '#ffffff');

// ---- the pictures' custom properties ----
// t: a PTN Ninja theme object (null, or tinue felt's own: none, board.css's felt stays). n: the board's size.
// Returns null, or { vars: { '--rt-…': value }, marks: { good, bad, last (the last move's thread) } (each { color, min }) }.
export function pictureLook(t, n = 6) {
  if (!t) return null; // (felt comes as none: a pasted theme is drawn as pasted, whatever its id)
  const R = resolve(t);
  if (!R) return null;
  const B = boardOf(R, n), C = R.C, [gap, rad] = STYLES[R.style] || [0, 0];
  const tileOf = (s) => (s.tile ? css(s.tile) : 'transparent');
  // coordinates: PTN Ninja's text colour for the square, unless it doesn't read there (under 3:1): the other one then,
  // or tinue's readable pair
  const lab = (s, raw) => {
    const on = s.tile || s.base, pick = [isDark(raw) ? C.textLight : C.textDark, isDark(raw) ? C.textDark : C.textLight, TEXT.light, TEXT.dark];
    return css(pick.find((c) => contrast(over(c, on), on) >= 3) || pick[0]);
  };
  const good = markOn('good', B.seen), bad = markOn('bad', B.seen), last = lineOn(C.primary, B.seen);
  const vars = {
    '--rt-b1': css(B.board),
    '--rt-base-l': css(B.l.base), '--rt-base-d': css(R.checker ? B.d.base : B.l.base),
    '--rt-tile-l': tileOf(B.l), '--rt-tile-d': tileOf(R.checker ? B.d : B.l),
    '--rt-chip': css(B.l.tile || B.l.base), '--rt-gap': gap + '%', '--rt-rad': rad + '%',
    '--rt-lab-l': lab(B.l, C.board1), '--rt-lab-d': lab(R.checker ? B.d : B.l, R.checker ? C.board2 : C.board1),
    '--rt-p1': css(C.player1flat), '--rt-p1s': css(C.player1special), '--rt-p1b': css(C.player1border),
    '--rt-p2': css(C.player2flat), '--rt-p2s': css(C.player2special), '--rt-p2b': css(C.player2border),
    '--rt-bw': String(R.border), '--rt-um': css(C.umbra), '--rt-pri': last.color,
    '--rt-good': good.color, '--rt-bad': bad.color, '--rt-ink-good': inkOn(good.color), '--rt-ink-bad': inkOn(bad.color),
    '--rt-case-good': good.casing?.color || 'transparent', '--rt-case-bad': bad.casing?.color || 'transparent',
  };
  B.ring.forEach((c, k) => { vars['--rt-ring-' + k] = c ? css(c) : 'transparent'; });
  return { vars, marks: { good, bad, last } };
}
