// The sound lab (#/sounds, beta builds only: app.js routes here and links here only when window.TINUE_BETA is set, and
// imports this file only then). For tuning the move sounds by ear: each sound's main controls as sliders, re-rendered
// through sound.js's own synth and recipe format (renderRecipe(recipeFrom(...))), plays of single takes or five in a
// row, the whole edited set copied as JSON to send back, stored on this device for the page to play (sound.js
// setCustom; beta only), and a recording decoded locally to play next to the synth, level-matched.
// The pure part (PARAMS, defaultsFor, editSet, exportSet, parseSet) runs in node too: scripts/test-move-sounds.mjs.
import { MOVE_RECIPES, MOVE_SOUNDS, SOUNDS, VOICES, VARIANTS, renderRecipe, recipeFrom, loudness, setCustom, getCustom, getVoice, isEnabled, CUSTOM_KEY, validRecipe } from './sound.js?v=1795581690';

const DROPS = { dropBoard: 'flatBoard', dropPiece: 'flatPiece' }; // a drop's level is set under its placement's
const OTHER = ['wrong', 'solved', 'rushGood', 'rushEnd', 'lowTime']; // untouched: Play only

// The sliders. Factors (×) act on every event of the recipe; bounce is the second event (for a smash, the settle after
// the slap), added if the recipe has none and its level is raised from 0. Every render is scaled to its loudness target
// (Overall level), so body and click change the balance between them, not the loudness; and no render goes over a
// peak of 0.5, so Overall level stops where that ceiling is reached (the readout says "at the peak ceiling").
export const PARAMS = [
  { key: 'pitch', label: 'Pitch', min: 0.7, max: 1.4, step: 0.01, unit: '×' },
  { key: 'bodyGain', label: 'Board body vs click', min: 0, max: 3, step: 0.05, unit: '×' },
  { key: 'bodyMs', label: 'Board body length', min: 0.4, max: 2.5, step: 0.05, unit: '×' },
  { key: 'clickGain', label: 'Click vs body', min: 0, max: 3, step: 0.05, unit: '×' },
  { key: 'clickHi', label: 'Click brightness', min: 0.5, max: 1.6, step: 0.01, unit: '×' },
  { key: 'modeMs', label: 'Ring (mode decay)', min: 0.4, max: 2.5, step: 0.05, unit: '×' },
  { key: 'bounceAt', label: 'Bounce time', min: 4, max: 60, step: 1, unit: 'ms' },
  { key: 'bounceGain', label: 'Bounce level', min: 0, max: 0.8, step: 0.01, unit: '' },
  { key: 'gap', label: 'Slap after', min: 40, max: 200, step: 1, unit: 'ms', only: ['smash'] },
  { key: 'slap', label: 'Slap level', min: 0.3, max: 2.5, step: 0.05, unit: '×', only: ['smash'] },
  { key: 'level', label: 'Overall level', min: -12, max: 6, step: 0.5, unit: 'dB', not: Object.keys(DROPS) },
  { key: 'under', label: 'Under placement', min: 0, max: 12, step: 0.1, unit: 'dB', only: Object.keys(DROPS) },
];
const SMASH_LABEL = { bounceAt: 'Settle after slap', bounceGain: 'Settle level' }; // (a smash's "bounce" is its settle)
const labelOf = (name, p) => (name === 'smash' && SMASH_LABEL[p.key]) || p.label;
export const paramsOf = (name) => PARAMS.filter((p) => (!p.only || p.only.includes(name)) && !p.not?.includes(name));

