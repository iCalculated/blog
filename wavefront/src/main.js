import * as K from './consts.js';
import { Dream, initWorld } from './gpu.js';
import { DreamRenderer } from './render.js';
import { makeBot, BOT_NOTES } from './bots.js';

const $ = (id) => document.getElementById(id);
const H = K.HD, KEY = 'wavefront.dream.v2', FPS = 60, DT = 1000 / FPS;
const KEEP = [H.dreamDecisions, H.ppoUpdates, H.round, H.aiWins, H.pWins];

let mode = 'mega', running = false, paused = false, rbBusy = false, lastJob = null, dead = false;
function fatal(msg) {   // replace the start overlay with a message; the game stops for good
  dead = true; running = false;
  const s = $('start'), h = document.createElement('h1'), p = document.createElement('p');
  h.textContent = 'wavefront'; p.textContent = msg; s.replaceChildren(h, p);
  s.classList.remove('hidden'); $('paused').classList.add('hidden');
}

let D, R, mouse = { x: K.AW / 2, y: K.AH / 2 };
try {
  D = await Dream.create();
  R = new DreamRenderer(D, $('game'));
  R.mouse = mouse;
  await R.compiled;
} catch (e) {
  fatal(navigator.gpu ? `couldn't start the gpu (${e.message}). try reloading, or another browser.`
    : "this needs webgpu, which this browser doesn't offer. try chrome, edge, or safari 26.");
  throw e;
}
D.device.lost.then((info) => { if (info.reason !== 'destroyed') fatal('gpu lost — reload the page'); });
$('backend').textContent = `webgpu · ${D.adapterInfo.vendor || 'gpu'} ${D.adapterInfo.architecture || ''}`.trim();

const fresh = () => initWorld(D.seed).slice(0, K.gEnv + K.EST);   // what the panel shows until the first readback
let W = fresh();
const eng = { gpuMs: null, disp: 0 };
let history = [], bucket = { base: null, frames: 0 };   // history: completed 30 s buckets of {dealt, taken}

// ---------- input ----------
const keys = new Set(); let firing = false;
const CTL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Enter', 'Home', 'End', 'PageUp', 'PageDown']);
addEventListener('keydown', (e) => {
  // a focused slider or button keeps the keys it uses (sliders: arrows; buttons: enter/space); letters still drive
  if (e.target instanceof Element && e.target.closest('input, button, select, textarea') && CTL_KEYS.has(e.key)) return;
  if ((e.key === 'Enter' || e.key === ' ') && (!running || paused)) { e.preventDefault(); if (!running) start(); else setPaused(false); return; }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  if (e.key === 'p' || e.key === 'Escape') { if (running) setPaused(!paused); return; }
  keys.add(e.key.toLowerCase());
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => { keys.clear(); firing = false; if (running && !pumping && opp === 'you') setPaused(true); if (running) save(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden || !running) return; if (!pumping) setPaused(true); save(); });
const canvas = $('game');
canvas.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); mouse = { x: ((e.clientX - r.left) / r.width) * K.AW, y: ((e.clientY - r.top) / r.height) * K.AH }; if (opp === 'you') R.mouse = mouse; });
canvas.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; firing = true; try { canvas.setPointerCapture(e.pointerId); } catch {} });
addEventListener('pointerup', (e) => { if (e.button === 0) firing = false; });
canvas.addEventListener('pointercancel', () => (firing = false));
canvas.addEventListener('lostpointercapture', () => (firing = false));
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
function start() { if (dead || running) return; running = true; $('start').classList.add('hidden'); setPaused(false); }
$('start').addEventListener('click', start);
$('paused').addEventListener('click', () => setPaused(false));
function setPaused(v) { paused = v; $('paused').classList.toggle('hidden', !v); }
function readInput() {
  const k = (...n) => n.some((x) => keys.has(x));
  return { thr: (k('w', 'arrowup') ? 1 : 0) - (k('s', 'arrowdown') ? 1 : 0), turn: (k('d', 'arrowright') ? 1 : 0) - (k('a', 'arrowleft') ? 1 : 0),
    mx: mouse.x, my: mouse.y, fire: firing || keys.has(' ') };
}

// ---------- the other tank: you, a scripted bot, the self-play champion, or itself ----------
// It keeps learning whoever drives the other tank: its model of the opponent retrains on the new
// driver's moves and its dreams follow, so switching shows it adapt.
const OPP_NOTES = { you: 'you drive the cyan tank.', ...BOT_NOTES,
  champion: 'a policy trained offline by self-play (the same net, observations and physics), frozen. it never changes; watch the learner figure it out.',
  itself: 'its own current policy drives the other tank too: live self-play. its model of the opponent is then a model of itself.' };
