#!/usr/bin/env node
'use strict';
// Captcha-cipher auto-checker (resilient edition).
//
// Usage:
//   node extract.js              -> auto-pick the bundle in this folder
//   node extract.js <file.js>    -> use a specific file
//   node extract.js <folder>     -> scan a folder for the bundle
//
// Reads an obfuscated frontend bundle (minified OR pretty-printed) and reports,
// for each captcha flow, the cipher module, secret key, skip, length, version
// and a best-effort algorithm name — then verifies by encrypting a sample.
//
// It anchors on properties that survive re-bundling/obfuscation:
//   * cipher modules expose  encryptText()  and  decryptText()
//   * flow configs are  { secret, startAt, length, version }
// Names, key values, versions, whitespace and minification may all change.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── 0. locate the bundle ────────────────────────────────────────────────────

function looksLikeBundle(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    return /encryptText/.test(txt) && /decryptText/.test(txt);
  } catch { return false; }
}

function pickBundle(arg) {
  let target = arg;
  if (!target) target = '.';
  let stat;
  try { stat = fs.statSync(target); } catch { console.error('No such path:', target); process.exit(1); }

  if (stat.isFile()) return target;

  // Directory: scan .js files, prefer ones that contain the cipher markers,
  // then pick the largest.
  const files = fs.readdirSync(target)
    .filter(f => f.endsWith('.js') && f !== path.basename(__filename))
    .map(f => path.join(target, f));
  if (!files.length) { console.error('No .js files found in', target); process.exit(1); }

  const scored = files.map(f => ({
    f,
    size: fs.statSync(f).size,
    hit: looksLikeBundle(f),
  })).sort((a, b) => (b.hit - a.hit) || (b.size - a.size));

  const chosen = scored[0];
  if (!chosen.hit) {
    console.error('Warning: no file in "' + target + '" contains encryptText/decryptText.');
  }
  return chosen.f;
}

const FILE = pickBundle(process.argv[2]);
const src = fs.readFileSync(FILE, 'utf8');

// ── helpers ─────────────────────────────────────────────────────────────────

// Extract a balanced { ... } body starting at the first '{' at/after `from`.
function balancedFrom(s, from) {
  const open = s.indexOf('{', from);
  if (open === -1) return null;
  return balancedAt(s, open);
}

// Extract a balanced { ... } body whose opening brace is exactly at `open`.
function balancedAt(s, open) {
  let depth = 0, inStr = false, q = '', esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return { start: open, end: i + 1 }; }
  }
  return null;
}

// The smallest object literal { ... } that encloses position `pos`.
function enclosingObject(s, pos) {
  let depth = 0;
  for (let i = pos; i >= 0; i--) {
    const c = s[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) return balancedAt(s, i);
      depth--;
    }
  }
  return null;
}

// Module wrapper tail — tolerant of minified OR pretty-printed whitespace.
const MODULE_DELIM_RE = /Symbol\.toStringTag\s*,\s*\{\s*value:\s*"Module"\s*\}\s*\)\s*\)/g;
const delimEnds = (() => {
  const ends = []; let m; MODULE_DELIM_RE.lastIndex = 0;
  while ((m = MODULE_DELIM_RE.exec(src))) ends.push({ start: m.index, end: m.index + m[0].length });
  return ends;
})();

// ── secret-string decoder (de-obfuscator) ───────────────────────────────────