const base = (name) => MOVE_RECIPES.sounds[name];
const lvl = (r) => r.level ?? -22;
// The sliders' starting values for a sound: the built-in recipe as it is.
export function defaultsFor(name) {
  const r = base(name), ev = r.events, smash = name === 'smash', b = smash ? ev[2] : ev[1];
  const d = { pitch: 1, bodyGain: 1, bodyMs: 1, clickGain: 1, clickHi: 1, modeMs: 1, level: 0,
    bounceAt: b ? Math.round(b.at - (smash ? ev[1].at : 0)) : 20, bounceGain: b ? b.gain ?? 1 : 0 };
  if (smash) { d.gap = ev[1].at; d.slap = ev[1].gain ?? 1; }
  if (DROPS[name]) d.under = +(lvl(base(DROPS[name])) - lvl(r)).toFixed(1);
  const out = {};
  for (const p of paramsOf(name)) out[p.key] = d[p.key];
  return out;
}

const clamp = (p, v) => { const x = Number(v); return Number.isFinite(x) ? Math.min(p.max, Math.max(p.min, x)) : null; };
// A sound's params, every slider present and in range (missing or bad values: the default).
function fill(name, given = {}) {
  const d = defaultsFor(name), out = {};
  for (const p of paramsOf(name)) out[p.key] = clamp(p, given?.[p.key]) ?? d[p.key];
  return out;
}
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// One sound's recipe from its params (levelOf: the edited level of another sound, for a drop's).
function edit(name, P, levelOf) {
  const r = base(name), smash = name === 'smash';
  const events = r.events.map((e) => ({ ...e }));
  const bi = smash ? 2 : 1;
  if (smash) {
    const settleAfter = events[2] ? events[2].at - events[1].at : 18;
    events[1].at = P.gap; events[1].gain = P.slap;
    if (events[2]) events[2].at = P.gap + settleAfter;
  }
  if (events[bi]) { events[bi].at = (smash ? P.gap : 0) + P.bounceAt; events[bi].gain = P.bounceGain; }
  else if (P.bounceGain > 0) {
    const c0 = events[0].contact, b0 = events[0].body;
    events.push({ at: (smash ? P.gap : 0) + P.bounceAt, gain: P.bounceGain,
      contact: c0 ? { ms: 1.5, lo: c0.lo || 300, hi: Math.round((c0.hi || 4500) * 0.9), gain: 0.5 } : null,
      body: b0 ? { ...b0, ms: Math.round(b0.ms * 0.6), gain: b0.gain * 0.5 } : null });
  }
  const out = { ...r, events: events.map((e) => {
    const x = { ...e };
    if (e.contact) x.contact = { ...e.contact, gain: r6(e.contact.gain * P.clickGain), hi: Math.round(e.contact.hi * P.clickHi) };
    if (e.modes) x.modes = e.modes.map((m) => ({ ...m, f: r6(m.f * P.pitch), ms: r6(m.ms * P.modeMs) }));
    if (e.body) x.body = { ...e.body, gain: r6(e.body.gain * P.bodyGain), ms: r6(e.body.ms * P.bodyMs) };
    x.at = r6(x.at); x.gain = r6(x.gain ?? 1);
    return x;
  }) };
  out.level = r6(DROPS[name] ? levelOf(DROPS[name]).level - P.under : lvl(r) + P.level);
  return out;
}

// state: { name: params } (any subset; the rest built-in). -> { name: recipe } for all nine move sounds.
export function editSet(state = {}) {
  const params = Object.fromEntries(MOVE_SOUNDS.map((n) => [n, fill(n, state[n])]));
  const out = {};
  const get = (n) => (out[n] ||= edit(n, params[n], get));
  for (const n of MOVE_SOUNDS) get(n);
  return out;
}

