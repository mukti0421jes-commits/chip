// cipher.js — AUTO-GENERATED clean port (sample format).
// Reverse-engineered + verified byte-for-byte against the live bundle.

const Charset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

function charsetIndex(ch) { return Charset.indexOf(ch); }

// Signin cipher (version 5, LFSR)
const SigninKey = "A!:p6cRVI}Me6gzuQAR72f&WYJ`s2x05G%>v8iXBO,Sk8mfaWGX94l_CEP$y4d27";
const SigninSkip = 1;
const SigninEncryptLen = 29;
function ProcessTokenSignin(token) { return cryptLFSR(token, SigninKey, SigninSkip, SigninEncryptLen, true); }
function ReverseTokenSignin(token) { return cryptLFSR(token, SigninKey, SigninSkip, SigninEncryptLen, false); }

// Reserve cipher (version 5, LFSR)
const ReserveKey = "A!:p6cRVI}Me6gzuQAR72f&WYJ`s2x05G%>v8iXBO,Sk8mfaWGX94l_CEP$y4d27";
const ReserveSkip = 1;
const ReserveEncryptLen = 29;
function ProcessTokenReserve(token) { return cryptLFSR(token, ReserveKey, ReserveSkip, ReserveEncryptLen, true); }
function ReverseTokenReserve(token) { return cryptLFSR(token, ReserveKey, ReserveSkip, ReserveEncryptLen, false); }


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

// ---- Three-LFSR Geffe-generator additive-shift cipher ----
function generateShiftsLFSR(key, length) {
  let u = 74565, s = 424090, l = 773615;
  for (let i = 0; i < key.length; i++) { const c = key.charCodeAt(i); u ^= (c | 1); s ^= 1 | (c << 2); l ^= 1 | (c << 4); }
  const shifts = [];
  for (let p = 0; p < length; p++) {
    let e = 0;
    for (let t = 0; t < 6; t++) {
      const ub = 1 & (u ^ u >> 2 ^ u >> 3 ^ u >> 5); u = (u >>> 1) | (ub << 15);
      const sb = 1 & (s ^ s >> 1 ^ s >> 2 ^ s >> 7); s = (s >>> 1) | (sb << 16);
      const lb = 1 & (l ^ l >> 1 ^ l >> 2 ^ l >> 22); l = (l >>> 1) | (lb << 23);
      const h = (ub & sb) ^ (~ub & lb);
      e = (e << 1) | h;
    }
    shifts.push(((e % Charset.length) + Charset.length) % Charset.length);
  }
  return shifts;
}
function cryptLFSR(token, key, skip, encryptLen, encrypt) { return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsLFSR); }

if (typeof module !== "undefined") {
  module.exports = { Charset, SigninKey, SigninSkip, SigninEncryptLen, ProcessTokenSignin, ReverseTokenSignin, ReserveKey, ReserveSkip, ReserveEncryptLen, ProcessTokenReserve, ReverseTokenReserve, encryptToken, decryptToken, ProcessToken, ReverseToken };
}
