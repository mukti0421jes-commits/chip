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

// ── code generation ──────────────────────────────────────────────────────────

const CHARSET_LITERAL = '"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_"';

// Shared preamble used by every clean file (matches the sample signin.js).
const PREAMBLE =
`const Charset = ${CHARSET_LITERAL};

// charsetIndex returns the index of ch in Charset, or -1 if not found.
function charsetIndex(ch) {
  return Charset.indexOf(ch);
}
`;

// Clean, readable implementations for the algorithms we have fully verified.
// Each defines a key-schedule plus ProcessToken(token,key,skip,encryptLen) and
// ReverseToken(...), in the exact style of the sample signin.js.
function cleanAlgoBody(algo) {
  if (algo === 'Cellular Automaton') {
    return `
// generateShiftsCellularAutomaton derives per-position shift values by evolving
// a 64-cell binary cellular automaton seeded from the key.
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

// ProcessToken encrypts a captcha token using Cellular Automaton.
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

// ReverseToken decrypts a captcha token using Cellular Automaton.
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
    if (idx !== -1) { let n = (idx - shifts[i]) % Charset.length; if (n < 0) n += Charset.length; middle[i] = Charset[n]; }
  }
  return prefix + middle.join("") + suffix;
}
`;
  }

  if (algo === 'Feistel (bitmix)') {
    return `
// keySchedule generates the 8 Feistel round keys from the cipher key.
function keySchedule(key) {
  let i = 0 >>> 0;
  for (let s = 0; s < key.length; s++) i = (i + key.charCodeAt(s) * (s + 1)) >>> 0;
  const out = [];
  for (let s = 0; s < 8; s++) { i = (Math.imul(i, 1103515245) + 12345) >>> 0; out.push(i & 7); }
  return out;
}
function roundFn(half, k) { return 7 & ((3 * half + k) ^ 3); }
function feistel(e, schedule) {
  let o = (e >> 3) & 7, i = e & 7;
  for (let c = 0; c < schedule.length; c++) { const ni = o ^ roundFn(i, schedule[c]); o = i; i = ni; }
  return (i << 3) | o;
}
function feistelInverse(x, schedule) {
  let i = (x >> 3) & 7, o = x & 7;
  for (let c = schedule.length - 1; c >= 0; c--) { const ni = o, no = i ^ roundFn(o, schedule[c]); o = no; i = ni; }
  return (o << 3) | i;
}

// ProcessToken encrypts a captcha token using the bitmix Feistel cipher.
function ProcessToken(token, key, skip, encryptLen) {
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

// ReverseToken decrypts a captcha token using the bitmix Feistel cipher.
function ReverseToken(token, key, skip, encryptLen) {
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
`;
  }

  if (algo === 'Polynomial Shift') {
    return `
// generateShiftsPoly derives per-position shift values from a polynomial over
// the key, modulo 67 then 64.
function generateShiftsPoly(key, length) {
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

// ProcessToken encrypts a captcha token using the polynomial shift cipher.
function ProcessToken(token, key, skip, encryptLen) {
  if (!token) return token;
  const prefixLen = Math.max(0, Math.min(skip, token.length));
  const remaining = Math.max(0, token.length - prefixLen);
  const actualLen = Math.max(0, Math.min(encryptLen, remaining));
  if (actualLen === 0) return token;
  const prefix = token.slice(0, prefixLen);
  const middle = token.slice(prefixLen, prefixLen + actualLen).split("");
  const suffix = token.slice(prefixLen + actualLen);
  const shifts = generateShiftsPoly(key, middle.length);
  for (let i = 0; i < middle.length; i++) {
    const idx = charsetIndex(middle[i]);
    if (idx !== -1) middle[i] = Charset[(idx + shifts[i]) % Charset.length];
  }
  return prefix + middle.join("") + suffix;
}

// ReverseToken decrypts a captcha token using the polynomial shift cipher.
function ReverseToken(token, key, skip, encryptLen) {
  if (!token) return token;
  const prefixLen = Math.max(0, Math.min(skip, token.length));
  const remaining = Math.max(0, token.length - prefixLen);
  const actualLen = Math.max(0, Math.min(encryptLen, remaining));
  if (actualLen === 0) return token;
  const prefix = token.slice(0, prefixLen);
  const middle = token.slice(prefixLen, prefixLen + actualLen).split("");
  const suffix = token.slice(prefixLen + actualLen);
  const shifts = generateShiftsPoly(key, middle.length);
  for (let i = 0; i < middle.length; i++) {
    const idx = charsetIndex(middle[i]);
    if (idx !== -1) { let n = (idx - shifts[i]) % Charset.length; if (n < 0) n += Charset.length; middle[i] = Charset[n]; }
  }
  return prefix + middle.join("") + suffix;
}
`;
  }

  if (algo === 'S-box substitution') {
    return `
// buildSbox derives a keyed substitution box (and its inverse) via a
// key-seeded Fisher-Yates shuffle of 0..63.
function buildSbox(key) {
  const N = 64;
  const sbox = Array.from({ length: N }, (_, t) => t);
  let u = 0;
  for (let l = 0; l < N; l++) {
    u = (u + sbox[l] + key.charCodeAt(l % key.length)) % N;
    const t = sbox[l]; sbox[l] = sbox[u]; sbox[u] = t;
  }
  const invSbox = new Array(N);
  for (let l = 0; l < N; l++) invSbox[sbox[l]] = l;
  return { sbox, invSbox };
}

// ProcessToken encrypts a captcha token: substitute via the s-box, then reverse.
function ProcessToken(token, key, skip, encryptLen) {
  if (!token) return token;
  const prefixLen = Math.max(0, Math.min(skip, token.length));
  const remaining = Math.max(0, token.length - prefixLen);
  const actualLen = Math.max(0, Math.min(encryptLen, remaining));
  if (actualLen === 0) return token;
  const prefix = token.slice(0, prefixLen);
  const middle = token.slice(prefixLen, prefixLen + actualLen).split("");
  const suffix = token.slice(prefixLen + actualLen);
  const { sbox } = buildSbox(key);
  for (let i = 0; i < middle.length; i++) {
    const idx = charsetIndex(middle[i]);
    if (idx !== -1) middle[i] = Charset[sbox[idx]];
  }
  middle.reverse();
  return prefix + middle.join("") + suffix;
}

// ReverseToken decrypts a captcha token: reverse, then inverse-substitute.
function ReverseToken(token, key, skip, encryptLen) {
  if (!token) return token;
  const prefixLen = Math.max(0, Math.min(skip, token.length));
  const remaining = Math.max(0, token.length - prefixLen);
  const actualLen = Math.max(0, Math.min(encryptLen, remaining));
  if (actualLen === 0) return token;
  const prefix = token.slice(0, prefixLen);
  const middle = token.slice(prefixLen, prefixLen + actualLen).split("");
  const suffix = token.slice(prefixLen + actualLen);
  const { invSbox } = buildSbox(key);
  middle.reverse();
  for (let i = 0; i < middle.length; i++) {
    const idx = charsetIndex(middle[i]);
    if (idx !== -1) middle[i] = Charset[invSbox[idx]];
  }
  return prefix + middle.join("") + suffix;
}
`;
  }

  return null; // no clean template for this algorithm
}

