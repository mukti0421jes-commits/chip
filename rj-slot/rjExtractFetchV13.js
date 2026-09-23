// ==================== extract_fetch v13 — browser port (dg-epay UUID + slot-id) ====================
// Faithful port of extract_fetch.js v13 (Strategy A–K). Node `vm` replaced by new Function shims.
// Returns { dgUuid, dgPath, sslPath, slotUuid } scanned dynamically from the live bundle text.
function rjExtractFetchV13(src) {
  var console = { log: function(){}, error: function(){}, warn: function(){} };  // silence internal logs
  function _vmRun(sandbox, code) {
    var keys = Object.keys(sandbox), vals = keys.map(function(k){ return sandbox[k]; });
    (new Function(keys.join(','), code)).apply(null, vals);
  }
  function _vmEvalWith(sandbox, defs, expr) {
    var keys = Object.keys(sandbox).filter(function(k){ return k !== '__aliasCode'; });
    var vals = keys.map(function(k){ return sandbox[k]; });
    return (new Function(keys.join(','), defs + '\n; return (' + expr + ');')).apply(null, vals);
  }
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
    _vmRun(sandbox, decodeFnCode + '\n' + iifeCode);
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
      _vmRun(sandboxDecls, iifeCode);
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
    if(decoded&&/[0-9a-f]{8}-[0-9a-f]{4}/.test(decoded))dgPath=decoded;
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
        const uuidInProp=decoded.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if(uuidInProp&&/dg-epay/i.test(decoded)){
          const cleanM=decoded.match(/\/?payment\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/dg-epay\/initiate/i);
          if(cleanM){dgPath=(cleanM[0].startsWith('/')?'':'/')+cleanM[0];}
          else{dgPath=decoded.startsWith('/')?decoded:'/'+decoded;}
          console.log("  ✅ DG path via property scan (mixed): "+dgPath);
        } else if(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(decoded)&&/dg-epay/i.test(decoded)){
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
          const cleanBrM=branchDecoded.match(/\/?payment\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/dg-epay\/initiate/i);
          if(cleanBrM){
            dgPath=(cleanBrM[0].startsWith('/')?'':'/')+cleanBrM[0];
            console.log("  ✅ DG path via ternary branch: "+dgPath);
          } else if(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(branchDecoded)&&/dg-epay/i.test(branchDecoded)){
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
          if(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(decoded)&&/dg-epay/i.test(decoded)){
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

  // ── Strategy H (NEW v11): depth-0 ternary TRUE-branch decoder ───────────
  // Fires when A-G fail. Handles bundles where the dg-epay path is built
  // INLINE in the TRUE branch of a top-level ternary assignment, e.g.:
  //   mrx52llu: n=OBJ[fn(r,OBJ[fn2()])]?DGPATH:SSL
  //   msbe8iqp: d=OBJ[fn(r,OBJ[fn2()])]?DGPATH:SSL
  //   mse7qsay: const u=OBJ[fn(e,decoded+"ay")]?DGPATH:SSL
  //   mrvp5ck7: a=r===OBJ[fn()]?DGPATH:SSL
  //   ms72wysd:  o=a===decoded+"ay"?DGPATH:SSL
  //
  // Key insight: these generators always pick the LONGER branch for dg-epay
  // path (TRUE) and shorter for ssl path (FALSE). We scan all depth-0 "?"
  // in genBody, extract TRUE/FALSE branches, decode both, and check for UUID.
  //
  // This is separate from the existing ternaryRe (Strategy B/C) which only
  // matches "VAR===COND" form. Strategy H covers the method-call equality
  // form: "VAR=OBJ[fn()](arg1,arg2)?..." which ternaryRe misses entirely.
  if (!dgPath) {
    console.log("  ⚙️  Trying Strategy H: depth-0 ternary branch decode...");

    // Extract all top-level ternary branches from genBody
    function extractDepth0Ternaries(body) {
      const results = [];
      let depth = 0, inStr = false, sc = '';
      for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (inStr) { if (c === '\\') i++; else if (c === sc) inStr = false; }
        else if (c === '"' || c === "'") { inStr = true; sc = c; }
        else if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === '?' && depth === 0) {
          // Extract TRUE branch
          let j = i + 1, d2 = 0, inS2 = false, sc2 = '', trueBranch = '';
          while (j < body.length) {
            const ch = body[j];
            if (inS2) { if(ch==='\\')j++; else if(ch===sc2)inS2=false; }
            else if(ch==='"'||ch==="'"){inS2=true;sc2=ch;}
            else if(ch==='('||ch==='['||ch==='{')d2++;
            else if(ch===')'||ch===']'||ch==='}')d2--;
            else if(ch===':'&&d2===0)break;
            trueBranch+=ch; j++;
          }
          // Extract FALSE branch
          let falseBranch = '';
          j++; d2=0; inS2=false; sc2='';
          while (j < body.length) {
            const ch = body[j];
            if (inS2){if(ch==='\\')j++;else if(ch===sc2)inS2=false;}
            else if(ch==='"'||ch==="'"){inS2=true;sc2=ch;}
            else if(ch==='('||ch==='['||ch==='{')d2++;
            else if(ch===')'||ch===']'||ch==='}')d2--;
            else if((ch==='\n'||ch===';')&&d2===0)break;
            falseBranch+=ch; j++;
          }
          results.push({
            trueBranch: trueBranch.trim(),
            falseBranch: falseBranch.trim()
          });
        }
      }
      return results;
    }

    const ternBranches = extractDepth0Ternaries(genBody);
    for (const {trueBranch, falseBranch} of ternBranches) {
      // Try decoding the TRUE branch first (always longer = dg-epay path)
      // then FALSE branch as fallback
      for (const branch of [trueBranch, falseBranch]) {
        if (!branch || branch.length < 15) continue;
        let decoded = decodeExpr(branch);
        if (!decoded || decoded.length < 15) {
          const mx = decodeExprMixed(branch);
          if (mx.text && mx.text.length >= 15) decoded = mx.text;
        }
        if (!decoded || decoded.length < 15) continue;

        // Clean extraction: look for /payment/UUID/dg-epay/initiate
        const cleanM = decoded.match(/\/?payment\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/dg-epay\/initiate/i);
        if (cleanM) {
          dgPath = (cleanM[0].startsWith('/') ? '' : '/') + cleanM[0];
          console.log("  ✅ DG path via Strategy H (depth-0 ternary TRUE): " + dgPath);
          break;
        }
        // UUID + dg-epay anywhere in decoded
        if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(decoded) &&
            /dg-epay/i.test(decoded)) {
          const uM = decoded.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
          dgPath = '/payment/' + uM[0].toLowerCase() + '/dg-epay/initiate';
          console.log("  ✅ DG UUID via Strategy H (depth-0 ternary UUID rescue): " + dgPath);
          break;
        }
        if (!sslPath && /ssl\/initiate|payment\/ssl/i.test(decoded)) {
          sslPath = decoded.startsWith('/') ? decoded : '/' + decoded;
        }
      }
      if (dgPath) break;
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
      if(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(accum)&&/dg-epay/i.test(accum)){
        const pathM=accum.match(/\/?payment\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/dg-epay\/initiate/i);
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
    const uuidM2=combined.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
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
            if(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(decoded)&&/dg-epay/i.test(decoded)){
              const cleanM2=decoded.match(/\/?payment\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/dg-epay\/initiate/i);
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
              if(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(dec3)&&/dg-epay/i.test(dec3)){
                const cleanM3=dec3.match(/\/?payment\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/dg-epay\/initiate/i);
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

      const uuidMatch=decoded.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if(uuidMatch&&/dg-epay/i.test(decoded)){
        const cleanMatch=decoded.match(/\/?payment\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/dg-epay\/initiate/i);
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

  // ── Strategy J (NEW v12): direct mU()/WU() call scan in generator body ───
  // Fires when A–I all fail. Handles bundles where the dg-epay path is built
  // by concatenating LITERAL string pieces + mU(idx,"key") + WU(idx) calls,
  // and the local alias functions map directly to mU/WU (not *V variants).
  //
  // Real example from mtv1rx02-e9bAiBuo.js generator body:
  //   function e(e,t){return WU(t- -744)}    // e(0,X) = WU(X + 744)
  //   function t(e,t){return mU(e- -310,t)}  // t(X,k) = mU(X + 310, k)
  //   function r(e,t){return WU(e- -710)}    // r(X)   = WU(X + 710)
  //   function o(e,t){return mU(e-63,t)}     // o(X,k) = mU(X - 63,  k)
  //   function u(e,t){return mU(e- -698,t)}  // u(X,k) = mU(X + 698, k)
  //   UCONv:"payme"+o(275,"g!Tz")+u(-449,"kJh5")+r(-423)+u(-436,"^dZd")
  //         +e(0,-484)+e(0,-481)+mU(250,"$VRW")+t(-68,"1mnJ")
  //         +r(-535)+WU(180)+t(-20,"[aFw")+"e"
  //
  // This generator's aliases don't end in 'V', so parseGenAliasesExtended
  // (which only matches [A-Za-z]{1,3}V) completely misses them. Strategy J
  // parses the alias-function bodies directly to extract the offset, then
  // decodes every mU/WU/alias call in the property expression.
  if (!dgPath) {
    console.log("  ⚙️  Trying Strategy J: direct mU()/WU() call scan in generator body...");

    // Parse alias functions of the form:
    //   function NAME(e,t){return DECFN(argExpr)}  or  function NAME(e){return DECFN(argExpr)}
    // where DECFN is the primary array's RC4 or B64 decoder (mU/WU or similar).
    // argExpr can be: t- -744, e- -310, e-63, t-563, e- -698, etc.
    const aliasMap = {};
    const aliasReJ = /function\s+([a-z])\s*\(\s*e(?:\s*,\s*t)?\s*\)\s*\{\s*return\s+([A-Za-z_$][A-Za-z0-9_$]{0,3})\s*\(\s*([^)]+)\)\s*\}/g;
    let ajm;
    while ((ajm = aliasReJ.exec(genBody)) !== null) {
      const alName = ajm[1], decFnName = ajm[2], argExpr = ajm[3].trim();
      // Only proceed if decFnName is the primary array's RC4 or B64 decoder.
      // In this bundle that's mU (RC4) and WU (B64). Check via allDecoders + vDecMap.
      let isRC4 = null, off = null;
      // Check allDecoders (primary array's direct decoders)
      if (allDecoders[decFnName] && allDecoders[decFnName].arrFn === primaryArrFn) {
        off = allDecoders[decFnName].offset;
        isRC4 = allDecoders[decFnName].type === 'rc4';
      }
      // Check vDecMap (functions like WU/mU themselves, detected by vFnRe2)
      if (off === null && vDecMap[decFnName]) {
        off = vDecMap[decFnName].off;
        isRC4 = vDecMap[decFnName].isRC4;
      }
      if (off === null) continue;
      // Parse argExpr to determine which arg is the index and which is the key,
      // plus the offset to add. Supported forms:
      //   t- -744    (idx is 't', offset +744, no key)
      //   e- -310,t  (idx is 'e', offset +310, key is 't')
      //   e-63,t     (idx is 'e', offset -63,  key is 't')
      //   t-563,e    (idx is 't', offset -563, key is 'e')
      //   e- -698,t  (idx is 'e', offset +698, key is 't')
      //   t-637,e    (idx is 't', offset -637, key is 'e')
      //   e          (idx is 'e', no offset,   no key)
      const parts = argExpr.split(/\s*,\s*/);
      const idxPart = parts[0];
      const keyPart = parts.length > 1 ? parts[1] : null;
      const m = idxPart.match(/^([et])\s*([+-]\s*-?\s*\d+)?$/);
      if (!m) continue;
      const idxVar = m[1];
      const offset = m[2] ? parseOffset(m[2]) : 0;
      aliasMap[alName] = { decFn: decFnName, idxVar, offset, keyVar: keyPart, isRC4 };
    }

    // Helper: decode a single call expr (alias or direct mU/WU) given the call's args.
    function decodeCallJ(fnName, a1Raw, a2Raw) {
      // a1Raw/a2Raw are strings like '0', '-484', '"g!Tz"', 'e', 't'
      const resolveArgJ = (raw) => {
        if (!raw) return null;
        const s = raw.trim();
        if (s.startsWith('"')) return s.replace(/"/g, '');
        if (/^-?\d/.test(s)) return s;
        if (/^[a-z]$/.test(s)) return genVarMap[s] || null; // single-letter var → look up in var map
        return null;
      };
      // Alias call (e.g. o(275,"g!Tz"))
      if (aliasMap[fnName]) {
        const al = aliasMap[fnName];
        const decFn = al.decFn;  // decoder function name (e.g. 'mU' or 'WU')
        const idxRaw = al.idxVar === 'e' ? a1Raw : a2Raw;
        const keyRaw = al.isRC4 ? (al.keyVar === 'e' ? a1Raw : a2Raw) : null;
        const idxStr = resolveArgJ(idxRaw);
        if (idxStr === null || !/^-?\d+$/.test(idxStr)) return null;
        const idxForDecoder = parseInt(idxStr) + al.offset;
        if (vDecMap[decFn]) {
          return vDec(decFn, idxForDecoder, keyRaw ? resolveArgJ(keyRaw) : null);
        }
        if (allDecoders[decFn] && allDecoders[decFn].arrFn === primaryArrFn) {
          const di = allDecoders[decFn];
          const r = idxForDecoder - di.offset;
          if (r < 0 || r >= rotatedArr.length) return null;
          return di.type === 'rc4' && keyRaw
            ? _rc4(rotatedArr[r], resolveArgJ(keyRaw))
            : _b64(rotatedArr[r]);
        }
        return null;
      }
      // Direct call to mU/WU itself (not via alias) — e.g. mU(250,"$VRW") or WU(180)
      if (vDecMap[fnName]) {
        const idxStr = resolveArgJ(a1Raw);
        if (idxStr === null || !/^-?\d+$/.test(idxStr)) return null;
        const key = a2Raw ? resolveArgJ(a2Raw) : null;
        return vDec(fnName, parseInt(idxStr), key);
      }
      if (allDecoders[fnName] && allDecoders[fnName].arrFn === primaryArrFn) {
        const di = allDecoders[fnName];
        const idxStr = resolveArgJ(a1Raw);
        if (idxStr === null || !/^-?\d+$/.test(idxStr)) return null;
        const r = parseInt(idxStr) - di.offset;
        if (r < 0 || r >= rotatedArr.length) return null;
        const key = a2Raw ? resolveArgJ(a2Raw) : null;
        return di.type === 'rc4' && key ? _rc4(rotatedArr[r], key) : _b64(rotatedArr[r]);
      }
      return null;
    }

    // Find all property-value expressions in genBody that look like:
    //   PROPNAME: "lit"+aliasCall+"lit"+... OR  PROPNAME: aliasCall+"lit"+...
    // We scan all property-colon positions and extract the value expression.
    const propScanReJ = /\b([A-Za-z_][A-Za-z0-9_]{2,})\s*:\s*("([^"\\]{0,80})"|([A-Za-z_$][A-Za-z0-9_$]{0,3})\([^)]*\))[\s\S]{0,1500}?(?=,|\}|\n\s*[A-Za-z_])/g;
    let psm;
    while ((psm = propScanReJ.exec(genBody)) !== null) {
      const propName = psm[1];
      // Skip reserved words
      if (/^(function|return|const|let|var|yield|async|await|new|throw)$/.test(propName)) continue;
      // Extract the value expression - scan from psm.index + psm[0].length - (last captured expr length)
      // Actually we need to re-extract the full value from the colon position.
      // Find the colon after propName:
      const colonPos = genBody.indexOf(':', psm.index + propName.length);
      if (colonPos < 0) continue;
      // Extract value expr up to next ',' or '}' at depth 0
      let d=0, inS=false, sc='', val='';
      let j=colonPos+1;
      while (j < genBody.length) {
        const c = genBody[j];
        if (inS) { if (c==='\\') j++; else if (c===sc) inS=false; val+=c; j++; continue; }
        if (c==='"'||c==="'") { inS=true; sc=c; val+=c; j++; continue; }
        if (c==='('||c==='['||c==='{') { d++; val+=c; j++; continue; }
        if (c===')'||c===']'||c==='}') { d--; val+=c; j++; continue; }
        if ((c===','||c==='\n') && d===0) break;
        val+=c; j++;
      }
      val = val.trim();
      if (val.length < 10) continue;

      // Now decode all mU/WU/alias calls in val, in order, concatenating with literals.
      // Tokenize: literals "..."  OR  fnName(args) calls
      const tokReJ = /"([^"\\]{0,80})"|([A-Za-z_$][A-Za-z0-9_$]{0,3})\s*\(\s*(-?\d+(?:e\d+)?|"[^"]*"|[a-z])\s*(?:,\s*(-?\d+(?:e\d+)?|"[^"]*"|[a-z]))?\)/g;
      let assembled = '', tkm;
      while ((tkm = tokReJ.exec(val)) !== null) {
        if (tkm[1] != null) { assembled += tkm[1]; continue; }
        const fn = tkm[2], a1 = tkm[3], a2 = tkm[4];
        const v = decodeCallJ(fn, a1, a2);
        if (v) assembled += v;
      }

      if (assembled.length < 15) continue;
      // Look for dg-epay path with UUID (lenient on non-hex chars in UUID
      // segments to tolerate bundle typos like 3s28 in segment 3).
      const dgMatch = assembled.match(/\/?payment\/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}\/dg-epay\/initiate/i);
      if (dgMatch) {
        dgPath = (dgMatch[0].startsWith('/') ? '' : '/') + dgMatch[0];
        console.log("  ✅ DG path via Strategy J (direct call scan, prop '" + propName + "'): " + dgPath);
        break;
      }
      // Lenient: dg-epay + something that looks UUID-ish
      if (/dg-epay/i.test(assembled) && /[0-9a-f]{8}-[0-9a-f]{4}/i.test(assembled)) {
        const uM = assembled.match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i);
        if (uM) {
          dgPath = '/payment/' + uM[0].toLowerCase() + '/dg-epay/initiate';
          console.log("  ✅ DG UUID via Strategy J (lenient UUID match, prop '" + propName + "'): " + dgPath);
          break;
        }
      }
      if (!sslPath && /ssl\/initiate|payment\/ssl/i.test(assembled)) {
        sslPath = assembled.startsWith('/') ? assembled : '/' + assembled;
        console.log("  🔓 SSL path via Strategy J: " + sslPath);
      }
    }
  }

  // ── Strategy K (NEW v13): VM-based property evaluation ──────────────────
  // Fires when A–J all fail. The most robust strategy: instead of parsing
  // alias function bodies with regex (which breaks if devs change to arrow
  // functions, ternary wrapping, multiplication, etc.), we eval each
  // property value expression in a real JS sandbox where:
  //   1. The rotated array (hU) is live
  //   2. All decoder functions (mU/WU/CU/etc.) are provided as live closures
  //   3. All alias function definitions from genBody are run as real JS
  // This means whatever shape the alias functions take — arrow, regular,
  // wrapped in ternary, etc. — the eval still produces the correct string.
  //
  // Real example: with Strategy K, even if the bundle switched from
  //   function e(e,t){return WU(t- -744)}
  // to
  //   const e=(a,b)=>WU(b+744)
  // to
  //   const e=(a,b)=>b>0?WU(b+744):mU(b,"x")
  // Strategy K still works because the alias is run as real JS, not parsed.
  if (!dgPath) {
    console.log("  ⚙️  Trying Strategy K: VM-based property evaluation...");

    try {
      // Build sandbox context
      const sandbox = {};
      ;

      // Provide hU() returning the rotated array
      sandbox.hU = function() { return rotatedArr; };

      // Provide _b64 and _rc4 helpers (decoders use these)
      sandbox._b64 = _b64;
      sandbox._rc4 = _rc4;

      // Scan src for ALL decoder functions matching the pattern:
      //   function NAME(e[,t]){e-=N; ... const n=ARR() ...}
      // and provide them in the sandbox as live closures that operate on rotatedArr.
      const decFnReK = /function\s+([A-Za-z_$][A-Za-z0-9_$]{0,3})\s*\(\s*e\s*(?:,\s*t)?\s*\)\s*\{\s*e-=(\d+)[\s\S]{0,80}(?:const|var)\s+n=([A-Za-z_$][A-Za-z0-9_$]{0,3})\s*\(\)/g;
      let dfm;
      const decodersFound = {};
      while ((dfm = decFnReK.exec(src)) !== null) {
        const fnName = dfm[1], offStr = dfm[2], arrFnName = dfm[3];
        if (arrFnName !== primaryArrFn) continue;
        const off = parseInt(offStr);
        const bodySrc = src.slice(dfm.index, dfm.index + 800);
        const isRC4 = bodySrc.includes('%t.length');
        decodersFound[fnName] = { off, isRC4 };
      }

      // Provide each decoder as a closure
      for (const [name, info] of Object.entries(decodersFound)) {
        if (sandbox[name]) continue;
        // Need to capture loop variables properly (use IIFE to avoid closure pitfall)
        const _off = info.off, _isRC4 = info.isRC4;
        sandbox[name] = function(e, t) {
          const r = e - _off;
          if (r < 0 || r >= rotatedArr.length) return '';
          return _isRC4 && t ? (_rc4(rotatedArr[r], t) || '') : (_b64(rotatedArr[r]) || '');
        };
      }

      // Extract ALL alias function definitions from genBody
      // Pattern: function NAME(e[,t]){return SOMETHING(...)}
      // Strategy K is liberal — it accepts any return shape, even ternary or arrow
      const aliasDefReK = /function\s+([a-z])\s*\(\s*e(?:\s*,\s*t)?\s*\)\s*\{[^{}]*\}/g;
      const aliasDefs = [];
      let amK;
      while ((amK = aliasDefReK.exec(genBody)) !== null) {
        // Validate it returns something (has 'return' inside)
        if (!/\breturn\b/.test(amK[0])) continue;
        aliasDefs.push(amK[0]);
      }
      // Also handle arrow-style: const e=(a,b)=>...
      const arrowDefReK = /\b(const|let|var)\s+([a-z])\s*=\s*\([^)]*\)\s*=>\s*[^,;\n}]{1,200}/g;
      while ((amK = arrowDefReK.exec(genBody)) !== null) {
        aliasDefs.push(amK[0]);
      }

      // Run all alias definitions in sandbox
      if (aliasDefs.length === 0) {
        console.log("  ⚠️  No alias functions found in genBody — Strategy K skipped");
      } else {
        try {
          sandbox.__aliasCode = aliasDefs.join('\n');
        } catch (e) {
          console.log("  ⚠️  Failed to define aliases in sandbox: " + e.message.slice(0,80));
        }

        // Find all property value expressions in genBody
        const propReK = /\b([A-Za-z_][A-Za-z0-9_]{2,})\s*:\s*("([^"\\]{0,80})"|([A-Za-z_$][A-Za-z0-9_$]{0,3})\s*\()/g;
        let pkm;
        const seenProps = new Set();
        while ((pkm = propReK.exec(genBody)) !== null) {
          const propName = pkm[1];
          if (seenProps.has(propName)) continue;
          seenProps.add(propName);
          if (/^(function|return|const|let|var|yield|async|await|new|throw)$/.test(propName)) continue;

          // Extract value expression (up to depth-0 ',' or '}' or newline)
          const colonPos = genBody.indexOf(':', pkm.index + propName.length);
          if (colonPos < 0) continue;
          let d=0, inS=false, sc='', val='';
          let j = colonPos + 1;
          while (j < genBody.length) {
            const c = genBody[j];
            if (inS) { if (c==='\\') j++; else if (c===sc) inS=false; val+=c; j++; continue; }
            if (c==='"'||c==="'") { inS=true; sc=c; val+=c; j++; continue; }
            if (c==='('||c==='['||c==='{') { d++; val+=c; j++; continue; }
            if (c===')'||c===']'||c==='}') { d--; val+=c; j++; continue; }
            if ((c===','||c==='\n') && d===0) break;
            val+=c; j++;
          }
          val = val.trim();
          if (val.length < 10) continue;
          // Must contain at least one function call OR string concatenation
          if (!/[A-Za-z_$][A-Za-z0-9_$]{0,3}\s*\(|"\+"/.test(val)) continue;

          // Eval in sandbox
          let result;
          try {
            result = _vmEvalWith(sandbox, sandbox.__aliasCode||'', val);
          } catch (e) { continue; }
          if (typeof result !== 'string' || result.length < 5) continue;

          // Check for dg-epay path
          const dgMatch = result.match(/\/?payment\/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}\/dg-epay\/initiate/i);
          if (dgMatch) {
            dgPath = (dgMatch[0].startsWith('/') ? '' : '/') + dgMatch[0];
            console.log("  ✅ DG path via Strategy K (VM eval, prop '" + propName + "'): " + dgPath);
            break;
          }
          if (/dg-epay/i.test(result) && /[0-9a-f]{8}-[0-9a-f]{4}/i.test(result)) {
            const uM = result.match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i);
            if (uM) {
              dgPath = '/payment/' + uM[0].toLowerCase() + '/dg-epay/initiate';
              console.log("  ✅ DG UUID via Strategy K (VM eval, prop '" + propName + "'): " + dgPath);
              break;
            }
          }
          if (!sslPath && /ssl\/initiate|payment\/ssl/i.test(result)) {
            sslPath = result.startsWith('/') ? result : '/' + result;
            console.log("  🔓 SSL path via Strategy K: " + sslPath);
          }
        }
      }
    } catch (eK) {
      console.log("  ⚠️  Strategy K error: " + eK.message.slice(0,80));
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
  // v12: UUID_RE_STR allows up to 1 non-hex char anywhere in the last 3
  // segments, to tolerate bundle typos like:
  //   23228961-2326-3s28-861f-465bb28337a3  (s in segment 3)
  //   139fd4d2-27c9-4758-a623-368583e830bs  (s at end of segment 5)
  // The overall shape 8-4-4-4-12 is still required.
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
  // v12: lenient UUID regex — allows non-hex chars anywhere in the UUID
  // segments, as long as overall 8-4-4-4-12 shape is preserved.
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
    if(zq424Pos>=0){let exprStart=zq424Pos;while(exprStart>0&&ctx[exprStart]!=='?'&&ctx[exprStart]!=='=')exprStart--;exprStart++;let exprEnd=zq424Pos+7,depth2=0,inStr2=false,sc2='';while(exprEnd<ctx.length){const ch=ctx[exprEnd];if(inStr2){if(ch==='\\')exprEnd++;else if(ch===sc2)inStr2=false;}else if(ch==='"'||ch==="'"){inStr2=true;sc2=ch;}else if(ch==='(')depth2++;else if(ch===')')depth2--;else if(ch===':'&&depth2===0)break;exprEnd++;}const dgPath2=decodeCalls(ctx.slice(exprStart,exprEnd).trim(),aliasDefs,varMap);if(dgPath2&&dgPath2.length>15&&/payment|[0-9a-f]{8}/.test(dgPath2))DECODED_DGEPAY_PATH=(dgPath2.startsWith('/')?'':'/')+dgPath2;}
  }
  const iv=zQdec(410)||'',iv2=PQdec(480,"0Ch2")||'',iv3=zQdec(386)||'',iv4=PQdec(467,"NPRs")||'';
  const assembled='/invo'+iv+iv2+iv3+iv4+'{txrId}';
  if(assembled.includes('/invoice/')||assembled.includes('download'))DECODED_INVOICE_PATH=assembled.replace(/\{txrId\}.*$/,'{txrId}');
}

