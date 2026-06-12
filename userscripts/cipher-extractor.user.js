// ==UserScript==
// @name         Captcha Cipher Extractor
// @namespace    chip.cipher.extractor
// @version      1.0.0
// @description  Auto-captures the page's captcha cipher modules and logs the real key/skip/len/algorithm at runtime — no manual reverse-engineering.
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // Captured cipher modules live here.
  const store = (window.__ciphers = window.__ciphers || []);
  const seen = new Set();

  // A cipher module is any object exposing both encryptText() and decryptText().
  function isCipherModule(o) {
    return o && typeof o === 'object' &&
           typeof o.encryptText === 'function' &&
           typeof o.decryptText === 'function';
  }

  function wrapModule(obj) {
    if (seen.has(obj)) return;
    seen.add(obj);

    const realEnc = obj.encryptText;
    const realDec = obj.decryptText;
    const id = store.length + 1;
    const rec = { id, module: obj, key: null, skip: null, len: null, calls: 0 };

    // Object is still mutable here (we run BEFORE the real Object.freeze).
    try {
      obj.encryptText = function (token, key, skip, len) {
        rec.calls++;
        const out = realEnc.apply(this, arguments);
        if (rec.key === null) {
          rec.key = key; rec.skip = skip; rec.len = len;
          console.log(
            '%c[cipher-extractor] captured #' + id,
            'color:#0a0;font-weight:bold',
            { key, skip, len, sampleIn: token, sampleOut: out }
          );
        }
        return out;
      };
      obj.decryptText = function () { return realDec.apply(this, arguments); };
    } catch (e) { /* already frozen / read-only: keep real refs below */ }

    rec.encryptText = realEnc;
    rec.decryptText = realDec;
    store.push(rec);
  }

  // Hook Object.freeze: catch the module object the instant before it is frozen.
  const realFreeze = Object.freeze;
  Object.freeze = function (obj) {
    try { if (isCipherModule(obj)) wrapModule(obj); } catch (e) {}
    return realFreeze.call(this, obj);
  };

  // Fallback: also hook defineProperty (modules add Symbol.toStringTag this way).
  const realDefine = Object.defineProperty;
  Object.defineProperty = function (obj, prop, desc) {
    try { if (isCipherModule(obj)) wrapModule(obj); } catch (e) {}
    return realDefine.call(this, obj, prop, desc);
  };

  // ── Console helpers ─────────────────────────────────────────────────────────

  // cipherDump() — print everything captured so far (key/skip/len per module).
  window.cipherDump = function () {
    if (!store.length) { console.warn('[cipher-extractor] nothing captured yet — perform a sign-in / reserve action first.'); return; }
    console.table(store.map(r => ({ id: r.id, key: r.key, skip: r.skip, len: r.len, calls: r.calls })));
    return store;
  };

  // cipherEncrypt(id, token[, key, skip, len]) — call a captured module directly.
  window.cipherEncrypt = function (id, token, key, skip, len) {
    const r = store.find(x => x.id === id); if (!r) return '(no such module)';
    return r.encryptText(token, key ?? r.key, skip ?? r.skip, len ?? r.len);
  };
  window.cipherDecrypt = function (id, token, key, skip, len) {
    const r = store.find(x => x.id === id); if (!r) return '(no such module)';
    return r.decryptText(token, key ?? r.key, skip ?? r.skip, len ?? r.len);
  };

  console.log('%c[cipher-extractor] armed. Trigger sign-in / reserve, then run cipherDump()',
              'color:#08f;font-weight:bold');
})();
