'use strict';
// ═══════════════════════════════════════════════════════════════════
//  cipher-headless.js — extract-ciphers.js-এর REPLACEMENT (encryption অংশ)
//
//  আগে: extract-ciphers.js obfuscated bundle-এর লেখা STATIC-ভাবে ঘেঁটে
//        key/skip/len বের করত (obfuscation বদলালে ভাঙত)।
//  এখন: headless Chromium-এ bundle চালিয়ে সাইটের NIJER cipher function
//        দিয়ে raw → c বানানো হয়; সাইট যখন নিজে ডাকে তখন argument গুলো
//        (key=secret, skip=startAt, length) খোলা অবস্থায় ধরা পড়ে।
//  তারপর সেই key/skip/len + সাইটের আসল output known ALGORITHM list-এর
//  সাথে মিলিয়ে algo-র নাম বের করে — extract-ciphers.js-এর মতোই একই
//  { role, version, algo, skip, len, key, code } shape ফেরত দেয়, যাতে
//  dashboard-এর Cipher table হুবহু আগের মতোই ভরে।
//
//  আউটপুট: extractCiphersHeadless(bundleFile) → Promise<{roles, code, verified}>
// ═══════════════════════════════════════════════════════════════════
const harness = require('./lib/harness');
const flows = require('./lib/flows');

const CH = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_';

// role অনুযায়ী কোন পেজে কোন flow চালালে সাইট নিজে cipher ডাকে
const FLOW = {
    Signin:  { route: '/signin', authed: false, drive: flows.runAuth,
               gate: { uploadFile: true, fileUploadConfirmed: false, slotOpen: false, paymentConfirm: false, uploadEnd: false } },
    Reserve: { route: '/appointment/time-slot', authed: true, drive: flows.runSlot, booked: true,
               gate: { uploadFile: true, fileUploadConfirmed: true, slotOpen: true, paymentConfirm: false, uploadEnd: true } }
};

// ── ADDITIVE-shift driver (extract-ciphers.js-এর সাথে হুবহু এক) ────
function shiftCipher(token, key, skip, len, dec, gen) {
    if (!token) return token;
    const p = Math.max(0, Math.min(skip, token.length)), a = Math.max(0, Math.min(len, token.length - p));
    if (!a) return token;
    const mid = token.slice(p, p + a).split(''), sh = gen(key, mid.length), n = CH.length;
    for (let i = 0; i < mid.length; i++) { const x = CH.indexOf(mid[i]); if (x < 0) continue; mid[i] = dec ? CH[((x - sh[i]) % n + n) % n] : CH[(x + sh[i]) % n]; }
    return token.slice(0, p) + mid.join('') + token.slice(p + a);
}

