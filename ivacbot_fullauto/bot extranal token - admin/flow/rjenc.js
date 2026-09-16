// ============================================================================
//  RJ SLOT — TOKEN ENCRYPTION MODULE (captcha/token গোপন করার সম্পূর্ণ অংশ)
//  RJ SLOT v10.5.0 থেকে extract করা।
//
//  কী করে:
//   • ১০টা cipher version (block_mix, bitmix, cellular, rc4, lfsr, polynomial,
//     subst_reverse, prng, logistic ...) — সাইটের bundle যে অ্যালগরিদম ব্যবহার করে
//   • VERSION DISPATCH        → কোন version চালাবে ঠিক করে
//   • ENCRYPTION CONFIG MANAGER → কোন purpose (signin/reserve/initiate) এ কোন
//                                cipher + secret + length, persist/load/UI
//   • encryptTokenByPurpose() → raw token → encrypted "c"
//   • encTokenForCall()       → purpose অনুযায়ী encrypt (raw toggle থাকলে raw)
//   • EXECUTION-BASED cipher fallback → ভারী-obfuscated bundle থেকে সাইটের নিজের
//                                cipher চালিয়ে secret বের করে (static resolver ব্যর্থ হলে)
//
//  ⚠️ বাইরের নির্ভরতা (একা চলবে না — মূল কোডের এগুলো লাগে):
//   logStatus, document (enc-*/chk-* input box), localStorage,
//   bundle fetch helpers (execution-based fallback-এর জন্য)।
// ============================================================================

// ==================== CAPTCHA TOKEN ENCRYPTION (10 VERSION HARDCODED) ====================
const CAPTCHA_CHARSET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
const CAPTCHA_ALPHA_LEN = CAPTCHA_CHARSET.length;

function _cs_idx(ch) { return CAPTCHA_CHARSET.indexOf(ch); }

// Shared driver for additive-shift ciphers.
function additiveShift(token, key, skip, encryptLen, encrypt, genShifts) {
    if (!token) return token;
    const p = Math.max(0, Math.min(skip, token.length));
    const a = Math.max(0, Math.min(encryptLen, token.length - p));
    if (a === 0) return token;
    const mid = token.slice(p, p + a).split('');
    const shifts = genShifts(key, mid.length), n = CAPTCHA_CHARSET.length;
    for (let i = 0; i < mid.length; i++) {
        const x = _cs_idx(mid[i]); if (x === -1) continue;
        mid[i] = encrypt ? CAPTCHA_CHARSET[(x + shifts[i]) % n]
                         : CAPTCHA_CHARSET[((x - shifts[i]) % n + n) % n];
    }
    return token.slice(0, p) + mid.join('') + token.slice(p + a);
}

// --- v1: block_mix / ChaCha-style keystream (16-word state, 10 column rounds) ---
function _rotl32(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
function _chachaQR(s, a, b, c, d) {
    s[a] = (s[a] + s[b]) >>> 0; s[d] = _rotl32(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = _rotl32(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) >>> 0; s[d] = _rotl32(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = _rotl32(s[b] ^ s[c], 7);
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
            _chachaQR(e, 0, 4, 8, 12); _chachaQR(e, 1, 5, 9, 13); _chachaQR(e, 2, 6, 10, 14); _chachaQR(e, 3, 7, 11, 15);
        }
        for (let k = 0; k < 4; k++) shifts.push((e[k] >>> 0) % CAPTCHA_ALPHA_LEN);
    }
    return shifts;
}

// --- v2: bitmix / 6-bit Feistel network (8 rounds, F = 7&((x*3+k)^3)) ---
function _bitmixRK(key) {
    let c = 0;
    for (let f = 0; f < key.length; f++) c = (c + key.charCodeAt(f) * (f + 1)) >>> 0;
    const rk = [];
    for (let f = 0; f < 8; f++) { c = (Math.imul(c, 1103515245) + 12345) >>> 0; rk.push(c & 7); }
    return rk;
}
function _bitmixFwd(val, rk) {
    let hi = (val >> 3) & 7, lo = val & 7;
    for (let r = 0; r < rk.length; r++) { const x = hi ^ (7 & ((lo * 3 + rk[r]) ^ 3)); hi = lo; lo = x; }
    return (lo << 3) | hi;
}
function _bitmixInv(val, rk) {
    let lo = (val >> 3) & 7, hi = val & 7;
    for (let r = rk.length - 1; r >= 0; r--) { const x = hi; hi = lo ^ (7 & ((x * 3 + rk[r]) ^ 3)); lo = x; }
    return (hi << 3) | lo;
}
function cryptBitmix(token, key, skip, encryptLen, encrypt) {
    if (!token) return token;
    const p = Math.max(0, Math.min(skip, token.length));
    const a = Math.max(0, Math.min(encryptLen, token.length - p));
    if (a === 0) return token;
    const mid = token.slice(p, p + a).split(''), rk = _bitmixRK(key);
    for (let i = 0; i < mid.length; i++) {
        const x = _cs_idx(mid[i]); if (x === -1) continue;
        mid[i] = CAPTCHA_CHARSET[(encrypt ? _bitmixFwd(x, rk) : _bitmixInv(x, rk)) % CAPTCHA_ALPHA_LEN];
    }
    return token.slice(0, p) + mid.join('') + token.slice(p + a);
}

// --- v3: cellular_shift / Rule-30 cellular automaton ---
function generateShiftsCellular(key, length) {
    let cur = new Uint8Array(64);
    for (let i = 0; i < key.length; i++) cur[i % 64] ^= (key.charCodeAt(i) & 1);
    cur[32] = 1;
    const shifts = [];
    for (let s = 0; s < length; s++) {
        const nx = new Uint8Array(64); let v = 0;
        for (let d = 0; d < 64; d++) {
            const L = cur[(d + 63) % 64], C = cur[d], R = cur[(d + 1) % 64];
            nx[d] = (30 >> ((L << 2) | (C << 1) | R)) & 1;
            if (d < 6) v = (v << 1) | nx[d];
        }
        cur = nx; shifts.push(v % CAPTCHA_ALPHA_LEN);
    }
    return shifts;
}

// --- v4: rc4_shift / RC4 over a 64-element state ---
function generateShiftsRC4(key, length) {
    const SZ = 64, S = Array.from({ length: SZ }, (_, i) => i);
    let j = 0;
    for (let i = 0; i < SZ; i++) { j = (j + S[i] + key.charCodeAt(i % key.length)) % SZ; const t = S[i]; S[i] = S[j]; S[j] = t; }
    let i = 0; j = 0; const shifts = [];
    for (let k = 0; k < length; k++) { i = (i + 1) % SZ; j = (j + S[i]) % SZ; const t = S[i]; S[i] = S[j]; S[j] = t; shifts.push(S[(S[i] + S[j]) % SZ]); }
    return shifts;
}

// --- v5: lfsr_shift / three-LFSR Geffe generator ---
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
            const h = (ub & sb) ^ (~ub & lb);
            e = (e << 1) | h;
        }
        shifts.push(((e % CAPTCHA_ALPHA_LEN) + CAPTCHA_ALPHA_LEN) % CAPTCHA_ALPHA_LEN);
    }
    return shifts;
}

