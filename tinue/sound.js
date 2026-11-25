// tinue's sounds: short, dry, quiet wood and stone, all synthesized here (no samples).
// Pure DSP (SOUNDS[name].render(sampleRate, opts) -> Float32Array, mono, deterministic) plus a tiny Web Audio player
// (unlock / play / playMove / setEnabled / setVoice) that does nothing outside a browser.
// The move sounds are a small physical model of a wooden set, read from plain data (MOVE_RECIPES, rendered by
// renderRecipe): a contact-noise burst, the piece's damped modes, the board's body under it, and any number of events
// (bounces, a smash's second impact). Each comes in VARIANTS slightly different takes and in three voices (light:
// least board body, highest; thunk, the default; deep: most body). wrong and rushGood have the older three voices;
// solved, rushEnd and lowTime one.

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
// f is held under Nyquist (0.45 sr, as contact() does): above it the filter is unstable and the sound turns to NaN
// (solved's 6 kHz low-pass at the fitter's 8 or 11 kHz; at 44.1 and 48 kHz nothing changes).
function biquad(buf, sr, type, f, q, from = 0) {
  f = Math.min(f, 0.45 * sr);
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

export const VOICES = ['light', 'thunk', 'deep'];
export const DEFAULT_VOICE = 'thunk';
const voiceOf = (opts) => (VOICES.includes(opts?.voice) ? opts.voice : DEFAULT_VOICE);

// ---- the move sounds: a physical model read from plain data ----
//
// A recipe (JSON-compatible; the tuning page and scripts/fit-sound.mjs read and write the same format):
//   { level, ms?, seed?, events: [event, ...] }
//   level   the loudness target in dBFS as loudness() measures it; the buffer is scaled to it, never above PEAK
//   ms      total length (default: the last event's start plus its longest ring, T60); the last 8 ms fade to 0
//   seed    the noise seed (default 1)
//   event   { at, gain, contact, modes, body }: at in ms from the start; gain scales the whole event.
//           A later event that leaves out contact, modes or body repeats the previous event's (null: none).
//   contact { ms, lo, hi, gain }: the strike, noise band-limited to lo..hi Hz (4th-order edges), under a
//           smooth envelope that peaks at ms/5 and is 40 dB down at ms; gain is its RMS over those ms.
//   modes   [{ f, ms, gain, phase? }]: the piece ringing, exponentially damped sines; ms is the T60 (the time
//           to fall 60 dB), gain the starting amplitude, phase (radians, default 0: sine phase) only where a fit to a
//           recording found one. A negative gain is the same ring with its sign flipped, as a mode radiating in
//           antiphase to its neighbours does; it keeps the in-phase starts from adding up to one sharp peak.
//   body    { f, ms, gain, phase? }: the board under the piece, a damped sine with a 1 ms rise (ms is its T60).
const LN1000 = Math.log(1000);

// A 2nd-order Butterworth high- or low-pass (RBJ), in place. Run twice for a 4th-order edge.
function edge(buf, sr, type, f) {
  const w = (2 * Math.PI * f) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2);
  const b0 = type === 'lp' ? (1 - c) / 2 : (1 + c) / 2, b1 = type === 'lp' ? 1 - c : -(1 + c), b2 = b0;
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i], y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y; buf[i] = y;
  }
}

// The contact burst of an event at t ms, scaled by g.
function contact(buf, sr, t, c, g, seed) {
  if (!c || !(c.gain > 0) || !(c.ms > 0)) return;
  const r = rng(seed), n = Math.max(4, Math.round((c.ms * sr) / 1000)), tp = n / 5;
  const tmp = new Float64Array(n + Math.round(0.004 * sr)), nyq = 0.45 * sr, hi = Math.min(c.hi || nyq, nyq), lo = Math.min(c.lo || 0, hi / 2);
  // The noise: equal-amplitude sines every ~60 Hz (each nudged up to 20 Hz) at random phases, over the band and half
  // an octave past each edge. Noise as the ear takes it in a few ms, but with a flat spectrum: white noise this short
  // draws its own lumpy one each time, and takes of a sound would differ in brightness by 20-30%.
  const f0 = Math.max(20, lo / 1.5), f1 = Math.min(nyq, hi * 1.5), ws = [], ph = [];
  for (let f = f0; f < f1; f += 60) { ws.push((2 * Math.PI * (f + 20 * (2 * r() - 1))) / sr); ph.push(2 * Math.PI * r()); }
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < ws.length; k++) v += Math.cos(ws[k] * i + ph[k]);
    const u = i / tp;
    tmp[i] = v * u * u * Math.exp(2 * (1 - u)); // its envelope: the peak at ms/5, -41 dB at ms
  }
  if (lo > 20) { edge(tmp, sr, 'hp', lo); edge(tmp, sr, 'hp', lo); }
  if (hi < nyq) { edge(tmp, sr, 'lp', hi); edge(tmp, sr, 'lp', hi); }
  let ss = 0;
  for (let i = 0; i < n; i++) ss += tmp[i] * tmp[i];
  // a soft ceiling at 2.5 x its RMS: the odd tall noise spike would otherwise set the whole sound's peak (and level)
  const s = Math.sqrt(ss / n) || 1, cl = 2.5 * s, a = (c.gain * g) / s, i0 = Math.round((t * sr) / 1000);
  for (let i = 0; i < tmp.length && i0 + i < buf.length; i++) buf[i0 + i] += a * cl * Math.tanh(tmp[i] / cl);
}

// One damped sine at t ms: frequency f, T60 t60 ms, starting amplitude amp, optional rise time (ms, 1 - e^-t/rise).
function ring(buf, sr, t, f, t60, amp, riseMs = 0, phase = 0) {
  if (!amp || !(t60 > 0) || !(f > 0) || f >= 0.48 * sr) return;
  const i0 = Math.round((t * sr) / 1000), k = LN1000 / ((t60 * sr) / 1000), w = (2 * Math.PI * f) / sr;
  const kr = riseMs > 0 ? 1000 / (riseMs * sr) : 0;
  for (let i = i0, n = 0; i < buf.length; i++, n++) {
    const e = amp * Math.exp(-n * k);
    if (Math.abs(e) < 1e-7) break;
    buf[i] += e * (kr ? 1 - Math.exp(-n * kr) : 1) * Math.sin(w * n + phase);
  }
}