const CALL = /([A-Za-z_$][\w$]*)\s*\(/g;
const NEAR = 60000;

function extractFunctionNear(name, anchor) {
  const re = new RegExp('function\\s+' + name.replace(/[$]/g, '\\$') + '\\s*\\(', 'g');
  let best = null, bestDist = Infinity, m;
  while ((m = re.exec(src))) {
    const d = Math.abs(m.index - anchor);
    if (d < bestDist) { bestDist = d; best = m.index; }
  }
  if (best === null || bestDist > NEAR) return null;
  const paren = src.indexOf('(', best);
  const body = balancedFrom(src, paren);
  return body ? src.slice(best, body.end) : null;
}

function extractRotation(arrName) {
  const tailRe = new RegExp('\\}\\s*\\(\\s*' + arrName.replace(/[$]/g, '\\$') + '\\s*\\)');
  const tm = tailRe.exec(src);
  if (!tm) return null;
  const at = tm.index, tailEnd = at + tm[0].length;
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    if (src[i] === '}') depth++;
    else if (src[i] === '{') { depth--; if (depth === 0) {
      let fnStart = src.lastIndexOf('!function', i);
      const paren = src.lastIndexOf('(function', i);
      if (paren > fnStart) fnStart = paren;
      if (fnStart === -1) return null;
      return src.slice(fnStart, tailEnd);
    } }
  }
  return null;
}

function decodeExpr(expr, anchor) {
  const collectedFns = new Map();
  const arrays = new Set();
  const queue = [];
  let m; const cr = new RegExp(CALL.source, 'g');
  while ((m = cr.exec(expr))) queue.push(m[1]);

  while (queue.length) {
    const name = queue.shift();
    if (collectedFns.has(name) || name === 'function') continue;
    const txt = extractFunctionNear(name, anchor);
    if (!txt) continue;
    collectedFns.set(name, txt);
    if (new RegExp('\\b' + name.replace(/[$]/g, '\\$') + '\\s*=\\s*function\\s*\\(\\s*\\)\\s*\\{\\s*return\\b').test(txt)) {
      arrays.add(name);
    }
    let mm; const inner = new RegExp(CALL.source, 'g');
    while ((mm = inner.exec(txt))) {
      const id = mm[1];
      if (id !== name && !collectedFns.has(id)) queue.push(id);
    }
    if (collectedFns.size > 120) break;
  }

  let code = '';
  for (const a of arrays) { const r = extractRotation(a); if (r) code += r + ';\n'; }
  for (const t of collectedFns.values()) code += t + ';\n';
  code += '__OUT=(' + expr + ');';

  const sandbox = { __OUT: null };
  try {
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { timeout: 4000 });
    return typeof sandbox.__OUT === 'string' ? sandbox.__OUT : null;
  } catch { return null; }
}

// ── 1. cipher modules ────────────────────────────────────────────────────────

// A module chunk = source between the previous and the next module delimiter.
function moduleChunk(constName) {
  const re = new RegExp('([A-Za-z0-9_$]+)\\s*=\\s*Object\\.freeze', 'g');
  let m, ci = -1;
  while ((m = re.exec(src))) { if (m[1] === constName) { ci = m.index; break; } }
  if (ci === -1) return null;
  const next = delimEnds.find(d => d.start >= ci);
  if (!next) return null;
  let prevEnd = 0;
  for (const d of delimEnds) { if (d.end <= ci) prevEnd = d.end; else break; }
  return src.slice(prevEnd, next.end);
}

