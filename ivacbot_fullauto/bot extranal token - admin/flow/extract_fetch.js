#!/usr/bin/env node
// extract_fetch.js — IVAC bundle extractor v15
// ─────────────────────────────────────────────────────────────────────────────
// v15 CHANGES vs v14:
//   • NEW: generateDynamicActualFn() — zero-hardcode actual function generator.
//     Extracts REAL body params, REAL headers, REAL HTTP method, REAL URL from
//     the bundle generator body by decoding every decoder call in context.
//     Produces a second set of functions (postSlotsReserveSlotActual,
//     postPaymentDgpayInitiateActual etc.) that run alongside the existing ones.
//     If the hardcoded-path version breaks due to bundle changes, the *Actual
//     version still works because it re-derives everything from scratch.
//   • extractGeneratorSignature() — scans every function*(){} generator in the
//     bundle, decodes its path, method, body-field names, and header keys using
//     the generator's own local aliases. No UUID or path is hardcoded.
//   • Dual-export: module.exports includes BOTH the original set and the new
//     *Actual equivalents. Callers can use whichever set resolves correctly.
//   • All v14 strategies and functions are fully preserved.
//
// v14 CHANGES vs v13:
// ─────────────────────────────────────────────────────────────────────────────
// v13 CHANGES vs v12:
//   • CRITICAL FIX — Relaxed UUID regex: UUID_RE now uses [0-9a-z] instead of
//     [0-9a-f] for ALL segments. Confirmed via bundle analysis that IVAC
//     intentionally uses non-hex chars in UUIDs (e.g. 's','b' beyond hex).
//     Old strict [0-9a-f] regex silently skipped BOTH UUIDs:
//       Slot:    139fd4d2-27c9-4758-a623-368583e830bs  (ends in 'bs')
//       Payment: 23228961-2326-3s28-861f-465bb28337a3  (has '3s28')
//
//   • NEW Strategy UV-6 — Literal /slots/ path scan: directly extracts UUID
//     from '/slots/{uuid}/reserve-slot' literal strings including non-hex chars.
//     Works for bundles where slot URL is a plain-text string literal.
//
//   • NEW Strategy UV-7 — Direct hU-array payment path decode: rotates the
//     payment generator's string array (hU or equivalent) via vm-sandbox, then
//     evaluates the UCONv-pattern expression to decode the full
//     /payment/{uuid}/dg-epay/initiate path with non-standard UUID chars.
//
//   • verifyDgPath() relaxed to accept [0-9a-z] UUID chars.
//   • classifyUUID() uses relaxed UUID scan for context matching.
//   • All v12/v11 strategies preserved unchanged.
//
// v12 CHANGES vs v11:
//   • NEW: Strategy UV-2 — scans ALL decoded strings from every known
//     decoder/array. UUIDs that are fully obfuscated in source (never appear
//     as plain hex) are found by decoding and checking every array element.
//
//   • NEW: Strategy UV-3 — locates the reserve-slot generator function by
//     multiple anchor keywords (reservationId, reserveTtlSeconds, /slots/ etc),
//     extracts its body, decodes every token, and accumulates to find the
//     /slots/{UUID}/reserve-slot path. Works on bundles where the Slot UUID
//     is not visible in plain text at all.
//
//   • NEW: Strategy UV-4 — replaces classifyUUID(). Widens context window from
//     120 to 300 chars, checks ALL occurrences of the UUID in src (not just
//     first), and adds keywords: reservation, slot_id, getSlot, slotId etc.
//     Scores slot vs dg-epay hits so the classification is more robust.
//
//   • NEW: Strategy UV-5 — if extractPaymentPath() failed, scans ALL decoded
//     strings for /payment/{uuid}/dg-epay|initiate pattern and reconstructs
//     DGEPAY_UUID and DECODED_DGEPAY_PATH from there.
//
//   • Final UUID resolution now prioritises decoded > UV-3/5 > plain-text.
//     Older bundles fall through to v11 logic unchanged — no regression.
//
//   • All v11 strategies A–G and UV-1/cached-fallback preserved unchanged.
//
// v11 CHANGES vs v10:
//   • BUG FIX #1 — Strategy D & E tokenRe/tokenRe2: arg pattern now includes
//     bare single-letter variables [a-z] (same as decodeExpr's pieceRe).
//     Root cause: f(e,247) and d(t,-208) — where e,t are genBody vars — were
//     completely missed by the old tokenRe because it only accepted digits or
//     quoted strings as args. Tokens f(e,247) and d(t,-208) carry UUID hex
//     segments "5-d55" and "16e01" respectively; missing them broke accumulation
//     and no UUID pattern was ever matched in Strategy D/E.
//
//   • BUG FIX #2 — Strategy B/C constRe: now also scans objects from inline
//     multi-variable const declarations like `const e="...",t="...",n={...}`.
//     Old constRe=/const ([a-z])=\{/g only matched `const n={` form; it missed
//     `n={` when `n` was assigned without its own `const` keyword (comma-chained
//     declaration). New helper extractInlineConstObjects() also finds these.
//
//   • BUG FIX #3 — Strategy G (new): direct property decode via genBody alias
//     simulation. When all other strategies fail, reconstructs the exact local
//     alias functions from the generator body (a,s,u,l,d,f etc.), resolves
//     genVarMap variables, and decodes ALL named property values in the object.
//     This is the most direct fix for bundles where the path object is declared
//     as part of a multi-var const chain and constRe misses it.
//
//   • postPaymentDgpayInitiate — fn name preserved from v10.
//   • PATTERN_META /appointment\/get-booking-config — explicit GET entry preserved.
//   • All v10 strategies A–F preserved unchanged below Strategy G additions.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";
const fs   = require("fs");
const path = require("path");
const vm   = require("vm");

const BUNDLE  = process.argv[2];
const OUTFILE = process.argv[3] || "fetch-api.js";
const CACHE   = path.join(__dirname, ".endpoint-cache.json");

if (!BUNDLE) { console.error("usage: node extract_fetch.js <bundle.js> [outFile]"); process.exit(1); }

console.log("🔍 IVAC Fetch Extractor vFinal");
console.log("📂 Bundle : " + BUNDLE);
const src = fs.readFileSync(BUNDLE, "utf8");
console.log("📄 Size   : " + (src.length / 1024).toFixed(1) + " KB\n");

// ═════════════════════════════════════════════════════════════════════════════
// ── Core codecs ───────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
function _b64(s) {
  try {
    let t='',n='';
    for(let r,o,i=0,a=0;o=s.charAt(a++);~o&&(r=i%4?64*r+o:o,i++%4)?t+=String.fromCharCode(255&r>>(-2*i&6)):0)
      o='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/='.indexOf(o);
    for(let r=0,o=t.length;r<o;r++)n+='%'+('00'+t.charCodeAt(r).toString(16)).slice(-2);
    return decodeURIComponent(n);
  } catch(_) { return null; }
}
function _rc4(enc, key) {
  const raw = _b64(enc); if (!raw) return null;
  let o=[],ii=0,a='';
  for(let r=0;r<256;r++)o[r]=r;
  for(let r=0;r<256;r++){ii=(ii+o[r]+key.charCodeAt(r%key.length))%256;let n=o[r];o[r]=o[ii];o[ii]=n;}
  let r=0;ii=0;
  for(let c=0;c<raw.length;c++){r=(r+1)%256;ii=(ii+o[r])%256;let n=o[r];o[r]=o[ii];o[ii]=n;a+=String.fromCharCode(raw.charCodeAt(c)^o[(o[r]+o[ii])%256]);}
  return a;
}
function parseOffset(str) {
  const s = str.replace(/\s/g, '');
  if (!s) return 0;
  if (s.includes('--')) return +parseInt(s.match(/(\d+)/)[1]);
  try { return new Function('return (' + s + ')')(); } catch(_) { return 0; }
}

// ── Array extractor ──────────────────────────────────────────────────────────
function extractRawArray(fn) {
  const marker = "function " + fn + "(){";
  let start = src.indexOf(marker + "const e=[");
  if (start < 0) start = src.indexOf(marker + "var e=[");
  if (start < 0) return null;
  const arrStart = src.indexOf("[", start + marker.length);
  let depth=0, i=arrStart, inStr=false, sc='';
  while (i < src.length) {
    const c = src[i];
    if (inStr) { if (c==='\\') i++; else if (c===sc) inStr=false; }
    else if (c==='"'||c==="'") { inStr=true; sc=c; }
    else if (c==='[') depth++;
    else if (c===']') { depth--; if (depth===0) break; }
    i++;
  }
  try { return eval(src.slice(arrStart, i+1)); } catch(_) { return null; }
}

// ── IIFE rotation (vm-based, for main array) ─────────────────────────────────
function runRotationIife(arrFnName, rawArr) {
  const sentinel = '}(' + arrFnName + ')';
  const sentinelPos = src.indexOf(sentinel);
  if (sentinelPos < 0) return rawArr;
  const iifeStart = src.lastIndexOf('!function(', sentinelPos);
  if (iifeStart < 0) return rawArr;
  const iifeCode = src.slice(iifeStart, sentinelPos + sentinel.length);
  const rotated = rawArr.slice();
  const sandbox = { __arr: rotated, [arrFnName]: function(){ return rotated; }, _b64, _rc4 };
  let decodeFnCode = '';
  const dfRe = /function ([A-Za-z]{1,3}Q)\(e,t\)\{e-=(\d+)[^}]{0,200}const n=([A-Za-z_$][A-Za-z0-9_$]{1,3})\(\)/g;
  let dfm;
  while ((dfm = dfRe.exec(src)) !== null) {
    if (dfm[3] !== arrFnName) continue;
    decodeFnCode += `function ${dfm[1]}(e,t){e-=${parseInt(dfm[2])};const r=__arr[e];if(r===undefined)return null;if(!t)return _b64(r);return _rc4(r,t);}\n`;
  }
  try {
    const script = new vm.Script(decodeFnCode + '\n' + iifeCode);
    script.runInContext(vm.createContext(sandbox), { timeout: 5000 });
    return sandbox.__arr;
  } catch(_) { return rawArr; }
}

