// tinue's sounds: short, dry, quiet wood and stone, all synthesized here (no samples).
// Pure DSP (SOUNDS[name].render(sampleRate, opts) -> Float32Array, mono, deterministic) plus a tiny Web Audio player
// (unlock / play / setEnabled / isEnabled / setVoice) that does nothing outside a browser.
// The move sounds (place, cap, spread, smash, rushGood) and wrong come in three voices (opts.voice): 'light', a dry
// mid tock; 'thunk', lower and weightier with a soft body thump; 'deep', lower again. The rest have one voice.

// ---- DSP ----

// mulberry32: a small seeded PRNG, so the noise in each sound is the same on every render.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// RBJ biquad, applied in place over buf[from..]; coefficients come from the sample rate, so 44.1k and 48k agree.
function biquad(buf, sr, type, f, q, from = 0) {
  const w = (2 * Math.PI * f) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
  else { b0 = al; b1 = 0; b2 = -al; } // band-pass, 0 dB peak
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = from; i < buf.length; i++) {
    const x = buf[i], y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y; buf[i] = y;
  }
}

// An exponentially damped sine starting at time t (ms): one mode of a struck body.
function mode(buf, sr, t, f, amp, decayMs) {
  const i0 = Math.round((t * sr) / 1000), k = 1000 / (decayMs * sr), w = (2 * Math.PI * f) / sr;
  for (let i = i0, n = 0; i < buf.length; i++, n++) {
    const e = amp * Math.exp(-n * k);
    if (e < 1e-6) break;
    buf[i] += e * Math.sin(w * n);
  }
}

// The strike: a short burst of band-passed noise at time t (ms), decaying over ~decayMs.
function strike(buf, sr, t, f, q, amp, decayMs, seed) {
  const r = rng(seed), i0 = Math.round((t * sr) / 1000), len = Math.round((decayMs * 6 * sr) / 1000);
  const tmp = new Float64Array(len + Math.round(0.02 * sr));
  for (let n = 0; n < len; n++) tmp[n] = (r() * 2 - 1) * Math.exp((-n * 1000) / (decayMs * sr));
  biquad(tmp, sr, 'bp', f, q);
  for (let n = 0; n < tmp.length && i0 + n < buf.length; n++) buf[i0 + n] += amp * 3 * tmp[n];
}

// A wooden "tock" at t: noise transient plus inharmonic modes (ratio, relative amp, decay ms).
// hit: how hard the strike is (the lower voices are struck more softly).
function tock(buf, sr, t, f0, modes, gain, seed, noiseHz = 1800, hit = 0.55) {
  strike(buf, sr, t, noiseHz, 1.2, hit * gain, 0.8, seed);
  for (const [ratio, amp, dec] of modes) mode(buf, sr, t, f0 * ratio, amp * gain, dec);
}
// A voiced knock at t: the tock of voice table v (f0, modes, noise, hit), then its body thump ([Hz, amp, decay ms]).
function knock(buf, sr, t, v, gain, seed, f0 = v.f0) {
  tock(buf, sr, t, f0, v.modes, gain, seed, v.noise, v.hit);
  if (v.thump) mode(buf, sr, t, v.thump[0], v.thump[1] * gain, v.thump[2]);
}

// A soft mallet note at t: a damped sine, a weak 4th harmonic, a faint felt thud.
function mallet(buf, sr, t, f, gain, decayMs, seed) {
  strike(buf, sr, t, f * 1.5, 1.0, 0.08 * gain, 0.6, seed);
  mode(buf, sr, t, f, gain, decayMs);
  mode(buf, sr, t, f * 4, 0.06 * gain, decayMs / 5);
}

// Loudness: the highest RMS over any 50 ms window, in dBFS (short sounds integrate whole).
export function loudness(x, sr) {
  const w = Math.min(x.length, Math.round(0.05 * sr));
  let s = 0, best = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i] * x[i];
    if (i >= w) s -= x[i - w] * x[i - w];
    if (i >= w - 1 && s > best) best = s;
  }
  return 10 * Math.log10(Math.max(best / w, 1e-20));
}