// What "Copy settings" puts on the clipboard: the whole edited recipe set (sound.js's format, renderable as it is), the
// slider values that made it, and the voice and variation tables it is heard through. raw: { name: recipe } set whole
// (pasted, or from scripts/fit-sound.mjs), in place of what the sliders make.
export function exportSet(state = {}, raw = {}) {
  const params = Object.fromEntries(MOVE_SOUNDS.map((n) => [n, fill(n, state[n])]));
  return JSON.stringify({ tinueSoundLab: 1, sounds: { ...editSet(state), ...raw }, params, voices: MOVE_RECIPES.voices, vary: MOVE_RECIPES.vary }, null, 1);
}
// Back from that JSON (or any { sounds: { name: recipe } }, such as a fitted set put together by hand): { sounds,
// params, raw }, raw the recipes the sliders do not make (to be played as they are, sliders inactive). Throws on
// anything else, and on a recipe sound.js could not render (validRecipe: stored, it would silence that move).
export function parseSet(text) {
  const j = typeof text === 'string' ? JSON.parse(text) : text;
  if (!j || typeof j !== 'object' || !j.sounds || typeof j.sounds !== 'object') throw new Error('not a sound lab set');
  const broken = MOVE_SOUNDS.filter((n) => j.sounds[n] != null && !validRecipe(j.sounds[n]));
  if (broken.length) throw new Error('not a recipe this page can play: ' + broken.join(', '));
  const params = {};
  for (const n of MOVE_SOUNDS) if (j.params?.[n]) params[n] = fill(n, j.params[n]);
  const made = editSet(params), raw = {};
  for (const n of MOVE_SOUNDS) if (j.sounds[n] != null && JSON.stringify(j.sounds[n]) !== JSON.stringify(made[n])) raw[n] = j.sounds[n];
  return { sounds: j.sounds, params, raw };
}

// ---------- the page ----------
const CSS = `
.sl h1 { font-size: var(--fs-lg); margin: 0 0 4px; }
.sl .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin: 12px 0; }
.sl .panel { margin-top: 10px; padding: 12px; }
.sl .hd { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.sl .hd b { color: var(--fg-hi); font-weight: 600; margin-right: auto; }
.sl .btns { display: flex; gap: 6px; flex-wrap: nowrap; }
.sl .hd .muted, .sl .meas { font-size: var(--fs-xs); }
.sl .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 4px 14px; margin-top: 8px; }
.sl label.sld { display: flex; flex-direction: column; font-size: var(--fs-xs); color: var(--muted); min-width: 0; }
.sl label.sld span { display: flex; justify-content: space-between; gap: 6px; white-space: nowrap; }
.sl label.sld output { color: var(--fg-hi); font-family: var(--mono); }
.sl input[type=range] { width: 100%; height: 28px; margin: 0; padding: 0; border: 0; background: none; accent-color: var(--accent); }
.sl button { height: 30px; padding: 0 9px; }
@media (pointer: coarse) { .sl button { height: auto; min-height: 36px; } .sl input[type=range] { height: 36px; } .sl input[type=file] { min-height: 36px; } }
.sl label.sld.off { opacity: 0.45; }
.sl .note { background: var(--bg3); border-radius: var(--r-ctl); padding: 8px 10px; font-size: var(--fs-sm); }
.sl textarea { width: 100%; height: 160px; font: 11px/1.3 var(--mono); background: var(--bg3); color: var(--fg-hi); border: 1px solid var(--line); border-radius: var(--r-ctl); }
.sl input[type=file] { height: auto; border: 0; padding: 4px 0; max-width: 100%; }
`;

const fmt = (p, v) => (p.unit === '×' ? '×' + v.toFixed(2) : p.unit === 'dB' ? (p.key === 'under' ? '−' : v > 0 ? '+' : '') + Math.abs(v).toFixed(1) + ' dB' : p.unit === 'ms' ? Math.round(v) + ' ms' : v.toFixed(2));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const readStored = () => { try { return JSON.parse(localStorage.getItem(CUSTOM_KEY)); } catch { return null; } };

