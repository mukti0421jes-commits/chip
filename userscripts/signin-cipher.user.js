// ==UserScript==
// @name         Captcha Cipher — Sign-In (Cellular Automaton v3)
// @namespace    chip.cipher.signin
// @version      1.0.0
// @description  Encrypt/decrypt sign-in captcha tokens (binary cellular automaton, module m$/version 3)
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // 64-character alphabet used by the cipher.
  const CHARSET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

  // Default sign-in parameters.
  const SIGNIN_KEY  = "rb%a#)tveypgal^xc8qqzdox%vh23b@!lq8yj9@i@3jq$ua+@k";
  const SIGNIN_SKIP = 5;
  const SIGNIN_LEN  = 22;

  // Binary cellular automaton key schedule (JS source: a$ function).
  //   - seed 64 cells with parity of each key char; set cell[32] = 1
  //   - per output position: new[i] = left ^ (center | right) over wrap-around
  //     neighbours; shift = top 6 cells (i=0..5, MSB first), value 0..63
  function generateShifts(key, length) {
    let state = new Uint8Array(64);
    for (let h = 0; h < key.length; h++) state[h % 64] ^= (key.charCodeAt(h) & 1);
    state[32] = 1;

    const shifts = [];
    for (let h = 0; h < length; h++) {
      const next = new Uint8Array(64);
      let t = 0;
      for (let i = 0; i < 64; i++) {
        const left = state[(i + 63) % 64], center = state[i], right = state[(i + 1) % 64];
        next[i] = left ^ (center | right);
        if (i < 6) t = (t << 1) | next[i];
      }
      state = next;
      shifts.push(t % 64);
    }
    return shifts;
  }

  function slice(token, skip, encryptLen) {
    const prefixLen = Math.max(0, Math.min(skip, token.length));
    const remaining = Math.max(0, token.length - prefixLen);
    const actualLen = Math.max(0, Math.min(encryptLen, remaining));
    return { prefixLen, actualLen };
  }

  // Encrypt a sign-in captcha token.
  function encryptSignin(token, key = SIGNIN_KEY, skip = SIGNIN_SKIP, encryptLen = SIGNIN_LEN) {
    if (!token) return token;
    const { prefixLen, actualLen } = slice(token, skip, encryptLen);
    if (actualLen === 0) return token;
    const prefix = token.slice(0, prefixLen);
    const middle = token.slice(prefixLen, prefixLen + actualLen).split("");
    const suffix = token.slice(prefixLen + actualLen);
    const shifts = generateShifts(key, middle.length);
    for (let i = 0; i < middle.length; i++) {
      const idx = CHARSET.indexOf(middle[i]);
      if (idx !== -1) middle[i] = CHARSET[(idx + shifts[i]) % 64];
    }
    return prefix + middle.join("") + suffix;
  }

  // Decrypt a sign-in captcha token.
  function decryptSignin(token, key = SIGNIN_KEY, skip = SIGNIN_SKIP, encryptLen = SIGNIN_LEN) {
    if (!token) return token;
    const { prefixLen, actualLen } = slice(token, skip, encryptLen);
    if (actualLen === 0) return token;
    const prefix = token.slice(0, prefixLen);
    const middle = token.slice(prefixLen, prefixLen + actualLen).split("");
    const suffix = token.slice(prefixLen + actualLen);
    const shifts = generateShifts(key, middle.length);
    for (let i = 0; i < middle.length; i++) {
      const idx = CHARSET.indexOf(middle[i]);
      if (idx !== -1) { let n = (idx - shifts[i]) % 64; if (n < 0) n += 64; middle[i] = CHARSET[n]; }
    }
    return prefix + middle.join("") + suffix;
  }

  const api = { encryptSignin, decryptSignin, SIGNIN_KEY, SIGNIN_SKIP, SIGNIN_LEN, CHARSET };
  if (typeof window !== 'undefined') window.SigninCipher = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