// The events of a recipe with every repeated part filled in (see the format above).
export function eventsOf(recipe) {
  let prev = { contact: null, modes: [], body: null };
  return (recipe?.events || []).map((e) => {
    const x = { at: Number(e.at) || 0, gain: e.gain ?? 1 };
    for (const k of ['contact', 'modes', 'body']) x[k] = e[k] !== undefined ? e[k] : prev[k];
    return (prev = x);
  });
}

// The length (ms) a recipe renders to.
export function recipeMs(recipe) {
  if (recipe.ms > 0) return Math.min(recipe.ms, 1000);
  let end = 10;
  for (const e of eventsOf(recipe)) {
    let r = e.contact ? e.contact.ms + 4 : 0;
    for (const m of e.modes || []) r = Math.max(r, m.ms);
    if (e.body) r = Math.max(r, e.body.ms);
    end = Math.max(end, e.at + r);
  }
  return Math.min(Math.ceil(end + 2), 1000);
}

// Render a recipe to a finished buffer: no DC, 0.5 ms fade in and 8 ms fade out to exact zero, scaled to its level.
// opts.raw: skip the level (return the unscaled sum, for the fitter).
export function renderRecipe(recipe, sr, opts = {}) {
  const b = len(sr, recipeMs(recipe)), seed = (recipe.seed ?? 1) >>> 0;
  eventsOf(recipe).forEach((e, k) => {
    if (!(e.gain > 0)) return;
    contact(b, sr, e.at, e.contact, e.gain, seed * 7919 + k * 104729 + 13);
    for (const m of e.modes || []) ring(b, sr, e.at, m.f, m.ms, m.gain * e.gain, 0, m.phase || 0);
    if (e.body) ring(b, sr, e.at, e.body.f, e.body.ms, e.body.gain * e.gain, 1, e.body.phase || 0);
  });
  let m = 0;
  for (const v of b) m += v;
  m /= b.length;
  for (let i = 0; i < b.length; i++) b[i] -= m;
  const N = b.length, a = Math.max(2, Math.round(0.0005 * sr)), f = Math.min(Math.max(2, Math.round(0.008 * sr)), N >> 2);
  for (let j = 0; j < a; j++) b[j] *= 0.5 * (1 - Math.cos((Math.PI * j) / (a - 1)));
  for (let j = 0; j < f; j++) b[N - f + j] *= 0.5 * (1 + Math.cos((Math.PI * j) / (f - 1)));
  const out = Float32Array.from(b);
  out[0] = 0; out[N - 1] = 0;
  if (opts.raw) return out;
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (!(peak > 0)) return out;
  const g = Math.min(10 ** (((recipe.level ?? -22) - loudness(out, sr)) / 20), PEAK / peak);
  for (let i = 0; i < N; i++) out[i] *= g;
  return out;
}

