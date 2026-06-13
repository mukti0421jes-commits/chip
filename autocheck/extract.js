#!/usr/bin/env node
'use strict';
// Captcha-cipher auto-checker.
// Usage: node extract.js <bundle.js>
// Reads an obfuscated frontend bundle and reports, for each captcha flow,
// the cipher module, secret key, skip, length, version and detected algorithm.

const fs = require('fs');
const vm = require('vm');

const FILE = process.argv[2];
if (!FILE) { console.error('Usage: node extract.js <bundle.js>'); process.exit(1); }
const src = fs.readFileSync(FILE, 'utf8');

const MODULE_DELIM = 'Symbol.toStringTag,{value:"Module"}))';

// ── helpers ───────────────────────────────────────────────────────────────────

// Extract a balanced { ... } body starting at the first '{' at/after `from`.
function balanced(s, from) {
  const open = s.indexOf('{', from);
  if (open === -1) return null;
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

// Pull the full text of a `function NAME(...) { ... }` declaration.
function extractFunction(name) {
  const re = new RegExp('function\\s+' + name.replace(/[$]/g, '\\$') + '\\s*\\(');
  const m = re.exec(src);
  if (!m) return null;
  const paren = src.indexOf('(', m.index);
  const body = balanced(src, paren);
  if (!body) return null;
  return src.slice(m.index, body.end);
}

// Find the rotation IIFE `!function(e){...}(ARR)` for a given array func name.
function extractRotation(arrName) {
  const tail = '}(' + arrName + ')';
  const at = src.indexOf(tail);
  if (at === -1) return null;
  // Walk back to the matching `!function` that owns this closing brace.
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    if (src[i] === '}') depth++;
    else if (src[i] === '{') { depth--; if (depth === 0) {
      const fnStart = src.lastIndexOf('!function', i);
      if (fnStart === -1) return null;
      return src.slice(fnStart, at + tail.length);
    } }
  }
  return null;
}

// Identifiers used as *calls* — `name(` — these are the only ones worth chasing.
const CALL = /([A-Za-z_$][\w$]*)\s*\(/g;
// How far from the config a helper definition may live (same obfuscation block).
const NEAR = 60000;

// Find the `function NAME(... ) { ... }` whose definition is closest to `anchor`.
function extractFunctionNear(name, anchor) {
  const re = new RegExp('function\\s+' + name.replace(/[$]/g, '\\$') + '\\s*\\(', 'g');
  let best = null, bestDist = Infinity, m;
  while ((m = re.exec(src))) {
    const d = Math.abs(m.index - anchor);
    if (d < bestDist) { bestDist = d; best = m.index; }
  }
  if (best === null || bestDist > NEAR) return null;
  const paren = src.indexOf('(', best);
  const body = balanced(src, paren);
  if (!body) return null;
  return src.slice(best, body.end);
}

// Decode an obfuscated string expression by gathering the local helper
// functions it references (the string-array, its rotation, and the decoder
// wrappers near `anchor`), then evaluating it in a sandbox.
function decodeExpr(expr, anchor) {
  const collectedFns = new Map();   // name -> text
  const arrays = new Set();
  const queue = [];
  let m;
  const cr = new RegExp(CALL.source, 'g');
  while ((m = cr.exec(expr))) queue.push(m[1]);

  while (queue.length) {
    const name = queue.shift();
    if (collectedFns.has(name) || name === 'function') continue;
    const txt = extractFunctionNear(name, anchor);
    if (!txt) continue;
    collectedFns.set(name, txt);
    if (new RegExp('\\b' + name.replace(/[$]/g, '\\$') + '=function\\(\\)\\{return ').test(txt)) {
      arrays.add(name);
    }
    // Only chase identifiers that are themselves called inside this helper.
    let mm; const inner = new RegExp(CALL.source, 'g');
    while ((mm = inner.exec(txt))) {
      const id = mm[1];
      if (id !== name && !collectedFns.has(id)) queue.push(id);
    }
    if (collectedFns.size > 120) break; // safety cap
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
  } catch (e) {
    return null;
  }
}

// ── 1. cipher modules ──────────────────────────────────────────────────────────

function moduleChunk(constName) {
  const ci = src.indexOf('const ' + constName + '=Object.freeze');
  if (ci === -1) return null;
  const end = src.indexOf(MODULE_DELIM, ci) + MODULE_DELIM.length;
  const prev = src.lastIndexOf(MODULE_DELIM, ci);
  return src.slice(prev === -1 ? 0 : prev + MODULE_DELIM.length, end);
}

function findModules() {
  const re = /const ([A-Za-z0-9_$]+)=Object\.freeze\(Object\.defineProperty\(\{__proto__:null,decryptText:[^,]+,encryptText:[^,]+\}/g;
  const mods = [];
  let m;
  while ((m = re.exec(src))) mods.push(m[1]);
  return mods;
}

// Load a module chunk in a sandbox and return its {encryptText, decryptText}.
function loadModule(name) {
  const chunk = moduleChunk(name);
  if (!chunk) return null;
  const sandbox = {};
  try {
    vm.createContext(sandbox);
    vm.runInContext(chunk + ';this.__M=' + name + ';', sandbox, { timeout: 4000 });
    return sandbox.__M;
  } catch (e) { return null; }
}

// Detect the algorithm from a module chunk's source signatures.
function detectAlgo(name) {
  const c = moduleChunk(name) || '';
  if (/Uint8Array\(64\)/.test(c) && /\[32\]=1/.test(c)) return 'Cellular Automaton';
  if (/3\.99/.test(c)) return 'Logistic Map';
  if (/0xe8d6ca6163/.test(c) || /314159265/.test(c)) return 'Modular Exponentiation';
  // Feistel round function is `7 & ((3*e + t) ^ 3)` — match the `*e+t^3` core.
  if (/1103515245/.test(c) && (/\*e\+t\^3/.test(c) || /3\*[a-z]\+[a-z]\^3/.test(c) || /\(e>>3\)/.test(c))) return 'Feistel (bitmix)';
  if (/1103515245/.test(c) && />>>16/.test(c)) return 'Dual LCG';
  if (/1103515245/.test(c)) return 'LCG-based';
  if (/charCodeAt\([^)]*\)\^/.test(c) && /256/.test(c)) return 'RC4-like';
  return 'unknown';
}

// ── 2. dispatcher (version -> module) ──────────────────────────────────────────

function findDispatcher() {
  // const oQ={1:()=>Xe(()=>Promise.resolve().then(()=>SX)),2:()=>...HX)),...}
  const m = /\{(\s*\d+:\(\)=>[^}]*?then\(\(\)=>[A-Za-z0-9_$]+\)\)[^}]*)\}/.exec(src);
  const map = {};
  const re = /(\d+):\(\)=>[^,]*?then\(\(\)=>([A-Za-z0-9_$]+)\)\)/g;
  let mm;
  while ((mm = re.exec(src))) {
    const v = +mm[1], mod = mm[2];
    if (!(v in map)) map[v] = mod;
  }
  return map;
}

