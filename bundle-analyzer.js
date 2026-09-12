#!/usr/bin/env node
/*
 * bundle-analyzer.js — static analyzer for JS bundles.
 *
 * Reads a JavaScript bundle FILE (no network, no browser, no execution of the
 * app) and reports what it can find by static inspection:
 *   - API endpoints (path + HTTP method) at axios/fetch call sites
 *   - request payload argument hints
 *   - custom request headers
 *   - cipher / crypto routines (charset alphabets, RC4, XOR, shift, base64)
 *
 * If the bundle is obfuscated with the common obfuscator.io string-array +
 * RC4 scheme, the analyzer auto-detects the decoder and resolves obfuscated
 * method/header strings so the report is readable.
 *
 * Usage:  node bundle-analyzer.js <bundle.js> [--json]
 */

const fs = require("fs");

const file = process.argv[2];
const asJson = process.argv.includes("--json");
if (!file) {
  console.error("Usage: node bundle-analyzer.js <bundle.js> [--json]");
  process.exit(1);
}
const code = fs.readFileSync(file, "utf8");

// ─────────────────────────────────────────────────────────────────────────
// 1. Obfuscator.io string-array + RC4 decoder auto-detection
// ─────────────────────────────────────────────────────────────────────────
function b64uri(e) {
  let t = "", n = "", r, o, i = 0;
  const tbl = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=";
  for (let a = 0; (o = e.charAt(a++)); ) {
    o = tbl.indexOf(o);
    if (~o) { r = i % 4 ? 64 * r + o : o; if (i++ % 4) t += String.fromCharCode(255 & (r >> ((-2 * i) & 6))); }
  }
  for (let x = 0, l = t.length; x < l; x++) n += "%" + ("00" + t.charCodeAt(x).toString(16)).slice(-2);
  try { return decodeURIComponent(n); } catch { return t; }
}
function rc4(str, key) {
  const e = b64uri(str);
  const o = []; for (let r = 0; r < 256; r++) o[r] = r;
  let i = 0, n;
  for (let r = 0; r < 256; r++) { i = (i + o[r] + key.charCodeAt(r % key.length)) % 256; n = o[r]; o[r] = o[i]; o[i] = n; }
  let r = 0; i = 0; let a = "";
  for (let c = 0; c < e.length; c++) { r = (r + 1) % 256; i = (i + o[r]) % 256; n = o[r]; o[r] = o[i]; o[i] = n; a += String.fromCharCode(e.charCodeAt(c) ^ o[(o[r] + o[i]) % 256]); }
  return a;
}
// a decode is "clean" when every char is printable ASCII and reads like an
// identifier / path / word (what real decoded tokens look like).
function clean(s) {
  if (typeof s !== "string" || !s.length) return 0;
  for (const c of s) { const n = c.charCodeAt(0); if (n < 32 || n > 126) return 0; }
  return /^[A-Za-z0-9_$\/.:@\- ]+$/.test(s) ? 1 : 0.4;
}