// ── known ALGORITHM list (extract-ciphers.js REGISTRY-র direct-ref অংশ) ─
//  প্রতিটার ref(token,key,skip,len,dec) সাইটের output-এর সাথে মিলিয়ে দেখা হয়।
const ALGORITHMS = [
    { id: 'LCG', crypt: 'cryptLCG',
      ref(token, key, skip, len, dec) { return shiftCipher(token, key, skip, len, dec, (k, L) => { let s = 123456789, m = 1103515245; for (let i = 0; i < k.length; i++) s = (s + k.charCodeAt(i)) >>> 0; const o = []; for (let i = 0; i < L; i++) { s = (Math.imul(s, m) + 12345) >>> 0; m = ((m + s) >>> 0) | 1; o.push((s >>> 16) % 64); } return o; }); },
      source: `\n// ---- LCG additive-shift cipher (seed 123456789 / mul 1103515245) ----\nfunction generateShiftsLCG(key, length) {\n  let seed = 123456789, mul = 1103515245;\n  for (let i = 0; i < key.length; i++) seed = (seed + key.charCodeAt(i)) >>> 0;\n  const shifts = new Array(length);\n  for (let i = 0; i < length; i++) { seed = (Math.imul(seed, mul) + 12345) >>> 0; mul = ((mul + seed) >>> 0) | 1; shifts[i] = (seed >>> 16) % Charset.length; }\n  return shifts;\n}\nfunction cryptLCG(token, key, skip, encryptLen, encrypt) { return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsLCG); }` },
    { id: 'LOGISTIC', crypt: 'cryptLogistic',
      ref(token, key, skip, len, dec) { return shiftCipher(token, key, skip, len, dec, (k, L) => { let u = 0.5; for (let i = 0; i < k.length; i++) u = (u + k.charCodeAt(i) / 256) % 1; if (u === 0) u = 0.5; const o = []; for (let f = 0; f < L + 100; f++) { u = (3.99 * u) * (1 - u); if (f >= 100) o.push(Math.floor(1e7 * u) % 64); } return o; }); },
      source: `\n// ---- Logistic-map chaotic shift cipher (r = 3.99, 100-step warmup) ----\nfunction generateShiftsLogistic(key, length) {\n  let u = 0.5;\n  for (let i = 0; i < key.length; i++) u = (u + key.charCodeAt(i) / 256) % 1;\n  if (u === 0) u = 0.5;\n  const shifts = [];\n  for (let f = 0; f < length + 100; f++) { u = (3.99 * u) * (1 - u); if (f >= 100) shifts.push(Math.floor(1e7 * u) % Charset.length); }\n  return shifts;\n}\nfunction cryptLogistic(token, key, skip, encryptLen, encrypt) { return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsLogistic); }` },
    { id: 'POLYNOMIAL', crypt: 'cryptPolynomial',
      ref(token, key, skip, len, dec) { return shiftCipher(token, key, skip, len, dec, (k, L) => { const co = []; for (let n = 0; n < k.length; n++) co.push(((k.charCodeAt(n % k.length) + n) % 67 + 67) % 67); const o = []; for (let d = 1; d <= L; d++) { let e = 0, t = 1; for (const a of co) { e = (e + a * t) % 67; t = (t * d) % 67; } o.push(e % 64); } return o; }); },
      source: `\n// ---- Polynomial (GF(67)) additive-shift cipher ----\nfunction generateShiftsPolynomial(key, length) {\n  const coeff = [];\n  for (let n = 0; n < key.length; n++) coeff.push(((key.charCodeAt(n % key.length) + n) % 67 + 67) % 67);\n  const shifts = [];\n  for (let d = 1; d <= length; d++) { let e = 0, t = 1; for (const a of coeff) { e = (e + a * t) % 67; t = (t * d) % 67; } shifts.push(e % Charset.length); }\n  return shifts;\n}\nfunction cryptPolynomial(token, key, skip, encryptLen, encrypt) { return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsPolynomial); }` },
    { id: 'CHACHA', crypt: 'cryptChaCha',
      ref(token, key, skip, len, dec) { return shiftCipher(token, key, skip, len, dec, (k, L) => { const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0; const qr = (e, a, b, c, d) => { e[a] = (e[a] + e[b]) >>> 0; e[d] = rotl(e[d] ^ e[a], 16); e[c] = (e[c] + e[d]) >>> 0; e[b] = rotl(e[b] ^ e[c], 12); e[a] = (e[a] + e[b]) >>> 0; e[d] = rotl(e[d] ^ e[a], 8); e[c] = (e[c] + e[d]) >>> 0; e[b] = rotl(e[b] ^ e[c], 7); }; const st = new Array(16).fill(0); for (let p = 0; p < k.length; p++) st[p % 16] = (st[p % 16] + k.charCodeAt(p)) >>> 0; st[15] = L; const o = []; const blocks = Math.ceil(L / 4); for (let p = 0; p < blocks; p++) { st[14] = p; const e = st.slice(); for (let r = 0; r < 10; r++) { qr(e, 0, 4, 8, 12); qr(e, 1, 5, 9, 13); qr(e, 2, 6, 10, 14); qr(e, 3, 7, 11, 15); } for (let kk = 0; kk < 4; kk++) o.push((e[kk] >>> 0) % 64); } return o; }); },
      source: `\n// ---- ChaCha-style keystream shift cipher (16-word state, 10 column rounds) ----\nfunction rotl32(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }\nfunction chachaQR(s, a, b, c, d) {\n  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl32(s[d] ^ s[a], 16);\n  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl32(s[b] ^ s[c], 12);\n  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl32(s[d] ^ s[a], 8);\n  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl32(s[b] ^ s[c], 7);\n}\nfunction generateShiftsChaCha(key, length) {\n  const st = new Array(16).fill(0);\n  for (let p = 0; p < key.length; p++) st[p % 16] = (st[p % 16] + key.charCodeAt(p)) >>> 0;\n  st[15] = length;\n  const shifts = [];\n  const blocks = Math.ceil(length / 4);\n  for (let p = 0; p < blocks; p++) {\n    st[14] = p;\n    const e = st.slice();\n    for (let r = 0; r < 10; r++) { chachaQR(e, 0, 4, 8, 12); chachaQR(e, 1, 5, 9, 13); chachaQR(e, 2, 6, 10, 14); chachaQR(e, 3, 7, 11, 15); }\n    for (let k = 0; k < 4; k++) shifts.push((e[k] >>> 0) % Charset.length);\n  }\n  return shifts;\n}\nfunction cryptChaCha(token, key, skip, encryptLen, encrypt) { return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsChaCha); }` },
    { id: 'CELLULAR', crypt: 'cryptCellular',
      ref(token, key, skip, len, dec) { return shiftCipher(token, key, skip, len, dec, (k, L) => { let cur = new Uint8Array(64); for (let i = 0; i < k.length; i++) cur[i % 64] ^= (k.charCodeAt(i) & 1); cur[32] = 1; const o = []; for (let s = 0; s < L; s++) { const nx = new Uint8Array(64); let v = 0; for (let d = 0; d < 64; d++) { const Lc = cur[(d + 63) % 64], C = cur[d], R = cur[(d + 1) % 64]; nx[d] = (30 >> ((Lc << 2) | (C << 1) | R)) & 1; if (d < 6) v = (v << 1) | nx[d]; } cur = nx; o.push(v % 64); } return o; }); },
      source: `\n// ---- Rule-30 cellular-automaton additive-shift cipher ----\nfunction generateShiftsCellular(key, length) {\n  let cur = new Uint8Array(64);\n  for (let i = 0; i < key.length; i++) cur[i % 64] ^= (key.charCodeAt(i) & 1);\n  cur[32] = 1;\n  const shifts = [];\n  for (let s = 0; s < length; s++) {\n    const nx = new Uint8Array(64); let v = 0;\n    for (let d = 0; d < 64; d++) { const L = cur[(d + 63) % 64], C = cur[d], R = cur[(d + 1) % 64]; nx[d] = (30 >> ((L << 2) | (C << 1) | R)) & 1; if (d < 6) v = (v << 1) | nx[d]; }\n    cur = nx; shifts.push(v % Charset.length);\n  }\n  return shifts;\n}\nfunction cryptCellular(token, key, skip, encryptLen, encrypt) { return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsCellular); }` },
    { id: 'RC4', crypt: 'cryptRC4',
      ref(token, key, skip, len, dec) { return shiftCipher(token, key, skip, len, dec, (k, L) => { const SZ = 64, S = Array.from({ length: SZ }, (_, i) => i); let j = 0; for (let i = 0; i < SZ; i++) { j = (j + S[i] + k.charCodeAt(i % k.length)) % SZ; const t = S[i]; S[i] = S[j]; S[j] = t; } let i = 0; j = 0; const o = []; for (let x = 0; x < L; x++) { i = (i + 1) % SZ; j = (j + S[i]) % SZ; const t = S[i]; S[i] = S[j]; S[j] = t; o.push(S[(S[i] + S[j]) % SZ]); } return o; }); },
      source: `\n// ---- RC4 (64-element state) additive-shift cipher ----\nfunction generateShiftsRC4(key, length) {\n  const SZ = 64, S = Array.from({ length: SZ }, (_, i) => i);\n  let j = 0;\n  for (let i = 0; i < SZ; i++) { j = (j + S[i] + key.charCodeAt(i % key.length)) % SZ; [S[i], S[j]] = [S[j], S[i]]; }\n  let i = 0; j = 0; const shifts = [];\n  for (let k = 0; k < length; k++) { i = (i + 1) % SZ; j = (j + S[i]) % SZ; [S[i], S[j]] = [S[j], S[i]]; shifts.push(S[(S[i] + S[j]) % SZ]); }\n  return shifts;\n}\nfunction cryptRC4(token, key, skip, encryptLen, encrypt) { return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsRC4); }` },
    { id: 'LFSR', crypt: 'cryptLFSR',
      ref(token, key, skip, len, dec) { return shiftCipher(token, key, skip, len, dec, (k, L) => { let u = 74565, s = 424090, l = 773615; for (let i = 0; i < k.length; i++) { const c = k.charCodeAt(i); u ^= (c | 1); s ^= 1 | (c << 2); l ^= 1 | (c << 4); } const o = []; for (let p = 0; p < L; p++) { let e = 0; for (let t = 0; t < 6; t++) { const ub = 1 & (u ^ u >> 2 ^ u >> 3 ^ u >> 5); u = (u >>> 1) | (ub << 15); const sb = 1 & (s ^ s >> 1 ^ s >> 2 ^ s >> 7); s = (s >>> 1) | (sb << 16); const lb = 1 & (l ^ l >> 1 ^ l >> 2 ^ l >> 22); l = (l >>> 1) | (lb << 23); const h = (ub & sb) ^ (~ub & lb); e = (e << 1) | h; } o.push(((e % 64) + 64) % 64); } return o; }); },
      source: `\n// ---- Three-LFSR Geffe-generator additive-shift cipher ----\nfunction generateShiftsLFSR(key, length) {\n  let u = 74565, s = 424090, l = 773615;\n  for (let i = 0; i < key.length; i++) { const c = key.charCodeAt(i); u ^= (c | 1); s ^= 1 | (c << 2); l ^= 1 | (c << 4); }\n  const shifts = [];\n  for (let p = 0; p < length; p++) {\n    let e = 0;\n    for (let t = 0; t < 6; t++) {\n      const ub = 1 & (u ^ u >> 2 ^ u >> 3 ^ u >> 5); u = (u >>> 1) | (ub << 15);\n      const sb = 1 & (s ^ s >> 1 ^ s >> 2 ^ s >> 7); s = (s >>> 1) | (sb << 16);\n      const lb = 1 & (l ^ l >> 1 ^ l >> 2 ^ l >> 22); l = (l >>> 1) | (lb << 23);\n      const h = (ub & sb) ^ (~ub & lb);\n      e = (e << 1) | h;\n    }\n    shifts.push(((e % Charset.length) + Charset.length) % Charset.length);\n  }\n  return shifts;\n}\nfunction cryptLFSR(token, key, skip, encryptLen, encrypt) { return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsLFSR); }` }
];

