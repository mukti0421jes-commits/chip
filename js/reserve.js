// reserve.js — Reserve Slot cipher (Feistel v2)
// JS port of the Go `cipher` package (reserve half).
// Used to encrypt captcha tokens before sending them to the booking API.

// Charset is the 64-character alphabet used by the cipher.
const Charset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

// Default reserve slot cipher parameters (Feistel v2)
const ReserveKey        = "4%i$h3wegd7daghf4p!3a9kbxczvgk3gl@ozin01++b1z#g)=w";
const ReserveSkip       = 3;
const ReserveEncryptLen = 20;

// charsetIndex returns the index of ch in Charset, or -1 if not found.
function charsetIndex(ch) {
  return Charset.indexOf(ch);
}

// keySchedule generates the 8 Feistel round keys from the cipher key.
//   i = Σ charCode(s) * (s+1)               (mod 2^32)
//   round key: i = imul(i, 1103515245) + 12345; key = i & 7
function keySchedule(key) {
  let i = 0 >>> 0;
  for (let s = 0; s < key.length; s++) i = (i + key.charCodeAt(s) * (s + 1)) >>> 0;
  const out = new Array(8);
  for (let s = 0; s < 8; s++) { i = (Math.imul(i, 1103515245) + 12345) >>> 0; out[s] = i & 7; }
  return out;
}

// roundFn is the Feistel round function.
function roundFn(half, k) {
  return 7 & ((3 * half + k) ^ 3);
}

// feistel applies the Feistel network to a 6-bit charset index.
function feistel(e, schedule) {
  let o = (e >> 3) & 7, i = e & 7;
  for (let c = 0; c < schedule.length; c++) { const ni = o ^ roundFn(i, schedule[c]); o = i; i = ni; }
  return (i << 3) | o;
}

// feistelInverse inverts feistel, used for decryption.
function feistelInverse(x, schedule) {
  let i = (x >> 3) & 7, o = x & 7;
  for (let c = schedule.length - 1; c >= 0; c--) { const ni = o; const no = i ^ roundFn(o, schedule[c]); o = no; i = ni; }
  return (o << 3) | i;
}

// ProcessTokenFeistel encrypts a captcha token using the bitmix Feistel cipher.
function ProcessTokenFeistel(token, key, skip, encryptLen) {
  if (!token) return token;

  const prefixLen = Math.max(0, Math.min(skip, token.length));
  const remaining = Math.max(0, token.length - prefixLen);
  const actualLen = Math.max(0, Math.min(encryptLen, remaining));
  if (actualLen === 0) return token;

  const prefix = token.slice(0, prefixLen);
  const middle = token.slice(prefixLen, prefixLen + actualLen).split("");
  const suffix = token.slice(prefixLen + actualLen);

  const schedule = keySchedule(key);
  for (let i = 0; i < middle.length; i++) {
    const idx = charsetIndex(middle[i]);
    if (idx !== -1) middle[i] = Charset[feistel(idx, schedule) % Charset.length];
  }
  return prefix + middle.join("") + suffix;
}

// ReverseTokenFeistel decrypts a captcha token using the bitmix Feistel cipher.
function ReverseTokenFeistel(token, key, skip, encryptLen) {
  if (!token) return token;

  const prefixLen = Math.max(0, Math.min(skip, token.length));
  const remaining = Math.max(0, token.length - prefixLen);
  const actualLen = Math.max(0, Math.min(encryptLen, remaining));
  if (actualLen === 0) return token;

  const prefix = token.slice(0, prefixLen);
  const middle = token.slice(prefixLen, prefixLen + actualLen).split("");
  const suffix = token.slice(prefixLen + actualLen);

  const schedule = keySchedule(key);
  for (let i = 0; i < middle.length; i++) {
    const idx = charsetIndex(middle[i]);
    if (idx !== -1) middle[i] = Charset[feistelInverse(idx, schedule) % Charset.length];
  }
  return prefix + middle.join("") + suffix;
}

// ProcessTokenReserveSlot encrypts a reserve slot token using default parameters.
function ProcessTokenReserveSlot(token) {
  return ProcessTokenFeistel(token, ReserveKey, ReserveSkip, ReserveEncryptLen);
}

// ReverseTokenReserveSlot decrypts a reserve slot token using default parameters.
function ReverseTokenReserveSlot(token) {
  return ReverseTokenFeistel(token, ReserveKey, ReserveSkip, ReserveEncryptLen);
}

if (typeof module !== "undefined") {
  module.exports = { Charset, ReserveKey, ReserveSkip, ReserveEncryptLen,
    ProcessTokenFeistel, ReverseTokenFeistel, ProcessTokenReserveSlot, ReverseTokenReserveSlot };
}