// A bundle can contain SEVERAL independent obfuscator string-array families
// (one per chunk), each with its own array, offset and rotation. Build a
// decoder for each and index every base-decoder name to its family, so a
// token is decoded by the family that actually owns its base function.
function buildDecoders(src) {
  const baseRe = /function\s+([A-Za-z_$]\w*)\(e,t\)\{e-=(\d+)\s+const\s+\w+=([A-Za-z_$]\w*)\(\)/g;
  const bases = [];
  let bm;
  while ((bm = baseRe.exec(src)) !== null) bases.push({ name: bm[1], offset: +bm[2], arrFn: bm[3] });
  if (!bases.length) return null;

  // group base names by their array function
  const byArr = {};
  for (const b of bases) (byArr[b.arrFn] ||= { offset: b.offset, names: [] }).names.push(b.name);

  const basesByName = new Map();
  const families = [];
  for (const [arrFn, info] of Object.entries(byArr)) {
    const am = src.match(new RegExp("function\\s+" + arrFn + "\\s*\\(\\)\\s*\\{const\\s+\\w+=\\["));
    if (!am) continue;
    const start = src.indexOf("[", am.index);
    const end = src.indexOf("]", start);
    let arr;
    try { arr = eval(src.slice(start, end + 1)); } catch { continue; }
    if (!Array.isArray(arr) || arr.length < 4) continue;
    const offset = info.offset;
    const mk = (rot) => (idx, key) => { const v = rot[idx - offset]; return key !== undefined ? rc4(v, key) : b64uri(v); };

    // score rotation with tokens that call THIS family's base names
    const samples = [];
    const tokRe = new RegExp("\\b(?:" + info.names.join("|") + ")\\((\\d{2,4}),\"([^\"]{1,8})\"\\)", "g");
    let sm; while ((sm = tokRe.exec(src)) !== null && samples.length < 80) samples.push([+sm[1], sm[2]]);
    let best = { k: 0, score: -1 };
    for (let k = 0; k < arr.length; k++) {
      const rot = arr.slice(k).concat(arr.slice(0, k));
      const pk = mk(rot);
      let score = 0, tot = 0;
      for (const [idx, key] of samples) { try { score += clean(pk(idx, key)); tot++; } catch {} }
      const avg = tot ? score / tot : 0;
      if (avg > best.score) best = { k, score: avg, rot };
    }
    if (best.score < 0.5) continue;
    const pk = mk(best.rot);
    for (const name of info.names) basesByName.set(name, pk);
    families.push({ arrFn, names: info.names, offset, arrayLen: arr.length, rotation: best.k, confidence: best.score });
  }
  if (!basesByName.size) return null;
  return { basesByName, families };
}

const dec = buildDecoders(code);

// Global one-liner alias table (name -> [defs]). Single-letter names are
// redefined per scope, so a name can have many defs; window-local defs take
// precedence and the global table is a fallback for uniquely-named chains.
function collectAliases(src) {
  const g = {};
  const re = /function\s+([A-Za-z_$]\w*)\(([^)]*)\)\{return\s+([A-Za-z_$]\w*)\(([^)]*)\)\}/g;
  let m;
  while ((m = re.exec(src)) !== null) (g[m[1]] ||= []).push({ params: m[2].split(","), target: m[3], cargs: m[4] });
  return g;
}

// resolve local one-liner alias decoders in a window, then evaluate an expression
function resolveExpr(expr, windowSrc, basesByName, globalAliases) {
  if (!basesByName || !basesByName.size) return null;
  // window-local defs win; fall back to the unique global chain otherwise.
  const locals = {};
  const re = /function\s+([A-Za-z_$]\w*)\(([^)]*)\)\{return\s+([A-Za-z_$]\w*)\(([^)]*)\)\}/g;
  let m;
  while ((m = re.exec(windowSrc)) !== null) locals[m[1]] = { params: m[2].split(","), target: m[3], cargs: m[4] };
  function lookup(name) {
    if (name in locals) return locals[name];
    const g = globalAliases && globalAliases[name];
    if (g && g.length === 1) return g[0]; // only trust unambiguous global chains
    return null;
  }
  function call(name, args, depth) {
    if (depth > 20) return null;
    const d = lookup(name);
    if (d) {
      const scope = {};
      d.params.forEach((p, i) => (scope[p.trim()] = args[i]));
      const resolved = d.cargs.split(",").map((a) => evalArg(a.trim(), scope));
      return call(d.target, resolved, depth + 1);
    }
    // base decoder: dispatch to the family that owns this name
    const pk = basesByName.get(name);
    if (!pk) return null;
    try { return pk(args[0], args[1]); } catch { return null; }
  }
  function evalArg(a, scope) {
    // numbers, simple arithmetic on scope vars, quoted strings
    if (/^"[^"]*"$/.test(a) || /^'[^']*'$/.test(a)) return a.slice(1, -1);
    let e = a;
    for (const k of Object.keys(scope)) e = e.replace(new RegExp("\\b" + k + "\\b", "g"), JSON.stringify(scope[k]));
    e = e.replace(/-\s*-/g, "+").replace(/1e3/g, "1000");
    try { return Function('"use strict";return (' + e + ")")(); } catch { return a; }
  }
  // evaluate expr: concatenation of NAME(args) and string literals
  try {
    const parts = expr.split("+").map((s) => s.trim());
    let out = "";
    for (const p of parts) {
      const cm = p.match(/^([A-Za-z_$]\w*)\(([^)]*)\)$/);
      if (cm) {
        const name = cm[1];
        const rawArgs = cm[2].length ? cm[2].split(",").map((x) => evalArg(x.trim(), {})) : [];
        const v = call(name, rawArgs, 0);
        if (v == null) return null;
        out += v;
      } else if (/^"[^"]*"$/.test(p) || /^'[^']*'$/.test(p)) {
        out += p.slice(1, -1);
      } else return null;
    }
    return out;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────