// The data. Frequencies in Hz, times in ms (mode and body ms are T60s). The thunk voice is the recipes as written;
// a voice is a transform of them (pitch: the piece's modes; modeMs: their ring; contact and body: factors on those
// fields; level: dB). light is a lighter set on a thinner board: higher, shorter, almost no body. deep is a heavier set
// on a thick board: lower, a longer and stronger body, a softer strike.
// vary: how far the VARIANTS takes of a sound wander from it (fractions, and dB): pitch moves every mode together,
// mode each one alone, decay their rings, at the later events' times (bounces), contact the strike's length.
export const MOVE_RECIPES = {
  voices: {
    light: { pitch: 1.14, modeMs: 0.8, contact: { gain: 1.15, hi: 1.12, ms: 0.85 }, body: { f: 1.3, ms: 0.6, gain: 0.3 }, level: -0.5 },
    thunk: {},
    deep: { pitch: 0.88, modeMs: 1.12, contact: { gain: 0.85, hi: 0.85, ms: 1.15 }, body: { f: 0.95, ms: 1.2, gain: 1.2 }, level: 1 },
  },
  vary: { variants: 4, pitch: 0.035, mode: 0.012, decay: 0.12, gainDb: 1.2, at: 0.1, contact: 0.08, levelDb: 0.6 },
  sounds: {
    // A flat on the bare board: a broad face landing, full contact noise, strong board body ("thock"), a small
    // bounce as the far edge comes down.
    flatBoard: { level: -25.5, events: [
      { at: 0, gain: 1, contact: { ms: 3.5, lo: 250, hi: 4500, gain: 1.2 },
        modes: [{ f: 470, ms: 50, gain: 0.8 }, { f: 612, ms: 44, gain: -1 }, { f: 795, ms: 38, gain: 1 }, { f: 1035, ms: 32, gain: -1 },
          { f: 1342, ms: 26, gain: 0.95 }, { f: 1768, ms: 21, gain: -0.85 }, { f: 2355, ms: 16, gain: 0.7 }, { f: 3110, ms: 12, gain: -0.5 }],
        body: { f: 205, ms: 95, gain: 0.9 } },
      { at: 21, gain: 0.26, contact: { ms: 1.5, lo: 300, hi: 4000, gain: 0.5 }, body: { f: 205, ms: 60, gain: 0.5 } },
    ] },
    // A flat onto a piece: wood on wood with the stack between it and the board: brighter, tighter, little body.
    flatPiece: { level: -26, events: [
      { at: 0, gain: 1, contact: { ms: 2.2, lo: 600, hi: 5000, gain: 1.3 },
        modes: [{ f: 649, ms: 34, gain: 0.75 }, { f: 847, ms: 30, gain: -1 }, { f: 1106, ms: 26, gain: 1 }, { f: 1441, ms: 22, gain: -1 },
          { f: 1876, ms: 18, gain: 0.95 }, { f: 2453, ms: 14, gain: -0.85 }, { f: 3256, ms: 10, gain: 0.65 }],
        body: { f: 320, ms: 45, gain: 0.3 } },
      { at: 14, gain: 0.15, contact: { ms: 1.2, lo: 500, hi: 4500, gain: 0.5 }, body: null },
    ] },
    // A wall stood on its edge: a small contact, lighter, higher and shorter ("tick"), a faint settle after.
    wallBoard: { level: -28.8, events: [
      { at: 0, gain: 1, contact: { ms: 1.5, lo: 900, hi: 5000, gain: 0.9 },
        modes: [{ f: 980, ms: 26, gain: 0.85 }, { f: 1290, ms: 22, gain: -1 }, { f: 1720, ms: 17, gain: 0.85 }, { f: 2260, ms: 12, gain: -0.7 },
          { f: 2950, ms: 9, gain: 0.55 }, { f: 3800, ms: 6, gain: -0.4 }],
        body: { f: 280, ms: 40, gain: 0.25 } },
      { at: 30, gain: 0.28, contact: { ms: 1.2, lo: 700, hi: 4500, gain: 0.5 }, body: { f: 260, ms: 30, gain: 0.2 } },
    ] },
    wallPiece: { level: -27.5, events: [
      { at: 0, gain: 1, contact: { ms: 1.2, lo: 1000, hi: 5000, gain: 1 },
        modes: [{ f: 1098, ms: 22, gain: 0.85 }, { f: 1445, ms: 18.5, gain: -1 }, { f: 1926, ms: 14.5, gain: 0.85 }, { f: 2531, ms: 10, gain: -0.7 },
          { f: 3304, ms: 7.5, gain: 0.55 }, { f: 4256, ms: 5, gain: -0.4 }],
        body: { f: 330, ms: 30, gain: 0.12 } },
      { at: 26, gain: 0.25, contact: { ms: 1, lo: 900, hi: 4500, gain: 0.5 }, body: null },
    ] },
    // The capstone, the heaviest piece, a turned block: a rounder, lower, single solid "tonk", the most board body.
    capBoard: { level: -25, events: [
      { at: 0, gain: 1, contact: { ms: 4.5, lo: 150, hi: 4000, gain: 0.8 },
        modes: [{ f: 352, ms: 60, gain: 1.04 }, { f: 468, ms: 52, gain: -1.3 }, { f: 618, ms: 44, gain: 1.17 }, { f: 826, ms: 35, gain: -0.845 },
          { f: 1108, ms: 26, gain: 0.45 }, { f: 1495, ms: 18, gain: -0.3 }, { f: 2040, ms: 12, gain: 0.2 }],
        body: { f: 190, ms: 110, gain: 0.75 } },
    ] },
    // The capstone onto a piece: a heavy clack.
    capPiece: { level: -25.5, events: [
      { at: 0, gain: 1, contact: { ms: 3, lo: 300, hi: 4500, gain: 0.9 },
        modes: [{ f: 410, ms: 44, gain: 0.75 }, { f: 545, ms: 38, gain: -1 }, { f: 720, ms: 31, gain: 0.9 }, { f: 960, ms: 25, gain: -0.7 },
          { f: 1290, ms: 18, gain: 0.5 }, { f: 1740, ms: 12, gain: -0.35 }, { f: 2370, ms: 8, gain: 0.25 }],
        body: { f: 240, ms: 60, gain: 0.45 } },
    ] },
    // A capstone flattening a wall: the cap's impact, then the wall slapping down flat under it (at least as loud as a
    // flat placed), then a settle.
    smash: { level: -23, events: [
      { at: 0, gain: 1, contact: { ms: 3, lo: 300, hi: 4500, gain: 0.9 },
        modes: [{ f: 410, ms: 44, gain: 0.975 }, { f: 545, ms: 38, gain: -1.3 }, { f: 720, ms: 31, gain: 1.17 }, { f: 960, ms: 25, gain: -0.91 },
          { f: 1290, ms: 18, gain: 0.65 }, { f: 1740, ms: 12, gain: -0.455 }, { f: 2370, ms: 8, gain: 0.325 }],
        body: { f: 240, ms: 60, gain: 0.45 } },
      { at: 90, gain: 1.15, contact: { ms: 8, lo: 200, hi: 5000, gain: 0.35 },
        modes: [{ f: 455, ms: 50, gain: 1.04 }, { f: 598, ms: 42, gain: -1.3 }, { f: 780, ms: 34, gain: 1.105 }, { f: 1020, ms: 27, gain: -0.91 },
          { f: 1330, ms: 20, gain: 0.715 }, { f: 1750, ms: 14, gain: -0.585 }, { f: 2340, ms: 10, gain: 0.455 }, { f: 3090, ms: 7, gain: -0.325 }],
        body: { f: 200, ms: 90, gain: 0.6 } },
      { at: 108, gain: 0.22, contact: { ms: 1.5, lo: 300, hi: 4000, gain: 0.5 }, body: { f: 200, ms: 60, gain: 0.35 } },
    ] },
    // One piece of a stack move let go onto the bare board / onto a piece: the flat sounds, softer and without the
    // bounce (it is set down, not dropped from a height).
    dropBoard: { level: -29.6, events: [
      { at: 0, gain: 1, contact: { ms: 3, lo: 250, hi: 4000, gain: 0.9 },
        modes: [{ f: 470, ms: 45, gain: 0.8 }, { f: 612, ms: 39.5, gain: -1 }, { f: 795, ms: 34, gain: 1 }, { f: 1035, ms: 29, gain: -1 },
          { f: 1342, ms: 23.5, gain: 0.95 }, { f: 1768, ms: 19, gain: -0.85 }, { f: 2355, ms: 14.5, gain: 0.7 }, { f: 3110, ms: 11, gain: -0.5 }],
        body: { f: 205, ms: 85, gain: 0.85 } },
    ] },
    dropPiece: { level: -30.4, events: [
      { at: 0, gain: 1, contact: { ms: 2, lo: 600, hi: 4500, gain: 1.04 },
        modes: [{ f: 649, ms: 30.5, gain: 0.75 }, { f: 847, ms: 27, gain: -1 }, { f: 1106, ms: 23.5, gain: 1 }, { f: 1441, ms: 20, gain: -1 },
          { f: 1876, ms: 16, gain: 0.95 }, { f: 2453, ms: 12.5, gain: -0.85 }, { f: 3256, ms: 9, gain: 0.65 }],
        body: { f: 320, ms: 40, gain: 0.3 } },
    ] },
  },
};
export const MOVE_SOUNDS = Object.keys(MOVE_RECIPES.sounds);
export const VARIANTS = MOVE_RECIPES.vary.variants;

