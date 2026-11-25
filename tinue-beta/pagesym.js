// A puzzle page visit under one of the board's 8 symmetries (shared/sym.js): a puzzle opened from a Rush run's list
// shows as the player saw it in the run (Sasha, 2026-11-19). The page orients the puzzle once, on arrival (loadById:
// orientPage), and works in the turned labels everywhere (board, tree, history, hints, solution, play-out); only what
// leaves the page is turned back, at one boundary (toServer), so the server, the judge and the engine checks see
// exactly what a visit in the puzzle's own orientation would send. Colours are never swapped (sym.js), so Rush's
// symmetries are the only transformation in play.
// The symmetry belongs to the visit: it lives in the address as a last hash segment, #/puzzle/<id>/<s> (puzzleHash),
// on both builds. Not the query string (it rides along to every page) and not the path (a static per-puzzle page
// forwards to #/puzzle/<id> and drops any hash; <id>/<s> has no page at all).
// Pure, no DOM: node tests in scripts/test-pagesym.mjs.
import * as SYM from './shared/sym.js?v=1795581795';
import { Game } from './shared/tak.js?v=1795581795';

// An address's symmetry segment: 1..7, else 0 (missing, stale or malformed is ignored).
export const symOf = (seg) => (typeof seg === 'string' && /^[1-7]$/.test(seg) ? +seg : 0);
// The in-page hash route of a puzzle under s (s = 0: exactly the route the app always used).
export const puzzleHash = (id, s = 0) => '#/puzzle/' + encodeURIComponent(id) + (symOf(String(s)) ? '/' + s : '');

const mapMeta = (meta, s, n) => {
  if (!meta || typeof meta !== 'object') return meta;
  const q = { ...meta };
  // The history starts from the empty board, which every symmetry fixes, so mapping it move by move is exact.
  if (Array.isArray(meta.history)) q.history = meta.history.map((m) => SYM.move(s, n, m));
  if (meta.dragon && typeof meta.dragon === 'object' && Array.isArray(meta.dragon.path)) q.dragon = { ...meta.dragon, path: meta.dragon.path.map((m) => SYM.move(s, n, m)) };
  return q;
};
// The puzzle as the page gets it (GET /api/puzzle/<id>) under s: sym.js orient (tps, tree, alts, altsAt) plus the game
// history the page builds its board and lines from. New objects only: the server's puzzle (kept by next.js too) is
// never touched. s = 0 returns p itself, so an ordinary visit is exactly what it always was.
export function orientPage(p, s) {
  if (!p || !symOf(String(s))) return p;
  return { ...SYM.orient(p, s), ...('meta' in p ? { meta: mapMeta(p.meta, s, p.size) } : {}) };
}
// The puzzle in its own orientation again (tests; the page keeps the server's object instead).
export function unorientPage(q) {
  const s = q?.sym || 0;
  if (!s) return q;
  const inv = SYM.inverse(s), p = SYM.unorient(q);
  if ('meta' in q) p.meta = mapMeta(q.meta, inv, q.size);
  return p;
}

// Engine and server answers: the fields that name moves (Syntaks's pv/best, /api/defend's move, the worker's reply/pv/
// threat, Tiltak's bestmove).
const MOVE_KEYS = ['move', 'best', 'reply', 'threat', 'bestmove'];
// The page's boundary with everything outside it, for a visit under s on an n×n board. back: a move in the page's labels
// to the puzzle's own; fwd: the other way. tps(t): a position the page holds, as the same position reached in the
// puzzle's own orientation writes it (Game.toTPS), so a request carries the bytes an ordinary visit's would. log: a
// result's move log turned back (copies). answer(r): an engine's answer about a turned-back position, in the page's
// labels (analysis(r): /api/analyze with its lines; facts(r): the worker's engine.lines). With s = 0 every one of them
// returns its argument itself.
export function toServer(s, n) {
  s = symOf(String(s));
  if (!s) { const id = (v) => v; return { sym: 0, back: id, fwd: id, tps: id, log: id, answer: id, analysis: id, facts: id }; }
  const inv = SYM.inverse(s);
  const back = (m) => SYM.move(inv, n, m), fwd = (m) => SYM.move(s, n, m);
  const answer = (r) => {
    if (!r || typeof r !== 'object') return r;
    const o = { ...r };
    for (const k of MOVE_KEYS) if (typeof r[k] === 'string') o[k] = fwd(r[k]);
    if (Array.isArray(r.pv)) o.pv = r.pv.map(fwd);
    return o;
  };
  // /api/analyze?lines=N's answer: the top level as answer() does, and each of its lines ({ move, pv, ... }) too.
  const analysis = (r) => {
    const o = answer(r);
    if (o && typeof o === 'object' && Array.isArray(r.lines)) o.lines = r.lines.map(answer);
    return o;
  };
  // The tactics worker's analysis facts (engine.lines, analysis.js solverLines): its move lists and the verdicts keyed
  // by the (turned back) pinned moves, in the page's labels. Lists keep their order; SYM.move is a bijection on moves,
  // so a key turned back and forward again is the move the page asked about.
  const list = (a) => (Array.isArray(a) ? a.map(fwd) : a);
  const facts = (r) => {
    if (!r || typeof r !== 'object') return r;
    const o = { ...r, wins1: list(r.wins1), wins3: list(r.wins3), threats: list(r.threats) };
    if (r.pinned && typeof r.pinned === 'object') o.pinned = Object.fromEntries(Object.entries(r.pinned).map(([k, v]) => [fwd(k), v]));
    return o;
  };
  return {
    sym: s, back, fwd, answer, analysis, facts,
    tps: (t, komi = 0) => Game.fromTPS(SYM.tps(inv, t), komi).toTPS(),
    log: (log) => (Array.isArray(log) ? log.map((e) => (e && typeof e.m === 'string' ? { ...e, m: back(e.m) } : e)) : log),
  };
}