// 2. API endpoints + methods + payloads + headers
// ─────────────────────────────────────────────────────────────────────────
const METHODS = ["get", "post", "put", "patch", "delete"];

// read a balanced (…) or {…} / […] region starting at the opening bracket
function readBalanced(src, open, openCh, closeCh) {
  let depth = 0, inStr = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === "\\") i++; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === openCh) depth++;
    else if (c === closeCh) { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

function analyzeEndpoints(src, basesByName, globalAliases) {
  const has = basesByName && basesByName.size;
  const results = [];
  // find call openings:  IDENT[<methodExpr>](   or   IDENT.method(
  const openRe = /([A-Za-z_$]\w*)(?:\[([^\]]+)\]|\.(get|post|put|patch|delete))\(/g;
  let m;
  while ((m = openRe.exec(src)) !== null) {
    const inst = m[1];
    const methodExpr = m[2] || null;
    const literalMethod = m[3] || null;
    const parenStart = openRe.lastIndex - 1; // at "("
    const argsRegion = readBalanced(src, parenStart, "(", ")");
    if (!argsRegion) continue;
    const inner = argsRegion.slice(1, -1);
    // first argument must be a "/path" string literal
    const pm = inner.match(/^\s*"(\/[^"]*)"/);
    if (!pm) continue;
    const path = pm[1];
    const win = src.slice(Math.max(0, m.index - 1600), m.index + 400);

    // method
    let method = literalMethod;
    if (!method && has && methodExpr && /^[A-Za-z_$]\w*\(/.test(methodExpr))
      method = resolveExpr(methodExpr, win, basesByName, globalAliases);
    if (method) method = method.toUpperCase();
    if (method && !METHODS.includes(method.toLowerCase())) method = null;

    // second argument name (payload) if it's a bare identifier
    const afterPath = inner.slice(pm[0].length);
    const bodyM = afterPath.match(/^\s*,\s*([A-Za-z_$]\w*)\s*(,|$)/);
    const bodyArg = bodyM ? bodyM[1] : null;

    // headers: find a balanced headers:{...} anywhere in the args region
    const headers = [];
    const hIdx = inner.indexOf("headers:");
    if (hIdx !== -1) {
      const braceStart = inner.indexOf("{", hIdx);
      const hObj = braceStart !== -1 ? readBalanced(inner, braceStart, "{", "}") : null;
      if (hObj) {
        const hre = /"([^"]+)"\s*:\s*([^,}]+)/g;
        let h;
        while ((h = hre.exec(hObj)) !== null) {
          const hname = h[1];
          let hval = h[2].trim();
          const propm = hval.match(/^[A-Za-z_$]\w*\.([A-Za-z_$]\w*)$/);
          if (propm && has) {
            const defm = win.match(new RegExp(propm[1] + ":([^,}]+(?:\\+[^,}]+)*)"));
            const raw = defm && defm[1];
            if (raw) { const r = resolveExpr(raw.trim(), win, basesByName, globalAliases); if (r) hval = JSON.stringify(r) + " (resolved)"; }
          }
          headers.push({ name: hname, value: hval });
        }
      }
    }
    results.push({ instance: inst, method, path, payloadArg: bodyArg, headers });
  }
  // dedupe by method+path
  const seen = new Set();
  return results.filter((r) => { const k = r.method + " " + r.path; if (seen.has(k)) return false; seen.add(k); return true; });
}

