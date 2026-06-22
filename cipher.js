// cipher.js — AUTO-GENERATED clean port (sample format).
// Reverse-engineered + verified byte-for-byte against the live bundle.
//
// The bundle ships a *bank* of 10 versioned cipher algorithms (v1..v10).
// At runtime a version number selects which algorithm encrypts/decrypts a
// token (e.g. Signin and Reserve are each assigned one of these versions).
// Every version exposes encryptText(token, key, skip, encryptLen) /
// decryptText(...). All 10 are reproduced below and verified against the
// bundle's own functions over a large random battery.

const Charset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
const N = Charset.length; // 64
function charsetIndex(ch) { return Charset.indexOf(ch); }

// ── shared drivers ───────────────────────────────────────────────────────────

// additive-shift driver: middle[i] = Charset[(idx ± shift[i]) % 64]
function additiveShift(token, key, skip, encryptLen, encrypt, genShifts) {
  if (!token) return token;
  const p = Math.max(0, Math.min(skip, token.length));
  const a = Math.max(0, Math.min(encryptLen, token.length - p));
  if (a === 0) return token;
  const mid = token.slice(p, p + a).split("");
  const sh = genShifts(key, mid.length);
  for (let i = 0; i < mid.length; i++) {
    const x = charsetIndex(mid[i]); if (x === -1) continue;
    mid[i] = encrypt ? Charset[(x + sh[i]) % N] : Charset[((x - sh[i]) % N + N) % N];
  }
  return token.slice(0, p) + mid.join("") + token.slice(p + a);
}

// ── v1: ChaCha-style ARX (10 column rounds, 4 shifts per 16-word block) ───────
const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
function quarterRound(a, b, c, d) {
  a = (a + b) >>> 0; d = rotl(d ^ a, 16);
  c = (c + d) >>> 0; b = rotl(b ^ c, 12);
  a = (a + b) >>> 0; d = rotl(d ^ a, 8);
  c = (c + d) >>> 0; b = rotl(b ^ c, 7);
  return [a, b, c, d];
}
function generateShiftsChaCha(key, length) {
  const o = new Array(16).fill(0);
  for (let d = 0; d < key.length; d++) o[d % 16] = (o[d % 16] + key.charCodeAt(d)) >>> 0;
  o[15] = length;
  const out = [];
  for (let blk = 0; blk < Math.ceil(length / 4); blk++) {
    o[14] = blk;
    const e = [...o];
    for (let r = 0; r < 10; r++) {
      let q;
      q = quarterRound(e[0], e[4], e[8], e[12]);  e[0] = q[0]; e[4] = q[1]; e[8] = q[2];  e[12] = q[3];
      q = quarterRound(e[1], e[5], e[9], e[13]);  e[1] = q[0]; e[5] = q[1]; e[9] = q[2];  e[13] = q[3];
      q = quarterRound(e[2], e[6], e[10], e[14]); e[2] = q[0]; e[6] = q[1]; e[10] = q[2]; e[14] = q[3];
      q = quarterRound(e[3], e[7], e[11], e[15]); e[3] = q[0]; e[7] = q[1]; e[11] = q[2]; e[15] = q[3];
    }
    out.push(...e.slice(0, 4).map(x => x % N));
  }
  return out;
}

// ── v2: Feistel substitution (8 LCG-derived round keys, 6-bit block) ──────────
function feistelRoundKeys(key, rounds) {
  let c = 0;
  for (let d = 0; d < key.length; d++) c = (c + Math.imul(key.charCodeAt(d), d + 1)) >>> 0;
  const rk = [];
  for (let d = 0; d < rounds; d++) { c = (Math.imul(c, 1103515245) + 12345) >>> 0; rk.push(7 & c); }
  return rk;
}
const feF = (x, t) => ((Math.imul(x, 3) + t) ^ 3) & 7;
function feistelEnc(idx, rk) { let i = (idx >> 3) & 7, c = idx & 7; for (let d = 0; d < rk.length; d++) { const e = c; c = i ^ feF(c, rk[d]); i = e; } return (c << 3) | i; }
function feistelDec(idx, rk) { let r = idx & 7, o = (idx >> 3) & 7; for (let d = rk.length - 1; d >= 0; d--) { const e = r; r = o ^ feF(r, rk[d]); o = e; } return (r << 3) | o; }
function feistel(token, key, skip, encryptLen, encrypt) {
  if (!token) return token;
  const p = Math.max(0, Math.min(skip, token.length));
  const a = Math.max(0, Math.min(encryptLen, token.length - p));
  if (a === 0) return token;
  const mid = token.slice(p, p + a).split("");
  const rk = feistelRoundKeys(key, 8);
  for (let i = 0; i < mid.length; i++) {
    const x = charsetIndex(mid[i]); if (x === -1) continue;
    mid[i] = Charset[(encrypt ? feistelEnc(x, rk) : feistelDec(x, rk)) % N];
  }
  return token.slice(0, p) + mid.join("") + token.slice(p + a);
}