let opp = 'you', oppBot = null, champ = null;
async function setOpp(name, store = true) {
  if (!(name in OPP_NOTES)) return;
  if (name === 'champion' && !champ) {
    try { const j = await (await fetch('assets/champion.json')).json(); D.setChampion(j.actor); champ = j; }
    catch (e) { $('oppNote').textContent = `couldn't load the champion (${e.message}).`; return; }
  }
  opp = name; oppBot = BOT_NOTES[name] ? makeBot(name) : null;
  D.opp = name === 'champion' || name === 'itself' ? 1 : 0; D.oppSelf = name === 'itself' ? 1 : 0;
  if (name === 'you') R.mouse = mouse;
  document.querySelectorAll('#opps button').forEach((x) => x.classList.toggle('on', x.dataset.opp === name));
  $('oppNote').textContent = OPP_NOTES[name];
  document.querySelectorAll('.oppName').forEach((x) => (x.textContent = name === 'you' ? 'you' : name));
  if (store) try { localStorage.setItem('wavefront.opp', name); } catch {}
  panel();
}
document.querySelectorAll('#opps button').forEach((b) => b.addEventListener('click', () => { setOpp(b.dataset.opp); b.blur(); }));
// one frame of the other tank's controls (ignored by the gpu when a net drives it)
function oppInput() {
  if (opp === 'you') return readInput();
  const ai = { x: W[tank(0, 'x')], y: W[tank(0, 'y')] };
  const inp = oppBot ? oppBot(W) : { thr: 0, turn: 0, mx: ai.x, my: ai.y, fire: false };
  R.mouse = oppBot ? { x: inp.mx, y: inp.my } : ai;   // the aim line follows its aim point
  return inp;
}

// ---------- ui ----------
document.querySelectorAll('#modes button').forEach((b) => b.addEventListener('click', () => {
  mode = b.dataset.mode; eng.gpuMs = null;
  document.querySelectorAll('#modes button').forEach((x) => x.classList.toggle('on', x === b));
}));
const VIEWS = ['off', 'futures', 'training dreams'];
$('ghosts').addEventListener('click', () => { R.view = (R.view + 1) % 3; D.viz = R.view === 1; $('ghosts').textContent = `show: ${VIEWS[R.view]}`; });
// Reset = start from scratch: random policy, blank model of you, new match at 0–0. The sliders are kept.
// (A two-click confirm in the page: browser confirm() dialogs are blocked in some embeds.)
let armed = null, gen = 0;
$('forget').addEventListener('click', () => {
  const b = $('forget');
  if (dead) return;
  if (!armed) {
    b.textContent = 'click again to reset'; b.style.color = 'var(--coral)';
    armed = setTimeout(() => { armed = null; b.textContent = 'reset ai to random'; b.style.color = ''; }, 3000);
    return;
  }
  clearTimeout(armed); armed = null; b.textContent = 'reset ai to random'; b.style.color = '';
  b.blur();                                // so enter starts the game instead of re-arming this
  try { localStorage.removeItem(KEY); } catch {}
  gen++;                                   // ignore readbacks and saves still in flight from before the reset
  D.seed = (Math.random() * 2 ** 32) >>> 0; D.reset();
  W = fresh(); history = []; bucket = { base: null, frames: 0 };
  saveT = performance.now();
  running = false; setPaused(false);
  $('start').querySelector('.go').textContent = 'fresh ai: random again, knows nothing about you. click to start';
  $('start').classList.remove('hidden');
  panel();
});
// sliders: start from the engine's defaults (not written to storage), then apply stored overrides, clamped to the slider's range
const clampTo = (id, v) => { const el = $(id); return Math.min(+el.max, Math.max(+el.min, v)); };
const stored = (k) => { try { const v = localStorage.getItem(k); return v == null ? null : JSON.parse(v); } catch { return null; } };
function setAlpha(a, store = true) {
  R.alpha = a; $('alpha').value = a; $('alphaV').textContent = `×${a.toFixed(1)}`;
  if (store) try { localStorage.setItem('wavefront.alpha', String(a)); } catch {}
}
setAlpha(R.alpha, false);
{ const a = stored('wavefront.alpha'); if (Number.isFinite(a)) setAlpha(clampTo('alpha', a), false); }
$('alpha').addEventListener('input', (e) => setAlpha(+e.target.value));
// reward shaping, live: the next dreams use the new values
function setKeep(w, d, store = true) {
  D.keepW = w; D.keepDist = d;
  $('keepW').value = w; $('keepD').value = d;
  $('keepWv').textContent = w.toFixed(3); $('keepDv').textContent = `${d} px`;
  if (store) try { localStorage.setItem('wavefront.keep', JSON.stringify([w, d])); } catch {}
}
setKeep(D.keepW, D.keepDist, false);
{ const k = stored('wavefront.keep');
  if (Array.isArray(k) && Number.isFinite(k[0]) && Number.isFinite(k[1])) setKeep(clampTo('keepW', k[0]), clampTo('keepD', k[1]), false); }