// also plain fetch("...") and string-literal API paths
function analyzePlainPaths(src) {
  const set = new Set();
  const res = [
    /fetch\s*\(\s*["'`](https?:\/\/[^"'`]+|\/[^"'`]+)["'`]/g,
    /["'`](\/(?:api|v\d|auth|otp|file|slots|appointment|payment|profile|invoice|forgot-password|high-commissions)\/[^"'`]*)["'`]/g,
    /["'`](https?:\/\/[a-z0-9.-]+\/[^"'`\s]*)["'`]/gi,
  ];
  for (const re of res) { let m; while ((m = re.exec(src)) !== null) if (m[1].length < 200) set.add(m[1]); }
  return [...set].sort();
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Cipher / crypto routine detection
// ─────────────────────────────────────────────────────────────────────────
function analyzeCiphers(src) {
  const findings = [];
  // custom charset alphabets (used by shift/substitution ciphers)
  const alpha = /["'`]([0-9A-Za-z][0-9A-Za-z_\-+/=]{31,})["'`]/g;
  let m;
  const seen = new Set();
  while ((m = alpha.exec(src)) !== null) {
    const s = m[1];
    const uniq = new Set(s).size;
    if (uniq >= 32 && uniq === s.length && /[0-9]/.test(s) && /[a-z]/.test(s)) {
      if (!seen.has(s)) { seen.add(s); findings.push({ type: "charset-alphabet", value: s, length: s.length }); }
    }
  }
  if (/for\s*\([^)]*\)[^]{0,40}256[^]{0,120}charCodeAt[^]{0,120}\^/.test(src) || /o\[\(o\[r\]\+o\[i\]\)%256\]/.test(src))
    findings.push({ type: "RC4", note: "RC4-style keystream (256-byte S-box, XOR) detected" });
  if (/charCodeAt\([^)]*\)\s*\^\s*/.test(src)) findings.push({ type: "XOR", note: "XOR over charCodeAt detected" });
  if (/%\s*(?:64|len\w*|charset\.length|\w+\.length)\)/.test(src) && /charset|Charset|alphabet/i.test(src))
    findings.push({ type: "modular-shift", note: "modular index shift over a charset (Caesar/Vigenère-style) detected" });
  if (/atob\(|fromCharCode|toString\(16\)|decodeURIComponent/.test(src))
    findings.push({ type: "encoding", note: "base64 / hex / percent-encoding helpers present" });
  // header names that look like custom signing/meta
  const hdr = /["'`](x-[a-z0-9-]*(?:meta|sign|sig|token|nav|sec|key|hash)[a-z0-9-]*)["'`]/gi;
  const hset = new Set();
  while ((m = hdr.exec(src)) !== null) hset.add(m[1].toLowerCase());
  if (hset.size) findings.push({ type: "custom-headers", values: [...hset] });
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────
const globalAliases = collectAliases(code);
const endpoints = analyzeEndpoints(code, dec && dec.basesByName, globalAliases);
const plainPaths = analyzePlainPaths(code);
const ciphers = analyzeCiphers(code);

const report = {
  file,
  sizeKB: +(code.length / 1024).toFixed(1),
  decoder: dec ? { scheme: "obfuscator.io string-array + RC4", families: dec.families } : null,
  endpoints,
  otherPaths: plainPaths,
  ciphers,
};

if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

console.log(`\n=== bundle-analyzer ===`);
console.log(`file: ${file}  (${report.sizeKB} KB)`);
if (dec) {
  console.log(`decoder: obfuscator.io RC4 — ${dec.families.length} string-array family(ies):`);
  for (const f of dec.families) console.log(`   [${f.arrFn}] array=${f.arrayLen} offset=${f.offset} rotation=${f.rotation} confidence=${f.confidence.toFixed(2)} bases=${f.names.join(",")}`);
} else {
  console.log(`decoder: none (plaintext or unknown scheme)`);
}

console.log(`\n--- API ENDPOINTS (${endpoints.length}) ---`);
for (const e of endpoints) {
  console.log(`  ${(e.method || "?").padEnd(6)} ${e.path}`);
  if (e.payloadArg) console.log(`         payload arg: ${e.payloadArg}`);
  for (const h of e.headers) console.log(`         header: ${h.name}: ${h.value}`);
}

console.log(`\n--- OTHER PATHS / URLs (${plainPaths.length}) ---`);
for (const p of plainPaths) console.log(`  ${p}`);

console.log(`\n--- CIPHER / CRYPTO ---`);
for (const c of ciphers) {
  if (c.type === "charset-alphabet") console.log(`  charset (${c.length} chars): ${c.value}`);
  else if (c.type === "custom-headers") console.log(`  custom headers: ${c.values.join(", ")}`);
  else console.log(`  ${c.type}: ${c.note}`);
}
console.log("");
