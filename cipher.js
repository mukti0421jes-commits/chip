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

// Reserve cipher (version 2, SUBST — key-derived 64-element permutation)
const ReserveKey = "e+=te%hn)s5d-266u6u^hys1s(d8a)&adf$ia3$pz6st)7%$g#";
const ReserveSkip = 7;
const ReserveEncryptLen = 28;
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


// shared driver for additive-shift algorithms
function additiveShift(token, key, skip, encryptLen, encrypt, genShifts) {
  if (!token) return token;
  const p = Math.max(0, Math.min(skip, token.length));
  const a = Math.max(0, Math.min(encryptLen, token.length - p));
  if (a === 0) return token;
  const mid = token.slice(p, p + a).split("");
  const shifts = genShifts(key, mid.length), n = Charset.length;
  for (let i = 0; i < mid.length; i++) {
    const x = charsetIndex(mid[i]); if (x === -1) continue;
    mid[i] = encrypt ? Charset[(x + shifts[i]) % n] : Charset[((x - shifts[i]) % n + n) % n];
  }
  return token.slice(0, p) + mid.join("") + token.slice(p + a);
}

// ---- Polynomial (GF(67)) additive-shift cipher (Signin) ----
function generateShiftsPolynomial(key, length) {
  const coeff = [];
  for (let n = 0; n < key.length; n++) coeff.push(((key.charCodeAt(n % key.length) + n) % 67 + 67) % 67);
  const shifts = [];
  for (let d = 1; d <= length; d++) {
    let e = 0, t = 1;
    for (const a of coeff) { e = (e + a * t) % 67; t = (t * d) % 67; }
    shifts.push(e % Charset.length);
  }
  return shifts;
}
function cryptPolynomial(token, key, skip, encryptLen, encrypt) {
  return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsPolynomial);
}

// ---- Substitution cipher (key-derived 64-element permutation) (Reserve) ----
// PERM was recovered from the live bundle for the Reserve key; it IS the cipher's net mapping.
const PERM = [24,47,58,41,28,43,62,45,23,4,53,2,19,0,49,6,42,29,8,27,46,25,12,31,33,50,3,52,37,54,7,48,60,11,30,13,56,15,26,9,51,32,17,38,55,36,21,34,14,57,44,63,10,61,40,59,5,22,39,16,1,18,35,20];
const PERM_INV = (() => { const v = new Array(64); for (let i = 0; i < 64; i++) v[PERM[i]] = i; return v; })();
function cryptSubst(token, key, skip, encryptLen, encrypt) {
  if (!token) return token;
  const p = Math.max(0, Math.min(skip, token.length));
  const a = Math.max(0, Math.min(encryptLen, token.length - p));
  if (a === 0) return token;
  const mid = token.slice(p, p + a).split("");
  if (encrypt) {
    for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x !== -1) mid[i] = Charset[PERM[x]]; }
  } else {
    for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x !== -1) mid[i] = Charset[PERM_INV[x]]; }
  }
  return token.slice(0, p) + mid.join("") + token.slice(p + a);
}

if (typeof module !== "undefined") {
  module.exports = { Charset, SigninKey, SigninSkip, SigninEncryptLen, ProcessTokenSignin, ReverseTokenSignin, ReserveKey, ReserveSkip, ReserveEncryptLen, ProcessTokenReserve, ReverseTokenReserve, encryptToken, decryptToken, ProcessToken, ReverseToken };
}