const PEAK = 0.5; // -6 dBFS: two sounds at once still fit under full scale
// Finish a buffer: low-pass (keeps wood out of the top octaves), remove DC, raised-cosine in/out fades to exact
// zero, then scale to the target loudness (dBFS, as loudness() measures it), never above PEAK.
function finish(buf, sr, target, { lp = 5000, fadeMs = 12 } = {}) {
  biquad(buf, sr, 'lp', lp, 0.707);
  biquad(buf, sr, 'lp', lp, 0.707);
  let m = 0;
  for (const v of buf) m += v;
  m /= buf.length;
  for (let i = 0; i < buf.length; i++) buf[i] -= m;
  const a = Math.max(2, Math.round(0.0005 * sr)), f = Math.max(2, Math.round((fadeMs * sr) / 1000)), N = buf.length;
  for (let j = 0; j < a; j++) buf[j] *= 0.5 * (1 - Math.cos((Math.PI * j) / (a - 1)));
  for (let j = 0; j < f; j++) buf[N - f + j] *= 0.5 * (1 + Math.cos((Math.PI * j) / (f - 1)));
  const out = Float32Array.from(buf);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = Math.min(10 ** ((target - loudness(out, sr)) / 20), PEAK / peak);
  for (let i = 0; i < N; i++) out[i] *= g;
  out[0] = 0; out[N - 1] = 0; // (already 0 to rounding; make it exact)
  return out;
}

const len = (sr, ms) => new Float64Array(Math.round((ms * sr) / 1000));
export const SPREAD_GAP_MS = 52; // between the taps of a stack move
const drops = (opts) => Math.min(7, Math.max(1, Math.round(Number(opts?.drops ?? opts?.n ?? 1)) || 1));

export const VOICES = ['light', 'thunk', 'deep'];
export const DEFAULT_VOICE = 'thunk';
const voiceOf = (opts) => (VOICES.includes(opts?.voice) ? opts.voice : DEFAULT_VOICE);
// The voiced sounds. Each table: ms (length), f0 and modes ([ratio, amp, decay ms]) of the tock, noise (the strike's
// centre, Hz), hit (its strength), thump ([Hz, amp, decay ms] of the body under it), lp (the final low-pass, Hz),
// trim (dB added to the sound's loudness target).
// In the lower voices the fundamental sits under 400 Hz, where small phone speakers give little back, so each keeps a
// strong mode between 450 and 700 Hz that carries the sound there.
const V = {
  place: {
    light: { ms: 75, f0: 540, modes: [[1, 1, 22], [2.31, 0.4, 11], [3.87, 0.16, 6]], noise: 1800, hit: 0.55, lp: 5000 },
    thunk: { ms: 85, f0: 300, modes: [[1, 1, 12], [2.2, 0.8, 8], [3.6, 0.1, 4]], noise: 1100, hit: 0.3, thump: [135, 0.3, 12], lp: 3500, trim: 2 },
    deep: { ms: 110, f0: 220, modes: [[1, 1, 15], [2.41, 0.9, 10], [4.2, 0.07, 4]], noise: 900, hit: 0.24, thump: [110, 0.4, 15], lp: 3000, trim: 3 },
  },
  cap: {
    light: { ms: 95, f0: 405, modes: [[1, 1, 30], [2.17, 0.42, 14], [3.62, 0.15, 7]], noise: 1400, hit: 0.55, thump: [150, 0.45, 22], lp: 5000 },
    thunk: { ms: 105, f0: 225, modes: [[1, 1, 18], [2.3, 0.75, 11], [3.62, 0.1, 5]], noise: 900, hit: 0.3, thump: [105, 0.42, 18], lp: 3200, trim: 2 },
    deep: { ms: 125, f0: 165, modes: [[1, 1, 22], [2.9, 0.9, 12], [4.6, 0.06, 5]], noise: 750, hit: 0.24, thump: [85, 0.5, 20], lp: 2800, trim: 3 },
  },
  spread: {
    light: { tail: 60, f0: 600, modes: [[1, 1, 16], [2.43, 0.35, 8], [4.1, 0.12, 4]], noise: 2000, hit: 0.55, lp: 5000 },
    thunk: { tail: 62, f0: 340, modes: [[1, 1, 10], [2.2, 0.7, 6], [3.7, 0.1, 3]], noise: 1250, hit: 0.3, thump: [150, 0.22, 9], lp: 3800, trim: 2 },
    deep: { tail: 70, f0: 250, modes: [[1, 1, 12], [2.35, 0.8, 8], [4.1, 0.07, 3]], noise: 1000, hit: 0.24, thump: [125, 0.3, 11], lp: 3200, trim: 3 },
  },
  // (the cap of the voice, a little shorter, under the crack)
  smash: {
    light: { ms: 105, f0: 405, modes: [[1, 1, 28], [2.17, 0.4, 13], [3.62, 0.14, 6]], noise: 1400, hit: 0.55, thump: [150, 0.4, 20] },
    thunk: { ms: 110, f0: 225, modes: [[1, 1, 17], [2.3, 0.72, 10], [3.62, 0.1, 5]], noise: 900, hit: 0.3, thump: [105, 0.4, 17], trim: 2 },
    deep: { ms: 125, f0: 165, modes: [[1, 1, 21], [2.9, 0.86, 11], [4.6, 0.06, 5]], noise: 750, hit: 0.24, thump: [85, 0.48, 19], trim: 3 },
  },
  rushGood: {
    light: { ms: 55, f0: 880, modes: [[1, 1, 14], [2.52, 0.3, 6]], noise: 2400, hit: 0.55, lp: 5000 },
    thunk: { ms: 55, f0: 560, modes: [[1, 1, 10], [2.4, 0.32, 5]], noise: 1700, hit: 0.4, lp: 4500, trim: 1 },
    deep: { ms: 60, f0: 440, modes: [[1, 1, 11], [2.4, 0.36, 6]], noise: 1400, hit: 0.34, lp: 4000, trim: 2 },
  },
  // Two knocks, the second lower (f1), both well under the voice's place.
  wrong: {
    light: { ms: 185, f0: 330, f1: 290, modes: [[1, 1, 26], [2.3, 0.7, 16], [3.9, 0.12, 6]], modes1: [[1, 1, 30], [2.3, 0.7, 16], [3.9, 0.12, 6]], noise: 1000, hit: 0.55, lp: 3000 },
    thunk: { ms: 195, f0: 210, f1: 185, modes: [[1, 1, 24], [2.6, 0.8, 15], [4.4, 0.08, 5]], modes1: [[1, 1, 28], [2.6, 0.8, 15], [4.4, 0.08, 5]], noise: 800, hit: 0.34, lp: 2600, trim: 1 },
    deep: { ms: 205, f0: 165, f1: 145, modes: [[1, 1, 26], [3.3, 0.85, 15], [5.2, 0.06, 5]], modes1: [[1, 1, 30], [3.3, 0.85, 15], [5.2, 0.06, 5]], noise: 700, hit: 0.28, lp: 2400, trim: 1.5 },
  },
};