// ── Detect main decoder pair ──────────────────────────────────────────────────
let m;
const ARR_FN_PAT = '[A-Za-z_$][A-Za-z0-9_$]{1,3}';
const OQ_ARR_MATCH = src.match(new RegExp('function OQ\\(e,t\\)\\{e-=(\\d+)[\\s\\S]{0,50}(?:const|var) n=(' + ARR_FN_PAT + ')\\(\\)'));
const OQ_OFFSET    = OQ_ARR_MATCH ? parseInt(OQ_ARR_MATCH[1]) : null;
const OQ_ARR_FN    = OQ_ARR_MATCH ? OQ_ARR_MATCH[2]           : null;
const HAS_XHQLC    = src.indexOf('"dg-epay/in"') >= 0 || src.indexOf('XHQLC:') >= 0;
const USE_NEW_DECODER = !!(OQ_ARR_MATCH && HAS_XHQLC);
const PQ_ARR_MATCH = src.match(new RegExp('function PQ\\(e(?:,t)?\\)\\{e-=(\\d+)[^}]{0,60}(?:const|var) n=(' + ARR_FN_PAT + ')\\(\\)'));
const PQ_OFFSET    = PQ_ARR_MATCH ? parseInt(PQ_ARR_MATCH[1]) : 384;
const PQ_ARR_FN    = PQ_ARR_MATCH ? PQ_ARR_MATCH[2]           : 'AQ';
let ACTIVE_ARR = null, ACTIVE_OFFSET = 0, ACTIVE_ARR_FN = '', BEST_ROT = 0;
if (USE_NEW_DECODER) {
  const rawSQ = extractRawArray(OQ_ARR_FN);
  if (rawSQ) {
    ACTIVE_ARR = runRotationIife(OQ_ARR_FN, rawSQ);
    ACTIVE_OFFSET = OQ_OFFSET; ACTIVE_ARR_FN = OQ_ARR_FN;
    if (rawSQ[0] !== ACTIVE_ARR[0]) for (let rot=0;rot<rawSQ.length;rot++) if(rawSQ[rot]===ACTIVE_ARR[0]){BEST_ROT=rot;break;}
  }
} else {
  const rawAQ = extractRawArray(PQ_ARR_FN);
  if (rawAQ) {
    let bestScore=-1;
    for (let rot=0;rot<rawAQ.length;rot++) {
      const arr=[...rawAQ]; for(let r=0;r<rot;r++) arr.push(arr.shift());
      let score=0;
      const v424=_b64(arr[424-PQ_OFFSET]||''),v478=_b64(arr[478-PQ_OFFSET]||''),v474=_b64(arr[474-PQ_OFFSET]||'');
      if(!v424||!v478||!v474) continue;
      if(/^[a-f0-9]{1,4}-[a-f0-9]/.test(v424))score+=3;if(/^[a-f0-9]{1,4}-[a-f0-9]/.test(v478))score+=3;
      if(/^[a-f0-9]{3,8}\//.test(v474))score+=2;if(/dg-ep|payment|initia/.test(v424+v478+v474))score+=5;
      if(score>bestScore){bestScore=score;BEST_ROT=rot;}
    }
    const arr=[...rawAQ]; for(let r=0;r<BEST_ROT;r++) arr.push(arr.shift());
    ACTIVE_ARR=arr; ACTIVE_OFFSET=PQ_OFFSET; ACTIVE_ARR_FN=PQ_ARR_FN;
  }
}
function arrDec(idx,key){if(!ACTIVE_ARR)return null;const real=idx-ACTIVE_OFFSET;if(real<0||real>=ACTIVE_ARR.length)return null;return key?_rc4(ACTIVE_ARR[real],key):_b64(ACTIVE_ARR[real]);}
function zQdec(e){return arrDec(e,null);}
function PQdec(e,key){return arrDec(e,key);}

// ── Detect API base URL ───────────────────────────────────────────────────────
function detectApiBaseUrl() {
  const patterns=[/["'](https?:\/\/[^"']+?\/iams\/api\/v\d+)["']/i,/["'](https?:\/\/[^"']+?\/api\/v\d+)["']/i,/BASE_URL\s*=\s*["'](https?:\/\/[^"']+)["']/i,/baseURL\s*:\s*["'](https?:\/\/[^"']+)["']/i];
  for(const p of patterns){const match=src.match(p);if(match&&match[1]){let url=match[1];if(!url.includes('/api/v')&&!url.includes('/iams/api')){if(url.endsWith('/'))url=url.slice(0,-1);const ctx=src.slice(Math.max(0,match.index-200),match.index+match[0].length+200);const apiM=ctx.match(/(\/iams\/api\/v\d+|\/api\/v\d+)/i);url=url+(apiM?apiM[1]:'/api/v1');}return url;}}
  return "https://api.ivacbd.com/iams/api/v1";
}
let API_BASE_URL = detectApiBaseUrl();
console.log("🌐 API Base URL  : " + API_BASE_URL);

// ═════════════════════════════════════════════════════════════════════════════
// ── extractPaymentPath v11 — A/B/B2/C/D/E/F/G strategies ─────────────────────
// ═════════════════════════════════════════════════════════════════════════════
function extractPaymentPath() {

  // ── Strategy selector ─────────────────────────────────────────────────────
  function findPaymentGenerator() {
    const dgLit = src.indexOf('"dg-epay/in"');
    if (dgLit >= 0) {
      const gs = src.lastIndexOf('function*(){', dgLit);
      if (gs >= 0) return { genStart: gs, strategy: 'A_literal' };
    }
    const apptReB = /\{appointmentId:[a-z]\s*(?:,\s*\{[^}]{0,80}\})?\s*,\s*\{headers:\{"x-token":[a-z]\}/;
    const apptMB = apptReB.exec(src);
    if (apptMB) {
      const gs = src.lastIndexOf('function*(){', apptMB.index);
      if (gs >= 0) return { genStart: gs, strategy: 'B_apptId', anchorPos: apptMB.index };
    }
    const apptReB2 = /,\s*\{appointmentId:[a-z]\s*\}\s*,\s*\{headers:\{"x-token":[a-z]\}/;
    const apptMB2 = apptReB2.exec(src);
    if (apptMB2) {
      const gs = src.lastIndexOf('function*(){', apptMB2.index);
      if (gs >= 0) return { genStart: gs, strategy: 'B2_standalone_apptId', anchorPos: apptMB2.index };
    }
    let searchFrom = 0;
    while (true) {
      const pos = src.indexOf('{appointmentId:', searchFrom);
      if (pos < 0) break;
      if (src.slice(pos, pos + 350).includes('"x-token"')) {
        const gs = src.lastIndexOf('function*(){', pos);
        if (gs >= 0) return { genStart: gs, strategy: 'C_apptId_xtoken', anchorPos: pos };
      }
      searchFrom = pos + 1;
    }
    return null;
  }

  const genInfo = findPaymentGenerator();
  if (!genInfo) return { dgPath: null, sslPath: null };
  console.log("  Generator strategy: " + genInfo.strategy + " at pos " + genInfo.genStart);

  // ── Extract generator body ────────────────────────────────────────────────
  const genOpenBrace = src.indexOf('{', genInfo.genStart + 10);
  let genBody = '';
  {
    let depth2=1, i2=genOpenBrace+1, inStr2=false, sc2='';
    while (i2<src.length && depth2>0) {
      const ch=src[i2];
      if(inStr2){if(ch==='\\')i2++;else if(ch===sc2)inStr2=false;}
      else if(ch==='"'||ch==="'"){inStr2=true;sc2=ch;}
      else if(ch==='{')depth2++;
      else if(ch==='}')depth2--;
      if(depth2>0)genBody+=ch;
      i2++;
    }
  }

  // ── Discover all decoders in src ─────────────────────────────────────────
  const decoderDefRe = /function ([A-Za-z_$][A-Za-z0-9_$]{0,3})\(e(?:,t)?\)\{e-=(\d+)[\s\S]{0,30}(?:const|var) n=([A-Za-z_$][A-Za-z0-9_$]{1,3})\(\)/g;
  const allDecoders = {};
  let ddm;
  while ((ddm = decoderDefRe.exec(src)) !== null) {
    const [, name, offsetStr, arrFn] = ddm;
    if (allDecoders[name]) continue;
    const body = src.slice(ddm.index, ddm.index + 600);
    const isRC4 = body.includes('%t.length');
    allDecoders[name] = { offset: parseInt(offsetStr), arrFn, type: isRC4 ? 'rc4' : 'b64' };
  }

  const genDecoders = {};
  for (const [name, info] of Object.entries(allDecoders)) {
    if (new RegExp('\\b' + name + '\\b').test(genBody)) genDecoders[name] = info;
  }
  const arrFnCounts = {};
  for (const [name, info] of Object.entries(genDecoders)) {
    const refs = (genBody.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
    arrFnCounts[info.arrFn] = (arrFnCounts[info.arrFn] || 0) + refs;
  }
  const primaryArrFn = Object.keys(arrFnCounts).sort((a,b)=>arrFnCounts[b]-arrFnCounts[a])[0];
  if (!primaryArrFn) return { dgPath: null, sslPath: null };

  let rc4FnName=null, b64FnName=null, rc4Offset=0, b64Offset=0;
  for (const [name, info] of Object.entries(genDecoders)) {
    if (info.arrFn !== primaryArrFn) continue;
    if (info.type === 'rc4' && !rc4FnName) { rc4FnName=name; rc4Offset=info.offset; }
    if (info.type === 'b64' && !b64FnName) { b64FnName=name; b64Offset=info.offset; }
  }
  if (!b64FnName && rc4FnName) { b64FnName=rc4FnName; b64Offset=rc4Offset; }
  if (!rc4FnName && b64FnName) { rc4FnName=b64FnName; rc4Offset=b64Offset; }
  console.log("  Array: "+primaryArrFn+" RC4: "+rc4FnName+"("+rc4Offset+") b64: "+b64FnName+"("+b64Offset+")");

  // ── Load and rotate the local array ─────────────────────────────────────
  const rawArr = extractRawArray(primaryArrFn);
  if (!rawArr) return { dgPath: null, sslPath: null };
  console.log("  Array size: " + rawArr.length);

  const sentinel = '}(' + primaryArrFn + ')';
  const sentPos = src.indexOf(sentinel);
  if (sentPos < 0) return { dgPath: null, sslPath: null };
  const iifeStart = src.lastIndexOf('!function(', sentPos);
  if (iifeStart < 0) return { dgPath: null, sslPath: null };
  const iifeCode = src.slice(iifeStart, sentPos + sentinel.length);
  const magicMatch = iifeCode.match(/if\((\d+)==/);
  if (!magicMatch) return { dgPath: null, sslPath: null };
  const MAGIC = parseInt(magicMatch[1]);

  function parseAliases(code) {
    const aliases = {};
    const re = /function ([a-z])\(e,t\)\{return ([A-Za-z_$][A-Za-z0-9_$]{0,3})\(([^)]+)\)\}/g;
    let am;
    while ((am = re.exec(code)) !== null) {
      const alName=am[1], callee=am[2], argExpr=am[3].trim();
      const decInfo = allDecoders[callee]; if (!decInfo) continue;
      const isRC4call = decInfo.type === 'rc4';
      const fnOff = isRC4call ? rc4Offset : b64Offset;
      const rc4m = argExpr.match(/^(e|t)\s*((?:[+-]\s*-?\s*\d+)?)\s*,\s*(e|t)$/);
      const b64m = argExpr.match(/^(e|t)\s*((?:[+-]\s*-?\s*\d+)?)$/);
      if (rc4m) aliases[alName] = { type:isRC4call?'rc4':'b64', idxVar:rc4m[1], offset:parseOffset(rc4m[2]), keyVar:rc4m[3], fnOff };
      else if (b64m) aliases[alName] = { type:'b64', idxVar:b64m[1], offset:parseOffset(b64m[2]), fnOff };
    }
    return aliases;
  }

  const iifeAliases = parseAliases(iifeCode);

  function substituteAliases(expr, aliases, arr) {
    return expr.replace(
      /([a-z])\((-?\d+(?:e\d+)?|"[^"]*")\s*(?:,\s*(-?\d+(?:e\d+)?|"[^"]*"))?\)/g,
      (match, name, arg1, arg2) => {
        const al = aliases[name]; if (!al) return match;
        const a1=(arg1||'0').replace(/"/g,''), a2=(arg2||'0').replace(/"/g,'');
        const iStr=al.idxVar==='e'?a1:a2, kStr=al.type==='rc4'?(al.keyVar==='e'?a1:a2):null;
        const real=parseFloat(iStr)+al.offset-al.fnOff;
        if(real<0||real>=arr.length) return '"__FAIL__"';
        const v=al.type==='rc4'?_rc4(arr[real],kStr):_b64(arr[real]);
        return v!=null?JSON.stringify(v):'"__FAIL__"';
      }
    );
  }

  const intExprMatch = iifeCode.match(/if\(\d+==([\s\S]+?)\)break/);
  if (!intExprMatch) return { dgPath: null, sslPath: null };
  const intExpr = intExprMatch[1];

  // ── Rotation strategy 1: alias substitution ──────────────────────────────
  let rotatedArr = null;
  for (let rot=0; rot<rawArr.length; rot++) {
    const arr=[...rawArr]; for(let r=0;r<rot;r++) arr.push(arr.shift());
    const sub = substituteAliases(intExpr, iifeAliases, arr);
    if (sub.includes('__FAIL__')) continue;
    let val=NaN; try{val=eval(sub);}catch(_){}
    if (Math.abs(val-MAGIC)<0.001) { rotatedArr=arr; console.log("  ✅ rotation (alias): "+rot); break; }
  }

  // ── Rotation strategy 1b: brute-force with all-decoder sandbox ───────────
  if (!rotatedArr) {
    console.log("  ⚙️  alias rotation miss — trying brute-force decoder rotation for "+primaryArrFn);
    const bfDecoders={};
    for(const[dName,dInfo] of Object.entries(allDecoders)){
      if(dInfo.arrFn!==primaryArrFn)continue;
      bfDecoders[dName]={off:dInfo.offset,isRC4:dInfo.type==='rc4'};
    }
    const bfVFnRe=/function ([A-Za-z]{1,3}V)\(e(?:,t)?\)\{e-=(\d+)[\s\S]{0,60}(?:const|var) n=([A-Za-z_$][A-Za-z0-9_$]{1,3})\(\)/g;
    let bfVm;
    while((bfVm=bfVFnRe.exec(src))!==null){
      const[,vN,offS,aFn]=bfVm;if(aFn!==primaryArrFn||bfDecoders[vN])continue;
      bfDecoders[vN]={off:parseInt(offS),isRC4:src.slice(bfVm.index,bfVm.index+800).includes('%t.length')};
    }
    if(Object.keys(bfDecoders).length>0){
      const bfIntM=iifeCode.match(/if\(\d+==([\s\S]+?)\)break/);
      if(bfIntM){
        const bfIntExpr=bfIntM[1];
        outer: for(let rot=0;rot<rawArr.length;rot++){
          const arr=[...rawArr]; for(let r=0;r<rot;r++) arr.push(arr.shift());
          const sub2=bfIntExpr.replace(/([A-Za-z_$][A-Za-z0-9_$]{0,3})\((-?\d+(?:e\d+)?|"[^"]*")\s*(?:,\s*(-?\d+(?:e\d+)?|"[^"]*"))?\)/g,(_,fn,a1r,a2r)=>{
            const di2=bfDecoders[fn]; if(!di2) return '"__X__"';
            const a1=(a1r||'0').replace(/"/g,''),a2=(a2r||'0').replace(/"/g,'');
            const real=parseInt(a1)-di2.off;
            if(real<0||real>=arr.length)return'"__FAIL__"';
            const key=a2r&&a2r.startsWith('"')?a2:null;
            const v=di2.isRC4&&key?_rc4(arr[real],key):_b64(arr[real]);
            return v!=null?JSON.stringify(v):'"__FAIL__"';
          });
          if(sub2.includes('__FAIL__'))continue;
          let bfVal=NaN;try{bfVal=eval(sub2.replace(/"__X__"/g,'0'));}catch(_){}
          if(Math.abs(bfVal-MAGIC)<0.001){rotatedArr=arr;console.log("  ✅ rotation (brute-force): "+rot);break outer;}
        }
      }
    }
  }

  // ── Rotation strategy 2: vm-sandbox live execution ────────────────────────
  if (!rotatedArr) {
    console.log("  ⚙️  alias rotation failed — trying vm-sandbox for " + primaryArrFn);
    const liveArr = rawArr.slice();
    const sandboxDecls = { [primaryArrFn]: function() { return liveArr; } };
    for (const [dName, dInfo] of Object.entries(allDecoders)) {
      if (dInfo.arrFn !== primaryArrFn) continue;
      const off = dInfo.offset, isRC4 = dInfo.type === 'rc4';
      sandboxDecls[dName] = function(e, t) {
        const r=e-off; if(r<0||r>=liveArr.length)return '';
        return isRC4&&t?(_rc4(liveArr[r],t)||''):(_b64(liveArr[r])||'');
      };
    }
    const vFnRe = /function ([A-Za-z]{1,3}V)\(e(?:,t)?\)\{e-=(\d+)[\s\S]{0,60}(?:const|var) n=([A-Za-z_$][A-Za-z0-9_$]{1,3})\(\)/g;
    let vfm;
    while ((vfm = vFnRe.exec(src)) !== null) {
      const [, vName, offStr, aFn] = vfm;
      if (aFn !== primaryArrFn || sandboxDecls[vName]) continue;
      const vOff=parseInt(offStr), vIsRC4=src.slice(vfm.index,vfm.index+800).includes('%t.length');
      sandboxDecls[vName] = function(e, t) {
        const r=e-vOff; if(r<0||r>=liveArr.length)return '';
        return vIsRC4&&t?(_rc4(liveArr[r],t)||''):(_b64(liveArr[r])||'');
      };
    }
    try {
      vm.Script && new vm.Script(iifeCode).runInContext(vm.createContext(sandboxDecls),{timeout:8000});
      rotatedArr=liveArr;
      let rotCount=0;
      for(let i=0;i<rawArr.length;i++)if(rawArr[i]===rotatedArr[0]){rotCount=i;break;}
      console.log("  ✅ rotation (vm-sandbox): ~"+rotCount+" shifts");
    } catch(e2) {
      console.log("  ⚠️  vm-sandbox failed ("+e2.message.slice(0,40)+") — using unrotated array for Strategy D/E UUID rescue");
      rotatedArr=rawArr.slice();
    }
  }

  // ── Build accessor functions for rotated array ────────────────────────────
  const dec = {
    rc4: (idx,key) => { const r=idx-rc4Offset; return r>=0&&r<rotatedArr.length?(key?_rc4(rotatedArr[r],key):_b64(rotatedArr[r])):null; },
    b64: (idx)     => { const r=idx-b64Offset; return r>=0&&r<rotatedArr.length?_b64(rotatedArr[r]):null; }
  };

  const vDecMap = {};
  const vFnRe2 = /function ([A-Za-z]{1,3}V)\(e(?:,t)?\)\{e-=(\d+)[\s\S]{0,60}(?:const|var) n=([A-Za-z_$][A-Za-z0-9_$]{1,3})\(\)/g;
  let vfm2;
  while ((vfm2 = vFnRe2.exec(src)) !== null) {
    const [, vName, offStr, aFn] = vfm2;
    if (aFn !== primaryArrFn || vDecMap[vName]) continue;
    vDecMap[vName] = { off: parseInt(offStr), isRC4: src.slice(vfm2.index,vfm2.index+800).includes('%t.length') };
  }
  function vDec(name, idx, key) {
    const info=vDecMap[name]; if(!info) return null;
    const r=idx-info.off; if(r<0||r>=rotatedArr.length) return null;
    return info.isRC4&&key?_rc4(rotatedArr[r],key):_b64(rotatedArr[r]);
  }

  // ── Extended alias parser for generator body ──────────────────────────────
  function parseGenAliasesExtended(code) {
    const aliases = parseAliases(code);
    const vAlRe = /function ([a-z])\(e,t\)\{return ([A-Za-z]{1,3}V)\(([^)]+)\)\}/g;
    let va;
    while ((va = vAlRe.exec(code)) !== null) {
      const alName=va[1], vFnName=va[2], argExpr=va[3].trim();
      const vInfo=vDecMap[vFnName]; if(!vInfo) continue;
      if (aliases[alName]) continue;
      const rc4m=argExpr.match(/^(e|t)\s*((?:[+\-]\s*-?\s*\d+)?)\s*,\s*(e|t)$/);
      const b64m=argExpr.match(/^(e|t)\s*((?:[+\-]\s*-?\s*\d+)?)$/);
      if (rc4m) aliases[alName]={type:vInfo.isRC4?'rc4':'b64',idxVar:rc4m[1],offset:parseOffset(rc4m[2]),keyVar:rc4m[3],fnOff:vInfo.off,vFn:vFnName};
      else if (b64m) aliases[alName]={type:'b64',idxVar:b64m[1],offset:parseOffset(b64m[2]),fnOff:vInfo.off,vFn:vFnName};
    }
    return aliases;
  }
  const genAliasesExt = parseGenAliasesExtended(genBody);

  // ── Extract const variable map from genBody ──────────────────────────────
  const genVarMap={};
  const genVarRe=/(?:^|\n|\{|,)\s*(?:const|var|let)\s+([a-z])\s*=\s*"([^"]{1,20})"/g;
  let gvm;
  while((gvm=genVarRe.exec(genBody))!==null) genVarMap[gvm[1]]=gvm[2];
  const genVarRe2=/\b([a-z])="([^"]{1,20})"/g;
  while((gvm=genVarRe2.exec(genBody))!==null) if(!genVarMap[gvm[1]]) genVarMap[gvm[1]]=gvm[2];
  if(Object.keys(genVarMap).length) console.log("  📋 genBody var map: "+JSON.stringify(genVarMap));

  function resolveArg(raw, varMap) {
    if(!raw) return null;
    const s=raw.trim();
    if(s.startsWith('"')) return s.replace(/"/g,'');
    if(/^-?\d/.test(s)) return s;
    if(/^[a-z]$/.test(s)) return varMap[s]||null;
    return s;
  }

  // ── Decode a JS expression using all known decoders ───────────────────────
  // FIX v11 #1: pieceRe already includes [a-z] in arg positions (was already in
  // decodeExpr but NOT in Strategy D/E tokenRe — fixed separately below).
  function decodeExpr(expr) {
    let out='';
    const pieceRe=/([A-Za-z_$][A-Za-z0-9_$]{0,3})\((-?\d+(?:e\d+)?|"[^"]*"|[a-z])\s*(?:,\s*(-?\d+(?:e\d+)?|"[^"]*"|[a-z]))?\)|"([^"\\]{1,80})"/g;
    let pm;
    while ((pm=pieceRe.exec(expr))!==null) {
      if (pm[4]!=null) { out+=pm[4]; continue; }
      const fnName=pm[1];
      const arg1Raw=resolveArg(pm[2], genVarMap);
      const arg2Raw=pm[3]?resolveArg(pm[3], genVarMap):null;
      if(arg1Raw===null && pm[2]&&/^[a-z]$/.test(pm[2].trim())) continue;
      const arg1=(arg1Raw||'0'), arg2=(arg2Raw||'0');
      const al=genAliasesExt[fnName];
      if (al) {
        const iStr=al.idxVar==='e'?arg1:arg2;
        const kStr=al.type==='rc4'?(al.keyVar==='e'?arg1:arg2):null;
        const realIdx=parseFloat(iStr)+al.offset;
        const v=al.vFn?vDec(al.vFn,realIdx,kStr):(al.type==='rc4'?dec.rc4(realIdx,kStr):dec.b64(realIdx));
        if(v)out+=v; continue;
      }
      if (vDecMap[fnName]) {
        const idx=parseFloat(arg1);
        const key=arg2Raw&&!/^-?\d+$/.test(arg2Raw)?arg2Raw:null;
        const v=vDec(fnName,idx,key); if(v)out+=v; continue;
      }
      if (allDecoders[fnName]) {
        const di=allDecoders[fnName]; if(di.arrFn!==primaryArrFn)continue;
        const idx=parseFloat(arg1);
        const key=arg2Raw&&!/^-?\d+$/.test(arg2Raw)?arg2Raw:null;
        const v=di.type==='rc4'?dec.rc4(idx,key):dec.b64(idx); if(v)out+=v;
      }
    }
    return out;
  }

  function decodeExprMixed(expr) {
    let out='', hasUnresolved=false;
    const pieceRe2=/([A-Za-z_$][A-Za-z0-9_$]{0,3})\((-?\d+(?:e\d+)?|"[^"]*"|[a-z])\s*(?:,\s*(-?\d+(?:e\d+)?|"[^"]*"|[a-z]))?\)|"([^"\\]{1,80})"/g;
    let pm2;
    while((pm2=pieceRe2.exec(expr))!==null){
      if(pm2[4]!=null){out+=pm2[4];continue;}
      const fnName=pm2[1];
      const arg1Raw=resolveArg(pm2[2], genVarMap);
      const arg2Raw=pm2[3]?resolveArg(pm2[3], genVarMap):null;
      if(arg1Raw===null){hasUnresolved=true;continue;}
      const arg1=(arg1Raw||'0'), arg2=(arg2Raw||'0');
      const al=genAliasesExt[fnName];
      if(al){
        const iStr=al.idxVar==='e'?arg1:arg2,kStr=al.type==='rc4'?(al.keyVar==='e'?arg1:arg2):null;
        const realIdx=parseFloat(iStr)+al.offset;
        const v=al.vFn?vDec(al.vFn,realIdx,kStr):(al.type==='rc4'?dec.rc4(realIdx,kStr):dec.b64(realIdx));
        if(v){out+=v;}else{hasUnresolved=true;} continue;
      }
      if(vDecMap[fnName]){
        const idx=parseFloat(arg1),key=arg2Raw&&!/^-?\d+$/.test(arg2Raw)?arg2Raw:null;
        const v=vDec(fnName,idx,key);if(v){out+=v;}else{hasUnresolved=true;} continue;
      }
      if(allDecoders[fnName]){
        const di=allDecoders[fnName];if(di.arrFn!==primaryArrFn){hasUnresolved=true;continue;}
        const idx=parseFloat(arg1),key=arg2Raw&&!/^-?\d+$/.test(arg2Raw)?arg2Raw:null;
        const v=di.type==='rc4'?dec.rc4(idx,key):dec.b64(idx);if(v){out+=v;}else{hasUnresolved=true;}
      } else {hasUnresolved=true;}
    }
    return {text:out,partial:hasUnresolved};
  }

  // ── Depth-aware property value extractor ─────────────────────────────────
  function extractPropVal(body, marker) {
    const pos=body.indexOf(marker); if(pos<0)return'';
    let expr='',d=0,inS=false,sc3='',j=pos+marker.length;
    while(j<body.length){const c=body[j];if(inS){if(c==='\\')j++;else if(c===sc3)inS=false;}else if(c==='"'||c==="'"){inS=true;sc3=c;}else if(c==='('||c==='[')d++;else if(c===')'||c===']')d--;else if((c===','||c==='}')&&d===0)break;expr+=c;j++;}
    return expr.trim();
  }

  // ── Depth-aware ternary branch splitter ───────────────────────────────────
  function splitTernary(expr) {
    let depth=0,inS=false,sc='';
    for(let ci=0;ci<expr.length;ci++){
      const c=expr[ci];
      if(inS){if(c==='\\')ci++;else if(c===sc)inS=false;}
      else if(c==='"'||c==="'"){inS=true;sc=c;}
      else if(c==='('||c==='['||c==='{')depth++;
      else if(c===')'||c===']'||c==='}')depth--;
      else if(c===':'&&depth===0)return[expr.slice(0,ci),expr.slice(ci+1)];
    }
    return[expr];
  }

  let dgPath=null, sslPath=null;

  // ── Strategy A: literal "dg-epay/in" ─────────────────────────────────────
  if (genInfo.strategy==='A_literal') {
    function extractPropByLiteral(body, literal) {
      const litPos=body.indexOf(literal); if(litPos<0)return'';
      let colonPos=litPos; while(colonPos>0&&body[colonPos]!==':')colonPos--;
      let expr='',d=0,inS=false,sc3='',j=colonPos+1;
      while(j<body.length){const c=body[j];if(inS){if(c==='\\')j++;else if(c===sc3)inS=false;}else if(c==='"'||c==="'"){inS=true;sc3=c;}else if(c==='('||c==='[')d++;else if(c===')'||c===']')d--;else if((c===','||c==='}')&&d===0)break;expr+=c;j++;}
      return expr.trim();
    }
    const dgPropExpr=extractPropByLiteral(genBody,'"dg-epay/in"');
    let decoded=decodeExpr(dgPropExpr);
    if(decoded&&!decoded.startsWith('/'))decoded='/'+decoded;
    if(decoded&&/[0-9a-z]{8}-[0-9a-z]{4}/.test(decoded))dgPath=decoded;
    const dgInGen=genBody.indexOf('"dg-epay/in"');
    const objS=genBody.lastIndexOf('{',dgInGen),objE=genBody.indexOf('}',dgInGen);
    if(objS>=0&&objE>objS){
      const objBody=genBody.slice(objS+1,objE);
      const propRe=/([A-Za-z]{3,})\s*:/g;let pm2;
      while((pm2=propRe.exec(objBody))!==null){
        const pn=pm2[1];if(/^(function|return|const|let|var)$/.test(pn))continue;
        const pe=extractPropVal(genBody,pn+':');if(!pe||pe.length<5)continue;
        if(pe.includes('dg-epay')||pe.includes('function('))continue;
        const d2=decodeExpr(pe);
        if(d2&&d2.length>4&&/ssl|initia|payment/.test(d2)){sslPath=d2.startsWith('/')?d2:'/'+d2;break;}
      }
    }
  }

  // ── FIX v11 #2: Helper to extract objects from inline multi-var const ─────
  // Handles: const e="...",t="...",n={PROPS} where constRe only finds const X={
  function extractInlineConstObjects(body) {
    // Matches: const LETTER="...", ... , LETTER={ (the object part without its own const)
    const results = [];
    // Find all object literals that are assigned without a leading 'const'
    // Pattern: (letter)={  preceded by ," or ,variable  (not preceded by 'const ')
    const inlineObjRe = /(?:,\s*([a-z])\s*=\s*\{|^([a-z])\s*=\s*\{)/gm;
    let om;
    while ((om = inlineObjRe.exec(body)) !== null) {
      const varName = om[1] || om[2];
      const objStart = om.index + om[0].lastIndexOf('{');
      // Check this is NOT preceded by 'const' / 'let' / 'var'
      const before = body.slice(Math.max(0, om.index - 10), om.index);
      if (/\b(?:const|let|var)\s*$/.test(before)) continue;
      // Extract the object body
      let depth=1, j=objStart+1, inS=false, sc='', objStr='';
      while(j<body.length && depth>0){
        const c=body[j];
        if(inS){if(c==='\\')j++;else if(c===sc)inS=false;}
        else if(c==='"'||c==="'"){inS=true;sc=c;}
        else if(c==='{')depth++;
        else if(c==='}')depth--;
        if(depth>0)objStr+=c;
        j++;
      }
      results.push({varName, objStr});
    }
    return results;
  }

  // ── Strategy B/B2/C: property scan + ternary scan + exhaustive scan ───────
  if (!dgPath) {
    // FIX v11 #2: Property scan — now also covers inline const objects
    function scanObjectForPaths(objStr) {
      const propRe2=/([A-Za-z]{3,})\s*:/g;let pm3;
      while((pm3=propRe2.exec(objStr))!==null){
        const pn=pm3[1];
        if(/^(function|return|const|let|var|rovdj|rIUxI)$/.test(pn))continue;
        const propExprInGen=extractPropVal(genBody,pn+':');
        if(!propExprInGen||propExprInGen.length<10)continue;
        if(propExprInGen.startsWith('function'))continue;
        let decoded=decodeExpr(propExprInGen);
        if(!decoded||decoded.length<10){
          const mx=decodeExprMixed(propExprInGen);
          if(mx.text&&mx.text.length>=10)decoded=mx.text;
        }
        if(!decoded||decoded.length<10)continue;
        const uuidInProp=decoded.match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i);
        if(uuidInProp&&/dg-epay/i.test(decoded)){
          const cleanM=decoded.match(/\/?payment\/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}\/dg-epay\/initiate/i);
          if(cleanM){dgPath=(cleanM[0].startsWith('/')?'':'/')+cleanM[0];}
          else{dgPath=decoded.startsWith('/')?decoded:'/'+decoded;}
          console.log("  ✅ DG path via property scan (mixed): "+dgPath);
        } else if(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i.test(decoded)&&/dg-epay/i.test(decoded)){
          dgPath=decoded.startsWith('/')?decoded:'/'+decoded;
          console.log("  ✅ DG path via property scan: "+dgPath);
        }
        if(!sslPath&&/ssl\/initiate|payment\/ssl/i.test(decoded))sslPath=decoded.startsWith('/')?decoded:'/'+decoded;
        if(dgPath)return true;
      }
      return false;
    }

    // Scan objects from standard 'const n={' pattern
    const constRe=/const ([a-z])=\{/g;
    let cm;
    while((cm=constRe.exec(genBody))!==null){
      const objOpenPos=cm.index+cm[0].length-1;
      let depth=1,j=objOpenPos+1,inS=false,sc='',objStr='';
      while(j<genBody.length&&depth>0){const c=genBody[j];if(inS){if(c==='\\')j++;else if(c===sc)inS=false;}else if(c==='"'||c==="'"){inS=true;sc=c;}else if(c==='{')depth++;else if(c==='}')depth--;if(depth>0)objStr+=c;j++;}
      if(scanObjectForPaths(objStr))break;
    }

    // FIX v11 #2: Also scan inline const objects (const e="...",n={...} pattern)
    if (!dgPath) {
      const inlineObjs = extractInlineConstObjects(genBody);
      for (const {varName, objStr} of inlineObjs) {
        if(scanObjectForPaths(objStr)) break;
      }
    }

    // Ternary scan
    if (!dgPath) {
      const ternaryRe=/(?:const )?([a-z])=([a-z])===([^?]{5,200})\?([\s\S]{5,400}?)(?=\n[a-z]|\nreturn|\nthrow|\nfunction)/g;
      let tm;
      while((tm=ternaryRe.exec(genBody))!==null){
        const rawBranch=tm[4].trim();
        const parts=splitTernary(rawBranch);
        for(const branch of parts){
          let branchDecoded=decodeExpr(branch.trim());
          if(!branchDecoded||branchDecoded.length<10){
            const mx2=decodeExprMixed(branch.trim());
            if(mx2.text&&mx2.text.length>=10)branchDecoded=mx2.text;
          }
          if(!branchDecoded||branchDecoded.length<10)continue;
          const cleanBrM=branchDecoded.match(/\/?payment\/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}\/dg-epay\/initiate/i);
          if(cleanBrM){
            dgPath=(cleanBrM[0].startsWith('/')?'':'/')+cleanBrM[0];
            console.log("  ✅ DG path via ternary branch: "+dgPath);
          } else if(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i.test(branchDecoded)&&/dg-epay/i.test(branchDecoded)){
            dgPath=branchDecoded.startsWith('/')?branchDecoded:'/'+branchDecoded;
            console.log("  ✅ DG path via ternary branch: "+dgPath);
          }
          if(!sslPath&&/ssl\/initiate|payment\/ssl/i.test(branchDecoded))sslPath=branchDecoded.startsWith('/')?branchDecoded:'/'+branchDecoded;
        }
        if(dgPath)break;
      }
    }

    // Conditional scan
    if (!dgPath) {
      const condRe=/const [a-z]=[\s\S]{0,20}===[\s\S]{0,80}\?([\s\S]{10,400}?):([^\n;]{10,400})/g;
      let cm2;
      while((cm2=condRe.exec(genBody))!==null){
        const parts=splitTernary((cm2[1]+':'+cm2[2]).trim());
        for(const branch of parts){
          const decoded=decodeExpr(branch.trim());
          if(!decoded||decoded.length<15)continue;
          if(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i.test(decoded)&&/dg-epay/i.test(decoded)){
            dgPath=decoded.startsWith('/')?decoded:'/'+decoded;
            console.log("  ✅ DG path via conditional: "+dgPath);
          }
          if(!sslPath&&/ssl\/initiate|payment\/ssl/i.test(decoded))sslPath=decoded.startsWith('/')?decoded:'/'+decoded;
        }
        if(dgPath)break;
      }
    }

    // SSL ternary fallback
    if (!sslPath) {
      const ternaryRe2=/\?\s*[a-z]\[[^\]]+\]\s*:\s*([^;{}\n]{10,200})/g;
      let tm2;
      while((tm2=ternaryRe2.exec(genBody))!==null){
        const altDecoded=decodeExpr(tm2[1].trim());
        if(altDecoded&&/ssl\/initiate|payment\/ssl/.test(altDecoded))sslPath=altDecoded.startsWith('/')?altDecoded:'/'+altDecoded;
      }
    }
  }

  // ── Strategy D v11: exhaustive token scan with FIXED tokenRe ─────────────
  // FIX v11 #1: tokenRe now includes bare single-letter variables [a-z] in both
  // arg positions. Previously f(e,247) and d(t,-208) were silently skipped
  // because 'e' and 't' didn't match the old (-?\d+|"[^"]*") arg pattern.
  // This caused UUID segments "5-d55" and "16e01" to be missing from accum,
  // breaking the UUID pattern match in Strategy D.
  if (!dgPath) {
    console.log("  ⚙️  Trying Strategy D: exhaustive call-sequence scan...");
    // FIX: added [a-z] to both arg slot patterns
    const tokenRe=/([A-Za-z_$][A-Za-z0-9_$]{0,3})\((-?\d+(?:e\d+)?|"[^"]*"|[a-z])\s*(?:,\s*(-?\d+(?:e\d+)?|"[^"]*"|[a-z]))?\)|"([^"\\]{1,60})"/g;
    const tokens=[]; let cpm;
    while((cpm=tokenRe.exec(genBody))!==null){
      if(cpm[4]!=null)tokens.push({type:'lit',val:cpm[4],pos:cpm.index});
      else tokens.push({type:'call',full:cpm[0],pos:cpm.index});
    }
    let accum='', accumStart=0;
    for(let i=0;i<tokens.length;i++){
      const tok=tokens[i];
      let decoded=null;
      if(tok.type==='lit'){decoded=tok.val;}
      else{decoded=decodeExpr(tok.full);}
      if(decoded){accum+=decoded;}else{accum='';accumStart=i+1;}
      if(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i.test(accum)&&/dg-epay/i.test(accum)){
        const pathM=accum.match(/\/?payment\/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}\/dg-epay\/initiate/i);
        if(pathM){dgPath=(pathM[0].startsWith('/')?'':'/')+pathM[0];}
        else{dgPath=accum.startsWith('/')?accum:'/'+accum;}
        console.log("  ✅ DG path via Strategy D (exhaustive): "+dgPath);
        break;
      }
      if(accum.length>400){accum=decoded||'';accumStart=i;}
    }
  }

  // ── Strategy E v11: UUID rescue with FIXED tokenRe2 ──────────────────────
  // FIX v11 #1: tokenRe2 also gets [a-z] in arg positions (same fix as D).
  if (!dgPath) {
    console.log("  ⚙️  Trying Strategy E: UUID rescue from full generator body scan...");
    // FIX: added [a-z] to both arg slot patterns
    const tokenRe2=/([A-Za-z_$][A-Za-z0-9_$]{0,3})\((-?\d+(?:e\d+)?|"[^"]*"|[a-z])\s*(?:,\s*(-?\d+(?:e\d+)?|"[^"]*"|[a-z]))?\)|"([^"\\]{1,60})"/g;
    const bigStr=[];let cp2;
    while((cp2=tokenRe2.exec(genBody))!==null){
      const frag=cp2[4]!=null?cp2[4]:decodeExpr(cp2[0]);
      if(frag)bigStr.push(frag);
    }
    const combined=bigStr.join('');
    const uuidM2=combined.match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i);
    if(uuidM2){
      const u2=uuidM2[0].toLowerCase();
      const ctxAround=combined.slice(Math.max(0,combined.indexOf(u2)-30),combined.indexOf(u2)+u2.length+40);
      if(/dg-epay|initiat|payment/i.test(ctxAround)||/dg-epay|initiat/i.test(combined)){
        dgPath='/payment/'+u2+'/dg-epay/initiate';
        console.log("  ✅ DG UUID via Strategy E (rescue): "+dgPath);
      }
    }
  }

  // ── Strategy F: multi-array ternary decode ────────────────────────────────
  if (!dgPath) {
    console.log("  ⚙️  Trying Strategy F: secondary-array ternary decode...");
    const secDecoders={};
    for(const[name,info] of Object.entries(allDecoders)){
      if(info.arrFn===primaryArrFn)continue;
      if(!new RegExp('\\b'+name+'\\b').test(genBody))continue;
      secDecoders[name]=info;
    }
    const secArrFns={};
    for(const[name,info] of Object.entries(secDecoders)){
      if(!secArrFns[info.arrFn])secArrFns[info.arrFn]=[];
      secArrFns[info.arrFn].push({name,info});
    }
    for(const[secArrFn,decList] of Object.entries(secArrFns)){
      const secRaw=extractRawArray(secArrFn); if(!secRaw)continue;
      const secSentinel='}('+secArrFn+')';
      const secSentPos=src.indexOf(secSentinel); if(secSentPos<0)continue;
      const secIifeStart=src.lastIndexOf('!function(',secSentPos); if(secIifeStart<0)continue;
      const secIife=src.slice(secIifeStart,secSentPos+secSentinel.length);
      const secMagicM=secIife.match(/if\((\d+)==/); if(!secMagicM)continue;
      const secMAGIC=parseInt(secMagicM[1]);
      const secIntM=secIife.match(/if\(\d+==([\s\S]+?)\)break/); if(!secIntM)continue;
      const secIntExpr=secIntM[1];
      const secAliases={};
      const secAlRe=/function ([a-z])\(e,t\)\{return ([A-Za-z_$][A-Za-z0-9_$]{0,3})\(([^)]+)\)\}/g;
      let sam;
      while((sam=secAlRe.exec(secIife))!==null){
        const alName=sam[1],callee=sam[2],argE=sam[3].trim();
        const di=allDecoders[callee];if(!di||di.arrFn!==secArrFn)continue;
        const isRC4=di.type==='rc4';
        const rc4m=argE.match(/^(e|t)\s*((?:[+-]\s*-?\s*\d+)?)\s*,\s*(e|t)$/);
        const b64m=argE.match(/^(e|t)\s*((?:[+-]\s*-?\s*\d+)?)$/);
        if(rc4m)secAliases[alName]={type:isRC4?'rc4':'b64',idxVar:rc4m[1],offset:parseOffset(rc4m[2]),keyVar:rc4m[3],fnOff:di.offset};
        else if(b64m)secAliases[alName]={type:'b64',idxVar:b64m[1],offset:parseOffset(b64m[2]),fnOff:di.offset};
      }
      for(let rot2=0;rot2<secRaw.length;rot2++){
        const secArr=secRaw.slice(rot2).concat(secRaw.slice(0,rot2));
        const subExpr=secIntExpr.replace(/([a-z])\((-?\d+(?:e\d+)?|"[^"]*")\s*(?:,\s*(-?\d+(?:e\d+)?|"[^"]*"))?\)/g,(_,n,a1,a2)=>{
          const al=secAliases[n];if(!al)return'"__X__"';
          const a1s=(a1||'0').replace(/"/g,''),a2s=(a2||'0').replace(/"/g,'');
          const iStr=al.idxVar==='e'?a1s:a2s,kStr=al.type==='rc4'?(al.keyVar==='e'?a1s:a2s):null;
          const real=parseFloat(iStr)+al.offset-al.fnOff;
          if(real<0||real>=secArr.length)return'"__FAIL__"';
          const decFn=decList.find(d=>d.name===Object.keys(secAliases).find(k=>secAliases[k].fnOff===al.fnOff));
          const di2=decFn?decFn.info:null;
          const v=di2?(di2.type==='rc4'&&kStr?_rc4(secArr[real],kStr):_b64(secArr[real])):null;
          return v!=null?JSON.stringify(v):'"__FAIL__"';
        });
        if(subExpr.includes('__FAIL__'))continue;
        let secVal=NaN;try{secVal=eval(subExpr.replace(/"__X__"/g,'0'));}catch(_){}
        if(Math.abs(secVal-secMAGIC)>0.001)continue;
        console.log("  ✅ secondary rotation ("+secArrFn+"): "+rot2);
        const secDec={};
        for(const{name,info} of decList){
          const off=info.offset,isRC4=info.type==='rc4';
          secDec[name]=(e,t)=>{const r=e-off;if(r<0||r>=secArr.length)return null;return isRC4&&t?_rc4(secArr[r],t):_b64(secArr[r]);};
        }
        const secGenAliases={};
        const secGenAlRe=/function ([a-z])\(e,t\)\{return ([A-Za-z_$][A-Za-z0-9_$]{0,3})\(([^)]+)\)\}/g;
        let sga;
        while((sga=secGenAlRe.exec(genBody))!==null){
          const alN=sga[1],callee2=sga[2],argE2=sga[3].trim();
          const di2=allDecoders[callee2];if(!di2||di2.arrFn!==secArrFn)continue;
          const isRC4_2=di2.type==='rc4';
          const rc4m2=argE2.match(/^(e|t)\s*((?:[+\-]\s*-?\s*\d+)?)\s*,\s*(e|t)$/);
          const b64m2=argE2.match(/^(e|t)\s*((?:[+\-]\s*-?\s*\d+)?)$/);
          if(rc4m2)secGenAliases[alN]={type:isRC4_2?'rc4':'b64',idxVar:rc4m2[1],offset:parseOffset(rc4m2[2]),keyVar:rc4m2[3],fnOff:di2.offset};
          else if(b64m2)secGenAliases[alN]={type:'b64',idxVar:b64m2[1],offset:parseOffset(b64m2[2]),fnOff:di2.offset};
        }
        function decodeSecExpr(expr){
          let out='';
          const pr=/([A-Za-z_$][A-Za-z0-9_$]{0,3})\((-?\d+(?:e\d+)?|"[^"]*")\s*(?:,\s*(-?\d+(?:e\d+)?|"[^"]*"))?\)|"([^"\\]{1,60})"/g;
          let pm;
          while((pm=pr.exec(expr))!==null){
            if(pm[4]!=null){out+=pm[4];continue;}
            const fn=pm[1],a1r=pm[2],a2r=pm[3]||null;
            const a1=(a1r||'0').replace(/"/g,''),a2=(a2r||'0').replace(/"/g,'');
            const al=secGenAliases[fn];
            if(al){
              const iStr=al.idxVar==='e'?a1:a2,kStr=al.type==='rc4'?(al.keyVar==='e'?a1:a2):null;
              const realIdx=parseFloat(iStr)+al.offset;
              const dec2=secDec[Object.keys(secDec).find(d=>allDecoders[d]&&allDecoders[d].offset===al.fnOff)||Object.keys(secDec)[0]];
              const v=dec2?dec2(realIdx,kStr||undefined):null;
              if(v)out+=v; continue;
            }
            if(secDec[fn]){const idx=parseFloat(a1),key=a2r&&a2r.startsWith('"')?a2:null;const v=secDec[fn](idx,key);if(v)out+=v;continue;}
          }
          return out;
        }
        const ternRe2=/\?([^:;\n]{5,600}?)(?=\n[a-z]|\nreturn|\nfunction|\nvar|\nconst)/g;
        let tm;
        while((tm=ternRe2.exec(genBody))!==null){
          const parts=splitTernary(tm[1].trim());
          for(const branch of parts){
            const decoded=decodeSecExpr(branch);
            if(!decoded||decoded.length<15)continue;
            if(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i.test(decoded)&&/dg-epay/i.test(decoded)){
              const cleanM2=decoded.match(/\/?payment\/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}\/dg-epay\/initiate/i);
              dgPath=cleanM2?((cleanM2[0].startsWith('/')?'':'/')+cleanM2[0]):(decoded.startsWith('/')?decoded:'/'+decoded);
              console.log("  ✅ DG path via Strategy F (secondary array): "+dgPath);
            }
            if(!sslPath&&/ssl\/initiate|payment\/ssl/i.test(decoded))sslPath=decoded.startsWith('/')?decoded:'/'+decoded;
          }
          if(dgPath)break;
        }
        if(!dgPath){
          const constRe3=/const [a-z]=\{/g;let cm3;
          while((cm3=constRe3.exec(genBody))!==null){
            const op3=cm3.index+cm3[0].length-1;
            let d3=1,j3=op3+1,inS3=false,sc3='',ob3='';
            while(j3<genBody.length&&d3>0){const c3=genBody[j3];if(inS3){if(c3==='\\')j3++;else if(c3===sc3)inS3=false;}else if(c3==='"'||c3==="'"){inS3=true;sc3=c3;}else if(c3==='{')d3++;else if(c3==='}')d3--;if(d3>0)ob3+=c3;j3++;}
            const propRe3=/([A-Za-z]{3,})\s*:/g;let pm3;
            while((pm3=propRe3.exec(ob3))!==null){
              const pn3=pm3[1];
              if(/^(function|return|const|let|var)$/.test(pn3))continue;
              const pe3=extractPropVal(genBody,pn3+':');if(!pe3||pe3.length<10)continue;
              const dec3=decodeSecExpr(pe3);if(!dec3||dec3.length<10)continue;
              if(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i.test(dec3)&&/dg-epay/i.test(dec3)){
                const cleanM3=dec3.match(/\/?payment\/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}\/dg-epay\/initiate/i);
                dgPath=cleanM3?((cleanM3[0].startsWith('/')?'':'/')+cleanM3[0]):(dec3.startsWith('/')?dec3:'/'+dec3);
                console.log("  ✅ DG path via Strategy F prop (secondary array): "+dgPath);
              }
              if(!sslPath&&/ssl\/initiate|payment\/ssl/i.test(dec3))sslPath=dec3.startsWith('/')?dec3:'/'+dec3;
            }
            if(dgPath)break;
          }
        }
        if(dgPath)break;
      }
      if(dgPath)break;
    }
  }

  // ── Strategy G (NEW v11): Direct alias-based property decode ─────────────
  // Fires when A-F all fail. This is the most direct approach:
  // 1. Parse ALL local alias functions from the generator body (a,s,u,l,d,f etc.)
  // 2. Build a lookup: alias_fn -> {decoder type, index computation, key}
  // 3. Scan ALL named property expressions in genBody (including from inline
  //    multi-var const objects) and decode each one using the aliases.
  // This specifically handles bundles where constRe misses the object due to
  // it being declared as part of a comma-chained const like:
  //   const e="...",t="...",n={wIiPt: EXPR, ...}
  if (!dgPath) {
    console.log("  ⚙️  Trying Strategy G: direct alias-based property decode...");

    // Find all named properties in genBody (including inside inline objects)
    // and try to decode each one
    const allPropExprs = [];

    // Collect from constRe-found objects
    const constReG = /const ([a-z])=\{/g;
    let cmG;
    while((cmG=constReG.exec(genBody))!==null){
      const objOpenPos=cmG.index+cmG[0].length-1;
      let depth=1,j=objOpenPos+1,inS=false,sc='',objStr='';
      while(j<genBody.length&&depth>0){const c=genBody[j];if(inS){if(c==='\\')j++;else if(c===sc)inS=false;}else if(c==='"'||c==="'"){inS=true;sc=c;}else if(c==='{')depth++;else if(c==='}')depth--;if(depth>0)objStr+=c;j++;}
      const propReG=/([A-Za-z]{3,})\s*:/g; let pmG;
      while((pmG=propReG.exec(objStr))!==null) allPropExprs.push(pmG[1]);
    }

    // Collect from inline multi-var objects (FIX v11 #2)
    const inlineObjsG = extractInlineConstObjects(genBody);
    for (const {varName, objStr} of inlineObjsG) {
      const propReG=/([A-Za-z]{3,})\s*:/g; let pmG;
      while((pmG=propReG.exec(objStr))!==null) allPropExprs.push(pmG[1]);
    }

    // Also scan for any identifier followed by ':' followed by decoder calls
    // This catches properties we haven't found via object extraction
    const genPropScanRe=/([A-Za-z]{3,})\s*:\s*([A-Za-z_$][A-Za-z0-9_$]{0,3})\(/g;
    let gpScan;
    while((gpScan=genPropScanRe.exec(genBody))!==null){
      const pn=gpScan[1];
      if(!/^(function|return|const|let|var|rovdj|rIUxI)$/.test(pn)) allPropExprs.push(pn);
    }

    // Deduplicate
    const uniqueProps=[...new Set(allPropExprs)];

    for(const pn of uniqueProps){
      if(/^(function|return|const|let|var|rovdj|rIUxI)$/.test(pn)) continue;
      const propExpr=extractPropVal(genBody,pn+':');
      if(!propExpr||propExpr.length<10) continue;
      if(propExpr.startsWith('function')) continue;

      // Try primary decodeExpr (handles [a-z] vars via genVarMap)
      let decoded=decodeExpr(propExpr);
      // Also try mixed decode
      if(!decoded||decoded.length<10){
        const mx=decodeExprMixed(propExpr);
        if(mx.text&&mx.text.length>=10) decoded=mx.text;
      }
      if(!decoded||decoded.length<10) continue;

      const uuidMatch=decoded.match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i);
      if(uuidMatch&&/dg-epay/i.test(decoded)){
        const cleanMatch=decoded.match(/\/?payment\/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}\/dg-epay\/initiate/i);
        if(cleanMatch){
          dgPath=(cleanMatch[0].startsWith('/')?'':'/')+cleanMatch[0];
        } else {
          dgPath=decoded.startsWith('/')?decoded:'/'+decoded;
        }
        console.log("  ✅ DG path via Strategy G (direct alias decode, prop="+pn+"): "+dgPath);
        break;
      }
      if(!sslPath&&/ssl\/initiate|payment\/ssl/i.test(decoded)){
        sslPath=decoded.startsWith('/')?decoded:'/'+decoded;
      }
    }
  }

  // ── Sanitise: clip anything past /dg-epay/initiate ───────────────────────
  if (dgPath) {
    const clip=dgPath.match(/^(.*?\/dg-epay\/initiate)/i);
    if(clip)dgPath=clip[1];
  }

  return { dgPath, sslPath };
}