// The lab's own AudioContext (it plays whatever the Sound setting says): made on first use, asleep (suspended) 1.5 s
// after the last sound ends, as sound.js's is, and closed when the lab page is left (leave). ctxOf() for rendering and
// decoding, which work asleep; audio() to play, which wakes it.
let ac = null, root = null, idleT = null, busyUntil = 0;
const srcs = new Set(); // what the lab started, until it ends: leave() stops them
const ctxOf = () => { if (!ac) { const AC = window.AudioContext || window.webkitAudioContext; ac = new AC({ latencyHint: 'interactive' }); } return ac; };
const audio = () => {
  const a = ctxOf();
  if (a.state !== 'running') a.resume().catch(() => {});
  return a;
};
function armIdle() {
  clearTimeout(idleT);
  idleT = setTimeout(() => {
    idleT = null;
    if (performance.now() < busyUntil + 1495) return armIdle();
    if (ac?.state === 'running') ac.suspend().catch(() => {});
  }, Math.max(0, busyUntil - performance.now()) + 1500);
}
// The lab page is left (app.js route): its sounds stop and its context is closed (a new one is made on return).
export function leave() {
  clearTimeout(idleT); idleT = null;
  for (const s of srcs) { try { s.stop(); } catch {} }
  srcs.clear();
  const a = ac; ac = null; root = null;
  try { a?.close().catch(() => {}); } catch {}
}
const bufCache = new Map();
function bufferOf(recipe, name, voice, variant) {
  const r = recipeFrom(recipe, name, voice, variant), key = JSON.stringify([r, ctxOf().sampleRate]);
  let b = bufCache.get(key);
  if (!b) {
    const d = renderRecipe(r, ac.sampleRate);
    b = ac.createBuffer(1, d.length, ac.sampleRate); b.getChannelData(0).set(d);
    b.__lvl = loudness(d, ac.sampleRate);
    b.__capped = b.__lvl < (r.level ?? -22) - 0.1; // held under its target by the peak ceiling
    if (bufCache.size > 300) bufCache.clear();
    bufCache.set(key, b);
  }
  return b;
}
function playBuf(b, when = 0, gain = 1) {
  const a = audio(), src = a.createBufferSource(), g = a.createGain();
  g.gain.value = gain; src.buffer = b; src.connect(g); g.connect(a.destination);
  srcs.add(src);
  src.onended = () => { src.disconnect(); g.disconnect(); srcs.delete(src); };
  src.start(a.currentTime + 0.02 + when / 1000);
  busyUntil = Math.max(busyUntil, performance.now() + 20 + when + b.duration * 1000);
  armIdle();
}

// A recording as the lab plays it: its channels mixed to one (what is measured is what is played: a stereo file's
// channels measured as a mix but played apart could be driven far past full scale, or 6 dB off level), and the gain
// that brings its loudest 50 ms to the synth's level, never past a 0.99 peak.
export function monoOf(chans) {
  const n = chans[0]?.length || 0, mono = new Float32Array(n);
  for (const d of chans) for (let i = 0; i < n; i++) mono[i] += d[i] / chans.length;
  return mono;
}
export function matchGain(synLvl, mono, sr) {
  let peak = 0;
  for (const v of mono) peak = Math.max(peak, Math.abs(v));
  return Math.min(10 ** ((synLvl - loudness(mono, sr)) / 20), 0.99 / (peak || 1));
}

