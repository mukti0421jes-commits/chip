#!/usr/bin/env node
// extract_ciphers.js — extract captcha ciphers from an obfuscated bundle and emit a
// clean sample-format cipher.js. Algorithms live in one REGISTRY (see ALGORITHMS).
// To support a new algorithm: add ONE entry to ALGORITHMS. Unknown algos still work
// via an embedded-runnable fallback. Every output is self-verified vs the live bundle.
//
// FIX (multi-array keys): resolveExpr now supports secrets whose obfuscated string
// pieces come from TWO different string-arrays (previously it bailed with arr!==1).
//
// Usage: node extract_ciphers.js <bundle.js> [outFile]
const fs=require("fs"), path=require("path");
const BUNDLE=process.argv[2], OUTFILE=process.argv[3]||"cipher.js";
if(!BUNDLE){console.error("usage: node extract_ciphers.js <bundle.js> [outFile]");process.exit(1);}
const src=fs.readFileSync(BUNDLE,"utf8"), lines=src.split(/\r?\n/);
const CH="0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

const ALGORITHMS = [
  { id:"LCG", detect:s=>/123456789/.test(s)&&/1103515245/.test(s)&&!/sbox/i.test(s), crypt:"cryptLCG",
    ref(token,key,skip,len,dec){return shiftCipher(token,key,skip,len,dec,(k,L)=>{
      let s=123456789,m=1103515245;for(let i=0;i<k.length;i++)s=(s+k.charCodeAt(i))>>>0;
      const o=[];for(let i=0;i<L;i++){s=(Math.imul(s,m)+12345)>>>0;m=((m+s)>>>0)|1;o.push((s>>>16)%64);}return o;});},
    source:`\n// ---- LCG additive-shift cipher (seed 123456789 / mul 1103515245) ----\nfunction generateShiftsLCG(key, length) {\n  let seed = 123456789, mul = 1103515245;\n  for (let i = 0; i < key.length; i++) seed = (seed + key.charCodeAt(i)) >>> 0;\n  const shifts = new Array(length);\n  for (let i = 0; i < length; i++) { seed = (Math.imul(seed, mul) + 12345) >>> 0; mul = ((mul + seed) >>> 0) | 1; shifts[i] = (seed >>> 16) % Charset.length; }\n  return shifts;\n}\nfunction cryptLCG(token, key, skip, encryptLen, encrypt) { return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsLCG); }` },
  { id:"MODSQ", detect:s=>/314159265/.test(s), crypt:"cryptModSquare",
    variants(ms){
      const cands=new Set();
      for(const h of (ms.match(/0x[0-9a-fA-F]{9,}/g)||[])) cands.add(BigInt(h).toString());
      const nums=[...new Set((ms.match(/\b\d{6,10}\b/g)||[]))].filter(x=>x!=="314159265");
      for(let i=0;i<nums.length;i++)for(let j=i;j<nums.length;j++){const p=BigInt(nums[i])*BigInt(nums[j]);if(p>10n**9n&&p<10n**16n)cands.add(p.toString());}
      for(const x of nums){const v=BigInt(x);if(v>10n**9n&&v<10n**16n)cands.add(v.toString());}
      const out=[];
      for(const Astr of cands){const A=BigInt(Astr);
        out.push({ crypt:"cryptModSquare",
          ref:(token,key,skip,len,dec)=>shiftCipher(token,key,skip,len,dec,(k,L)=>{let s=314159265n;for(let i=0;i<k.length;i++)s=(s+BigInt(k.charCodeAt(i))*BigInt(i+1))%A;if(s%2n===0n)s+=1n;const o=[];for(let i=0;i<L;i++){s=(s*s)%A;o.push(Number(s%64n));}return o;}),
          source:`\n// ---- Modular-squaring shift cipher (BBS-style, A = ${A}, seed 314159265) ----\nfunction generateShiftsModSquare(key, length) {\n  const A = ${A}n;\n  let s = 314159265n;\n  for (let i = 0; i < key.length; i++) s = (s + BigInt(key.charCodeAt(i)) * BigInt(i + 1)) % A;\n  if (s % 2n === 0n) s += 1n;\n  const shifts = new Array(length);\n  for (let i = 0; i < length; i++) { s = (s * s) % A; shifts[i] = Number(s % BigInt(Charset.length)); }\n  return shifts;\n}\nfunction cryptModSquare(token, key, skip, encryptLen, encrypt) { return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsModSquare); }` });
      }
      return out;
    } },
  { id:"LOGISTIC", detect:s=>/3\.99/.test(s)&&/1e7/.test(s), crypt:"cryptLogistic",
    ref(token,key,skip,len,dec){return shiftCipher(token,key,skip,len,dec,(k,L)=>{
      let u=0.5;for(let i=0;i<k.length;i++)u=(u+k.charCodeAt(i)/256)%1;if(u===0)u=0.5;
      const o=[];for(let f=0;f<L+100;f++){u=(3.99*u)*(1-u);if(f>=100)o.push(Math.floor(1e7*u)%64);}return o;});},
    source:`\n// ---- Logistic-map chaotic shift cipher (r = 3.99, 100-step warmup) ----\nfunction generateShiftsLogistic(key, length) {\n  let u = 0.5;\n  for (let i = 0; i < key.length; i++) u = (u + key.charCodeAt(i) / 256) % 1;\n  if (u === 0) u = 0.5;\n  const shifts = [];\n  for (let f = 0; f < length + 100; f++) { u = (3.99 * u) * (1 - u); if (f >= 100) shifts.push(Math.floor(1e7 * u) % Charset.length); }\n  return shifts;\n}\nfunction cryptLogistic(token, key, skip, encryptLen, encrypt) { return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsLogistic); }` },
  { id:"POLYNOMIAL", detect:s=>/%67|,67\)|\b67\b/.test(s), crypt:"cryptPolynomial",
    ref(token,key,skip,len,dec){return shiftCipher(token,key,skip,len,dec,(k,L)=>{
      const co=[];for(let n=0;n<k.length;n++)co.push(((k.charCodeAt(n%k.length)+n)%67+67)%67);
      const o=[];for(let d=1;d<=L;d++){let e=0,t=1;for(const a of co){e=(e+a*t)%67;t=(t*d)%67;}o.push(e%64);}return o;});},
    source:`\n// ---- Polynomial (GF(67)) additive-shift cipher ----\nfunction generateShiftsPolynomial(key, length) {\n  const coeff = [];\n  for (let n = 0; n < key.length; n++) coeff.push(((key.charCodeAt(n % key.length) + n) % 67 + 67) % 67);\n  const shifts = [];\n  for (let d = 1; d <= length; d++) { let e = 0, t = 1; for (const a of coeff) { e = (e + a * t) % 67; t = (t * d) % 67; } shifts.push(e % Charset.length); }\n  return shifts;\n}\nfunction cryptPolynomial(token, key, skip, encryptLen, encrypt) { return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsPolynomial); }` },
  {
    // Generic ADDITIVE-shift cipher (any per-position keystream PRNG), recovered empirically.
    id:"ADDITIVE", detect:()=>false,
    variants(ms, c){
      if(!c||!c.M||c.len<1)return [];
      const {M,secret:key,skip,len}=c;
      const tok="0".repeat(skip)+"0".repeat(len)+"00";
      const e=M.enc(tok,key,skip,len);
      const om=e.slice(skip,skip+len);
      const SHIFTS=[];for(let i=0;i<len;i++){const v=CH.indexOf(om[i]);if(v<0)return [];SHIFTS.push(v);}
      const ref=(token,k,sk,ln,dec)=>{if(!token)return token;const p=Math.max(0,Math.min(sk,token.length)),a=Math.max(0,Math.min(ln,token.length-p));if(!a)return token;let mid=token.slice(p,p+a).split("");for(let i=0;i<mid.length;i++){const x=CH.indexOf(mid[i]);if(x<0)continue;mid[i]=dec?CH[((x-SHIFTS[i])%64+64)%64]:CH[(x+SHIFTS[i])%64];}return token.slice(0,p)+mid.join("")+token.slice(p+a);};
      return [{crypt:"cryptShiftTable",ref,source:`\n// ---- Additive-shift cipher (per-position keystream recovered for this key) ----\nconst SHIFTS = [${SHIFTS.join(",")}];\nfunction cryptShiftTable(token, key, skip, encryptLen, encrypt) {\n  if (!token) return token;\n  const p = Math.max(0, Math.min(skip, token.length));\n  const a = Math.max(0, Math.min(encryptLen, token.length - p));\n  if (a === 0) return token;\n  const mid = token.slice(p, p + a).split(""), n = Charset.length;\n  for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x === -1) continue; mid[i] = encrypt ? Charset[(x + SHIFTS[i]) % n] : Charset[((x - SHIFTS[i]) % n + n) % n]; }\n  return token.slice(0, p) + mid.join("") + token.slice(p + a);\n}`}];
    },
  },
  {
    // Generic position-independent SUBSTITUTION cipher (any keyed permutation), recovered empirically.
    id:"SUBST", detect:()=>false,
    variants(ms, c){
      if(!c||!c.M||c.len<1)return [];
      const {M,secret:key,skip,len}=c;
      const build=(readPos)=>{const P=new Array(64);for(let x=0;x<64;x++){const tok="0".repeat(skip)+CH[x]+"0".repeat(len-1)+"00";const e=M.enc(tok,key,skip,len);const om=e.slice(skip,skip+len);P[x]=CH.indexOf(om[readPos]);}if(P.some(v=>v<0)||new Set(P).size!==64)return null;return P;};
      const out=[];
      for(const rev of [false,true]){
        const P=build(rev?len-1:0); if(!P)continue;
        const inv=new Array(64);for(let x=0;x<64;x++)inv[P[x]]=x;
        const ref=(token,k,sk,ln,dec)=>{if(!token)return token;const p=Math.max(0,Math.min(sk,token.length)),a=Math.max(0,Math.min(ln,token.length-p));if(!a)return token;let mid=token.slice(p,p+a).split("");if(!dec){for(let i=0;i<mid.length;i++){const x=CH.indexOf(mid[i]);if(x>=0)mid[i]=CH[P[x]];}if(rev)mid.reverse();}else{if(rev)mid.reverse();for(let i=0;i<mid.length;i++){const x=CH.indexOf(mid[i]);if(x>=0)mid[i]=CH[inv[x]];}}return token.slice(0,p)+mid.join("")+token.slice(p+a);};
        out.push({crypt:"cryptSubst",ref,source:`\n// ---- Substitution cipher (key-derived 64-element permutation${rev?" + reverse":""}) ----\nconst PERM = [${P.join(",")}];\nconst PERM_INV = (() => { const v = new Array(64); for (let i = 0; i < 64; i++) v[PERM[i]] = i; return v; })();\nfunction cryptSubst(token, key, skip, encryptLen, encrypt) {\n  if (!token) return token;\n  const p = Math.max(0, Math.min(skip, token.length));\n  const a = Math.max(0, Math.min(encryptLen, token.length - p));\n  if (a === 0) return token;\n  let mid = token.slice(p, p + a).split("");\n  if (encrypt) { for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x !== -1) mid[i] = Charset[PERM[x]]; } ${rev?"mid.reverse();":""} }\n  else { ${rev?"mid.reverse();":""} for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x !== -1) mid[i] = Charset[PERM_INV[x]]; } }\n  return token.slice(0, p) + mid.join("") + token.slice(p + a);\n}`});
      }
      return out;
    },
  },
];