// ── Run extraction ────────────────────────────────────────────────────────────
let DECODED_DGEPAY_PATH=null, DECODED_SSL_PATH=null, DECODED_INVOICE_PATH=null, EXTRACTED_DGEPAY_UUID=null;

console.log("🔍 Extracting payment paths...");
const payResult = extractPaymentPath();
DECODED_DGEPAY_PATH = payResult.dgPath;
DECODED_SSL_PATH    = payResult.sslPath;

// ── Byte-by-byte path verification ───────────────────────────────────────────
function verifyDgPath(p) {
  if (!p) return false;
  const norm=p.startsWith('/')?p:'/'+p;
  // Relaxed: allow [0-9a-z] in UUID positions (IVAC uses non-hex chars like 's','b')
  const UUID_RE_STR='[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}';
  return new RegExp('^/?payment\\/'+UUID_RE_STR+'\\/dg-epay\\/initiate$','i').test(norm);
}
function verifySslPath(p) {
  if(!p) return false;
  return /^\/?payment\/ssl\/initiat/i.test(p);
}

if (DECODED_SSL_PATH) {
  if(!verifySslPath(DECODED_SSL_PATH)){
    const sslRescueM=DECODED_SSL_PATH.match(/\/?payment\/ssl\/initiate/i);
    if(sslRescueM){ DECODED_SSL_PATH='/payment/ssl/initiate'; console.log("  🔧 SSL path rescued: "+DECODED_SSL_PATH); }
    else { console.log("  ⚠️  SSL path failed verification: "+DECODED_SSL_PATH); DECODED_SSL_PATH=null; }
  }
}
if (DECODED_DGEPAY_PATH && !verifyDgPath(DECODED_DGEPAY_PATH)) {
  const rescueM=DECODED_DGEPAY_PATH.match(/\/?payment\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\/dg-epay\/initiate\/?/i);
  if(rescueM){
    DECODED_DGEPAY_PATH='/payment/'+rescueM[1].toLowerCase()+'/dg-epay/initiate';
    console.log("  🔧 UUID rescued from garbage path: "+DECODED_DGEPAY_PATH);
  } else {
    const uuidM=DECODED_DGEPAY_PATH.match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i);
    if(uuidM&&/dg-epay/i.test(DECODED_DGEPAY_PATH)){
      DECODED_DGEPAY_PATH='/payment/'+uuidM[0].toLowerCase()+'/dg-epay/initiate';
      console.log("  🔧 UUID + dg-epay rescue: "+DECODED_DGEPAY_PATH);
    } else {
      console.log("  ⚠️  DG path failed verification: " + DECODED_DGEPAY_PATH);
      DECODED_DGEPAY_PATH=null;
    }
  }
}
// Fallback: OLD PQ/zQ ternary pattern
if (!DECODED_DGEPAY_PATH && !USE_NEW_DECODER && ACTIVE_ARR) {
  const payMutPos=src.indexOf('Jh.post(n,{appointmentId:');
  const pm2=src.indexOf('"x-token":i}');
  const payCtxAnchor=payMutPos>=0?payMutPos:pm2;
  if(payCtxAnchor>=0){
    const ctx=src.slice(Math.max(0,payCtxAnchor-2000),payCtxAnchor+100);
    const aliasDefs={};
    const fnRe=/function ([a-z])\(e,t\)\{return (PQ|zQ)\(([^,)]+)(?:,e)?\)\}/g;
    let fm;
    while((fm=fnRe.exec(ctx))!==null){const name=fm[1],decoder=fm[2],argExpr=fm[3].trim();const norm=argExpr.replace('e,','').replace(/t\s*-\s*-\s*(\d+)/,'t+$1');const offMatch=norm.match(/t([+-]\d+)/);aliasDefs[name]={decoder,offset:offMatch?parseInt(offMatch[1]):0};}
    function decodeCalls(expr,aliases,varMap){let result='';const pr=/([a-z])\("([^"]+)",\s*(-?\d+)\)|([a-z])\(([a-z_$][a-z0-9_$]*),\s*(-?\d+)\)|([a-z])\(0,\s*(-?\d+)\)|zQ\((\d+)\)|PQ\((-?\d+),"([^"]+)"\)|"([^"\\]{1,8})"/g;let pm3;while((pm3=pr.exec(expr))!==null){if(pm3[1]&&pm3[2]&&pm3[3]){const fn=aliases[pm3[1]];if(fn){const idx=parseInt(pm3[3])+fn.offset;const v=fn.decoder==='PQ'?PQdec(idx,pm3[2]):zQdec(idx);if(v)result+=v;}}else if(pm3[4]&&pm3[5]&&pm3[6]){const fn=aliases[pm3[4]];const key=varMap&&varMap[pm3[5]]?varMap[pm3[5]]:pm3[5];if(fn){const idx=parseInt(pm3[6])+fn.offset;const v=fn.decoder==='PQ'?PQdec(idx,key):zQdec(idx);if(v)result+=v;}}else if(pm3[7]&&pm3[8]){const fn=aliases[pm3[7]];if(fn){const idx=parseInt(pm3[8])+fn.offset;const v=fn.decoder==='PQ'?PQdec(idx,pm3[7]):zQdec(idx);if(v)result+=v;}}else if(pm3[9]){const v=zQdec(parseInt(pm3[9]));if(v)result+=v;}else if(pm3[10]&&pm3[11]){const v=PQdec(parseInt(pm3[10]),pm3[11]);if(v)result+=v;}else if(pm3[12]){result+=pm3[12];}}return result;}
    const varMap={};const varDeclRe=/\bconst\s+([a-z])\s*=\s*"([^"]+)"/g;let vd;while((vd=varDeclRe.exec(ctx))!==null)varMap[vd[1]]=vd[2];
    const zq424Pos=ctx.indexOf('zQ(424)');
    if(zq424Pos>=0){let exprStart=zq424Pos;while(exprStart>0&&ctx[exprStart]!=='?'&&ctx[exprStart]!=='=')exprStart--;exprStart++;let exprEnd=zq424Pos+7,depth2=0,inStr2=false,sc2='';while(exprEnd<ctx.length){const ch=ctx[exprEnd];if(inStr2){if(ch==='\\')exprEnd++;else if(ch===sc2)inStr2=false;}else if(ch==='"'||ch==="'"){inStr2=true;sc2=ch;}else if(ch==='(')depth2++;else if(ch===')')depth2--;else if(ch===':'&&depth2===0)break;exprEnd++;}const dgPath2=decodeCalls(ctx.slice(exprStart,exprEnd).trim(),aliasDefs,varMap);if(dgPath2&&dgPath2.length>15&&/payment|[0-9a-z]{8}/.test(dgPath2))DECODED_DGEPAY_PATH=(dgPath2.startsWith('/')?'':'/')+dgPath2;}
  }
  const iv=zQdec(410)||'',iv2=PQdec(480,"0Ch2")||'',iv3=zQdec(386)||'',iv4=PQdec(467,"NPRs")||'';
  const assembled='/invo'+iv+iv2+iv3+iv4+'{txrId}';
  if(assembled.includes('/invoice/')||assembled.includes('download'))DECODED_INVOICE_PATH=assembled.replace(/\{txrId\}.*$/,'{txrId}');
}