// Verify a clean body reproduces the real module exactly for the given key.
function cleanBodyMatches(body, mod, key, skip, len) {
  try {
    const sb = {};
    vm.createContext(sb);
    vm.runInContext(PREAMBLE + body + ';this.P=ProcessToken;this.R=ReverseToken;', sb, { timeout: 4000 });
    for (const t of ['0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ', 'hello-world_X-12345', 'aZ9_-bQ', 'x', '']) {
      const a = sb.P(t, key, skip, len);
      if (a !== mod.encryptText(t, key, skip, len)) return false;
      if (sb.R(a, key, skip, len) !== t) return false;
    }
    return true;
  } catch { return false; }
}

function cap2(tag) { return tag.charAt(0).toUpperCase() + tag.slice(1); }

// Emit a ready-to-use cipher file for one flow, in the sample signin.js style.
// Prefers a clean readable implementation (verified against the real module);
// falls back to embedding the site module for algorithms without a template.
function emitFlowFile(flow, modName, key, skip, len, algo, mod) {
  const isSignin = flow === 'SIGN-IN';
  const tag = isSignin ? 'signin' : (flow === 'RESERVE' ? 'reserve' : flow.toLowerCase().replace(/[^a-z]/g, '') || 'flow');
  const KP = isSignin ? 'Signin' : (flow === 'RESERVE' ? 'Reserve' : cap2(tag));   // constant prefix
  const SUF = isSignin ? 'Signin' : (flow === 'RESERVE' ? 'ReserveSlot' : cap2(tag)); // convenience suffix
  const Cap = cap2(tag);
  const file = path.join(process.cwd(), tag + '.generated.js');

  const consts =
`const ${KP}Key        = ${JSON.stringify(key)};
const ${KP}Skip       = ${skip};
const ${KP}EncryptLen = ${len};
`;

  const footer =
`
// ${tag} convenience wrappers (use the default ${KP} parameters).
function ProcessToken${SUF}(token) { return ProcessToken(token, ${KP}Key, ${KP}Skip, ${KP}EncryptLen); }
function ReverseToken${SUF}(token) { return ReverseToken(token, ${KP}Key, ${KP}Skip, ${KP}EncryptLen); }

if (typeof module !== 'undefined') {
  module.exports = { Charset, ${KP}Key, ${KP}Skip, ${KP}EncryptLen, ProcessToken, ReverseToken, ProcessToken${SUF}, ReverseToken${SUF} };
}
if (typeof window !== 'undefined') {
  window.${Cap}Cipher = { key: ${KP}Key, skip: ${KP}Skip, encryptLen: ${KP}EncryptLen, encrypt: ProcessToken${SUF}, decrypt: ReverseToken${SUF} };
}
`;

  const body = cleanAlgoBody(algo);
  let content, kind;
  if (body && mod && cleanBodyMatches(body, mod, key, skip, len)) {
    content =
`// ${tag}.generated.js — ${isSignin ? 'Sign-In' : (flow === 'RESERVE' ? 'Reserve Slot' : flow)} cipher (${algo})
// Auto-generated by extract.js from the site bundle (key/skip/len extracted,
// algorithm verified byte-for-byte against the live module).

${consts}
${PREAMBLE}${body}${footer}`;
    kind = 'clean';
  } else {
    const chunk = moduleChunk(modName);
    if (!chunk) return null;
    content =
`// ${tag}.generated.js — ${flow} cipher (${algo})
// Auto-generated by extract.js. No clean template for this algorithm, so the
// site's real cipher module is embedded to stay byte-for-byte correct.

${consts}
const Charset = ${CHARSET_LITERAL};
const _MOD = (function () {
${chunk}
  return ${modName};
})();
function ProcessToken(token, key, skip, encryptLen) { return _MOD.encryptText(token, key, skip, encryptLen); }
function ReverseToken(token, key, skip, encryptLen) { return _MOD.decryptText(token, key, skip, encryptLen); }
${footer}`;
    kind = 'embedded';
  }
  fs.writeFileSync(file, content);
  return { file, kind };
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