// (a part left out of an event stays left out: it repeats the previous event's)
const tidy = (e) => { for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]; return e; };
// A recipe in a voice (an entry of MOVE_RECIPES.voices).
export function voiced(recipe, v = {}) {
  const c = v.contact || {}, bd = v.body || {}, p = v.pitch ?? 1, mm = v.modeMs ?? 1;
  return { ...recipe, level: (recipe.level ?? -22) + (v.level || 0), events: recipe.events.map((e) => tidy({ ...e,
    contact: e.contact && { ...e.contact, ms: e.contact.ms * (c.ms ?? 1), hi: e.contact.hi * (c.hi ?? 1), gain: e.contact.gain * (c.gain ?? 1) },
    modes: e.modes && e.modes.map((m) => ({ ...m, f: m.f * p, ms: m.ms * mm })),
    body: e.body && { ...e.body, f: e.body.f * (bd.f ?? 1), ms: e.body.ms * (bd.ms ?? 1), gain: e.body.gain * (bd.gain ?? 1) } })) };
}

const hashStr = (s) => { let a = 0x811c9dc5; for (const ch of String(s)) { a ^= ch.charCodeAt(0); a = Math.imul(a, 0x01000193) >>> 0; } return a; };
// Take i of a recipe (0: the recipe itself): every mode, ring, bounce time, level and the noise moved a little, the
// same way every time for the same (key, i).
export function vary(recipe, i, key = '') {
  i = Math.max(0, Math.round(Number(i) || 0));
  if (!i) return recipe;
  const V = MOVE_RECIPES.vary, r = rng(hashStr(key) + Math.imul(i, 0x9e3779b1)), u = () => 2 * r() - 1;
  const p = 1 + V.pitch * u(), bp = 1 + 0.5 * V.pitch * u();
  return { ...recipe, level: (recipe.level ?? -22) + V.levelDb * u(), seed: ((recipe.seed ?? 1) + 101 * i) >>> 0,
    events: recipe.events.map((e, k) => tidy({ ...e,
      at: k ? e.at * (1 + V.at * u()) : e.at,
      gain: k ? (e.gain ?? 1) * 10 ** ((V.gainDb * u()) / 20) : e.gain,
      contact: e.contact && { ...e.contact, ms: e.contact.ms * (1 + V.contact * u()), hi: e.contact.hi * (1 + 0.5 * V.contact * u()) },
      modes: e.modes && e.modes.map((m) => ({ ...m, f: m.f * p * (1 + V.mode * u()), ms: m.ms * (1 + V.decay * u()) })),
      body: e.body && { ...e.body, f: e.body.f * bp } })) };
}

const variantOf = (opts) => Math.min(VARIANTS - 1, Math.max(0, Math.round(Number(opts?.variant) || 0)));
// The brightness of a buffer: its RMS frequency, sqrt(E[x'^2] / E[x^2]) in units of the sample rate.
const brightness = (x) => { let d = 0, e = 0; for (let i = 1; i < x.length; i++) { d += (x[i] - x[i - 1]) ** 2; e += x[i] * x[i]; } return Math.sqrt(d / (e || 1)); };
const recipes = new Map(); // (the data, voice, variant) -> recipe: the seed choice below costs a few renders
// The recipe a move sound renders from, in a voice and a variant (0..VARIANTS-1). A take's noise is one of 6 seeds,
// the one whose take comes out closest in brightness to the first take: the contact and the modes overlap, so the
// noise alone can make one take 20-40% brighter than another, more than a small change.
export function recipeFor(name, voice = DEFAULT_VOICE, variant = 0) {
  return recipeFrom(customOf(name) || MOVE_RECIPES.sounds[name], name, voice, variant);
}
// The same for any base recipe in the format above (the sound lab's edits; recipeFor's base is the built-in one, or the
// device's own set on a beta build: setCustom).
export function recipeFrom(base, name, voice = DEFAULT_VOICE, variant = 0) {
  const v = VOICES.includes(voice) ? voice : DEFAULT_VOICE, vi = variantOf({ variant });
  const key = JSON.stringify([base, MOVE_RECIPES.voices[v], MOVE_RECIPES.vary, v, vi, name]);
  let r = recipes.get(key);
  if (r) return r;
  r = vary(voiced(base, MOVE_RECIPES.voices[v]), vi, `${name}:${v}`);
  if (vi) {
    // the built-in set's choices are written down (SEED_PICKS), so a take costs one render, not seven, in a tap
    const known = MOVE_RECIPES.sounds[name] && JSON.stringify(base) === JSON.stringify(MOVE_RECIPES.sounds[name]) ? SEED_PICKS[name]?.[v]?.[vi - 1] : undefined;
    r = { ...r, seed: (r.seed + 7919 * (known ?? seedPick(base, name, v, vi))) >>> 0 };
  }
  if (recipes.size > 500) recipes.clear();
  recipes.set(key, r);
  return r;
}
// Which of the 6 noise seeds take vi (1..VARIANTS-1) of a base recipe uses: j in 0..5, the seed vary() gave plus 7919 j.
export function seedPick(base, name, voice, vi) {
  const first = voiced(base, MOVE_RECIPES.voices[voice]), r = vary(first, vi, `${name}:${voice}`);
  const want = brightness(renderRecipe(first, 48000));
  let bd = Infinity, best = 0;
  for (let j = 0; j < 6; j++) {
    const d = Math.abs(Math.log(brightness(renderRecipe({ ...r, seed: (r.seed + 7919 * j) >>> 0 }, 48000)) / want));
    if (d < bd) { bd = d; best = j; }
  }
  return best;
}
// seedPick for the built-in recipes, takes 1-3 per voice. scripts/test-sound.mjs checks every one against seedPick and,
// after a change to MOVE_RECIPES, prints the table to paste here.
export const SEED_PICKS = {
  flatBoard: { light: [5, 0, 4], thunk: [3, 4, 3], deep: [4, 0, 0] },
  flatPiece: { light: [2, 1, 1], thunk: [1, 1, 1], deep: [1, 3, 4] },
  wallBoard: { light: [5, 1, 1], thunk: [4, 0, 2], deep: [5, 1, 1] },
  wallPiece: { light: [1, 1, 4], thunk: [1, 1, 5], deep: [0, 0, 2] },
  capBoard: { light: [4, 4, 0], thunk: [5, 0, 5], deep: [0, 4, 5] },
  capPiece: { light: [2, 1, 4], thunk: [2, 0, 1], deep: [1, 0, 4] },
  smash: { light: [3, 0, 2], thunk: [3, 0, 4], deep: [0, 0, 1] },
  dropBoard: { light: [3, 2, 3], thunk: [0, 4, 2], deep: [3, 0, 2] },
  dropPiece: { light: [2, 1, 4], thunk: [1, 1, 4], deep: [1, 3, 0] },
};

