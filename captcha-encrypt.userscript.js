// ============================================================================
//  cipher.js  — 10 captcha-token encryption algorithms
//  Clean, de-obfuscated port reverse-engineered from the app bundle.
//  Charset (radix-64) and all keystreams verified byte-for-byte vs the bundle.
// ============================================================================
const Charset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
const N = 64;
const ci = ch => Charset.indexOf(ch);

// ---- window helper: only [prefixLen, prefixLen+encodeLen) is transformed -----
function windowOf(token, prefixLen, encodeLen) {
  const p = Math.max(0, Math.min(prefixLen, token.length));
  const a = Math.max(0, Math.min(encodeLen, token.length - p));
  return [p, a];
}

// ======================= keystream generators (per version) =================

// v1 "block_mix" — ChaCha-style 16-word state, 10 column quarter-rounds.
function rotl32(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
function chachaQR(s, a, b, c, d) {
  s[a]=(s[a]+s[b])>>>0; s[d]=rotl32(s[d]^s[a],16);
  s[c]=(s[c]+s[d])>>>0; s[b]=rotl32(s[b]^s[c],12);
  s[a]=(s[a]+s[b])>>>0; s[d]=rotl32(s[d]^s[a],8);
  s[c]=(s[c]+s[d])>>>0; s[b]=rotl32(s[b]^s[c],7);
}
function genBlockMix(key, len) {
  const st = new Array(16).fill(0);
  for (let p = 0; p < key.length; p++) st[p%16] = (st[p%16] + key.charCodeAt(p)) >>> 0;
  st[15] = len;
  const sh = [], blocks = Math.ceil(len / 4);
  for (let b = 0; b < blocks; b++) {
    st[14] = b;
    const e = st.slice();
    for (let r = 0; r < 10; r++) { chachaQR(e,0,4,8,12); chachaQR(e,1,5,9,13); chachaQR(e,2,6,10,14); chachaQR(e,3,7,11,15); }
    for (let k = 0; k < 4; k++) sh.push(e[k] % N);
  }
  return sh;
}

// v3 "cellular_shift" — elementary cellular automaton, Rule 30.
function genCellular(key, len) {
  let cur = new Uint8Array(64);
  for (let k = 0; k < key.length; k++) cur[k%64] ^= (key.charCodeAt(k) & 1);
  cur[32] = 1;
  const out = [];
  for (let s = 0; s < len; s++) {
    const nx = new Uint8Array(64); let v = 0;
    for (let d = 0; d < 64; d++) {
      const L = cur[(d+63)%64], C = cur[d], R = cur[(d+1)%64];
      nx[d] = (30 >> ((L<<2)|(C<<1)|R)) & 1;   // Rule 30
      if (d < 6) v = (v<<1) | nx[d];
    }
    cur = nx; out.push(v % N);
  }
  return out;
}

// v4 "rc4_shift" — RC4 over a 64-element state (KSA + PRGA).
function genRC4(key, len) {
  const SZ = 64, S = Array.from({length:SZ}, (_,i)=>i);
  let j = 0;
  for (let i = 0; i < SZ; i++) { j = (j + S[i] + key.charCodeAt(i%key.length)) % SZ; [S[i],S[j]]=[S[j],S[i]]; }
  let i = 0; j = 0; const out = [];
  for (let k = 0; k < len; k++) { i=(i+1)%SZ; j=(j+S[i])%SZ; [S[i],S[j]]=[S[j],S[i]]; out.push(S[(S[i]+S[j])%SZ]); }
  return out;
}

// v5 "lfsr_shift" — three Galois/Fibonacci LFSRs combined by a Geffe generator.
function genLFSR(key, len) {
  let u = 74565, s = 424090, l = 773615;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    u ^= (c | 1); s ^= 1 | (c << 2); l ^= 1 | (c << 4);
  }
  const out = [];
  for (let p = 0; p < len; p++) {
    let e = 0;
    for (let t = 0; t < 6; t++) {
      const ub = 1 & (u ^ u>>2 ^ u>>3 ^ u>>5);   u = (u>>>1) | (ub<<15);
      const sb = 1 & (s ^ s>>1 ^ s>>2 ^ s>>7);    s = (s>>>1) | (sb<<16);
      const lb = 1 & (l ^ l>>1 ^ l>>2 ^ l>>22);   l = (l>>>1) | (lb<<23);
      const h = (ub & sb) ^ (~ub & lb);           // Geffe combiner
      e = (e<<1) | h;
    }
    out.push(((e % N) + N) % N);
  }
  return out;
}

