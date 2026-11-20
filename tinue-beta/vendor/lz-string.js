// lz-string 1.5.0 (MIT, Copyright (c) 2013 pieroxy; see LICENSE-lz-string.txt beside this file), the compress half
// only, rewritten as an ES module: compressToEncodedURIComponent, the format of ptn.ninja's links. Output is the same
// as the library's, byte for byte (scripts/test-analysis.mjs checks a real link).
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