// ---- a device's own recipes (the sound lab, public/sound-lab.js; beta builds only) ----
// The lab can store an edited set in this browser ("Use these on this device"); the page then plays those instead of
// MOVE_RECIPES.sounds. Only where window.TINUE_BETA is set: on the real site nothing is read and setCustom does nothing.
export const CUSTOM_KEY = 'tinue.soundLab';
let custom = null;
const isBeta = () => { try { return typeof window !== 'undefined' && !!window.TINUE_BETA; } catch { return false; } };
// A recipe this file can render (the format above): plain objects, finite numbers in sane ranges, modes an array. A
// pasted or stored one that isn't (a null event, an object for modes, a contact 1e100 ms long) would throw or allocate
// without bound in every render, and playSeq's catch would make that move silent: such an entry is refused (the lab's
// paste) or left out (setCustom, loadCustom: the built-in sound plays).
const fin = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const opt = (v, lo, hi) => v === undefined || fin(v, lo, hi);
const obj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const ringOk = (m) => obj(m) && fin(m.f, 0, 24000) && fin(m.ms, 0, 5000) && fin(m.gain, -10, 10) && opt(m.phase, -100, 100);
const eventOk = (e) => obj(e) && opt(e.at, 0, 1000) && opt(e.gain, 0, 10)
  && (e.contact == null || (obj(e.contact) && fin(e.contact.ms, 0, 100) && fin(e.contact.gain, 0, 10) && opt(e.contact.lo, 0, 24000) && opt(e.contact.hi, 0, 24000)))
  && (e.modes == null || (Array.isArray(e.modes) && e.modes.length <= 32 && e.modes.every(ringOk)))
  && (e.body == null || ringOk(e.body));
export const validRecipe = (r) => obj(r) && Array.isArray(r.events) && r.events.length > 0 && r.events.length <= 16
  && opt(r.level, -80, 0) && opt(r.ms, 0, 1000) && opt(r.seed, 0, 2 ** 32) && r.events.every(eventOk);
function customOf(name) {
  const r = custom && isBeta() ? custom[name] : null;
  return validRecipe(r) ? r : null;
}
// sounds: { name: recipe } (any of MOVE_SOUNDS; others ignored), or null for the built-in set. Returns whether it took.
export function setCustom(sounds) {
  const ok = isBeta() && sounds && typeof sounds === 'object';
  custom = ok ? Object.fromEntries(Object.entries(sounds).filter(([k, r]) => MOVE_RECIPES.sounds[k] && validRecipe(r))) : null;
  if (custom && !Object.keys(custom).length) custom = null;
  cache.clear();
  return !!custom;
}
export const getCustom = () => (isBeta() ? custom : null);
// At startup: the set stored by the lab, if this is a beta build and there is one.
export function loadCustom() {
  if (!isBeta()) return setCustom(null);
  try { return setCustom(JSON.parse(localStorage.getItem(CUSTOM_KEY))?.sounds || null); } catch { return setCustom(null); }
}