function shiftCipher(token,key,skip,len,dec,gen){if(!token)return token;const p=Math.max(0,Math.min(skip,token.length)),a=Math.max(0,Math.min(len,token.length-p));if(!a)return token;const mid=token.slice(p,p+a).split(""),sh=gen(key,mid.length),n=CH.length;for(let i=0;i<mid.length;i++){const x=CH.indexOf(mid[i]);if(x<0)continue;mid[i]=dec?CH[((x-sh[i])%n+n)%n]:CH[(x+sh[i])%n];}return token.slice(0,p)+mid.join("")+token.slice(p+a);}

const SHARED_ADDITIVE = `\n// shared driver for additive-shift algorithms\nfunction additiveShift(token, key, skip, encryptLen, encrypt, genShifts) {\n  if (!token) return token;\n  const p = Math.max(0, Math.min(skip, token.length));\n  const a = Math.max(0, Math.min(encryptLen, token.length - p));\n  if (a === 0) return token;\n  const mid = token.slice(p, p + a).split("");\n  const shifts = genShifts(key, mid.length), n = Charset.length;\n  for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x === -1) continue; mid[i] = encrypt ? Charset[(x + shifts[i]) % n] : Charset[((x - shifts[i]) % n + n) % n]; }\n  return token.slice(0, p) + mid.join("") + token.slice(p + a);\n}`;