// --- v6: polynomial / GF(67) additive-shift ---
function generateShiftsPolynomial(key, length) {
    const coeff = [];
    for (let n = 0; n < key.length; n++) coeff.push(((key.charCodeAt(n % key.length) + n) % 67 + 67) % 67);
    const shifts = [];
    for (let d = 1; d <= length; d++) {
        let e = 0, t = 1;
        for (const a of coeff) { e = (e + a * t) % 67; t = (t * d) % 67; }
        shifts.push(e % CAPTCHA_ALPHA_LEN);
    }
    return shifts;
}

// --- v7: subst_reverse / RC4-keyed 64-element S-box substitution + reverse ---
function cryptSBox(token, key, skip, encryptLen, encrypt) {
    if (!token) return token;
    const p = Math.max(0, Math.min(skip, token.length));
    const a = Math.max(0, Math.min(encryptLen, token.length - p));
    if (a === 0) return token;
    let mid = token.slice(p, p + a).split('');
    const n = CAPTCHA_ALPHA_LEN;
    const sbox = Array.from({ length: n }, (_, i) => i);
    let u = 0;
    for (let h = 0; h < n; h++) { u = (u + sbox[h] + key.charCodeAt(h % key.length)) % n; const t = sbox[h]; sbox[h] = sbox[u]; sbox[u] = t; }
    const inv = new Array(n); for (let h = 0; h < n; h++) inv[sbox[h]] = h;
    if (encrypt) { for (let i = 0; i < mid.length; i++) { const x = _cs_idx(mid[i]); if (x !== -1) mid[i] = CAPTCHA_CHARSET[sbox[x]]; } mid.reverse(); }
    else { mid.reverse(); for (let i = 0; i < mid.length; i++) { const x = _cs_idx(mid[i]); if (x !== -1) mid[i] = CAPTCHA_CHARSET[inv[x]]; } }
    return token.slice(0, p) + mid.join('') + token.slice(p + a);
}

// --- v8: prng / LCG additive-shift (seed 123456789, mul 1103515245) ---
function generateShiftsLCG(key, length) {
    let seed = 123456789, mul = 1103515245;
    for (let i = 0; i < key.length; i++) seed = (seed + key.charCodeAt(i)) >>> 0;
    const shifts = new Array(length);
    for (let i = 0; i < length; i++) {
        seed = (Math.imul(seed, mul) + 12345) >>> 0;
        mul = ((mul + seed) >>> 0) | 1;
        shifts[i] = (seed >>> 16) % CAPTCHA_ALPHA_LEN;
    }
    return shifts;
}

function generateShiftsModSquare(key, length, A) {
    A = A || 1000036000099n;
    let s = 314159265n;
    for (let i = 0; i < key.length; i++) s = (s + BigInt(key.charCodeAt(i)) * BigInt(i + 1)) % A;
    if (s % 2n === 0n) s += 1n;
    const shifts = new Array(length);
    for (let i = 0; i < length; i++) { s = (s * s) % A; shifts[i] = Number(s % BigInt(CAPTCHA_ALPHA_LEN)); }
    return shifts;
}

// --- v10: logistic_shift / chaotic logistic map (r=3.99, 100-step warmup) ---
function generateShiftsLogistic(key, length) {
    let u = 0.5;
    for (let i = 0; i < key.length; i++) u = (u + key.charCodeAt(i) / 256) % 1;
    if (u === 0) u = 0.5;
    const shifts = [];
    for (let f = 0; f < length + 100; f++) {
        u = (3.99 * u) * (1 - u);
        if (f >= 100) shifts.push(Math.floor(1e7 * u) % CAPTCHA_ALPHA_LEN);
    }
    return shifts;
}

// --- VERSION DISPATCH ---
function encryptByVersion(version, token, key, prefixLen, encodeLen, modulus) {
    const v = parseInt(version) || 1;
    switch (v) {
        case 1:  return additiveShift(token, key, prefixLen, encodeLen, true, generateShiftsChaCha);
        case 2:  return cryptBitmix(token, key, prefixLen, encodeLen, true);
        case 3:  return additiveShift(token, key, prefixLen, encodeLen, true, generateShiftsCellular);
        case 4:  return additiveShift(token, key, prefixLen, encodeLen, true, generateShiftsRC4);
        case 5:  return additiveShift(token, key, prefixLen, encodeLen, true, generateShiftsLFSR);
        case 6:  return additiveShift(token, key, prefixLen, encodeLen, true, generateShiftsPolynomial);
        case 7:  return cryptSBox(token, key, prefixLen, encodeLen, true);
        case 8:  return additiveShift(token, key, prefixLen, encodeLen, true, generateShiftsLCG);
        case 9:  return additiveShift(token, key, prefixLen, encodeLen, true, (k, L) => generateShiftsModSquare(k, L, modulus));
        case 10: return additiveShift(token, key, prefixLen, encodeLen, true, generateShiftsLogistic);
        default: return token;
    }
}

// --- ENCRYPTION CONFIG MANAGER ---
const ENC_SIGNIN_KEY   = 'rj_enc_signin_cfg_v2';
const ENC_RESERVE_KEY  = 'rj_enc_reserve_cfg_v2';
const ENC_INITIATE_KEY = 'rj_enc_initiate_cfg_v2';

const encConfig = {
    signin:   {},
    reserve:  {},
    initiate: {}
};
const ENC_STORE_KEY = { signin: ENC_SIGNIN_KEY, reserve: ENC_RESERVE_KEY, initiate: ENC_INITIATE_KEY };