if (DECODED_DGEPAY_PATH) {
  // v12: lenient UUID regex to handle bundle typos (non-hex chars in UUID segments)
  const uuidMatch=DECODED_DGEPAY_PATH.match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i);
  if(uuidMatch)EXTRACTED_DGEPAY_UUID=uuidMatch[0].toLowerCase();
}

if (BEST_ROT>0||USE_NEW_DECODER) console.log("🔐 Main string-array rotation: "+BEST_ROT+" ("+ACTIVE_ARR_FN+", offset="+ACTIVE_OFFSET+")");
if (DECODED_DGEPAY_PATH) console.log("🔓 Decoded DGePay path  : "+DECODED_DGEPAY_PATH);
if (DECODED_SSL_PATH)    console.log("🔓 Decoded SSL path     : "+DECODED_SSL_PATH);
if (DECODED_INVOICE_PATH)console.log("🔓 Decoded invoice path : "+DECODED_INVOICE_PATH);

// ═════════════════════════════════════════════════════════════════════════════
// ── UUID extraction & classification ─────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
const UUID_RE=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const uuidCounts={};
while((m=UUID_RE.exec(src))!==null){const u=m[0].toLowerCase();if(u==="ffffffff-ffff-ffff-ffff-ffffffffffff"||u==="00000000-0000-0000-0000-000000000000")continue;uuidCounts[u]=(uuidCounts[u]||0)+1;}
if(EXTRACTED_DGEPAY_UUID)uuidCounts[EXTRACTED_DGEPAY_UUID]=(uuidCounts[EXTRACTED_DGEPAY_UUID]||0)+1;
// ── Strategy I: Lenient slot UUID rescue ───────────────────────────────────
// v12 NEW: Some bundles contain a typo'd slot UUID where the dev put a non-hex
// char in the last segment. Real example from mtv1rx02-e9bAiBuo.js:
//   /slots/139fd4d2-27c9-4758-a623-368583e830bs/reserve-slot
//                                       ↑ trailing 's' is non-hex
// Strict UUID_RE won't match this, so SLOT_UUID falls through to NOT_FOUND and
// fetch-api.js loses the slot ID. This rescue scans /slots/<36-char>/reserve
// patterns explicitly and tolerates a non-hex char in the final segment slot.
const LENIENT_SLOT_RE=/\/slots\/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\//gi;
let _lenientSlotM;
while((_lenientSlotM=LENIENT_SLOT_RE.exec(src))!==null){
  const u=_lenientSlotM[1].toLowerCase();
  if(u==="ffffffff-ffff-ffff-ffff-ffffffffffff"||u==="00000000-0000-0000-0000-000000000000")continue;
  if(!uuidCounts[u]){
    uuidCounts[u]=(uuidCounts[u]||0)+1;
    console.log("  🔧 Lenient slot UUID rescued (non-hex trailing char tolerated): "+u);
  }
}
const realUUIDs=Object.keys(uuidCounts);
function classifyUUID(u){const ctxPos=src.indexOf(u);if(u===EXTRACTED_DGEPAY_UUID)return"DGEPAY_GATEWAY_ID";const ctx=ctxPos>=0?src.slice(Math.max(0,ctxPos-120),ctxPos+u.length+120):"";if(ctx.includes("reserve-slot")||ctx.includes("/slots/"))return"SLOT_ID";if(ctx.includes("dg-epay")||ctx.includes("dgepay")||ctx.includes("payment"))return"DGEPAY_GATEWAY_ID";return"unknown";}
const UUID_INFO={};realUUIDs.forEach(u=>{UUID_INFO[u]=classifyUUID(u);});
const SLOT_UUID=realUUIDs.find(u=>UUID_INFO[u]==="SLOT_ID")||"SLOT_ID_NOT_FOUND";
  var _dgU = EXTRACTED_DGEPAY_UUID || null;
  if (!_dgU && DECODED_DGEPAY_PATH) { var _m = DECODED_DGEPAY_PATH.match(/[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}/i); if (_m) _dgU = _m[0].toLowerCase(); }
  var _slot = (typeof SLOT_UUID !== 'undefined' && SLOT_UUID !== 'SLOT_ID_NOT_FOUND') ? SLOT_UUID : null;
  return { dgUuid: _dgU, dgPath: DECODED_DGEPAY_PATH || null, sslPath: DECODED_SSL_PATH || null, slotUuid: _slot };
}