export function enter(el) {
  root = el;
  const stored = readStored();
  const st = { voice: getVoice(), params: {}, raw: {}, last: {} };
  if (stored?.sounds) try { ({ params: st.params, raw: st.raw } = parseSet(stored)); } catch {}
  if (!document.getElementById('sound-lab-css')) document.head.append(Object.assign(document.createElement('style'), { id: 'sound-lab-css', textContent: CSS }));
  const rec = { buf: null, name: 'flatBoard', info: '' };

  const sets = () => ({ ...editSet(st.params), ...st.raw });
  const builtIn = editSet({});
  const takeOf = (name) => { let v = Math.floor(Math.random() * VARIANTS); if (v === st.last[name]) v = (v + 1) % VARIANTS; st.last[name] = v; return v; };
  const play = (name, variant = takeOf(name)) => { const b = bufferOf(sets()[name], name, st.voice, variant); playBuf(b); return b; };
  const gapOf = (name) => (name === 'smash' ? 480 : 340);
  const playFive = (name) => {
    const r = sets()[name];
    for (let i = 0; i < 5; i++) playBuf(bufferOf(r, name, st.voice, i % VARIANTS), i * gapOf(name));
  };
  // the built-in sound, take 0; then (both) the edited one, take 0, a beat later: an A/B without losing the edit
  const playOriginal = (name, both) => {
    playBuf(bufferOf(builtIn[name], name, st.voice, 0));
    if (both) playBuf(bufferOf(sets()[name], name, st.voice, 0), gapOf(name));
  };
  const measure = (name) => {
    try { const b = bufferOf(sets()[name], name, st.voice, 0); return `${Math.round((1000 * b.length) / b.sampleRate)} ms · ${b.__lvl.toFixed(1)} dBFS${b.__capped ? ' · at the peak ceiling: no louder' : ''}`; } catch { return ''; }
  };
  const offNote = 'Sound is Off in Settings: the lab plays here, but puzzles and Rush stay silent until you turn it on.';
  const using = () => !!getCustom();

  function render() {
    el.innerHTML = `<div class="sl">
      <h1>Sound lab</h1>
      <p class="muted" style="margin:0;font-size:var(--fs-sm)">The move sounds, to tune by ear (beta builds only). Sliders re-render through the page's own synth. Changes play only here until you use them on this device; Copy settings gives the numbers to send back.</p>
      <div class="bar">
        <label class="field"><span>Voice</span><select id="sl-voice">${VOICES.map((v) => `<option value="${v}"${v === st.voice ? ' selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select></label>
        <button id="sl-copy">Copy settings</button>
        <button id="sl-use" class="primary">Use these on this device</button>
        <button id="sl-reset-all">Reset all</button>
      </div>
      <p class="note${isEnabled() ? ' hidden' : ''}" id="sl-off">${offNote}</p>
      <p class="note${using() ? '' : ' hidden'}" id="sl-using">This device plays the lab's sounds, not the built-in ones. <button class="link" id="sl-builtin" style="color:var(--accent)">Back to built-in</button></p>
      <p class="muted hidden" id="sl-msg" style="font-size:var(--fs-sm)"></p>
      <textarea id="sl-json" class="hidden" readonly></textarea>
      <details id="sl-paste-box"><summary class="muted" style="font-size:var(--fs-sm)">Paste settings</summary>
        <textarea id="sl-paste" placeholder='Settings copied from a lab, or { "sounds": { "flatBoard": { recipe } } } (a fitted recipe: its sliders stay inactive)'></textarea>
        <div class="bar" style="margin:6px 0 0"><button id="sl-load">Load pasted settings</button></div></details>
      ${MOVE_SOUNDS.map((n) => `<section class="panel" data-s="${n}">
        <div class="hd"><b>${esc(SOUNDS[n].label)}</b>
          <span class="btns"><button data-a="play">Play</button><button data-a="five">Play 5</button><button data-a="orig">Original</button><button data-a="ab" title="The built-in sound, then yours">Original, then edited</button><button data-a="reset">Reset</button></span></div>
        <div class="muted" style="font-size:var(--fs-xs)">${esc(SOUNDS[n].desc)} · <span data-meas></span><span data-raw class="hidden"> · custom recipe (sliders inactive; Reset to edit)</span></div>
        <div class="muted" style="font-size:var(--fs-xs)">Body and click set the balance; the loudness is held (Overall level sets it).</div>
        <div class="grid">${paramsOf(n).map((p) => `<label class="sld"><span>${esc(labelOf(n, p))} <output data-o="${p.key}"></output></span>
          <input type="range" data-k="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}"></label>`).join('')}</div></section>`).join('')}
      <section class="panel"><div class="hd"><b>Other sounds</b><span class="muted">untouched, Play only</span></div>
        <div class="bar" style="margin:8px 0 0">${OTHER.map((n) => `<button data-other="${n}">${esc(SOUNDS[n].label)}</button>`).join('')}</div></section>
      <section class="panel"><div class="hd"><b>Compare with a recording</b></div>
        <div class="muted" style="font-size:var(--fs-xs)">Decoded here in the browser; nothing is uploaded. Both are played at the same level (the loudest 50 ms, RMS).</div>
        <div class="bar" style="margin:8px 0 0"><input type="file" id="sl-file" accept="audio/*,.wav,.m4a,.mp3,.aac,.caf,.ogg,.webm">
          <select id="sl-cmp" aria-label="Sound to compare">${MOVE_SOUNDS.map((n) => `<option value="${n}">${esc(SOUNDS[n].label)}</option>`).join('')}</select>
          <button data-c="rec">Recording</button><button data-c="syn">Synth</button><button data-c="ab">Both</button></div>
        <div class="meas muted" id="sl-rec"></div></section>
    </div>`;
    sync();
  }
  // the sliders and readouts from st (all of them: a drop's level follows its placement's)
  function sync() {
    for (const sec of el.querySelectorAll('section[data-s]')) {
      const n = sec.dataset.s, P = fill(n, st.params[n]), raw = !!st.raw[n];
      for (const inp of sec.querySelectorAll('input[data-k]')) {
        const p = PARAMS.find((x) => x.key === inp.dataset.k);
        inp.value = P[p.key]; inp.disabled = raw;
        sec.querySelector(`output[data-o="${p.key}"]`).textContent = fmt(p, P[p.key]);
      }
      sec.querySelector('[data-raw]').classList.toggle('hidden', !raw);
      bounceState(sec, P);
      sec.querySelector('[data-meas]').textContent = measure(n);
    }
    el.querySelector('#sl-using').classList.toggle('hidden', !using());
    el.querySelector('#sl-off').classList.toggle('hidden', isEnabled());
  }
  // Bounce time does nothing while Bounce level is 0: greyed and disabled until then
  function bounceState(sec, P) {
    const inp = sec.querySelector('input[data-k="bounceAt"]');
    if (!inp) return;
    const off = !(P.bounceGain > 0) || !!st.raw[sec.dataset.s];
    inp.disabled = off; inp.closest('label').classList.toggle('off', off);
    inp.closest('label').title = off && !st.raw[sec.dataset.s] ? `Set ${labelOf(sec.dataset.s, PARAMS.find((p) => p.key === 'bounceGain'))} first` : '';
  }
  const say = (t) => { const m = el.querySelector('#sl-msg'); m.textContent = t; m.classList.toggle('hidden', !t); };

  render();
  el.oninput = (e) => {
    const inp = e.target.closest('input[data-k]');
    if (!inp) return;
    const n = inp.closest('section').dataset.s, p = PARAMS.find((x) => x.key === inp.dataset.k);
    st.params[n] = { ...fill(n, st.params[n]), [p.key]: clamp(p, inp.value) };
    inp.closest('label').querySelector('output').textContent = fmt(p, st.params[n][p.key]);
    if (p.key === 'bounceGain') bounceState(inp.closest('section'), st.params[n]);
  };
  el.onchange = async (e) => {
    const t = e.target;
    if (t.id === 'sl-voice') { st.voice = t.value; sync(); return; }
    if (t.id === 'sl-cmp') { rec.name = t.value; return; }
    if (t.id === 'sl-file') return loadFile(t.files?.[0]);
    const inp = t.closest?.('input[data-k]');
    if (inp) { const n = inp.closest('section').dataset.s; sync(); play(n, 0); } // released: hear it
  };
  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const sec = b.closest('section[data-s]'), n = sec?.dataset.s;
    if (b.dataset.a === 'play') play(n);
    else if (b.dataset.a === 'five') playFive(n);
    else if (b.dataset.a === 'orig') playOriginal(n, false);
    else if (b.dataset.a === 'ab') playOriginal(n, true);
    else if (b.dataset.a === 'reset') { delete st.params[n]; delete st.raw[n]; sync(); }
    else if (b.dataset.other) playBuf(otherBuf(b.dataset.other));
    else if (b.id === 'sl-reset-all') { st.params = {}; st.raw = {}; sync(); say('All sliders back to the built-in recipes (this device still plays what it was set to).'); }
    else if (b.id === 'sl-copy') {
      const text = exportSet(st.params, st.raw), ta = el.querySelector('#sl-json');
      ta.value = text;
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch {}
      ta.classList.toggle('hidden', ok);
      if (!ok) { ta.focus(); ta.select(); }
      say(ok ? `Copied (${text.length.toLocaleString()} characters of JSON).` : 'The clipboard refused: select the text below and copy it.');
    } else if (b.id === 'sl-use') {
      const sounds = sets();
      try { localStorage.setItem(CUSTOM_KEY, JSON.stringify({ tinueSoundLab: 1, sounds, params: st.params })); } catch {}
      const ok = setCustom(sounds);
      sync(); say(!ok ? 'Not stored (this is not a beta build).' : 'Stored in this browser: the puzzles and Rush now play these. Other devices and the real site are unaffected.' + (isEnabled() ? '' : ' ' + offNote));
    } else if (b.id === 'sl-load') {
      try {
        const got = parseSet(el.querySelector('#sl-paste').value);
        st.params = got.params; st.raw = got.raw; sync();
        const k = Object.keys(got.raw).length;
        say(`Loaded: ${MOVE_SOUNDS.length - k} sound(s) on the sliders${k ? `, ${k} as custom recipes (${Object.keys(got.raw).join(', ')})` : ''}. Use these on this device to hear them in the puzzles.`);
      } catch (err) { say('Could not read those settings (' + (err?.message || err) + ').'); }
    } else if (b.id === 'sl-builtin') {
      try { localStorage.removeItem(CUSTOM_KEY); } catch {}
      setCustom(null); sync(); say('Back to the built-in sounds on this device.');
    } else if (b.dataset.c) compare(b.dataset.c);
  };

  const others = new Map();
  function otherBuf(n) {
    const a = ctxOf(), k = n + ':' + st.voice;
    if (!others.has(k)) { const d = SOUNDS[n].render(a.sampleRate, { voice: st.voice }); const b = a.createBuffer(1, d.length, a.sampleRate); b.getChannelData(0).set(d); others.set(k, b); }
    return others.get(k);
  }
  async function loadFile(f) {
    const out = el.querySelector('#sl-rec');
    if (!f) return;
    try {
      const a = ctxOf(), b = await a.decodeAudioData(await f.arrayBuffer());
      const mono = monoOf(Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)));
      const m = a.createBuffer(1, mono.length, b.sampleRate); m.getChannelData(0).set(mono);
      rec.buf = m; rec.mono = mono; rec.lvl = loudness(mono, b.sampleRate);
      out.textContent = `${f.name}: ${(b.duration * 1000).toFixed(0)} ms, ${b.numberOfChannels} ch, ${b.sampleRate} Hz, loudest 50 ms ${rec.lvl.toFixed(1)} dBFS.`;
    } catch (err) { rec.buf = null; out.textContent = 'Could not decode that file here (' + (err?.message || err) + ').'; }
  }
  function compare(which) {
    const syn = bufferOf(sets()[rec.name], rec.name, st.voice, 0);
    if (which !== 'syn' && !rec.buf) { el.querySelector('#sl-rec').textContent = 'Choose a recording first.'; return; }
    const g = rec.buf ? matchGain(syn.__lvl, rec.mono, rec.buf.sampleRate) : 1;
    if (which === 'rec') playBuf(rec.buf, 0, g);
    else if (which === 'syn') playBuf(syn);
    else { playBuf(rec.buf, 0, g); playBuf(syn, rec.buf.duration * 1000 + 400); }
    if (rec.buf) el.querySelector('#sl-rec').dataset.gain = (20 * Math.log10(g)).toFixed(1);
  }
}
