// ==UserScript==
// @name         Captcha Cipher — Reserve Slot (Feistel v2)
// @namespace    chip.cipher.reserve
// @version      1.0.0
// @description  Encrypt/decrypt reserve-slot captcha tokens (bitmix Feistel network, module HX/version 2)
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // 64-character alphabet used by the cipher.
  const CHARSET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

  // Default reserve-slot parameters.
  const RESERVE_KEY  = "4%i$h3wegd7daghf4p!3a9kbxczvgk3gl@ozin01++b1z#g)=w";
  const RESERVE_SKIP = 3;
  const RESERVE_LEN  = 20;

  // Feistel key schedule (JS source: PX function).
  //   i = Σ charCode(s) * (s+1)               (mod 2^32)
  //   8 round keys: i = imul(i, 1103515245) + 12345; key = i & 7
  function keySchedule(key) {
    let i = 0 >>> 0;
    for (let s = 0; s < key.length; s++) i = (i + key.charCodeAt(s) * (s + 1)) >>> 0;
    const out = [];
    for (let s = 0; s < 8; s++) { i = (Math.imul(i, 1103515245) + 12345) >>> 0; out.push(i & 7); }
    return out;
  }

  // Round function (JS source: NX function).
  function roundFn(half, k) { return 7 & ((3 * half + k) ^ 3); }

  // Feistel network over the 6-bit charset index (two 3-bit halves, 8 rounds).
  function feistel(e, schedule) {
    let o = (e >> 3) & 7, i = e & 7;
    for (let c = 0; c < schedule.length; c++) { const ni = o ^ roundFn(i, schedule[c]); o = i; i = ni; }
    return (i << 3) | o;
  }
  function feistelInverse(x, schedule) {
    let i = (x >> 3) & 7, o = x & 7;
    for (let c = schedule.length - 1; c >= 0; c--) { const ni = o; const no = i ^ roundFn(o, schedule[c]); o = no; i = ni; }
    return (o << 3) | i;
  }

  function slice(token, skip, encryptLen) {
    const prefixLen = Math.max(0, Math.min(skip, token.length));
    const remaining = Math.max(0, token.length - prefixLen);
    const actualLen = Math.max(0, Math.min(encryptLen, remaining));
    return { prefixLen, actualLen };
  }

  // Encrypt a reserve-slot captcha token.
  function encryptReserve(token, key = RESERVE_KEY, skip = RESERVE_SKIP, encryptLen = RESERVE_LEN) {
    if (!token) return token;
    const { prefixLen, actualLen } = slice(token, skip, encryptLen);
    if (actualLen === 0) return token;
    const prefix = token.slice(0, prefixLen);
    const middle = token.slice(prefixLen, prefixLen + actualLen).split("");
    const suffix = token.slice(prefixLen + actualLen);
    const schedule = keySchedule(key);
    for (let i = 0; i < middle.length; i++) {
      const idx = CHARSET.indexOf(middle[i]);
      if (idx !== -1) middle[i] = CHARSET[feistel(idx, schedule) % 64];
    }
    return prefix + middle.join("") + suffix;
  }

  // Decrypt a reserve-slot captcha token.
  function decryptReserve(token, key = RESERVE_KEY, skip = RESERVE_SKIP, encryptLen = RESERVE_LEN) {
    if (!token) return token;
    const { prefixLen, actualLen } = slice(token, skip, encryptLen);
    if (actualLen === 0) return token;
    const prefix = token.slice(0, prefixLen);
    const middle = token.slice(prefixLen, prefixLen + actualLen).split("");
    const suffix = token.slice(prefixLen + actualLen);
    const schedule = keySchedule(key);
    for (let i = 0; i < middle.length; i++) {
      const idx = CHARSET.indexOf(middle[i]);
      if (idx !== -1) middle[i] = CHARSET[feistelInverse(idx, schedule) % 64];
    }
    return prefix + middle.join("") + suffix;
  }

  const api = { encryptReserve, decryptReserve, RESERVE_KEY, RESERVE_SKIP, RESERVE_LEN, CHARSET };
  if (typeof window !== 'undefined') window.ReserveCipher = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