function encConfigSave(purpose) {
    const cfg = encConfig[purpose];
    const storeKey = ENC_STORE_KEY[purpose] || ENC_RESERVE_KEY;
    try { localStorage.setItem(storeKey, JSON.stringify(cfg)); } catch(e) {}
}

function encConfigLoad(purpose) {
    const storeKey = ENC_STORE_KEY[purpose] || ENC_RESERVE_KEY;
    try {
        const raw = localStorage.getItem(storeKey);
        if (raw) { const parsed = JSON.parse(raw); Object.assign(encConfig[purpose], parsed); return true; }
    } catch(e) {}
    return false;
}

function encConfigApplyToUI(purpose) {
    const cfg = encConfig[purpose];
    const p = purpose;
    const keyInp   = document.getElementById(`enc-${p}-key`);
    const skipInp  = document.getElementById(`enc-${p}-skip`);
    const lenInp   = document.getElementById(`enc-${p}-length`);
    const verSel   = document.getElementById(`enc-${p}-version`);
    const statusEl = document.getElementById(`enc-${p}-status`);
    if (keyInp)  keyInp.value  = cfg.key || '';
    if (skipInp) skipInp.value = cfg.skip;
    if (lenInp)  lenInp.value  = cfg.length;
    if (verSel)  verSel.value  = cfg.version;
    if (statusEl) {
        statusEl.textContent = cfg.active ? `✅ Active (v${cfg.version})` : 'Inactive';
        statusEl.style.color = cfg.active ? '#4ade80' : '#8888aa';
    }
}

function encConfigReadFromUI(purpose) {
    const p = purpose;
    const cfg = encConfig[p];
    const keyInp  = document.getElementById(`enc-${p}-key`);
    const skipInp = document.getElementById(`enc-${p}-skip`);
    const lenInp  = document.getElementById(`enc-${p}-length`);
    const verSel  = document.getElementById(`enc-${p}-version`);
    if (keyInp)  cfg.key     = keyInp.value.trim();
    if (skipInp) cfg.skip    = parseInt(skipInp.value);
    if (lenInp)  cfg.length  = parseInt(lenInp.value);
    if (verSel)  cfg.version = parseInt(verSel.value) || 1;
    cfg.manual = true;   // user-entered → LOCK: A_E auto-resolve must not overwrite this working config
}

function encryptTokenByPurpose(rawToken, purpose) {
    if (!rawToken || typeof rawToken !== 'string') return rawToken;
    const cfg = encConfig[purpose];
    if (!cfg.active || !cfg.key) {
        console.log(`[RJ Enc] ${purpose} encryption not active — token sent raw`);
        return rawToken;
    }
    try {
        const result = encryptByVersion(cfg.version, rawToken, cfg.key, cfg.skip, cfg.length, cfg.modulus);
        console.log(`[RJ Enc] ${purpose} encrypted with v${cfg.version} (skip=${cfg.skip}, len=${cfg.length})`);
        return result;
    } catch(e) {
        console.error(`[RJ Enc] ${purpose} encryption error:`, e);
        logStatus(`⚠ ${purpose} encryption error — sending raw token`, 'y');
        return rawToken;
    }
}

function encTokenForCall(rawToken, purpose) {
    if (purpose === 'initiate') {
        return document.getElementById('chk-initiate-raw')?.checked ? rawToken : encryptTokenByPurpose(rawToken, 'initiate');
    }
    const rawChkId = purpose === 'signin' ? 'chk-signin-raw' : 'chk-reserve-raw';
    return document.getElementById(rawChkId)?.checked ? rawToken : encryptTokenByPurpose(rawToken, purpose);
}

const ENC_BUNDLE_HASH_KEY = 'rj_enc_bundle_hash';

function encConfigInit() {
    encConfigLoad('signin');
    encConfigLoad('reserve');
    encConfigLoad('initiate');
    // Clean stale configs that have no key (broken from previous failed resolves)
    for (const p of ['signin', 'reserve', 'initiate']) {
        if (encConfig[p].active && !encConfig[p].key) {
            encConfig[p].active = false;
            encConfigSave(p);
        }
    }
    setTimeout(() => {
        encConfigApplyToUI('signin');
        encConfigApplyToUI('reserve');
        encConfigApplyToUI('initiate');
    }, 500);
}

