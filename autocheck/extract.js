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
  if (/1103515245/.test(ns) && (/\*[a-z]\+[a-z]\^3/.test(ns) || /\(e>>3\)/.test(ns) || />>3&7/.test(ns))) return 'Feistel (bitmix)';
  if (/1103515245/.test(ns) && />>>16/.test(ns)) return 'Dual LCG';
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

  if (!configs.length) {
    console.log('No {secret,startAt,length,version} flow configs found.');
    console.log('The scheme may have changed — fall back to the runtime Tampermonkey extractor.');
    return;
  }

  console.log('flows (from {secret,startAt,length,version} configs):');
  for (const cfg of configs) {
    const modName = dispatcher[cfg.version];
    const key = decodeExpr(cfg.expr, cfg.at);
    const clean = typeof key === 'string' && /^[\x20-\x7e]+$/.test(key);

    console.log('  ┌─ version ' + cfg.version + '  ->  module ' + (modName || '?') +
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
    }
    console.log('  └────────────────────────────────────────────');
  }
}

main();