const SHARED_ADDITIVE = `\n// shared driver for additive-shift algorithms\nfunction additiveShift(token, key, skip, encryptLen, encrypt, genShifts) {\n  if (!token) return token;\n  const p = Math.max(0, Math.min(skip, token.length));\n  const a = Math.max(0, Math.min(encryptLen, token.length - p));\n  if (a === 0) return token;\n  const mid = token.slice(p, p + a).split("");\n  const shifts = genShifts(key, mid.length), n = Charset.length;\n  for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x === -1) continue; mid[i] = encrypt ? Charset[(x + shifts[i]) % n] : Charset[((x - shifts[i]) % n + n) % n]; }\n  return token.slice(0, p) + mid.join("") + token.slice(p + a);\n}`;

function rnd(n) { let s = ''; for (let i = 0; i < n; i++) s += CH[Math.floor(Math.random() * 64)]; return s; }

// ── headless: এক role চালিয়ে সাইটের নিজের cipher-call ধরি ─────────
//  ফেরত: { key, skip, len, output, sample:[{tok,out}...] } অথবা null
async function captureRole(browser, server, roleName) {
    const f = FLOW[roleName];
    // skip+len ঢাকতে যথেষ্ট লম্বা একটা marker (turnstile token আকৃতির)
    const marker = '1.' + rnd(60);
    let session = null;
    try {
        const state = harness.makeState({ gate: f.gate, booked: !!f.booked });
        session = await harness.openSession(browser, server.port, state,
            { route: f.route, authed: f.authed, marker: marker });
        await f.drive(session, state);
        await session.page.waitForTimeout(500);

        // সাইট নিজে যে ডাকটা দিয়েছে (text === আমাদের marker) — key/skip/len খোলা
        const call = await session.page.evaluate(function (t) {
            const c = window.__probeCipherCalls || [];
            for (let i = c.length - 1; i >= 0; i--) {
                if (c[i] && c[i].text === t && typeof c[i].out === 'string')
                    return { secret: c[i].secret, startAt: c[i].startAt | 0, length: c[i].length | 0, out: c[i].out };
            }
            return null;
        }, marker).catch(function () { return null; });
        if (!call || !call.secret) return null;

        // ঐ (secret,startAt,length) দিয়ে যে function marker→out দেয়, সেটা দিয়ে
        //   কয়েকটা test token-এর reference output নিই (algo মেলাতে লাগবে)
        const tests = []; for (let i = 0; i < 24; i++) tests.push(rnd(call.startAt + call.length + 2));
        const refs = await session.page.evaluate(function (arg) {
            const list = window.__probeCipher || []; let fn = null;
            for (const f of list) { try { if (f.fn(arg.marker, arg.secret, arg.startAt, arg.length) === arg.out) { fn = f.fn; break; } } catch (_) {} }
            if (!fn) return null;
            return arg.tests.map(function (t) { try { return fn(t, arg.secret, arg.startAt, arg.length); } catch (_) { return null; } });
        }, { marker: marker, secret: call.secret, startAt: call.startAt, length: call.length, out: call.out, tests: tests }).catch(function () { return null; });

        const sample = [];
        if (refs) for (let i = 0; i < tests.length; i++) if (typeof refs[i] === 'string') sample.push({ tok: tests[i], out: refs[i] });
        return { key: call.secret, skip: call.startAt, len: call.length, output: call.out, marker: marker, sample: sample };
    } catch (e) {
        return null;
    } finally {
        try { if (session) await session.close(); } catch (_) {}
    }
}