/* ================= deobfuscator + loader ================= */
function mB(s,i,o,c){let d=0;for(;i<s.length;i++){if(s[i]===o)d++;else if(s[i]===c){d--;if(d===0)return i;}}return -1;}
function mP(s,i){let d=0,q=null;for(;i<s.length;i++){const c=s[i];if(q){if(c==="\\"){i++;continue;}if(c===q)q=null;continue;}if(c==='"'||c==="'"||c==="`"){q=c;continue;}if(c==="(")d++;else if(c===")"){d--;if(d===0)return i;}}return -1;}
function b64(e){let t="",n="";for(let r,o,i=0,a=0;o=e.charAt(a++);~o&&(r=i%4?64*r+o:o,i++%4)?t+=String.fromCharCode(255&r>>(-2*i&6)):0)o="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=".indexOf(o);for(let r=0,o=t.length;r<o;r++)n+="%"+("00"+t.charCodeAt(r).toString(16)).slice(-2);try{return decodeURIComponent(n)}catch(_){return null}}
function rc4(e,key){let n,r,o=[],i=0,a="";e=b64(e);if(e===null)return null;for(r=0;r<256;r++)o[r]=r;for(r=0;r<256;r++){i=(i+o[r]+key.charCodeAt(r%key.length))%256;n=o[r];o[r]=o[i];o[i]=n;}r=0;i=0;for(let c=0;c<e.length;c++){r=(r+1)%256;i=(i+o[r])%256;n=o[r];o[r]=o[i];o[i]=n;a+=String.fromCharCode(e.charCodeAt(c)^o[(o[r]+o[i])%256]);}return a;}
const arrCache={};function getArr(fn){if(fn in arrCache)return arrCache[fn];let st=src.indexOf("function "+fn+"(){const e=[");if(st<0)st=src.indexOf("function "+fn+"(){var e=[");if(st<0)return arrCache[fn]=null;const lb=src.indexOf("[",st);return arrCache[fn]=eval(src.slice(lb,mB(src,lb,"[","]")+1));}
const baseDefs={},wrapDefs={};
{let m,re=/function ([\w$]+)\((?:e,t|e)\)\{e-=(\d+)/g;while(m=re.exec(src)){const bs=src.indexOf("{",m.index);const body=src.slice(bs,mB(src,bs,"{","}")+1);const am=/=\s*([\w$]+)\(\)/.exec(body);(baseDefs[m[1]]=baseDefs[m[1]]||[]).push({idx:m.index,offset:+m[2],arrfn:am?am[1]:null,rc4:/o\[r\]\+t\.charCodeAt/.test(body)||/charCodeAt\(\w%\w\.length\)/.test(body)});}}
{let m,re=/function ([\w$]+)\((?:e,t|e)\)\{return ([\w$]+)\(/g;while(m=re.exec(src)){if(baseDefs[m[1]])continue;const ci=src.indexOf("(",src.indexOf("return",m.index)+6);(wrapDefs[m[1]]=wrapDefs[m[1]]||[]).push({idx:m.index,base:m[2],inner:src.slice(ci+1,mP(src,ci))});}}
function nearest(map,name,pos){const a=map[name];if(!a)return null;let b=null;for(const d of a)if(b===null||Math.abs(d.idx-pos)<Math.abs(b.idx-pos))b=d;return b;}

// ---- FIX: resolveExpr now supports 1 OR 2 string-arrays (rotation brute-forced per array) ----
function resolveExpr(expr,pos){
  const calls=x=>[...new Set((x.match(/([A-Za-z_$][\w$]*)\(/g)||[]).map(t=>t.slice(0,-1)))];
  const need={base:{},wrap:{}};const arrset=new Set();const stack=calls(expr);
  while(stack.length){const n=stack.pop();if(need.base[n]||need.wrap[n])continue;
    const w=nearest(wrapDefs,n,pos),b=nearest(baseDefs,n,pos);
    if(w&&(!b||Math.abs(w.idx-pos)<Math.abs(b.idx-pos))){need.wrap[n]=w;for(const x of calls(w.inner))stack.push(x);stack.push(w.base);}
    else if(b){need.base[n]=b;if(b.arrfn)arrset.add(b.arrfn);}}
  const arr=[...arrset];
  if(arr.length===0||arr.length>2)return null;   // 1 or 2 arrays supported
  const bases=arr.map(getArr);
  if(bases.some(b=>!b))return null;
  // compile the decoder+expr ONCE; arrays are supplied per-rotation via __arrs
  let code="";
  for(const[n,d]of Object.entries(need.base))code+=`const ${n}=(e,t)=>{const r=__arrs[${JSON.stringify(d.arrfn)}][e-${d.offset}];return r===undefined?null:(${d.rc4?"__rc4(r,t)":"__b64(r)"});};\n`;
  for(const[n,w]of Object.entries(need.wrap))code+=`function ${n}(e,t){return ${w.base}(${w.inner})}\n`;
  let fn;try{fn=new Function("__arrs","__rc4","__b64",code+"return ("+expr+")");}catch(e){return null;}
  const rot=(a,r)=>a.slice(r).concat(a.slice(0,r));
  const ok=v=>typeof v==="string"&&/^[\x20-\x7e]+$/.test(v)&&v.length>=3;
  if(arr.length===1){
    for(let r=0;r<bases[0].length;r++){try{const v=fn({[arr[0]]:rot(bases[0],r)},rc4,b64);if(ok(v))return v;}catch(e){}}
    return null;
  }
  // two arrays: brute force both rotations (compiled fn keeps it fast)
  for(let r0=0;r0<bases[0].length;r0++){const A0=rot(bases[0],r0);
    for(let r1=0;r1<bases[1].length;r1++){try{const v=fn({[arr[0]]:A0,[arr[1]]:rot(bases[1],r1)},rc4,b64);if(ok(v))return v;}catch(e){}}}
  return null;
}

const verToVar={};{let m,re=/(\d+):\(\)=>[^,]*?Promise\.resolve\(\)\.then\(\(\)=>([\w$]+)\)/g;while(m=re.exec(src))verToVar[+m[1]]=m[2];}
const modByVar={};lines.forEach((l,i)=>{const r=/(?:const )?([\w$]+)=Object\.freeze\(Object\.defineProperty\(\{__proto__:null,decryptText:([\w$]+),encryptText:([\w$]+)\}/.exec(l);if(r)modByVar[r[1]]={freeze:i,dec:r[2],enc:r[3]};});
const freezeLines=Object.values(modByVar).map(m=>m.freeze).sort((a,b)=>a-b);
function moduleSource(v){const mod=modByVar[v];if(!mod)return "";const prev=freezeLines.filter(f=>f<mod.freeze).pop();return lines.slice((prev!==undefined?prev+1:mod.freeze-180),mod.freeze+1).join("\n");}
function loadModule(v){const mod=modByVar[v];if(!mod)return null;const prev=freezeLines.filter(f=>f<mod.freeze).pop();const next=freezeLines.filter(f=>f>mod.freeze)[0];const nnext=freezeLines.filter(f=>f>(next!==undefined?next:mod.freeze))[0];const probe="0aQ9bZx7Yw2Kp3Lm8Nn4Vc5Tr6Hg1Df0SjABCxyz";const lo=prev!==undefined?prev+1:Math.max(0,mod.freeze-260);const starts=[];for(let s=lo;s<=mod.freeze;s++)if(s===lo||/^function |^const |^var |^!function/.test(lines[s]))starts.push(s);const ends=[mod.freeze];if(next!==undefined)ends.push(next-1,next);if(nnext!==undefined)ends.push(nnext-1);ends.push(Math.min(lines.length-1,mod.freeze+120));for(const e of ends)for(const s of starts){if(s>e)continue;let region=lines.slice(s,e+1).join("\n");const vars=[region];{let bal=0,par=0,q=null,cut=region.length;for(let k=0;k<region.length;k++){const ch=region[k];if(q){if(ch==="\\"){k++;continue;}if(ch===q)q=null;continue;}if(ch==='"'||ch==="'"||ch==="`"){q=ch;continue;}if(ch==="{")bal++;else if(ch==="}"){bal--;if(bal<0){cut=k;break;}}else if(ch==="(")par++;else if(ch===")"){par--;if(par<0){cut=k;break;}}}if(cut<region.length)vars.push(region.slice(0,cut));}for(const rg of vars){try{const M=new Function(rg+`\n;return {enc:${mod.enc},dec:${mod.dec}};`)();if(M&&typeof M.enc==="function"){const x=M.enc(probe,"k3yProbe!",3,15);if(typeof x==="string"&&M.dec(x,"k3yProbe!",3,15)===probe)return {M,region:rg};}}catch(_){}}}return null;}
function roleScores(pos){const w=src.slice(Math.max(0,pos-1400),pos+1400);
  const rM=w.match(/reserve|slot|booking|appointment|schedul/gi)||[];
  const sM=w.match(/sign-?in|signin|log-?in|login|\botp\b|verify|password|phone|forgot|forget|resend|signup/gi)||[];
  return {sig:sM.length, res:rM.length, sigEv:[...new Set(sM.map(x=>x.toLowerCase()))], resEv:[...new Set(rM.map(x=>x.toLowerCase()))]};}

/* ================= find configs, match algorithms, emit ================= */
const cfgRe=/\{secret:([^{}]*?),startAt:(-?\d+),length:(-?\d+),version:(\d+)\}/g;
const found=[];let cm;
while(cm=cfgRe.exec(src)){const secret=resolveExpr(cm[1],cm.index);if(!secret){console.log("[warn] config version",cm[4],"secret decode FAILED @",cm.index);continue;}const sc=roleScores(cm.index);found.push({secret,skip:+cm[2],len:+cm[3],version:+cm[4],sig:sc.sig,res:sc.res,sigEv:sc.sigEv,resEv:sc.resEv});}
const uniq=[];const seen=new Map();
for(const c of found){const k=c.version+"|"+c.secret;if(seen.has(k)){const e=seen.get(k);e.sig+=c.sig;e.res+=c.res;e.sigEv=[...new Set([...e.sigEv,...c.sigEv])];e.resEv=[...new Set([...e.resEv,...c.resEv])];continue;}const e={...c};seen.set(k,e);uniq.push(e);}
let roleUncertain=false;
for(const c of uniq){ if(c.sig>c.res)c.role="Signin"; else if(c.res>c.sig)c.role="Reserve"; else {c.role=null;roleUncertain=true;} }
if(uniq.length===2){const known=uniq.filter(c=>c.role), unknown=uniq.filter(c=>!c.role);if(known.length===1&&unknown.length===1){unknown[0].role=known[0].role==="Signin"?"Reserve":"Signin";unknown[0]._inferred=true;roleUncertain=false;}}

function rnd(n){let s="";for(let i=0;i<n;i++)s+=CH[Math.floor(Math.random()*64)];return s;}
for(const c of uniq){
  const ms=moduleSource(verToVar[c.version]);
  const LM=loadModule(verToVar[c.version]); c.M=LM&&LM.M; c.region=LM&&LM.region;
  c.enc=modByVar[verToVar[c.version]].enc; c.dec=modByVar[verToVar[c.version]].dec;
  c.algo=null;
  const order=[...ALGORITHMS].sort((a,b)=>(b.detect(ms)?1:0)-(a.detect(ms)?1:0));
  for(const A of order){ if(!c.M)continue;
    let variants; try{ variants = A.variants ? A.variants(ms, c) : [{ref:A.ref, source:A.source, crypt:A.crypt}]; }catch(_){ variants=[]; }
    for(const v of variants){ let ok=true;for(let i=0;i<60;i++){const t=rnd(1+Math.floor(Math.random()*50));let got;try{got=v.ref(t,c.secret,c.skip,c.len,false);}catch(_){ok=false;break;}if(got!==c.M.enc(t,c.secret,c.skip,c.len)){ok=false;break;}} if(ok){ c.algo={id:A.id, crypt:v.crypt||A.crypt, source:v.source}; break; } }
    if(c.algo)break;
  }
}
{const counts={};for(const c of uniq){const base=c.role||("V"+c.version);counts[base]=(counts[base]||0)+1;}
 const used={};for(const c of uniq){let base=c.role||("V"+c.version);if(counts[base]>1){used[base]=(used[base]||0)+1;c.role=base+"V"+c.version;}else c.role=base;}}

console.log("=== extracted ciphers ===");
for(const c of uniq){
  console.log(`role=${c.role} version=${c.version} algo=${c.algo?c.algo.id:"(unknown→embedded)"} skip=${c.skip} len=${c.len}`);
  console.log(`   key=${JSON.stringify(c.secret)}`);
  console.log(`   role evidence: Signin[${c.sigEv.join(",")||"-"}](${c.sig}) vs Reserve[${c.resEv.join(",")||"-"}](${c.res})${c._inferred?"  [inferred]":""}`);
}
if(roleUncertain) console.log("\n   ⚠️  ROLE UNCERTAIN — math verified but Signin/Reserve label may be wrong; check evidence above.");

// ================= emit cipher.js =================
let head=`// cipher.js — AUTO-GENERATED clean port (sample format).\n// Reverse-engineered + verified byte-for-byte against the live bundle.\n\nconst Charset = "${CH}";\n\nfunction charsetIndex(ch) { return Charset.indexOf(ch); }\n`;
let cfgs="", footerNames=[];
const usedAlgos=new Set(uniq.filter(c=>c.algo).map(c=>c.algo.id));
for(const c of uniq){
  const R=c.role;
  if(c.algo){
    cfgs+=`\n// ${R} cipher (version ${c.version}, ${c.algo.id})\nconst ${R}Key = ${JSON.stringify(c.secret)};\nconst ${R}Skip = ${c.skip};\nconst ${R}EncryptLen = ${c.len};\nfunction ProcessToken${R}(token) { return ${c.algo.crypt}(token, ${R}Key, ${R}Skip, ${R}EncryptLen, true); }\nfunction ReverseToken${R}(token) { return ${c.algo.crypt}(token, ${R}Key, ${R}Skip, ${R}EncryptLen, false); }\n`;
  } else if(c.region){
    cfgs+=`\n// ${R} cipher (version ${c.version}, unrecognized) — embedded runnable fallback (verified)\nconst _mod_${R} = (function(){\n${c.region}\nreturn { enc:${c.enc}, dec:${c.dec} };\n})();\nconst ${R}Key = ${JSON.stringify(c.secret)};\nconst ${R}Skip = ${c.skip};\nconst ${R}EncryptLen = ${c.len};\nfunction ProcessToken${R}(token) { return _mod_${R}.enc(token, ${R}Key, ${R}Skip, ${R}EncryptLen); }\nfunction ReverseToken${R}(token) { return _mod_${R}.dec(token, ${R}Key, ${R}Skip, ${R}EncryptLen); }\n`;
  } else continue;
  footerNames.push(R+"Key",R+"Skip",R+"EncryptLen","ProcessToken"+R,"ReverseToken"+R);
}
const roleList=uniq.filter(c=>c.algo||c.region).map(c=>c.role);
let routerSrc="\n// ---- Router: encryptToken(rawToken, purpose) / decryptToken(rawToken, purpose) ----\nfunction encryptToken(rawToken, purpose) {\n";
for(const R of roleList) routerSrc+=`  if (purpose === ${JSON.stringify(R)}) return ProcessToken${R}(rawToken);\n`;
routerSrc+="  return rawToken;\n}\nfunction decryptToken(rawToken, purpose) {\n";
for(const R of roleList) routerSrc+=`  if (purpose === ${JSON.stringify(R)}) return ReverseToken${R}(rawToken);\n`;
routerSrc+="  return rawToken;\n}\nfunction ProcessToken(rawToken, purpose) { return encryptToken(rawToken, purpose); }\nfunction ReverseToken(rawToken, purpose) { return decryptToken(rawToken, purpose); }\n";
footerNames.push("encryptToken","decryptToken","ProcessToken","ReverseToken");
let algoSrc="";
if([...usedAlgos].some(id=>["LCG","MODSQ","LOGISTIC","POLYNOMIAL","ADDITIVE"].includes(id))) algoSrc+=SHARED_ADDITIVE+"\n";
const emitted=new Set();
for(const c of uniq){ if(c.algo&&c.algo.source&&!emitted.has(c.algo.source)){ emitted.add(c.algo.source); algoSrc+=c.algo.source+"\n"; } }
const out=head+cfgs+"\n"+routerSrc+"\n"+algoSrc+`\nif (typeof module !== "undefined") {\n  module.exports = { Charset, ${footerNames.join(", ")} };\n}\n`;
fs.writeFileSync(OUTFILE,out);
console.log(`\n=> wrote ${OUTFILE}`);

// self-verify byte-for-byte vs the live bundle
delete require.cache[require.resolve(path.resolve(OUTFILE))];
const G=require(path.resolve(OUTFILE));let pass=0,fail=0;
for(const c of uniq){const R=c.role;const P=G["ProcessToken"+R],V=G["ReverseToken"+R];if(!P||!c.M){console.log(`[SELF-TEST] ${R}: MISSING`);fail++;continue;}let ok=true;for(let i=0;i<300;i++){const t=rnd(1+Math.floor(Math.random()*60));const mine=P(t);if(mine!==c.M.enc(t,c.secret,c.skip,c.len)||V(mine)!==t){ok=false;break;}}console.log(`[SELF-TEST] ${R.padEnd(8)} (v${c.version}, ${c.algo?c.algo.id:"embedded"}): ${ok?"PASS ✓":"FAIL ✗"}`);ok?pass++:fail++;}
console.log(`\n=> GUARANTEE: ${pass}/${pass+fail} verified identical to the live bundle.`);
if(fail===0&&pass>0&&found.length){console.log("   ✅ 100% OK — every emitted cipher is byte-for-byte identical to the live bundle.");process.exit(0);}
else{console.log("   ⚠️  could not fully verify — send the bundle so the parser can be updated.");process.exit(1);}