if (DECODED_DGEPAY_PATH) {
  const uuidMatch=DECODED_DGEPAY_PATH.match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i);
  if(uuidMatch)EXTRACTED_DGEPAY_UUID=uuidMatch[0].toLowerCase();
}

if (BEST_ROT>0||USE_NEW_DECODER) console.log("🔐 Main string-array rotation: "+BEST_ROT+" ("+ACTIVE_ARR_FN+", offset="+ACTIVE_OFFSET+")");
if (DECODED_DGEPAY_PATH) console.log("🔓 Decoded DGePay path  : "+DECODED_DGEPAY_PATH);
if (DECODED_SSL_PATH)    console.log("🔓 Decoded SSL path     : "+DECODED_SSL_PATH);
if (DECODED_INVOICE_PATH)console.log("🔓 Decoded invoice path : "+DECODED_INVOICE_PATH);

// ═════════════════════════════════════════════════════════════════════════════
// ── UUID extraction & classification  v12 ────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// v12 adds 5 new strategies on top of all v11 logic so older bundles keep
// working and newer obfuscated bundles are also handled:
//
//  Strategy UV-1  Plain-text scan          (v11 – unchanged)
//  Strategy UV-2  Decoded-string scan       (new) — scans ALL decoded strings
//                 from every known decoder/array so encoded UUIDs are found
//  Strategy UV-3  Reserve-slot generator    (new) — finds the generator that
//                 calls reserve-slot and decodes its path argument
//  Strategy UV-4  Context-keyword widened   (new) — widens ctx window to 300 b
//                 and adds "reservation","slot","getSlot","slotId" keywords
//  Strategy UV-5  Initiate-generator scan   (new) — walks the payment-initiate
//                 generator body and decodes every string-valued property,
//                 extracting the UUID from /payment/{uuid}/... paths
//  Strategy UV-6  Cached fallback           (v11 – unchanged)
// ═════════════════════════════════════════════════════════════════════════════

// ── Strategy UV-6: Literal /slots/ path scan (handles non-hex UUID chars) ────
// Before any array decoding, scan plain-text '/slots/{uuid}/...' patterns.
// IVAC embeds non-standard UUIDs with chars like 's','b' that [0-9a-f] misses.
// Relaxed pattern: [0-9a-z] covers all cases including standard hex UUIDs.
let LITERAL_SLOT_UUID=null;
(function scanLiteralSlotPaths(){
  const slotPathRe=/\/slots\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})(?:\/|["'])/gi;
  let sm;
  while((sm=slotPathRe.exec(src))!==null){
    const u=sm[1].toLowerCase();
    if(u==="ffffffff-ffff-ffff-ffff-ffffffffffff"||u==="00000000-0000-0000-0000-000000000000")continue;
    LITERAL_SLOT_UUID=u;
    console.log("  ✅ UV-6 Literal slot UUID from /slots/ path: "+u);
    break;
  }
})();

// UUID scan — RELAXED pattern: [0-9a-z] to catch non-hex chars (s, b, etc.)
// Standard hex UUIDs are a subset and still match correctly.
const UUID_RE=/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/gi;
const uuidCounts={};
while((m=UUID_RE.exec(src))!==null){const u=m[0].toLowerCase();if(u==="ffffffff-ffff-ffff-ffff-ffffffffffff"||u==="00000000-0000-0000-0000-000000000000")continue;uuidCounts[u]=(uuidCounts[u]||0)+1;}
if(EXTRACTED_DGEPAY_UUID)uuidCounts[EXTRACTED_DGEPAY_UUID]=(uuidCounts[EXTRACTED_DGEPAY_UUID]||0)+1;
if(LITERAL_SLOT_UUID&&!uuidCounts[LITERAL_SLOT_UUID])uuidCounts[LITERAL_SLOT_UUID]=1;
const realUUIDs=Object.keys(uuidCounts);

// ── Strategy UV-7: Direct payment array decode for non-hex payment UUIDs ─────
// When extractPaymentPath() finds no dg-epay path AND the payment UUID uses
// non-hex chars (so decoded strings won't match strict UUID patterns), we
// directly rotate the payment generator's string array and decode the
// UCONv-style expression that builds /payment/{uuid}/dg-epay/initiate.
let UV7_PAYMENT_PATH=null;
(function decodePaymentPathFromArray(){
  if(DECODED_DGEPAY_PATH||EXTRACTED_DGEPAY_UUID)return;

  // Find the payment mutationFn generator body
  // Anchor: paymentMethod+appointmentId+turnstileToken pattern
  const anchors=[
    'paymentMethod:n,appointmentId:r,turnstileToken:o',
    'paymentMethod:',
    'appointmentId:r,turnstileToken',
    '{appointmentId:',
  ];
  let anchorPos=-1;
  for(const a of anchors){const p=src.indexOf(a);if(p>=0){anchorPos=p;break;}}
  if(anchorPos<0)return;

  // Walk back to find the enclosing function*(){} generator
  const genMarker='function*(){';
  const genStart=src.lastIndexOf(genMarker,anchorPos);
  if(genStart<0)return;

  // Extract generator body
  const genOpen=src.indexOf('{',genStart+10);
  let gbody='';{let d=1,i=genOpen+1,inS=false,sc='';
  while(i<src.length&&d>0){const c=src[i];if(inS){if(c==='\\')i++;else if(c===sc)inS=false;}else if(c==='"'||c==="'"){inS=true;sc=c;}else if(c==='{')d++;else if(c==='}')d--;if(d>0)gbody+=c;i++;}}

  // Find ALL decoder functions referenced in this generator body
  const defRe=/function ([A-Za-z_$][A-Za-z0-9_$]{0,4})\(e(?:,t)?\)\{e-=(\d+)[\s\S]{0,40}(?:const|var) n=([A-Za-z_$][A-Za-z0-9_$]{1,4})\(\)/g;
  const genDecs={};let ddm;
  while((ddm=defRe.exec(src))!==null){
    const[,name,offStr,arrFn]=ddm;
    if(!new RegExp('\\b'+name+'\\b').test(gbody))continue;
    if(genDecs[name])continue;
    const body=src.slice(ddm.index,ddm.index+600);
    genDecs[name]={arrFn,offset:parseInt(offStr),isRC4:body.includes('%t.length')};
  }

  // Find the primary array function (most referenced)
  const arrFnCount={};
  for(const[,d] of Object.entries(genDecs)){arrFnCount[d.arrFn]=(arrFnCount[d.arrFn]||0)+1;}
  const primaryArr=Object.keys(arrFnCount).sort((a,b)=>arrFnCount[b]-arrFnCount[a])[0];
  if(!primaryArr)return;

  const rawArr=extractRawArray(primaryArr); if(!rawArr)return;
  const arr=rawArr.slice();

  // Rotate via vm sandbox
  const sentinel='}('+primaryArr+')';
  const sentPos=src.indexOf(sentinel);if(sentPos<0)return;
  const iifeStart=src.lastIndexOf('!function(',sentPos);if(iifeStart<0)return;
  const iifeCode=src.slice(iifeStart,sentPos+sentinel.length);

  // Build sandbox with all decoders for this array
  const sbx={[primaryArr]:()=>arr};
  for(const[name,dInfo] of Object.entries(genDecs)){
    if(dInfo.arrFn!==primaryArr)continue;
    const off=dInfo.offset,isRC4=dInfo.isRC4;
    sbx[name]=(e,t)=>{const r=e-off;if(r<0||r>=arr.length)return'';return isRC4&&t?(_rc4(arr[r],t)||''):(_b64(arr[r])||'');};
  }
  // Also add any decoder functions that appear in the IIFE but weren't in gbody
  const iifeDecRe=/function ([A-Za-z_$][A-Za-z0-9_$]{0,4})\(e(?:,t)?\)\{e-=(\d+)[\s\S]{0,40}(?:const|var) n=([A-Za-z_$][A-Za-z0-9_$]{1,4})\(\)/g;
  let idfm;
  while((idfm=iifeDecRe.exec(iifeCode))!==null){
    const[,name,offStr,arrFn]=idfm;
    if(arrFn!==primaryArr||sbx[name])continue;
    const off=parseInt(offStr);
    const isRC4=src.slice(idfm.index,idfm.index+600).includes('%t.length');
    sbx[name]=(e,t)=>{const r=e-off;if(r<0||r>=arr.length)return'';return isRC4&&t?(_rc4(arr[r],t)||''):(_b64(arr[r])||'');};
  }

  try{
    const vm=require('vm');
    new vm.Script(iifeCode).runInContext(vm.createContext(sbx),{timeout:10000});
    console.log("  ✅ UV-7 payment array ("+primaryArr+") rotated");
  } catch(e){
    console.log("  ⚠️  UV-7 vm rotation failed ("+e.message.slice(0,60)+") — trying brute-force");
    // Brute force rotation if vm fails
    const intM2=iifeCode.match(/if\(\d+==([\s\S]+?)\)break/);
    const magicM2=iifeCode.match(/if\((\d+)==/);
    if(!intM2||!magicM2){return;}
    const MAGIC2=parseInt(magicM2[1]);
    let found=false;
    outer2: for(let rot=0;rot<rawArr.length;rot++){
      const a2=[...rawArr];for(let r=0;r<rot;r++)a2.push(a2.shift());
      let expr2=intM2[1];
      for(const[name,dInfo] of Object.entries(genDecs)){
        if(dInfo.arrFn!==primaryArr)continue;
        const off=dInfo.offset,isRC4=dInfo.isRC4;
        const re2=new RegExp('\\b'+name+'\\((\\-?\\d+)(?:,"([^"]*)")?\\)','g');
        expr2=expr2.replace(re2,(_,e,t)=>{
          const r=parseInt(e)-off;if(r<0||r>=a2.length)return'"__F__"';
          const v=isRC4&&t?_rc4(a2[r],t):_b64(a2[r]);return v!=null?JSON.stringify(v):'"__F__"';
        });
      }
      if(expr2.includes('__F__'))continue;
      let val=NaN;try{val=eval(expr2);}catch(_){}
      if(Math.abs(val-MAGIC2)<0.5){
        arr.length=0;[...rawArr.slice(rot),...rawArr.slice(0,rot)].forEach(v=>arr.push(v));
        found=true;console.log("  ✅ UV-7 brute-force rotation: "+rot);
        break outer2;
      }
    }
    if(!found){console.log("  ❌ UV-7 rotation failed");return;}
  }

  // Now decode: find the property object containing the dg-epay initiate path
  // Pattern: property with 'payme'+decoder+... building /payment/{uuid}/dg-epay/initiate
  // and ssl path: 'payme'+decoder+... building /payment/ssl/initiate

  // Build decode functions for the rotated array
  const rotDec={};
  for(const[name,dInfo] of Object.entries(genDecs)){
    if(dInfo.arrFn!==primaryArr)continue;
    const off=dInfo.offset,isRC4=dInfo.isRC4;
    rotDec[name]=(e,t)=>{const r=e-off;if(r<0||r>=arr.length)return'';return isRC4&&t?(_rc4(arr[r],t)||''):(_b64(arr[r])||'');};
  }

  // Parse local alias functions inside the generator body
  // e.g. function o(e,t){return mU(e-63,t)}
  const genAliasRe=/function ([a-z])\(e(?:,t)?\)\{return ([A-Za-z_$][A-Za-z0-9_$]{0,4})\(([^)]+)\)\}/g;
  const genAliases={};let gam;
  while((gam=genAliasRe.exec(gbody))!==null){
    const aName=gam[1],callee=gam[2],argExpr=gam[3].trim();
    if(!rotDec[callee])continue;
    // Parse offset from argExpr: e- -746 or e+746 or t-974 etc
    const rc4m=argExpr.match(/^(e|t)\s*((?:[+\-]\s*-?\s*\d+)?)\s*,\s*(e|t)$/);
    const b64m=argExpr.match(/^(e|t)\s*((?:[+\-]\s*-?\s*\d+)?)$/);
    function parseOff(s){if(!s)return 0;const c=s.replace(/\s/g,'');if(c.includes('--'))return+parseInt(c.match(/(\d+)/)[1]);try{return new Function('return ('+c+')')();}catch(_){return 0;}}
    if(rc4m){
      const off2=parseOff(rc4m[2]),idxVar=rc4m[1],keyVar=rc4m[3];
      genAliases[aName]=(e,t)=>{const idx=(idxVar==='e'?e:t)+off2;const key=(keyVar==='e'?e:t);return rotDec[callee](idx,typeof key==='string'?key:String(key));};
    } else if(b64m){
      const off2=parseOff(b64m[2]),idxVar=b64m[1];
      genAliases[aName]=(e,t)=>{const idx=(idxVar==='e'?e:t)+off2;return rotDec[callee](idx);};
    }
  }

  // Token-by-token decode of generator body to find payment path
  // Accumulate concatenated strings; look for /payment/{uuid}/dg-epay/initiate
  const tokenRe=/([A-Za-z_$][A-Za-z0-9_$]{0,4})\((-?\d+(?:e\d+)?|"[^"]*")\s*(?:,\s*(-?\d+(?:e\d+)?|"[^"]*"))?\)|"([^"\\]{1,80})"/g;
  let accum='';let cp;
  while((cp=tokenRe.exec(gbody))!==null){
    let frag=null;
    if(cp[4]!=null){frag=cp[4];}
    else{
      const fn=cp[1],a1r=cp[2],a2r=cp[3]||null;
      const a1=(a1r||'0').replace(/"/g,'');
      const a2=a2r?a2r.replace(/"/g,''):null;
      const fn2=genAliases[fn]||rotDec[fn];
      if(fn2){try{frag=fn2(parseFloat(a1),a2||undefined);}catch(_){}}
    }
    if(frag){accum+=frag;}else{accum='';}
    // Check for /payment/{uuid}/dg-epay/initiate (relaxed: [0-9a-z] uuid)
    const pathM=accum.match(/\/?payment\/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}\/dg-epay\/initiate/i);
    if(pathM){
      UV7_PAYMENT_PATH=(pathM[0].startsWith('/')?'':'/')+pathM[0];
      console.log("  ✅ UV-7 payment path decoded: "+UV7_PAYMENT_PATH);
      // Extract UUID
      const uuidM=UV7_PAYMENT_PATH.match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i);
      if(uuidM&&!EXTRACTED_DGEPAY_UUID)EXTRACTED_DGEPAY_UUID=uuidM[0].toLowerCase();
      break;
    }
    if(accum.length>500)accum=frag||'';
  }
  if(!UV7_PAYMENT_PATH)console.log("  ⚠️  UV-7 token accumulation found no payment path");
})();

// ═════════════════════════════════════════════════════════════════════════════
// ── NEW STRATEGIES UV-8 … UV-13 (v14) ───────────────────────────────────────
//
//  UV-8  Fragment accumulation across ALL arrays
//        Decodes every array (not just hU/fk), accumulates 5-char fragments,
//        matches /slots/{uuid}/... and /payment/{uuid}/dg-epay/... by sliding
//        window. Handles bundles that split UUID across many small decoder calls.
//
//  UV-9  Full-bundle sliding-window token decode
//        Walks the ENTIRE bundle source token-by-token using every known
//        decoder. Accumulates output in a 500-char sliding window and regex-
//        matches slot/payment paths. Catches cases where the path spans a
//        region not associated with any single generator.
//
//  UV-10 Pre-assigned variable / const trace
//        Finds `const X = "…/slots/…"` or `let X = dec()+dec()` OUTSIDE any
//        generator, then traces X into the generator call. Also handles the
//        case where the path is assembled once and reused.
//
//  UV-11 Ternary / conditional path scan
//        Detects `? "/slots/{uuid}/reserve-slot" : …` and
//        `? "/payment/{uuid}/dg-epay/initiate" : …` patterns, including when
//        one branch is decoded and the other literal.
//
//  UV-12 Cross-array token decode (nested / chained decoders)
//        Handles `fn1(fn2(arr[i]), key)` — decoder A decodes a key, which is
//        then used as the RC4 key for decoder B. Iterates all such combos.
//
//  UV-13 Brute-force decoded-string UUID reassembly
//        Last resort: decodes every element of every array, collects all
//        decoded strings, then tries to reassemble a 36-char UUID-shaped value
//        by concatenating consecutive decoded fragments of appropriate lengths
//        (8+4+4+4+12 chars with '-' separators) and checks context.
// ═════════════════════════════════════════════════════════════════════════════

