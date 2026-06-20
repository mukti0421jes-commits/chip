#!/usr/bin/env node
// cipher_tool.js — extract captcha ciphers from an obfuscated bundle and emit a
// clean sample-format cipher.js. Algorithms live in one REGISTRY (see ALGORITHMS).
// To support a new algorithm: add ONE entry to ALGORITHMS. Unknown algos still work
// via an embedded-runnable fallback. Every output is self-verified vs the live bundle.
//
// Usage: node cipher_tool.js <bundle.js> [outFile]
const fs=require("fs"), path=require("path");
const BUNDLE=process.argv[2], OUTFILE=process.argv[3]||"cipher.js";
if(!BUNDLE){console.error("usage: node cipher_tool.js <bundle.js> [outFile]");process.exit(1);}
const src=fs.readFileSync(BUNDLE,"utf8"), lines=src.split(/\r?\n/);
const CH="0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

/* =======================================================================
   ALGORITHM REGISTRY  — one entry per algorithm.
   id      : short name shown in comments
   detect  : (moduleSource) => true if this algorithm is present
   ref     : clean reference impl used to VERIFY against the live bundle
   crypt   : name of the clean crypt function emitted into the output
   source  : the clean readable helper code emitted into cipher.js
   ======================================================================= */
const ALGORITHMS = [
  {
    id:"LCG",
    detect:s=>/123456789/.test(s)&&/1103515245/.test(s)&&!/sbox/i.test(s),
    crypt:"cryptLCG",
    ref(token,key,skip,len,dec){return shiftCipher(token,key,skip,len,dec,(k,L)=>{
      let s=123456789,m=1103515245;for(let i=0;i<k.length;i++)s=(s+k.charCodeAt(i))>>>0;
      const o=[];for(let i=0;i<L;i++){s=(Math.imul(s,m)+12345)>>>0;m=((m+s)>>>0)|1;o.push((s>>>16)%64);}return o;});},
    source:`
// ---- LCG additive-shift cipher (seed 123456789 / mul 1103515245) ----
function generateShiftsLCG(key, length) {
  let seed = 123456789, mul = 1103515245;
  for (let i = 0; i < key.length; i++) seed = (seed + key.charCodeAt(i)) >>> 0;
  const shifts = new Array(length);
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, mul) + 12345) >>> 0;
    mul = ((mul + seed) >>> 0) | 1;
    shifts[i] = (seed >>> 16) % Charset.length;
  }
  return shifts;
}
function cryptLCG(token, key, skip, encryptLen, encrypt) {
  return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsLCG);
}`
  },
  {
    id:"MODSQ",
    detect:s=>/314159265/.test(s),
    crypt:"cryptModSquare",
    // dynamic: the modulus A changes between bundles (hex literal OR product of two primes).
    // Build candidate moduli from the module source; the correct one is picked by byte-for-byte verification.
    variants(ms){
      const cands=new Set();
      for(const h of (ms.match(/0x[0-9a-fA-F]{9,}/g)||[])) cands.add(BigInt(h).toString());
      const nums=[...new Set((ms.match(/\b\d{6,10}\b/g)||[]))].filter(x=>x!=="314159265");
      for(let i=0;i<nums.length;i++)for(let j=i;j<nums.length;j++){const p=BigInt(nums[i])*BigInt(nums[j]);if(p>10n**9n&&p<10n**16n)cands.add(p.toString());}
      for(const x of nums){const v=BigInt(x);if(v>10n**9n&&v<10n**16n)cands.add(v.toString());}
      const out=[];
      for(const Astr of cands){const A=BigInt(Astr);
        out.push({
          crypt:"cryptModSquare",
          ref:(token,key,skip,len,dec)=>shiftCipher(token,key,skip,len,dec,(k,L)=>{let s=314159265n;for(let i=0;i<k.length;i++)s=(s+BigInt(k.charCodeAt(i))*BigInt(i+1))%A;if(s%2n===0n)s+=1n;const o=[];for(let i=0;i<L;i++){s=(s*s)%A;o.push(Number(s%64n));}return o;}),
          source:`
// ---- Modular-squaring shift cipher (BBS-style, A = ${A}, seed 314159265) ----
function generateShiftsModSquare(key, length) {
  const A = ${A}n;
  let s = 314159265n;
  for (let i = 0; i < key.length; i++) s = (s + BigInt(key.charCodeAt(i)) * BigInt(i + 1)) % A;
  if (s % 2n === 0n) s += 1n;
  const shifts = new Array(length);
  for (let i = 0; i < length; i++) { s = (s * s) % A; shifts[i] = Number(s % BigInt(Charset.length)); }
  return shifts;
}
function cryptModSquare(token, key, skip, encryptLen, encrypt) {
  return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsModSquare);
}`
        });
      }
      return out;
    },
  },
  {
    id:"SBOX_REV",
    detect:s=>/sbox|invSbox/i.test(s)&&/reverse\(/.test(s),
    crypt:"cryptSBox",
    ref(token,key,skip,len,dec){if(!token)return token;const p=Math.max(0,Math.min(skip,token.length)),a=Math.max(0,Math.min(len,token.length-p));if(!a)return token;
      let mid=token.slice(p,p+a).split("");const n=CH.length;const sb=Array.from({length:n},(_,i)=>i);let u=0;for(let h=0;h<n;h++){u=(u+sb[h]+key.charCodeAt(h%key.length))%n;[sb[h],sb[u]]=[sb[u],sb[h]];}const inv=new Array(n);for(let h=0;h<n;h++)inv[sb[h]]=h;
      if(!dec){for(let i=0;i<mid.length;i++){const x=CH.indexOf(mid[i]);if(x>=0)mid[i]=CH[sb[x]];}mid.reverse();}else{mid.reverse();for(let i=0;i<mid.length;i++){const x=CH.indexOf(mid[i]);if(x>=0)mid[i]=CH[inv[x]];}}
      return token.slice(0,p)+mid.join("")+token.slice(p+a);},
    source:`
// ---- RC4-keyed 64-element S-box substitution + reverse ----
function buildSBox(key) {
  const n = Charset.length;
  const sbox = Array.from({ length: n }, (_, i) => i);
  let u = 0;
  for (let h = 0; h < n; h++) { u = (u + sbox[h] + key.charCodeAt(h % key.length)) % n; [sbox[h], sbox[u]] = [sbox[u], sbox[h]]; }
  const inv = new Array(n); for (let h = 0; h < n; h++) inv[sbox[h]] = h;
  return { sbox, inv };
}
function cryptSBox(token, key, skip, encryptLen, encrypt) {
  if (!token) return token;
  const p = Math.max(0, Math.min(skip, token.length));
  const a = Math.max(0, Math.min(encryptLen, token.length - p));
  if (a === 0) return token;
  let mid = token.slice(p, p + a).split("");
  const { sbox, inv } = buildSBox(key);
  if (encrypt) { for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x !== -1) mid[i] = Charset[sbox[x]]; } mid.reverse(); }
  else { mid.reverse(); for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x !== -1) mid[i] = Charset[inv[x]]; } }
  return token.slice(0, p) + mid.join("") + token.slice(p + a);
}`
  },
  {
    id:"LOGISTIC",
    detect:s=>/3\.99/.test(s)&&/1e7/.test(s),
    crypt:"cryptLogistic",
    ref(token,key,skip,len,dec){return shiftCipher(token,key,skip,len,dec,(k,L)=>{
      let u=0.5;for(let i=0;i<k.length;i++)u=(u+k.charCodeAt(i)/256)%1;if(u===0)u=0.5;
      const o=[];for(let f=0;f<L+100;f++){u=(3.99*u)*(1-u);if(f>=100)o.push(Math.floor(1e7*u)%64);}return o;});},
    source:`
// ---- Logistic-map chaotic shift cipher (r = 3.99, 100-step warmup) ----
function generateShiftsLogistic(key, length) {
  let u = 0.5;
  for (let i = 0; i < key.length; i++) u = (u + key.charCodeAt(i) / 256) % 1;
  if (u === 0) u = 0.5;
  const shifts = [];
  for (let f = 0; f < length + 100; f++) {
    u = (3.99 * u) * (1 - u);
    if (f >= 100) shifts.push(Math.floor(1e7 * u) % Charset.length);
  }
  return shifts;
}
function cryptLogistic(token, key, skip, encryptLen, encrypt) {
  return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsLogistic);
}`
  },
  {
    id:"CHACHA",
    detect:s=>/<<7\|/.test(s)&&/<<12/.test(s),
    crypt:"cryptChaCha",
    ref(token,key,skip,len,dec){return shiftCipher(token,key,skip,len,dec,(k,L)=>{
      const rotl=(x,n)=>((x<<n)|(x>>>(32-n)))>>>0;
      const qr=(e,a,b,c,d)=>{e[a]=(e[a]+e[b])>>>0;e[d]=rotl(e[d]^e[a],16);e[c]=(e[c]+e[d])>>>0;e[b]=rotl(e[b]^e[c],12);e[a]=(e[a]+e[b])>>>0;e[d]=rotl(e[d]^e[a],8);e[c]=(e[c]+e[d])>>>0;e[b]=rotl(e[b]^e[c],7);};
      const st=new Array(16).fill(0);for(let p=0;p<k.length;p++)st[p%16]=(st[p%16]+k.charCodeAt(p))>>>0;st[15]=L;
      const o=[];const blocks=Math.ceil(L/4);for(let p=0;p<blocks;p++){st[14]=p;const e=st.slice();for(let r=0;r<10;r++){qr(e,0,4,8,12);qr(e,1,5,9,13);qr(e,2,6,10,14);qr(e,3,7,11,15);}for(let kk=0;kk<4;kk++)o.push((e[kk]>>>0)%64);}return o;});},
    source:`
// ---- ChaCha-style keystream shift cipher (16-word state, 10 column rounds) ----
function rotl32(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
function chachaQR(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl32(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl32(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl32(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl32(s[b] ^ s[c], 7);
}
function generateShiftsChaCha(key, length) {
  const st = new Array(16).fill(0);
  for (let p = 0; p < key.length; p++) st[p % 16] = (st[p % 16] + key.charCodeAt(p)) >>> 0;
  st[15] = length;
  const shifts = [];
  const blocks = Math.ceil(length / 4);
  for (let p = 0; p < blocks; p++) {
    st[14] = p;
    const e = st.slice();
    for (let r = 0; r < 10; r++) {
      chachaQR(e, 0, 4, 8, 12); chachaQR(e, 1, 5, 9, 13); chachaQR(e, 2, 6, 10, 14); chachaQR(e, 3, 7, 11, 15);
    }
    for (let k = 0; k < 4; k++) shifts.push((e[k] >>> 0) % Charset.length);
  }
  return shifts;
}
function cryptChaCha(token, key, skip, encryptLen, encrypt) {
  return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsChaCha);
}`
  },
  // ===================== added: the remaining 5 algorithms =====================
  {
    id:"BITMIX",   // 6-bit Feistel network (8 rounds, F = 7&((x*3+k)^3))
    detect:s=>/<<3\|/.test(s)&&/1103515245/.test(s),
    crypt:"cryptBitmix",
    ref(token,key,skip,len,dec){if(!token)return token;const p=Math.max(0,Math.min(skip,token.length)),a=Math.max(0,Math.min(len,token.length-p));if(!a)return token;
      let c=0;for(let f=0;f<key.length;f++)c=(c+key.charCodeAt(f)*(f+1))>>>0;const rk=[];for(let f=0;f<8;f++){c=(Math.imul(c,1103515245)+12345)>>>0;rk.push(c&7);}
      const F=(e,t)=>7&((e*3+t)^3);
      const fwd=v=>{let hi=(v>>3)&7,lo=v&7;for(let r=0;r<rk.length;r++){const x=hi^F(lo,rk[r]);hi=lo;lo=x;}return (lo<<3)|hi;};
      const inv=v=>{let lo=(v>>3)&7,hi=v&7;for(let r=rk.length-1;r>=0;r--){const x=hi;hi=lo^F(x,rk[r]);lo=x;}return (hi<<3)|lo;};
      const mid=token.slice(p,p+a).split("");for(let i=0;i<mid.length;i++){const x=CH.indexOf(mid[i]);if(x<0)continue;mid[i]=CH[(dec?inv(x):fwd(x))%64];}
      return token.slice(0,p)+mid.join("")+token.slice(p+a);},
    source:`
// ---- 6-bit Feistel substitution cipher (8 rounds, round F = 7&((x*3+k)^3)) ----
function bitmixRoundKeys(key) {
  let c = 0;
  for (let f = 0; f < key.length; f++) c = (c + key.charCodeAt(f) * (f + 1)) >>> 0;
  const rk = [];
  for (let f = 0; f < 8; f++) { c = (Math.imul(c, 1103515245) + 12345) >>> 0; rk.push(c & 7); }
  return rk;
}
function bitmixForward(val, rk) {
  let hi = (val >> 3) & 7, lo = val & 7;
  for (let r = 0; r < rk.length; r++) { const x = hi ^ (7 & ((lo * 3 + rk[r]) ^ 3)); hi = lo; lo = x; }
  return (lo << 3) | hi;
}
function bitmixInverse(val, rk) {
  let lo = (val >> 3) & 7, hi = val & 7;
  for (let r = rk.length - 1; r >= 0; r--) { const x = hi; hi = lo ^ (7 & ((x * 3 + rk[r]) ^ 3)); lo = x; }
  return (hi << 3) | lo;
}
function cryptBitmix(token, key, skip, encryptLen, encrypt) {
  if (!token) return token;
  const p = Math.max(0, Math.min(skip, token.length));
  const a = Math.max(0, Math.min(encryptLen, token.length - p));
  if (a === 0) return token;
  const mid = token.slice(p, p + a).split(""), rk = bitmixRoundKeys(key);
  for (let i = 0; i < mid.length; i++) {
    const x = charsetIndex(mid[i]); if (x === -1) continue;
    mid[i] = Charset[(encrypt ? bitmixForward(x, rk) : bitmixInverse(x, rk)) % Charset.length];
  }
  return token.slice(0, p) + mid.join("") + token.slice(p + a);
}`
  },
  {
    id:"CELLULAR",   // elementary cellular automaton, Rule 30
    detect:s=>/Uint8Array\(64\)/.test(s),
    crypt:"cryptCellular",
    ref(token,key,skip,len,dec){return shiftCipher(token,key,skip,len,dec,(k,L)=>{
      let cur=new Uint8Array(64);for(let i=0;i<k.length;i++)cur[i%64]^=(k.charCodeAt(i)&1);cur[32]=1;
      const o=[];for(let s=0;s<L;s++){const nx=new Uint8Array(64);let v=0;for(let d=0;d<64;d++){const Lc=cur[(d+63)%64],C=cur[d],R=cur[(d+1)%64];nx[d]=(30>>((Lc<<2)|(C<<1)|R))&1;if(d<6)v=(v<<1)|nx[d];}cur=nx;o.push(v%64);}return o;});},
    source:`
// ---- Rule-30 cellular-automaton additive-shift cipher ----
function generateShiftsCellular(key, length) {
  let cur = new Uint8Array(64);
  for (let i = 0; i < key.length; i++) cur[i % 64] ^= (key.charCodeAt(i) & 1);
  cur[32] = 1;
  const shifts = [];
  for (let s = 0; s < length; s++) {
    const nx = new Uint8Array(64); let v = 0;
    for (let d = 0; d < 64; d++) {
      const L = cur[(d + 63) % 64], C = cur[d], R = cur[(d + 1) % 64];
      nx[d] = (30 >> ((L << 2) | (C << 1) | R)) & 1;   // Rule 30
      if (d < 6) v = (v << 1) | nx[d];
    }
    cur = nx; shifts.push(v % Charset.length);
  }
  return shifts;
}
function cryptCellular(token, key, skip, encryptLen, encrypt) {
  return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsCellular);
}`
  },
  {
    id:"RC4",   // RC4 over a 64-element state
    detect:s=>/256|q\$/.test(s)&&!/reverse\(/.test(s)&&!/3\.99/.test(s),
    crypt:"cryptRC4",
    ref(token,key,skip,len,dec){return shiftCipher(token,key,skip,len,dec,(k,L)=>{
      const SZ=64,S=Array.from({length:SZ},(_,i)=>i);let j=0;for(let i=0;i<SZ;i++){j=(j+S[i]+k.charCodeAt(i%k.length))%SZ;const t=S[i];S[i]=S[j];S[j]=t;}
      let i=0;j=0;const o=[];for(let x=0;x<L;x++){i=(i+1)%SZ;j=(j+S[i])%SZ;const t=S[i];S[i]=S[j];S[j]=t;o.push(S[(S[i]+S[j])%SZ]);}return o;});},
    source:`
// ---- RC4 (64-element state) additive-shift cipher ----
function generateShiftsRC4(key, length) {
  const SZ = 64, S = Array.from({ length: SZ }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < SZ; i++) { j = (j + S[i] + key.charCodeAt(i % key.length)) % SZ; [S[i], S[j]] = [S[j], S[i]]; }
  let i = 0; j = 0; const shifts = [];
  for (let k = 0; k < length; k++) { i = (i + 1) % SZ; j = (j + S[i]) % SZ; [S[i], S[j]] = [S[j], S[i]]; shifts.push(S[(S[i] + S[j]) % SZ]); }
  return shifts;
}
function cryptRC4(token, key, skip, encryptLen, encrypt) {
  return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsRC4);
}`
  },
  {
    id:"LFSR",   // three LFSRs combined by a Geffe generator
    detect:s=>/74565|424090|773615/.test(s),
    crypt:"cryptLFSR",
    ref(token,key,skip,len,dec){return shiftCipher(token,key,skip,len,dec,(k,L)=>{
      let u=74565,s=424090,l=773615;for(let i=0;i<k.length;i++){const c=k.charCodeAt(i);u^=(c|1);s^=1|(c<<2);l^=1|(c<<4);}
      const o=[];for(let p=0;p<L;p++){let e=0;for(let t=0;t<6;t++){const ub=1&(u^u>>2^u>>3^u>>5);u=(u>>>1)|(ub<<15);const sb=1&(s^s>>1^s>>2^s>>7);s=(s>>>1)|(sb<<16);const lb=1&(l^l>>1^l>>2^l>>22);l=(l>>>1)|(lb<<23);const h=(ub&sb)^(~ub&lb);e=(e<<1)|h;}o.push(((e%64)+64)%64);}return o;});},
    source:`
// ---- Three-LFSR Geffe-generator additive-shift cipher ----
function generateShiftsLFSR(key, length) {
  let u = 74565, s = 424090, l = 773615;
  for (let i = 0; i < key.length; i++) { const c = key.charCodeAt(i); u ^= (c | 1); s ^= 1 | (c << 2); l ^= 1 | (c << 4); }
  const shifts = [];
  for (let p = 0; p < length; p++) {
    let e = 0;
    for (let t = 0; t < 6; t++) {
      const ub = 1 & (u ^ u >> 2 ^ u >> 3 ^ u >> 5); u = (u >>> 1) | (ub << 15);
      const sb = 1 & (s ^ s >> 1 ^ s >> 2 ^ s >> 7); s = (s >>> 1) | (sb << 16);
      const lb = 1 & (l ^ l >> 1 ^ l >> 2 ^ l >> 22); l = (l >>> 1) | (lb << 23);
      const h = (ub & sb) ^ (~ub & lb);   // Geffe combiner
      e = (e << 1) | h;
    }
    shifts.push(((e % Charset.length) + Charset.length) % Charset.length);
  }
  return shifts;
}
function cryptLFSR(token, key, skip, encryptLen, encrypt) {
  return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsLFSR);
}`
  },
  {
    id:"POLYNOMIAL",   // Horner polynomial evaluation over GF(67)
    detect:s=>/%67|,67\)|\b67\b/.test(s),
    crypt:"cryptPolynomial",
    ref(token,key,skip,len,dec){return shiftCipher(token,key,skip,len,dec,(k,L)=>{
      const co=[];for(let n=0;n<k.length;n++)co.push(((k.charCodeAt(n%k.length)+n)%67+67)%67);
      const o=[];for(let d=1;d<=L;d++){let e=0,t=1;for(const a of co){e=(e+a*t)%67;t=(t*d)%67;}o.push(e%64);}return o;});},
    source:`
// ---- Polynomial (GF(67)) additive-shift cipher ----
function generateShiftsPolynomial(key, length) {
  const coeff = [];
  for (let n = 0; n < key.length; n++) coeff.push(((key.charCodeAt(n % key.length) + n) % 67 + 67) % 67);
  const shifts = [];
  for (let d = 1; d <= length; d++) {
    let e = 0, t = 1;
    for (const a of coeff) { e = (e + a * t) % 67; t = (t * d) % 67; }
    shifts.push(e % Charset.length);
  }
  return shifts;
}
function cryptPolynomial(token, key, skip, encryptLen, encrypt) {
  return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsPolynomial);
}`
  },
  {
    // Generic ADDITIVE-shift cipher (any per-position keystream PRNG).
    // The per-position shift sequence is fixed for the given key; recover it empirically
    // from the live module (encrypt all-'0' = index 0, so output index == shift). Verification
    // (incl. short tokens) confirms it; non-prefix-consistent generators are rejected and
    // handled by a specific template (e.g. ChaCha) or embedded fallback instead.
    id:"ADDITIVE",
    detect:()=>false, // tried last; only accepted if it verifies byte-for-byte
    variants(ms, c){
      if(!c||!c.M||c.len<1)return [];
      const {M,secret:key,skip,len}=c;
      const tok="0".repeat(skip)+"0".repeat(len)+"00";
      const e=M.enc(tok,key,skip,len);
      const om=e.slice(skip,skip+len);
      const SHIFTS=[];for(let i=0;i<len;i++){const v=CH.indexOf(om[i]);if(v<0)return [];SHIFTS.push(v);}
      const ref=(token,k,sk,ln,dec)=>{if(!token)return token;const p=Math.max(0,Math.min(sk,token.length)),a=Math.max(0,Math.min(ln,token.length-p));if(!a)return token;let mid=token.slice(p,p+a).split("");for(let i=0;i<mid.length;i++){const x=CH.indexOf(mid[i]);if(x<0)continue;mid[i]=dec?CH[((x-SHIFTS[i])%64+64)%64]:CH[(x+SHIFTS[i])%64];}return token.slice(0,p)+mid.join("")+token.slice(p+a);};
      return [{crypt:"cryptShiftTable",ref,source:`
// ---- Additive-shift cipher (per-position keystream recovered for this key) ----
// SHIFTS is the exact per-position shift sequence the bundle's PRNG produces for this key.
const SHIFTS = [${SHIFTS.join(",")}];
function cryptShiftTable(token, key, skip, encryptLen, encrypt) {
  if (!token) return token;
  const p = Math.max(0, Math.min(skip, token.length));
  const a = Math.max(0, Math.min(encryptLen, token.length - p));
  if (a === 0) return token;
  const mid = token.slice(p, p + a).split(""), n = Charset.length;
  for (let i = 0; i < mid.length; i++) {
    const x = charsetIndex(mid[i]); if (x === -1) continue;
    mid[i] = encrypt ? Charset[(x + SHIFTS[i]) % n] : Charset[((x - SHIFTS[i]) % n + n) % n];
  }
  return token.slice(0, p) + mid.join("") + token.slice(p + a);
}`}];
    },
  },
  {
    // Generic position-independent SUBSTITUTION cipher (any keyed permutation, e.g. Feistel/S-box).
    // The net effect is a fixed 64-element permutation P for the given key; we recover P empirically
    // from the live module (so no need to reverse the key schedule), with optional segment reversal.
    id:"SUBST",
    detect:()=>false, // tried last; only accepted if it verifies byte-for-byte
    variants(ms, c){
      if(!c||!c.M||c.len<1)return [];
      const {M,secret:key,skip,len}=c;
      const build=(readPos)=>{const P=new Array(64);for(let x=0;x<64;x++){const tok="0".repeat(skip)+CH[x]+"0".repeat(len-1)+"00";const e=M.enc(tok,key,skip,len);const om=e.slice(skip,skip+len);P[x]=CH.indexOf(om[readPos]);}if(P.some(v=>v<0)||new Set(P).size!==64)return null;return P;};
      const out=[];
      for(const rev of [false,true]){
        const P=build(rev?len-1:0); if(!P)continue;
        const inv=new Array(64);for(let x=0;x<64;x++)inv[P[x]]=x;
        const ref=(token,k,sk,ln,dec)=>{if(!token)return token;const p=Math.max(0,Math.min(sk,token.length)),a=Math.max(0,Math.min(ln,token.length-p));if(!a)return token;let mid=token.slice(p,p+a).split("");if(!dec){for(let i=0;i<mid.length;i++){const x=CH.indexOf(mid[i]);if(x>=0)mid[i]=CH[P[x]];}if(rev)mid.reverse();}else{if(rev)mid.reverse();for(let i=0;i<mid.length;i++){const x=CH.indexOf(mid[i]);if(x>=0)mid[i]=CH[inv[x]];}}return token.slice(0,p)+mid.join("")+token.slice(p+a);};
        out.push({crypt:"cryptSubst",ref,source:`
// ---- Substitution cipher (key-derived 64-element permutation${rev?" + reverse":""}) ----
// PERM was recovered from the live bundle for this key; it IS the cipher's net mapping.
const PERM = [${P.join(",")}];
const PERM_INV = (() => { const v = new Array(64); for (let i = 0; i < 64; i++) v[PERM[i]] = i; return v; })();
function cryptSubst(token, key, skip, encryptLen, encrypt) {
  if (!token) return token;
  const p = Math.max(0, Math.min(skip, token.length));
  const a = Math.max(0, Math.min(encryptLen, token.length - p));
  if (a === 0) return token;
  let mid = token.slice(p, p + a).split("");
  if (encrypt) {
    for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x !== -1) mid[i] = Charset[PERM[x]]; }
    ${rev?"mid.reverse();":""}
  } else {
    ${rev?"mid.reverse();":""}
    for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x !== -1) mid[i] = Charset[PERM_INV[x]]; }
  }
  return token.slice(0, p) + mid.join("") + token.slice(p + a);
}`});
      }
      return out;
    },
  },
];

// shared helpers used by the reference impls
function shiftCipher(token,key,skip,len,dec,gen){if(!token)return token;const p=Math.max(0,Math.min(skip,token.length)),a=Math.max(0,Math.min(len,token.length-p));if(!a)return token;const mid=token.slice(p,p+a).split(""),sh=gen(key,mid.length),n=CH.length;for(let i=0;i<mid.length;i++){const x=CH.indexOf(mid[i]);if(x<0)continue;mid[i]=dec?CH[((x-sh[i])%n+n)%n]:CH[(x+sh[i])%n];}return token.slice(0,p)+mid.join("")+token.slice(p+a);}

// shared clean helper emitted into the output (used by additive algorithms)
const SHARED_ADDITIVE = `
// shared driver for additive-shift algorithms
function additiveShift(token, key, skip, encryptLen, encrypt, genShifts) {
  if (!token) return token;
  const p = Math.max(0, Math.min(skip, token.length));
  const a = Math.max(0, Math.min(encryptLen, token.length - p));
  if (a === 0) return token;
  const mid = token.slice(p, p + a).split("");
  const shifts = genShifts(key, mid.length), n = Charset.length;
  for (let i = 0; i < mid.length; i++) {
    const x = charsetIndex(mid[i]); if (x === -1) continue;
    mid[i] = encrypt ? Charset[(x + shifts[i]) % n] : Charset[((x - shifts[i]) % n + n) % n];
  }
  return token.slice(0, p) + mid.join("") + token.slice(p + a);
}`;

/* ================= deobfuscator + loader (generic, unchanged) ================= */
function mB(s,i,o,c){let d=0;for(;i<s.length;i++){if(s[i]===o)d++;else if(s[i]===c){d--;if(d===0)return i;}}return -1;}
function mP(s,i){let d=0,q=null;for(;i<s.length;i++){const c=s[i];if(q){if(c==="\\"){i++;continue;}if(c===q)q=null;continue;}if(c==='"'||c==="'"||c==="`"){q=c;continue;}if(c==="(")d++;else if(c===")"){d--;if(d===0)return i;}}return -1;}
function b64(e){let t="",n="";for(let r,o,i=0,a=0;o=e.charAt(a++);~o&&(r=i%4?64*r+o:o,i++%4)?t+=String.fromCharCode(255&r>>(-2*i&6)):0)o="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=".indexOf(o);for(let r=0,o=t.length;r<o;r++)n+="%"+("00"+t.charCodeAt(r).toString(16)).slice(-2);try{return decodeURIComponent(n)}catch(_){return null}}
function rc4(e,key){let n,r,o=[],i=0,a="";e=b64(e);if(e===null)return null;for(r=0;r<256;r++)o[r]=r;for(r=0;r<256;r++){i=(i+o[r]+key.charCodeAt(r%key.length))%256;n=o[r];o[r]=o[i];o[i]=n;}r=0;i=0;for(let c=0;c<e.length;c++){r=(r+1)%256;i=(i+o[r])%256;n=o[r];o[r]=o[i];o[i]=n;a+=String.fromCharCode(e.charCodeAt(c)^o[(o[r]+o[i])%256]);}return a;}
const arrCache={};function getArr(fn){if(fn in arrCache)return arrCache[fn];let st=src.indexOf("function "+fn+"(){const e=[");if(st<0)st=src.indexOf("function "+fn+"(){var e=[");if(st<0)return arrCache[fn]=null;const lb=src.indexOf("[",st);return arrCache[fn]=eval(src.slice(lb,mB(src,lb,"[","]")+1));}
const baseDefs={},wrapDefs={};
{let m,re=/function ([\w$]+)\((?:e,t|e)\)\{e-=(\d+)/g;while(m=re.exec(src)){const bs=src.indexOf("{",m.index);const body=src.slice(bs,mB(src,bs,"{","}")+1);const am=/=\s*([\w$]+)\(\)/.exec(body);(baseDefs[m[1]]=baseDefs[m[1]]||[]).push({idx:m.index,offset:+m[2],arrfn:am?am[1]:null,rc4:/o\[r\]\+t\.charCodeAt/.test(body)||/charCodeAt\(\w%\w\.length\)/.test(body)});}}
{let m,re=/function ([\w$]+)\((?:e,t|e)\)\{return ([\w$]+)\(/g;while(m=re.exec(src)){if(baseDefs[m[1]])continue;const ci=src.indexOf("(",src.indexOf("return",m.index)+6);(wrapDefs[m[1]]=wrapDefs[m[1]]||[]).push({idx:m.index,base:m[2],inner:src.slice(ci+1,mP(src,ci))});}}
function nearest(map,name,pos){const a=map[name];if(!a)return null;let b=null;for(const d of a)if(b===null||Math.abs(d.idx-pos)<Math.abs(b.idx-pos))b=d;return b;}
function resolveExpr(expr,pos){const calls=x=>[...new Set((x.match(/([A-Za-z_$][\w$]*)\(/g)||[]).map(t=>t.slice(0,-1)))];const need={base:{},wrap:{}};const arrset=new Set();const stack=calls(expr);while(stack.length){const n=stack.pop();if(need.base[n]||need.wrap[n])continue;const w=nearest(wrapDefs,n,pos),b=nearest(baseDefs,n,pos);if(w&&(!b||Math.abs(w.idx-pos)<Math.abs(b.idx-pos))){need.wrap[n]=w;for(const x of calls(w.inner))stack.push(x);stack.push(w.base);}else if(b){need.base[n]=b;if(b.arrfn)arrset.add(b.arrfn);}}const arr=[...arrset];if(arr.length!==1)return null;const base=getArr(arr[0]);if(!base)return null;for(let rot=0;rot<base.length;rot++){const a=base.slice(rot).concat(base.slice(0,rot));let code="";for(const[n,d]of Object.entries(need.base))code+=`const ${n}=(e,t)=>{const r=__a[e-${d.offset}];return r===undefined?null:(${d.rc4?"__rc4(r,t)":"__b64(r)"});};\n`;for(const[n,w]of Object.entries(need.wrap))code+=`function ${n}(e,t){return ${w.base}(${w.inner})}\n`;try{const v=new Function("__a","__rc4","__b64",code+"return ("+expr+")")(a,rc4,b64);if(typeof v==="string"&&/^[\x20-\x7e]+$/.test(v)&&v.length>=3)return v;}catch(e){}}return null;}
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
while(cm=cfgRe.exec(src)){const secret=resolveExpr(cm[1],cm.index);if(!secret)continue;const sc=roleScores(cm.index);found.push({secret,skip:+cm[2],len:+cm[3],version:+cm[4],sig:sc.sig,res:sc.res,sigEv:sc.sigEv,resEv:sc.resEv});}
const uniq=[];const seen=new Map();
for(const c of found){const k=c.version+"|"+c.secret;if(seen.has(k)){const e=seen.get(k);e.sig+=c.sig;e.res+=c.res;e.sigEv=[...new Set([...e.sigEv,...c.sigEv])];e.resEv=[...new Set([...e.resEv,...c.resEv])];continue;}const e={...c};seen.set(k,e);uniq.push(e);}
let roleUncertain=false;
for(const c of uniq){ if(c.sig>c.res)c.role="Signin"; else if(c.res>c.sig)c.role="Reserve"; else {c.role=null;roleUncertain=true;} }
// complement inference: if exactly two distinct ciphers and only one has a clear role,
// the other must be the opposite role (Signin <-> Reserve).
if(uniq.length===2){
  const known=uniq.filter(c=>c.role), unknown=uniq.filter(c=>!c.role);
  if(known.length===1 && unknown.length===1){
    unknown[0].role = known[0].role==="Signin" ? "Reserve" : "Signin";
    unknown[0]._inferred=true; roleUncertain=false;
  }
}

function rnd(n){let s="";for(let i=0;i<n;i++)s+=CH[Math.floor(Math.random()*64)];return s;}
for(const c of uniq){
  const ms=moduleSource(verToVar[c.version]);
  const LM=loadModule(verToVar[c.version]); c.M=LM&&LM.M; c.region=LM&&LM.region;
  c.enc=modByVar[verToVar[c.version]].enc; c.dec=modByVar[verToVar[c.version]].dec;
  // pick the first registry algorithm whose detect+ref matches the live module byte-for-byte
  c.algo=null;
  // Try EVERY algorithm's reference impl against the live module byte-for-byte.
  // detect() is only a hint/fast-path; verification is the real test, so it is robust
  // to however the obfuscator renders the constants/operators.
  const order=[...ALGORITHMS].sort((a,b)=>(b.detect(ms)?1:0)-(a.detect(ms)?1:0));
  for(const A of order){ if(!c.M)continue;
    let variants;
    try{ variants = A.variants ? A.variants(ms, c) : [{ref:A.ref, source:A.source, crypt:A.crypt}]; }catch(_){ variants=[]; }
    for(const v of variants){
      let ok=true;for(let i=0;i<60;i++){const t=rnd(1+Math.floor(Math.random()*50));let got;try{got=v.ref(t,c.secret,c.skip,c.len,false);}catch(_){ok=false;break;}if(got!==c.M.enc(t,c.secret,c.skip,c.len)){ok=false;break;}}
      if(ok){ c.algo={id:A.id, crypt:v.crypt||A.crypt, source:v.source}; break; }
    }
    if(c.algo)break;
  }
}


// ensure unique role labels (disambiguate any collision so the output never has duplicate declarations)
{const counts={};for(const c of uniq){const base=c.role||("V"+c.version);counts[base]=(counts[base]||0)+1;}
 const used={};for(const c of uniq){let base=c.role||("V"+c.version);if(counts[base]>1){used[base]=(used[base]||0)+1;c.role=base+"V"+c.version;}else c.role=base;}}

console.log("=== extracted ciphers ===");
for(const c of uniq){
  console.log(`role=${c.role||"(UNCERTAIN: V"+c.version+")"} version=${c.version} algo=${c.algo?c.algo.id:"(unknown→embedded)"} skip=${c.skip} len=${c.len}`);
  console.log(`   role evidence: Signin[${c.sigEv.join(",")||"-"}](${c.sig}) vs Reserve[${c.resEv.join(",")||"-"}](${c.res})${c._inferred?"  [inferred as complement of the other cipher]":""}`);
}
if(roleUncertain){
  console.log("\n   ⚠️  ROLE UNCERTAIN for one or more ciphers (no clear Signin/Reserve signal nearby).");
  console.log("      The cipher MATH is still verified correct, but the Signin/Reserve LABEL may be wrong — check the evidence above before using.");
}

// emit

/* ================= Go output (overflow-safe) + go-run self-verification ================= */
const GO_SHARED = `package cipher

import (
\t"math/bits"
\t"strings"
)

const Charset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_"

func charsetIndex(ch byte) int { return strings.IndexByte(Charset, ch) }

func clamp(v, lo, hi int) int {
\tif v < lo { return lo }
\tif v > hi { return hi }
\treturn v
}

func reverseBytes(b []byte) { for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 { b[i], b[j] = b[j], b[i] } }

// (a * b) % m without overflow (128-bit multiply)
func mulmod(a, b, m uint64) uint64 { hi, lo := bits.Mul64(a, b); _, rem := bits.Div64(hi%m, lo, m); return rem }

func additiveShift(token, key string, skip, encLen int, encrypt bool, gen func(string, int) []int) string {
\tif token == "" { return token }
\tp := clamp(skip, 0, len(token))
\ta := clamp(encLen, 0, len(token)-p)
\tif a == 0 { return token }
\tmid := []byte(token[p : p+a])
\tshifts := gen(key, len(mid))
\tn := len(Charset)
\tfor i := 0; i < len(mid); i++ {
\t\tx := charsetIndex(mid[i])
\t\tif x == -1 { continue }
\t\tif encrypt { mid[i] = Charset[(x+shifts[i])%n] } else { v := (x - shifts[i]) % n; if v < 0 { v += n }; mid[i] = Charset[v] }
\t}
\treturn token[:p] + string(mid) + token[p+a:]
}
`;
const GO_ALGO = {
  LCG:{crypt:"cryptLCG", src:`
func generateShiftsLCG(key string, length int) []int {
\tvar seed uint32 = 123456789
\tvar mul uint32 = 1103515245
\tfor i := 0; i < len(key); i++ { seed += uint32(key[i]) }
\tshifts := make([]int, length)
\tfor i := 0; i < length; i++ {
\t\tseed = seed*mul + 12345
\t\tmul = (mul + seed) | 1
\t\tshifts[i] = int((seed >> 16) % uint32(len(Charset)))
\t}
\treturn shifts
}
func cryptLCG(token, key string, skip, encLen int, encrypt bool) string {
\treturn additiveShift(token, key, skip, encLen, encrypt, generateShiftsLCG)
}`},
  MODSQ:{crypt:"cryptModSquare", src:`
func generateShiftsModSquare(key string, length int) []int {
\tconst A = uint64(0xe8d6ca6163)
\ts := uint64(314159265)
\tfor i := 0; i < len(key); i++ { s = (s + uint64(key[i])*uint64(i+1)) % A }
\tif s%2 == 0 { s++ }
\tshifts := make([]int, length)
\tfor i := 0; i < length; i++ { s = mulmod(s, s, A); shifts[i] = int(s % uint64(len(Charset))) }
\treturn shifts
}
func cryptModSquare(token, key string, skip, encLen int, encrypt bool) string {
\treturn additiveShift(token, key, skip, encLen, encrypt, generateShiftsModSquare)
}`},
  LOGISTIC:{crypt:"cryptLogistic", src:`
func generateShiftsLogistic(key string, length int) []int {
\tu := 0.5
\tfor i := 0; i < len(key); i++ { u = math.Mod(u+float64(key[i])/256.0, 1.0) }
\tif u == 0 { u = 0.5 }
\tshifts := []int{}
\tfor f := 0; f < length+100; f++ {
\t\tu = (3.99 * u) * (1 - u)
\t\tif f >= 100 { shifts = append(shifts, int(math.Floor(1e7*u))%len(Charset)) }
\t}
\treturn shifts
}
func cryptLogistic(token, key string, skip, encLen int, encrypt bool) string {
\treturn additiveShift(token, key, skip, encLen, encrypt, generateShiftsLogistic)
}`, imports:["math"]},
  SBOX_REV:{crypt:"cryptSBox", src:`
func cryptSBox(token, key string, skip, encLen int, encrypt bool) string {
\tif token == "" { return token }
\tp := clamp(skip, 0, len(token)); a := clamp(encLen, 0, len(token)-p)
\tif a == 0 { return token }
\tmid := []byte(token[p : p+a]); n := len(Charset)
\tsbox := make([]int, n); for i := range sbox { sbox[i] = i }
\tu := 0
\tfor h := 0; h < n; h++ { u = (u + sbox[h] + int(key[h%len(key)])) % n; sbox[h], sbox[u] = sbox[u], sbox[h] }
\tinv := make([]int, n); for h := 0; h < n; h++ { inv[sbox[h]] = h }
\tif encrypt { for i := range mid { x := charsetIndex(mid[i]); if x != -1 { mid[i] = Charset[sbox[x]] } }; reverseBytes(mid) } else { reverseBytes(mid); for i := range mid { x := charsetIndex(mid[i]); if x != -1 { mid[i] = Charset[inv[x]] } } }
\treturn token[:p] + string(mid) + token[p+a:]
}`},
};

function emitGo(){
  const algos=[...new Set(uniq.filter(c=>c.algo).map(c=>c.algo.id))];
  if(uniq.some(c=>!c.algo)){ console.log("\\n[GO] some cipher uses an algorithm with no Go template yet — Go output skipped (use JS, or ask to add the Go template)."); return null; }
  const extraImports=new Set();
  for(const id of algos) (GO_ALGO[id].imports||[]).forEach(i=>extraImports.add(i));
  let header=GO_SHARED;
  if(extraImports.has("math")){ header=header.replace('"math/bits"', '"math"\n\t"math/bits"'); }
  let body="";
  const exportLines=[];
  for(const c of uniq){
    const R=c.role||("V"+c.version), g=GO_ALGO[c.algo.id];
    body+=`\n// ${R} cipher (version ${c.version}, ${c.algo.id})\nconst ${R}Key = ${JSON.stringify(c.secret)}\nconst ${R}Skip = ${c.skip}\nconst ${R}EncryptLen = ${c.len}\nfunc ProcessToken${R}(token string) string { return ${g.crypt}(token, ${R}Key, ${R}Skip, ${R}EncryptLen, true) }\nfunc ReverseToken${R}(token string) string { return ${g.crypt}(token, ${R}Key, ${R}Skip, ${R}EncryptLen, false) }\n`;
  }
  // router
  body+="\n// Router\nfunc EncryptToken(rawToken, purpose string) string {\n";
  for(const c of uniq){const R=c.role||("V"+c.version);body+=`\tif purpose == ${JSON.stringify(R)} { return ProcessToken${R}(rawToken) }\n`;}
  body+="\treturn rawToken\n}\nfunc DecryptToken(rawToken, purpose string) string {\n";
  for(const c of uniq){const R=c.role||("V"+c.version);body+=`\tif purpose == ${JSON.stringify(R)} { return ReverseToken${R}(rawToken) }\n`;}
  body+="\treturn rawToken\n}\n";
  let algoSrc=""; for(const id of algos) algoSrc+=GO_ALGO[id].src+"\n";
  return header+"\n"+body+"\n"+algoSrc;
}

function verifyGo(goFile){
  // generate vectors from bundle, build a temp Go main that imports nothing (same package) and self-tests
  const cp=require("child_process"), os=require("os");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cipherverify-"));
  // write the cipher .go but as package main (strip 'package cipher')
  let goSrc=fs.readFileSync(goFile,"utf8").replace(/^package \w+/,"package main").replace(/import \(\n/, "import (\n\t\"fmt\"\n");
  // build vectors + a main()
  function rnd(n){let s="";for(let i=0;i<n;i++)s+=CH[Math.floor(Math.random()*64)];return s;}
  let vlines=[];
  for(const c of uniq){const R=c.role||("V"+c.version);for(let i=0;i<60;i++){const t=rnd(1+Math.floor(Math.random()*55));const exp=c.M.enc(t,c.secret,c.skip,c.len);vlines.push(`{${JSON.stringify(R)}, ${JSON.stringify(t)}, ${JSON.stringify(exp)}},`);}}
  goSrc+=`
func main(){
\tvecs := []struct{ purpose, in, exp string }{
\t\t${vlines.join("\n\t\t")}
\t}
\tfail := 0
\tfor _, v := range vecs {
\t\tif EncryptToken(v.in, v.purpose) != v.exp { fail++ }
\t\tif DecryptToken(EncryptToken(v.in, v.purpose), v.purpose) != v.in { fail++ }
\t}
\tif fail == 0 { fmt.Println("GOPASS") } else { fmt.Printf("GOFAIL %d\\n", fail) }
}
`;
  fs.writeFileSync(path.join(dir,"main.go"),goSrc);
  try{ const out=cp.execSync("cd "+dir+" && go run main.go",{encoding:"utf8",timeout:60000}); return out.includes("GOPASS"); }
  catch(e){ console.log("[GO] verify error:", (e.stdout||"")+(e.stderr||e.message)); return false; }
}

let head=`// cipher.js — AUTO-GENERATED clean port (sample format).
// Reverse-engineered + verified byte-for-byte against the live bundle.

const Charset = "${CH}";

function charsetIndex(ch) { return Charset.indexOf(ch); }
`;
let cfgs="", footerNames=[];
const usedAlgos=new Set(uniq.filter(c=>c.algo).map(c=>c.algo.id));
const needAdditive=uniq.some(c=>c.algo&&c.algo.crypt!=="cryptSBox");
for(const c of uniq){
  const R=c.role||("V"+c.version);
  if(c.algo){
    cfgs+=`
// ${R} cipher (version ${c.version}, ${c.algo.id})
const ${R}Key = ${JSON.stringify(c.secret)};
const ${R}Skip = ${c.skip};
const ${R}EncryptLen = ${c.len};
function ProcessToken${R}(token) { return ${c.algo.crypt}(token, ${R}Key, ${R}Skip, ${R}EncryptLen, true); }
function ReverseToken${R}(token) { return ${c.algo.crypt}(token, ${R}Key, ${R}Skip, ${R}EncryptLen, false); }
`;
  } else if(c.region){
    cfgs+=`
// ${R} cipher (version ${c.version}, unrecognized algorithm) — embedded runnable fallback (verified)
const _mod_${R} = (function(){
${c.region}
return { enc:${c.enc}, dec:${c.dec} };
})();
const ${R}Key = ${JSON.stringify(c.secret)};
const ${R}Skip = ${c.skip};
const ${R}EncryptLen = ${c.len};
function ProcessToken${R}(token) { return _mod_${R}.enc(token, ${R}Key, ${R}Skip, ${R}EncryptLen); }
function ReverseToken${R}(token) { return _mod_${R}.dec(token, ${R}Key, ${R}Skip, ${R}EncryptLen); }
`;
  } else continue;
  footerNames.push(R+"Key",R+"Skip",R+"EncryptLen","ProcessToken"+R,"ReverseToken"+R);
}

// ---- Router (so userscripts can call encryptToken(rawToken, purpose) / ProcessToken(rawToken, purpose)) ----
const roleList = uniq.filter(c=>c.algo||c.region).map(c=>c.role||("V"+c.version));
let routerSrc = "\n// ---- Router: encryptToken(rawToken, purpose) / decryptToken(rawToken, purpose) ----\n";
routerSrc += "function encryptToken(rawToken, purpose) {\n";
for(const R of roleList) routerSrc += `  if (purpose === ${JSON.stringify(R)}) return ProcessToken${R}(rawToken);\n`;
routerSrc += "  return rawToken;\n}\n";
routerSrc += "function decryptToken(rawToken, purpose) {\n";
for(const R of roleList) routerSrc += `  if (purpose === ${JSON.stringify(R)}) return ReverseToken${R}(rawToken);\n`;
routerSrc += "  return rawToken;\n}\n";
routerSrc += "function ProcessToken(rawToken, purpose) { return encryptToken(rawToken, purpose); }\n";
routerSrc += "function ReverseToken(rawToken, purpose) { return decryptToken(rawToken, purpose); }\n";
footerNames.push("encryptToken","decryptToken","ProcessToken","ReverseToken");

let algoSrc="";
if([...usedAlgos].some(id=>["LCG","MODSQ","LOGISTIC","CHACHA","BITMIX","CELLULAR","RC4","LFSR","POLYNOMIAL"].includes(id))) algoSrc+=SHARED_ADDITIVE+"\n";
// emit each cipher's matched (possibly dynamic) algorithm source, de-duplicated
const emittedSrc=new Set();
for(const c of uniq){ if(c.algo&&c.algo.source&&!emittedSrc.has(c.algo.source)){ emittedSrc.add(c.algo.source); algoSrc+=c.algo.source+"\n"; } }
const out=head+cfgs+"\n"+routerSrc+"\n"+algoSrc+`
if (typeof module !== "undefined") {
  module.exports = { Charset, ${footerNames.join(", ")} };
}
`;
fs.writeFileSync(OUTFILE,out);
console.log(`\n=> wrote ${OUTFILE}`);

// self-verify
delete require.cache[require.resolve(path.resolve(OUTFILE))];
const G=require(path.resolve(OUTFILE));let pass=0,fail=0;
for(const c of uniq){const R=c.role||("V"+c.version);const P=G["ProcessToken"+R],V=G["ReverseToken"+R];if(!P||!c.M){console.log(`[SELF-TEST] ${R}: MISSING`);fail++;continue;}let ok=true;for(let i=0;i<200;i++){const t=rnd(1+Math.floor(Math.random()*60));const mine=P(t);if(mine!==c.M.enc(t,c.secret,c.skip,c.len)||V(mine)!==t){ok=false;break;}}console.log(`[SELF-TEST] ${R.padEnd(8)} (v${c.version}, ${c.algo?c.algo.id:"embedded"}): ${ok?"PASS ✓":"FAIL ✗"}`);ok?pass++:fail++;}

// ---- Go output: ONLY if --go flag is passed (not needed for JS/Node use) ----
if(process.argv.includes("--go")){
  const goOut = OUTFILE.replace(/\.js$/i, "")+".go";
  const goSrc = emitGo();
  if(goSrc){
    fs.writeFileSync(goOut, goSrc);
    const goOK = verifyGo(goOut);
    console.log("=> wrote "+goOut+" (Go) — "+(goOK ? "GO SELF-TEST PASS ✅ (overflow-safe, matches bundle)" : "GO SELF-TEST FAIL ❌"));
  }
}

const undecoded = found.length===0;
console.log(`\n=> GUARANTEE: ${pass}/${pass+fail} verified identical to the live bundle.`);
if(fail===0 && pass>0 && !undecoded){
  console.log("   ✅ 100% OK — every emitted cipher is byte-for-byte identical to the live bundle.");
  process.exit(0);
} else {
  console.log("   ⚠️  WARNING: could not fully verify. DO NOT trust the output until this is resolved.");
  console.log("      (bundle may use a new obfuscator/config shape — send it over to update the parser.)");
  process.exit(1);
}