// Find every `NAME = Object.freeze(Object.defineProperty({ ... }))` whose object
// exposes BOTH encryptText and decryptText (property order doesn't matter).
function findModules() {
  const re = /([A-Za-z0-9_$]+)\s*=\s*Object\.freeze\(Object\.defineProperty\(/g;
  const mods = []; let m;
  while ((m = re.exec(src))) {
    const body = balancedFrom(src, m.index);
    if (!body) continue;
    const txt = src.slice(body.start, body.end);
    if (/\bencryptText\b/.test(txt) && /\bdecryptText\b/.test(txt) && !mods.includes(m[1])) {
      mods.push(m[1]);
    }
  }
  return mods;
}

function loadModule(name) {
  const chunk = moduleChunk(name);
  if (!chunk) return null;
  const sandbox = {};
  try {
    vm.createContext(sandbox);
    vm.runInContext(chunk + ';this.__M=' + name + ';', sandbox, { timeout: 4000 });
    return sandbox.__M;
  } catch { return null; }
}

function detectAlgo(name) {
  const ns = (moduleChunk(name) || '').replace(/\s+/g, '');
  if (/Uint8Array\(64\)/.test(ns) && /\[32\]=1/.test(ns)) return 'Cellular Automaton';
  if (/3\.99/.test(ns)) return 'Logistic Map';
  if (/0xe8d6ca6163/.test(ns) || /314159265/.test(ns)) return 'Modular Exponentiation';
  // Feistel round function is `7 & ((3*e + t) ^ 3)`.
  if (/1103515245/.test(ns) && (/\*[a-z]\+[a-z]\^3/.test(ns) || /\(e>>3\)/.test(ns) || />>3&7/.test(ns))) return 'Feistel (bitmix)';
  if (/1103515245/.test(ns) && />>>16/.test(ns)) return 'Dual LCG';
  // Keyed substitution box: encryptText destructures {sbox,invSbox} from the key.
  if (/invSbox/.test(ns) || /\{sbox:/.test(ns) || /sbox\]/.test(ns)) return 'S-box substitution';
  if (/1103515245/.test(ns)) return 'LCG-based';
  if (/%67/.test(ns)) return 'Polynomial Shift';
  return 'other / unknown';
}

// ── 2. dispatcher (version -> module) ────────────────────────────────────────

function findDispatcher() {
  const map = {};
  // number : ()=> ...(()=> MODULE)   (whitespace-tolerant, any wrapper depth)
  const re = /(\d+)\s*:\s*\(\)\s*=>[^,{}]*?=>\s*([A-Za-z0-9_$]+)\s*\)/g;
  let m;
  while ((m = re.exec(src))) { const v = +m[1]; if (!(v in map)) map[v] = m[2]; }
  return map;
}

// ── 3. flow configs ({ secret, startAt, length, version }) ───────────────────

function findConfigs() {
  const out = [];
  const seen = new Set();
  // Anchor on `startAt:` then read the whole enclosing object — field order and
  // whitespace are irrelevant this way.
  const re = /startAt\s*:\s*(\d+)/g;
  let m;
  while ((m = re.exec(src))) {
    const obj = enclosingObject(src, m.index);
    if (!obj) continue;
    const t = src.slice(obj.start, obj.end);
    const sec = /secret\s*:\s*([\s\S]*?)\s*,\s*(?:startAt|length|version|seedMode|mode|skip)\s*:/.exec(t);
    const len = /length\s*:\s*(\d+)/.exec(t);
    const ver = /version\s*:\s*(\d+)/.exec(t);
    if (!sec || !len || !ver) continue;
    const tag = ver[1] + ':' + m[1] + ':' + len[1];
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push({
      expr: sec[1],
      skip: +m[1],
      len: +len[1],
      version: +ver[1],
      at: obj.start + t.indexOf('secret'),
    });
  }
  return out;
}

// Classify a flow as sign-in or reserve by the UI strings around its config.
function classifyFlow(anchor) {
  const win = src.slice(Math.max(0, anchor - 6000), anchor + 6000).toLowerCase();
  const signin = (win.match(/sign-?in|login|otp|phone|password|verify-login/g) || []).length;
  const reserve = (win.match(/reserve|reserving|booking|slot|continuebooking|date/g) || []).length;
  if (signin > reserve) return 'SIGN-IN';
  if (reserve > signin) return 'RESERVE';
  return 'unknown-flow';
}

// ── code generation (static precomputed tables, sample-file style) ───────────

const _CS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_';
const CHARSET_LITERAL = JSON.stringify(_CS);

// -- verified key schedules (used only to PRECOMPUTE the static tables) -------
function _caShifts(key, length) {
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
    shifts[h] = t % 64;
  }
  return shifts;
}
function _polyShifts(key, length) {
  const stateLen = Math.max(3, key.length);
  const s = [];
  for (let r = 0; r < stateLen; r++) s[r] = (key.charCodeAt(r % key.length) + r) % 67;
  const shifts = [];
  for (let f = 1; f <= length; f++) {
    let e = 0, t = 1;
    for (const o of s) { e = (e + o * t) % 67; t = (t * f) % 67; }
    shifts[f - 1] = e % 64;
  }
  return shifts;
}
function _sboxOf(key) {
  const N = 64;
  const sbox = Array.from({ length: N }, (_, t) => t);
  let u = 0;
  for (let l = 0; l < N; l++) { u = (u + sbox[l] + key.charCodeAt(l % key.length)) % N; const t = sbox[l]; sbox[l] = sbox[u]; sbox[u] = t; }
  return sbox;
}
function _feistelSbox(key) {
  let i = 0 >>> 0;
  for (let s = 0; s < key.length; s++) i = (i + key.charCodeAt(s) * (s + 1)) >>> 0;
  const sch = [];
  for (let s = 0; s < 8; s++) { i = (Math.imul(i, 1103515245) + 12345) >>> 0; sch.push(i & 7); }
  const round = (h, k) => 7 & ((3 * h + k) ^ 3);
  const fe = (e) => { let o = (e >> 3) & 7, j = e & 7; for (let c = 0; c < sch.length; c++) { const ni = o ^ round(j, sch[c]); o = j; j = ni; } return ((j << 3) | o) % 64; };
  const sbox = new Array(64);
  for (let e = 0; e < 64; e++) sbox[e] = fe(e);
  return sbox;
}
function _invert(sbox) { const inv = new Array(sbox.length); for (let i = 0; i < sbox.length; i++) inv[sbox[i]] = i; return inv; }