// ── v3: Cellular Automaton (64-cell, rule cell = left ^ (self | right)) ───────
function generateShiftsCA(key, length) {
  let d = new Uint8Array(64);
  for (let p = 0; p < key.length; p++) d[p % 64] ^= key.charCodeAt(p) & 1;
  d[32] = 1;
  const out = [];
  for (let p = 0; p < length; p++) {
    const e = new Uint8Array(64); let t = 0;
    for (let f = 0; f < 64; f++) {
      const left = d[(f + 63) % 64], self = d[f], right = d[(f + 1) % 64];
      e[f] = left ^ (self | right);
      if (f < 6) t = (t << 1) | e[f];
    }
    d = e; out.push(t % N);
  }
  return out;
}

// ── v4: RC4 keystream (alphabet of 64), shift = keystream byte ────────────────
function generateShiftsRC4(key, length) {
  const a = Array.from({ length: 64 }, (_, t) => t);
  let c = 0;
  for (let k = 0; k < 64; k++) { c = (c + a[k] + key.charCodeAt(k % key.length)) % 64; [a[k], a[c]] = [a[c], a[k]]; }
  let W = 0; c = 0; const out = [];
  for (let k = 0; k < length; k++) { W = (W + 1) % 64; c = (c + a[W]) % 64; [a[W], a[c]] = [a[c], a[W]]; out.push(a[(a[W] + a[c]) % 64]); }
  return out;
}

// ── v5: three combined LFSRs (16/17/24-bit), output bit = LFSR-A ? B : C ──────
function generateShiftsLFSR(key, length) {
  let u = 0x12345, s = 0x6789A, l = 0xBCDEF;
  for (let g = 0; g < key.length; g++) { const cc = key.charCodeAt(g); u ^= cc | 1; s ^= (cc << 2) | 1; l ^= (cc << 4) | 1; }
  const out = [];
  for (let g = 0; g < length; g++) {
    let e = 0;
    for (let b = 0; b < 6; b++) {
      const tu = 1 & (u ^ (u >> 2) ^ (u >> 3) ^ (u >> 5)); u = (u >>> 1) | (tu << 15);
      const ts = 1 & (s ^ (s >> 1) ^ (s >> 2) ^ (s >> 7)); s = (s >>> 1) | (ts << 16);
      const tl = 1 & (l ^ (l >> 1) ^ (l >> 2) ^ (l >> 22)); l = (l >>> 1) | (tl << 23);
      e = (e << 1) | (tu ? ts : tl);
    }
    out.push(e % N);
  }
  return out;
}

// ── v6: polynomial over GF(67): shift_f = ( Σ coef[i]·f^i mod 67 ) mod 64 ─────
function generateShiftsPoly(key, length) {
  const m = Math.max(3, key.length);
  const coef = Array.from({ length: m }, (_, n) => (key.charCodeAt(n % key.length) + n) % 67);
  const out = [];
  for (let f = 1; f <= length; f++) {
    let e = 0, t = 1;
    for (const c of coef) { e = (e + c * t) % 67; t = (t * f) % 67; }
    out.push(e % N);
  }
  return out;
}

// ── v7: key-seeded Fisher-Yates substitution box, then reverse the middle ─────
function buildSbox(key) {
  const sbox = Array.from({ length: 64 }, (_, t) => t);
  let i = 0;
  for (let s = 0; s < 64; s++) { i = (i + sbox[s] + key.charCodeAt(s % key.length)) % 64; [sbox[s], sbox[i]] = [sbox[i], sbox[s]]; }
  const invSbox = new Array(64).fill(0);
  for (let k = 0; k < 64; k++) invSbox[sbox[k]] = k;
  return { sbox, invSbox };
}
function substituteReverse(token, key, skip, encryptLen, encrypt) {
  if (!token) return token;
  const p = Math.max(0, Math.min(skip, token.length));
  const a = Math.max(0, Math.min(encryptLen, token.length - p));
  if (a === 0) return token;
  const mid = token.slice(p, p + a).split("");
  const { sbox, invSbox } = buildSbox(key);
  if (encrypt) {
    for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x !== -1) mid[i] = Charset[sbox[x]]; }
    mid.reverse();
  } else {
    mid.reverse();
    for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x !== -1) mid[i] = Charset[invSbox[x]]; }
  }
  return token.slice(0, p) + mid.join("") + token.slice(p + a);
}