// Loudness targets (dBFS, 50 ms RMS): the frequent sounds quietest, solved the loudest. A lower voice gets its trim
// (dB) on top: the ear, and a small speaker more so, hears less of a low sound at the same level.
export const SOUNDS = {
  // A flat or a wall set on the board: a dry wooden tock.
  place: { label: 'Place', desc: 'a stone placed', voiced: true, render(sr, opts) {
    const v = V.place[voiceOf(opts)], b = len(sr, v.ms);
    knock(b, sr, 0, v, 1, 11);
    return finish(b, sr, -23 + (v.trim || 0), { lp: v.lp });
  } },
  // The capstone: the same family, about a fourth lower, a longer body and a soft low thump under it.
  cap: { label: 'Capstone', desc: 'a capstone placed', voiced: true, render(sr, opts) {
    const v = V.cap[voiceOf(opts)], b = len(sr, v.ms);
    knock(b, sr, 0, v, 1, 12);
    return finish(b, sr, -21.5 + (v.trim || 0), { lp: v.lp });
  } },
  // A stack move: one light tap per square dropped on (opts.drops, 1-7), each a hair lower and softer.
  spread: { label: 'Stack move', desc: 'one tap per square dropped on', voiced: true, render(sr, opts) {
    const v = V.spread[voiceOf(opts)], n = drops(opts), b = len(sr, (n - 1) * SPREAD_GAP_MS + v.tail);
    for (let i = 0; i < n; i++) knock(b, sr, i * SPREAD_GAP_MS, v, 1 - 0.06 * i, 20 + i, v.f0 * (1 - 0.025 * i) * (i % 2 ? 0.985 : 1));
    return finish(b, sr, -24 + (v.trim || 0), { lp: v.lp, fadeMs: 10 });
  } },
  // A capstone flattening a wall: the cap tock, then 10 ms later a short dry crack (bright, very quick modes).
  smash: { label: 'Smash', desc: 'a wall flattened', voiced: true, render(sr, opts) {
    const v = V.smash[voiceOf(opts)], b = len(sr, v.ms);
    knock(b, sr, 0, v, 1, 13);
    strike(b, sr, 10, 2600, 1.6, 0.5, 2.2, 14);
    mode(b, sr, 10, 1310, 0.3, 6); mode(b, sr, 10, 1870, 0.22, 4); mode(b, sr, 10, 2730, 0.12, 3);
    return finish(b, sr, -21 + (v.trim || 0), { lp: 6000 });
  } },
  // A wrong move: two low, muffled knocks on wood, the second a touch lower. No pitch, no buzz. Lower than the
  // voice's cap, but with a strong upper mode: phone speakers lose almost everything under ~300 Hz.
  wrong: { label: 'Wrong', desc: 'a wrong move', voiced: true, render(sr, opts) {
    const v = V.wrong[voiceOf(opts)], b = len(sr, v.ms);
    tock(b, sr, 0, v.f0, v.modes, 1, 15, v.noise, v.hit);
    tock(b, sr, 95, v.f1, v.modes1, 0.85, 16, v.noise, v.hit);
    return finish(b, sr, -22 + (v.trim || 0), { lp: v.lp, fadeMs: 25 });
  } },
  // Solved: three soft mallet notes rising (G5 C6 E6), close together, ringing briefly. Heard once a puzzle, so only a
  // few dB above place over its whole length (its 50 ms target sits low because three notes carry the energy).
  solved: { label: 'Solved', desc: 'the puzzle is solved', render(sr) {
    const b = len(sr, 460);
    mallet(b, sr, 0, 783.99, 0.8, 110, 17);
    mallet(b, sr, 85, 1046.5, 0.85, 120, 18);
    mallet(b, sr, 170, 1318.5, 1, 140, 19);
    return finish(b, sr, -21.5, { lp: 6000, fadeMs: 90 });
  } },
  // Rush, a correct puzzle: one tiny, light, slightly higher tock (heard dozens of times a run).
  rushGood: { label: 'Rush correct', desc: 'a correct puzzle in Puzzle Rush', voiced: true, render(sr, opts) {
    const v = V.rushGood[voiceOf(opts)], b = len(sr, v.ms);
    knock(b, sr, 0, v, 1, 21);
    return finish(b, sr, -24 + (v.trim || 0), { lp: v.lp, fadeMs: 10 });
  } },
  // Rush over: two low mallet notes falling a fourth (C5 then G4), calm and quiet.
  rushEnd: { label: 'Rush over', desc: 'a Puzzle Rush run ends', render(sr) {
    const b = len(sr, 440);
    mallet(b, sr, 0, 523.25, 1, 120, 22);
    mallet(b, sr, 130, 392, 0.95, 150, 23);
    return finish(b, sr, -19, { lp: 4000, fadeMs: 90 });
  } },
  // Ten seconds left: a soft tick-tock, two short high-wood ticks.
  lowTime: { label: 'Low time', desc: 'ten seconds left on the clock', render(sr) {
    const b = len(sr, 200);
    tock(b, sr, 0, 1250, [[1, 1, 9], [1.63, 0.3, 5]], 1, 24, 2600);
    tock(b, sr, 150, 1050, [[1, 1, 9], [1.63, 0.3, 5]], 0.9, 25, 2600);
    return finish(b, sr, -23, { fadeMs: 10 });
  } },
};

