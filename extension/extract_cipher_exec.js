#!/usr/bin/env node
// extract_cipher_exec.js — EXECUTION-BASED captcha-cipher secret extractor.
//
// Why this exists: heavy obfuscator.io bundles chain their string decoders through
// MANY duplicate-named wrappers and TWO+ interleaved string-arrays whose correct
// rotation is fixed at load-time by mutually-dependent shuffle IIFEs. A static
// rotation-search (nearest-by-position heuristic) mis-maps the decoders and fails.
//
// Instead of guessing, this tool RUNS the bundle's own decoder subsystem: it slices
// the contiguous decoder cluster around each `secret:` config, executes it (so every
// string-array is shuffled into place exactly as the browser does), exposes the base
// wrapper functions, then evaluates the secret concat with the config's own local
// wrappers. Output is the real key — byte-identical to what the site computes.
//
// Usage: node extract_cipher_exec.js <bundle.js>
'use strict';
const fs = require('fs');
const BUNDLE = process.argv[2];
if (!BUNDLE) { console.error('usage: node extract_cipher_exec.js <bundle.js>'); process.exit(1); }
const src = fs.readFileSync(BUNDLE, 'utf8');

// ---- brace / paren matchers ----
function mB(s, i, o, c) { let d = 0; for (; i < s.length; i++) { if (s[i] === o) d++; else if (s[i] === c) { d--; if (d === 0) return i; } } return -1; }
function braceObj(str, b) { let depth = 0, q = null; for (let j = b; j < str.length; j++) { const c = str[j]; if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; } if (c === '"' || c === "'" || c === '`') { q = c; continue; } if (c === '{') depth++; else if (c === '}') { if (--depth === 0) return j; } } return -1; }
function splitTopComma(s) { const parts = []; let depth = 0, q = null, cur = ''; for (let i = 0; i < s.length; i++) { const c = s[i]; if (q) { cur += c; if (c === '\\') { cur += s[++i] || ''; continue; } if (c === q) q = null; continue; } if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; } if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; } if (c === ')' || c === ']' || c === '}') { depth--; cur += c; continue; } if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; } cur += c; } if (cur.trim()) parts.push(cur); return parts; }
function cfgNum(expr) { let m = /["'`](-?\d+)["'`]/.exec(expr); if (m) return parseInt(m[1], 10); m = /(-?\d+)/.exec(expr); return m ? parseInt(m[1], 10) : NaN; }

// Run the contiguous decoder cluster around position P and expose every base wrapper
// function (aW/cW/rW/…) to a returned map. The cluster spans from the first base decoder
// (`function X(e,t){e-=N`) at/ before P back through a contiguous run, to a balanced end
// just past the last shuffle IIFE near P. Executing it shuffles all arrays into place.
function runDecoderCluster(P) {
    // span start: earliest base-decoder / array-getter in the contiguous block before P
    const decRe = /function [\w$]+\((?:e,t|e)\)\{e-=\d+/g;
    const arrRe = /function [\w$]+\(\)\{(?:const|var) e=\[/g;
    let starts = [];
    for (const m of src.matchAll(decRe)) starts.push(m.index);
    for (const m of src.matchAll(arrRe)) starts.push(m.index);
    starts = starts.filter(x => x < P).sort((a, b) => a - b);
    // take the contiguous cluster: walk back while gaps stay small (< 12k)
    let start = starts[starts.length - 1];
    for (let i = starts.length - 1; i > 0; i--) { if (starts[i] - starts[i - 1] < 12000) start = starts[i - 1]; else break; }
    // span end: last shuffle IIFE within +14k of P, balanced to brace 0
    const shs = [...src.matchAll(/for\(;;\)try\{if\(/g)].map(m => m.index).filter(x => x > start && x < P + 14000);
    const lastSh = shs.length ? shs[shs.length - 1] : P;
    let b = 0, q = null, endIdx = -1;
    for (let k = start; k < src.length; k++) { const c = src[k]; if (q) { if (c === '\\') { k++; continue; } if (c === q) q = null; continue; } if (c === '"' || c === "'" || c === '`') { q = c; continue; } if (c === '{') b++; else if (c === '}') b--; if (k >= lastSh && b === 0) { endIdx = k + 1; break; } }
    if (endIdx < 0) endIdx = Math.min(src.length, lastSh + 4000);
    const region = src.slice(start, endIdx);
    // expose every top-level wrapper/base name defined in the region
    const names = new Set();
    for (const m of region.matchAll(/function ([\w$]+)\((?:e,t|e)\)\{(?:return [\w$]+\(|e-=)/g)) names.add(m[1]);
    let exposer = '';
    for (const n of names) exposer += `try{globalThis.__D['${n}']=${n}}catch(e){}\n`;
    globalThis.__D = {};
    try { new Function("'use strict';\n" + region + '\n' + exposer)(); } catch (e) { /* app-side code may throw; decoders are already exposed */ }
    return globalThis.__D;
}

// collect the local wrapper defs the secret uses, hoisting-aware: for each NAME, pick the
// definition closest to P within the enclosing method window.
function localWrappers(P) {
    const win = src.slice(Math.max(0, P - 6000), P + 3000);
    const base = Math.max(0, P - 6000);
    const defs = {};
    for (const m of win.matchAll(/function ([\w$]+)\((?:e,t|e)\)\{return [\w$]+\([^{}]*\)\}/g)) {
        const nm = m[1], idx = base + m.index;
        if (!defs[nm] || Math.abs(idx - P) < Math.abs(defs[nm].idx - P)) defs[nm] = { idx, text: m[0] };
    }
    return defs;
}

function decodeSecret(secretExpr, P, decoders) {
    // gather every identifier called in the expr + transitively in the wrappers
    const wrappers = localWrappers(P);
    const need = new Set();
    const scan = (s) => { for (const m of s.matchAll(/([A-Za-z_$][\w$]*)\(/g)) need.add(m[1]); };
    scan(secretExpr);
    let changed = true;
    while (changed) { changed = false; const before = need.size; for (const n of [...need]) { if (wrappers[n]) scan(wrappers[n].text); } if (need.size > before) changed = true; }
    // build eval scope: expose needed decoder roots + local wrappers
    let decl = '';
    const args = [], vals = [];
    for (const n of need) { if (decoders[n] && !wrappers[n]) { args.push(n); vals.push(decoders[n]); } }
    for (const n of need) { if (wrappers[n]) decl += wrappers[n].text + '\n'; }
    const code = `const [${args.join(',')}]=arguments[0];\n${decl}\nreturn (${secretExpr});`;
    try { return new Function(code)(vals); } catch (e) { return null; }
}

// ---- main: find every secret: config, decode via execution ----
const found = [];
let idx = 0;
while ((idx = src.indexOf('secret:', idx)) !== -1) {
    const b = src.lastIndexOf('{', idx); const e = b >= 0 ? braceObj(src, b) : -1;
    if (b < 0 || e < 0) { idx += 7; continue; }
    const objStart = b, fields = splitTopComma(src.slice(b + 1, e)); idx = e + 1;
    const map = {};
    for (const f of fields) { const ci = f.indexOf(':'); if (ci < 0) continue; map[f.slice(0, ci).trim()] = f.slice(ci + 1).trim(); }
    if (!('secret' in map) || !('startAt' in map) || !('length' in map) || !('version' in map)) continue;
    const skip = cfgNum(map.startAt), len = cfgNum(map.length), version = cfgNum(map.version);
    if (isNaN(skip) || isNaN(len) || isNaN(version)) continue;   // not a real cipher config (false secret: match)
    const memberAccess = /^[A-Za-z_$][\w$]*\s*[.[]/.test(map.secret.trim());
    const decoders = runDecoderCluster(objStart);
    const secret = decodeSecret(map.secret, objStart, decoders);
    if (secret && /^[\x20-\x7e]+$/.test(secret) && !/\s/.test(secret) && secret.length >= 10) {
        found.push({ version, skip, len, secret, at: objStart });
    } else {
        console.log(`[warn] v${version} @${objStart}: decode failed${memberAccess ? ' (member-access secret — use the static extract_ciphers.js for this one)' : ''}`);
    }
}

console.log('=== extracted ciphers (execution-based) ===');
const seen = new Set();
for (const c of found) {
    const k = c.version + '|' + c.secret; if (seen.has(k)) continue; seen.add(k);
    console.log(`version=${c.version} skip=${c.skip} length=${c.len}`);
    console.log(`  key=${JSON.stringify(c.secret)}  (len ${c.secret.length})`);
}
if (!found.length) { console.log('  no direct-concat secret decoded (member-access bundles → use static extract_ciphers.js)'); process.exit(1); }
process.exit(0);
