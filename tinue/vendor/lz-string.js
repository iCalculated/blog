// lz-string 1.5.0 (MIT, Copyright (c) 2013 pieroxy; see LICENSE-lz-string.txt beside this file), rewritten as an ES
// module with both halves of ptn.ninja's link format: compressToEncodedURIComponent and decompressFromEncodedURIComponent.
// Output is the same as the library's, byte for byte (scripts/test-ninja-look.mjs checks a real link both ways).
const URI_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$';

export function compressToEncodedURIComponent(input) {
  if (input == null) return '';
  const BITS = 6, out = [];
  let val = 0, pos = 0;
  const bit = (b) => {
    val = (val << 1) | b;
    if (pos === BITS - 1) { pos = 0; out.push(URI_SAFE[val]); val = 0; } else pos++;
  };
  const bits = (n, v) => { for (let i = 0; i < n; i++) { bit(v & 1); v >>= 1; } }; // low bit first
  const dict = new Map(), fresh = new Set(); // fresh: single characters not yet written out literally
  let w = '', size = 3, numBits = 2, enlargeIn = 2;
  const grow = () => { if (--enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; } };
  const emit = (s) => {
    if (fresh.has(s)) {
      const c = s.charCodeAt(0);
      if (c < 256) { bits(numBits, 0); bits(8, c); } else { bits(numBits, 1); bits(16, c); }
      grow();
      fresh.delete(s);
    } else bits(numBits, dict.get(s));
    grow();
  };
  for (let i = 0; i < input.length; i++) {
    const c = input.charAt(i);
    if (!dict.has(c)) { dict.set(c, size++); fresh.add(c); }
    const wc = w + c;
    if (dict.has(wc)) w = wc;
    else { emit(w); dict.set(wc, size++); w = c; }
  }
  if (w !== '') emit(w);
  bits(numBits, 2); // end of stream
  for (;;) { val <<= 1; if (pos === BITS - 1) { out.push(URI_SAFE[val]); break; } pos++; } // flush the last character
  return out.join('');
}

// The decompress half (added 2026-11-20 for the PTN Ninja settings string, whose theme comes compressed): the same
// format read back. Hostile input is expected here (a player pastes it), so this one stops early: null for a stream
// that isn't lz-string or whose output would pass maxOut characters (a short stream can expand quadratically).
export function decompressFromEncodedURIComponent(input, maxOut = 20000) {
  if (typeof input !== 'string' || input === '') return null;
  input = input.replace(/ /g, '+'); // (a + that a form or URL decoding turned into a space)
  const n = input.length;
  let idx = 0, val = 0, pos = 0;
  const next = () => { const v = URI_SAFE.indexOf(input.charAt(idx++)); val = v < 0 ? 0 : v; pos = 32; };
  next();
  const bits = (k) => { // low bit first, as written
    let r = 0;
    for (let i = 0; i < k; i++) { if (val & pos) r |= 1 << i; pos >>= 1; if (!pos) next(); }
    return r;
  };
  const dict = ['', '', ''];
  let numBits = 3, enlargeIn = 4, out = '';
  const grow = () => { if (--enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits++; } };
  const first = bits(2);
  if (first === 2) return '';
  if (first > 2) return null;
  let w = String.fromCharCode(bits(first === 0 ? 8 : 16));
  dict.push(w); out = w;
  for (;;) {
    if (idx > n) return null; // ran off the end without the end-of-stream code
    let c = bits(numBits);
    if (c === 2) return out;
    if (c < 2) { dict.push(String.fromCharCode(bits(c === 0 ? 8 : 16))); c = dict.length - 1; grow(); }
    const entry = c < dict.length && c > 2 ? dict[c] : c === dict.length ? w + w.charAt(0) : null;
    if (entry == null) return null;
    out += entry;
    if (out.length > maxOut) return null;
    dict.push(w + entry.charAt(0)); grow();
    w = entry;
  }
}