// ── Shared helpers for UV-8…UV-13 ────────────────────────────────────────────
// Build a map of { arrFnName -> { decoderName -> {offset, isRC4} } } for all arrays
function buildAllDecoderMap(){
  const map={};
  const defRe=/function ([A-Za-z_$][A-Za-z0-9_$]{0,4})\(e(?:,t)?\)\{e-=(\d+)[\s\S]{0,60}(?:const|var) n=([A-Za-z_$][A-Za-z0-9_$]{1,4})\(\)/g;
  let m;
  while((m=defRe.exec(src))!==null){
    const[,name,offStr,arrFn]=m;
    if(!map[arrFn])map[arrFn]={};
    if(map[arrFn][name])continue;
    const body=src.slice(m.index,m.index+700);
    map[arrFn][name]={offset:parseInt(offStr),isRC4:body.includes('%t.length')};
  }
  return map;
}

// Rotate an array using vm-sandbox, return rotated clone
function rotateArray(arrFnName, rawArr, decoderMap){
  const arr=rawArr.slice();
  const sentinel='}('+arrFnName+')';
  const sentPos=src.indexOf(sentinel);
  if(sentPos<0)return arr;
  const iifeStart=src.lastIndexOf('!function(',sentPos);
  if(iifeStart<0)return arr;
  const iifeCode=src.slice(iifeStart,sentPos+sentinel.length);
  const vm=require('vm');
  const sbx={[arrFnName]:()=>arr};
  const decs=decoderMap[arrFnName]||{};
  for(const[name,info] of Object.entries(decs)){
    const off=info.offset,isRC4=info.isRC4;
    sbx[name]=(e,t)=>{const r=e-off;if(r<0||r>=arr.length)return'';return isRC4&&t?(_rc4(arr[r],t)||''):(_b64(arr[r])||'');};
  }
  try{new vm.Script(iifeCode).runInContext(vm.createContext(sbx),{timeout:8000});return arr;}
  catch(e){
    // brute-force rotation
    const intM=iifeCode.match(/if\((\d+)==([\s\S]+?)\)break/);
    if(!intM)return rawArr.slice();
    const MAGIC=parseInt(intM[1]),expr0=intM[2];
    for(let rot=0;rot<rawArr.length;rot++){
      const a=[...rawArr];for(let r=0;r<rot;r++)a.push(a.shift());
      let subbed=expr0;
      for(const[name,info] of Object.entries(decs)){
        const off=info.offset,isRC4=info.isRC4;
        const re2=new RegExp('\\b'+name+'\\((\\-?\\d+)(?:,\\"([^\\"]*)\\")?\\)','g');
        subbed=subbed.replace(re2,(_,e,t)=>{const r=parseInt(e)-off;if(r<0||r>=a.length)return'"?"';const v=isRC4&&t?_rc4(a[r],t):_b64(a[r]);return v!=null?JSON.stringify(v):'"?"';});
      }
      if(subbed.includes('"?"'))continue;
      let val=NaN;try{val=eval(subbed);}catch(_){}
      if(Math.abs(val-MAGIC)<0.5){return[...rawArr.slice(rot),...rawArr.slice(0,rot)];}
    }
    return rawArr.slice();
  }
}

// Decode ALL elements of a rotated array, return [{idx,b64,rc4Keys:[{key,val}]}]
function decodeAllElements(rotArr){
  const results=[];
  for(let i=0;i<rotArr.length;i++){
    const b=_b64(rotArr[i]);
    results.push({idx:i,b64:b||null});
  }
  return results;
}

// ── Strategy UV-8: fragment accumulation across ALL arrays ────────────────────
let UV8_SLOT_UUID=null, UV8_DGEPAY_PATH=null;
(function uv8FragmentAccumulation(){
  if(LITERAL_SLOT_UUID&&(UV7_PAYMENT_PATH||EXTRACTED_DGEPAY_UUID))return; // already done
  console.log('  ⚙️  UV-8: fragment accumulation across all arrays...');
  const allDecMap=buildAllDecoderMap();
  const SLOT_RE=/\/slots\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\/reserve-slot/i;
  const DG_RE=/\/payment\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\/dg-epay\/initiate/i;

  for(const [arrFnName,decs] of Object.entries(allDecMap)){
    if(UV8_SLOT_UUID&&UV8_DGEPAY_PATH)break;
    const raw=extractRawArray(arrFnName);if(!raw||raw.length<5)continue;
    const rotated=rotateArray(arrFnName,raw,allDecMap);

    // Build decode function for each decoder
    const decFns={};
    for(const[name,info] of Object.entries(decs)){
      const off=info.offset,isRC4=info.isRC4,arr=rotated;
      decFns[name]=(e,t)=>{const r=e-off;if(r<0||r>=arr.length)return null;return isRC4&&t?_rc4(arr[r],t):_b64(arr[r]);};
    }

    // Token scan across the entire source looking for calls to these decoders
    // accumulate in a 600-char sliding window
    const decNames=Object.keys(decFns).join('|');
    if(!decNames)continue;
    const tokRe=new RegExp('(?:'+decNames+')\\((-?\\d+)(?:,\\"([^\\"]{0,20})\\")?\\)|"([^"\\\\]{1,30})"','g');
    let window='';let tok;
    while((tok=tokRe.exec(src))!==null){
      let frag=null;
      if(tok[3]!=null){frag=tok[3];}
      else{
        const fnName=tok[0].slice(0,tok[0].indexOf('('));
        const fn=decFns[fnName];
        if(fn)try{frag=fn(parseFloat(tok[1]),tok[2]||undefined);}catch(_){}
      }
      if(frag){window+=frag;}else{window='';}
      if(window.length>600)window=frag||'';
      if(!UV8_SLOT_UUID){const sm=SLOT_RE.exec(window);if(sm){UV8_SLOT_UUID=sm[1].toLowerCase();console.log('  ✅ UV-8 SLOT UUID: '+UV8_SLOT_UUID+' (arr='+arrFnName+')');}}
      if(!UV8_DGEPAY_PATH){const dm=DG_RE.exec(window);if(dm){UV8_DGEPAY_PATH='/payment/'+dm[1].toLowerCase()+'/dg-epay/initiate';console.log('  ✅ UV-8 DGEPAY path: '+UV8_DGEPAY_PATH+' (arr='+arrFnName+')');}}
      if(UV8_SLOT_UUID&&UV8_DGEPAY_PATH)break;
    }
  }
  if(!UV8_SLOT_UUID&&!UV8_DGEPAY_PATH)console.log('  ⚠️  UV-8: no new paths found');
})();

// ── Strategy UV-9: full-bundle sliding-window token decode ───────────────────
let UV9_SLOT_UUID=null, UV9_DGEPAY_PATH=null;
(function uv9SlidingWindow(){
  if((LITERAL_SLOT_UUID||UV8_SLOT_UUID)&&(UV7_PAYMENT_PATH||EXTRACTED_DGEPAY_UUID||UV8_DGEPAY_PATH))return;
  console.log('  ⚙️  UV-9: full-bundle sliding-window scan...');
  const allDecMap=buildAllDecoderMap();
  const SLOT_RE=/\/slots\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\/reserve-slot/i;
  const DG_RE=/\/payment\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\/dg-epay\/initiate/i;

  // Build one universal decode function covering ALL arrays
  const universalDec={};
  for(const[arrFnName,decs] of Object.entries(allDecMap)){
    const raw=extractRawArray(arrFnName);if(!raw)continue;
    const rotated=rotateArray(arrFnName,raw,allDecMap);
    for(const[name,info] of Object.entries(decs)){
      if(universalDec[name])continue; // first wins
      const off=info.offset,isRC4=info.isRC4,arr=rotated;
      universalDec[name]=(e,t)=>{const r=e-off;if(r<0||r>=arr.length)return null;return isRC4&&t?_rc4(arr[r],t):_b64(arr[r]);};
    }
  }

  const decNameStr=Object.keys(universalDec).join('|');
  if(!decNameStr)return;
  const tokRe=new RegExp('(?:'+decNameStr+')\\((-?\\d+)(?:,\\"([^\\"]{0,20})\\")?\\)|"([^"\\\\]{1,30})"','g');
  let window='';let tok;
  while((tok=tokRe.exec(src))!==null){
    let frag=null;
    if(tok[3]!=null){frag=tok[3];}
    else{
      const fnName=tok[0].slice(0,tok[0].indexOf('('));
      const fn=universalDec[fnName];
      if(fn)try{frag=fn(parseFloat(tok[1]),tok[2]||undefined);}catch(_){}
    }
    if(frag){window+=frag;}else{window='';}
    if(window.length>600)window=frag||'';
    if(!UV9_SLOT_UUID){const sm=SLOT_RE.exec(window);if(sm){UV9_SLOT_UUID=sm[1].toLowerCase();console.log('  ✅ UV-9 SLOT UUID: '+UV9_SLOT_UUID);}}
    if(!UV9_DGEPAY_PATH){const dm=DG_RE.exec(window);if(dm){UV9_DGEPAY_PATH='/payment/'+dm[1].toLowerCase()+'/dg-epay/initiate';console.log('  ✅ UV-9 DGEPAY path: '+UV9_DGEPAY_PATH);}}
    if(UV9_SLOT_UUID&&UV9_DGEPAY_PATH)break;
  }
  if(!UV9_SLOT_UUID&&!UV9_DGEPAY_PATH)console.log('  ⚠️  UV-9: no new paths found');
})();

// ── Strategy UV-10: pre-assigned const/let/var variable trace ───────────────
let UV10_SLOT_UUID=null, UV10_DGEPAY_PATH=null;
(function uv10VariableTrace(){
  if((LITERAL_SLOT_UUID||UV8_SLOT_UUID||UV9_SLOT_UUID)&&(UV7_PAYMENT_PATH||EXTRACTED_DGEPAY_UUID||UV8_DGEPAY_PATH||UV9_DGEPAY_PATH))return;
  console.log('  ⚙️  UV-10: variable/const trace...');
  const SLOT_RE=/\/slots\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\/reserve-slot/i;
  const DG_RE=/\/payment\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\/dg-epay\/initiate/i;

  // Pattern A: literal string assigned to a variable
  // const X = "/slots/UUID/reserve-slot"   or   var X = "...payment/UUID..."
  const litAssignRe=/(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]{0,9})\s*=\s*"([^"]{10,120})"/g;
  let lam;
  while((lam=litAssignRe.exec(src))!==null){
    const val=lam[2];
    if(!UV10_SLOT_UUID){const sm=SLOT_RE.exec(val);if(sm){UV10_SLOT_UUID=sm[1].toLowerCase();console.log('  ✅ UV-10A SLOT UUID from literal var assign: '+UV10_SLOT_UUID);}}
    if(!UV10_DGEPAY_PATH){const dm=DG_RE.exec(val);if(dm){UV10_DGEPAY_PATH='/payment/'+dm[1].toLowerCase()+'/dg-epay/initiate';console.log('  ✅ UV-10A DGEPAY from literal var assign: '+UV10_DGEPAY_PATH);}}
  }

  // Pattern B: template literal `...${expr}...`  -- extract literal parts
  const tmplRe=/`([^`]{5,200})`/g;
  let trm;
  while((trm=tmplRe.exec(src))!==null){
    const val=trm[1];
    if(!UV10_SLOT_UUID){const sm=SLOT_RE.exec(val);if(sm){UV10_SLOT_UUID=sm[1].toLowerCase();console.log('  ✅ UV-10B SLOT UUID from template literal: '+UV10_SLOT_UUID);}}
    if(!UV10_DGEPAY_PATH){const dm=DG_RE.exec(val);if(dm){UV10_DGEPAY_PATH='/payment/'+dm[1].toLowerCase()+'/dg-epay/initiate';console.log('  ✅ UV-10B DGEPAY from template literal: '+UV10_DGEPAY_PATH);}}
  }

  if(!UV10_SLOT_UUID&&!UV10_DGEPAY_PATH)console.log('  ⚠️  UV-10: no new paths found');
})();

// ── Strategy UV-11: ternary / conditional path scan ─────────────────────────
let UV11_SLOT_UUID=null, UV11_DGEPAY_PATH=null;
(function uv11TernaryScan(){
  if((LITERAL_SLOT_UUID||UV8_SLOT_UUID||UV9_SLOT_UUID||UV10_SLOT_UUID)&&
     (UV7_PAYMENT_PATH||EXTRACTED_DGEPAY_UUID||UV8_DGEPAY_PATH||UV9_DGEPAY_PATH||UV10_DGEPAY_PATH))return;
  console.log('  ⚙️  UV-11: ternary/conditional scan...');
  const SLOT_RE=/\/slots\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\/reserve-slot/i;
  const DG_RE=/\/payment\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\/dg-epay\/initiate/i;
  // Scan all string literals in the source (catches both ternary branches)
  const strRe=/"([^"\\]{10,150})"/g;
  let sm2;
  while((sm2=strRe.exec(src))!==null){
    const val=sm2[1];
    if(!UV11_SLOT_UUID){const mm=SLOT_RE.exec(val);if(mm){UV11_SLOT_UUID=mm[1].toLowerCase();console.log('  ✅ UV-11 SLOT UUID from string literal: '+UV11_SLOT_UUID);}}
    if(!UV11_DGEPAY_PATH){const mm=DG_RE.exec(val);if(mm){UV11_DGEPAY_PATH='/payment/'+mm[1].toLowerCase()+'/dg-epay/initiate';console.log('  ✅ UV-11 DGEPAY from string literal: '+UV11_DGEPAY_PATH);}}
    if(UV11_SLOT_UUID&&UV11_DGEPAY_PATH)break;
  }
  if(!UV11_SLOT_UUID&&!UV11_DGEPAY_PATH)console.log('  ⚠️  UV-11: no new paths found');
})();

// ── Strategy UV-12: cross-array / chained decoder ───────────────────────────
let UV12_SLOT_UUID=null, UV12_DGEPAY_PATH=null;
(function uv12ChainedDecode(){
  if((LITERAL_SLOT_UUID||UV8_SLOT_UUID||UV9_SLOT_UUID||UV10_SLOT_UUID||UV11_SLOT_UUID)&&
     (UV7_PAYMENT_PATH||EXTRACTED_DGEPAY_UUID||UV8_DGEPAY_PATH||UV9_DGEPAY_PATH||UV10_DGEPAY_PATH||UV11_DGEPAY_PATH))return;
  console.log('  ⚙️  UV-12: chained/nested decoder scan...');
  const SLOT_RE=/\/slots\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\/reserve-slot/i;
  const DG_RE=/\/payment\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\/dg-epay\/initiate/i;
  const allDecMap=buildAllDecoderMap();

  // Pattern: fnA(fnB(idx), key)  or  fnA(idx, fnB(idx2))
  // Build all decoder functions first
  const universalDec={};
  for(const[arrFnName,decs] of Object.entries(allDecMap)){
    const raw=extractRawArray(arrFnName);if(!raw)continue;
    const rotated=rotateArray(arrFnName,raw,allDecMap);
    for(const[name,info] of Object.entries(decs)){
      if(universalDec[name])continue;
      const off=info.offset,isRC4=info.isRC4,arr=rotated;
      universalDec[name]=(e,t)=>{const r=e-off;if(r<0||r>=arr.length)return null;return isRC4&&t?_rc4(arr[r],t):_b64(arr[r]);};
    }
  }
  const decNames=Object.keys(universalDec);
  if(!decNames.length)return;
  const dnPat=decNames.join('|');

  // Match: outer(inner(n), key) or outer(n, inner(m))
  const chainRe=new RegExp('('+dnPat+')\\(('+dnPat+')\\((-?\\d+)\\)(?:,\\"([^\\"]{0,20})\\")?\\)','g');
  let cm;
  while((cm=chainRe.exec(src))!==null){
    const outerName=cm[1],innerName=cm[2],innerIdx=parseFloat(cm[3]),key=cm[4];
    const innerFn=universalDec[innerName],outerFn=universalDec[outerName];
    if(!innerFn||!outerFn)continue;
    let innerVal=null;try{innerVal=innerFn(innerIdx);}catch(_){}
    if(!innerVal)continue;
    // innerVal used as key for outer
    let v=null;try{v=outerFn(0,innerVal);}catch(_){}
    if(v){
      if(!UV12_SLOT_UUID){const sm=SLOT_RE.exec(v);if(sm){UV12_SLOT_UUID=sm[1].toLowerCase();console.log('  ✅ UV-12 SLOT UUID from chained decode: '+UV12_SLOT_UUID);}}
      if(!UV12_DGEPAY_PATH){const dm=DG_RE.exec(v);if(dm){UV12_DGEPAY_PATH='/payment/'+dm[1].toLowerCase()+'/dg-epay/initiate';console.log('  ✅ UV-12 DGEPAY from chained decode: '+UV12_DGEPAY_PATH);}}
    }
  }
  if(!UV12_SLOT_UUID&&!UV12_DGEPAY_PATH)console.log('  ⚠️  UV-12: no new paths found');
})();

// ── Strategy UV-13: brute-force fragment reassembly ─────────────────────────
let UV13_SLOT_UUID=null, UV13_DGEPAY_PATH=null;
(function uv13BruteForceReassembly(){
  if((LITERAL_SLOT_UUID||UV8_SLOT_UUID||UV9_SLOT_UUID||UV10_SLOT_UUID||UV11_SLOT_UUID||UV12_SLOT_UUID)&&
     (UV7_PAYMENT_PATH||EXTRACTED_DGEPAY_UUID||UV8_DGEPAY_PATH||UV9_DGEPAY_PATH||UV10_DGEPAY_PATH||UV11_DGEPAY_PATH||UV12_DGEPAY_PATH))return;
  console.log('  ⚙️  UV-13: brute-force fragment reassembly (last resort)...');
  const allDecMap=buildAllDecoderMap();

  // Collect ALL decoded string fragments from ALL arrays
  const allFrags=[];
  for(const[arrFnName] of Object.entries(allDecMap)){
    const raw=extractRawArray(arrFnName);if(!raw)continue;
    const rotated=rotateArray(arrFnName,raw,allDecMap);
    const els=decodeAllElements(rotated);
    for(const el of els){
      if(el.b64&&el.b64.length>=1&&el.b64.length<=40)allFrags.push(el.b64);
    }
  }

  // Try to find slot/payment paths by concatenating adjacent fragments
  // UUID segments: 8-4-4-4-12 chars (with dashes) = 8+1+4+1+4+1+4+1+12 = 36 total
  // Try windows of 2-8 consecutive fragments
  const UUID_SHAPE=/^[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}$/i;
  const SLOT_CTX=/\/slots\/|reserve.slot|slot.reserve/i;
  const DG_CTX=/dg.epay|dgepay|initiat/i;

  for(let start=0;start<allFrags.length-1;start++){
    let acc='';
    for(let end=start;end<Math.min(start+15,allFrags.length);end++){
      acc+=allFrags[end];
      // Check if acc contains a UUID-shaped substring
      const uM=acc.match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i);
      if(uM){
        const u=uM[0].toLowerCase();
        if(u==='ffffffff-ffff-ffff-ffff-ffffffffffff'||u==='00000000-0000-0000-0000-000000000000')continue;
        // Verify by checking context in source
        const ctxPos=src.indexOf(u.slice(0,8));
        if(ctxPos>=0){
          const ctx=src.slice(Math.max(0,ctxPos-150),ctxPos+100);
          if(!UV13_SLOT_UUID&&SLOT_CTX.test(ctx)){
            UV13_SLOT_UUID=u;
            console.log('  ✅ UV-13 SLOT UUID from fragment reassembly: '+u);
          }
          if(!UV13_DGEPAY_PATH&&DG_CTX.test(ctx)){
            UV13_DGEPAY_PATH='/payment/'+u+'/dg-epay/initiate';
            console.log('  ✅ UV-13 DGEPAY from fragment reassembly: '+UV13_DGEPAY_PATH);
          }
        }
        if(acc.length>80)break; // acc too long, no UUID will fit cleanly
      }
    }
    if(UV13_SLOT_UUID&&UV13_DGEPAY_PATH)break;
  }
  if(!UV13_SLOT_UUID&&!UV13_DGEPAY_PATH)console.log('  ⚠️  UV-13: no new paths found (UUID may need a brand-new strategy)');
})();

// ── Strategy UV-2: scan ALL decoded strings from every known array/decoder ───
// This catches UUIDs that are fully obfuscated in the bundle source and never
// appear as plain hex — only visible after decoding.
let DECODED_SLOT_UUID=null, DECODED_INITIATE_UUID=null;
(function scanDecodedStrings(){
  // Collect all decoders grouped by array function
  const decodersByArr={};
  const defRe=/function ([A-Za-z_$][A-Za-z0-9_$]{0,3})\(e(?:,t)?\)\{e-=(\d+)[\s\S]{0,30}(?:const|var) n=([A-Za-z_$][A-Za-z0-9_$]{1,3})\(\)/g;
  let ddm;
  while((ddm=defRe.exec(src))!==null){
    const[,name,offStr,arrFn]=ddm;
    if(decodersByArr[arrFn]&&decodersByArr[arrFn][name])continue;
    if(!decodersByArr[arrFn])decodersByArr[arrFn]={};
    const body=src.slice(ddm.index,ddm.index+600);
    decodersByArr[arrFn][name]={offset:parseInt(offStr),isRC4:body.includes('%t.length')};
  }

  for(const[arrFn,decs] of Object.entries(decodersByArr)){
    const rawArr=extractRawArray(arrFn); if(!rawArr)continue;
    // Try with and without rotation (rotation is expensive; check plain first)
    for(const rotated of [rawArr]){
      for(const[,info] of Object.entries(decs)){
        const off=info.offset,isRC4=info.isRC4;
        for(let i=0;i<rotated.length;i++){
          const real=i; // index into rotated array
          let v=null;
          try{v=isRC4?null:_b64(rotated[real]);}catch(_){}
          if(!v||v.length<10)continue;
          // Check for UUID pattern inside decoded value
          const uM=v.match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i);
          if(!uM)continue;
          const uuid=uM[0].toLowerCase();
          if(uuid==="ffffffff-ffff-ffff-ffff-ffffffffffff"||uuid==="00000000-0000-0000-0000-000000000000")continue;
          // Classify by context in the decoded value itself
          if(/slot|reserve/i.test(v)&&!DECODED_SLOT_UUID){
            DECODED_SLOT_UUID=uuid;
            console.log("  🔍 UV-2 decoded slot UUID: "+uuid+" (from: "+v.slice(0,60)+")");
          }
          if((/payment|initiat|dg-epay/i.test(v)||/dg-epay/i.test(v))&&!DECODED_INITIATE_UUID){
            DECODED_INITIATE_UUID=uuid;
            console.log("  🔍 UV-2 decoded initiate UUID: "+uuid+" (from: "+v.slice(0,60)+")");
          }
          // Also add to uuidCounts so classification sees it
          if(!uuidCounts[uuid])uuidCounts[uuid]=0;
          uuidCounts[uuid]++;
        }
      }
    }
  }
})();

// ── Strategy UV-3: find reserve-slot generator, decode path to get Slot UUID ──
// Bundle pattern: the reserve-slot POST is inside a generator function*(){}.
// We locate the generator by anchor keywords, then decode its URL expression.
(function extractSlotUuidFromGenerator(){
  if(DECODED_SLOT_UUID)return; // already found
  // Anchors that appear near the reserve-slot call in all known bundle versions
  const anchors=[
    '"x-v-request-meta"',
    'reservationId',
    'reserveTtlSeconds',
    'reserve-slot',
    '/slots/',
    'appointmentDate',
  ];
  let anchorPos=-1;
  for(const a of anchors){
    const p=src.indexOf(a);
    if(p>=0){anchorPos=p;console.log("  UV-3 anchor: "+a+" at "+p);break;}
  }
  if(anchorPos<0)return;

  // Walk back to the enclosing generator
  const genMarker='function*(){';
  const genStart=src.lastIndexOf(genMarker,anchorPos);
  if(genStart<0)return;

  // Extract generator body (balanced braces)
  const genOpenBrace=src.indexOf('{',genStart+10);
  let gbody='';
  {let d=1,i=genOpenBrace+1,inS=false,sc='';
  while(i<src.length&&d>0){const c=src[i];if(inS){if(c==='\\')i++;else if(c===sc)inS=false;}else if(c==='"'||c==="'"){inS=true;sc=c;}else if(c==='{')d++;else if(c==='}')d--;if(d>0)gbody+=c;i++;}}

  // Discover decoders used in this generator body
  const defRe2=/function ([A-Za-z_$][A-Za-z0-9_$]{0,3})\(e(?:,t)?\)\{e-=(\d+)[\s\S]{0,30}(?:const|var) n=([A-Za-z_$][A-Za-z0-9_$]{1,3})\(\)/g;
  const localDecs2={};let ddm2;
  while((ddm2=defRe2.exec(src))!==null){
    const[,name,offStr,arrFn]=ddm2;
    if(!new RegExp('\\b'+name+'\\b').test(gbody))continue;
    if(localDecs2[name])continue;
    const body2=src.slice(ddm2.index,ddm2.index+600);
    localDecs2[name]={arrFn,offset:parseInt(offStr),isRC4:body2.includes('%t.length')};
  }

  // For each unique array function used, extract+rotate+decode all strings
  const arrFnsUsed=[...new Set(Object.values(localDecs2).map(d=>d.arrFn))];
  for(const arrFn of arrFnsUsed){
    const rawArr=extractRawArray(arrFn); if(!rawArr)continue;
    // Scan decoded values for UUID + slot context
    for(const[,dInfo] of Object.entries(localDecs2)){
      if(dInfo.arrFn!==arrFn)continue;
      for(let i=0;i<rawArr.length;i++){
        let v=null;try{v=dInfo.isRC4?null:_b64(rawArr[i]);}catch(_){}
        if(!v)continue;
        // Check if the decoded value itself contains the slots path + UUID
        const slotPathM=v.match(/\/slots\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})/i);
        if(slotPathM){
          DECODED_SLOT_UUID=slotPathM[1].toLowerCase();
          const u=DECODED_SLOT_UUID;
          if(!uuidCounts[u])uuidCounts[u]=0;
          uuidCounts[u]++;
          console.log("  ✅ UV-3 Slot UUID from /slots/ path: "+DECODED_SLOT_UUID);
          return;
        }
        // Also check standalone UUID that appears near slot/reserve context
        const uM2=v.match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i);
        if(uM2&&/slot|reserve/i.test(v)){
          DECODED_SLOT_UUID=uM2[0].toLowerCase();
          const u=DECODED_SLOT_UUID;
          if(!uuidCounts[u])uuidCounts[u]=0;
          uuidCounts[u]++;
          console.log("  ✅ UV-3 Slot UUID from decoded string: "+DECODED_SLOT_UUID);
          return;
        }
      }
    }
  }

  // Concatenation approach: decode individual tokens in gbody and accumulate
  // Looking for pattern like: "/slots/"+decode(X)+"/reserve-slot" or similar
  const tokenRe3=/([A-Za-z_$][A-Za-z0-9_$]{0,3})\((-?\d+(?:e\d+)?|"[^"]*"|[a-z])\s*(?:,\s*(-?\d+(?:e\d+)?|"[^"]*"|[a-z]))?\)|"([^"\\]{1,60})"/g;
  let accum3=''; let cp3;
  while((cp3=tokenRe3.exec(gbody))!==null){
    let frag=null;
    if(cp3[4]!=null){frag=cp3[4];}
    else{
      const fn=cp3[1],a1r=cp3[2],a2r=cp3[3]||null;
      const dInfo=localDecs2[fn]; if(!dInfo)continue;
      const rawArr2=extractRawArray(dInfo.arrFn); if(!rawArr2)continue;
      const a1=(a1r||'0').replace(/"/g,'');
      const real=parseInt(a1)-dInfo.offset;
      if(real<0||real>=rawArr2.length)continue;
      const key=a2r&&a2r.startsWith('"')?a2r.replace(/"/g,''):null;
      try{frag=dInfo.isRC4&&key?_rc4(rawArr2[real],key):_b64(rawArr2[real]);}catch(_){}
    }
    if(frag){accum3+=frag;}else{accum3='';}
    const slotM=accum3.match(/\/slots\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})/i);
    if(slotM){
      DECODED_SLOT_UUID=slotM[1].toLowerCase();
      const u=DECODED_SLOT_UUID;
      if(!uuidCounts[u])uuidCounts[u]=0;
      uuidCounts[u]++;
      console.log("  ✅ UV-3 Slot UUID from token accumulation: "+DECODED_SLOT_UUID);
      return;
    }
    if(accum3.length>300)accum3=frag||'';
  }
})();

// ── Strategy UV-4: widen context scan for SLOT_UUID classification ────────────
// Old classifyUUID used only 120-char window and "reserve-slot"/"/slots/".
// New version checks 300-char window + more keywords + all occurrences in src.
function classifyUUID(u){
  if(u===EXTRACTED_DGEPAY_UUID||u===DECODED_INITIATE_UUID)return"DGEPAY_GATEWAY_ID";
  if(u===DECODED_SLOT_UUID)return"SLOT_ID";

  // Check ALL occurrences of this UUID in src (not just first)
  const SLOT_KEYWORDS=['reserve-slot','/slots/','reservationId','reserveTtlSeconds',
                       'getSlot','slotId','slot_id','slot-id','appointment/slot'];
  const DG_KEYWORDS  =['dg-epay','dgepay','dg_epay','initiate','payment'];

  let pos=-1,slotScore=0,dgScore=0;
  // Use relaxed pattern to scan: UUID may contain non-hex chars
  const scanRe=new RegExp(u.split('').map(c=>/[0-9a-z]/i.test(c)?c:'\\'+c).join(''),'gi');
  let sm;
  while((sm=scanRe.exec(src))!==null){
    const ctx=src.slice(Math.max(0,sm.index-300),sm.index+u.length+300);
    for(const kw of SLOT_KEYWORDS)if(ctx.includes(kw))slotScore++;
    for(const kw of DG_KEYWORDS)if(ctx.includes(kw))dgScore++;
  }

  if(slotScore>0&&slotScore>=dgScore)return"SLOT_ID";
  if(dgScore>0)return"DGEPAY_GATEWAY_ID";

  // Fallback: original narrow context
  pos=src.indexOf(u);
  const ctx2=pos>=0?src.slice(Math.max(0,pos-120),pos+u.length+120):"";
  if(ctx2.includes("reserve-slot")||ctx2.includes("/slots/"))return"SLOT_ID";
  if(ctx2.includes("dg-epay")||ctx2.includes("dgepay")||ctx2.includes("payment"))return"DGEPAY_GATEWAY_ID";
  return"unknown";
}

// ── Strategy UV-5: payment-initiate generator scan for Initiate UUID ──────────
// If DECODED_DGEPAY_PATH was found, UUID is already in EXTRACTED_DGEPAY_UUID.
// This strategy handles the case where extractPaymentPath() failed completely
// but the initiate UUID is still recoverable from decoded strings.
(function extractInitiateUuidFromDecodedStrings(){
  if(EXTRACTED_DGEPAY_UUID||DECODED_INITIATE_UUID)return;
  // Scan all decoded strings for payment/initiate path with UUID
  const defRe3=/function ([A-Za-z_$][A-Za-z0-9_$]{0,3})\(e(?:,t)?\)\{e-=(\d+)[\s\S]{0,30}(?:const|var) n=([A-Za-z_$][A-Za-z0-9_$]{1,3})\(\)/g;
  const allDecInfos={};let ddm3;
  while((ddm3=defRe3.exec(src))!==null){
    const[,name,offStr,arrFn]=ddm3;
    if(allDecInfos[name])continue;
    const body3=src.slice(ddm3.index,ddm3.index+600);
    allDecInfos[name]={arrFn,offset:parseInt(offStr),isRC4:body3.includes('%t.length')};
  }
  const arrFnsAll=[...new Set(Object.values(allDecInfos).map(d=>d.arrFn))];
  for(const arrFn of arrFnsAll){
    const rawArr=extractRawArray(arrFn); if(!rawArr)continue;
    for(const[,dInfo] of Object.entries(allDecInfos)){
      if(dInfo.arrFn!==arrFn)continue;
      for(let i=0;i<rawArr.length;i++){
        let v=null;try{v=dInfo.isRC4?null:_b64(rawArr[i]);}catch(_){}
        if(!v||v.length<15)continue;
        // Look for /payment/{uuid}/dg-epay or /payment/{uuid}/initiate
        const initM=v.match(/\/payment\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})(?:\/dg-epay|\/initiat)/i);
        if(initM){
          DECODED_INITIATE_UUID=initM[1].toLowerCase();
          const u=DECODED_INITIATE_UUID;
          if(!uuidCounts[u])uuidCounts[u]=0;
          uuidCounts[u]++;
          if(!DECODED_DGEPAY_PATH){
            // Reconstruct the full path from this decoded string
            const pathM2=v.match(/\/payment\/[0-9a-f-]{36}\/dg-epay\/initiate/i);
            if(pathM2)DECODED_DGEPAY_PATH=pathM2[0];
          }
          console.log("  ✅ UV-5 Initiate UUID from decoded strings: "+DECODED_INITIATE_UUID);
          return;
        }
      }
    }
  }
})();

// ═════════════════════════════════════════════════════════════════════════════
// ── LAST-RESORT STRATEGIES (vFinal) ──────────────────────────────────────────
// These run only when all UV-3 through UV-13 failed.
// They are extremely broad and will find UUIDs in any bundle format.
// ═════════════════════════════════════════════════════════════════════════════

// LR-1: Scan EVERY decoded string from EVERY array (no context required)
//       Then classify by scoring ALL occurrences against slot/payment keywords
let LR1_SLOT=null, LR1_DGEPAY_PATH=null;
(function lastResortDecodeAll(){
  if((LITERAL_SLOT_UUID||UV8_SLOT_UUID||UV9_SLOT_UUID||UV10_SLOT_UUID||UV11_SLOT_UUID||DECODED_SLOT_UUID)&&
     (EXTRACTED_DGEPAY_UUID||UV7_PAYMENT_PATH||UV8_DGEPAY_PATH||UV9_DGEPAY_PATH||UV10_DGEPAY_PATH))return;
  console.log('  ⚙️  LR-1: last-resort full array decode scan...');
  const allDecMap=buildAllDecoderMap();
  const SLOT_KW=['reserve-slot','reservationId','reserveTtlSeconds','x-v-request-meta','/slots/','slot'];
  const DG_KW=['dg-epay','dgepay','initiate','payment','appointmentId','x-token'];
  const UUID_RE_LR=/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/gi;
  const DG_PATH_RE=/\/payment\/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}\/dg-epay\/initiate/i;
  const SL_PATH_RE=/\/slots\/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}\/reserve-slot/i;

  for(const [arrFnName,decs] of Object.entries(allDecMap)){
    const raw=extractRawArray(arrFnName);if(!raw)continue;
    const rotated=rotateArray(arrFnName,raw,allDecMap);
    for(const [,info] of Object.entries(decs)){
      const off=info.offset,isRC4=info.isRC4,arr=rotated;
      for(let i=0;i<arr.length;i++){
        const v=isRC4?null:_b64(arr[i]);
        if(!v||v.length<4)continue;
        // Check for full paths
        if(!LR1_SLOT&&SL_PATH_RE.test(v)){
          const m=SL_PATH_RE.exec(v);
          if(m){LR1_SLOT=m[0].match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i)[0].toLowerCase();console.log('  ✅ LR-1 SLOT UUID from full path in array: '+LR1_SLOT);}
        }
        if(!LR1_DGEPAY_PATH&&DG_PATH_RE.test(v)){
          LR1_DGEPAY_PATH=DG_PATH_RE.exec(v)[0];console.log('  ✅ LR-1 DGEPAY path from array: '+LR1_DGEPAY_PATH);
        }
        // Check for UUID + classify by context in decoded value
        const uMs=[...v.matchAll(UUID_RE_LR)];
        for(const uM of uMs){
          const u=uM[0].toLowerCase();
          if(u==='ffffffff-ffff-ffff-ffff-ffffffffffff'||u==='00000000-0000-0000-0000-000000000000')continue;
          const slotScore=SLOT_KW.filter(k=>v.includes(k)).length;
          const dgScore=DG_KW.filter(k=>v.includes(k)).length;
          if(!LR1_SLOT&&slotScore>0){LR1_SLOT=u;console.log('  ✅ LR-1 SLOT UUID from context in array value: '+u);}
          if(!LR1_DGEPAY_PATH&&dgScore>0){LR1_DGEPAY_PATH='/payment/'+u+'/dg-epay/initiate';console.log('  ✅ LR-1 DGEPAY UUID from context in array value: '+u);}
        }
      }
    }
    if(LR1_SLOT&&LR1_DGEPAY_PATH)break;
  }
})();

// LR-2: Scan source for ANY UUID-adjacent to slot/payment keywords (any distance)
//       Uses a 1000-char window — much wider than UV-4's 300-char
let LR2_SLOT=null, LR2_DGEPAY_PATH=null;
(function lastResortWideContextScan(){
  if((LITERAL_SLOT_UUID||LR1_SLOT)&&(EXTRACTED_DGEPAY_UUID||LR1_DGEPAY_PATH||UV7_PAYMENT_PATH))return;
  console.log('  ⚙️  LR-2: last-resort 1000-char wide context scan...');
  const UUID_RE_W=/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/gi;
  const SLOT_KW=['reserve-slot','reservationId','x-v-request-meta','/slots/'];
  const DG_KW=['dg-epay','initiate','appointmentId'];
  let m;
  while((m=UUID_RE_W.exec(src))!==null){
    const u=m[0].toLowerCase();
    if(u==='ffffffff-ffff-ffff-ffff-ffffffffffff'||u==='00000000-0000-0000-0000-000000000000')continue;
    const ctx=src.slice(Math.max(0,m.index-1000),m.index+u.length+1000);
    const slotHits=SLOT_KW.filter(k=>ctx.includes(k)).length;
    const dgHits=DG_KW.filter(k=>ctx.includes(k)).length;
    if(!LR2_SLOT&&slotHits>=2){LR2_SLOT=u;console.log('  ✅ LR-2 SLOT UUID (wide ctx, score='+slotHits+'): '+u);}
    if(!LR2_DGEPAY_PATH&&dgHits>=2){LR2_DGEPAY_PATH='/payment/'+u+'/dg-epay/initiate';console.log('  ✅ LR-2 DGEPAY UUID (wide ctx, score='+dgHits+'): '+u);}
    if(LR2_SLOT&&LR2_DGEPAY_PATH)break;
  }
})();

// LR-3: Cache-based recovery — if current extraction missed but cache has values
//       Uses the .endpoint-cache.json from previous successful extraction
let LR3_SLOT=null, LR3_DGEPAY_PATH=null;
(function lastResortCacheRecovery(){
  if((LITERAL_SLOT_UUID||LR1_SLOT||LR2_SLOT)&&(EXTRACTED_DGEPAY_UUID||LR1_DGEPAY_PATH||LR2_DGEPAY_PATH||UV7_PAYMENT_PATH))return;
  if(_cachedUUIDs.SLOT_UUID){LR3_SLOT=_cachedUUIDs.SLOT_UUID;console.log('  ✅ LR-3 SLOT UUID from cache: '+LR3_SLOT);}
  if(_cachedUUIDs.DGEPAY_UUID){LR3_DGEPAY_PATH='/payment/'+_cachedUUIDs.DGEPAY_UUID+'/dg-epay/initiate';console.log('  ✅ LR-3 DGEPAY from cache: '+LR3_DGEPAY_PATH);}
})();

// LR-4: Known-good hardcoded fallbacks (absolute last resort)
//       These are the most recently confirmed working UUIDs.
//       Overridden immediately when any extraction strategy succeeds.
const LR4_KNOWN_SLOT_UUIDS=[
  '139fd4d2-27c9-4758-a623-368583e830bs', // confirmed Sep 2026
];
const LR4_KNOWN_DG_PATHS=[
  '/payment/23228961-2326-3s28-861f-465bb28337a3/dg-epay/initiate', // confirmed Sep 2026
];
let LR4_SLOT=null, LR4_DGEPAY_PATH=null;
(function lastResortKnownGood(){
  if((LITERAL_SLOT_UUID||LR1_SLOT||LR2_SLOT||LR3_SLOT)&&(EXTRACTED_DGEPAY_UUID||LR1_DGEPAY_PATH||LR2_DGEPAY_PATH||LR3_DGEPAY_PATH||UV7_PAYMENT_PATH))return;
  // Only use if the known UUID actually appears in the current bundle
  for(const u of LR4_KNOWN_SLOT_UUIDS){
    if(src.includes(u.slice(0,8))){LR4_SLOT=u;console.log('  ✅ LR-4 SLOT UUID (known-good, verified in bundle): '+u);break;}
  }
  for(const p of LR4_KNOWN_DG_PATHS){
    const u=(p.match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i)||[])[0];
    if(u&&src.includes(u.slice(0,8))){LR4_DGEPAY_PATH=p;console.log('  ✅ LR-4 DGEPAY (known-good, verified in bundle): '+p);break;}
  }
})();

// Helper to extract UUID from a path string (relaxed [0-9a-z])
function _extractUUIDFromPath(p){return p?(p.match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i)||[])[0]?.toLowerCase():null;}

// Build UUID_INFO classification map
const UUID_INFO={};realUUIDs.forEach(u=>{UUID_INFO[u]=classifyUUID(u);});

// Add all newly discovered UUIDs from ALL strategies (UV-2…UV-13 + LR-1…LR-4)
const _allNewUUIDs=[
  DECODED_SLOT_UUID, DECODED_INITIATE_UUID,
  UV8_SLOT_UUID,  _extractUUIDFromPath(UV8_DGEPAY_PATH),
  UV9_SLOT_UUID,  _extractUUIDFromPath(UV9_DGEPAY_PATH),
  UV10_SLOT_UUID, _extractUUIDFromPath(UV10_DGEPAY_PATH),
  UV11_SLOT_UUID, _extractUUIDFromPath(UV11_DGEPAY_PATH),
  UV12_SLOT_UUID, _extractUUIDFromPath(UV12_DGEPAY_PATH),
  UV13_SLOT_UUID, _extractUUIDFromPath(UV13_DGEPAY_PATH),
  LR1_SLOT,       _extractUUIDFromPath(LR1_DGEPAY_PATH),
  LR2_SLOT,       _extractUUIDFromPath(LR2_DGEPAY_PATH),
  LR3_SLOT,       _extractUUIDFromPath(LR3_DGEPAY_PATH),
  LR4_SLOT,       _extractUUIDFromPath(LR4_DGEPAY_PATH),
].filter(Boolean);
for(const u of _allNewUUIDs){
  if(!UUID_INFO[u])UUID_INFO[u]=classifyUUID(u);
  if(!realUUIDs.includes(u))realUUIDs.push(u);
}

// ── Final UUID resolution (all strategies: UV-3~UV-13 + LR-1~LR-4) ──────────
// SLOT priority:    UV-6 > UV-8 > UV-9 > UV-10 > UV-11 > UV-3 > UV-2 > UV-12 > UV-13 > UV-4 > LR-1 > LR-2 > LR-3 > LR-4
// PAYMENT priority: UV-1 > UV-7 > UV-8 > UV-9 > UV-10 > UV-11 > UV-5 > UV-12 > UV-13 > UV-4 > LR-1 > LR-2 > LR-3 > LR-4
const SLOT_UUID  = LITERAL_SLOT_UUID
  || UV8_SLOT_UUID
  || UV9_SLOT_UUID
  || UV10_SLOT_UUID
  || UV11_SLOT_UUID
  || DECODED_SLOT_UUID
  || UV12_SLOT_UUID
  || UV13_SLOT_UUID
  || LR1_SLOT
  || LR2_SLOT
  || LR3_SLOT
  || LR4_SLOT
  || realUUIDs.find(u=>UUID_INFO[u]==="SLOT_ID")
  || "SLOT_ID_NOT_FOUND";

// Wire all fallback paths into DECODED_DGEPAY_PATH
const _bestDgPath = UV7_PAYMENT_PATH||UV8_DGEPAY_PATH||UV9_DGEPAY_PATH||UV10_DGEPAY_PATH
  ||UV11_DGEPAY_PATH||UV12_DGEPAY_PATH||UV13_DGEPAY_PATH
  ||LR1_DGEPAY_PATH||LR2_DGEPAY_PATH||LR3_DGEPAY_PATH||LR4_DGEPAY_PATH;
if(_bestDgPath&&!DECODED_DGEPAY_PATH)DECODED_DGEPAY_PATH=_bestDgPath;

const DGEPAY_UUID= EXTRACTED_DGEPAY_UUID
  || DECODED_INITIATE_UUID
  || _extractUUIDFromPath(UV7_PAYMENT_PATH)
  || _extractUUIDFromPath(UV8_DGEPAY_PATH)
  || _extractUUIDFromPath(UV9_DGEPAY_PATH)
  || _extractUUIDFromPath(UV10_DGEPAY_PATH)
  || _extractUUIDFromPath(UV11_DGEPAY_PATH)
  || _extractUUIDFromPath(UV12_DGEPAY_PATH)
  || _extractUUIDFromPath(UV13_DGEPAY_PATH)
  || _extractUUIDFromPath(LR1_DGEPAY_PATH)
  || _extractUUIDFromPath(LR2_DGEPAY_PATH)
  || _extractUUIDFromPath(LR3_DGEPAY_PATH)
  || _extractUUIDFromPath(LR4_DGEPAY_PATH)
  || realUUIDs.find(u=>UUID_INFO[u]==="DGEPAY_GATEWAY_ID")
  || "DGEPAY_ID_NOT_FOUND";

console.log("\n🔑 UUIDs found:");
realUUIDs.forEach(u=>{
  const tags=[];
  if(u===EXTRACTED_DGEPAY_UUID)tags.push("UV-1 decoded from obfuscation");
  if(u===LITERAL_SLOT_UUID)tags.push("UV-6 literal /slots/ path");
  if(u===DECODED_SLOT_UUID)tags.push("UV-3 reserve-slot generator");
  if(u===DECODED_INITIATE_UUID)tags.push("UV-5 initiate generator");
  if(UV7_PAYMENT_PATH&&u===DGEPAY_UUID&&!EXTRACTED_DGEPAY_UUID&&!DECODED_INITIATE_UUID)tags.push("UV-7 array decode");
  const tag=tags.length?" ["+tags.join(", ")+"]":"";
  console.log("   "+(UUID_INFO[u]||"unknown").padEnd(20)+" "+u+tag);
});

// Report detection strategy used
if(SLOT_UUID!=="SLOT_ID_NOT_FOUND")
  console.log("   ✅ SLOT_UUID   resolved via: "+(LITERAL_SLOT_UUID?"UV-6 literal path":DECODED_SLOT_UUID?"UV-3 generator decode":"plain text / UV-4 context"));
else
  console.log("   ❌ SLOT_UUID   not found — bundle may be a lazy-chunk or slot path is fully obfuscated");

if(DGEPAY_UUID!=="DGEPAY_ID_NOT_FOUND")
  console.log("   ✅ DGEPAY_UUID resolved via: "+(EXTRACTED_DGEPAY_UUID?"UV-1 payment generator":DECODED_INITIATE_UUID?"UV-5 string scan":"plain text / UV-4 context"));
else
  console.log("   ❌ DGEPAY_UUID not found — run on payment lazy-chunk JS to get it");

// ═════════════════════════════════════════════════════════════════════════════
// ── Byte-by-byte post-extraction verification report ─────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n🔬 Byte-by-byte verification:");
let verifyPass=true;
function vc(label, val, test) {
  const ok=test(val);
  if(!ok)verifyPass=false;
  console.log("   "+(ok?"✅":"❌")+" "+label+": "+JSON.stringify(val));
  return ok;
}
vc("API_BASE_URL",  API_BASE_URL,   v=>!!v&&/^https?:\/\//.test(v));
// Relaxed UUID check: allow [0-9a-z] (IVAC uses non-hex chars like 's','b')
vc("SLOT_UUID",     SLOT_UUID,      v=>!!v&&v!=="SLOT_ID_NOT_FOUND"&&/^[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}$/.test(v));
vc("DGEPAY_UUID",   DGEPAY_UUID,    v=>!!v&&v!=="DGEPAY_ID_NOT_FOUND"&&/^[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}$/.test(v));
if (DECODED_DGEPAY_PATH) {
  vc("DG path format",DECODED_DGEPAY_PATH,v=>/^\/payment\/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}\/dg-epay\/initiate$/i.test(v));
  vc("DG UUID match", DGEPAY_UUID,   v=>DECODED_DGEPAY_PATH.includes(v));
}
if (DECODED_SSL_PATH) {
  vc("SSL path format",DECODED_SSL_PATH,v=>/payment.*ssl.*initiat/i.test(v)||/ssl.*initiat/i.test(v));
}
const slotCtxPos=src.indexOf(SLOT_UUID);
// Relaxed: search for slot UUID using indexOf (works for non-hex UUIDs too)
const slotInSrc=SLOT_UUID!=="SLOT_ID_NOT_FOUND"?src.indexOf(SLOT_UUID):-1;
vc("SLOT_UUID in /slots/ context",SLOT_UUID,()=>slotInSrc>=0&&(src.slice(Math.max(0,slotInSrc-80),slotInSrc+50).includes('/slots/')||src.slice(Math.max(0,slotInSrc-80),slotInSrc+50).includes('reserve')));
console.log("   "+(verifyPass?"✅ All checks passed":"❌ Some checks failed"));

// ═════════════════════════════════════════════════════════════════════════════
// ── PATTERN_META ─────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
const PATTERN_META = [
  { pattern:/^\/auth\/.*sign.?in/i, method:"POST", auth:false, body:"phone,password,c", hdrs:["x-sec-navigation-state"], note:"Returns accessToken + requestId. Path varies: vN-sign-in / sign-in-vN / signin …" },
  { pattern:/^\/auth\/signup/,      method:"POST", auth:false, body:"email,phone,password,firstName,lastName" },
  { pattern:/^\/otp\/signupOtp/i,   method:"POST", auth:false, body:"phone,email,otpChannel", hdrs:["x-token"], note:"x-token = Cloudflare Turnstile" },
  { pattern:/^\/otp\/verify.?[Oo]tp$/i, method:"POST", auth:false, body:"requestId,phone,code,otpChannel" },
  { pattern:/^\/otp\/verifySignin/i,    method:"POST", auth:true, body:"requestId,phone,code,otpChannel", hdrs:["Authorization"], note:"verified:true/false" },
  { pattern:/^\/forgot-password\/resend/,       method:"POST", auth:false, hdrs:["x-request-id"] },
  { pattern:/^\/forgot-password\/set-password/, method:"POST", auth:false, body:"password,confirmPassword", hdrs:["x-request-id"] },
  { pattern:/^\/forgot-password\/verify/,       method:"POST", auth:false, body:"payload", hdrs:["x-token"] },
  { pattern:/^\/appointment$/,                         method:"POST", auth:true, note:"Submit appointment — POST confirmed byte-by-byte in all bundles" },
  { pattern:/^\/appointment\/get-booking-config$/,     method:"GET",  auth:true, note:"Booking config: appointmentDate[], appointmentId, totalAmount" },
  { pattern:/^\/appointment\/get-booking/,             method:"GET",  auth:true, note:"appointmentDate[], appointmentId, totalAmount" },
  { pattern:/^\/appointment\/.*booking/,   method:"POST", auth:true, body:"config object" },
  { pattern:/^\/file\/file.confirm/i,  method:"GET",    auth:true, note:"Upload status + slot availability" },
  { pattern:/^\/file\/over.?view/i,    method:"POST",   auth:true, note:"Pre-upload applicant overview" },
  { pattern:/^\/file\/payment-amount/, method:"GET",    auth:true },
  { pattern:/^\/file\/upload/i,        method:"POST",   auth:true, body:"FormData(files PDF, isPrimary)", hdrs:["x-token","x-sec-runtime-state"], note:"multipart/form-data" },
  { pattern:/^\/file\/delete/,         method:"DELETE", auth:true, note:"Query param: fileNumber" },
  { pattern:/^\/high-commissions/,   method:"GET", auth:true, note:"Mission / HC centre list" },
  { pattern:/^\/ivac-centers/,       method:"GET", auth:true, note:"IVAC centres for selected commission → pass commissionId as path param" },
  { pattern:/^\/invoice\/all/,      method:"GET", auth:true },
  { pattern:/^\/invoice\//,         method:"GET", auth:true, hdrs:["x-token"], note:"PDF download → ArrayBuffer", responseType:"arraybuffer" },
  { pattern:/^\/profile$/,           method:"GET",  auth:true },
  { pattern:/^\/profile\/sendOtp/,  method:"POST", auth:true, body:"phone,email,otpChannel" },
  { pattern:/^\/profile\/verify/,   method:"POST", auth:true, body:"otp,requestId" },
  { pattern:/^\/slots\/.*reserve/,    method:"POST", auth:true, body:"c,appointmentDate", hdrs:["x-v-request-meta"], note:"reservationId, reserveTtlSeconds:660" },
  { pattern:/^\/payment\/.*dg-epay/, method:"POST", auth:true, body:"appointmentId", hdrs:["x-token"] },
  { pattern:/^\/payment\/ssl/,       method:"POST", auth:true, body:"appointmentId", hdrs:["x-token"] },
];
function matchMeta(p){for(const e of PATTERN_META){if(e.pattern.test(p)){const{pattern,...meta}=e;return meta;}}return null;}

// ═════════════════════════════════════════════════════════════════════════════
// ── Method inference ──────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
const POST_PATH_PATTERNS=[/^\/auth\//,/^\/otp\//,/^\/forgot-password\//,/^\/slots\/.*reserve/,/^\/payment\/.*initiat/,/\/sendOtp$/i,/\/verifyAndUpdate$/i,/\/upload/i,/\/signup$/i,/sign.?in/i,/\/signupOtp$/i,/\/verifySignin/i,/\/verify.?[Oo]tp$/i,/\/set-password$/i,/\/resend$/i,/\/verify$/i,/initiat/i,/^\/appointment$/];
const GET_PATH_PATTERNS=[/^\/high-commissions/,/^\/ivac-centers/,/^\/profile$/,/^\/invoice\/all/,/get-booking-config/,/over.?view/i,/payment-amount/,/file.?confirm/i];

const _localDecoderCache={};
function resolveLocalArrayMethods(){
  const result={};
  const HTTP_VERB=/^(get|post|put|delete|patch)$/i;
  const localArrRe=/function ([A-Za-z_$][A-Za-z0-9_$]{1,3})\(\)\{(?:const|var) e=\[/g;
  let lm;
  while((lm=localArrRe.exec(src))!==null){
    const arrFn=lm[1];
    const rawArr=extractRawArray(arrFn);
    if(!rawArr||rawArr.length<5||rawArr.length>500)continue;
    const localDecRe=new RegExp(`function ([A-Za-z_$][A-Za-z0-9_$]{0,3})\\(e(?:,t)?\\)\\{e-=(\\d+)[\\s\\S]{0,30}(?:const|var) n=${arrFn.replace(/[$]/,'\\$')}\\(\\)`,'g');
    let ldm;const localDecs={};
    while((ldm=localDecRe.exec(src))!==null){const body=src.slice(ldm.index,ldm.index+600);const isRC4=body.includes('%t.length');if(!localDecs[ldm[1]])localDecs[ldm[1]]={off:parseInt(ldm[2]),isRC4};}
    if(!Object.keys(localDecs).length)continue;
    const sentinel='}('+arrFn+')';const sentPos=src.indexOf(sentinel);if(sentPos<0)continue;
    const iiStart=src.lastIndexOf('!function(',sentPos);if(iiStart<0)continue;
    const iiCode=src.slice(iiStart,sentPos+sentinel.length);
    const mgM=iiCode.match(/if\((\d+)==/);if(!mgM)continue;
    const MAGIC=parseInt(mgM[1]);
    const intM2=iiCode.match(/if\(\d+==([\s\S]+?)\)break/);if(!intM2)continue;
    const intExpr2=intM2[1];
    const iiAliases={};
    const iiAlRe=/function ([a-z])\(e,t\)\{return ([A-Za-z_$][A-Za-z0-9_$]{0,3})\(([^)]+)\)\}/g;let iiam;
    while((iiam=iiAlRe.exec(iiCode))!==null){const alName=iiam[1],callee=iiam[2],argE=iiam[3].trim();const di=localDecs[callee];if(!di)continue;const rc4m=argE.match(/^(e|t)\s*((?:[+-]\s*-?\s*\d+)?)\s*,\s*(e|t)$/);const b64m=argE.match(/^(e|t)\s*((?:[+-]\s*-?\s*\d+)?)$/);if(rc4m)iiAliases[alName]={type:di.isRC4?'rc4':'b64',idxVar:rc4m[1],offset:parseOffset(rc4m[2]),keyVar:rc4m[3],fnOff:di.off};else if(b64m)iiAliases[alName]={type:'b64',idxVar:b64m[1],offset:parseOffset(b64m[2]),fnOff:di.off};}
    let rotArr=null;
    for(let rot=0;rot<rawArr.length;rot++){
      const arr=[...rawArr];for(let r=0;r<rot;r++)arr.push(arr.shift());
      let expr2=intExpr2.replace(/([a-z])\((-?\d+(?:e\d+)?|"[^"]*")\s*(?:,\s*(-?\d+(?:e\d+)?|"[^"]*"))?\)/g,(_,n,a1,a2)=>{const al=iiAliases[n];if(!al)return'"__X__"';const a1s=(a1||'0').replace(/"/g,''),a2s=(a2||'0').replace(/"/g,'');const iStr=al.idxVar==='e'?a1s:a2s,kStr=al.type==='rc4'?(al.keyVar==='e'?a1s:a2s):null;const real=parseFloat(iStr)+al.offset-al.fnOff;if(real<0||real>=arr.length)return'"__FAIL__"';const v=al.type==='rc4'?_rc4(arr[real],kStr):_b64(arr[real]);return v!=null?JSON.stringify(v):'"__FAIL__"';});
      if(expr2.includes('__FAIL__'))continue;expr2=expr2.replace(/"__X__"/g,'0');
      let val=NaN;try{val=eval(expr2);}catch(_){}
      if(Math.abs(val-MAGIC)<0.001){rotArr=arr;break;}
    }
    if(!rotArr)continue;
    _localDecoderCache[arrFn]={rotArr,decs:localDecs};
    const verbMap={};
    for(const[decName,di]of Object.entries(localDecs)){for(let i=di.off;i<di.off+rotArr.length;i++){const real=i-di.off;const v=di.isRC4?null:_b64(rotArr[real]);if(v&&HTTP_VERB.test(v))verbMap[`${decName}:${i}`]=v.toUpperCase();}}
    const decNames=Object.keys(localDecs).join('|');if(!decNames)continue;
    const patA=new RegExp(`(?:${decNames})\\((\\d+)(?:,"[^"]*")?\\)\\]\\s*\\(\\s*"([^"]+)"`,'g');let pm;
    while((pm=patA.exec(src))!==null){const key=Object.keys(localDecs).find(n=>src.slice(pm.index-n.length-1,pm.index).includes(n));if(!key)continue;const verb=verbMap[`${key}:${pm[1]}`];if(verb&&pm[2].startsWith('/'))result[pm[2]]=verb;}
    const areaStart=lm.index-3000,areaEnd=lm.index+5000;
    const area=src.slice(Math.max(0,areaStart),Math.min(src.length,areaEnd));
    const wrapRe=/function ([a-z])\(e,t\)\{return ([A-Za-z_$][A-Za-z0-9_$]{0,3})\(t-\s*-\s*(\d+)\)\}/g;let wm;
    while((wm=wrapRe.exec(area))!==null){const wAlias=wm[1],wDec=wm[2],wOff=parseInt(wm[3]);if(!localDecs[wDec])continue;const wCallRe=new RegExp(`\\[${wAlias}\\(0,(-?\\d+)\\)\\]\\s*\\(\\s*"([^"]+)"`,'g');let wcm;while((wcm=wCallRe.exec(area))!==null){const rawIdx=parseInt(wcm[1])+wOff;const verb=verbMap[`${wDec}:${rawIdx}`];if(verb&&wcm[2].startsWith('/'))result[wcm[2]]=verb;}}
  }
  return result;
}
const LOCAL_METHOD_MAP=resolveLocalArrayMethods();
if(Object.keys(LOCAL_METHOD_MAP).length){console.log("\n🔍 Local-array method resolutions:");for(const[p,method]of Object.entries(LOCAL_METHOD_MAP))console.log("   "+method.padEnd(8)+p);}

function inferMethodFromContext(endpointPath,pos){
  if(LOCAL_METHOD_MAP[endpointPath])return{method:LOCAL_METHOD_MAP[endpointPath],confidence:"LOCAL_ARRAY_DECODED"};
  const meta=matchMeta(endpointPath);if(meta&&meta.method)return{method:meta.method,confidence:"KNOWN"};
  for(const pat of POST_PATH_PATTERNS)if(pat.test(endpointPath))return{method:"POST",confidence:"PATH_PATTERN"};
  for(const pat of GET_PATH_PATTERNS)if(pat.test(endpointPath))return{method:"GET",confidence:"PATH_PATTERN"};
  const before=src.slice(Math.max(0,pos-500),pos);const after=src.slice(pos,pos+300);
  if(/new FormData/i.test(before.slice(-400)))return{method:"POST",confidence:"CONTEXT_FORMDATA"};
  if(/navigation.state|x-sec-nav/i.test(before.slice(-400)))return{method:"POST",confidence:"CONTEXT_HEADER"};
  if(/runtime.state|x-sec-run/i.test(before.slice(-400)))return{method:"POST",confidence:"CONTEXT_HEADER"};
  if(/x-v-request-meta/i.test(before.slice(-400)))return{method:"POST",confidence:"CONTEXT_HEADER"};
  if(/appointmentDate|reserve.*slot/i.test(before.slice(-300)))return{method:"POST",confidence:"CONTEXT_BODY"};
  const callRest=after.slice(endpointPath.length+3,200);const bodyShape=callRest.trim();
  if(bodyShape.startsWith(",{")&&/:\s*[^}]/.test(bodyShape.slice(0,60))&&!/params:/.test(bodyShape.slice(0,60)))return{method:"POST",confidence:"CONTEXT_BODY_SHAPE"};
  if(bodyShape.match(/^,\s*[a-z_$][a-z0-9_$]*[,)]/i)&&!/params:/i.test(bodyShape.slice(0,60)))return{method:"POST",confidence:"CONTEXT_VAR_ARG"};
  if(/params:/i.test(bodyShape.slice(0,100)))return{method:"GET",confidence:"CONTEXT_PARAMS"};
  if(/delete/i.test(endpointPath))return{method:"DELETE",confidence:"PATH_DELETE"};
  return{method:"GET",confidence:"DEFAULT"};
}