// v6 "polynomial" — Horner polynomial evaluation over GF(67), key as coeffs.
function genPolynomial(key, len) {
  const coeff = [];
  for (let n = 0; n < key.length; n++) coeff.push(((key.charCodeAt(n % key.length) + n) % 67 + 67) % 67);
  const out = [];
  for (let d = 1; d <= len; d++) {
    let e = 0, t = 1;
    for (const a of coeff) { e = (e + a*t) % 67; t = (t*d) % 67; }
    out.push(e % N);
  }
  return out;
}

// v8 "prng" — linear congruential PRNG with a self-modifying multiplier.
function genPRNG(key, len) {
  let st = 123456789, mul = 1103515245;
  for (let f = 0; f < key.length; f++) st = (st + key.charCodeAt(f)) >>> 0;
  const out = [];
  for (let f = 0; f < len; f++) {
    st = (Math.imul(st, mul) + 12345) >>> 0;
    mul = ((mul + st) >>> 0) | 1;
    out.push((st >>> 16) % N);
  }
  return out;
}

// v9 "mod_square" — Blum-Blum-Shub style x = x*x mod M.
function modmul(a, b, m) { return Number((BigInt(a) * BigInt(b)) % BigInt(m)); }
function genModSquare(key, len) {
  const M = 0xe8d6ca6163; let c = 314159265;
  for (let l = 0; l < key.length; l++) c = (c + key.charCodeAt(l)*(l+1)) % M;
  if (c % 2 === 0) c += 1;
  const out = [];
  for (let l = 0; l < len; l++) { c = modmul(c, c, M); out.push(c % N); }
  return out;
}

// v10 "logistic_shift" — chaotic logistic map x = r*x*(1-x), r=3.99, 100-step warm-up.
function genLogistic(key, len) {
  let d = 0.5;
  for (let h = 0; h < key.length; h++) d = (d + (key.charCodeAt(h) % 256) / 256) % 1;
  if (d === 0) d = 0.5;
  const out = [];
  for (let h = 0; h < len + 100; h++) {
    d = 3.99 * d * (1 - d);
    if (h >= 100) out.push(Math.floor(1e7 * d) % N);
  }
  return out;
}

// ============== additive-shift driver (used by v1,3,4,5,6,8,9,10) ===========
const GEN = { 1:genBlockMix, 3:genCellular, 4:genRC4, 5:genLFSR, 6:genPolynomial, 8:genPRNG, 9:genModSquare, 10:genLogistic };
function additiveShift(version, token, key, prefixLen, encodeLen, encrypt) {
  const [p, a] = windowOf(token, prefixLen, encodeLen);
  if (a === 0) return token;
  const mid = token.slice(p, p+a).split("");
  const sh = GEN[version](key, mid.length);
  for (let i = 0; i < mid.length; i++) {
    const x = ci(mid[i]); if (x === -1) continue;
    mid[i] = encrypt ? Charset[(x + sh[i]) % N] : Charset[((x - sh[i]) % N + N) % N];
  }
  return token.slice(0, p) + mid.join("") + token.slice(p+a);
}

// ===================== v2 "bitmix" — 6-bit Feistel network ==================
function genBitmixKeys(key) {            // 8 round keys (LCG, low 3 bits each)
  let c = 0;
  for (let f = 0; f < key.length; f++) c = (c + key.charCodeAt(f) * (f+1)) >>> 0;
  const rk = [];
  for (let f = 0; f < 8; f++) { c = (Math.imul(c, 1103515245) + 12345) >>> 0; rk.push(c & 7); }
  return rk;
}
const feistelF = (e, t) => 7 & ((e * 3 + t) ^ 3);   // round function
function bitmixForward(val, rk) {                    // 6-bit value -> 6-bit value
  let hi = (val >> 3) & 7, lo = val & 7;
  for (let r = 0; r < rk.length; r++) { const a = hi ^ feistelF(lo, rk[r]); hi = lo; lo = a; }
  return (lo << 3) | hi;
}
function bitmixInverse(val, rk) {
  let lo = (val >> 3) & 7, hi = val & 7;             // undo final (i<<3)|o swap
  for (let r = rk.length - 1; r >= 0; r--) { const a = hi; hi = lo ^ feistelF(a, rk[r]); lo = a; }
  return ((hi >> 0) & 7) << 3 | (lo & 7);            // recombine ( (e>>3)&7=hi , e&7=lo )
}
function cryptBitmix(token, key, prefixLen, encodeLen, encrypt) {
  const [p, a] = windowOf(token, prefixLen, encodeLen);
  if (a === 0) return token;
  const mid = token.slice(p, p+a).split("");
  const rk = genBitmixKeys(key);
  for (let i = 0; i < mid.length; i++) {
    const x = ci(mid[i]); if (x === -1) continue;
    mid[i] = Charset[(encrypt ? bitmixForward(x, rk) : bitmixInverse(x, rk)) % N];
  }
  return token.slice(0, p) + mid.join("") + token.slice(p+a);
}