// Decide the static representation for an algorithm.
//   sbox  : single 64-entry substitution + a position permutation
//   shift : per-position Caesar shift table (length entries)
function staticTables(algo, key, len) {
  if (algo === 'S-box substitution') {
    const sbox = _sboxOf(key);
    const perm = []; for (let i = 0; i < len; i++) perm.push(len - 1 - i); // reverse
    return { mode: 'sbox', sbox, invSbox: _invert(sbox), perm };
  }
  if (algo === 'Feistel (bitmix)') {
    const sbox = _feistelSbox(key);
    const perm = []; for (let i = 0; i < len; i++) perm.push(i); // identity
    return { mode: 'sbox', sbox, invSbox: _invert(sbox), perm };
  }
  if (algo === 'Cellular Automaton') return { mode: 'shift', shifts: _caShifts(key, len) };
  if (algo === 'Polynomial Shift')   return { mode: 'shift', shifts: _polyShifts(key, len) };
  return null;
}

function _names(flow) {
  if (flow === 'SIGN-IN') return { tag: 'signin', UP: 'SIGNIN', Cap: 'Signin', low: 'signin' };
  if (flow === 'RESERVE') return { tag: 'reserve', UP: 'RESERVE', Cap: 'Reserve', low: 'reserve' };
  const t = flow.toLowerCase().replace(/[^a-z]/g, '') || 'flow';
  return { tag: t, UP: t.toUpperCase(), Cap: t.charAt(0).toUpperCase() + t.slice(1), low: t };
}

const _arr = a => '[' + a.join(', ') + ']';