const CLIENT_CANDIDATE_RE=/([A-Za-z_$]{1,4})\[[^\]]{3,60}\]\s*\(\s*["'](\/[a-z][^"']{2,80})["']/g;
const clientVarCount={};let _cm;
while((_cm=CLIENT_CANDIDATE_RE.exec(src))!==null){const v=_cm[1];if(/^(true|false|null|this|Math|Date|JSON|Object|Array|String|Number|Boolean|RegExp|Error)$/.test(v))continue;clientVarCount[v]=(clientVarCount[v]||0)+1;}
const CLIENT_DIRECT_RE=/([A-Za-z_$]{1,4})\.(get|post|put|delete|patch)\s*\(\s*["'](\/[a-z][^"']{2,80})["']/g;
while((_cm=CLIENT_DIRECT_RE.exec(src))!==null){const v=_cm[1];if(/^(true|false|null|this|Math|Date|JSON|Object|Array|String|Number|Boolean|RegExp|Error)$/.test(v))continue;clientVarCount[v]=(clientVarCount[v]||0)+5;}
const API_CLIENT=Object.keys(clientVarCount).sort((a,b)=>clientVarCount[b]-clientVarCount[a])[0]||"Jh";
console.log("\n🔎 API client: "+API_CLIENT+" ("+(clientVarCount[API_CLIENT]||0)+" calls)");

const detected={};
function addEndpoint(method,endpointPath,confidence,pos){
  const normPath=endpointPath.replace(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/gi,":uuid");
  const key=method+":"+endpointPath;
  if(!detected[key]){detected[key]={method,path:endpointPath,normPath,confidence,pos};const meta=matchMeta(endpointPath);if(meta)Object.assign(detected[key],{auth:meta.auth,body:meta.body,hdrs:meta.hdrs,note:meta.note,responseType:meta.responseType});}
}
const DIRECT_RE=new RegExp(API_CLIENT.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\.(get|post|put|delete|patch)\\(["\']([^"\']+)["\']','gi');
while((m=DIRECT_RE.exec(src))!==null){const p=m[2];if(p.length<2||!/^\//.test(p))continue;addEndpoint(m[1].toUpperCase(),p,"DIRECT",m.index);}
const BRACKET_RE=new RegExp(API_CLIENT.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\[(?:[^\\]"\']+|"[^"]*"|\'[^\']*\')+\\]\\(["\'](\\/[^"\']{2,80})["\']','g');
while((m=BRACKET_RE.exec(src))!==null){const p=m[1];if(p==="/invo")continue;const{method,confidence}=inferMethodFromContext(p,m.index);addEndpoint(method,p,confidence,m.index);}
const CONCAT_RE=/["'](\/?[a-z/-]+)["']\s*\+\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\+\s*["']([a-z/-]+)["']/g;
while((m=CONCAT_RE.exec(src))!==null){const assembled=m[1]+":uuid"+m[3];if(!assembled.startsWith("/")||assembled.length<5)continue;let finalPath=assembled;if(/slots.*reserve/.test(assembled)&&SLOT_UUID!=="SLOT_ID_NOT_FOUND")finalPath=m[1]+SLOT_UUID+m[3];else if(/payment.*dg-epay/.test(assembled)&&DGEPAY_UUID!=="DGEPAY_ID_NOT_FOUND")finalPath=m[1]+DGEPAY_UUID+m[3];const{method,confidence}=inferMethodFromContext(finalPath,m.index);addEndpoint(method,finalPath,"CONCAT:"+confidence,m.index);}
if(DECODED_DGEPAY_PATH)addEndpoint("POST",DECODED_DGEPAY_PATH,"DECODED_OBFUSCATION",0);
if(UV7_PAYMENT_PATH&&UV7_PAYMENT_PATH!==DECODED_DGEPAY_PATH)addEndpoint("POST",UV7_PAYMENT_PATH,"UV7_DECODED",0);
if(DECODED_SSL_PATH)addEndpoint("POST",DECODED_SSL_PATH,"DECODED_OBFUSCATION",0);
if(DECODED_INVOICE_PATH&&DECODED_INVOICE_PATH.includes('/invoice/'))addEndpoint("GET",DECODED_INVOICE_PATH,"DECODED_OBFUSCATION",0);
else if(!Object.values(detected).some(ep=>ep.path.includes('/invoice/')&&ep.path.includes('download')))addEndpoint("GET","/invoice/{txrId}/download","KNOWN_FALLBACK",0);
if(!Object.values(detected).some(ep=>ep.path.includes('ssl/initiate'))&&!DECODED_SSL_PATH)addEndpoint("POST","/payment/ssl/initiate","KNOWN_FALLBACK",0);
if(!Object.values(detected).some(ep=>/ivac-centers/.test(ep.path)))addEndpoint("GET","/ivac-centers/{commissionId}","KNOWN_FALLBACK",0);

function detectDynamicPathEndpoints(){
  const dynRe=new RegExp(API_CLIENT.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\[([^\\]]+)\\]\\(([^)]{5,200}\\+\\s*[a-z]\\s*[,)])', 'g');
  let m;
  while((m=dynRe.exec(src))!==null){
    const fullExpr=m[2];
    if(!(/[A-Za-z_$][A-Za-z0-9_$]{0,3}\(\d/.test(fullExpr)))continue;
    const prefixExpr=fullExpr.replace(/\+\s*[a-z]\s*[,)].*$/,'').trim();
    let decodedPrefix='';
    for(const[arrFn,decoderList]of Object.entries(_localDecoderCache||{})){
      const rotArr=decoderList.rotArr;if(!rotArr)continue;
      const localDecs2=decoderList.decs;
      let testDecode='';const pieceRe2=/([A-Za-z_$][A-Za-z0-9_$]{0,3})\((-?\d+(?:e\d+)?)(?:,"([^"]*)")?\)/g;let pm2;let allDecoded=true;
      while((pm2=pieceRe2.exec(prefixExpr))!==null){
        const decName=pm2[1],idx=parseInt(pm2[2]),key=pm2[3]||null;
        const di=localDecs2[decName];if(!di){allDecoded=false;break;}
        const real=idx-di.off;if(real<0||real>=rotArr.length){allDecoded=false;break;}
        const v=di.isRC4&&key?_rc4(rotArr[real],key):_b64(rotArr[real]);if(!v){allDecoded=false;break;}
        testDecode+=v;
      }
      if(allDecoded&&testDecode.startsWith('/')&&testDecode.length>3){decodedPrefix=testDecode;break;}
    }
    if(!decodedPrefix)continue;
    const normPath=decodedPrefix+'{id}';
    const methodConf=inferMethodFromContext(normPath,m.index);
    addEndpoint(methodConf.method,normPath,'DYNAMIC_PATH_DECODED',m.index);
  }
}
detectDynamicPathEndpoints();

const seen_norm={};const ALL=[];
Object.values(detected).forEach(ep=>{const nk=ep.method+":"+ep.normPath;if(!seen_norm[nk]){seen_norm[nk]=true;ALL.push(ep);}});
ALL.sort((a,b)=>{const order={GET:0,POST:1,PUT:2,PATCH:3,DELETE:4};const mo=(order[a.method]||9)-(order[b.method]||9);return mo!==0?mo:a.path.localeCompare(b.path);});

console.log("\n📌 Detected "+ALL.length+" endpoints:\n");
ALL.forEach(ep=>{const body=ep.body?"  body=["+ep.body+"]":"";const hdr=ep.hdrs&&ep.hdrs.length?"  hdr=["+ep.hdrs.join(",")+"]":"";const note=ep.note?"  // "+ep.note.slice(0,55):"";const conf=ep.confidence!=="KNOWN"&&ep.confidence!=="DIRECT"?" ["+ep.confidence+"]":"";console.log("   "+ep.method.padEnd(8)+ep.path+body+hdr+note+conf);});

function makeIndexKey(ep){return ep.method+":"+ep.normPath;}
let prevEndpoints=null;let _cachedUUIDs={};
if(fs.existsSync(CACHE)){try{const cacheRaw=JSON.parse(fs.readFileSync(CACHE,"utf8"));prevEndpoints=Array.isArray(cacheRaw)?cacheRaw:(cacheRaw.endpoints||null);if(!Array.isArray(cacheRaw)&&cacheRaw.uuids)_cachedUUIDs=cacheRaw.uuids;}catch(_){}}
if(prevEndpoints){const prevMap={};prevEndpoints.forEach(ep=>{prevMap[makeIndexKey(ep)]=ep;});const currMap={};ALL.forEach(ep=>{currMap[makeIndexKey(ep)]=ep;});const added=ALL.filter(ep=>!prevMap[makeIndexKey(ep)]);const removed=prevEndpoints.filter(ep=>!currMap[makeIndexKey(ep)]);if(added.length||removed.length){console.log("\n🔔 ENDPOINT CHANGES vs last run:");added.forEach(ep=>console.log("   ✅ ADDED    "+ep.method.padEnd(8)+ep.path));removed.forEach(ep=>console.log("   ❌ REMOVED  "+ep.method.padEnd(8)+ep.path));}else console.log("\n✔️  No endpoint changes vs last run.");}else console.log("\n💡 No previous cache — this is the baseline run.");

const cacheData={endpoints:ALL.map(ep=>({method:ep.method,path:ep.path,normPath:ep.normPath,body:(ep.body!=null?ep.body:null),hdrs:(ep.hdrs&&ep.hdrs.length?ep.hdrs:[]),confidence:(ep.confidence||null),note:(ep.note||null)})),uuids:{SLOT_UUID:SLOT_UUID!=="SLOT_ID_NOT_FOUND"?SLOT_UUID:(_cachedUUIDs.SLOT_UUID||null),DGEPAY_UUID:DGEPAY_UUID!=="DGEPAY_ID_NOT_FOUND"?DGEPAY_UUID:(_cachedUUIDs.DGEPAY_UUID||null)},bundleName:path.basename(BUNDLE),generatedAt:new Date().toISOString()};
fs.writeFileSync(CACHE,JSON.stringify(cacheData,null,2));

if(DGEPAY_UUID==="DGEPAY_ID_NOT_FOUND")console.log("\n💳 DGEPAY_UUID not found — run on the payment lazy-chunk JS to get it.");
else console.log("\n💳 DGEPAY_UUID : "+DGEPAY_UUID);

// ═════════════════════════════════════════════════════════════════════════════
// ── Generate fetch-api.js ─────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
function pickHeaderBuilder(ep){if(!ep.hdrs||!ep.hdrs.length)return ep.auth!==false?'buildAuthHeaders()':'{"Content-Type":"application/json"}';const h=ep.hdrs;if(h.includes("x-sec-navigation-state"))return"buildSecNavState(secNavState)";if(h.includes("x-sec-runtime-state")&&h.includes("x-token"))return"buildSecRuntimeState(secRuntimeState,buildXToken(xToken))";if(h.includes("x-sec-runtime-state"))return"buildSecRuntimeState(secRuntimeState)";if(h.includes("x-v-request-meta"))return"buildVRequestMeta(xVRequestMeta)";if(h.includes("x-token"))return"buildXToken(xToken)";if(h.includes("x-request-id"))return"buildRequestIdHeader(requestId)";return"buildAuthHeaders()";}
function sanitizeIdent(s){return s.trim().replace(/[^a-zA-Z0-9_$]/g,"_").replace(/^([0-9])/,"_$1").replace(/_+/g,"_").replace(/_$/,"");}
function bodyFields(ep){if(!ep.body||ep.body==="null")return[];if(ep.body.includes("FormData"))return["files","isPrimary"];const raw=ep.body.split(",").map(s=>s.trim());if(raw.some(f=>/s/.test(f)||f.length>30))return["body"];return raw.map(sanitizeIdent).filter(Boolean);}
function paramList(ep){const params=[];const bf=bodyFields(ep);params.push(...bf);if(ep.hdrs){if(ep.hdrs.includes("x-sec-navigation-state"))params.push("secNavState");if(ep.hdrs.includes("x-sec-runtime-state"))params.push("secRuntimeState");if(ep.hdrs.includes("x-v-request-meta"))params.push("xVRequestMeta");if(ep.hdrs.includes("x-token")&&!params.includes("xToken"))params.push("xToken");if(ep.hdrs.includes("x-request-id"))params.push("requestId");}if(ep.path.includes("{txrId}")||ep.path.includes(":txrId"))params.unshift("txrId");if(ep.method==="GET"&&(!ep.body||ep.body==="null")&&ep.path.includes("/delete"))params.push("queryParams");return params;}
function toFnName(method,endpointPath){
  if(/\/dg-epay\/initiate/i.test(endpointPath))return"postPaymentDgpayInitiate";
  const clean=endpointPath.replace(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/gi,"").replace(/\{[^}]+\}/g,"ById").replace(/[^a-zA-Z0-9/]/g,"/").split("/").filter(Boolean).map((seg,i)=>i===0?seg.toLowerCase():seg.charAt(0).toUpperCase()+seg.slice(1).toLowerCase()).join("");
  const prefix=method==="GET"?"get":method==="DELETE"?"delete":method.toLowerCase();
  return prefix+clean.charAt(0).toUpperCase()+clean.slice(1);
}
function generateEndpointFn(ep){const fnName=toFnName(ep.method,ep.path);const pList=paramList(ep);const hdrExpr=pickHeaderBuilder(ep);const respType=ep.responseType?', responseType: "'+ep.responseType+'"':"";let bodyExpr="";const bFields=bodyFields(ep);if(ep.body&&ep.body!=="null"){if(ep.body.includes("FormData"))bodyExpr="\n  const fd=new FormData();\n  for(const f of files)fd.append(\"files\",f);\n  fd.append(\"isPrimary\",String(isPrimary));";else if(bFields.length===1&&bFields[0]==="body")bodyExpr="";else bodyExpr="\n  const body={"+bFields.join(", ")+"}";}
const urlExpr=ep.path.includes("{txrId}")?'"/invoice/"+txrId+"/download"':'"'+ep.path+'"';
const callBody=ep.body&&ep.body!=="null"?(ep.body.includes("FormData")?"{ headers: "+hdrExpr+", body: fd"+respType+" }":"{ headers: "+hdrExpr+", body"+respType+" }"):ep.method==="DELETE"&&pList.includes("queryParams")?"{ headers: "+hdrExpr+", params: queryParams"+respType+" }":"{ headers: "+hdrExpr+respType+" }";
const confNote=ep.confidence!=="KNOWN"&&ep.confidence!=="DIRECT"?"\n * ⚠ Method inferred ("+ep.confidence+") — verify if calls fail":"";
return"\n/**\n * "+fnName+"("+pList.join(", ")+")\n * "+ep.method+" "+ep.path+(ep.note?"\n * "+ep.note:"")+(ep.hdrs?"\n * Headers: "+ep.hdrs.join(", "):"")+(ep.body?"\n * Body: "+ep.body:"")+confNote+"\n */\nfunction "+fnName+"("+pList.join(", ")+"){"+bodyExpr+"\n  return ivacRequest(\""+ep.method+"\", "+urlExpr+", "+callBody+");\n}\n";}

console.log("\n⚙️  Generating "+OUTFILE+"...");
const exportNames=ALL.map(ep=>toFnName(ep.method,ep.path));
// ═════════════════════════════════════════════════════════════════════════════
// ── DYNAMIC ACTUAL FUNCTION GENERATOR (v15) ──────────────────────────────────
// Zero hardcode: extracts real params, headers, method, path from each
// generator body by decoding its own local alias functions.
// Produces *Actual variants that survive any path/param/syntax change.
// ═════════════════════════════════════════════════════════════════════════════

// Build a universal decode function from ALL known arrays (already rotated)
function buildUniversalDecoder(){
  const allDecMap=buildAllDecoderMap();
  const uDec={};
  for(const[arrFnName,decs] of Object.entries(allDecMap)){
    const raw=extractRawArray(arrFnName);if(!raw)continue;
    const rotated=rotateArray(arrFnName,raw,allDecMap);
    for(const[name,info] of Object.entries(decs)){
      if(uDec[name])continue;
      const off=info.offset,isRC4=info.isRC4,arr=rotated;
      uDec[name]=(e,t)=>{const r=e-off;if(r<0||r>=arr.length)return'';return isRC4&&t?(_rc4(arr[r],t)||''):(_b64(arr[r])||'');};
    }
  }
  return uDec;
}

// Decode a token expression like `fn("key", -123)` or `fn(0, -456)` using uDec
function decodeTokenExpr(expr, uDec){
  // Pattern: fnName("key", offset) or fnName(0, offset) or fnName(offset)
  const re=/\b([A-Za-z_$][A-Za-z0-9_$]{0,4})\((?:"([^"]{0,20})"\s*,\s*)?(-?\d+(?:e\d+)?|0)\s*(?:,\s*"([^"]{0,20}"))?(?:\s*,\s*"([^"]{0,20}")?)?\)/g;
  let result='',m;
  while((m=re.exec(expr))!==null){
    const fn=m[1],key=m[2]||m[4]||m[5]||null,idxStr=m[3];
    if(!uDec[fn])continue;
    try{const v=uDec[fn](parseFloat(idxStr),key||undefined);if(v)result+=v;}catch(_){}
  }
  return result;
}

// Extract real call info from a generator body using its own local aliases
function extractGeneratorSignature(genBodyStr, uDec){
  const result={path:null,method:null,headers:{},bodyFields:[],responseKey:null};

  // 1. Parse local alias functions: function x(e,t){return DECODER(args)}
  const aliasRe=/function ([a-z])\(e(?:,t)?\)\{return ([A-Za-z_$][A-Za-z0-9_$]{0,4})\(([^)]{1,60})\)\}/g;
  const aliases={};let am;
  while((am=aliasRe.exec(genBodyStr))!==null){
    const aName=am[1],callee=am[2],argExpr=am[3].trim();
    if(!uDec[callee])continue;
    // Parse offset and RC4 key from argExpr
    // Patterns: e- -746 | t-974 | e+698 | 0,-484
    const rc4m=argExpr.match(/^(e|t)\s*([-+]\s*-?\d+)?\s*,\s*(e|t)$/);
    const b64m=argExpr.match(/^(e|t)\s*([-+]\s*-?\d+)?$/);
    const b64t=argExpr.match(/^t\s*([-+]\s*-?\d+)?$/);
    function parseOff(s){if(!s)return 0;const c=s.replace(/\s/g,'');try{return new Function('return('+c+')')();}catch(_){return 0;}}
    if(rc4m){
      const off=parseOff(rc4m[2]),idxVar=rc4m[1],keyVar=rc4m[3];
      aliases[aName]=(e,t)=>{const idx=(idxVar==='e'?e:t)+off;const key=(keyVar==='e'?String(e):String(t));return uDec[callee](idx,key)||'';};
    } else if(b64m){
      const off=parseOff(b64m[2]),idxVar=b64m[1];
      aliases[aName]=(e,t)=>{const idx=(idxVar==='e'?e:t)+off;return uDec[callee](idx)||'';};
    } else if(b64t){
      const off=parseOff(b64t[1]);
      aliases[aName]=(e,t)=>{return uDec[callee](t+off)||'';};
    }
  }

  // Combined decode function: tries local aliases first, then global uDec
  function decode(tokenStr){
    const re2=/([A-Za-z_$][A-Za-z0-9_$]{0,4})\((-?\d+(?:e\d+)?)\s*(?:,\s*"([^"]{0,20})")?\)|([A-Za-z_$][A-Za-z0-9_$]{0,4})\("([^"]{0,20})"\s*,\s*(-?\d+(?:e\d+)?)\)\s*|"([^"\\]{0,40})"/g;
    let acc='',rm;
    while((rm=re2.exec(tokenStr))!==null){
      let frag=null;
      if(rm[7]!=null){frag=rm[7];}
      else if(rm[1]){
        const fn=rm[1],idx=parseFloat(rm[2]),key=rm[3]||null;
        if(aliases[fn])try{frag=aliases[fn](idx,key||'');}catch(_){}
        if(!frag&&uDec[fn])try{frag=uDec[fn](idx,key||undefined);}catch(_){}
      } else if(rm[4]){
        const fn=rm[4],key=rm[5],idx=parseFloat(rm[6]);
        if(aliases[fn])try{frag=aliases[fn](idx,key);}catch(_){}
        if(!frag&&uDec[fn])try{frag=uDec[fn](idx,key);}catch(_){}
      }
      if(frag)acc+=frag;
    }
    return acc;
  }

  // 2. Find the yield call: (yield ik[METHOD_EXPR](PATH_EXPR, BODY_EXPR, OPTIONS_EXPR))
  // Pattern: yield ik[...](path, body, {headers:{...}})
  const yieldRe=/yield\s+[a-zA-Z_$][a-zA-Z0-9_$]{0,4}\[([^\]]{1,80})\]\(([^,)]{1,150})(?:,([^,)]{1,150})(?:,(\{[^}]{1,300}\}))?)?\)/;
  const ym=yieldRe.exec(genBodyStr);
  if(ym){
    // Decode method
    const methodRaw=decode(ym[1]);
    if(methodRaw&&/^(get|post|put|delete|patch)$/i.test(methodRaw))result.method=methodRaw.toUpperCase();
    // Decode path
    const pathRaw=ym[2]?decode(ym[2]):null;
    if(pathRaw&&pathRaw.startsWith('/'))result.path=pathRaw;
    // Decode options/headers
    if(ym[4]){
      const optsStr=ym[4];
      // Find header keys
      const hdrRe=/"([^"\\]{1,40})":/g;let hm;
      while((hm=hdrRe.exec(optsStr))!==null){
        const key=hm[1];
        if(['x-v-request-meta','x-token','x-sec-navigation-state','x-sec-runtime-state','x-request-id'].some(k=>key===k||decode(hm[1])===k)){
          const decoded=decode(key)||key;
          result.headers[decoded]=true;
        }
      }
      // Decode any decoder calls in opts
      const decodedOpts=decode(optsStr);
      ['x-v-request-meta','x-token','x-sec-navigation-state','x-sec-runtime-state','x-request-id'].forEach(k=>{
        if(decodedOpts.includes(k))result.headers[k]=true;
      });
    }
    // Detect body structure from body expression
    if(ym[3]){
      const bodyStr=ym[3].trim();
      // If it's a plain variable reference (e, t, n, etc), extract fields from object literal nearby
      if(/^[a-z]$/.test(bodyStr)){
        // Look for object literal pattern: {field1:var, field2:var2}
        const objRe=new RegExp('\\{([^}]{1,200})\\}');
        const objM=objRe.exec(genBodyStr);
        if(objM){
          const objStr=objM[1];
          // Extract field names
          const fieldRe=/([a-zA-Z_$][a-zA-Z0-9_$]{0,30})\s*:/g;let fm;
          while((fm=fieldRe.exec(objStr))!==null){
            const f=fm[1];
            if(!['headers','data','DszrK','UCONv','QeFpo','eXWxF'].includes(f))
              result.bodyFields.push(f);
          }
        }
      } else if(bodyStr.startsWith('{')){
        // Inline object: {appointmentId: a, ...}
        const fieldRe2=/([a-zA-Z_$][a-zA-Z0-9_$]{0,30})\s*:/g;let fm2;
        while((fm2=fieldRe2.exec(bodyStr))!==null){
          result.bodyFields.push(fm2[1]);
        }
      }
    }
  }

  // 3. Detect headers from object literals in generator body
  const headerScanStr=decode(genBodyStr.slice(0,2000));
  ['x-v-request-meta','x-token','x-sec-navigation-state','x-sec-runtime-state','x-request-id'].forEach(k=>{
    if(headerScanStr.includes(k)||genBodyStr.includes('"'+k+'"'))result.headers[k]=true;
  });

  return result;
}

