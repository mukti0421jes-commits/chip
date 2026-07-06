// cipher.js — AUTO-GENERATED clean port (sample format).
// Reverse-engineered + verified byte-for-byte against the live bundle.

const Charset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

function charsetIndex(ch) { return Charset.indexOf(ch); }

// Signin cipher (version 10, LOGISTIC)
const SigninKey = "%4m_yl@y(1or0!0xtpp6m1ihs6dg@h(+(f*mu9!%c0+2o%-g*o";
const SigninSkip = 3;
const SigninEncryptLen = 17;
function ProcessTokenSignin(token) { return cryptLogistic(token, SigninKey, SigninSkip, SigninEncryptLen, true); }
function ReverseTokenSignin(token) { return cryptLogistic(token, SigninKey, SigninSkip, SigninEncryptLen, false); }

// Reserve cipher (version 9, MODSQ)
const ReserveKey = "vsk9$0g85ncn1b842gefi$vfu(kjc4kbdf+(o6q54o)v4(0-^s";
const ReserveSkip = 9;
const ReserveEncryptLen = 19;
function ProcessTokenReserve(token) { return cryptModSquare(token, ReserveKey, ReserveSkip, ReserveEncryptLen, true); }
function ReverseTokenReserve(token) { return cryptModSquare(token, ReserveKey, ReserveSkip, ReserveEncryptLen, false); }


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

// ---- Modular-squaring shift cipher (BBS-style, A = 0xe8d6ca6163, seed 314159265) ----
function generateShiftsModSquare(key, length) {
  const A = BigInt("0xe8d6ca6163");
  let s = 314159265n;
  for (let i = 0; i < key.length; i++) s = (s + BigInt(key.charCodeAt(i)) * BigInt(i + 1)) % A;
  if (s % 2n === 0n) s += 1n;
  const shifts = new Array(length);
  for (let i = 0; i < length; i++) { s = (s * s) % A; shifts[i] = Number(s % BigInt(Charset.length)); }
  return shifts;
}
function cryptModSquare(token, key, skip, encryptLen, encrypt) {
  return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsModSquare);
}

// ---- Logistic-map chaotic shift cipher (r = 3.99, 100-step warmup) ----
function generateShiftsLogistic(key, length) {
  let u = 0.5;
  for (let i = 0; i < key.length; i++) u = (u + key.charCodeAt(i) / 256) % 1;
  if (u === 0) u = 0.5;
  const shifts = [];
  for (let f = 0; f < length + 100; f++) {
    u = (3.99 * u) * (1 - u);
    if (f >= 100) shifts.push(Math.floor(1e7 * u) % Charset.length);
  }
  return shifts;
}
function cryptLogistic(token, key, skip, encryptLen, encrypt) {
  return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsLogistic);
}

if (typeof module !== "undefined") {
  module.exports = { Charset, SigninKey, SigninSkip, SigninEncryptLen, ProcessTokenSignin, ReverseTokenSignin, ReserveKey, ReserveSkip, ReserveEncryptLen, ProcessTokenReserve, ReverseTokenReserve, encryptToken, decryptToken, ProcessToken, ReverseToken };
}