// =============== v7 "subst_reverse" — key-scheduled S-box + reversal ========
function buildSbox(key) {
  const box = Array.from({length:N}, (_,i)=>i);
  let i = 0;
  for (let d = 0; d < N; d++) { i = (i + box[d] + key.charCodeAt(d % key.length)) % N; [box[d],box[i]]=[box[i],box[d]]; }
  const inv = new Array(N);
  for (let d = 0; d < N; d++) inv[box[d]] = d;
  return { sbox: box, invSbox: inv };
}
function cryptSubstReverse(token, key, prefixLen, encodeLen, encrypt) {
  const [p, a] = windowOf(token, prefixLen, encodeLen);
  if (a === 0) return token;
  let mid = token.slice(p, p+a).split("");
  const { sbox, invSbox } = buildSbox(key);
  if (encrypt) {
    for (let i = 0; i < mid.length; i++) { const x = ci(mid[i]); if (x !== -1) mid[i] = Charset[sbox[x]]; }
    mid.reverse();
  } else {
    mid.reverse();
    for (let i = 0; i < mid.length; i++) { const x = ci(mid[i]); if (x !== -1) mid[i] = Charset[invSbox[x]]; }
  }
  return token.slice(0, p) + mid.join("") + token.slice(p+a);
}

// =============================== dispatch ===================================
function encryptVersion(version, token, key, prefixLen, encodeLen) {
  if (version === 2) return cryptBitmix(token, key, prefixLen, encodeLen, true);
  if (version === 7) return cryptSubstReverse(token, key, prefixLen, encodeLen, true);
  return additiveShift(version, token, key, prefixLen, encodeLen, true);
}
function decryptVersion(version, token, key, prefixLen, encodeLen) {
  if (version === 2) return cryptBitmix(token, key, prefixLen, encodeLen, false);
  if (version === 7) return cryptSubstReverse(token, key, prefixLen, encodeLen, false);
  return additiveShift(version, token, key, prefixLen, encodeLen, false);
}

// ============================================================================
//  Per-version CONFIG  (hardcoded). Frontend just sends { rawToken, version }.
// ============================================================================
const CAPTCHA_CONFIG = {
  1:  { key: "",                                                   skip: 0, length: 0  }, // TODO: fill v1 real key/skip/length
  2:  { key: "4%i$h3wegd7daghf4p!3a9kbxczvgk3gl@ozin01++b1z#g)=w", skip: 3, length: 20 },
  3:  { key: "rb%a#)tveypgal^xc8qqzdox%vh23b@!lq8yj9@i@3jq$ua+@k", skip: 5, length: 22 },
  4:  { key: "l4z&xb9q!7sfon6hhi&p5d1dgyy#f$-y%tx66sdb#0i31xg^ke", skip: 3, length: 20 },
  5:  { key: "@541m3tp&t63noy&3ngwa%fgfivy3n1_7d)zvj$h-au+bah50f", skip: 4, length: 22 },
  6:  { key: "671hnk6vg7e5hnv$4fy+7-_ch_io0)q$_xz=k++r-^&i32dfst", skip: 7, length: 23 },
  7:  { key: "7*z-x)kx)p&a$381#fv$=d8-8(41e7s!*orx9e3s$1ne2z6c7w", skip: 3, length: 21 },
  8:  { key: "tbp&12h&cc0q58*s!!+x)ga83rncmmzv9mb^%4r+3j)5caqrrn", skip: 7, length: 19 },
  9:  { key: "mg!b=zdz^y_ly!-#x_e%z65s_$&#!d1@w%@2ux%mr0d)o+6mp9", skip: 4, length: 23 },
  10: { key: "vd@+sy&b)fjogphl3#=3i(-uuqemhdk2%7zuybitu)!^)rcy5v", skip: 8, length: 29 },
};

// rawToken + version => encrypted token  (key/skip/length looked up by version)
function encryptCaptcha(rawToken, version) {
  const c = CAPTCHA_CONFIG[version];
  if (!c) throw new Error("unknown captcha version: " + version);
  return encryptVersion(version, rawToken, c.key, c.skip, c.length);
}
function decryptCaptcha(rawToken, version) {
  const c = CAPTCHA_CONFIG[version];
  if (!c) throw new Error("unknown captcha version: " + version);
  return decryptVersion(version, rawToken, c.key, c.skip, c.length);
}

// Optional: fully-dynamic variant if you'd rather send everything from frontend:
//   encryptVersion(version, rawToken, key, skip, length)

// Tampermonkey: these are now global in your userscript scope.
// e.g.  const enc = encryptCaptcha(captchaToken, 4);