$('keepW').addEventListener('input', (e) => setKeep(+e.target.value, D.keepDist));
$('keepD').addEventListener('input', (e) => setKeep(D.keepW, +e.target.value));
function setWall(w, store = true) { D.wallW = w; $('wallW').value = w; $('wallWv').textContent = w.toFixed(3); if (store) try { localStorage.setItem('wavefront.wall', String(w)); } catch {} }
setWall(D.wallW, false);
{ const w = stored('wavefront.wall'); if (Number.isFinite(w)) setWall(clampTo('wallW', w), false); }
$('wallW').addEventListener('input', (e) => setWall(+e.target.value));
const HEADNAMES = ['throttle', 'turn', 'aim', 'fire'];
$('acc').innerHTML = HEADNAMES.map((n, k) => `<div class="meter"><span>${n}</span><div class="bar"><i id="accb${k}" style="width:0"></i></div><span id="acct${k}" class="num" style="text-align:right">—</span></div>`).join('');

// ---------- loop ----------
let acc = 0, last = performance.now(), panelT = 0, saveT = performance.now(), pumping = false, bot = null;
function stepOnce(input, render) {
  const rb = !rbBusy;
  const job = D.step(mode, input, { readback: rb, extra: render ? (enc) => R.encode(enc) : null });
  eng.disp = job.dispatches;
  if (rb) { rbBusy = true; const g = gen; lastJob = job.promise.then((r) => (g === gen ? onReadback(r) : (rbBusy = false))); }
  bucket.frames++;
}
function onReadback(r) {
  rbBusy = false; W = r.hdr.slice();
  if (r.gpuMs != null) eng.gpuMs = eng.gpuMs == null ? r.gpuMs : eng.gpuMs * 0.95 + r.gpuMs * 0.05;
  if (bucket.base == null) bucket.base = { dealt: W[H.realDealt], taken: W[H.realTaken] };
  if (bucket.frames >= 30 * FPS) {
    history.push({ dealt: W[H.realDealt] - bucket.base.dealt, taken: W[H.realTaken] - bucket.base.taken, opp });
    if (history.length > 120) history.shift();
    bucket = { base: { dealt: W[H.realDealt], taken: W[H.realTaken] }, frames: 0 };
  }
}
function tick(now) {
  acc += Math.min(100, now - last); last = now;
  let n = 0;
  if (running && !paused) {
    while (acc >= DT && n < 3) { acc -= DT; stepOnce(bot ? bot(W) : oppInput(), acc < DT || n === 2); n++; }
    acc = Math.min(acc, DT);   // after a stall, don't fast-forward to catch up
  } else acc = 0;
  if (!n) R.draw();
  if (now - panelT > 200) { panelT = now; panel(); }
  if (running && now - saveT > 15000) { saveT = now; save(); }
}
function frame(now) { if (dead) return; if (!pumping) tick(now); requestAnimationFrame(frame); }