// Build the static-table source file (sample-file style) for a flow.
function buildStaticFile(flow, tab, key, skip, len, algo) {
  const n = _names(flow);
  const head =
`// === ${n.UP} CAPTCHA ENCRYPTION (${algo}) ===
// Auto-generated by extract.js. Tables precomputed from the live module's key
// and verified byte-for-byte. Designed for real (full-length) captcha tokens.

const ${n.UP}_CHARSET = ${CHARSET_LITERAL};
const ${n.UP}_CAPTCHA_SECRET = ${JSON.stringify(key)};
const ${n.UP}_SKIP = ${skip};
const ${n.UP}_LENGTH = ${len};
`;

  let coreEnc, coreDec, tables;
  if (tab.mode === 'sbox') {
    tables =
`
const ${n.low}Perm = ${_arr(tab.perm)};
const ${n.low}Sbox = ${_arr(tab.sbox)};
const ${n.low}InvSbox = ${_arr(tab.invSbox)};
`;
    coreEnc =
`function encrypt${n.Cap}CaptchaTokenImpl(token, key, skip, length) {
  if (!token || typeof token !== "string") return token;
  const prefixLen = Math.max(0, Math.min(skip, token.length));
  const span = Math.max(0, Math.min(length, Math.max(0, token.length - prefixLen)));
  if (span === 0) return token;
  const src = token.slice(prefixLen, prefixLen + span).split("");
  const mid = src.slice();
  for (let i = 0; i < span; i++) {
    const sp = ${n.low}Perm[i];
    const ch = sp < span ? src[sp] : src[i];
    const ci = ${n.UP}_CHARSET.indexOf(ch);
    mid[i] = ci !== -1 ? ${n.UP}_CHARSET[${n.low}Sbox[ci]] : ch;
  }
  return token.slice(0, prefixLen) + mid.join("") + token.slice(prefixLen + span);
}`;
    coreDec =
`function decrypt${n.Cap}CaptchaTokenImpl(token, key, skip, length) {
  if (!token || typeof token !== "string") return token;
  const prefixLen = Math.max(0, Math.min(skip, token.length));
  const span = Math.max(0, Math.min(length, Math.max(0, token.length - prefixLen)));
  if (span === 0) return token;
  const enc = token.slice(prefixLen, prefixLen + span).split("");
  const out = enc.slice();
  for (let i = 0; i < span; i++) {
    const sp = ${n.low}Perm[i];
    const dst = sp < span ? sp : i;
    const ci = ${n.UP}_CHARSET.indexOf(enc[i]);
    out[dst] = ci !== -1 ? ${n.UP}_CHARSET[${n.low}InvSbox[ci]] : enc[i];
  }
  return token.slice(0, prefixLen) + out.join("") + token.slice(prefixLen + span);
}`;
  } else {
    tables =
`
const ${n.low}Shifts = ${_arr(tab.shifts)};
`;
    coreEnc =
`function encrypt${n.Cap}CaptchaTokenImpl(token, key, skip, length) {
  if (!token || typeof token !== "string") return token;
  const prefixLen = Math.max(0, Math.min(skip, token.length));
  const span = Math.max(0, Math.min(length, Math.max(0, token.length - prefixLen)));
  if (span === 0) return token;
  const src = token.slice(prefixLen, prefixLen + span).split("");
  for (let i = 0; i < span; i++) {
    const ci = ${n.UP}_CHARSET.indexOf(src[i]);
    if (ci !== -1) src[i] = ${n.UP}_CHARSET[(ci + ${n.low}Shifts[i]) % 64];
  }
  return token.slice(0, prefixLen) + src.join("") + token.slice(prefixLen + span);
}`;
    coreDec =
`function decrypt${n.Cap}CaptchaTokenImpl(token, key, skip, length) {
  if (!token || typeof token !== "string") return token;
  const prefixLen = Math.max(0, Math.min(skip, token.length));
  const span = Math.max(0, Math.min(length, Math.max(0, token.length - prefixLen)));
  if (span === 0) return token;
  const enc = token.slice(prefixLen, prefixLen + span).split("");
  for (let i = 0; i < span; i++) {
    const ci = ${n.UP}_CHARSET.indexOf(enc[i]);
    if (ci !== -1) { let v = (ci - ${n.low}Shifts[i]) % 64; if (v < 0) v += 64; enc[i] = ${n.UP}_CHARSET[v]; }
  }
  return token.slice(0, prefixLen) + enc.join("") + token.slice(prefixLen + span);
}`;
  }

  const pub =
`
function encrypt${n.Cap}CaptchaToken(rawToken) { return encrypt${n.Cap}CaptchaTokenImpl(rawToken, ${n.UP}_CAPTCHA_SECRET, ${n.UP}_SKIP, ${n.UP}_LENGTH); }
function decrypt${n.Cap}CaptchaToken(rawToken) { return decrypt${n.Cap}CaptchaTokenImpl(rawToken, ${n.UP}_CAPTCHA_SECRET, ${n.UP}_SKIP, ${n.UP}_LENGTH); }

if (typeof module !== "undefined") {
  module.exports = {
    ${n.UP}_CHARSET, ${n.UP}_CAPTCHA_SECRET, ${n.UP}_SKIP, ${n.UP}_LENGTH,
    encrypt${n.Cap}CaptchaToken, decrypt${n.Cap}CaptchaToken,
    encrypt${n.Cap}CaptchaTokenImpl, decrypt${n.Cap}CaptchaTokenImpl
  };
}
if (typeof window !== "undefined") {
  window.${n.Cap}Cipher = { encrypt: encrypt${n.Cap}CaptchaToken, decrypt: decrypt${n.Cap}CaptchaToken };
}
`;
  return head + tables + '\n' + coreEnc + '\n\n' + coreDec + '\n' + pub;
}