// The older tables, for wrong and rushGood (unchanged): ms (length), f0 and modes ([ratio, amp, decay ms]) of the
// tock, noise (the strike's centre, Hz), hit (its strength), lp (the final low-pass, Hz), trim (dB added to the
// sound's loudness target).
const V = {
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

const MOVE_LABELS = {
  flatBoard: ['Flat', 'a flat placed on the board'],
  flatPiece: ['Flat on a piece', 'a flat set on top of a piece'],
  wallBoard: ['Wall', 'a wall stood on the board'],
  wallPiece: ['Wall on a piece', 'a wall stood on top of a piece'],
  capBoard: ['Capstone', 'a capstone placed on the board'],
  capPiece: ['Capstone on a piece', 'a capstone set on top of a piece'],
  smash: ['Smash', 'a capstone flattening a wall'],
  dropBoard: ['Drop', 'one piece of a stack move let go on an empty square'],
  dropPiece: ['Drop on a piece', 'one piece of a stack move let go on a piece'],
};

// Every sound: render(sampleRate, opts) -> Float32Array. The move sounds take opts.voice and opts.variant
// (0..VARIANTS-1); wrong and rushGood opts.voice. Loudness targets (dBFS, 50 ms RMS): the frequent sounds quietest.
export const SOUNDS = {
  ...Object.fromEntries(MOVE_SOUNDS.map((name) => [name, { label: MOVE_LABELS[name][0], desc: MOVE_LABELS[name][1],
    voiced: true, move: true, variants: VARIANTS,
    render: (sr, opts) => renderRecipe(recipeFor(name, voiceOf(opts), variantOf(opts)), sr) }])),
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

// ---- which sounds a move makes ----

// The sound of one piece landing: piece 'flat' | 'wall' | 'cap', onto 'board' | 'piece', drop: it is one of a stack
// move's pieces let go (a flat that is dropped is softer than one placed; a wall or capstone ending a spread on top
// makes its own sound).
export function pieceSound({ piece = 'flat', onto = 'board', drop = false } = {}) {
  const p = piece === 'wall' || piece === 'cap' ? piece : 'flat', o = onto === 'piece' ? 'Piece' : 'Board';
  return p === 'flat' && drop ? 'drop' + o : p + o;
}

// A stack move's drops: about DROP_GAP_MS apart, each gap DROP_JITTER (a fraction) longer or shorter at random.
export const DROP_GAP_MS = 105, DROP_JITTER = 0.2;
const PTN_MOVE = /^([1-8])?([a-h])([1-8])([<>+-])(\d*)/;
let pick = rng((Date.now() ^ 0x5bd1e995) >>> 0); // the player's dice: variants and drop timing (not the renders)

// The sounds of a whole move played back at once (the opponent's reply, a solution, a step through a line), as
// [[delay ms, sound name], ...], the first at 0. move: a PTN string, or { ptn, smash, top, onto }:
//   smash  the move flattened a wall (its last drop is the smash)
//   top    the piece on top of a moving stack: 'flat' | 'wall' | 'cap' (default 'flat'); the last drop is it
//   onto   per square dropped on, 'board' (it was empty) or 'piece' (default 'piece')
// A placement is always onto the bare board: Cxx a capstone, Sxx a wall, else a flat. opts.seed: fixed timing.
//   piece  a placement's piece, 'flat' | 'wall' | 'cap' (board.js gives it; without it the PTN's C/S prefix says)
export function moveSounds(move, opts = {}) {
  const m = typeof move === 'string' || move == null ? { ptn: move } : move;
  const s = String(m.ptn ?? ''), sp = PTN_MOVE.exec(s);
  if (!sp) return [[0, m.smash ? 'smash' : pieceSound({ piece: m.piece || (/^C/.test(s) ? 'cap' : /^S/.test(s) ? 'wall' : 'flat') })]];
  const n = Math.min(8, sp[5] ? sp[5].length : 1), onto = Array.isArray(m.onto) ? m.onto : [], top = m.top || 'flat';
  const list = [];
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    list.push({ piece: last ? top : 'flat', onto: onto[i] || 'piece', drop: true, smash: last && !!m.smash });
  }
  return landingSounds(list, opts);
}

// Landings in a row (pieces let go one after another, as by a hand): [{ piece, onto, drop, smash }, ...] ->
// [[delay ms, name], ...], the first at 0, the rest DROP_GAP_MS apart ± DROP_JITTER at random (opts.seed: fixed).
export function landingSounds(list, opts = {}) {
  const r = opts.seed != null ? rng(opts.seed) : pick, out = [];
  let t = 0;
  for (const l of Array.isArray(list) ? list : []) {
    out.push([Math.round(t), l?.smash ? 'smash' : pieceSound(l || {})]);
    t += DROP_GAP_MS * (1 + DROP_JITTER * (2 * r() - 1));
  }
  return out;
}

// ---- playback (browser only) ----

const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : undefined;
let ctx = null, master = null, enabled = true, voice = DEFAULT_VOICE;
const cache = new Map(); // name[:voice][:variant] -> AudioBuffer at ctx.sampleRate

// The voice of the move sounds (VOICES); anything else leaves it as it is. Takes effect with the next sound; the
// frequent sounds of the new voice are rendered in the background (warm).
export const setVoice = (v) => { if (VOICES.includes(v) && v !== voice) { voice = v; warm(); } };
export const getVoice = () => voice;

// Off stops every sound started or queued (a spread's later drops would otherwise wait in the frozen context and play
// when it resumes) and suspends the context, so no audio thread renders silence; unlock() (or a play) resumes it.
export const setEnabled = (on) => {
  enabled = !!on;
  if (!enabled) hush();
};
export const isEnabled = () => enabled;

// Every move sound, the frequent ones first: rendered in advance, one buffer per task, so no first play renders in a tap.
const WARM = ['flatBoard', 'dropPiece', 'dropBoard', 'flatPiece', 'capBoard', 'wallBoard', 'smash', 'capPiece', 'wallPiece'];
let warmGen = 0;
function warm() {
  if (!ctx) return;
  const gen = ++warmGen; // (a newer warm, after a change of voice, replaces this one)
  WARM.flatMap((k) => [...Array(VARIANTS).keys()].map((i) => [k, i])).forEach(([k, i], j) =>
    setTimeout(() => { try { if (ctx && gen === warmGen) buffer(k, i); } catch {} }, 20 * j));
}

// ---- sleeping while idle ----
// A running AudioContext costs CPU and keeps the audio hardware awake even when it plays nothing (about 0.6-1 s of CPU
// a minute, in a hidden tab too). So it is suspended IDLE_MS after the last sound ends (or the last tap: unlock), and at
// once when the tab is hidden; the next sound resumes it and starts once it runs (playSeq's waiting path).
const IDLE_MS = 1500;
let busyUntil = 0, idleT = null, sleeping = null; // sleeping: a suspend() still settling
function armIdle() {
  if (!ctx) return;
  clearTimeout(idleT);
  idleT = setTimeout(idle, Math.max(0, busyUntil - performance.now()) + IDLE_MS);
}
function idle() {
  idleT = null;
  if (waiting.size || performance.now() < busyUntil + IDLE_MS - 5) return armIdle(); // (a sound arrived meanwhile)
  sleep();
}
function sleep() {
  clearTimeout(idleT); idleT = null;
  try {
    if (!ctx || ctx.state !== 'running' || sleeping) return;
    const p = sleeping = Promise.resolve(ctx.suspend()).catch(() => {}).then(() => { if (sleeping === p) sleeping = null; });
  } catch { /* no audio */ }
}
// Resolves once the context runs. Called inside a gesture, resume() is called in it, as iOS needs.
// (resume() right away, even while a suspend() settles: the context runs them in order, so it ends up running.)
function wake() {
  return ctx.state === 'running' && !sleeping ? Promise.resolve() : Promise.resolve(ctx.resume());
}
// Everything stops: what sounds, what is queued on the audio clock, what waits for a resume; then the context sleeps.
// (Off, and a hidden tab: a frozen context would play the rest of a spread when it next resumes.)
const live = new Set(); // every source started, until it ends
function hush() {
  try {
    for (const src of live) { try { src.stop(); } catch {} }
    live.clear(); queued.clear(); waiting.clear(); mains.clear(); stash = null; gen++;
    sleep();
  } catch { /* never throw into the game */ }
}

// Call on every gesture: creates the AudioContext on the first one that activates the page and resumes it if
// suspended. A touch pointerdown does not activate the page (its pointerup/touchend does), so it only resumes.
export function unlock(e) {
  try {
    if (!AC || !enabled) return;
    if (!ctx) {
      if (e && e.type === 'pointerdown' && e.pointerType && e.pointerType !== 'mouse') { touchAt = performance.now(); return; }
      // iOS 16.4+: mix with the player's own music instead of pausing it, and obey the silent switch
      try { if (navigator.audioSession) navigator.audioSession.type = 'ambient'; } catch {}
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.gain.value = 0.9; // peaks are <= 0.5, so two sounds at once stay under full scale
      master.connect(ctx.destination);
      warm();
    }
    if (ctx.state !== 'running' || sleeping) wake().catch(() => {});
    armIdle(); // (a tap that plays nothing still resumed it: it sleeps again IDLE_MS later)
    // A move asked for before the page was ever activated (a long press placing the very first stone: its touchend is
    // the first activating event): it plays now, if the board hasn't moved on since and it is recent.
    const s = stash; stash = null;
    if (s && s.g === gen && performance.now() - s.at < STASH_MS) playSeq(s.list, s.opts);
  } catch { /* no audio: stay silent */ }
}
let stash = null, touchAt = -1e9; // touchAt: a touch pressed before the page was activated (only it may stash a move)
const STASH_MS = 1000;

function buffer(name, variant = 0, opts) {
  const s = SOUNDS[name], voiced = s.voiced;
  const key = name + (voiced ? `:${voice}` : '') + (s.move ? `:${variant}` : '');
  let b = cache.get(key);
  if (!b) {
    const d = s.render(ctx.sampleRate, voiced ? { ...opts, voice, variant } : opts);
    b = ctx.createBuffer(1, d.length, ctx.sampleRate);
    b.getChannelData(0).set(d);
    cache.set(key, b);
  }
  return b;
}

// A move sound's take: at random, never the one it played last (in this voice).
const lastTake = new Map();
function take(name) {
  if (!SOUNDS[name]?.move) return 0;
  const k = name + ':' + voice, prev = lastTake.get(k);
  let i = Math.floor(pick() * VARIANTS);
  if (VARIANTS > 1 && i === prev) i = (i + 1 + Math.floor(pick() * (VARIANTS - 1))) % VARIANTS;
  lastTake.set(k, i);
  return i;
}

// The gesture listeners (call once at startup): every press, tap and key unlocks or resumes the context, inside the
// gesture as iOS needs. Document level, capture, passive: a handler that stops a press (app.js's click while a move is
// held) can't hide it from these. A hidden tab stops every sound and sleeps at once.
let listening = false;
export function listen() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  for (const t of ['pointerdown', 'touchend', 'keydown', 'click']) document.addEventListener(t, unlock, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) hush(); });
}