async function findBundleUrls() {
    const BUNDLE_RE_G = /\/assets\/[a-zA-Z0-9]{8,}(?:-[a-zA-Z0-9]+)+\.js/g;
    const BUNDLE_RE   = /\/assets\/[a-zA-Z0-9]{8,}(?:-[a-zA-Z0-9]+)+\.js(?:$|\?)/;
    const seen = new Set(); const urls = [];
    const add = (u) => { if (u && !seen.has(u)) { seen.add(u); urls.push(u); } };
    // 1) from the loaded page DOM (all matching script tags)
    [...document.querySelectorAll('script[src]')].forEach(s => { if (BUNDLE_RE.test(s.src)) add(s.src); });
    // 2) also parse index.html for chunks that may be lazy-loaded (not yet in the DOM)
    try {
        const r = await pageFetch(location.origin + '/', { cache: 'no-store' });
        if (r.ok) {
            const html = await r.text();
            let m; while ((m = BUNDLE_RE_G.exec(html)) !== null) add(new URL(m[0], location.origin).href);
        }
    } catch(e) {}
    // 3) all loaded JS from performance entries — catches dynamically-imported chunks (e.g. the
    // payment lazy-chunk where the dg-epay concat lives) that aren't <script src> or in index.html
    try { performance.getEntriesByType('resource').forEach(e => { if (/\.js(?:$|\?)/.test(e.name) && e.name.indexOf(location.origin) === 0) add(e.name); }); } catch (e) {}
    // 4) TRANSITIVE: open each discovered JS bundle and pull the lazy-chunk filenames referenced
    // *inside* it (Vite/webpack write the full chunk filename as a string literal in the entry
    // bundle's chunk-manifest). This finds the payment lazy-chunk WITHOUT waiting for it to load,
    // so dg-epay can be resolved from the appointment page. One transitive level is enough.
    try {
        const grab = async (u) => {
            try { const r = await pageFetch(u); if (r.ok) return await r.text(); } catch (e) {}
            return await new Promise((res) => { const g = (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) || (typeof GM !== 'undefined' && GM.xmlHttpRequest); if (!g) { res(null); return; } g({ method: 'GET', url: u, timeout: 30000, onload: r => res(r.responseText || ''), onerror: () => res(null), ontimeout: () => res(null) }); });
        };
        // base dir of the /assets/ folder (to resolve BARE chunk basenames that Vite writes without a path)
        let assetBase = location.origin + '/assets/';
        for (const u of urls) { const mm = /^(.*\/assets\/)/.exec(u); if (mm) { assetBase = mm[1]; break; } }
        // Vite/webpack reference lazy-chunks two ways: (a) full "/assets/xxx.js" path, or (b) BARE
        // basename "name-HASH.js" (path prepended at runtime). Match BOTH so the payment chunk is found.
        const PATH_RE = /(?:\/|\b)assets\/[\w.-]+\.js/g;                    // .../assets/foo-HASH.js
        const BARE_RE = /["'`]([\w.-]+-[A-Za-z0-9_]{8,})\.js["'`]/g;        // "foo-HASH.js"
        const seedList = urls.slice(0, 8);   // scan the entry/main chunks only (cap fetches)
        for (const u of seedList) {
            const t = await grab(u); if (!t) continue;
            let m;
            PATH_RE.lastIndex = 0; while ((m = PATH_RE.exec(t)) !== null) { try { add(new URL('/' + m[0].replace(/^\//, ''), location.origin).href); } catch (e) {} }
            BARE_RE.lastIndex = 0; while ((m = BARE_RE.exec(t)) !== null) { try { add(new URL(m[1] + '.js', assetBase).href); } catch (e) {} }
        }
    } catch (e) {}
    return urls;
}

function buildBundleResolver(src) {
    function mB(s,i,o,c){let d=0;for(;i<s.length;i++){if(s[i]===o)d++;else if(s[i]===c){d--;if(d===0)return i;}}return -1;}
    function mP(s,i){let d=0,q=null;for(;i<s.length;i++){const c=s[i];if(q){if(c==="\\"){i++;continue;}if(c===q)q=null;continue;}if(c==='"'||c==="'"||c==="`"){q=c;continue;}if(c==="(")d++;else if(c===")"){d--;if(d===0)return i;}}return -1;}
    function b64(e){let t="",n="";for(let r,o,i=0,a=0;o=e.charAt(a++);~o&&(r=i%4?64*r+o:o,i++%4)?t+=String.fromCharCode(255&r>>(-2*i&6)):0)o="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=".indexOf(o);for(let r=0,o=t.length;r<o;r++)n+="%"+("00"+t.charCodeAt(r).toString(16)).slice(-2);try{return decodeURIComponent(n)}catch(_){return null}}
    function rc4(e,key){let n,r,o=[],i=0,a="";e=b64(e);if(e===null)return null;for(r=0;r<256;r++)o[r]=r;for(r=0;r<256;r++){i=(i+o[r]+key.charCodeAt(r%key.length))%256;n=o[r];o[r]=o[i];o[i]=n;}r=0;i=0;for(let c=0;c<e.length;c++){r=(r+1)%256;i=(i+o[r])%256;n=o[r];o[r]=o[i];o[i]=n;a+=String.fromCharCode(e.charCodeAt(c)^o[(o[r]+o[i])%256]);}return a;}
    const arrCache={};function getArr(fn){if(fn in arrCache)return arrCache[fn];let st=src.indexOf("function "+fn+"(){const e=[");if(st<0)st=src.indexOf("function "+fn+"(){var e=[");if(st<0)return arrCache[fn]=null;const lb=src.indexOf("[",st);try{return arrCache[fn]=eval(src.slice(lb,mB(src,lb,"[","]")+1));}catch(_){return arrCache[fn]=null;}}
    const baseDefs={},wrapDefs={};
    {let m,re=/function ([\w$]+)\((?:e,t|e)\)\{e-=(\d+)/g;while(m=re.exec(src)){const bs=src.indexOf("{",m.index);const body=src.slice(bs,mB(src,bs,"{","}")+1);const am=/=\s*([\w$]+)\(\)/.exec(body);(baseDefs[m[1]]=baseDefs[m[1]]||[]).push({idx:m.index,offset:+m[2],arrfn:am?am[1]:null,rc4:/o\[r\]\+t\.charCodeAt/.test(body)||/charCodeAt\(\w%\w\.length\)/.test(body)});}}
    {let m,re=/function ([\w$]+)\((?:e,t|e)\)\{return ([\w$]+)\(/g;while(m=re.exec(src)){if(baseDefs[m[1]])continue;const ci=src.indexOf("(",src.indexOf("return",m.index)+6);(wrapDefs[m[1]]=wrapDefs[m[1]]||[]).push({idx:m.index,base:m[2],inner:src.slice(ci+1,mP(src,ci))});}}
    function nearest(map,name,pos){const a=map[name];if(!a)return null;let b=null;for(const d of a)if(b===null||Math.abs(d.idx-pos)<Math.abs(b.idx-pos))b=d;return b;}
    function splitTopPlus(s){const parts=[];let depth=0,q=null,cur="";for(let i=0;i<s.length;i++){const c=s[i];if(q){cur+=c;if(c==="\\"){cur+=s[++i]||"";continue;}if(c===q)q=null;continue;}if(c==='"'||c==="'"||c==="`"){q=c;cur+=c;continue;}if(c==="("||c==="["){depth++;cur+=c;continue;}if(c===")"||c==="]"){depth--;cur+=c;continue;}if(c==="+"&&depth===0){parts.push(cur);cur="";continue;}cur+=c;}if(cur.trim())parts.push(cur);return parts.map(x=>x.trim()).filter(Boolean);}
    function ultimateArrfn(name,pos,guard){guard=guard||0;if(guard>12)return null;const w=nearest(wrapDefs,name,pos),b=nearest(baseDefs,name,pos);if(b&&(!w||Math.abs(b.idx-pos)<=Math.abs(w.idx-pos)))return b.arrfn;if(w){const inner=[...new Set((w.inner.match(/([A-Za-z_$][\w$]*)\(/g)||[]).map(t=>t.slice(0,-1)))];for(const nm of inner){const af=ultimateArrfn(nm,pos,guard+1);if(af)return af;}return ultimateArrfn(w.base,pos,guard+1);}return null;}
    const __gb={n:40000};   // per-call fnFull-eval budget (caps the 2-array O(N^2) path → no hang; cipher single-array uses <10k)
    function resolveExpr(expr,pos){__gb.n=40000;
        const calls=x=>[...new Set((x.match(/([A-Za-z_$][\w$]*)\(/g)||[]).map(t=>t.slice(0,-1)))];
        const need={base:{},wrap:{}};const arrset=new Set();const stack=calls(expr);
        while(stack.length){const n=stack.pop();if(need.base[n]||need.wrap[n])continue;
            const w=nearest(wrapDefs,n,pos),b=nearest(baseDefs,n,pos);
            if(w&&(!b||Math.abs(w.idx-pos)<Math.abs(b.idx-pos))){need.wrap[n]=w;for(const x of calls(w.inner))stack.push(x);stack.push(w.base);}
            else if(b){need.base[n]=b;if(b.arrfn)arrset.add(b.arrfn);}}
        const arr=[...arrset];
        if(arr.length===0)return null;
        const baseArr={};for(const a of arr){const g=getArr(a);if(!g)return null;baseArr[a]=g;}
        const rot=(a,r)=>a.slice(r).concat(a.slice(0,r));
        const ok=v=>typeof v==="string"&&/^[\x20-\x7e]+$/.test(v)&&v.length>=3;
        let decl="";
        for(const[n,d]of Object.entries(need.base))decl+=`const ${n}=(e,t)=>{const r=__arrs[${JSON.stringify(d.arrfn)}][e-${d.offset}];return r===undefined?null:(${d.rc4?"__rc4(r,t)":"__b64(r)"});};\n`;
        for(const[n,w]of Object.entries(need.wrap))decl+=`function ${n}(e,t){return ${w.base}(${w.inner})}\n`;
        let fnFull;try{fnFull=new Function("__arrs","__rc4","__b64",decl+"return ("+expr+")");}catch(e){return null;}
        // METHOD A: independent per-array rotation (scales to any N)
        try{
            const terms=splitTopPlus(expr);
            const termArr=terms.map(t=>{const m=/^([A-Za-z_$][\w$]*)\(/.exec(t);return m?ultimateArrfn(m[1],pos):null;});
            const fnTerms=new Function("__arrs","__rc4","__b64",decl+"return ["+terms.join(",")+"]");
            const groups={};arr.forEach(a=>groups[a]=[]);termArr.forEach((a,i)=>{if(a&&groups[a])groups[a].push(i);});
            const passRot={};let feasible=true;
            for(const a of arr){
                const idxs=groups[a];if(!idxs.length){feasible=false;break;}
                const good=[];
                for(let r=0;r<baseArr[a].length;r++){if(--__gb.n<=0){feasible=false;break;}
                    const arrs={};arr.forEach(x=>arrs[x]=x===a?rot(baseArr[a],r):baseArr[x]);
                    let allok=true;try{const vals=fnTerms(arrs,rc4,b64);for(const i of idxs){const v=vals[i];if(typeof v!=="string"||!/^[\x20-\x7e]*$/.test(v)){allok=false;break;}}}catch(e){allok=false;}
                    if(allok)good.push(r);
                    if(good.length>8)break;
                }
                if(!good.length||good.length>8){feasible=false;break;}
                passRot[a]=good;
            }
            if(feasible){
                const keys=arr, lists=keys.map(a=>passRot[a]);
                const combos=(function prod(i){if(i===lists.length)return [[]];const rest=prod(i+1);const out=[];for(const r of lists[i])for(const t of rest)out.push([r,...t]);return out;})(0);
                for(const combo of combos){if(--__gb.n<=0)break;const arrs={};keys.forEach((a,i)=>arrs[a]=rot(baseArr[a],combo[i]));try{const v=fnFull(arrs,rc4,b64);if(ok(v))return v;}catch(e){}}
            }
        }catch(e){}
        // METHOD B: full brute-force fallback (1-2 arrays)
        if(arr.length===1){for(let r=0;r<baseArr[arr[0]].length;r++){if(--__gb.n<=0)return null;try{const v=fnFull({[arr[0]]:rot(baseArr[arr[0]],r)},rc4,b64);if(ok(v))return v;}catch(e){}}return null;}
        if(arr.length===2){
            const a0=arr[0],a1=arr[1],A=baseArr[a0],B=baseArr[a1];
            const terms2=splitTopPlus(expr);
            const termArr2=terms2.map(t=>{const m=/^([A-Za-z_$][\w$]*)\(/.exec(t);return m?ultimateArrfn(m[1],pos):null;});
            let fnTermsB=null;try{fnTermsB=new Function("__arrs","__rc4","__b64",decl+"return ["+terms2.join(",")+"]");}catch(e){}
            if(fnTermsB){
                const idx0=[],idx1=[];termArr2.forEach((a,i)=>{if(a===a0)idx0.push(i);else if(a===a1)idx1.push(i);});
                const isPrint=v=>typeof v==="string"&&/^[\x20-\x7e]*$/.test(v);
                let baseVals=null;try{baseVals=fnTermsB({[a0]:A,[a1]:B},rc4,b64);}catch(e){}
                if(baseVals){
                    const rec0=[],good0=[];for(let r0=0;r0<A.length;r0++){if(--__gb.n<=0)break;let vals;try{vals=fnTermsB({[a0]:rot(A,r0),[a1]:B},rc4,b64);}catch(e){rec0.push(null);continue;}const m={};let okp=true;for(const i of idx0){m[i]=vals[i];if(!isPrint(vals[i]))okp=false;}rec0.push(m);if(okp)good0.push(r0);}
                    const rec1=[],good1=[];for(let r1=0;r1<B.length;r1++){if(--__gb.n<=0)break;let vals;try{vals=fnTermsB({[a0]:A,[a1]:rot(B,r1)},rc4,b64);}catch(e){rec1.push(null);continue;}const m={};let okp=true;for(const i of idx1){m[i]=vals[i];if(!isPrint(vals[i]))okp=false;}rec1.push(m);if(okp)good1.push(r1);}
                    const L0=good0.length?good0:[...Array(A.length).keys()];
                    const L1=good1.length?good1:[...Array(B.length).keys()];
                    for(const r0 of L0){const m0=rec0[r0];if(!m0)continue;for(const r1 of L1){const m1=rec1[r1];if(!m1)continue;let sec="";for(let i=0;i<terms2.length;i++)sec+=(i in m0?m0[i]:(i in m1?m1[i]:baseVals[i]));if(ok(sec))return sec;}}
                    return null;
                }
            }
            const A2=baseArr[arr[0]],B2=baseArr[arr[1]];for(let r0=0;r0<A2.length;r0++){if(__gb.n<=0)break;const A0=rot(A2,r0);for(let r1=0;r1<B2.length;r1++){if(--__gb.n<=0)break;try{const v=fnFull({[arr[0]]:A0,[arr[1]]:rot(B2,r1)},rc4,b64);if(ok(v))return v;}catch(e){}}}return null;
        }
        return null;
    }
    return { resolveExpr };
}

// role scoring (signin vs reserve vs initiate) by keyword proximity — mirrors extract_ciphers.js
function encRoleScores(src, pos) {
    const w = src.slice(Math.max(0, pos - 1400), pos + 1400);
    const rM = w.match(/reserve|slot|booking|appointment|schedul/gi) || [];
    const sM = w.match(/sign-?in|signin|log-?in|login|\botp\b|verify|password|phone|forgot|forget|resend|signup/gi) || [];
    const iM = w.match(/initiate|payment|dg-?epay|dg_epay|epay|checkout|gateway|invoice/gi) || [];
    return { sig: sM.length, res: rM.length, ini: iM.length };
}

function _splitTopComma(s){const parts=[];let depth=0,q=null,cur="";for(let i=0;i<s.length;i++){const c=s[i];if(q){cur+=c;if(c==="\\"){cur+=s[++i]||"";continue;}if(c===q)q=null;continue;}if(c==='"'||c==="'"||c==="`"){q=c;cur+=c;continue;}if(c==="("||c==="["||c==="{"){depth++;cur+=c;continue;}if(c===")"||c==="]"||c==="}"){depth--;cur+=c;continue;}if(c===","&&depth===0){parts.push(cur);cur="";continue;}cur+=c;}if(cur.trim())parts.push(cur);return parts;}
// config integer: prefer a QUOTED number (Number("1"), c[f(1486)](_,"27")), else a bare int (old startAt:4)
function _cfgNum(expr){let m=/["'`](-?\d+)["'`]/.exec(expr);if(m)return parseInt(m[1],10);m=/(-?\d+)/.exec(expr);return m?parseInt(m[1],10):NaN;}
// brace-match an object literal starting at `{` (respect quotes)
function _braceObj(str,b){let depth=0,q=null;for(let j=b;j<str.length;j++){const c=str[j];if(q){if(c==="\\"){j++;continue;}if(c===q)q=null;continue;}if(c==='"'||c==="'"||c==="`"){q=c;continue;}if(c==="{")depth++;else if(c==="}"){if(--depth===0)return j;}}return -1;}

// ===== EXECUTION-BASED cipher fallback (for heavy-obfuscation bundles the static resolver can't map) =====
// Runs the bundle's OWN decoder cluster around the secret so every string-array shuffles into place
// exactly as the browser does, exposes the base wrapper fns, then evaluates the secret concat with its
// local wrappers. Used only when buildBundleResolver().resolveExpr() returns null. This is what makes
// A_E auto-fill the cipher config on bundles like 94e60cd7 (deep wrapper chains + 2 interleaved arrays).
function _encRunDecoderCluster(src, P) {
    try {
        const decRe = /function [\w$]+\((?:e,t|e)\)\{e-=\d+/g, arrRe = /function [\w$]+\(\)\{(?:const|var) e=\[/g;
        let starts = [];
        for (const m of src.matchAll(decRe)) starts.push(m.index);
        for (const m of src.matchAll(arrRe)) starts.push(m.index);
        starts = starts.filter(x => x < P).sort((a, b) => a - b);
        if (!starts.length) return {};
        let start = starts[starts.length - 1];
        for (let i = starts.length - 1; i > 0; i--) { if (starts[i] - starts[i - 1] < 12000) start = starts[i - 1]; else break; }
        const shs = [...src.matchAll(/for\(;;\)try\{if\(/g)].map(m => m.index).filter(x => x > start && x < P + 14000);
        const lastSh = shs.length ? shs[shs.length - 1] : P;
        let b = 0, q = null, endIdx = -1;
        for (let k = start; k < src.length; k++) { const c = src[k]; if (q) { if (c === "\\") { k++; continue; } if (c === q) q = null; continue; } if (c === '"' || c === "'" || c === "`") { q = c; continue; } if (c === "{") b++; else if (c === "}") b--; if (k >= lastSh && b === 0) { endIdx = k + 1; break; } }
        if (endIdx < 0) endIdx = Math.min(src.length, lastSh + 4000);
        const region = src.slice(start, endIdx);
        const names = new Set();
        for (const m of region.matchAll(/function ([\w$]+)\((?:e,t|e)\)\{(?:return [\w$]+\(|e-=)/g)) names.add(m[1]);
        const store = {};
        let exposer = "";
        for (const n of names) exposer += "try{__DEC['" + n + "']=" + n + "}catch(e){}\n";
        try { new Function("__DEC", "'use strict';\n" + region + "\n" + exposer)(store); } catch (e) {}
        return store;
    } catch (e) { return {}; }
}
function _encLocalWrappers(src, P) {
    const win = src.slice(Math.max(0, P - 8000), P + 3000), base = Math.max(0, P - 8000), defs = {};
    for (const m of win.matchAll(/function ([\w$]+)\((?:e,t|e)\)\{return [\w$]+\([^{}]*\)\}/g)) {
        const nm = m[1], ix = base + m.index;
        if (!defs[nm] || Math.abs(ix - P) < Math.abs(defs[nm].idx - P)) defs[nm] = { idx: ix, text: m[0] };
    }
    return defs;
}
function _encDecodeSecretExec(src, secretExpr, P) {
    try {
        const decoders = _encRunDecoderCluster(src, P), wrappers = _encLocalWrappers(src, P);
        const need = new Set(), scan = s => { for (const m of s.matchAll(/([A-Za-z_$][\w$]*)\(/g)) need.add(m[1]); };
        scan(secretExpr);
        let changed = true;
        while (changed) { changed = false; const before = need.size; for (const n of [...need]) { if (wrappers[n]) scan(wrappers[n].text); } if (need.size > before) changed = true; }
        const args = [], vals = [];
        for (const n of need) { if (decoders[n] && !wrappers[n]) { args.push(n); vals.push(decoders[n]); } }
        let decl = "";
        for (const n of need) { if (wrappers[n]) decl += wrappers[n].text + "\n"; }
        const code = "const [" + args.join(",") + "]=arguments[0];\n" + decl + "\nreturn (" + secretExpr + ");";
        const v = new Function(code)(vals);
        return (typeof v === "string" && /^[\x20-\x7e]+$/.test(v) && v.length >= 3) ? v : null;
    } catch (e) { return null; }
}

function resolveBundleConfigs(text) {
    const R = buildBundleResolver(text);
    const subLocalStr = (expr, objStart) => {
        const region = text.slice(Math.max(0, objStart - 6000), objStart);
        const ids = [...new Set((expr.match(/[A-Za-z_$][\w$]*/g) || []))];
        for (const id of ids) {
            const esc = id.replace(/[$]/g, '\\$');
            if (new RegExp('\\b' + esc + '\\s*\\(').test(expr)) continue;
            const defRe = new RegExp('\\b' + esc + '\\s*=\\s*(["\'`])((?:\\\\.|(?!\\1).)*)\\1', 'g');
            let best = null, mm; while ((mm = defRe.exec(region))) best = mm[2];
            if (best !== null) expr = expr.replace(new RegExp('\\b' + esc + '\\b', 'g'), JSON.stringify(best));
        }
        return expr;
    };
    const found = [];
    let idx = 0; const NEEDLE = 'secret:';
    while ((idx = text.indexOf(NEEDLE, idx)) !== -1) {
        const b = text.lastIndexOf('{', idx);
        if (b < 0) { idx += NEEDLE.length; continue; }
        const e = _braceObj(text, b);
        if (e < 0) { idx += NEEDLE.length; continue; }
        const objStart = b, objStr = text.slice(b + 1, e);
        idx = e + 1;
        const fields = _splitTopComma(objStr); const map = {};
        for (const f of fields) { const ci = f.indexOf(':'); if (ci < 0) continue; map[f.slice(0, ci).trim()] = f.slice(ci + 1).trim(); }
        if (!('secret' in map) || !('startAt' in map) || !('length' in map) || !('version' in map)) continue;
        const skip = _cfgNum(map.startAt), length = _cfgNum(map.length), version = _cfgNum(map.version);
        if (isNaN(skip) || isNaN(length) || isNaN(version)) continue;
        let secretExpr = map.secret;
        try {
            const t0 = secretExpr.trim();
            const mm = /^([A-Za-z_$][\w$]*)\s*[\.\[]/.exec(t0);
            if (mm) {
                const objName = mm[1];
                const before = text.slice(0, objStart);
                const re = new RegExp('[^\\w$]' + objName.replace(/[$]/g, '\\$') + '\\s*=\\s*\\{', 'g');
                let om = null, mmm; while ((mmm = re.exec(before))) om = mmm;
                if (om) {
                    const ob = before.indexOf('{', om.index), oe = _braceObj(text, ob);
                    if (oe > ob) {
                        const ofields = _splitTopComma(text.slice(ob + 1, oe));
                        let best = null, bestLen = -1;
                        for (const of2 of ofields) {
                            const ci = of2.indexOf(':'); if (ci < 0) continue;
                            const val = of2.slice(ci + 1).trim();
                            if (/^function\b/.test(val)) continue;
                            if (!/[A-Za-z_$][\w$]*\(/.test(val)) continue;   // must use a decoder call
                            const sval = subLocalStr(val, objStart);        // resolve local key vars (const e="...")
                            let dec = null; try { dec = R.resolveExpr(sval, objStart); } catch (e3) {}
                            if (dec && !/\s/.test(dec) && dec.length >= 10 && dec.length > bestLen) { best = sval; bestLen = dec.length; }
                        }
                        if (best) secretExpr = best;
                    }
                }
            }
        } catch (e2) {}
        // inline local string vars used as bare args, e.g. r(1538,n) where const ...,n="Y$pG"
        try {
            const region = text.slice(Math.max(0, objStart - 6000), objStart);
            const ids = [...new Set((secretExpr.match(/[A-Za-z_$][\w$]*/g) || []))];
            for (const id of ids) {
                const esc = id.replace(/[$]/g, '\\$');
                if (new RegExp('\\b' + esc + '\\s*\\(').test(secretExpr)) continue; // decoder call → skip
                const defRe = new RegExp('\\b' + esc + '\\s*=\\s*(["\'`])((?:\\\\.|(?!\\1).)*)\\1', 'g');
                let best = null, mm; while ((mm = defRe.exec(region))) best = mm[2];
                if (best !== null) secretExpr = secretExpr.replace(new RegExp('\\b' + esc + '\\b', 'g'), JSON.stringify(best));
            }
        } catch (e2) {}
        let secret = R.resolveExpr(secretExpr, objStart);
        if (!secret) {
            // static resolver failed → try execution-based decode (heavy-obfuscation bundles)
            secret = _encDecodeSecretExec(text, secretExpr, objStart);
            if (secret) console.log('%c[RJ EncAuto] v' + version + ' secret decoded via EXECUTION fallback @ ' + objStart, 'color:#4ade80;font-weight:800');
        }
        if (!secret) { console.warn('[RJ EncAuto] config v' + version + ' secret decode FAILED @', objStart); continue; }
        const sc = encRoleScores(text, objStart);
        found.push({ key: secret, skip, length, version, sig: sc.sig, res: sc.res, ini: sc.ini });
    }
    // dedup by version|secret, summing role evidence
    const uniq = []; const seen = new Map();
    for (const c of found) {
        const k = c.version + '|' + c.key;
        if (seen.has(k)) { const e = seen.get(k); e.sig += c.sig; e.res += c.res; e.ini += c.ini; continue; }
        const e = { ...c }; seen.set(k, e); uniq.push(e);
    }
    // assign each config the role with the STRICTLY highest keyword score (tie/zero → unknown)
    for (const c of uniq) {
        const ranked = [['signin', c.sig], ['reserve', c.res], ['initiate', c.ini]].sort((a, b) => b[1] - a[1]);
        c.role = (ranked[0][1] > 0 && ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
    }
    if (uniq.length === 2) {
        const known = uniq.filter(c => c.role), unknown = uniq.filter(c => !c.role);
        if (known.length === 1 && unknown.length === 1) unknown[0].role = known[0].role === 'signin' ? 'reserve' : 'signin';
    }
    const out = { signin: null, reserve: null, initiate: null };
    for (const c of uniq) { if (c.role && !out[c.role]) out[c.role] = { key: c.key, skip: c.skip, length: c.length, version: c.version }; }
    // Single key in the bundle → it serves ALL purposes (newer bundles do this).
    if (uniq.length === 1) { const c = uniq[0]; const cfg = { key: c.key, skip: c.skip, length: c.length, version: c.version }; out.signin = out.signin || cfg; out.reserve = out.reserve || cfg; out.initiate = out.initiate || cfg; }
    return out;
}

async function encConfigAutoFetch(forceReload) {
    const bundleUrls = await findBundleUrls();
    if (!bundleUrls.length) {
        logStatus('\u23f3 Bundle not available yet (server 503 / not loaded) \u2014 will retry', 'y');
        return;
    }

    // Cache key = list signature; if unchanged and config already active, skip (unless forced).
    const currentHash = bundleUrls.join('|');

    if (!forceReload) {
        const storedHash  = localStorage.getItem(ENC_BUNDLE_HASH_KEY);
        const alreadyFresh = storedHash === currentHash
            && encConfig.signin.active && encConfig.signin.key
            && encConfig.reserve.active && encConfig.reserve.key;
        if (alreadyFresh) return;
    } else {
        logStatus('\ud83d\udd04 Force re-loading encryption config\u2026', 'y');
        localStorage.removeItem(ENC_BUNDLE_HASH_KEY);
    }

    logStatus(`🔍 Loading encryption config from ${bundleUrls.length} IVAC chunk(s)…`, 'y');
    try {
        let resolved = null, usedSrc = null, fetched = 0;
        for (const src of bundleUrls) {
            let text;
            try {
                const r = await pageFetch(src);
                if (!r.ok) { console.warn('[RJ EncAuto] skip', src, 'HTTP', r.status); continue; }
                text = await r.text();
            } catch (e) { console.warn('[RJ EncAuto] fetch failed', src, e.message); continue; }
            fetched++;
            if (text.indexOf('secret:') === -1 && text.indexOf('secret :') === -1) continue; // no cipher config here
            console.log('[RJ EncAuto] Bundle fetched:', text.length, 'chars from', src);
            const r2 = resolveBundleConfigs(text);
            if (r2.signin || r2.reserve || r2.initiate) { resolved = r2; usedSrc = src; break; }
            console.warn('[RJ EncAuto] chunk had secret: but decode failed @', src);
        }

        if (!resolved) {
            if (!fetched) throw new Error('no chunk fetched (all failed)');
            logStatus('⚠ Live resolve failed — keeping current verified config', 'y');
            console.warn('[RJ EncAuto] No config decoded from any chunk. Keeping existing config.');
            return { signin: false, reserve: false };
        }
        console.log('[RJ EncAuto] Config chunk:', usedSrc);
        const signin  = resolved.signin;
        const reserve = resolved.reserve;

        if (!signin && !reserve) {
            logStatus('⚠ Live resolve failed — keeping current verified config', 'y');
            console.warn('[RJ EncAuto] No config decoded from bundle. Keeping existing config.');
            return { signin: false, reserve: false };
        }

        // manual-lock: never overwrite a config the user entered by hand (marked manual) that is active+keyed
        const isLocked = (p) => encConfig[p] && encConfig[p].manual && encConfig[p].active && encConfig[p].key;
        if (signin) {
            if (isLocked('signin')) { logStatus('🔒 Signin: manual config kept (A_E did not overwrite)', 'g'); }
            else {
                encConfig.signin = { active: true, key: signin.key, skip: signin.skip, length: signin.length, version: signin.version };
                encConfigSave('signin');
                logStatus('✅ Signin: v' + signin.version + ' skip=' + signin.skip + ' len=' + signin.length + ' key[' + signin.key.length + ']', 'g');
            }
        } else {
            logStatus('⚠ Signin not resolved — keeping current config', 'y');
        }
        if (reserve) {
            if (isLocked('reserve')) { logStatus('🔒 Reserve: manual config kept (A_E did not overwrite)', 'g'); }
            else {
                encConfig.reserve = { active: true, key: reserve.key, skip: reserve.skip, length: reserve.length, version: reserve.version };
                encConfigSave('reserve');
                logStatus('✅ Reserve: v' + reserve.version + ' skip=' + reserve.skip + ' len=' + reserve.length + ' key[' + reserve.key.length + ']', 'g');
            }
        } else {
            logStatus('⚠ Reserve not resolved — keeping current config', 'y');
        }

        const initiate = resolved.initiate;
        const initOwn  = !!initiate;
        const initCfg  = initiate || signin || reserve;
        if (initCfg) {
            if (isLocked('initiate')) { logStatus('🔒 Initiate: manual config kept (A_E did not overwrite)', 'g'); }
            else {
                encConfig.initiate = { active: true, key: initCfg.key, skip: initCfg.skip, length: initCfg.length, version: initCfg.version };
                encConfigSave('initiate');
                logStatus('✅ Initiate' + (initOwn ? '' : ' (mirrored)') + ': v' + initCfg.version + ' skip=' + initCfg.skip + ' len=' + initCfg.length + ' key[' + initCfg.key.length + ']', 'g');
            }
        }

        localStorage.setItem(ENC_BUNDLE_HASH_KEY, currentHash);
        encConfigApplyToUI('signin');
        encConfigApplyToUI('reserve');
        encConfigApplyToUI('initiate');

        if (signin && reserve) {
            logStatus('✅ Encryption config fully resolved from live bundle!', 'g'); try { announceSuccess('Scan successful, encryption ready'); } catch(e) {}
        } else {
            logStatus('⚠ Partial resolve — other purpose kept on current config', 'y');
        }

        return { signin: !!signin, reserve: !!reserve };

    } catch (e) {
        console.error('[RJ EncAuto] Top-level error:', e);
        // KEEP existing config on crash — never send raw
        logStatus('⚠ Auto-config error: ' + e.message + ' — keeping current config', 'y');
        return { signin: false, reserve: false };
    }
}