// Verify the generated static file reproduces the real module on full-length
// tokens (which is what real captcha tokens always are).
function verifyStaticFile(content, implName, decName, mod, key, skip, len) {
  try {
    const sb = {};
    vm.createContext(sb);
    vm.runInContext(content + ';this.E=' + implName + ';this.D=' + decName + ';', sb, { timeout: 4000 });
    const long = (_CS + _CS).slice(0, skip + len + 8);
    for (const t of [long, _CS.slice(0, skip + len + 5), 'A'.repeat(skip) + _CS.slice(0, len + 3)]) {
      if (sb.E(t, key, skip, len) !== mod.encryptText(t, key, skip, len)) return false;
      if (sb.D(sb.E(t, key, skip, len), key, skip, len) !== t) return false;
    }
    return true;
  } catch { return false; }
}

// Emit a ready-to-use cipher file for one flow, in the static sample-file style.
// Falls back to embedding the real module for algorithms without a template.
function emitFlowFile(flow, modName, key, skip, len, algo, mod) {
  const n = _names(flow);
  const file = path.join(process.cwd(), n.tag + '.generated.js');
  const tab = staticTables(algo, key, len);

  if (tab && mod) {
    const content = buildStaticFile(flow, tab, key, skip, len, algo);
    if (verifyStaticFile(content, 'encrypt' + n.Cap + 'CaptchaTokenImpl', 'decrypt' + n.Cap + 'CaptchaTokenImpl', mod, key, skip, len)) {
      fs.writeFileSync(file, content);
      return { file, kind: 'static ' + tab.mode };
    }
  }

  // Fallback: embed the real module verbatim (byte-for-byte correct).
  const chunk = moduleChunk(modName);
  if (!chunk) return null;
  const content =
`// === ${n.UP} CAPTCHA ENCRYPTION (${algo}) ===
// Auto-generated by extract.js. No static template for this algorithm, so the
// site's real cipher module is embedded to stay byte-for-byte correct.

const ${n.UP}_CHARSET = ${CHARSET_LITERAL};
const ${n.UP}_CAPTCHA_SECRET = ${JSON.stringify(key)};
const ${n.UP}_SKIP = ${skip};
const ${n.UP}_LENGTH = ${len};

const _MOD = (function () {
${chunk}
  return ${modName};
})();

function encrypt${n.Cap}CaptchaToken(rawToken) { return _MOD.encryptText(rawToken, ${n.UP}_CAPTCHA_SECRET, ${n.UP}_SKIP, ${n.UP}_LENGTH); }
function decrypt${n.Cap}CaptchaToken(rawToken) { return _MOD.decryptText(rawToken, ${n.UP}_CAPTCHA_SECRET, ${n.UP}_SKIP, ${n.UP}_LENGTH); }

if (typeof module !== "undefined") {
  module.exports = { ${n.UP}_CHARSET, ${n.UP}_CAPTCHA_SECRET, ${n.UP}_SKIP, ${n.UP}_LENGTH, encrypt${n.Cap}CaptchaToken, decrypt${n.Cap}CaptchaToken };
}
if (typeof window !== "undefined") {
  window.${n.Cap}Cipher = { encrypt: encrypt${n.Cap}CaptchaToken, decrypt: decrypt${n.Cap}CaptchaToken };
}
`;
  fs.writeFileSync(file, content);
  return { file, kind: 'embedded' };
}

// ── report ───────────────────────────────────────────────────────────────────