const lastAt = new Map(); // key -> when it last started: the same sound twice within REPEAT_MS is one sound
const REPEAT_MS = 40;
const RESUME_MS = 250; // a sound asked for while the context resumes still plays if it resumes within this
// The page has had a gesture, maybe one our listeners never saw: a tap inside the PTN Ninja iframe activates this
// page too (activation propagates to ancestor frames), so the context may be started from here.
const activated = () => { try { return !!navigator.userActivation?.hasBeenActive; } catch { return false; } };
const hidden = () => typeof document !== 'undefined' && !!document.hidden;

// Play a list of [delay ms, sound name] (as moveSounds gives), timed on the audio clock; a silent no-op when off,
// never unlocked, the page hidden, or anything goes wrong. While the context is suspended (asleep while idle, or
// interrupted) it is resumed and the sounds start once it runs, dropped if that takes longer than RESUME_MS, resume()
// rejects, or (a move's sounds) the board jumped meanwhile (cut).
// A one-off sound (play, later, verdict) twice within REPEAT_MS plays once, and so does one move (opts.key, playMove);
// the landings of a hand are each their own sound however fast they come.
// A move's sounds still queued on the audio clock (a spread's later drops): cut() stops them. A new move cuts them
// (playMove, playLanding), and so does a jump to another position (board-kit.js hooks.onCut, set by app.js).
// What the player's own hand queued (playLanding: a capstone moving on alone to flatten a wall) is never stopped: the
// next board event (Rush's reply 80 ms later, the next puzzle's load) must not silence the move just made.
const queued = new Set(); // { src, t (audio clock), hand, rec }
const waiting = new Set(); // lists waiting for a resume: { hand, cut (a later move cut its later sounds), recs }
function stopQueued() {
  try {
    const now = ctx ? ctx.currentTime || 0 : 0;
    for (const q of queued) {
      if (q.hand) continue;
      if (q.t > now) { try { q.src.stop(); } catch {} mains.delete(q.rec); }
      queued.delete(q);
    }
    for (const w of waiting) if (!w.hand) { w.cut = true; for (const r of w.recs) if (r?.ms > 0) mains.delete(r); }
  } catch { /* never throw into the game */ }
}
// A jump to another position: queued drops stop, a move waiting for a resume is dropped, and the next move sounds
// even within REPEAT_MS of the last.
export function cut() { stopQueued(); lastAt.clear(); gen++; }
let gen = 0; // (cut() counts up: a move sound held back by holdMoves, or waiting for a resume, is dropped if it moved)

