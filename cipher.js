// cipher.js — AUTO-GENERATED clean port (sample format).
// Reverse-engineered + verified byte-for-byte against the live bundle (cipher.go).

const Charset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

function charsetIndex(ch) { return Charset.indexOf(ch); }

// Signin cipher (Cellular Automaton v3, SplitMix64 additive-shift)
const SigninKey = "rb%a#)tveypgal^xc8qqzdox%vh23b@!lq8yj9@i@3jq$ua+@k";
const SigninSkip = 5;
const SigninEncryptLen = 22;
function ProcessTokenSignin(token) { return cryptAdditiveSM(token, SigninKey, SigninSkip, SigninEncryptLen, true); }
function ReverseTokenSignin(token) { return cryptAdditiveSM(token, SigninKey, SigninSkip, SigninEncryptLen, false); }

// Reserve cipher (Feistel v2, key-seeded Fisher-Yates substitution permutation)
const ReserveKey = "4%i$h3wegd7daghf4p!3a9kbxczvgk3gl@ozin01++b1z#g)=w";
const ReserveSkip = 3;
const ReserveEncryptLen = 20;
function ProcessTokenReserve(token) { return cryptSubst(token, ReserveKey, ReserveSkip, ReserveEncryptLen, true); }
function ReverseTokenReserve(token) { return cryptSubst(token, ReserveKey, ReserveSkip, ReserveEncryptLen, false); }


// ---- Router: encryptToken(rawToken, purpose) / decryptToken(rawToken, purpose) ----
function encryptToken(rawToken, purpose) {
  if (purpose === "Signin") return ProcessTokenSignin(rawToken);
  if (purpose === "Reserve") return ProcessTokenReserve(rawToken);
  return rawToken;
}
function decryptToken(rawToken, purpose) {
  if (purpose === "Signin") return ReverseTokenSignin(rawToken);
  if (purpose === "Reserve") return ReverseTokenReserve(rawToken);
  return rawToken;
}
function ProcessToken(rawToken, purpose) { return encryptToken(rawToken, purpose); }
function ReverseToken(rawToken, purpose) { return decryptToken(rawToken, purpose); }


// ---- Key-seeded PRNG (SplitMix64 over FNV-1a seed), exact port of the bundle ----
const U64 = (1n << 64n) - 1n;
function newKeyStream(key, salt) {
  let h = 1469598103934665603n;
  for (let i = 0; i < key.length; i++) {
    h = (h ^ BigInt(key.charCodeAt(i) & 0xff)) & U64;
    h = (h * 1099511628211n) & U64;
  }
  h = (h ^ ((salt + 0x9e3779b97f4a7c15n) & U64)) & U64;
  return { state: h };
}
function ksNext(k) {
  k.state = (k.state + 0x9e3779b97f4a7c15n) & U64;
  let z = k.state;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
  return (z ^ (z >> 31n)) & U64;
}
function ksIntn(k, n) {
  if (n <= 0) return 0;
  const un = BigInt(n);
  const limit = (U64 / un) * un;
  for (;;) {
    const v = ksNext(k);
    if (v < limit) return Number(v % un);
  }
}

// ---- Signin: additive shift with per-position key-derived shifts ----
const signinSalt = 0x53474e494e00n; // "SGNIN"
function generateShiftsSignin(key, length) {
  const k = newKeyStream(key, signinSalt);
  const shifts = new Array(length);
  for (let i = 0; i < length; i++) shifts[i] = ksIntn(k, Charset.length);
  return shifts;
}
function cryptAdditiveSM(token, key, skip, encryptLen, encrypt) {
  if (!token) return token;
  const p = Math.max(0, Math.min(skip, token.length));
  const a = Math.max(0, Math.min(encryptLen, token.length - p));
  if (a === 0) return token;
  const mid = token.slice(p, p + a).split("");
  const shifts = generateShiftsSignin(key, mid.length), n = Charset.length;
  for (let i = 0; i < mid.length; i++) {
    const x = charsetIndex(mid[i]); if (x === -1) continue;
    mid[i] = encrypt ? Charset[(x + shifts[i]) % n] : Charset[((x - shifts[i]) % n + n) % n];
  }
  return token.slice(0, p) + mid.join("") + token.slice(p + a);
}

// ---- Reserve: bijective substitution permutation (key-seeded Fisher-Yates) ----
const reserveSalt = 0x524553455256n; // "RESERV"
function deriveReservePermutation(key) {
  const n = Charset.length;
  const perm = new Array(n);
  for (let i = 0; i < n; i++) perm[i] = i;
  const k = newKeyStream(key, reserveSalt);
  for (let i = n - 1; i > 0; i--) {
    const j = ksIntn(k, i + 1);
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  return perm;
}
function invertPermutation(perm) {
  const inv = new Array(perm.length).fill(-1);
  for (let inIdx = 0; inIdx < perm.length; inIdx++) inv[perm[inIdx]] = inIdx;
  return inv;
}
function cryptSubst(token, key, skip, encryptLen, encrypt) {
  if (!token) return token;
  const p = Math.max(0, Math.min(skip, token.length));
  const a = Math.max(0, Math.min(encryptLen, token.length - p));
  if (a === 0) return token;
  const mid = token.slice(p, p + a).split("");
  const map = encrypt ? deriveReservePermutation(key) : invertPermutation(deriveReservePermutation(key));
  for (let i = 0; i < mid.length; i++) {
    const x = charsetIndex(mid[i]); if (x === -1 || map[x] === -1) continue;
    mid[i] = Charset[map[x]];
  }
  return token.slice(0, p) + mid.join("") + token.slice(p + a);
}

if (typeof module !== "undefined") {
  module.exports = { Charset, SigninKey, SigninSkip, SigninEncryptLen, ProcessTokenSignin, ReverseTokenSignin, ReserveKey, ReserveSkip, ReserveEncryptLen, ProcessTokenReserve, ReverseTokenReserve, encryptToken, decryptToken, ProcessToken, ReverseToken };
}