// ---- playback (browser only) ----

const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : undefined;
let ctx = null, master = null, enabled = true, voice = DEFAULT_VOICE;
const cache = new Map(); // name[:voice][:drops] -> AudioBuffer at ctx.sampleRate

// The voice of the move sounds (VOICES); anything else leaves it as it is. Takes effect with the next sound.
export const setVoice = (v) => { if (VOICES.includes(v)) voice = v; };
export const getVoice = () => voice;

// Off also suspends the context, so no audio thread renders silence; unlock() (or a play) resumes it.
export const setEnabled = (on) => {
  enabled = !!on;
  try { if (!enabled && ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); } catch {}
};
export const isEnabled = () => enabled;

// Call on every gesture: creates the AudioContext on the first one that activates the page and resumes it if
// suspended. A touch pointerdown does not activate the page (its pointerup/touchend does), so it only resumes.
export function unlock(e) {
  try {
    if (!AC || !enabled) return;
    if (!ctx) {
      if (e && e.type === 'pointerdown' && e.pointerType && e.pointerType !== 'mouse') return;
      // iOS 16.4+: mix with the player's own music instead of pausing it, and obey the silent switch
      try { if (navigator.audioSession) navigator.audioSession.type = 'ambient'; } catch {}
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.gain.value = 0.9; // peaks are <= 0.5, so two sounds at once stay under full scale
      master.connect(ctx.destination);
      setTimeout(() => { for (const k of ['place', 'cap', 'spread']) buffer(k); }, 0); // warm the frequent ones
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  } catch { /* no audio: stay silent */ }
}

function buffer(name, opts) {
  const voiced = SOUNDS[name].voiced;
  const key = (voiced ? `${name}:${voice}` : name) + (name === 'spread' ? `:${drops(opts)}` : '');
  let b = cache.get(key);
  if (!b) {
    const d = SOUNDS[name].render(ctx.sampleRate, voiced ? { ...opts, voice } : opts);
    b = ctx.createBuffer(1, d.length, ctx.sampleRate);
    b.getChannelData(0).set(d);
    cache.set(key, b);
  }
  return b;
}

// The gesture listeners (call once at startup): every press, tap and key unlocks or resumes the context, inside the
// gesture as iOS needs. Document level, capture, passive: board.js cancels touchend on the board (no click follows a
// tap) and holdTaps stops touches from bubbling, so bubbling listeners or click alone would miss them.
let listening = false;
export function listen() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  for (const t of ['pointerdown', 'touchend', 'keydown', 'click']) document.addEventListener(t, unlock, { capture: true, passive: true });
}

