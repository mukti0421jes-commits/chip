// cipher.js — AUTO-GENERATED clean port (sample format).
// Reverse-engineered + verified byte-for-byte against the live bundle.

const Charset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

function charsetIndex(ch) { return Charset.indexOf(ch); }

// Signin cipher (version 6, POLYNOMIAL)
const SigninKey = "jwmm)y9btdj4m3yh2c^o(mxekdmgl4x+tq2cyb&e$=rt&ajd&-";
const SigninSkip = 4;
const SigninEncryptLen = 23;
function ProcessTokenSignin(token) { return cryptPolynomial(token, SigninKey, SigninSkip, SigninEncryptLen, true); }
function ReverseTokenSignin(token) { return cryptPolynomial(token, SigninKey, SigninSkip, SigninEncryptLen, false); }

// Reserve cipher (version 2, BITMIX)
const ReserveKey = "e+=te%hn)s5d-266u6u^hys1s(d8a)&adf$ia3$pz6st)7%$g#";
const ReserveSkip = 7;
const ReserveEncryptLen = 28;
function ProcessTokenReserve(token) { return cryptBitmix(token, ReserveKey, ReserveSkip, ReserveEncryptLen, true); }
function ReverseTokenReserve(token) { return cryptBitmix(token, ReserveKey, ReserveSkip, ReserveEncryptLen, false); }


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


// shared driver for additive-shift algorithms
function additiveShift(token, key, skip, encryptLen, encrypt, genShifts) {
  if (!token) return token;
  const p = Math.max(0, Math.min(skip, token.length));
  const a = Math.max(0, Math.min(encryptLen, token.length - p));
  if (a === 0) return token;
  const mid = token.slice(p, p + a).split("");
  const shifts = genShifts(key, mid.length), n = Charset.length;
  for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x === -1) continue; mid[i] = encrypt ? Charset[(x + shifts[i]) % n] : Charset[((x - shifts[i]) % n + n) % n]; }
  return token.slice(0, p) + mid.join("") + token.slice(p + a);
}

// ---- Polynomial (GF(67)) additive-shift cipher ----
function generateShiftsPolynomial(key, length) {
  const coeff = [];
  for (let n = 0; n < key.length; n++) coeff.push(((key.charCodeAt(n % key.length) + n) % 67 + 67) % 67);
  const shifts = [];
  for (let d = 1; d <= length; d++) { let e = 0, t = 1; for (const a of coeff) { e = (e + a * t) % 67; t = (t * d) % 67; } shifts.push(e % Charset.length); }
  return shifts;
}
function cryptPolynomial(token, key, skip, encryptLen, encrypt) { return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsPolynomial); }

// ---- 6-bit Feistel substitution cipher (8 rounds, round F = 7&((x*3+k)^3)) ----
function bitmixRoundKeys(key) {
  let c = 0;
  for (let f = 0; f < key.length; f++) c = (c + key.charCodeAt(f) * (f + 1)) >>> 0;
  const rk = [];
  for (let f = 0; f < 8; f++) { c = (Math.imul(c, 1103515245) + 12345) >>> 0; rk.push(c & 7); }
  return rk;
}
function bitmixForward(val, rk) { let hi = (val >> 3) & 7, lo = val & 7; for (let r = 0; r < rk.length; r++) { const x = hi ^ (7 & ((lo * 3 + rk[r]) ^ 3)); hi = lo; lo = x; } return (lo << 3) | hi; }
function bitmixInverse(val, rk) { let lo = (val >> 3) & 7, hi = val & 7; for (let r = rk.length - 1; r >= 0; r--) { const x = hi; hi = lo ^ (7 & ((x * 3 + rk[r]) ^ 3)); lo = x; } return (hi << 3) | lo; }
function cryptBitmix(token, key, skip, encryptLen, encrypt) {
  if (!token) return token;
  const p = Math.max(0, Math.min(skip, token.length));
  const a = Math.max(0, Math.min(encryptLen, token.length - p));
  if (a === 0) return token;
  const mid = token.slice(p, p + a).split(""), rk = bitmixRoundKeys(key);
  for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x === -1) continue; mid[i] = Charset[(encrypt ? bitmixForward(x, rk) : bitmixInverse(x, rk)) % Charset.length]; }
  return token.slice(0, p) + mid.join("") + token.slice(p + a);
}

if (typeof module !== "undefined") {
  module.exports = { Charset, SigninKey, SigninSkip, SigninEncryptLen, ProcessTokenSignin, ReverseTokenSignin, ReserveKey, ReserveSkip, ReserveEncryptLen, ProcessTokenReserve, ReverseTokenReserve, encryptToken, decryptToken, ProcessToken, ReverseToken };
}