// ── known list-এর সাথে মিলিয়ে algo identify ───────────────────────
//  সাইটের sample output গুলো যে ALGORITHM ref হুবহু বানায়, সেটাই algo।
function identifyAlgo(cap) {
    if (!cap.sample.length) return null;
    // ১) known list-এর সাথে হুবহু মিলিয়ে দেখি — মিললে algo-র নাম পাই
    for (const A of ALGORITHMS) {
        let ok = true;
        for (const s of cap.sample) {
            let got; try { got = A.ref(s.tok, cap.key, cap.skip, cap.len, false); } catch (_) { ok = false; break; }
            if (got !== s.out) { ok = false; break; }
        }
        if (ok) return { id: A.id, crypt: A.crypt, source: A.source };
    }
    // ২) known list-এ নেই → additive-shift কিনা দেখি: প্রতি position-এ
    //    shift = (out[i] - in[i]) mod 64 সব sample-এ একই হলে ওটাই cipher।
    //    সাইটের নিজের output থেকেই বানানো, তাই byte-exact (LFSR/LCG… সবই এতে পড়ে)।
    const shifts = recoverShiftTable(cap);
    if (shifts) {
        const src = `\n// ---- Additive-shift cipher (per-position keystream recovered from the live site) ----\nconst SHIFTS = [${shifts.join(',')}];\nfunction cryptShiftTable(token, key, skip, encryptLen, encrypt) {\n  if (!token) return token;\n  const p = Math.max(0, Math.min(skip, token.length));\n  const a = Math.max(0, Math.min(encryptLen, token.length - p));\n  if (a === 0) return token;\n  const mid = token.slice(p, p + a).split(""), n = Charset.length;\n  for (let i = 0; i < mid.length; i++) { const x = charsetIndex(mid[i]); if (x === -1) continue; mid[i] = encrypt ? Charset[(x + SHIFTS[i]) % n] : Charset[((x - SHIFTS[i]) % n + n) % n]; }\n  return token.slice(0, p) + mid.join("") + token.slice(p + a);\n}`;
        return { id: 'ADDITIVE', crypt: 'cryptShiftTable', source: src };
    }
    return null;
}