// ── v8: LCG additive shift (seed 123456789, mul 1103515245) ───────────────────
function generateShiftsLCG(key, length) {
  let seed = 123456789, mul = 1103515245;
  for (let i = 0; i < key.length; i++) seed = (seed + key.charCodeAt(i)) >>> 0;
  const out = new Array(length);
  for (let i = 0; i < length; i++) { seed = (Math.imul(seed, mul) + 12345) >>> 0; mul = ((mul + seed) >>> 0) | 1; out[i] = (seed >>> 16) % N; }
  return out;
}

// ── v9: modular-squaring (BBS-style): s = s² mod (1000003·1000033) ────────────
function generateShiftsModSquare(key, length) {
  const A = 1000003n * 1000033n; // 1000036000099
  let s = 314159265n;
  for (let i = 0; i < key.length; i++) s = (s + BigInt(key.charCodeAt(i)) * BigInt(i + 1)) % A;
  if (s % 2n === 0n) s += 1n;
  const out = new Array(length);
  for (let i = 0; i < length; i++) { s = (s * s) % A; out[i] = Number(s % BigInt(N)); }
  return out;
}

// ── v10: logistic-map chaos (x = 3.99·x·(1−x), 100-step warm-up) ──────────────
function generateShiftsLogistic(key, length) {
  let x = 0.5;
  for (let d = 0; d < key.length; d++) x = (x + key.charCodeAt(d) / 256) % 1;
  if (x === 0) x = 0.5;
  const out = [];
  for (let d = 0; d < length + 100; d++) { x = 3.99 * x * (1 - x); if (d >= 100) out.push(Math.floor(x * 1e7) % N); }
  return out;
}

// ── version registry: each maps to { encryptText, decryptText } ───────────────
const Versions = {
  1:  { encryptText: (t, k, s, l) => additiveShift(t, k, s, l, true,  generateShiftsChaCha),
        decryptText: (t, k, s, l) => additiveShift(t, k, s, l, false, generateShiftsChaCha) },
  2:  { encryptText: (t, k, s, l) => feistel(t, k, s, l, true),
        decryptText: (t, k, s, l) => feistel(t, k, s, l, false) },
  3:  { encryptText: (t, k, s, l) => additiveShift(t, k, s, l, true,  generateShiftsCA),
        decryptText: (t, k, s, l) => additiveShift(t, k, s, l, false, generateShiftsCA) },
  4:  { encryptText: (t, k, s, l) => additiveShift(t, k, s, l, true,  generateShiftsRC4),
        decryptText: (t, k, s, l) => additiveShift(t, k, s, l, false, generateShiftsRC4) },
  5:  { encryptText: (t, k, s, l) => additiveShift(t, k, s, l, true,  generateShiftsLFSR),
        decryptText: (t, k, s, l) => additiveShift(t, k, s, l, false, generateShiftsLFSR) },
  6:  { encryptText: (t, k, s, l) => additiveShift(t, k, s, l, true,  generateShiftsPoly),
        decryptText: (t, k, s, l) => additiveShift(t, k, s, l, false, generateShiftsPoly) },
  7:  { encryptText: (t, k, s, l) => substituteReverse(t, k, s, l, true),
        decryptText: (t, k, s, l) => substituteReverse(t, k, s, l, false) },
  8:  { encryptText: (t, k, s, l) => additiveShift(t, k, s, l, true,  generateShiftsLCG),
        decryptText: (t, k, s, l) => additiveShift(t, k, s, l, false, generateShiftsLCG) },
  9:  { encryptText: (t, k, s, l) => additiveShift(t, k, s, l, true,  generateShiftsModSquare),
        decryptText: (t, k, s, l) => additiveShift(t, k, s, l, false, generateShiftsModSquare) },
  10: { encryptText: (t, k, s, l) => additiveShift(t, k, s, l, true,  generateShiftsLogistic),
        decryptText: (t, k, s, l) => additiveShift(t, k, s, l, false, generateShiftsLogistic) },
};

// ── Router: pick the cipher version, then encrypt/decrypt a token ─────────────
function encryptToken(rawToken, version, key, skip, encryptLen) {
  const v = Versions[version]; if (!v) return rawToken;
  return v.encryptText(rawToken, key, skip, encryptLen);
}
function decryptToken(rawToken, version, key, skip, encryptLen) {
  const v = Versions[version]; if (!v) return rawToken;
  return v.decryptText(rawToken, key, skip, encryptLen);
}

if (typeof module !== "undefined") {
  module.exports = { Charset, Versions, encryptToken, decryptToken };
}