// ---------- panel ----------
function tank(s, f) { return K.gEnv + K.E.tank + s * 8 + K.T8[f]; }   // the real game's tank[2][8]; s: 0 it, 1 the other tank
const maxEnt = K.HEADS.reduce((s, n) => s + Math.log(n), 0);
function panel() {
  const set = (id, v) => { const e = $(id); if (e.textContent !== v) e.textContent = v; };
  $('eP').firstChild.style.width = `${Math.max(0, Math.min(100, W[tank(1, 'energy')]))}%`;
  $('eA').firstChild.style.width = `${Math.max(0, Math.min(100, W[tank(0, 'energy')]))}%`;
  const sd = W[K.gEnv + K.E.t] >= K.ROUND_TICKS ? ' · sudden death' : '';
  set('score', `round ${W[H.pWins] + W[H.aiWins] + 1} · ${opp === 'you' ? 'you' : opp} ${W[H.pWins]} – ${W[H.aiWins]} it${sd}`);
  const l = history[history.length - 1];
  set('last30', l ? `${l.dealt} / ${l.taken}` : '—');
  for (let k = 0; k < 4; k++) {
    const a = W[H.accHeads + k];
    $('accb' + k).style.width = `${100 * a}%`; set('acct' + k, W[H.bcSteps] > 50 ? `${Math.round(100 * a)}%` : '—');
  }
  const secs = (W[H.dreamDecisions] * K.REPEAT) / 60;
  set('dreamt', W[H.dreamDecisions] ? (secs < 3600 ? `${(secs / 60).toFixed(0)} min` : `${(secs / 3600).toFixed(1)} h`) : 'waiting for your first moves…');
  set('ppo', (W[H.ppoUpdates] | 0).toLocaleString());
  set('decisive', W[H.ppoUpdates] ? `${Math.round(100 * (1 - W[H.entTrain] / maxEnt))}%` : 'random');
  set('disp', String(eng.disp));
  set('gpuUs', eng.gpuMs == null ? '—' : (eng.gpuMs * 1000).toFixed(0));
  spark();
}
let css = null;
function spark() {
  const c = $('spark'), x = c.getContext('2d'), w = c.width, h = c.height;
  if (!css) { const s = getComputedStyle(document.documentElement), v = (n) => s.getPropertyValue(n).trim(); css = { faint: v('--faint'), line: v('--line'), violet: v('--violet'), cyan: v('--cyan') }; }
  x.clearRect(0, 0, w, h);
  if (!history.length) { x.fillStyle = css.faint; x.font = '22px "IBM Plex Mono", monospace'; x.fillText('first 30 s…', 6, h / 2 + 8); return; }
  const m = Math.max(50, ...history.map((d) => Math.abs(d.dealt - d.taken)));
  const bw = Math.min(28, (w - 4) / history.length);
  x.fillStyle = css.line; x.fillRect(0, h / 2, w, 1);
  history.forEach((d, i) => {
    const v = d.dealt - d.taken, bh = (v / m) * (h / 2 - 4);
    x.fillStyle = v >= 0 ? css.violet : css.cyan;
    x.fillRect(2 + i * bw, v >= 0 ? h / 2 - bh : h / 2, bw - 2, Math.abs(bh) || 1);
    if (i && d.opp !== history[i - 1].opp) { x.fillStyle = css.faint; x.fillRect(1 + i * bw - 1, 0, 1, h); }   // opponent switched
  });
}

// ---------- persistence: its brain survives a reload ----------
const b64 = (buf) => { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
async function save() {
  const g = gen;
  try {
    const s = await D.read(['NET', 'WD']);
    const raw = s.NET.slice(0, K.NNET * 4);   // the learner only (the opponent-net slot after it isn't saved)
    const net = new Float32Array(raw); if (!net.every(Number.isFinite)) return;
    const wd = new Float32Array(s.WD);
    if (g !== gen) return;                 // a reset happened while reading: don't resurrect the old brain
    localStorage.setItem(KEY, JSON.stringify({ v: 2, nnet: K.NNET, net: b64(raw), hdr: KEEP.map((k) => wd[k]), history }));
  } catch (e) { console.warn('save failed', e); }
}
function load() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!j || j.v !== 2 || j.nnet !== K.NNET) return false;   // layout changed: start fresh rather than load misaligned weights
    const net = unb64(j.net);
    if (net.byteLength !== K.NNET * 4 || !new Float32Array(net).every(Number.isFinite)) return false;
    D.write({ NET: net });
    const w = new Float32Array(K.NWORLD); KEEP.forEach((k, i) => { const v = Array.isArray(j.hdr) ? +j.hdr[i] : 0; w[k] = Number.isFinite(v) ? v : 0; });
    D.device.queue.writeBuffer(D.WD, 0, w.subarray(0, K.gEnv)); // counters only; the world itself starts fresh
    KEEP.forEach((k) => (W[k] = w[k]));                          // so the panel shows them before the first readback
    const hist = j.history || j.windows;                         // `windows`: saves from before the rename
    history = Array.isArray(hist) ? hist.filter((d) => d && Number.isFinite(d.dealt) && Number.isFinite(d.taken)).slice(-120) : [];
    return true;
  } catch (e) { console.warn('load failed', e); return false; }
}

// ---------- test hooks (?debug) ----------
const pump = async (frames, botFn) => {
  bot = botFn; running = true; $('start').classList.add('hidden'); setPaused(false); pumping = true;
  let t = last;
  for (let k = 0; k < frames; k++) { t += DT; tick(t); if (lastJob) await lastJob; }
  bot = null; pumping = false; last = performance.now();
};
if (new URLSearchParams(location.search).has('debug')) window.WAVEFRONT = { D, R, get W() { return W; }, pump, save, history: () => history };

try { localStorage.removeItem('wavefront.dream.v1'); } catch {}  // pre-split-K saves don't fit the current layout
if (load()) $('start').querySelector('.go').textContent = 'welcome back—it remembers how you play. click to start';
{ const o = stored('wavefront.opp'); if (typeof o === 'string' && o !== 'you') setOpp(o, false); }
panel();
requestAnimationFrame(frame);