// ── 3. configs ({secret, startAt, length, version}) ────────────────────────────

function findConfigs() {
  // `[^{}]` keeps the secret expression on one statement (no brace crossing),
  // so the iQ destructuring `{secret:a,startAt:c,...}` is never matched.
  const re = /secret:([^{}]*?),startAt:(\d+),length:(\d+),version:(\d+)/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    out.push({ expr: m[1], skip: +m[2], len: +m[3], version: +m[4], at: m.index });
  }
  return out;
}

// ── report ─────────────────────────────────────────────────────────────────────

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

  console.log('flows (from {secret,startAt,length,version} configs):');
  const seen = new Set();
  for (const cfg of configs) {
    const tag = cfg.version + ':' + cfg.skip + ':' + cfg.len;
    if (seen.has(tag)) continue;
    seen.add(tag);

    const modName = dispatcher[cfg.version];
    const key = decodeExpr(cfg.expr, cfg.at);
    console.log('  ┌─ version ' + cfg.version + '  ->  module ' + (modName || '?') +
                '  (' + (modName ? detectAlgo(modName) : '?') + ')');
    console.log('  │  key  : ' + (key !== null ? JSON.stringify(key) : '(decode failed — use runtime extractor)'));
    console.log('  │  skip : ' + cfg.skip);
    console.log('  │  len  : ' + cfg.len);

    // Verify by encrypting a sample if the module loads.
    const mod = modName && loadModule(modName);
    if (mod && key) {
      const sample = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
      try {
        const enc = mod.encryptText(sample, key, cfg.skip, cfg.len);
        const dec = mod.decryptText(enc, key, cfg.skip, cfg.len);
        console.log('  │  test : enc=' + enc);
        console.log('  │         roundtrip ' + (dec === sample ? 'OK ✔' : 'FAILED �’'));
      } catch (e) { console.log('  │  test : (module eval error)'); }
    }
    console.log('  └────────────────────────────────────────────');
  }
}

main();