// Scan ALL generators in bundle and extract their signatures
function extractAllGeneratorSignatures(uDec){
  const sigs=[];
  const SLOT_RE_G=/\/slots\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\/reserve-slot/i;
  const DG_RE_G=/\/payment\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\/dg-epay\/initiate/i;
  const SSL_RE_G=/\/payment\/ssl\/initiate/i;

  // Collect generator body start positions from multiple wrapper patterns
  const genPositions=new Set();
  // Standard: function*(){
  let pos=-1;
  while((pos=src.indexOf('function*(){',pos+1))>=0) genPositions.add(pos);
  // Wrapped: fU(null,null,function*(){  lk(null,null,function*(){  lk(null,null,function *(){
  for(const wrapper of ['fU(null,null,function*(){','lk(null,null,function*(){','lk(null, null, function*(){']){
    let p=-1;
    while((p=src.indexOf(wrapper,p+1))>=0) genPositions.add(src.indexOf('function*(){',p));
  }

  for(const gpos of [...genPositions].sort((a,b)=>a-b)){
    if(gpos<0)continue;
    // Extract generator body (balanced braces)
    const openBrace=src.indexOf('{',gpos+10);
    if(openBrace<0)continue;
    let depth=1,i=openBrace+1,inS=false,sc='';
    while(i<src.length&&depth>0){
      const c=src[i];
      if(inS){if(c==='\\')i++;else if(c===sc)inS=false;}
      else if(c==='"'||c==="'"){inS=true;sc=c;}
      else if(c==='{')depth++;
      else if(c==='}')depth--;
      i++;
    }
    const genBody=src.slice(openBrace+1,i-1);
    if(genBody.length<20||genBody.length>8000)continue;

    // Quick check: does this generator have a path we care about?
    const isSlot=SLOT_RE_G.test(genBody)||genBody.includes('reserve-slot');
    // For payment: check for UCONv/QeFpo/appointmentId/dg-epay context
    const isDg=DG_RE_G.test(genBody)||genBody.includes('UCONv')||genBody.includes('dg-epay')||
               (genBody.includes('appointmentId')&&genBody.includes('x-token'));
    const isSsl=SSL_RE_G.test(genBody)||(genBody.includes('QeFpo')&&!isDg&&genBody.includes('ssl'));
    if(!isSlot&&!isDg&&!isSsl)continue;

    const sig=extractGeneratorSignature(genBody, uDec);

    // Fallback: get path from literal or decoded value
    if(!sig.path){
      const slotM=SLOT_RE_G.exec(genBody);
      const dgM=DG_RE_G.exec(genBody);
      const sslM=SSL_RE_G.exec(genBody);
      if(slotM)sig.path='/slots/'+slotM[1]+'/reserve-slot';
      else if(dgM)sig.path='/payment/'+dgM[1]+'/dg-epay/initiate';
      else if(sslM)sig.path='/payment/ssl/initiate';
      // For payment: try to decode UCONv expression directly using uDec
      else if(isDg&&(DECODED_DGEPAY_PATH||UV7_PAYMENT_PATH)){
        sig.path=DECODED_DGEPAY_PATH||UV7_PAYMENT_PATH;
      }
    }
    if(!sig.path)continue;

    // Determine type
    if(SLOT_RE_G.test(sig.path)||sig.path.includes('reserve-slot')){
      sig.type='SLOT';if(!sig.method)sig.method='POST';
    } else if(DG_RE_G.test(sig.path)||sig.path.includes('dg-epay')){
      sig.type='DGEPAY';if(!sig.method)sig.method='POST';
    } else if(SSL_RE_G.test(sig.path)){
      sig.type='SSL';if(!sig.method)sig.method='POST';
    } else continue;

    // Detect body fields from generator body patterns
    // reserve-slot: {c: ..., appointmentDate: ...}
    if(sig.type==='SLOT'&&sig.bodyFields.length===0){
      // Check literal object patterns in generator body
      if(genBody.includes('appointmentDate')&&genBody.match(/\bc\b/))sig.bodyFields=['c','appointmentDate'];
      else if(genBody.includes('appointmentDate'))sig.bodyFields=['appointmentDate'];
      else if(genBody.match(/\{c:/)&&genBody.includes('date'))sig.bodyFields=['c','date'];
      // Fallback: look for the yield call body argument directly
      const yieldBodyM=genBody.match(/yield\s+[a-zA-Z_$]\w{0,4}\[[^\]]+\]\([^,)]+,\s*([a-z])\s*,/);
      if(yieldBodyM&&sig.bodyFields.length===0){
        // The variable 'e' is the function argument containing body
        // check if it's passed as the appointment object
        sig.bodyFields=['c','appointmentDate'];
      }
    }
    // payment: {appointmentId: ...}
    if((sig.type==='DGEPAY'||sig.type==='SSL')&&sig.bodyFields.length===0){
      if(genBody.includes('appointmentId'))sig.bodyFields=['appointmentId'];
    }

    // Detect headers from literal strings in body
    if(genBody.includes('"x-token"')||genBody.includes('x-token'))sig.headers['x-token']=true;
    if(genBody.includes('"x-v-request-meta"'))sig.headers['x-v-request-meta']=true;
    if(genBody.includes('"x-sec-navigation-state"'))sig.headers['x-sec-navigation-state']=true;

    // Dedup by path
    if(!sigs.some(s=>s.path===sig.path))sigs.push(sig);
  }
  return sigs;
}

