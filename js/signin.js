// signin.js — Sign-In cipher (Cellular Automaton v3)
// JS port of the Go `cipher` package (sign-in half).
// Used to encrypt captcha tokens before sending them to the booking API.

// Charset is the 64-character alphabet used by the cipher.
const Charset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

// Default sign-in cipher parameters (Cellular Automaton v3)
const SigninKey        = "rb%a#)tveypgal^xc8qqzdox%vh23b@!lq8yj9@i@3jq$ua+@k";
const SigninSkip       = 5;
const SigninEncryptLen = 22;

// charsetIndex returns the index of ch in Charset, or -1 if not found.
function charsetIndex(ch) {
  return Charset.indexOf(ch);
}

// generateShiftsCellularAutomaton derives the per-position shift values by
// evolving a 64-cell binary cellular automaton seeded from the key.
//   - seed cells with the parity of each key char; set cell[32] = 1
//   - per output position: new[i] = left ^ (center | right) over wrap-around
//     neighbours; shift = top 6 cells (i=0..5, MSB first), value 0..63
function generateShiftsCellularAutomaton(key, length) {
  let state = new Uint8Array(64);
  for (let h = 0; h < key.length; h++) state[h % 64] ^= (key.charCodeAt(h) & 1);
  state[32] = 1;

  const shifts = new Array(length);
  for (let h = 0; h < length; h++) {
    const next = new Uint8Array(64);
    let t = 0;
    for (let i = 0; i < 64; i++) {
      const left = state[(i + 63) % 64], center = state[i], right = state[(i + 1) % 64];
      next[i] = left ^ (center | right);
      if (i < 6) t = (t << 1) | next[i];
    }
    state = next;
    shifts[h] = t % Charset.length;
  }
  return shifts;
}

// ProcessToken encrypts a captcha token using Cellular Automaton v3.
function ProcessToken(token, key, skip, encryptLen) {
  if (!token) return token;

  const prefixLen = Math.max(0, Math.min(skip, token.length));
  const remaining = Math.max(0, token.length - prefixLen);
  const actualLen = Math.max(0, Math.min(encryptLen, remaining));
  if (actualLen === 0) return token;

  const prefix = token.slice(0, prefixLen);
  const middle = token.slice(prefixLen, prefixLen + actualLen).split("");
  const suffix = token.slice(prefixLen + actualLen);

  const shifts = generateShiftsCellularAutomaton(key, middle.length);
  for (let i = 0; i < middle.length; i++) {
    const idx = charsetIndex(middle[i]);
    if (idx !== -1) middle[i] = Charset[(idx + shifts[i]) % Charset.length];
  }
  return prefix + middle.join("") + suffix;
}

// ReverseToken decrypts a captcha token using Cellular Automaton v3.
function ReverseToken(token, key, skip, encryptLen) {
  if (!token) return token;

  const prefixLen = Math.max(0, Math.min(skip, token.length));
  const remaining = Math.max(0, token.length - prefixLen);
  const actualLen = Math.max(0, Math.min(encryptLen, remaining));
  if (actualLen === 0) return token;

  const prefix = token.slice(0, prefixLen);
  const middle = token.slice(prefixLen, prefixLen + actualLen).split("");
  const suffix = token.slice(prefixLen + actualLen);

  const shifts = generateShiftsCellularAutomaton(key, middle.length);
  for (let i = 0; i < middle.length; i++) {
    const idx = charsetIndex(middle[i]);
    if (idx !== -1) {
      let n = (idx - shifts[i]) % Charset.length;
      if (n < 0) n += Charset.length;
      middle[i] = Charset[n];
    }
  }
  return prefix + middle.join("") + suffix;
}

// ProcessTokenSignin encrypts a sign-in token using the default parameters.
function ProcessTokenSignin(token) {
  return ProcessToken(token, SigninKey, SigninSkip, SigninEncryptLen);
}

// ReverseTokenSignin decrypts a sign-in token using the default parameters.
function ReverseTokenSignin(token) {
  return ReverseToken(token, SigninKey, SigninSkip, SigninEncryptLen);
}

if (typeof module !== "undefined") {
  module.exports = { Charset, SigninKey, SigninSkip, SigninEncryptLen,
    ProcessToken, ReverseToken, ProcessTokenSignin, ReverseTokenSignin };
}