// When the move sounds asked for so far will have played their main part (performance.now() ms): per sound, the start
// of the last event that carries at least half the first's gain (a smash's slap), plus SETTLE_MS for it to ring. A
// sound stopped before it started (cut) no longer counts.
const SETTLE_MS = 40;
const mains = new Set(); // { end, ms }
function mainMs(name) {
  try {
    let at = 0;
    for (const e of eventsOf(recipeFor(name, voice, 0))) if ((e.gain ?? 1) >= 0.5) at = Math.max(at, e.at);
    return at + SETTLE_MS;
  } catch { return SETTLE_MS; }
}
// ms from now until the move sounds asked for so far have played their main part (0 when they have).
export const tail = () => {
  const now = performance.now();
  let end = now;
  for (const r of mains) { if (r.end <= now) mains.delete(r); else end = Math.max(end, r.end); }
  return end - now;
};

export function playSeq(list, opts) {
  try {
    if (opts?.cut) stopQueued();
    if (!enabled || !Array.isArray(list) || !list.length) return;
    list = list.map(([ms, name]) => [Math.max(0, Number(ms) || 0), name]).filter(([, n]) => SOUNDS[n]);
    if (!list.length || hidden()) return;
    if ((!ctx || ctx.state !== 'running') && activated()) unlock();
    // (Only a move made by a touch still under way: anything else asked for before activation, such as a puzzle's
    // intro move, would otherwise sound late on the player's first tap, on top of that tap's own sound.)
    if (!ctx) { if (opts?.cut && performance.now() - touchAt < STASH_MS) stash = { list, opts, at: performance.now(), g: gen }; return; }
    const now = performance.now(), key = opts?.cut ? opts.key : list[0][1];
    if (key != null) {
      if (now - (lastAt.get(key) ?? -1e9) < REPEAT_MS) return;
      lastAt.set(key, now);
    }
    const recs = list.map(([ms, name]) => (SOUNDS[name].move ? { end: now + ms + mainMs(name), ms } : null));
    for (const r of recs) if (r) mains.add(r);
    const start = (w) => {
      const t0 = ctx.currentTime || 0, at = performance.now();
      list.forEach(([ms, name], i) => {
        if (w?.cut && ms > 0) return; // (a later move cut this one's later sounds while it waited)
        const src = ctx.createBufferSource();
        src.buffer = buffer(name, take(name), opts?.render);
        src.connect(master);
        const q = ms > 0 && opts?.cut ? { src, t: t0 + ms / 1000, hand: !!opts.hand, rec: recs[i] } : null;
        if (q) queued.add(q);
        live.add(src);
        src.onended = () => { src.disconnect(); live.delete(src); if (q) queued.delete(q); };
        if (ms > 0) src.start(t0 + ms / 1000); else src.start();
        busyUntil = Math.max(busyUntil, at + ms + (1000 * src.buffer.length) / ctx.sampleRate);
      });
      armIdle();
    };
    if (ctx.state === 'running' && !sleeping) return start();
    // Waiting for the context to run: a move stepped away from meanwhile (cut: gen) never sounds late, and nothing
    // starts in a hidden tab.
    const g = gen, w = { hand: !!opts?.hand, cut: false, recs };
    waiting.add(w);
    busyUntil = Math.max(busyUntil, now + RESUME_MS);
    // Not started after all: the context goes back to sleep, at once if the tab was hidden or sound turned Off while it
    // resumed (hush() found it not yet running, so its sleep() did nothing), else after IDLE_MS.
    const drop = () => { for (const r of recs) mains.delete(r); if (hidden() || !enabled) sleep(); else armIdle(); };
    wake().then(() => {
      if (!waiting.delete(w)) return drop(); // (hush() let it go)
      if (enabled && !hidden() && ctx.state === 'running' && performance.now() - now < RESUME_MS && !(opts?.cut && g !== gen)) start(w);
      else drop();
    }, () => { waiting.delete(w); drop(); });
  } catch { /* never throw into the game */ }
}

// Play a sound now (a name of SOUNDS).
export function play(name, opts) { playSeq([[0, name]], { render: opts }); }

// Pieces landing by hand, one input at a time (board-kit.js hooks.onLand; unused on PTN Ninja, which reports whole moves): usually one; two when the rest of the hand is
// set down before the capstone moves on alone to flatten a wall.
export const playLanding = (list) => playSeq(landingSounds(list), { cut: true, hand: true });

// A whole move at once (see moveSounds). hooks.onPly (board-kit.js) calls playMove(ptn, smash, info): info { piece } for a placement,
// { top, onto } for a stack move (board.js landOf); info.byHand: its pieces already sounded as they landed (playLanding),
// so nothing plays.
// While a verdict plays (holdMoves), a move's sound waits for it: Rush's next puzzle puts its intro move on the board at
// once (or 100 ms later), on top of the verdict.
export const playMove = (ptn, smash = false, info = {}) => {
  if (info?.byHand) return;
  const list = moveSounds({ ...info, ptn, smash: !!smash }), wait = holdUntil - performance.now(), g = gen;
  const opts = { cut: true, key: 'move:' + ptn }; // (one move twice within REPEAT_MS is one; two moves are two)
  if (wait > 0) return void setTimeout(() => { if (g === gen) playSeq(list, opts); }, wait);
  playSeq(list, opts);
};
let holdUntil = 0;
// Move sounds asked for in the next ms wait until then (playMove).
export function holdMoves(ms) { holdUntil = Math.max(holdUntil, performance.now() + Math.max(0, Number(ms) || 0)); }

// Play `name` after `ms` (a verdict after the move's own click, so the two don't mask each other). Whether it plays is
// decided then, like play(). dropLater() forgets every cue still waiting (rush.js leave: a run's cues stay in the run).
const laters = new Set();
export function later(name, ms, opts) {
  if (!enabled) return;
  const t = setTimeout(() => { laters.delete(t); play(name, opts); }, ms);
  laters.add(t);
}
export function dropLater() { for (const t of laters) clearTimeout(t); laters.clear(); }
// A verdict on the move just made: `name` at least `ms` after it, and not before the move's own sounds have played their
// main part (a smash's slap, a spread's last drop: tail()). The next move sounds no sooner than holdMs after the verdict
// starts (holdMoves). Returns the delay used.
export function verdict(name, ms, holdMs = 0) {
  const d = Math.max(Number(ms) || 0, Math.round(tail()));
  later(name, d);
  if (holdMs > 0 && enabled) holdMoves(d + holdMs);
  return d;
}