const lastAt = new Map(); // name -> when it last started: the same sound twice within REPEAT_MS is one sound
const REPEAT_MS = 40;
const RESUME_MS = 250; // a sound asked for while the context resumes still plays if it resumes within this
// The page has had a gesture, maybe one our listeners never saw: a tap inside the PTN Ninja iframe activates this
// page too (activation propagates to ancestor frames), so the context may be started from here.
const activated = () => { try { return !!navigator.userActivation?.hasBeenActive; } catch { return false; } };
// Play a sound now; a silent no-op when off, never unlocked, the page hidden, or anything goes wrong. While the
// context is suspended or interrupted it is resumed and the sound starts once it runs (dropped if that takes longer
// than RESUME_MS or resume() rejects); nothing else is queued.
export function play(name, opts) {
  try {
    if (!enabled || !SOUNDS[name]) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if ((!ctx || ctx.state !== 'running') && activated()) unlock();
    if (!ctx) return;
    const now = performance.now();
    if (now - (lastAt.get(name) ?? -1e9) < REPEAT_MS) return;
    lastAt.set(name, now);
    const start = () => {
      const src = ctx.createBufferSource();
      src.buffer = buffer(name, opts);
      src.connect(master);
      src.onended = () => src.disconnect();
      src.start();
    };
    if (ctx.state === 'running') return start();
    ctx.resume().then(() => {
      try { if (enabled && ctx.state === 'running' && performance.now() - now < RESUME_MS) start(); } catch {}
    }, () => {});
  } catch { /* never throw into the game */ }
}

// Play `name` after `ms` (a verdict after the move's own click, so the two don't mask each other). Whether it plays is
// decided then, like play().
export function later(name, ms, opts) {
  if (!enabled) return;
  setTimeout(() => play(name, opts), ms);
}

// Which sound a move makes, from its PTN (canonical or not): a capstone placed 'cap', any other placement 'place', a
// stack move one tap per square dropped on, 'smash' when it flattened a wall (the caller knows: board.js stepSnap).
export function moveSound(ptn, smash = false) {
  if (smash) return ['smash'];
  const s = String(ptn || '');
  const m = /^([1-8])?([a-h])([1-8])([<>+-])(\d*)/.exec(s);
  if (m) return ['spread', { drops: m[5] ? m[5].length : 1 }];
  return [/^C/.test(s) ? 'cap' : 'place'];
}
export const playMove = (ptn, smash) => play(...moveSound(ptn, smash));