function main() {
  const modules = findModules();
  const dispatcher = findDispatcher();
  const configs = findConfigs();

  console.log('================ CAPTCHA CIPHER AUTO-CHECKER ================');
  console.log('bundle:', FILE, '(' + (src.length / 1048576).toFixed(2) + ' MB,', src.split('\n').length, 'lines)');
  console.log();

  console.log('cipher modules found:', modules.length);
  for (let i = 0; i < modules.length; i++) {
    const v = Object.keys(dispatcher).find(k => dispatcher[k] === modules[i]);
    console.log(`  #${i + 1} ${modules[i].padEnd(4)} version=${v || '?'}  algo=${detectAlgo(modules[i])}`);
  }
  console.log();

  if (!modules.length) {
    console.log('✗ No cipher modules found (no encryptText/decryptText pair).');
    console.log('  The cipher library structure changed — use the runtime');
    console.log('  Tampermonkey extractor (cipher-extractor.user.js) instead.');
    return;
  }

  if (!configs.length) {
    console.log('✗ Modules found, but no {secret,startAt,length,version} flow configs.');
    console.log('  The config shape changed — use the runtime Tampermonkey extractor.');
    return;
  }

  let okCount = 0;
  const generated = [];
  console.log('flows (from {secret,startAt,length,version} configs):');
  for (const cfg of configs) {
    const modName = dispatcher[cfg.version];
    const key = decodeExpr(cfg.expr, cfg.at);
    const clean = typeof key === 'string' && /^[\x20-\x7e]+$/.test(key);
    if (clean) okCount++;

    const flow = classifyFlow(cfg.at);
    console.log('  ┌─ [' + flow + ']  version ' + cfg.version + '  ->  module ' + (modName || '?') +
                '  (' + (modName ? detectAlgo(modName) : '?') + ')');
    if (clean) {
      console.log('  │  key  : ' + JSON.stringify(key));
    } else if (key !== null) {
      console.log('  │  key  : ' + JSON.stringify(key));
      console.log('  │         ⚠ decode looks corrupted — use the runtime Tampermonkey extractor');
    } else {
      console.log('  │  key  : (decode failed — use runtime extractor)');
    }
    console.log('  │  skip : ' + cfg.skip);
    console.log('  │  len  : ' + cfg.len);

    const mod = modName && loadModule(modName);
    if (mod && key) {
      const sample = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
      try {
        const enc = mod.encryptText(sample, key, cfg.skip, cfg.len);
        const dec = mod.decryptText(enc, key, cfg.skip, cfg.len);
        console.log('  │  test : enc=' + enc);
        console.log('  │         roundtrip ' + (dec === sample ? 'OK ✔' : 'FAILED ✗'));
      } catch { console.log('  │  test : (module eval error)'); }

      // Write a ready-to-use standalone JS file for this flow.
      if (clean) {
        const r = emitFlowFile(flow, modName, key, cfg.skip, cfg.len, detectAlgo(modName), mod);
        if (r) {
          generated.push(r.file);
          console.log('  │  file : ' + path.basename(r.file) + '  (' + r.kind + ', encrypt/decrypt ready)');
        }
      }
    }
    console.log('  └────────────────────────────────────────────');
  }

  // ── overall health verdict ──────────────────────────────────────────────
  console.log();
  if (generated.length) {
    console.log('generated ready-to-use files (in ' + process.cwd() + '):');
    for (const f of generated) console.log('  • ' + path.basename(f));
    console.log();
  }
  if (okCount === configs.length) {
    console.log('✔ DONE — all ' + okCount + ' active flow(s) extracted cleanly. You can trust these values.');
  } else if (okCount > 0) {
    console.log('▲ PARTIAL — ' + okCount + '/' + configs.length + ' flow(s) clean; the rest look corrupted.');
    console.log('  For the corrupted one(s), confirm the key with the runtime Tampermonkey extractor.');
  } else {
    console.log('✗ Keys could not be decoded — the obfuscation changed.');
    console.log('  Use the runtime Tampermonkey extractor (cipher-extractor.user.js) for the exact keys.');
  }
}

main();