// per-position additive shift recover: shift[i] = (out[i]-in[i]) mod 64, সব sample-এ এক হতে হবে
function recoverShiftTable(cap) {
    const p = cap.skip, a = cap.len;
    if (a < 1) return null;
    let shifts = null;
    for (const s of cap.sample) {
        if (s.tok.length < p + a || s.out.length < p + a) return null;
        const cur = [];
        for (let i = 0; i < a; i++) {
            const x = CH.indexOf(s.tok[p + i]), y = CH.indexOf(s.out[p + i]);
            if (x < 0 || y < 0) return null;
            cur.push(((y - x) % 64 + 64) % 64);
        }
        if (!shifts) shifts = cur;
        else { for (let i = 0; i < a; i++) if (shifts[i] !== cur[i]) return null; } // pure additive নয়
    }
    return shifts;
}

// ── cipher.js এমিট (extract-ciphers.js-এর emit-এর সাথে সামঞ্জস্যপূর্ণ) ──
function emitCipherJs(roles) {
    let head = `// cipher.js — AUTO-GENERATED (headless: সাইটের নিজের cipher থেকে).\n// key/skip/length সাইটের live ডাক থেকে; algorithm known-list-এর সাথে মিলিয়ে যাচাই।\n\nconst Charset = "${CH}";\n\nfunction charsetIndex(ch) { return Charset.indexOf(ch); }\n`;
    let cfgs = '', footerNames = [];
    const emitted = new Set(); let algoSrc = '';
    for (const c of roles) {
        if (!c.algo) continue;
        const R = c.role;
        cfgs += `\n// ${R} cipher (${c.algo.id}) — headless-captured key\nconst ${R}Key = ${JSON.stringify(c.key)};\nconst ${R}Skip = ${c.skip};\nconst ${R}EncryptLen = ${c.len};\nfunction ProcessToken${R}(token) { return ${c.algo.crypt}(token, ${R}Key, ${R}Skip, ${R}EncryptLen, true); }\nfunction ReverseToken${R}(token) { return ${c.algo.crypt}(token, ${R}Key, ${R}Skip, ${R}EncryptLen, false); }\n`;
        footerNames.push(R + 'Key', R + 'Skip', R + 'EncryptLen', 'ProcessToken' + R, 'ReverseToken' + R);
        if (!emitted.has(c.algo.source)) { emitted.add(c.algo.source); algoSrc += c.algo.source + '\n'; }
    }
    if (!cfgs) return '';
    const roleList = roles.filter(c => c.algo).map(c => c.role);
    let router = '\n// ---- Router ----\nfunction encryptToken(rawToken, purpose) {\n';
    for (const R of roleList) router += `  if (purpose === ${JSON.stringify(R)}) return ProcessToken${R}(rawToken);\n`;
    router += '  return rawToken;\n}\nfunction decryptToken(rawToken, purpose) {\n';
    for (const R of roleList) router += `  if (purpose === ${JSON.stringify(R)}) return ReverseToken${R}(rawToken);\n`;
    router += '  return rawToken;\n}\n';
    footerNames.push('encryptToken', 'decryptToken');
    return head + cfgs + '\n' + router + '\n' + SHARED_ADDITIVE + '\n' + algoSrc +
        `\nif (typeof module !== "undefined") {\n  module.exports = { Charset, ${footerNames.join(', ')} };\n}\n`;
}