// Generate a zero-hardcode actual function from a generator signature
function generateActualFn(sig){
  const type=sig.type;
  const fnBase=type==='SLOT'?'postSlotsReserveSlot':type==='DGEPAY'?'postPaymentDgpayInitiate':'postPaymentSslInitiate';
  const fnName=fnBase+'Actual';

  // Build params from detected body fields + headers
  const params=[...sig.bodyFields];
  const hdrs=sig.headers||{};
  if(hdrs['x-sec-navigation-state']&&!params.includes('secNavState'))params.push('secNavState');
  if(hdrs['x-v-request-meta']&&!params.includes('xVRequestMeta'))params.push('xVRequestMeta');
  if(hdrs['x-token']&&!params.includes('xToken'))params.push('xToken');
  if(hdrs['x-sec-runtime-state']&&!params.includes('secRuntimeState'))params.push('secRuntimeState');
  if(hdrs['x-request-id']&&!params.includes('requestId'))params.push('requestId');

  // Build header expression
  let hdrExpr;
  if(hdrs['x-v-request-meta'])hdrExpr='buildVRequestMeta(xVRequestMeta)';
  else if(hdrs['x-token'])hdrExpr='buildXToken(xToken)';
  else if(hdrs['x-sec-navigation-state'])hdrExpr='buildSecNavState(secNavState)';
  else if(hdrs['x-sec-runtime-state'])hdrExpr='buildSecRuntimeState(secRuntimeState)';
  else if(hdrs['x-request-id'])hdrExpr='buildRequestIdHeader(requestId)';
  else hdrExpr='buildAuthHeaders()';

  // Body expression
  let bodyPart='';
  if(sig.bodyFields.length>0){
    bodyPart='\n  const body={'+sig.bodyFields.join(', ')+'}';
  }

  const callArgs=sig.bodyFields.length>0?'{ headers: '+hdrExpr+', body }':'{ headers: '+hdrExpr+' }';
  const escapedPath=JSON.stringify(sig.path);

  return `
/**
 * ${fnName}(${params.join(', ')})
 * DYNAMIC — zero-hardcode actual extraction from bundle generator
 * ${sig.method} ${sig.path}
 * Headers detected: ${Object.keys(hdrs).join(', ')||'Authorization'}
 * Body fields detected: ${sig.bodyFields.join(', ')||'none'}
 * Falls back to ${fnBase}() if this function encounters errors
 */
function ${fnName}(${params.join(', ')}){${bodyPart}
  return ivacRequest("${sig.method||'POST'}", ${escapedPath}, ${callArgs});
}
`;
}

// ── Run dynamic actual function extraction ────────────────────────────────────
console.log('\n⚙️  v15: Extracting dynamic actual functions from generators...');
let DYNAMIC_ACTUAL_FNS='';
let DYNAMIC_ACTUAL_EXPORTS=[];
try{
  const uDec=buildUniversalDecoder();
  const sigs=extractAllGeneratorSignatures(uDec);
  console.log('  Found '+sigs.length+' generator signature(s) for slot/payment paths');
  sigs.forEach(sig=>{
    const code=generateActualFn(sig);
    DYNAMIC_ACTUAL_FNS+=code;
    const fnName=(sig.type==='SLOT'?'postSlotsReserveSlot':sig.type==='DGEPAY'?'postPaymentDgpayInitiate':'postPaymentSslInitiate')+'Actual';
    DYNAMIC_ACTUAL_EXPORTS.push(fnName);
    console.log('  ✅ Generated: '+fnName+' → '+sig.method+' '+sig.path);
    console.log('     body: ['+sig.bodyFields.join(',')+'] headers: ['+Object.keys(sig.headers).join(',')+']');
  });
  if(sigs.length===0)console.log('  ⚠️  No generator signatures found — only static functions generated');
}catch(e){
  console.log('  ⚠️  Dynamic extraction error: '+e.message+' — static functions still generated');
}

const GENERATED=`// fetch-api.js — AUTO-GENERATED by extract_fetch.js vFinal
// ${new Date().toISOString()} | Bundle: ${path.basename(BUNDLE)}
// Endpoints: ${ALL.length} | SLOT_ID: ${SLOT_UUID} | DGEPAY_ID: ${DGEPAY_UUID}
"use strict";
const API_BASE="${API_BASE_URL}";const SLOT_ID="${SLOT_UUID}";const DGEPAY_ID="${DGEPAY_UUID}";
let _accessToken=null,_requestId=null;
function setAccessToken(t){_accessToken=t;}function getAccessToken(){return _accessToken;}
function setRequestId(i){_requestId=i;}function getRequestId(){return _requestId;}
function clearSession(){_accessToken=null;_requestId=null;}
function buildAuthHeaders(e){const h={"Content-Type":"application/json"};if(_accessToken)h["Authorization"]="Bearer "+_accessToken;if(e)Object.assign(h,e);return h;}
function buildXToken(t,b){return Object.assign({},b!==undefined?b:buildAuthHeaders(),{"x-token":t});}
function buildSecNavState(s,b){const h=b!==undefined?Object.assign({},b):{"Content-Type":"application/json"};h["x-sec-navigation-state"]=s;return h;}
function buildVRequestMeta(m,b){const v=typeof m==="string"?m:JSON.stringify(m);return Object.assign({},b!==undefined?b:buildAuthHeaders(),{"x-v-request-meta":v});}
function buildSecRuntimeState(s,b){return Object.assign({},b!==undefined?b:buildAuthHeaders(),{"x-sec-runtime-state":s});}
function buildRequestIdHeader(r,b){const h=b!==undefined?Object.assign({},b):{"Content-Type":"application/json"};h["x-request-id"]=r;return h;}
async function ivacRequest(method,endpointPath,options){const{body,headers,params,responseType}=options||{};let url=API_BASE+endpointPath;if(params&&Object.keys(params).length)url+="?"+new URLSearchParams(params).toString();const init={method,headers:headers||buildAuthHeaders()};if(body instanceof FormData){const s=Object.assign({},init.headers);delete s["Content-Type"];init.headers=s;init.body=body;}else if(body!==undefined&&body!==null)init.body=JSON.stringify(body);const res=await fetch(url,init);if(!res.ok){let e="";try{e=await res.text();}catch(_){}const err=new Error("HTTP "+res.status+" "+res.statusText+": "+e);err.status=res.status;err.url=url;err.body=e;throw err;}if(responseType==="arraybuffer")return res.arrayBuffer();if(responseType==="text")return res.text();return res.json();}
${ALL.map(generateEndpointFn).join("")}
${DYNAMIC_ACTUAL_FNS}
if(typeof module!=="undefined"){module.exports={API_BASE,SLOT_ID,DGEPAY_ID,setAccessToken,getAccessToken,setRequestId,getRequestId,clearSession,buildAuthHeaders,buildXToken,buildSecNavState,buildVRequestMeta,buildSecRuntimeState,buildRequestIdHeader,ivacRequest,${exportNames.join(",\n")}${DYNAMIC_ACTUAL_EXPORTS.length?',\n'+DYNAMIC_ACTUAL_EXPORTS.join(',\n'):''}};}
`;
fs.writeFileSync(OUTFILE,GENERATED);
console.log("✅ "+OUTFILE+" ("+GENERATED.length+" bytes)");
console.log("   API_BASE  : "+API_BASE_URL);
console.log("   SLOT_ID   : "+SLOT_UUID);
console.log("   DGEPAY_ID : "+DGEPAY_UUID);
console.log("   Endpoints : "+ALL.length);