// ── মূল entry: extract-ciphers.js-এর extractCiphers()-এর REPLACEMENT ──
//  একই shape ফেরত দেয়: { roles:[{role,version,algo,skip,len,key}], code, verified }
async function extractCiphersHeadless(bundleFile) {
    const out = { roles: [], code: '', verified: '', via: 'headless' };
    let chromium, browser, server;
    try { chromium = require('playwright-core').chromium; }
    catch (_) { out.error = 'playwright-core নেই'; return out; }
    try {
        server = await harness.startServer(bundleFile);
        browser = await chromium.launch({ executablePath: harness.findChromium(), args: ['--no-sandbox'] });
        const resolved = [];
        let pass = 0, total = 0;
        for (const roleName of ['Signin', 'Reserve']) {
            const cap = await captureRole(browser, server, roleName);
            if (!cap) continue;
            total++;
            const algo = identifyAlgo(cap);
            if (algo) pass++;
            const entry = {
                role: roleName, version: '', algo: algo ? algo.id : '(unknown)',
                skip: cap.skip, len: cap.len, key: cap.key,
                output: cap.output, _algo: algo
            };
            resolved.push(entry);
            out.roles.push({ role: entry.role, version: entry.version, algo: entry.algo, skip: entry.skip, len: entry.len, key: entry.key, output: entry.output });
        }
        // code (standalone cipher.js) — যেগুলোর algo identify হয়েছে
        out.code = emitCipherJs(resolved.map(function (e) { return { role: e.role, key: e.key, skip: e.skip, len: e.len, algo: e._algo }; }));
        out.verified = total ? (pass + '/' + total) : '';
    } catch (e) {
        out.error = e.message;
    } finally {
        try { if (browser) await browser.close(); } catch (_) {}
        try { if (server) server.close(); } catch (_) {}
    }
    return out;
}

module.exports = { extractCiphersHeadless, ALGORITHMS };
