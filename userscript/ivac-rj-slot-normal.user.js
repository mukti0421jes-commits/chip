// ==UserScript==
// @name         RJ SLOT (Normal, no-dynamic)
// @namespace    http://tampermonkey.net/
// @version      10.4.6
// @description  RJ SLOT v7.5 engine + Manual Panel clone. Fixed Appointment ID save & Smart Skip
// @author       RJ SLOT
// @match        https://appointment.ivacbd.com/*
// @match        https://appointment-dev-ivacbd-v2.dgi-rnd.com
// @match        https://appointment-dev-ivacbd-v2.dgi-rnd.com/*
// @match        https://*.ivacbd.com/*
// @match        https://ivacbd.com/*
// @match        https://payment.ivacbd.com/*
// @match        https://epay-gw.sslcommerz.com/*
// @match        https://checkout.pathaopay.com/*
// @match        https://checkout.dgepay.net/*
// @connect      api.ivacbd.com
// @connect      capsolver.com
// @connect      api.capmonster.cloud
// @connect      challenges.cloudflare.com
// @connect      duttauzzal.shop
// @connect      localhost
// @connect      127.0.0.1
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @run-at       document-end
// @noframes
// ==/UserScript==
(function() { 'use strict';

// ==================== PAGE-CONTEXT FETCH (HTTP/2 CAPABLE) ====================
const pageFetch = (() => {
    try {
        if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.fetch === 'function') {
            console.log('[RJ] Using unsafeWindow.fetch (page-context — HTTP/2 via browser stack)');
            return unsafeWindow.fetch.bind(unsafeWindow);
        }
    } catch(e) {
        console.log('[RJ] unsafeWindow access failed, using sandboxed fetch:', e.message);
    }
    console.log('[RJ] Using sandboxed window.fetch');
    return window.fetch.bind(window);
})();

// ==================== HTTP/2 CONNECTION MANAGER (SILENT KEEP-ALIVE) ====================
const H2 = {
    _state: {
        warmed: false,
        lastActivity: 0,
        activeStreams: 0,
        totalRequests: 0,
        h2Confirmed: false,
        keepAliveTimerId: null,
        keepAliveIntervalMs: 60 * 1000,
        preWarmPromise: null,
        failedCount: 0
    },

    async preWarm() {
        if (this._state.warmed) return true;
        if (this._state.preWarmPromise) return this._state.preWarmPromise;

        this._state.preWarmPromise = (async () => {
            try {
                await this._silentKeepAlivePing();
                this._state.warmed = true;
                this._state.lastActivity = Date.now();
                this._startKeepAlive();
                return true;
            } catch(e) {
                return false;
            } finally {
                this._state.preWarmPromise = null;
            }
        })();
        return this._state.preWarmPromise;
    },

    async _silentKeepAlivePing() {
        return new Promise((resolve) => {
            const gmApi = (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) ||
                         (typeof GM !== 'undefined' && GM.xmlHttpRequest);

            if (!gmApi) {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);

                pageFetch('https://api.ivacbd.com/', {
                    method: 'HEAD',
                    signal: controller.signal,
                    cache: 'no-store'
                }).catch(() => {}).finally(() => {
                    clearTimeout(timeoutId);
                    resolve();
                });
                return;
            }

            const timeoutId = setTimeout(() => {
                resolve();
            }, 5000);

            gmApi({
                method: 'HEAD',
                url: 'https://api.ivacbd.com/',
                timeout: 4000,
                onload: () => {
                    clearTimeout(timeoutId);
                    resolve();
                },
                onerror: () => {
                    clearTimeout(timeoutId);
                    resolve();
                },
                ontimeout: () => {
                    clearTimeout(timeoutId);
                    resolve();
                }
            });
        });
    },

    _detectProtocol() {
        try {
            const entries = performance.getEntriesByType('resource');
            const apiEntries = entries.filter(e => e.name.includes('api.ivacbd.com'));
            if (apiEntries.length > 0) {
                const latest = apiEntries[apiEntries.length - 1];
                const proto = latest.nextHopProtocol || '';
                this._state.h2Confirmed = (proto === 'h2' || proto === 'h2c');
            }
        } catch(e) {}
    },

    _startKeepAlive() {
        if (this._state.keepAliveTimerId) clearInterval(this._state.keepAliveTimerId);

        this._state.keepAliveTimerId = setInterval(async () => {
            const idleMs = Date.now() - this._state.lastActivity;
            if (idleMs < 10000 || this._state.activeStreams > 0) return;

            await this._silentKeepAlivePing();
            this._state.lastActivity = Date.now();
        }, this._state.keepAliveIntervalMs);
    },

    stopKeepAlive() {
        if (this._state.keepAliveTimerId) {
            clearInterval(this._state.keepAliveTimerId);
            this._state.keepAliveTimerId = null;
        }
    },

    headersToObject(headers) {
        const obj = {};
        if (headers instanceof Headers) { headers.forEach((v, k) => obj[k] = v); }
        else if (typeof headers === 'object' && headers !== null) { Object.assign(obj, headers); }
        return obj;
    },

    // POST the request to the local relay (proxy-relay.js on :8781); the relay performs it
    // through the chosen proxy (real Chromium → passes Cloudflare) and returns { status, body }.
    _relayFetch(url, init, proxy, logId) {
        return new Promise((resolve, reject) => {
            const gmApi = (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) || (typeof GM !== 'undefined' && GM.xmlHttpRequest);
            if (!gmApi) { if (logId) netLogUpdate(logId, { state: 'fail', status: 'ERR', note: 'no GM for relay' }); return reject(new Error('No GM for proxy relay')); }
            const relays = ['http://127.0.0.1:8781/relay', 'http://localhost:8781/relay'];
            let i = 0;
            const tryRelay = () => {
                if (i >= relays.length) { if (logId) netLogUpdate(logId, { state: 'fail', status: 'ERR', note: 'relay unreachable' }); return reject(new Error('Proxy relay not reachable — run proxy-relay.js on :8781')); }
                const relayUrl = relays[i++];
                const payload = JSON.stringify({ url, method: init.method || 'GET', headers: init.headers || {}, body: (init.body != null && typeof init.body !== 'string') ? String(init.body) : (init.body || null), proxy });
                gmApi({ method: 'POST', url: relayUrl, headers: { 'content-type': 'application/json' }, data: payload, timeout: 60000,
                    onload: (resp) => {
                        let j; try { j = JSON.parse(resp.responseText); } catch(e) { return tryRelay(); }
                        if (resp.status >= 200 && resp.status < 300 && j && typeof j.status === 'number') {
                            // relay returns status 0 when the in-browser fetch itself failed
                            // (bad proxy / Cloudflare network block). Response() only accepts
                            // 200–599, so map any out-of-range/0 status to 502 (→ triggers rotate).
                            const raw = j.status;
                            const safeStatus = (raw >= 200 && raw <= 599) ? raw : 502;
                            const nullBody = [101, 103, 204, 205, 304].includes(safeStatus);
                            const isOk = safeStatus >= 200 && safeStatus < 400;
                            if (logId) netLogUpdate(logId, { status: safeStatus, state: isOk ? 'ok' : 'fail', note: `HTTP ${raw === safeStatus ? raw : raw + '→' + safeStatus} (proxy ${proxy.host}:${proxy.port})${raw === 0 ? ' fetch-error' : ''}` });
                            resolve(new Response(nullBody ? null : (j.body != null ? String(j.body) : ''), { status: safeStatus, statusText: j.statusText || '' }));
                        } else if (j && j.error) { if (logId) netLogUpdate(logId, { state: 'fail', status: 'ERR', note: 'proxy: ' + j.error }); reject(new Error('proxy relay: ' + j.error)); }
                        else { tryRelay(); }
                    },
                    onerror: tryRelay, ontimeout: tryRelay });
            };
            tryRelay();
        });
    },

    async gmFetch(url, init = {}) {
        const method  = init.method || 'GET';
        const headers = this.headersToObject(init.headers || {});
        const body    = init.body || null;
        const signal  = init.signal;

        if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

        const isConnectionCheck = url === 'https://api.ivacbd.com/' && method === 'HEAD';

        if (!isConnectionCheck) {
            console.log(`%c[RJ Fetch] ➡️ Request Sent`, 'color: #60a5fa; font-weight: bold;', { url, method, headers, body });
        }

        const logId = isConnectionCheck ? null : netLogAdd({ method: method, url: url, tag: getTagFromUrl(url), state: 'pending', note: 'request sent' });

        // ── FORCE GM (CORS-immune) ──────────────────────────────────────────────
        // Some endpoints (payment/dg-epay/initiate) return NO CORS headers, so a native
        // fetch is always blocked by the preflight. Go straight through GM_xmlhttpRequest
        // (not subject to CORS) instead of wasting a native attempt that logs an error.
        if (init.forceGM) return this._gmFallback(url, init, logId);

        // ── PER-CALL PROXY ROTATION ────────────────────────────────────────────
        // When rotation (or a single connected proxy) is active, route this call through
        // the local relay so it egresses via a proxy IP. Sticky-on-success / rotate-on-error.
        const _proxy = (typeof pickProxyForCall === 'function') ? pickProxyForCall() : ((typeof window !== 'undefined') ? window._rjActiveProxy : null);
        const _bodySimple = (body == null || typeof body === 'string');
        if (_proxy && _proxy.host && !isConnectionCheck && _bodySimple) {
            try {
                const resp = await this._relayFetch(url, { method, headers, body }, _proxy, logId);
                if (resp.status >= 400 && typeof rotateProxyOnError === 'function') rotateProxyOnError(_proxy);  // rotate for NEXT call
                return resp;
            } catch (e) {
                if (typeof rotateProxyOnError === 'function') rotateProxyOnError(_proxy);   // proxy/relay failed → rotate
                if (!isConnectionCheck) console.log('%c[RJ Fetch] ⚠ relay failed, trying direct', 'color:#fcd34d', { error: e.message });
                // fall through to direct fetch below
            }
        }

        try {
            const fetchInit = { method, headers, credentials: init.credentials || 'omit' };
            if (body)            fetchInit.body     = body;
            if (init.referrer)   fetchInit.referrer = init.referrer;
            if (signal)          fetchInit.signal   = signal;

            const response = await pageFetch(url, fetchInit);

            if (!isConnectionCheck) {
                console.log(`%c[RJ Fetch] ⬅️ Response Received (${response.status})`, 'color: #4ade80; font-weight: bold;', { url, status: response.status });
            }

            const isOk = response.status >= 200 && response.status < 400;
            if (logId) netLogUpdate(logId, { status: response.status, state: isOk ? 'ok' : 'fail', note: `HTTP ${response.status}` });

            return response;
        } catch (err) {
            if (err.name === 'AbortError') {
                if (logId) netLogUpdate(logId, { state: 'cancel', status: '⊘', note: 'aborted' });
                throw err;
            }
            if (!isConnectionCheck) {
                console.log(`%c[RJ Fetch] ⚠ pageFetch failed, trying GM fallback`, 'color: #fcd34d; font-weight: bold;', { url, error: err.message });
            }
            return this._gmFallback(url, init, logId);
        }
    },

    _gmFallback(url, init, logId) {
        return new Promise((resolve, reject) => {
            const gmApi = (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) || (typeof GM !== 'undefined' && GM.xmlHttpRequest);
            if (!gmApi) {
                if (logId) netLogUpdate(logId, { state: 'fail', status: 'ERR', note: 'No fetch available' });
                return reject(new Error('No fetch method available'));
            }

            const method  = init.method || 'GET';
            const headers = this.headersToObject(init.headers || {});
            const body    = init.body || null;
            const signal  = init.signal;
            const isConnectionCheck = url === 'https://api.ivacbd.com/' && method === 'HEAD';

            gmApi({
                method, url, headers, data: body, timeout: 30000,
                onload: (response) => {
                    if (!isConnectionCheck) {
                        console.log(`%c[RJ GM Fallback] ⬅️ Response (${response.status})`, 'color: #4ade80; font-weight: bold;', { url, status: response.status });
                    }

                    const isOk = response.status >= 200 && response.status < 400;
                    if (logId) netLogUpdate(logId, { status: response.status, state: isOk ? 'ok' : 'fail', note: `HTTP ${response.status} (GM)` });

                    resolve(new Response(response.responseText, { status: response.status, statusText: response.statusText }));
                },
                onerror: (err) => {
                    if (logId) netLogUpdate(logId, { state: 'fail', status: 'ERR', note: 'network error' });
                    reject(new Error('GM_xmlhttpRequest network error'));
                },
                ontimeout: () => {
                    if (logId) netLogUpdate(logId, { state: 'fail', status: 'TMO', note: 'timeout' });
                    reject(new Error('GM_xmlhttpRequest timeout'));
                }
            });

            if (signal) signal.addEventListener('abort', () => {
                if (logId) netLogUpdate(logId, { state: 'cancel', status: '⊘', note: 'aborted' });
                reject(new DOMException('Aborted', 'AbortError'));
            });
        });
    },

    async fetchH2(url, init = {}) {
        if (!this._state.warmed) {
            this.preWarm().catch(() => {});
        }

        const h2Init = { ...init, credentials: init.credentials || 'omit' };

        this._state.activeStreams++;
        this._state.totalRequests++;
        this._state.lastActivity = Date.now();

        try {
            const response = await this.gmFetch(url, h2Init);
            this._state.warmed = true;
            this._state.lastActivity = Date.now();
            this._state.failedCount = 0;
            return response;
        } catch(err) {
            this._state.lastActivity = Date.now();
            this._state.failedCount++;
            if (this._state.failedCount > 3) this._state.warmed = false;
            throw err;
        } finally {
            this._state.activeStreams--;
        }
    },

    async fetchH2Critical(url, init = {}) { return this.fetchH2(url, { ...init, keepalive: true }); },
    async fetchH2Upload(url, init = {}) { return this.fetchH2(url, { ...init, keepalive: false }); },
    getStats() { return { warmed: this._state.warmed, h2Confirmed: this._state.h2Confirmed, activeStreams: this._state.activeStreams, totalRequests: this._state.totalRequests, idleMs: Date.now() - this._state.lastActivity, failedCount: this._state.failedCount }; }
};

function getTagFromUrl(url) {
    if (!url) return 'network';
    if (url.includes('sign-in') || url.includes('signin')) return 'signin';
    if (url.includes('verifyOtp') || url.includes('verify')) return 'verify';
    if (url.includes('reserveSlot')) return 'reserve';
    if (url.includes('appointment-booking-config') || url.includes('appointment')) return 'book';
    if (url.includes('initiate')) return 'initiate';
    if (url.includes('signup')) return 'signup';
    if (url.includes('forgot-password')) return 'advance';
    if (url.includes('upload') || url.includes('file')) return 'upload';
    if (url.includes('download')) return 'invoice';
    return 'network';
}

H2.preWarm();

// ==================== API CONFIG ====================
const API_SIGNIN_V2 = "https://api.ivacbd.com/iams/api/v1/auth/v23-sign-in";
// x-sec-navigation-state / x-sec-runtime-state are NOT per-session random values — they are
// FIXED constants baked into the site bundle (the obfuscated code assembles them from string
// literals, e.g. the "1.9a5" fragment of the runtime-state). Confirmed against the live bundle
// + HAR. The server may validate them, so we send the exact bundle constants, not a random uuid.
// If a future bundle changes these, update the two constants below (grep the bundle for
// "x-sec-navigation-state" / "x-sec-runtime-state", or read them from a fresh request HAR).
const X_SEC_NAV_STATE     = '80d51dc5-af20-46fa-a7bb-e6a8f3f80065';
const X_SEC_RUNTIME_STATE = 'v1.5a4c8831.9a53.47ed.b579.042a2c0cee5a';
function _navState()     { return X_SEC_NAV_STATE; }
function _runtimeState() { return X_SEC_RUNTIME_STATE; }
const API_SIGNUP    = "https://api.ivacbd.com/iams/api/v1/auth/signup";
// initiate URL carries a fixed dg-epay payment-method id segment:
//   /payment/{PAYMENT_METHOD_ID}/dg-epay/initiate   (confirmed from live bundle + real fetch).
// The id is NOT the appointmentId (that goes in the body). If a future bundle changes it,
// update PAYMENT_METHOD_ID (grep the real initiate URL).
const PAYMENT_METHOD_ID = 'dcd59a95-d55e-41ed-b57c-60416e01617e';
const API_INITIATE  = `https://api.ivacbd.com/iams/api/v1/payment/${PAYMENT_METHOD_ID}/dg-epay/initiate`;
const API_FORGOT    = "https://api.ivacbd.com/iams/api/v1/forgot-password/sendOtp";
const API_VERIFY    = "https://api.ivacbd.com/iams/api/v1/otp/verifySigninOtp";
const API_RESERVE   = "https://api.ivacbd.com/iams/api/v1/slots/reserveSlot";
const API_BOOK      = "https://api.ivacbd.com/iams/api/v1/appointment/get-booking-config";
const API_SLOT_STATUS = "https://api.ivacbd.com/iams/api/v1/file/file-confirmation_and_slot-status";
const API_REFERRER  = "https://appointment.ivacbd.com/";
const API_SMS_SERVER = "https://duttauzzal.shop/sms.php";


function getDeviceId() {
    let id = localStorage.getItem('rj_device_id');
    if (!id) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        id = Array.from({length: 20}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        localStorage.setItem('rj_device_id', id);
    }
    return id;
}

// ==================== CAPTCHA TOKEN ENCRYPTION (10 VERSION HARDCODED) ====================
const CAPTCHA_CHARSET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
const CAPTCHA_ALPHA_LEN = CAPTCHA_CHARSET.length;

// ==================== CAPTCHA CIPHER ALGORITHMS ====================
// Verified byte-for-byte against the live IVAC bundle (via cipher_tool.js registry).
// IVAC rotates which version+key is active ~2x/day; the math per version is fixed.
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

// --- v9: mod_square / BBS-style x=x*x mod A additive-shift ---
// A is fixed in the algorithm; if a future bundle uses a different modulus, the
// live-scan overrides encConfig.modulus (see resolveConfig) and it is used here.
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

// NO hardcoded key/version — IVAC rotates the bundle ~2x/day, so key+version+skip+length
// are ALWAYS resolved live from the bundle (encConfigAutoFetch). The algorithm math for
// each version (below) is fixed and does not rotate, so those stay in code.
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

// Respect the per-endpoint token-mode checkboxes next to the buttons:
//   signin / reserve → checkbox CHECKED = send RAW token (skip encryption); unchecked = encrypted.
//   initiate         → checkbox CHECKED = ENCRYPT per Initiate config;      unchecked = raw (default).
function encTokenForCall(rawToken, purpose) {
    if (purpose === 'initiate') {
        // The live initiate x-token is ENCRYPTED ("1."-prefixed) — confirmed from the real fetch.
        // Encrypt by default; the checkbox can force RAW only if ever needed for debugging.
        return document.getElementById('chk-initiate-raw')?.checked ? rawToken : encryptTokenByPurpose(rawToken, 'initiate');
    }
    const rawChkId = purpose === 'signin' ? 'chk-signin-raw' : 'chk-reserve-raw';
    return document.getElementById(rawChkId)?.checked ? rawToken : encryptTokenByPurpose(rawToken, purpose);
}

const ENC_BUNDLE_HASH_KEY = 'rj_enc_bundle_hash';

// NO hardcoded defaults — config is ALWAYS resolved live from the IVAC bundle.
// If live resolve fails, encryption is DISABLED (not sent with wrong key).

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
    // NOTE: no auto bundle-fetch here — it hangs the browser. Config is resolved
    // ONLY when the user clicks the SCAN (⟳) button. See scan-btn handler below.
    setTimeout(() => {
        encConfigApplyToUI('signin');
        encConfigApplyToUI('reserve');
        encConfigApplyToUI('initiate');
    }, 500);
}

// Collect ALL candidate /assets/*.js chunk URLs (Vite code-splits the cipher config into
// its own chunk, so the FIRST script tag is usually NOT the one holding `secret:`). We gather
// every chunk from the DOM + index.html, then encConfigAutoFetch fetches them until one yields
// a resolvable config. Order: DOM scripts first, then any extra chunks from index.html.
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
    return urls;
}

// Back-compat single-URL helper (first candidate).
async function findBundleUrl() { const u = await findBundleUrls(); return u.length ? u[0] : null; }

// ── ROBUST N-ARRAY SECRET RESOLVER (ported from extract_ciphers.js) ──────────
// The old resolveConfig re-ran the obfuscated decoders + rotation IIFEs via a single
// text-assembled new Function(). That FAILED today whenever a secret was assembled from
// 2+ string-arrays (the assembly missed a rotation / mixed scopes). This version instead
// RECONSTRUCTS each string-array + its base64/RC4 decoder from scratch, then finds each
// array's correct rotation INDEPENDENTLY by requiring its decoded terms to be printable —
// so it scales to ANY number of arrays (cost = sum of array lengths, not the product).
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
    function resolveExpr(expr,pos){
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
                for(let r=0;r<baseArr[a].length;r++){
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
                for(const combo of combos){const arrs={};keys.forEach((a,i)=>arrs[a]=rot(baseArr[a],combo[i]));try{const v=fnFull(arrs,rc4,b64);if(ok(v))return v;}catch(e){}}
            }
        }catch(e){}
        // METHOD B: full brute-force fallback (1-2 arrays)
        if(arr.length===1){for(let r=0;r<baseArr[arr[0]].length;r++){try{const v=fnFull({[arr[0]]:rot(baseArr[arr[0]],r)},rc4,b64);if(ok(v))return v;}catch(e){}}return null;}
        if(arr.length===2){
            // FAST 2-array path: each term reads ONE array, so precompute every term's value
            // per rotation of its array (O(A+B) evals) and combine with cheap string concat,
            // instead of O(A*B) full-expression evals. Byte-identical result, ~20x faster.
            const a0=arr[0],a1=arr[1],A=baseArr[a0],B=baseArr[a1];
            const terms2=splitTopPlus(expr);
            const termArr2=terms2.map(t=>{const m=/^([A-Za-z_$][\w$]*)\(/.exec(t);return m?ultimateArrfn(m[1],pos):null;});
            let fnTermsB=null;try{fnTermsB=new Function("__arrs","__rc4","__b64",decl+"return ["+terms2.join(",")+"]");}catch(e){}
            if(fnTermsB){
                const idx0=[],idx1=[];termArr2.forEach((a,i)=>{if(a===a0)idx0.push(i);else if(a===a1)idx1.push(i);});
                const isPrint=v=>typeof v==="string"&&/^[\x20-\x7e]*$/.test(v);
                let baseVals=null;try{baseVals=fnTermsB({[a0]:A,[a1]:B},rc4,b64);}catch(e){}
                if(baseVals){
                    const rec0=[],good0=[];for(let r0=0;r0<A.length;r0++){let vals;try{vals=fnTermsB({[a0]:rot(A,r0),[a1]:B},rc4,b64);}catch(e){rec0.push(null);continue;}const m={};let okp=true;for(const i of idx0){m[i]=vals[i];if(!isPrint(vals[i]))okp=false;}rec0.push(m);if(okp)good0.push(r0);}
                    const rec1=[],good1=[];for(let r1=0;r1<B.length;r1++){let vals;try{vals=fnTermsB({[a0]:A,[a1]:rot(B,r1)},rc4,b64);}catch(e){rec1.push(null);continue;}const m={};let okp=true;for(const i of idx1){m[i]=vals[i];if(!isPrint(vals[i]))okp=false;}rec1.push(m);if(okp)good1.push(r1);}
                    const L0=good0.length?good0:[...Array(A.length).keys()];
                    const L1=good1.length?good1:[...Array(B.length).keys()];
                    for(const r0 of L0){const m0=rec0[r0];if(!m0)continue;for(const r1 of L1){const m1=rec1[r1];if(!m1)continue;let sec="";for(let i=0;i<terms2.length;i++)sec+=(i in m0?m0[i]:(i in m1?m1[i]:baseVals[i]));if(ok(sec))return sec;}}
                    return null;
                }
            }
            const A2=baseArr[arr[0]],B2=baseArr[arr[1]];for(let r0=0;r0<A2.length;r0++){const A0=rot(A2,r0);for(let r1=0;r1<B2.length;r1++){try{const v=fnFull({[arr[0]]:A0,[arr[1]]:rot(B2,r1)},rc4,b64);if(ok(v))return v;}catch(e){}}}return null;
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

// --- config-object parsing helpers (handle new bundle format) ---
// split on top-level commas (respect quotes and ()[]{} nesting)
function _splitTopComma(s){const parts=[];let depth=0,q=null,cur="";for(let i=0;i<s.length;i++){const c=s[i];if(q){cur+=c;if(c==="\\"){cur+=s[++i]||"";continue;}if(c===q)q=null;continue;}if(c==='"'||c==="'"||c==="`"){q=c;cur+=c;continue;}if(c==="("||c==="["||c==="{"){depth++;cur+=c;continue;}if(c===")"||c==="]"||c==="}"){depth--;cur+=c;continue;}if(c===","&&depth===0){parts.push(cur);cur="";continue;}cur+=c;}if(cur.trim())parts.push(cur);return parts;}
// config integer: prefer a QUOTED number (Number("1"), c[f(1486)](_,"27")), else a bare int (old startAt:4)
function _cfgNum(expr){let m=/["'`](-?\d+)["'`]/.exec(expr);if(m)return parseInt(m[1],10);m=/(-?\d+)/.exec(expr);return m?parseInt(m[1],10):NaN;}
// brace-match an object literal starting at `{` (respect quotes)
function _braceObj(str,b){let depth=0,q=null;for(let j=b;j<str.length;j++){const c=str[j];if(q){if(c==="\\"){j++;continue;}if(c===q)q=null;continue;}if(c==='"'||c==="'"||c==="`"){q=c;continue;}if(c==="{")depth++;else if(c==="}"){if(--depth===0)return j;}}return -1;}

// Resolve config(s) directly from the bundle object literals (handles both old {secret:...,startAt:4,...}
// and new {secret:...,startAt:Number("1"),length:c[f()](_,"27"),version:...} formats).
// Returns { signin, reserve } where each is { key, skip, length, version } or null.
function resolveBundleConfigs(text) {
    const R = buildBundleResolver(text);
    // substitute local string-constant vars (e.g. const e="f*^(") into an expression so decoder
    // calls that use them as an RC4 key — n(e,-177) — can be evaluated during member decode.
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
        // Member-access secret (secret: n[o(191)] or n.prop): the key lives inside an object
        // property. Decode each concatenation-valued property; the captcha KEY is the spaceless
        // one (sibling message strings contain spaces). Handles bundles with no direct expression.
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
        const secret = R.resolveExpr(secretExpr, objStart);
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
        // Try each chunk until one contains a decodable {secret,startAt,length,version} config.
        // (Vite splits the cipher into its own chunk — the first script tag is usually not it.)
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

        if (signin) {
            encConfig.signin = { active: true, key: signin.key, skip: signin.skip, length: signin.length, version: signin.version };
            encConfigSave('signin');
            logStatus('✅ Signin: v' + signin.version + ' skip=' + signin.skip + ' len=' + signin.length + ' key[' + signin.key.length + ']', 'g');
        } else {
            logStatus('⚠ Signin not resolved — keeping current config', 'y');
        }
        if (reserve) {
            encConfig.reserve = { active: true, key: reserve.key, skip: reserve.skip, length: reserve.length, version: reserve.version };
            encConfigSave('reserve');
            logStatus('✅ Reserve: v' + reserve.version + ' skip=' + reserve.skip + ' len=' + reserve.length + ' key[' + reserve.key.length + ']', 'g');
        } else {
            logStatus('⚠ Reserve not resolved — keeping current config', 'y');
        }

        // Initiate: use its OWN resolved config if the bundle has a distinct one; otherwise mirror
        // signin/reserve (bundles that use one cipher for everything). Usage still gated by the checkbox.
        const initiate = resolved.initiate;
        const initOwn  = !!initiate;
        const initCfg  = initiate || signin || reserve;
        if (initCfg) {
            encConfig.initiate = { active: true, key: initCfg.key, skip: initCfg.skip, length: initCfg.length, version: initCfg.version };
            encConfigSave('initiate');
            logStatus('✅ Initiate' + (initOwn ? '' : ' (mirrored)') + ': v' + initCfg.version + ' skip=' + initCfg.skip + ' len=' + initCfg.length + ' key[' + initCfg.key.length + ']', 'g');
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

// ==================== SESSION STATE & PERSISTENCE ====================
const SESSION_GM_KEY = 'rj_master_session';

const sessionState = {
    accessToken: null,
    userId: null,
    requestId: null,
    expiresAt: null,
    phone: null,
    loggedInAt: null,
    isVerified: false,
    appointmentId: null,
    abcDate: null,
    abcSlot: null,
    ivacCenter: null,
    mission: null,
    numberOfApplicants: null,
    totalAmount: null,
    fileUploadStatus: null,
    visaCodes: null,
    reservationId: null,
    reserveTtlSec: null,
    reserveStatus: null,
    reservedAt: null,
    bookedAt: null,
    otpVerifiedAt: null,
    otpExpiresAt: null
};

function gmGet(key, defaultValue) {
    try {
        if (typeof GM_getValue !== 'undefined') return GM_getValue(key, defaultValue);
    } catch(e) {}
    try {
        const raw = localStorage.getItem('gm_' + key);
        return raw ? JSON.parse(raw) : defaultValue;
    } catch(e) { return defaultValue; }
}
function gmSet(key, value) {
    try {
        if (typeof GM_setValue !== 'undefined') { GM_setValue(key, value); return; }
    } catch(e) {}
    try { localStorage.setItem('gm_' + key, JSON.stringify(value)); } catch(e) {}
}
function gmDelete(key) {
    try {
        if (typeof GM_deleteValue !== 'undefined') { GM_deleteValue(key); return; }
    } catch(e) {}
    try { localStorage.removeItem('gm_' + key); } catch(e) {}
}

function buildAuthStorage(state) {
    return {
        state: {
            token: state.accessToken || null,
            userId: state.userId || null,
            expiresAt: 899,
            isAuthenticated: !!state.accessToken,
            isVerified: !!state.isVerified,
            requestId: state.requestId || null,
            phone: state.phone || null,
            otpSentAt: state.loggedInAt || Date.now()
        }
    };
}

function persistSession() {
    try { localStorage.setItem('rj_session', JSON.stringify(sessionState)); } catch(e) {}
    try {
        const sf = buildAuthStorage(sessionState);
        localStorage.setItem('auth-storage', JSON.stringify(sf));
        localStorage.setItem('rj-auth-storage-backup', JSON.stringify(sf));
    } catch(e) {}
    try { gmSet(SESSION_GM_KEY, { ...sessionState }); } catch(e) {}
}

function saveSession(data, phone) {
    sessionState.isVerified         = false;
    sessionState.otpVerifiedAt      = null;
    sessionState.otpExpiresAt       = null;
    try { if (typeof smsFetcher !== 'undefined') { smsFetcher.usedOtps.clear(); } } catch(e) {}
    try { if (typeof stopSmsFetcher === 'function') { stopSmsFetcher('new signin'); } } catch(e) {}
    sessionState.appointmentId              = null;
    sessionState.abcDate            = null;
    sessionState.abcSlot            = null;
    sessionState.ivacCenter         = null;
    sessionState.mission            = null;
    sessionState.numberOfApplicants = null;
    sessionState.totalAmount        = null;
    sessionState.fileUploadStatus   = null;
    sessionState.visaCodes          = null;
    sessionState.reservationId      = null;
    sessionState.reserveTtlSec      = null;
    sessionState.reserveStatus      = null;
    sessionState.reservedAt         = null;
    sessionState.bookedAt           = null;

    sessionState.accessToken = data.accessToken;
    sessionState.userId      = data.userId;
    sessionState.requestId   = data.requestId;
    sessionState.expiresAt   = data.expiresAt;
    sessionState.phone       = phone;
    sessionState.loggedInAt  = Date.now();
    persistSession();
    console.log('[RJ Session] Fresh Signin — all downstream state wiped, new token saved');
}

function markSessionVerified() {
    const wasAlreadyVerified = sessionState.isVerified;
    sessionState.isVerified = true;
    sessionState.otpVerifiedAt = Date.now();
    persistSession();
    if (!wasAlreadyVerified) {
        try { announceSuccess('Verification successful'); } catch(e) {}   // voice, no beep
    }
}

function restoreSession() {
    let restored = false;
    try {
        const gm = gmGet(SESSION_GM_KEY, null);
        if (gm && gm.accessToken && gm.loggedInAt) {
            const age = Date.now() - gm.loggedInAt;
            if (age < 15 * 60 * 1000) {
                Object.assign(sessionState, gm);
                restored = true;
                console.log('[RJ Session] Restored from GM storage (age', Math.round(age/1000), 's)');
            } else {
                console.log('[RJ Session] GM session too old, discarding');
                gmDelete(SESSION_GM_KEY);
            }
        }
    } catch(e) {}

    if (!restored) {
        try {
            const raw = localStorage.getItem('rj_session');
            if (raw) {
                const s = JSON.parse(raw);
                if (s.accessToken && s.loggedInAt) {
                    const age = Date.now() - s.loggedInAt;
                    if (age < 15 * 60 * 1000) {
                        Object.assign(sessionState, s);
                        restored = true;
                        console.log('[RJ Session] Restored from rj_session localStorage');
                    }
                }
            }
        } catch(e) {}
    }

    if (!restored) {
        try {
            const raw = localStorage.getItem('auth-storage');
            if (raw) {
                const parsed = JSON.parse(raw);
                const s = parsed.state || parsed;
                if (s.token) {
                    sessionState.accessToken = s.token;
                    sessionState.userId      = s.userId || null;
                    sessionState.requestId   = s.requestId || null;
                    sessionState.phone       = s.phone || null;
                    sessionState.isVerified  = !!s.isVerified;
                    sessionState.loggedInAt  = s.otpSentAt || Date.now();
                    restored = true;
                    console.log('[RJ Session] Restored from auth-storage');
                }
            }
        } catch(e) {}
    }

    if (restored) {
        persistSession();
        try {
            const elapsedSinceLogin = Date.now() - sessionState.loggedInAt;
            const remainingMs = (15 * 60 * 1000) - elapsedSinceLogin;
            if (remainingMs > 0 && sessionState.isVerified) {
                setTimeout(() => {
                    try {
                        if (typeof startTokenTimerWithExpiry === 'function') {
                            startTokenTimerWithExpiry(sessionState.loggedInAt + 15 * 60 * 1000);
                        }
                    } catch(e) {}
                }, 500);
            } else if (remainingMs > 0 && !sessionState.isVerified) {
                const otpElapsed = Date.now() - sessionState.loggedInAt;
                const otpRemain = (5 * 60 * 1000) - otpElapsed;
                if (otpRemain > 0) {
                    setTimeout(() => {
                        try {
                            if (typeof startOtpTimer === 'function') {
                                if (timers?.signinOtp) {
                                    if (timers.signinOtp.intervalId) clearInterval(timers.signinOtp.intervalId);
                                    timers.signinOtp.expiresAt = sessionState.loggedInAt + (5 * 60 * 1000);
                                    timers.signinOtp.beeped = false;
                                    timers.signinOtp.intervalId = setInterval(() => tickOtpTimer('signinOtp'), 1000);
                                    tickOtpTimer('signinOtp');
                                }
                            }
                        } catch(e) {}
                    }, 500);
                }
            }
        } catch(e) {}
    }
    return restored;
}

function clearAllSession() {
    _autoReserveKicked = false;   // notun cycle e abar auto-reserve fire korte parbe
    sessionState.accessToken        = null;
    sessionState.userId             = null;
    sessionState.requestId          = null;
    sessionState.expiresAt          = null;
    sessionState.phone              = null;
    sessionState.loggedInAt         = null;
    sessionState.isVerified         = false;
    sessionState.appointmentId              = null;
    sessionState.abcDate            = null;
    sessionState.abcSlot            = null;
    sessionState.ivacCenter         = null;
    sessionState.mission            = null;
    sessionState.numberOfApplicants = null;
    sessionState.totalAmount        = null;
    sessionState.fileUploadStatus   = null;
    sessionState.visaCodes          = null;
    sessionState.reservationId      = null;
    sessionState.reserveTtlSec      = null;
    sessionState.reserveStatus      = null;
    sessionState.reservedAt         = null;
    sessionState.bookedAt           = null;
    sessionState.otpVerifiedAt      = null;
    sessionState.otpExpiresAt       = null;
    try { if (typeof smsFetcher !== 'undefined') { smsFetcher.usedOtps.clear(); stopSmsFetcher('session clear'); } } catch(e) {}
    try { localStorage.removeItem('rj_session'); } catch(e) {}
    try { localStorage.removeItem('auth-storage'); } catch(e) {}
    try { localStorage.removeItem('rj-auth-storage-backup'); } catch(e) {}
    try { gmDelete(SESSION_GM_KEY); } catch(e) {}
}

setInterval(() => {
    if (!sessionState.accessToken) return;
    if (!sessionState.loggedInAt) return;
    const age = Date.now() - sessionState.loggedInAt;

    if (age >= 15 * 60 * 1000) {
        console.log(`[RJ Session] Expired (age ${Math.round(age/1000)}s) — auto-clearing`);
        try {
            clearAllSession();
            stopOtpTimer('signinOtp');
            stopOtpTimer('advanceOtp');
            if (timers?.token?.intervalId) {
                clearInterval(timers.token.intervalId);
                timers.token.intervalId = null;
                timers.token.expiresAt = null;
                refreshTokenCdUI();
            }
            logStatus('🔒 Session expired (15 min) — login again', 'r');
        } catch(e) {}
        return;
    }

    try {
        const current = localStorage.getItem('auth-storage');
        let needsRestore = false;
        if (!current) {
            needsRestore = true;
        } else {
            try {
                const parsed = JSON.parse(current);
                if (!parsed?.state?.token) needsRestore = true;
            } catch(e) { needsRestore = true; }
        }
        if (needsRestore) {
            const sf = buildAuthStorage(sessionState);
            localStorage.setItem('auth-storage', JSON.stringify(sf));
            console.log('[RJ Session] auth-storage was cleared — restored from in-memory state');
        }
    } catch(e) {}
}, 1000);

// ==================== SIGNUP STATE ====================
const signupState = {
    mobileVerified: false,
    emailVerified: false,
    mobileRequestId: null,
    emailRequestId: null,
    stopRequested: false
};

function resetSignupState() {
    signupState.mobileVerified = false;
    signupState.emailVerified = false;
    signupState.mobileRequestId = null;
    signupState.emailRequestId = null;
    signupState.stopRequested = false;
}

// ==================== STATUS LOGGER ====================
function logStatus(msg, color = 'g') {
    const t = new Date().toLocaleTimeString('en-US', { hour12: true });
    const html = `<span class="${color}">[${t}] ${msg}</span>`;
    ['ll', 'ls', 'lu', 'lf'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    });
    console.log(`[RJ ${t}] ${msg}`);
}

function showMilestonePopup(title, message, emoji) {
    if (!document.getElementById('popup-toggle')?.classList.contains('on')) return;
    const existing = document.getElementById('rj-milestone-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'rj-milestone-overlay';
    const card = document.createElement('div');
    card.className = 'mp-card';
    card.innerHTML = `
        <div class="mp-emoji">${emoji}</div>
        <div class="mp-title">${title}</div>
        <div class="mp-msg">${message}</div>
        <div style="padding:0 20px 18px 20px"><button class="mp-ok" id="rj-popup-ok">OK</button></div>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.getElementById('rj-popup-ok').onclick = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ==================== CLOUDFLARE TURNSTILE CAPTCHA ====================
const CF_SITEKEY = '0x4AAAAAACghKkJHL1t7UkuZ';
let cfWidgetId = null;
let cfToken    = null;
let cfTokenAt  = 0;     // when the current cfToken was solved (to drop a stale one after TTL)
let cfMode     = 'signin';

if (!document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')) {
    const cfScript = document.createElement('script');
    cfScript.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    cfScript.async = true;
    cfScript.defer = true;
    document.head.appendChild(cfScript);
}

let _renderInFlight = false;
let _lastRenderAt   = 0;
const RENDER_COOLDOWN = 10 * 1000;

function renderCaptcha() {
    if (typeof turnstile === 'undefined') return;
    const container = document.getElementById('cfTurnstile');
    if (!container) return;

    if (_renderInFlight) {
        console.log('[RJ Captcha] render already in flight, skipping');
        return;
    }
    if (Date.now() - _lastRenderAt < RENDER_COOLDOWN) {
        console.log('[RJ Captcha] render cooldown active, skipping');
        return;
    }
    _renderInFlight = true;
    _lastRenderAt = Date.now();

    if (cfWidgetId !== null) {
        try { turnstile.remove(cfWidgetId); } catch(e) {}
        cfWidgetId = null;
        cfToken = null;
        container.innerHTML = '';
    }

    try {
        cfWidgetId = turnstile.render(container, {
            sitekey: CF_SITEKEY,
            size: 'normal',
            theme: 'dark',
            appearance: 'always',
            callback: (token) => {
                cfToken = token; cfTokenAt = Date.now();
                tokenQueueAddTagged(token, 'turnstile');
                logStatus(`✓ Captcha solved → queue ${tokenQueue.length}/${TOKEN_QUEUE_MAX}`, 'g');

                const isApiMode = document.getElementById('captcha-toggle')?.classList.contains('on');
                if (isApiMode) return;

                setTimeout(() => {
                    tokenQueueCleanExpired();
                    const turnstileCount = tokenQueue.filter(t => t.source === 'turnstile').length;
                    if (turnstileCount >= TOKEN_QUEUE_MAX) {
                        console.log(`[RJ Turnstile] Queue full (${turnstileCount}/${TOKEN_QUEUE_MAX}) — pausing auto-solve`);
                        return;
                    }
                    try {
                        turnstile.reset(cfWidgetId);
                        cfToken = null;
                        console.log(`[RJ Turnstile] Auto-reset for next solve (queue ${turnstileCount}/${TOKEN_QUEUE_MAX})`);
                    } catch(e) {
                        console.log('[RJ Turnstile] reset failed:', e.message);
                    }
                }, 2000);
            },
            'error-callback': () => {
                logStatus('✗ Captcha error', 'r');
            },
            'expired-callback': () => {
                cfToken = null;
                logStatus('⚠ Captcha expired', 'y');
                const isApiMode = document.getElementById('captcha-toggle')?.classList.contains('on');
                if (!isApiMode && cfWidgetId !== null) {
                    try { turnstile.reset(cfWidgetId); } catch(e) {}
                }
            },
            'timeout-callback': () => {
                logStatus('⚠ Captcha timeout', 'y');
            }
        });
    } finally {
        setTimeout(() => { _renderInFlight = false; }, 2000);
    }
}

function resetCaptcha() {
    if (typeof turnstile !== 'undefined' && cfWidgetId !== null) {
        try { turnstile.reset(cfWidgetId); } catch(e) {}
        cfToken = null;
    }
}

function showManualCaptcha() {
    const useApi = document.getElementById('captcha-toggle')?.classList.contains('on');
    if (useApi) return;
    // Widget already rendered (pre-warm or earlier click)? DON'T re-render — re-rendering removes
    // and re-creates the iframe, which is the "spark"/flicker. Leave it; it's already solving and
    // feeding the queue. Only render when there is no widget yet.
    if (cfWidgetId !== null) return;
    _lastRenderAt = 0;
    const tryRender = (attempts) => {
        if (document.getElementById('captcha-toggle')?.classList.contains('on')) return;
        if (cfWidgetId !== null) return;                              // became available meanwhile — stop
        if (typeof turnstile !== 'undefined') { renderCaptcha(); }
        else if (attempts > 0) { setTimeout(() => tryRender(attempts - 1), 60); }   // first render: catch turnstile-ready fast
    };
    tryRender(500);
}
function hideManualCaptcha() {
    try {
        if (typeof turnstile !== 'undefined' && cfWidgetId !== null) {
            turnstile.remove(cfWidgetId);
            cfWidgetId = null; cfToken = null;
            const c = document.getElementById('cfTurnstile'); if (c) c.innerHTML = '';
        }
    } catch(e) {}
}
const cfCheck = setInterval(() => {
    if (typeof turnstile === 'undefined') return;
    if (!document.getElementById('cfTurnstile')) return;   // wait for the panel/container
    clearInterval(cfCheck);
    // Pre-warm ONLY in manual (non-API) mode: render the widget as soon as Turnstile + container
    // are ready so a solved token is already queued before Sign In is clicked — no render latency
    // at click time. API mode never pre-warms.
    try {
        const useApi = document.getElementById('captcha-toggle')?.classList.contains('on');
        if (!useApi && cfWidgetId === null) { _lastRenderAt = 0; renderCaptcha(); }
    } catch(e) {}
}, 300);

// ==================== SIGN-IN API CALL (H2) ====================
async function performSignin(phone, password, captchaToken) {
    const encryptedCaptcha = encTokenForCall(captchaToken, 'signin');
    const body = JSON.stringify({ phone, password, c: encryptedCaptcha });
    const response = await H2.fetchH2(API_SIGNIN_V2, {
        method: "POST",
        headers: {
            "accept": "application/json, text/plain, */*",
            "cache-control": "no-cache, no-store, must-revalidate",
            "content-type": "application/json",
            "pragma": "no-cache",
            "x-sec-navigation-state": _navState()
        },
        referrer: API_REFERRER,
        body: body
    });

    const result = await response.json();
    return { ok: response.ok, status: response.status, body: result };
}

// Active initiate is stepInitiate (STEP_FACTORY). The old performInitiate() helper was unused
// dead code (it carried no x-token) and has been removed.
function extractPaymentUrl(body) {
    if (!body) return null;
    const d = body.data || body;
    return d.webview_url || d.GatewayPageURL || d.gatewayPageURL || d.paymentUrl ||
           d.payment_url || d.gatewayUrl || d.redirectUrl ||
           d.redirect_url || d.url || d.epayUrl || d.securePayUrl || null;
}

function isVerifiedResponse(status, body) {
    if (!body) return false;
    if (body.successFlag === true) return true;
    if (body.message === 'Success') return true;
    if (body.data?.verified === true) return true;
    return false;
}

function isReservedResponse(body, status) {
    if (!body) return false;
    const msg = (body.message || '').trim();
    const st  = (body.status  || '').trim();
    if (msg === 'Reserved booking') return true;
    if (st  === 'OK_NEW')           return true;
    if (st  === 'OK_EXISTING')      return true;
    // Broader success detection (the exact 200 body shape can differ): any 2xx that carries a
    // success flag or a reservation id counts as reserved — so a successful reserve STOPS the
    // retry loop instead of re-firing and getting 400 (slot already reserved).
    const okHttp = typeof status === 'number' ? (status >= 200 && status < 300) : true;
    if (okHttp) {
        if (body.successFlag === true) return true;
        if (body.statusCode === 200 || body.statusCode === 201) return true;
        if (/^(reserv|success|ok)/i.test(msg)) return true;
        if (body.reservationId || body.data?.reservationId) return true;
        const d = body.data || {};
        if (d.status === 'OK_NEW' || d.status === 'OK_EXISTING' || (d.message || '').trim() === 'Reserved booking') return true;
    }
    return false;
}

// ==================== CSS STYLES (PRO LOOK) ====================
const s = document.createElement('style');
s.textContent = `


/* ===== MAIN PANEL ===== */ #p{position:fixed;top:50%;right:20px;transform:translateY(-50%);width:285px;height:auto;background:linear-gradient(160deg,#0d0d1e 0%,#10102a 60%,#0a0a18 100%);border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.85),0 0 0 1px rgba(124,58,237,.25),0 0 25px rgba(124,58,237,.12);z-index:999999;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:#e0e0f0;overflow:hidden;display:flex;flex-direction:column;backdrop-filter:blur(8px)} #p.hidden{display:none !important} #p *{box-sizing:border-box;margin:0;padding:0} #p .dh{background:linear-gradient(90deg,#0a0a18,#15152e,#0a0a18);padding:12px 14px;cursor:move;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(124,58,237,.25);user-select:none;flex-shrink:0;position:relative} #p .dh::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,#7c3aed,#4f46e5);border-radius:0 2px 2px 0} #p .dt{font-size:.72rem;font-weight:800;background:linear-gradient(90deg,#c4b5fd,#a78bfa,#818cf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:1px} #p .db{background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.35);color:#a78bfa;font-size:.95rem;cursor:pointer;line-height:1;padding:0 7px;border-radius:4px;transition:all .2s} #p .db:hover{background:rgba(124,58,237,.25);color:#fff;transform:scale(1.05)} #p #scan-btn{background:linear-gradient(135deg,#06b6d4,#22c55e);border:1px solid rgba(34,197,94,.6);color:#fff;font-weight:800;text-shadow:0 0 6px rgba(0,0,0,.4);box-shadow:0 0 10px rgba(34,197,94,.45);height:26px;padding:0 9px;display:inline-flex;align-items:center;justify-content:center} #p #scan-btn:hover{background:linear-gradient(135deg,#22d3ee,#4ade80);box-shadow:0 0 14px rgba(34,197,94,.7);transform:scale(1.12) rotate(90deg)} #p #auto-enc-btn{background:linear-gradient(135deg,#6366f1,#8b5cf6);border:1px solid rgba(139,92,246,.6);color:#fff;font-weight:800;text-shadow:0 0 6px rgba(0,0,0,.4);box-shadow:0 0 10px rgba(139,92,246,.45);height:26px;padding:0 9px;display:inline-flex;align-items:center;justify-content:center} #p #auto-enc-btn:hover{background:linear-gradient(135deg,#818cf8,#a78bfa);box-shadow:0 0 14px rgba(139,92,246,.7);transform:scale(1.08)} #p #auto-enc-btn.scanning{background:linear-gradient(135deg,#10b981,#059669);border-color:rgba(16,185,129,.7);box-shadow:0 0 12px rgba(16,185,129,.7);animation:aePulse 1s ease-in-out infinite} @keyframes aePulse{0%,100%{box-shadow:0 0 8px rgba(16,185,129,.5)}50%{box-shadow:0 0 16px rgba(16,185,129,.9)}} #p #enc-clear-btn{background:linear-gradient(135deg,#f97316,#ef4444);border:1px solid rgba(239,68,68,.6);color:#fff;font-weight:800;text-shadow:0 0 6px rgba(0,0,0,.4);box-shadow:0 0 10px rgba(239,68,68,.45);height:26px;padding:0 9px;display:inline-flex;align-items:center;justify-content:center} #p #enc-clear-btn:hover{background:linear-gradient(135deg,#fb923c,#f87171);box-shadow:0 0 14px rgba(239,68,68,.75);transform:scale(1.08)} #p .tb{display:flex;background:#06061a;padding:0;border-bottom:1px solid rgba(124,58,237,.2);flex-shrink:0} #p .t{background:none;border:none;padding:11px 0;color:#5a5a80;font-weight:700;font-size:.68rem;cursor:pointer;border-bottom:2px solid transparent;flex:1;text-align:center;transition:all .2s;position:relative} #p .t:hover{color:#a78bfa;background:rgba(124,58,237,.08)} #p .t.a{color:#fff;background:linear-gradient(180deg,rgba(124,58,237,.15),transparent);border-bottom-color:#7c3aed;text-shadow:0 0 8px rgba(124,58,237,.6)} #p .bd{overflow:visible;flex:1} #p .sl{background:linear-gradient(135deg,#06061a,#0a0a1f);margin:5px 8px;border-radius:6px;border:1px solid rgba(124,58,237,.2);overflow:hidden;flex-shrink:0;height:auto;min-height:34px;max-height:34px;box-shadow:inset 0 1px 3px rgba(0,0,0,.5)} #p .sl>div{display:none;padding:4px 7px;font-family:Consolas,monospace;font-size:.82rem;font-weight:700;color:#5a5a88;line-height:1.4;height:auto;overflow:hidden;white-space:nowrap;text-overflow:ellipsis} #p .sl>div.a{display:block} #p .sl .g{color:#4ade80;text-shadow:0 0 6px rgba(74,222,128,.4)} #p .sl .r{color:#fca5a5;text-shadow:0 0 6px rgba(252,165,165,.4)} #p .sl .y{color:#fcd34d;text-shadow:0 0 6px rgba(252,211,77,.4)} #p .sc{padding:5px 9px 3px} #p .fr{display:flex;gap:3px;margin-bottom:1px;align-items:center} #p .sa-row{gap:3px} #p .sa-row input[type=number]{flex:1;width:0;min-width:0;padding:3px 0;text-align:center;font-size:.62rem;font-weight:700} #p .sa-btn{flex:0 0 38px;padding:3px 0!important;font-size:.6rem!important;font-weight:800;letter-spacing:.2px;border-radius:4px!important} #p .fr-otp{display:flex;gap:4px;margin-bottom:3px;align-items:center} #p .fr-otp input[type=text]{flex:50;min-width:0} #p .fr-otp button.b4{flex:18;min-width:0} #p .fr-otp button.b5{flex:32;min-width:0} #p .fr-phone{display:flex;gap:4px;margin-bottom:3px;align-items:center} #p .phone-type-sel{flex:none;width:58px;background:linear-gradient(180deg,#13132e,#0a0a18);border:1px solid #3b3777;color:#c4b5fd;padding:4px 2px;border-radius:4px;font-size:.6rem;font-weight:700;outline:none;cursor:pointer;text-align:center;appearance:none;box-shadow:0 1px 3px rgba(0,0,0,.4)} #p .phone-type-sel:focus{border-color:#7c3aed;box-shadow:0 0 0 2px rgba(124,58,237,.2)} #p .phone-type-sel option{background:#0e0e1c;color:#c4b5fd;font-size:.6rem} #p .fr-phone input[type=text],#p .fr-phone input[type=tel],#p .fr-phone input[type=email]{flex:1;background:linear-gradient(180deg,#0a0a1a,#08081a);border:1px solid #2a2a4a;padding:5px 7px;border-radius:4px;color:#e0e0f0;font-size:.68rem;font-weight:600;outline:none;min-width:0;transition:all .2s} #p .fr-phone input::placeholder{color:#4a4a6a;font-size:.6rem;font-weight:500} #p .fr-phone input:focus{border-color:#7c3aed;box-shadow:0 0 0 2px rgba(124,58,237,.15)} #p .fr-phone .sw-c{flex:0 0 24px;display:flex;align-items:center;justify-content:center} #p .fr-pw{display:flex;gap:4px;margin-bottom:3px;align-items:center} #p .fr-pw .pw{flex:0 0 55%;display:flex;position:relative;min-width:0} #p .fr-pw .pw input{width:100%;background:linear-gradient(180deg,#0a0a1a,#08081a);border:1px solid #2a2a4a;padding:5px 7px;border-radius:5px;color:#e0e0f0;font-size:.68rem;font-weight:600;outline:none;padding-right:22px;transition:all .2s} #p .fr-pw .pw input::placeholder{color:#4a4a6a;font-size:.6rem;font-weight:500} #p .fr-pw .pw input:focus{border-color:#7c3aed;box-shadow:0 0 0 2px rgba(124,58,237,.15)} #p .fr-pw .pw .eye{position:absolute;right:2px;top:50%;transform:translateY(-50%);background:none;border:none;color:#666690;cursor:pointer;padding:0 4px;font-size:.7rem;line-height:1;z-index:2;transition:color .2s} #p .fr-pw .pw .eye:hover{color:#a78bfa} #p .fr-pw .b7.bh{flex:1;padding:5px 0;font-size:.66rem;font-weight:700;min-width:0} #p .tr{display:flex;gap:5px;margin-bottom:3px;align-items:center} #p .tm{flex:1;border-radius:5px;padding:1px 3px;text-align:center;position:relative;overflow:hidden;height:26px;display:flex;flex-direction:column;justify-content:center;background:linear-gradient(135deg,#0a0a1a,#0d0d24);border:1px solid #1f1f3a;box-shadow:inset 0 1px 2px rgba(0,0,0,.5)} #p .tm.t1{border-color:rgba(74,222,128,.3)} #p .tm.t2{border-color:rgba(167,139,250,.3)} #p .tm input.ti{width:100%;background:transparent;border:1px solid transparent;border-radius:4px;padding:1px 2px;font-family:Consolas,'Courier New',monospace;font-size:.7rem;font-weight:800;letter-spacing:.3px;text-align:center;outline:none} #p .tm.t1 input.ti{color:#4ade80;text-shadow:0 0 10px rgba(74,222,128,.5)} #p .tm.t2 input.ti{color:#c4b5fd;text-shadow:0 0 10px rgba(167,139,250,.5)} #p .tm input.ti:hover{border-color:rgba(255,255,255,.12);background:rgba(255,255,255,.02)} #p .tm input.ti:focus{border-color:rgba(255,255,255,.25);background:rgba(0,0,0,.3)} #p .tr .reserve-tg-wrap{flex:0 0 22px;display:flex;align-items:center;justify-content:center;height:26px} #p input[type=text],#p input[type=tel],#p input[type=email],#p input[type=password],#p input[type=number],#p select{background:linear-gradient(180deg,#0a0a1a,#08081a);border:1px solid #2a2a4a;padding:5px 7px;border-radius:4px;color:#e0e0f0;font-size:.68rem;font-weight:600;flex:1;outline:none;font-family:inherit;min-width:0;transition:all .2s} #p input:focus,#p select:focus{border-color:#7c3aed;box-shadow:0 0 0 2px rgba(124,58,237,.15)} #p input::placeholder{color:#4a4a6a;font-size:.6rem;font-weight:500} #p select option{background:#0e0e1c;color:#c4b5fd} #p input[type=number]{text-align:center;padding:4px 2px} #p input[type=file]{font-size:.56rem;padding:3px;background:#0a0a1a;border:1px solid #1c1c36;border-radius:4px;color:#b0b0cc} #p textarea{background:linear-gradient(180deg,#0a0a1a,#08081a);border:1px solid #1c1c36;border-radius:4px;color:#d0d0e6;font-size:.64rem;font-weight:600;padding:5px 7px;width:100%;resize:none;font-family:Consolas,monospace;outline:none;transition:all .2s} #p textarea:focus{border-color:#7c3aed;box-shadow:0 0 0 2px rgba(124,58,237,.15)} #p textarea::placeholder{color:#2a2a50} #p label{font-size:.62rem;color:#7777aa;font-weight:700;white-space:nowrap} #p button{border:none;padding:6px 9px;border-radius:5px;color:#fff;font-weight:700;font-size:.64rem;transition:all .2s;white-space:nowrap;font-family:inherit;cursor:pointer;letter-spacing:.3px;position:relative;overflow:hidden} #p button:hover{transform:translateY(-1px);filter:brightness(1.15)} #p button:active{transform:scale(.96)} #p .b1{background:linear-gradient(135deg,#3b82f6,#1d4ed8);border:1px solid #60a5fa;color:#fff;box-shadow:0 2px 6px rgba(59,130,246,.35),inset 0 1px 0 rgba(255,255,255,.15)} #p .b2{background:linear-gradient(135deg,#f59e0b,#d97706);border:1px solid #fbbf24;color:#fff;box-shadow:0 2px 6px rgba(245,158,11,.35),inset 0 1px 0 rgba(255,255,255,.15)} #p .b3{background:linear-gradient(135deg,#14b8a6,#0d9488);border:1px solid #2dd4bf;color:#fff;box-shadow:0 2px 6px rgba(20,184,166,.35),inset 0 1px 0 rgba(255,255,255,.15)} #p .b4{background:linear-gradient(135deg,#d946ef,#a21caf);border:1px solid #e879f9;color:#fff;box-shadow:0 2px 6px rgba(217,70,239,.35),inset 0 1px 0 rgba(255,255,255,.15)} #p .b5{background:linear-gradient(135deg,#10b981,#059669);border:1px solid #34d399;color:#fff;box-shadow:0 2px 6px rgba(16,185,129,.35),inset 0 1px 0 rgba(255,255,255,.15)} #p .b6{background:linear-gradient(135deg,#8b5cf6,#6d28d9);border:1px solid #a78bfa;color:#fff;box-shadow:0 2px 6px rgba(139,92,246,.4),inset 0 1px 0 rgba(255,255,255,.15)} #p .b7{background:linear-gradient(135deg,#06b6d4,#0891b2);border:1px solid #22d3ee;color:#fff;box-shadow:0 2px 6px rgba(6,182,212,.35),inset 0 1px 0 rgba(255,255,255,.15)} #p .b8{background:linear-gradient(135deg,#ef4444,#b91c1c);border:1px solid #f87171;color:#fff;box-shadow:0 2px 6px rgba(239,68,68,.4),inset 0 1px 0 rgba(255,255,255,.15)} #p .b9{background:linear-gradient(135deg,#f43f5e,#be123c);border:1px solid #fb7185;color:#fff;box-shadow:0 2px 6px rgba(244,63,94,.35),inset 0 1px 0 rgba(255,255,255,.15)} #p .b10{background:linear-gradient(135deg,#0ea5e9,#0369a1);border:1px solid #38bdf8;color:#fff;box-shadow:0 2px 6px rgba(14,165,233,.35),inset 0 1px 0 rgba(255,255,255,.15)} #p .b11{background:linear-gradient(135deg,#84cc16,#4d7c0f);border:1px solid #a3e635;color:#fff;box-shadow:0 2px 6px rgba(132,204,22,.35),inset 0 1px 0 rgba(255,255,255,.15)} #p .b12{background:linear-gradient(135deg,#a855f7,#7e22ce);border:1px solid #c084fc;color:#fff;box-shadow:0 2px 6px rgba(168,85,247,.35),inset 0 1px 0 rgba(255,255,255,.15)} #p .b13{background:linear-gradient(135deg,#dc2626,#7f1d1d);border:1px solid #ef4444;color:#fff;box-shadow:0 2px 6px rgba(220,38,38,.35),inset 0 1px 0 rgba(255,255,255,.15)} #p .b14{background:linear-gradient(135deg,#6366f1,#3730a3);border:1px solid #818cf8;color:#fff;box-shadow:0 2px 6px rgba(99,102,241,.4),inset 0 1px 0 rgba(255,255,255,.15)} #p .b15{background:linear-gradient(135deg,#ea580c,#f59e0b);border:1px solid #fb923c;color:#fff;box-shadow:0 2px 8px rgba(234,88,12,.45),inset 0 1px 0 rgba(255,255,255,.22);text-shadow:0 1px 1px rgba(0,0,0,.25)} #p .b0{background:linear-gradient(135deg,#1f1f3a,#13132e);border:1px solid #2a2a4a;color:#a0a0c8;box-shadow:0 1px 3px rgba(0,0,0,.3)} #p .bh{padding:6px 8px;font-size:.66rem;border-radius:5px} #p .tg{width:24px;height:12px;background:linear-gradient(180deg,#1a1a38,#0f0f24);border-radius:7px;border:1px solid #333366;cursor:pointer;position:relative;flex-shrink:0;transition:all .25s;box-shadow:inset 0 1px 2px rgba(0,0,0,.5)} #p .tg-dot{width:8px;height:8px;background:linear-gradient(135deg,#888,#555);border-radius:50%;position:absolute;top:1px;left:1px;transition:all .25s;box-shadow:0 1px 2px rgba(0,0,0,.4)} #p .tg.on{background:linear-gradient(180deg,#059669,#047857);border-color:#10b981;box-shadow:inset 0 1px 2px rgba(0,0,0,.3),0 0 6px rgba(16,185,129,.4)} #p .tg.on .tg-dot{left:13px;background:linear-gradient(135deg,#fff,#a7f3d0);box-shadow:0 0 4px rgba(74,222,128,.6)} #ps .sc{padding:4px 6px 4px} #ps .su-section{background:linear-gradient(135deg,#13132e,#18183a);border-radius:6px;padding:4px 6px 3px;margin-bottom:1px;border:1px solid rgba(124,58,237,.15);box-shadow:none} #ps .su-sec-title{display:none} #ps .su-badge{font-size:.46rem;font-weight:800;padding:0px 4px;border-radius:2px;letter-spacing:.2px} #ps .su-badge.on{background:rgba(16,185,129,.15);color:#34d399;border:1px solid rgba(52,211,153,.25)} #ps .su-badge.off{background:rgba(239,68,68,.1);color:#f87171;border:1px solid rgba(248,113,113,.18)} #ps .su-row{display:flex;gap:2px;margin-bottom:1px;align-items:center} #ps .su-row input[type=text],#ps .su-row input[type=tel],#ps .su-row input[type=email],#ps .su-row input[type=password]{flex:1;min-width:0;background:linear-gradient(180deg,#1f1f3a,#181832);border:1px solid #3f3f65;padding:4px 6px;border-radius:4px;color:#eaeaff;font-size:.62rem;font-weight:600;outline:none;transition:all .2s} #ps .su-row input::placeholder{color:#7575a0;font-size:.56rem;font-weight:500} #ps .su-row input:focus{border-color:#7c3aed;box-shadow:0 0 0 1px rgba(124,58,237,.25)} #ps .su-row button{padding:4px 6px;font-size:.58rem;font-weight:700;border-radius:4px;white-space:nowrap;flex:none;min-width:85px;text-align:center} #ps .su-full{display:flex;gap:2px;margin-bottom:1px} #ps .su-full button{flex:1;padding:4px 6px;font-size:.58rem;font-weight:700;border-radius:4px} #ps .su-half{display:flex;gap:2px;margin-bottom:1px} #ps .su-half button{flex:1;padding:4px 6px;font-size:.58rem;font-weight:700;border-radius:4px} #ps .su-msg{font-size:.5rem;font-weight:600;min-height:10px;padding:0 2px 0px;margin-bottom:1px;line-height:1.2;border-radius:2px;transition:all .3s} #ps .su-msg.g{color:#4ade80} #ps .su-msg.r{color:#fca5a5} #ps .su-msg.y{color:#fcd34d} #ps .su-pw{flex:1;display:flex;position:relative;min-width:0} #ps .su-pw input{width:100%;padding-right:20px!important} #ps .su-pw .eye{position:absolute;right:2px;top:50%;transform:translateY(-50%);background:none;border:none;color:#8888aa;cursor:pointer;padding:0 3px;font-size:.64rem;line-height:1;z-index:2;transition:color .2s} #ps .su-pw .eye:hover{color:#a78bfa} #p .cp{background:linear-gradient(135deg,#070716,#0a0a1f);border-radius:6px;padding:6px 6px 4px;margin-top:2px;border:1px solid rgba(124,58,237,.2);box-shadow:inset 0 1px 3px rgba(0,0,0,.5)} #p .cp .cr{display:flex;gap:3px;align-items:center;margin-bottom:5px} #p .cp .cr .cl{display:flex;gap:3px;flex:1} #p .cp .cr .cr2{display:flex;gap:3px;align-items:center;justify-content:flex-end} #p .cp .cr button{padding:4px 6px;font-size:.6rem;font-weight:700;background:linear-gradient(135deg,#13132a,#0c0c1e);border:1px solid #1f1f3a;color:#777799;border-radius:4px;flex:1;text-align:center;transition:all .2s} #p .cp .cr button:hover{background:linear-gradient(135deg,#1a1a3a,#13132a);color:#c0c0e0} #p .cp .cr button.a{background:linear-gradient(135deg,#7c3aed,#4f46e5);border-color:#a78bfa;color:#fff;box-shadow:0 0 8px rgba(124,58,237,.45),inset 0 1px 0 rgba(255,255,255,.2)} #p .cp .cf-wrap{width:100%;max-width:250px;margin:0 auto;border-radius:5px;overflow:hidden;background:linear-gradient(135deg,#0a0a1a,#06061a);border:1px solid rgba(124,58,237,.25);min-height:58px;display:flex;align-items:center;justify-content:center;margin-bottom:3px;box-shadow:inset 0 1px 4px rgba(0,0,0,.5)} #p .cp .cf-wrap .cf-turnstile{width:100%} #p .cp .cf-wrap iframe{border:none!important;border-radius:4px} #p .cp .ck-row{display:flex;align-items:center;gap:0;margin-top:2px;padding:2px 5px;background:linear-gradient(90deg,#06061a,#0a0a1f,#06061a);border-radius:5px;border:1px solid rgba(124,58,237,.15)} #p .cp .ck-time{font-size:.78rem;font-family:Consolas,monospace;font-weight:800;background:linear-gradient(90deg,#a78bfa,#c4b5fd);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:.5px;flex-shrink:0} #p .cp .ck-sep{width:1px;height:14px;background:linear-gradient(180deg,transparent,#3b3777,transparent);margin:0 7px;flex-shrink:0} #p .cp .ck-date{font-size:.62rem;background:linear-gradient(90deg,#c4b5fd,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-weight:700;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} #p .cp .ck-row .b8{padding:3px 11px;border-radius:4px;font-size:.58rem;flex-shrink:0} #p .ft{padding:4px 9px 4px;background:linear-gradient(90deg,#06061a,#0a0a1f,#06061a);display:flex;flex-direction:column;align-items:center;gap:2px;border-top:1px solid rgba(124,58,237,.2);flex-shrink:0} #p .ft .ft-top{display:flex;justify-content:center;align-items:center;width:100%} #p .ft .fl{display:flex;gap:4px} #p .ft button{background:linear-gradient(135deg,#0c0c1e,#13132a);border:1px solid #2a2a4a;padding:5px 12px;font-size:.68rem;border-radius:4px;color:#a0a0c8;font-weight:700;letter-spacing:.5px;transition:all .2s} #p .ft button:hover{background:linear-gradient(135deg,#1a1a3a,#222248);color:#fff;border-color:#7c3aed;transform:translateY(-1px);box-shadow:0 2px 6px rgba(124,58,237,.3)} #p .ft span{font-size:.82rem;background:linear-gradient(90deg,#f97316,#fbbf24,#f59e0b);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;font-weight:900;letter-spacing:.6px;white-space:nowrap;text-shadow:0 0 10px rgba(249,115,22,.35)} #p .cdbar{background:linear-gradient(90deg,#05050f,#0a0a1f,#05050f);padding:3px 9px;display:flex;align-items:center;justify-content:center;gap:8px;border-top:1px solid rgba(124,58,237,.15);flex-shrink:0;min-height:0;flex-wrap:nowrap} #p .cd-empty{font-size:.6rem;color:#5a5a78;font-weight:600;letter-spacing:.4px;font-family:Consolas,monospace} #p .cd-cell{display:flex;align-items:center;gap:5px;padding:3px 8px;border-radius:5px;background:linear-gradient(135deg,#0d0d24,#13132e);border:1px solid rgba(124,58,237,.25);box-shadow:inset 0 1px 2px rgba(0,0,0,.4);transition:all .3s} #p .cd-cell .cd-icon{font-size:.7rem;line-height:1} #p .cd-cell .cd-label{font-size:.56rem;color:#8888aa;font-weight:700;letter-spacing:.5px} #p .cd-cell .cd-time{font-family:Consolas,monospace;font-size:.74rem;font-weight:800;letter-spacing:.5px} #p .cd-otp .cd-time{color:#5eead4;text-shadow:0 0 6px rgba(94,234,212,.45)} #p .cd-token .cd-time{color:#a78bfa;text-shadow:0 0 6px rgba(167,139,250,.45)} #p .cd-sep{width:1px;height:14px;background:linear-gradient(180deg,transparent,#3b3777,transparent);flex-shrink:0} #p .cd-cell.warn{border-color:#ef4444;background:linear-gradient(135deg,#1a0a0a,#2a0d0d);animation:cdpulse 1s ease-in-out infinite} #p .cd-cell.warn .cd-time{color:#fca5a5 !important;text-shadow:0 0 8px rgba(252,165,165,.6) !important} #p .cd-cell.warn .cd-label{color:#fca5a5} @keyframes cdpulse{0%,100%{box-shadow:inset 0 1px 2px rgba(0,0,0,.4),0 0 6px rgba(239,68,68,.4)}50%{box-shadow:inset 0 1px 2px rgba(0,0,0,.4),0 0 14px rgba(239,68,68,.8)}} #p .cd-cell.expired{border-color:#444;opacity:.55} #p .cd-cell.expired .cd-time{color:#666 !important;text-shadow:none !important;text-decoration:line-through} .btn-inline-cd{display:inline-block;margin-left:5px;padding:2px 6px;font-family:Consolas,monospace;font-size:.62rem;font-weight:800;border-radius:3px;background:rgba(0,0,0,.35);color:#fde047;letter-spacing:.4px} .btn-inline-cd.warn{color:#fca5a5;background:rgba(239,68,68,.2);animation:cdpulse 1s ease-in-out infinite} #p .tp{display:none} #p .tp.a{display:block} #pl input[type=text],#pl input[type=tel],#pl input[type=email],#pl input[type=password],#pl input[type=number],#pl select,#pf input[type=text],#pf input[type=number],#pf select,#pf textarea,#pe input[type=text],#pe input[type=number],#pe select,#px input[type=text],#px input[type=number],#px input[type=password],#px select,#px textarea{background:linear-gradient(180deg,#15152e,#10102a) !important;border:1px solid #3a3a5e !important;color:#f0f0ff !important} #pl input::placeholder,#pl select option,#pf input::placeholder,#pf textarea::placeholder,#pe input::placeholder,#pe select option,#px input::placeholder,#px textarea::placeholder{color:#7575a0 !important} #pf .pl-row{display:flex;gap:5px;align-items:center;margin-bottom:5px} #pf .pl-row span{font-size:.66rem;color:#b0b0cc;font-weight:700;white-space:nowrap} #pf .pl-row input[type=number]{flex:1;text-align:center;padding:4px 2px;min-width:0} #px textarea{height:58px} #pu input[type=text],#pu input[type=tel],#pu input[type=email],#pu input[type=password],#pu input[type=number],#pu select,#pu input[type=file]{background:linear-gradient(180deg,#15152e,#10102a)!important;border:1px solid #3a3a5e!important;color:#f0f0ff!important} #pu input::placeholder,#pu select option{color:#7575a0!important}#pu .fr{margin-bottom:4px;gap:4px}#pu button{padding:6px 7px!important;font-size:.64rem!important;line-height:1.25!important;border-radius:5px!important}#pu input[type=file]{font-size:.54rem!important;padding:3px!important;height:auto!important}#pu input[type=text],#pu input[type=number],#pu select{padding:6px 7px!important;font-size:.66rem!important}#pu .sc{padding:6px 9px 8px!important} #px .proxy-msg{font-size:.62rem;color:#8888aa;font-weight:600;margin-top:3px;text-align:center} #p .enc-section{margin-top:5px;padding:5px 6px;background:linear-gradient(135deg,#070716,#0a0a1f);border:1px dashed rgba(124,58,237,.3);border-radius:7px} #p .enc-title{font-size:.64rem;color:#a78bfa;font-weight:800;letter-spacing:.5px;margin-bottom:4px} #p .enc-row{display:flex;gap:4px;align-items:center;margin-bottom:3px} #p .enc-row input[type=checkbox]{flex:none;accent-color:#7c3aed;width:14px;height:14px;cursor:pointer} #p .enc-row label{flex:none;font-size:.62rem;color:#c4b5fd;font-weight:700;cursor:pointer;min-width:60px} #p .enc-row .enc-status{flex:none;font-size:.54rem;font-weight:600;margin-left:auto} #p .enc-editor{display:none;margin-bottom:4px} #p .enc-editor textarea{height:100px;font-size:.58rem;line-height:1.35;background:linear-gradient(180deg,#0d0d24,#08081a)!important;border:1px solid rgba(124,58,237,.25)!important;color:#c4b5fd!important;border-radius:5px} #p .enc-editor textarea::placeholder{color:#3a3a5e!important;font-size:.54rem} #p .enc-editor .enc-btn-row{display:flex;gap:3px;margin-top:3px} #p .enc-editor .enc-btn-row button{flex:1;padding:4px 0;font-size:.58rem;font-weight:700} #p .enc-cfg-row{display:flex;gap:5px;align-items:center;margin-bottom:4px} #p .enc-cfg-row label{flex:none;min-width:75px;font-size:.62rem;color:#c4b5fd;font-weight:700} #p .enc-cfg-row input,#p .enc-cfg-row select{flex:1;min-width:0} #p .enc-cfg-actions{display:flex;gap:4px;align-items:center;margin-top:5px} #p .enc-cfg-actions .bh{padding:3px 8px;font-size:.62rem;line-height:1.15} #p .enc-cfg-actions .enc-status{font-size:.58rem;font-weight:700;margin-left:auto} #p-fab{position:fixed;bottom:22px;left:22px;width:54px;height:54px;background:linear-gradient(135deg,#f97316,#ea580c,#c2410c);border-radius:50%;color:#fff;font-size:1.25rem;font-weight:900;z-index:9999999;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(249,115,22,.55),inset 0 2px 0 rgba(255,255,255,.25);cursor:pointer;transition:all .25s;border:2px solid rgba(255,255,255,.15);font-family:'Segoe UI',sans-serif;letter-spacing:.5px} #p-fab:hover{transform:scale(1.12) rotate(-5deg);box-shadow:0 8px 28px rgba(249,115,22,.7),inset 0 2px 0 rgba(255,255,255,.3)} #p-fab.hidden{display:none !important} #profile-manager{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:370px;background:linear-gradient(160deg,#1a1a2e,#16162a,#13132e);border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.85),0 0 0 1px rgba(124,58,237,.3),0 0 30px rgba(124,58,237,.12);z-index:99999999;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:#e0e0ff;display:none;flex-direction:column;overflow:hidden} #profile-manager.open{display:flex} #profile-manager .pm-header{background:linear-gradient(90deg,#0a0a18,#15152e,#0a0a18);padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(124,58,237,.3);user-select:none;cursor:move;position:relative} #profile-manager .pm-header::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,#7c3aed,#4f46e5);border-radius:0 2px 2px 0} #profile-manager .pm-title{font-size:.78rem;font-weight:800;background:linear-gradient(90deg,#c4b5fd,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:.6px} #profile-manager .pm-close{background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.35);color:#a78bfa;font-size:.95rem;cursor:pointer;line-height:1;padding:0 8px;border-radius:5px;transition:all .2s} #profile-manager .pm-close:hover{background:rgba(124,58,237,.25);color:#fff;transform:scale(1.05)} #profile-manager .pm-body{overflow-y:auto;padding:12px;flex:1;background:#13132e} #profile-manager .pm-section{background:linear-gradient(135deg,#1f1f38,#1a1a32);border-radius:9px;padding:10px 12px;margin-bottom:10px;border:1px solid rgba(124,58,237,.25)} #profile-manager .pm-section h4{font-size:.68rem;font-weight:800;background:linear-gradient(90deg,#c4b5fd,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:9px;border-bottom:1px solid rgba(124,58,237,.3);padding-bottom:5px;text-transform:uppercase;letter-spacing:.6px} #profile-manager .pm-select-row{display:flex;gap:7px;margin-bottom:11px;align-items:center} #profile-manager .pm-select-row select{flex:2;background:linear-gradient(180deg,#0f0f24,#0a0a1c);border:1px solid #4a4a7a;color:#e0e0ff;padding:7px 9px;border-radius:7px;font-size:.72rem;font-weight:500} #profile-manager .pm-select-row select:focus{border-color:#a78bfa;outline:none;box-shadow:0 0 0 2px rgba(167,139,250,.2)} #profile-manager .pm-select-row button{padding:7px 11px;border-radius:7px;font-size:.66rem;font-weight:800;cursor:pointer;border:none;transition:all .2s;color:#fff;letter-spacing:.5px} #profile-manager .pm-select-row button:hover{filter:brightness(1.15);transform:translateY(-1px)} #profile-manager .pm-btn-new{background:linear-gradient(135deg,#10b981,#059669);box-shadow:0 2px 8px rgba(16,185,129,.4);flex:1} #profile-manager .pm-btn-del{background:linear-gradient(135deg,#ef4444,#b91c1c);box-shadow:0 2px 8px rgba(239,68,68,.4);flex:1} #profile-manager .pm-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:7px} #profile-manager input{background:linear-gradient(180deg,#0f0f24,#0a0a1c);border:1px solid #4a4a7a;color:#e0e0ff;padding:7px 9px;border-radius:7px;font-size:.72rem;outline:none;box-sizing:border-box;font-family:inherit;font-weight:500;transition:all .2s} #profile-manager input:focus{border-color:#a78bfa;box-shadow:0 0 0 2px rgba(167,139,250,.2)} #profile-manager input::placeholder{color:#6a6a9a;font-size:.66rem;font-weight:400} #profile-manager .pm-action-row{display:flex;gap:7px;margin-top:9px} #profile-manager .pm-action-row button{flex:1;padding:8px;border-radius:7px;font-size:.7rem;font-weight:800;cursor:pointer;border:none;transition:all .2s;color:#fff;letter-spacing:.5px} #profile-manager .pm-action-row button:hover{filter:brightness(1.15);transform:translateY(-1px)} #profile-manager .pm-btn-export{background:linear-gradient(135deg,#3b82f6,#1d4ed8);box-shadow:0 2px 8px rgba(59,130,246,.4)} #profile-manager .pm-btn-import{background:linear-gradient(135deg,#8b5cf6,#6d28d9);box-shadow:0 2px 8px rgba(139,92,246,.4)} #profile-manager .pm-btn-save{background:linear-gradient(135deg,#059669,#047857);box-shadow:0 2px 8px rgba(5,150,105,.4)} #pm-import-file{display:none} #p #bst,#p .cp .cr .cl button#csi,#p .cp .cr .cl button#csr,#p #pl-button,#p #badv,#p #bsgn{padding-top:4px !important;padding-bottom:4px !important;line-height:1.15 !important} #p .tq-row{display:flex;align-items:center;gap:4px;margin-top:2px;padding:2px 5px;background:linear-gradient(90deg,#06061a,#0a0a1f,#06061a);border-radius:4px;border:1px solid rgba(124,58,237,.15);font-size:.54rem;color:#8888aa;font-weight:600} #p .tq-label{flex-shrink:0;font-size:.54rem;letter-spacing:.3px} #p .tq-slots{display:flex;gap:2px;flex:1;justify-content:center} #p .tq-slot{width:10px;height:10px;border-radius:2px;border:1px solid #2a2a4a;background:linear-gradient(135deg,#0a0a18,#06061a);transition:all .3s;position:relative} #p .tq-slot.empty{background:linear-gradient(135deg,#0a0a18,#06061a);border-color:#2a2a4a;opacity:.4} #p .tq-slot.turnstile{background:linear-gradient(135deg,#06b6d4,#0891b2);border-color:#22d3ee;box-shadow:0 0 4px rgba(34,211,238,.5),inset 0 1px 0 rgba(255,255,255,.2);opacity:1} #p .tq-slot.capmonster{background:linear-gradient(135deg,#a855f7,#7e22ce);border-color:#c084fc;box-shadow:0 0 4px rgba(168,85,247,.5),inset 0 1px 0 rgba(255,255,255,.2);opacity:1} #p .tq-slot.capsolver{background:linear-gradient(135deg,#10b981,#059669);border-color:#34d399;box-shadow:0 0 4px rgba(52,211,153,.5),inset 0 1px 0 rgba(255,255,255,.2);opacity:1} #p .tq-slot.twocaptcha{background:linear-gradient(135deg,#f59e0b,#d97706);border-color:#fbbf24;box-shadow:0 0 4px rgba(251,191,36,.5),inset 0 1px 0 rgba(255,255,255,.2);opacity:1} #p .tq-slot.yescaptcha{background:linear-gradient(135deg,#ec4899,#be185d);border-color:#f472b6;box-shadow:0 0 4px rgba(244,114,182,.5),inset 0 1px 0 rgba(255,255,255,.2);opacity:1} #p .tq-slot.solving{background:linear-gradient(135deg,#fcd34d,#f59e0b);border-color:#fcd34d;box-shadow:0 0 6px rgba(252,211,77,.6);animation:tqPulse 1s ease-in-out infinite} #p .tq-slot.expiring{animation:tqExpiring 1s ease-in-out infinite} @keyframes tqPulse{0%,100%{box-shadow:0 0 4px rgba(252,211,77,.5)}50%{box-shadow:0 0 10px rgba(252,211,77,.9)}} @keyframes tqExpiring{0%,100%{filter:brightness(1)}50%{filter:brightness(0.5) hue-rotate(-30deg)}} #p .tq-info{flex-shrink:0;font-family:Consolas,monospace;font-size:.5rem;color:#a78bfa;font-weight:700;min-width:62px;text-align:right;letter-spacing:.2px} #p .tq-info.solving{color:#fcd34d;animation:tqInfoPulse 1.5s ease-in-out infinite} @keyframes tqInfoPulse{0%,100%{opacity:.7}50%{opacity:1}} #rj-netlog{position:fixed;bottom:90px;left:20px;width:480px;max-width:90vw;height:420px;background:linear-gradient(160deg,#0d0d1e,#10102a,#0a0a18);border-radius:12px;box-shadow:0 20px 50px rgba(0,0,0,.85),0 0 0 1px rgba(124,58,237,.3),0 0 25px rgba(124,58,237,.15);z-index:99999990;display:none;flex-direction:column;font-family:'Segoe UI',system-ui,sans-serif;color:#e0e0f0;overflow:hidden;backdrop-filter:blur(8px)} #rj-netlog.open{display:flex} #rj-netlog .netlog-header{background:linear-gradient(90deg,#0a0a18,#15152e,#0a0a18);padding:9px 13px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(124,58,237,.3);cursor:move;user-select:none;position:relative} #rj-netlog .netlog-header::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,#7c3aed,#4f46e5);border-radius:0 2px 2px 0} #rj-netlog .netlog-title{font-size:.78rem;font-weight:800;background:linear-gradient(90deg,#c4b5fd,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:.6px} #rj-netlog .netlog-tools{display:flex;gap:6px} #rj-netlog .netlog-tools button{background:linear-gradient(135deg,#13132e,#1f1f3a);border:1px solid rgba(124,58,237,.3);color:#c4b5fd;font-size:.66rem;font-weight:700;padding:3px 10px;border-radius:5px;cursor:pointer;transition:all .2s} #rj-netlog .netlog-tools button:hover{background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff} #rj-netlog .netlog-tools #netlog-close{padding:3px 9px} #rj-netlog .netlog-meta{padding:6px 12px;background:#06061a;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(124,58,237,.15);font-size:.62rem;color:#8888aa;font-weight:600} #rj-netlog .netlog-steps{padding:8px 10px;background:linear-gradient(90deg,#06061a,#0a0a1f,#06061a);display:flex;gap:6px;border-bottom:1px solid rgba(124,58,237,.15)} #rj-netlog .nl-step{flex:1;text-align:center;font-size:.66rem;font-weight:800;padding:6px 4px;border-radius:6px;background:linear-gradient(135deg,#1a1a2e,#13132a);border:1px solid #2a2a4a;color:#7777aa;letter-spacing:.3px;transition:all .3s;position:relative} #rj-netlog .nl-step.active{background:linear-gradient(135deg,#fcd34d,#f59e0b);border-color:#fcd34d;color:#1a1a00;box-shadow:0 0 10px rgba(252,211,77,.5),inset 0 1px 0 rgba(255,255,255,.3);animation:nlPulse 1s ease-in-out infinite} #rj-netlog .nl-step.success{background:linear-gradient(135deg,#10b981,#059669);border-color:#34d399;color:#fff;box-shadow:0 0 12px rgba(16,185,129,.55),inset 0 1px 0 rgba(255,255,255,.25)} #rj-netlog .nl-step.fail{background:linear-gradient(135deg,#ef4444,#b91c1c);border-color:#f87171;color:#fff;box-shadow:0 0 10px rgba(239,68,68,.5),inset 0 1px 0 rgba(255,255,255,.25)} @keyframes nlPulse{0%,100%{box-shadow:0 0 10px rgba(252,211,77,.4)}50%{box-shadow:0 0 18px rgba(252,211,77,.7)}} #rj-netlog #netlog-filter{background:#0a0a1a;border:1px solid #2a2a4a;color:#c4b5fd;font-size:.6rem;padding:2px 4px;border-radius:4px;cursor:pointer;font-family:inherit} #rj-netlog .netlog-body{flex:1;overflow-y:auto;padding:6px;background:#06061a;font-family:Consolas,'Courier New',monospace;font-size:.66rem;line-height:1.5} #rj-netlog .netlog-body::-webkit-scrollbar{width:6px} #rj-netlog .netlog-body::-webkit-scrollbar-thumb{background:rgba(124,58,237,.4);border-radius:3px} #rj-netlog .nl-entry{padding:4px 8px;margin-bottom:3px;border-radius:5px;border-left:3px solid #2a2a4a;background:rgba(15,15,35,.7);display:grid;grid-template-columns:65px 55px 60px 1fr;gap:6px;align-items:center} #rj-netlog .nl-entry.ok{border-left-color:#10b981} #rj-netlog .nl-entry.fail{border-left-color:#ef4444;background:rgba(40,15,15,.55)} #rj-netlog .nl-entry.pending{border-left-color:#fcd34d;background:rgba(30,28,5,.55)} #rj-netlog .nl-entry.cancel{border-left-color:#888;opacity:.55} #rj-netlog .nl-time{color:#8888aa;font-size:.6rem} #rj-netlog .nl-method{color:#a78bfa;font-weight:700;font-size:.6rem} #rj-netlog .nl-status{font-weight:800;font-size:.62rem;text-align:center;padding:1px 4px;border-radius:3px;background:#13132e} #rj-netlog .nl-status.ok{background:rgba(16,185,129,.2);color:#34d399} #rj-netlog .nl-status.fail{background:rgba(239,68,68,.2);color:#fca5a5} #rj-netlog .nl-status.pending{background:rgba(252,211,77,.2);color:#fcd34d} #rj-netlog .nl-status.cancel{background:rgba(136,136,136,.2);color:#aaa} #rj-netlog .nl-url{color:#e0e0f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.62rem} #rj-netlog .nl-tag{display:inline-block;font-size:.55rem;font-weight:700;padding:1px 4px;border-radius:3px;background:rgba(124,58,237,.25);color:#c4b5fd;margin-right:4px;text-transform:uppercase} #rj-netlog .nl-empty{text-align:center;color:#555588;padding:30px 10px;font-size:.7rem;font-family:inherit} #rj-milestone-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999999999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);font-family:'Segoe UI',system-ui,sans-serif} #rj-milestone-overlay .mp-card{width:300px;background:linear-gradient(160deg,#1a1a2e,#16162a);border-radius:14px;box-shadow:0 25px 60px rgba(0,0,0,.85),0 0 0 1px rgba(124,58,237,.3),0 0 30px rgba(124,58,237,.15);overflow:hidden;text-align:center;animation:mpFadeIn .25s ease-out} #rj-milestone-overlay .mp-emoji{padding:22px 20px 10px;font-size:2.2rem} #rj-milestone-overlay .mp-title{padding:0 20px 6px;color:#fff;font-size:.88rem;font-weight:800;letter-spacing:.3px} #rj-milestone-overlay .mp-msg{padding:0 20px 16px;color:#b0b0d0;font-size:.72rem;font-weight:600;line-height:1.5;word-break:break-all} #rj-milestone-overlay .mp-ok{width:100%;background:linear-gradient(135deg,#7c3aed,#4f46e5);border:1px solid #a78bfa;color:#fff;padding:10px 0;border-radius:8px;font-size:.76rem;font-weight:800;cursor:pointer;letter-spacing:.5px;box-shadow:0 3px 10px rgba(124,58,237,.4);transition:all .2s} #rj-milestone-overlay .mp-ok:hover{filter:brightness(1.15);transform:translateY(-1px)} @keyframes mpFadeIn{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}} `; document.head.appendChild(s);

// ==================== HTML STRUCTURE ====================
const h2html = `
<div id="p-fab" class="hidden">RJ</div>
<div id="p">
<div class="dh" id="dh"> <span class="dt">RJ SLOT v7.5 H2</span>
<div style="display:flex;gap:5px;align-items:center"> <button class="db" id="auto-enc-btn" title="Auto-scan: re-check the bundle every 2s; when encryption config is found it turns itself OFF and auto-starts Signin" style="font-size:10px;font-weight:700;letter-spacing:.2px">A_E</button> <button class="db" id="enc-clear-btn" title="Clear all encryption config (stops dangerous signin auto-retry from stale config)" style="font-size:10px;font-weight:700;letter-spacing:.2px">E_encrpt</button> <button class="db" id="scan-btn" title="Manual bundle scan — re-extract encryption config">⟳</button> <button class="db" id="mb">&minus;</button>
</div>
</div>

<div class="tb"> <button class="t a" data-t="l">Login</button> <button class="t" data-t="s">Sign Up</button> <button class="t" data-t="u">Upload</button> <button class="t" data-t="f">Fetch</button> <button class="t" data-t="e">Encrypt</button> <button class="t" data-t="x">Proxy</button>
</div>

<div class="bd">
<div class="sl">
<div class="a" id="ll"><span class="g">Ready (H/2)</span></div>
<div id="ls"><span class="y">Sign Up Ready</span></div>
<div id="lu"><span class="y">Upload Ready</span></div>
<div id="lf"><span class="y">Fetch Ready</span></div>
<div id="le"><span class="y">Encrypt Ready</span></div>
</div>

<div class="tp a" id="pl">
<div class="sc">
<div class="fr"><select id="login-proxy-picker" style="flex:2;min-width:0" title="Active proxy (synced with Proxy tab)"><option value="">-- Direct (no proxy) --</option></select><button class="b2 bh" id="login-proxy-toggle" title="Toggle connect/disconnect">Disconnect</button></div>
<div class="fr"><select id="main-profile-select" style="width:100%;min-width:0"><option value="">-- Select Profile --</option></select></div>
<div class="fr sa-row"> <input type="number" id="rt-signin" value="1" min="0" max="999" title="Signin retry delay (seconds)"> <input type="number" id="rt-verify" value="1" min="0" max="999" title="Verify retry delay (seconds)"> <input type="number" id="rt-reserve" value="21" min="0" max="999" title="Reserve retry delay (seconds)"> <input type="number" id="rt-book" value="1" min="0" max="999" title="Book retry delay (seconds)"> <input type="number" id="rt-initiate" value="1" min="0" max="999" title="Initiate retry delay (seconds)"> <button class="b5 toggle-btn sa-btn" id="btn-single" title="Single ON: retry on failure. OFF: no retry, fail = stop">Single</button> <input type="number" id="rt-auto-loops" value="0" min="0" max="999" title="Reserved (currently unused)"> <button class="b5 toggle-btn sa-btn" id="btn-auto" title="Auto ON: after a step wins, automatically continues to next step. Manual button starts the flow.">Auto</button>
</div>

<div class="fr-phone"> <select id="login-phone-type" class="phone-type-sel"> <option value="phone1">📞 P1</option> <option value="email">✉️ Em</option> <option value="phone2">📞 P2</option> </select> <input type="tel" id="login-phone" placeholder="Phone 1">
<div class="sw-c">
<div class="tg" id="advance-toggle"><div class="tg-dot"></div></div>
</div> <button class="b2 bh" style="padding:4px 8px!important" id="badv-phone">Advance</button>
</div>

<div class="fr-pw"><div class="pw" style="flex:0 0 44%"><input type="password" id="login-password" placeholder="Password"><button class="eye">&#128065;</button></div><label style="flex:none;display:flex;align-items:center;gap:2px;font-size:.55rem;color:#7777aa;font-weight:700;cursor:pointer" title="✓ = Signin sends RAW token (skip encryption). Unchecked = encrypted (default)."><input type="checkbox" id="chk-signin-raw" style="width:12px;height:12px;accent-color:#f59e0b;cursor:pointer">raw</label><button class="b7 bh" id="bsi">Signin</button></div>
<div class="fr-otp"><input type="text" id="login-otp" placeholder="Login OTP"><button class="b4 bh" id="botp">OTP</button><button class="b5 bh" id="bve">Verify</button></div>
<div class="fr"> <button class="b1 bh" style="flex:1" id="brs">Reserve</button> <button class="b14 bh" style="flex:1" id="bbk">Book</button> <button class="b6 bh" style="flex:1" id="bin">Initiate</button>
</div>
<div class="fr" style="gap:3px;padding:1px 2px">
<label style="flex:1;display:flex;align-items:center;justify-content:center;gap:3px;font-size:.55rem;color:#7777aa;font-weight:700;cursor:pointer" title="✓ = Reserve sends RAW token (skip encryption). Unchecked = encrypted (default)."><input type="checkbox" id="chk-reserve-raw" style="width:12px;height:12px;accent-color:#f59e0b;cursor:pointer">Reserve raw</label>
<span style="flex:1"></span>
<label style="flex:1;display:flex;align-items:center;justify-content:center;gap:3px;font-size:.55rem;color:#7777aa;font-weight:700;cursor:pointer" title="✓ = Initiate ENCRYPTS token per Initiate config. Unchecked = raw (default)."><input type="checkbox" id="chk-initiate-enc" style="width:12px;height:12px;accent-color:#10b981;cursor:pointer">Initiate enc</label>
<label style="flex:1;display:flex;align-items:center;justify-content:center;gap:3px;font-size:.55rem;color:#7777aa;font-weight:700;cursor:pointer" title="✓ = native fetch (DevTools Network Fetch/XHR e DEKHABE, kintu CORS lagbe). Unchecked = GM (CORS-immune, kintu Network e lukano)."><input type="checkbox" id="chk-initiate-net" checked style="width:12px;height:12px;accent-color:#10b981;cursor:pointer">Initiate Net</label>
</div>
<div class="fr" style="gap:4px"><input type="text" id="ivac-reserve-slot-id" placeholder="Reserve Slot ID (54ea9f13-… — center fixed)" autocomplete="off" spellcheck="false" style="flex:1;min-width:0" title="Center-fixed slot UUID from the real reserve-slot URL. Paste once; saved."></div>
<div class="fr" style="gap:4px;align-items:center"><select id="ivac-reserve-date" style="flex:1;min-width:0" title="Appointment date for reserve — auto-synced from the time-slot page (first date auto-selected)"><option value="">📅 Reserve date…</option></select><button class="b3 bh" style="flex:none;padding:4px 9px!important" id="ivac-btn-load-dates" title="Sync dates now from the time-slot page / booking config">↻</button><label style="flex:none;font-size:.6rem;color:#7777aa;font-weight:700" title="Auto-pick date: ON = Latest (last), OFF = Earliest (first)">📆</label><div class="tg on" id="date-target-toggle" title="Auto-pick date: ON = Latest (last date), OFF = Earliest (first date)"><div class="tg-dot"></div></div><label style="flex:none;font-size:.6rem;color:#7777aa;font-weight:700">🔔</label><div class="tg" id="popup-toggle" title="Popup: ON=show milestone popups, OFF=disable"><div class="tg-dot"></div></div></div>
<div class="fr"><button class="b8" style="width:100%" id="bst">Stop All</button></div>
<div class="tr">
<div class="tm t1"><input class="ti" id="sched-advance" type="text" value="04:59:10:000 PM" spellcheck="false" title="Schedule time for Advance (Forgot flow)"></div>
<div class="reserve-tg-wrap"><div class="tg" id="reserve-toggle"><div class="tg-dot"></div></div></div>
<div class="tm t2"><input class="ti" id="sched-signin" type="text" value="04:59:59:900 PM" spellcheck="false" title="Schedule time for Signin (full flow)"></div>
</div>

<div class="fr"><button class="b5 bh" style="flex:1" id="badv">Advance</button><button class="b1 bh" style="flex:1" id="bsgn">Signin</button></div>
<div class="cp">
<div class="cr">
<div class="cl" style="margin-left:-6px"><button class="a" id="csi">Signin</button><button id="csr">Reserve</button></div>
<div class="cr2">
<div class="tg" id="captcha-toggle" title="Captcha: ON=CapMonster API, OFF=Turnstile widget"><div class="tg-dot"></div></div>
<div class="tg" id="parallel-toggle" style="margin-left:5px" title="Parallel mode (leaky-bucket retries)"><div class="tg-dot"></div></div> <button id="pl-button" style="margin-left:5px;background:linear-gradient(135deg,#7c3aed,#4f46e5);border:1px solid #a78bfa;color:#fff;padding:4px 10px;border-radius:5px;font-size:0.6rem;font-weight:800;box-shadow:0 2px 6px rgba(124,58,237,.4)">A_L</button> <button id="pl-del-appt" title="Delete saved Appointment ID from active profile" style="margin-left:4px;margin-right:-6px;background:linear-gradient(135deg,#ef4444,#b91c1c);border:1px solid #f87171;color:#fff;padding:4px 14px;border-radius:5px;font-size:0.6rem;font-weight:800;box-shadow:0 2px 6px rgba(239,68,68,.4)">A</button>
</div>
</div>

<div class="cf-wrap" id="cfWidget"><div class="cf-turnstile" id="cfTurnstile"></div></div>
<div class="tq-row" id="tq-row" title="Captcha token queue status"> <span class="tq-label">🎫 Queue</span> <span class="tq-slots" id="tq-slots"> <span class="tq-slot empty"></span> <span class="tq-slot empty"></span> <span class="tq-slot empty"></span> <span class="tq-slot empty"></span> <span class="tq-slot empty"></span> </span> <span class="tq-info" id="tq-info">0/5 • idle</span>
</div>

<div class="ck-row"> <span class="ck-time" id="tk">12:13:17 AM</span> <span class="ck-sep"></span> <span class="ck-date" id="dk">08/05/2026</span> <button class="b8" id="blo" style="margin-right:-12px;padding:3px 15px">Logout</button>
</div>
</div>
</div>
</div>

<div class="tp" id="ps">
<div class="sc">
<div class="su-section">
<div class="su-sec-title"><span>📱 Mobile Verification</span><span class="su-badge off" id="su-mobile-badge">NOT VERIFIED</span></div>
<div class="su-row"><input type="tel" id="ivac-mobile" placeholder="Mobile number (01XXXXXXXXX)"><button class="b3" id="ivac-btn-mobile">Mobile</button></div>
<div class="su-msg" id="ivac-msg-mobile"></div>
<div class="su-row"><input type="text" id="ivac-mobile-otp" placeholder="Enter OTP" maxlength="6"><button class="b2" id="ivac-btn-mobile-verify">Mobile Verify</button></div>
<div class="su-full"><button class="b4" id="ivac-btn-get-mobile-otp">Get Mobile OTP</button></div>
</div>

<div class="su-section">
<div class="su-sec-title"><span>✉️ Email Verification</span><span class="su-badge off" id="su-email-badge">NOT VERIFIED</span></div>
<div class="su-row"><input type="email" id="ivac-email" placeholder="Email address"><button class="b1" id="ivac-btn-email">Email</button></div>
<div class="su-msg" id="ivac-msg-email"></div>
<div class="su-row"><input type="text" id="ivac-email-otp" placeholder="Enter OTP" maxlength="6"><button class="b15" id="ivac-btn-email-verify">Email Verify</button></div>
<div class="su-full"><button class="b3" id="ivac-btn-get-email-otp">Get Email OTP</button></div>
</div>

<div class="su-section">
<div class="su-sec-title"><span>🪪 Personal Details</span></div>
<div class="su-row"><input type="text" id="ivac-dob" placeholder="Date of Birth (DD.MM.YYYY)"></div>
<div class="su-row"><input type="text" id="ivac-passport" placeholder="Passport No (AA00000000)"></div>
<div class="su-row"><input type="text" id="ivac-nid" placeholder="NID Number (10/13/17 digits)"></div>
<div class="su-row"><input type="text" id="ivac-surname" placeholder="Surname (As in Passport)"></div>
<div class="su-row"><input type="text" id="ivac-given-name" placeholder="Given Name (As in Passport)"></div>
<div class="su-row"><div class="su-pw"><input type="password" id="ivac-password" placeholder="Password"><button class="eye" id="ivac-password-toggle">👁</button></div></div>
<div class="su-half"><button class="b5" id="ivac-btn-submit-info">Account Registration</button><button class="b8" id="ivac-btn-signup-stop">Stop All</button></div>
<div class="su-msg" id="ivac-msg-submit"></div>
</div>
</div>
</div>

<div class="tp" id="pu">
<div class="sc">
<div class="tq-row" id="upq-row" title="Dedicated upload token pool (pre-solved, single-use)"> <span class="tq-label">📤 Upload</span> <span class="tq-slots" id="upq-slots"> <span class="tq-slot empty"></span> <span class="tq-slot empty"></span> <span class="tq-slot empty"></span> <span class="tq-slot empty"></span> </span> <span class="tq-info" id="upq-info">0/4 • idle</span></div>
<div class="fr"><button class="b3 bh" style="flex:1" id="ivac-btn-file-upload-checking">File Upload Checking</button><button class="b1 bh" style="flex:1" id="ivac-btn-appointment">Appointment</button></div>
<div class="fr"><input type="file" id="ivac-file-upload" accept=".pdf,application/pdf" style="flex:1;min-width:0"><button class="b10 bh" style="flex:1;min-width:0" id="ivac-btn-file-upload">Patient File</button></div>
<div class="fr"><input type="file" id="ivac-file-upload-2" accept=".pdf,application/pdf" style="flex:1;min-width:0"><button class="b10 bh" style="flex:1;min-width:0" id="ivac-btn-file-upload-2">Attendant 1</button></div>
<div class="fr"><input type="file" id="ivac-file-upload-3" accept=".pdf,application/pdf" style="flex:1;min-width:0"><button class="b10 bh" style="flex:1;min-width:0" id="ivac-btn-file-upload-3">Attendant 2</button></div>
<div class="fr"><input type="file" id="ivac-file-upload-4" accept=".pdf,application/pdf" style="flex:1;min-width:0"><button class="b10 bh" style="flex:1;min-width:0" id="ivac-btn-file-upload-4">Attendant 3</button></div>
<div class="fr" style="margin-bottom:1px;gap:3px"><select id="ivac-appointment-mission" style="flex:1;min-width:0"><option value="dhaka">Dhaka (JFP)</option><option value="chittagong">Chittagong</option><option value="khulna">Khulna</option><option value="rajshahi">Rajshahi</option><option value="sylhet">Sylhet</option></select><button class="bh" style="flex:none;padding:4px 6px!important;background:linear-gradient(135deg,#10b981,#059669);border:1px solid #34d399;color:#fff" id="ivac-btn-appointment-booking">Confirm Mission & Center</button></div>
<div class="fr" style="margin-bottom:1px"><button class="bh" style="width:100%;padding:4px 6px!important;background:linear-gradient(135deg,#06b6d4,#0891b2);border:1px solid #22d3ee;color:#fff" id="ivac-btn-file-checking">File Checking</button></div>
<div class="fr" style="margin-bottom:1px;gap:3px"><input type="text" id="ivac-file-delete-number" placeholder="WebFile" autocomplete="off" style="flex:1;min-width:0"><button class="bh" style="flex:1;padding:4px 6px!important;background:linear-gradient(135deg,#ef4444,#b91c1c);border:1px solid #f87171;color:#fff" id="ivac-btn-file-delete">Delete file</button></div>
<div class="fr" style="margin-bottom:1px;gap:3px"><input type="text" id="ivac-invoice-trxid" placeholder="Give your trxId" autocomplete="off" style="flex:1;min-width:0"><button class="bh" style="flex:0.25;padding:4px 6px!important;background:linear-gradient(135deg,#f59e0b,#d97706);border:1px solid #fbbf24;color:#fff" id="ivac-btn-invoice-download">Submit</button></div>
<div class="fr" style="margin-bottom:1px"><button class="bh" style="width:100%;padding:4px 6px!important;background:linear-gradient(135deg,#8b5cf6,#6d28d9);border:1px solid #a78bfa;color:#fff" id="ivac-btn-number-password" title="Fill phone+password from selected profile">Number Password</button></div>
<div class="fr" style="margin-bottom:1px;gap:3px"><button class="bh" style="flex:0.80;padding:4px 6px!important;background:linear-gradient(135deg,#f97316,#ea580c);border:1px solid #fb923c;color:#fff" id="ivac-dom-signin-btn">Signin</button><input type="number" id="ivac-dom-signin-sec" min="0.1" max="60" step="0.1" value="20" style="min-width:0px;flex:0.30;text-align:center;padding:3px 2px" title="Signin retry interval (sec)"></div>
<div class="fr" style="margin-bottom:1px;gap:3px"><button class="bh" style="flex:1;padding:4px 6px!important;background:linear-gradient(135deg,#ec4899,#be185d);border:1px solid #f472b6;color:#fff" id="ivac-dom-get-signin-otp-btn">Get Signin OTP</button><button class="bh" style="flex:1;padding:4px 6px!important;background:linear-gradient(135deg,#14b8a6,#0d9488);border:1px solid #2dd4bf;color:#fff" id="ivac-dom-verify-otp-btn">Verify</button></div>
<div class="fr" style="margin-bottom:1px;gap:3px"><button class="bh" style="flex:0.80;padding:4px 6px!important;background:linear-gradient(135deg,#3b82f6,#1d4ed8);border:1px solid #60a5fa;color:#fff" id="ivac-dom-reserve-btn">Reserveslot</button><input type="number" id="ivac-dom-retry-sec" min="0.1" max="60" step="0.1" value="22" style="min-width:0px;flex:0.30;text-align:center;padding:3px 2px" title="Reserve retry interval (sec)"></div>
</div>
</div>

<div class="tp" id="pf">
<div class="sc"> <textarea id="ivac-fetch-input" rows="3" placeholder='{"url":"...", "method":"POST", "headers":{}, "body":null}'></textarea>
<div class="fr" style="gap:4px"><button class="b5 bh" style="flex:1" id="ivac-btn-fetch-send">▶ Start</button><input type="number" id="ivac-fetch-delay" min="0" value="1000" style="width:56px;flex:none;text-align:center" title="Repeat delay between calls (ms)"><span style="color:#8888aa;font-size:.72rem;align-self:center;flex:none;font-weight:700">ms</span><label style="flex:none;display:flex;align-items:center;gap:3px;font-size:.6rem;color:#8888aa;font-weight:700" title="ON = GM (CORS-immune, hidden from DevTools). OFF = native fetch (shows in DevTools Fetch/XHR, but CORS-limited).">GM<div class="tg" id="ivac-fetch-gm-toggle" style="flex:none"><div class="tg-dot"></div></div></label></div>
<div class="fr"><label style="flex:none; min-width:85px">SMS OTP app</label><select style="flex:1;min-width:0" id="ivac-otp-sms-source-select"><option value="lurkbd">LurkBD OTP APP</option><option value="sptootp">Buyer OTP APP</option></select></div>
<div class="fr"><label style="flex:none; min-width:85px">Captcha Provider</label><select style="flex:1;min-width:0" id="ivac-captcha-provider-select"><option value="capmonster">CapMonster</option><option value="capsolver">CapSolver</option><option value="2captcha">2Captcha</option><option value="yescaptcha">YesCaptcha</option></select></div>
<div class="fr" style="flex-wrap: nowrap;"><input type="text" id="ivac-captcha-api-input" placeholder="API key" autocomplete="off"><button class="b5 bh" style="flex:none" id="ivac-btn-captcha-save">Save</button><button class="b2 bh" style="flex:none" id="ivac-btn-captcha-reset">Reset</button></div>
<div class="fr" style="gap:4px; margin-top:2px; margin-bottom:2px"><label style="flex:none; min-width:85px; font-size:.64rem; color:#666690; font-weight:700">Network Status</label><div class="tg" id="ivac-network-status-toggle"><div class="tg-dot"></div></div><label style="flex:none; font-size:.64rem; color:#666690; font-weight:700">Proxy</label><div class="tg" id="ivac-parallel-proxy-rotation-toggle" title="Parallel proxy rotation"><div class="tg-dot"></div></div><input type="text" id="ivac-parallel-proxy-start" style="width:30px; flex:none; text-align:center" placeholder="#" maxlength="4" autocomplete="off" title="Start proxy #"><span style="color:#666690; font-size:.72rem">–</span><input type="text" id="ivac-parallel-proxy-end" style="width:30px; flex:none; text-align:center" placeholder="#" maxlength="4" autocomplete="off" title="End proxy #"></div>
<div id="ivac-parallel-options-wrap" style="background:linear-gradient(135deg,#070716,#0a0a1f); border:1px dashed rgba(124,58,237,.3); border-radius:7px; padding:6px; margin-top:5px">
<div class="pl-row"><span style="width:65px; flex:none">Advance</span><input type="number" id="ivac-parallel-advance-hits" min="1" placeholder="10" value="5"><span>hits</span><input type="number" id="ivac-parallel-advance-ms" min="0" placeholder="1000" value="1000"><span>ms</span></div>
<div class="pl-row"><span style="width:65px; flex:none">Signin</span><input type="number" id="ivac-parallel-signin-hits" min="1" placeholder="10" value="5"><span>hits</span><input type="number" id="ivac-parallel-signin-ms" min="0" placeholder="1000" value="1000"><span>ms</span></div>
<div class="pl-row"><span style="width:65px; flex:none">Verify</span><input type="number" id="ivac-parallel-loginotp-hits" min="1" placeholder="10" value="5"><span>hits</span><input type="number" id="ivac-parallel-loginotp-ms" min="0" placeholder="1000" value="1000"><span>ms</span></div>
<div class="pl-row"><span style="width:65px; flex:none">Book</span><input type="number" id="ivac-parallel-book-hits" min="1" placeholder="10" value="5"><span>hits</span><input type="number" id="ivac-parallel-book-ms" min="0" placeholder="1000" value="1000"><span>ms</span></div>
<div class="pl-row"><span style="width:65px; flex:none">Reserve Slot</span><input type="number" id="ivac-parallel-reserveslot-hits" min="1" placeholder="10" value="5"><span>hits</span><input type="number" id="ivac-parallel-reserveslot-ms" min="0" placeholder="1000" value="1000"><span>ms</span></div>
<div class="pl-row"><span style="width:65px; flex:none">Initiate</span><input type="number" id="ivac-parallel-initiate-hits" min="1" placeholder="5" value="5"><span>hits</span><input type="number" id="ivac-parallel-initiate-ms" min="0" placeholder="1000" value="1000"><span>ms</span></div>
</div>
</div>
</div>

<div class="tp" id="px">
<div class="sc">
<div class="fr"><span id="ivac-proxy-status-line" style="font-size:.7rem;color:#94a3b8;font-weight:700">Extension proxy: system</span></div>
<div class="fr"><select id="ivac-proxy-scheme" style="min-width:5rem; flex:none"><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option><option value="socks4">SOCKS4</option></select><input type="text" id="ivac-proxy-host" placeholder="Host (127.0.0.1)" autocomplete="off"><input type="number" id="ivac-proxy-port" placeholder="Port" min="1" max="65535" style="width:5rem; flex:none"></div>
<div class="fr"><input type="text" id="ivac-proxy-user" placeholder="User (opt)" autocomplete="off"><input type="password" id="ivac-proxy-password" placeholder="Pass (opt)" autocomplete="off"></div>
<div class="fr"><button class="b1 bh" id="ivac-proxy-btn-add">Add</button><select style="flex:1;min-width:0" id="ivac-proxy-picker"><option value="">-- Saved proxies --</option></select><button class="b9 bh" id="ivac-proxy-btn-remove">Remove</button></div>
<div class="fr"><button class="b5 bh" style="flex:1" id="ivac-proxy-btn-connect">Connect</button><button class="b2 bh" style="flex:1" id="ivac-proxy-btn-disconnect">Disconnect</button></div>
<div class="fr"><textarea id="ivac-proxy-import-export" rows="2" placeholder="host:port or host:port:user:pass"></textarea></div>
<div class="fr"><input type="file" id="ivac-proxy-file-input" accept=".json,application/json" style="display:none"><button class="b10 bh" style="flex:1" id="ivac-proxy-btn-import-file">Import</button><button class="b1 bh" style="flex:1" id="ivac-proxy-btn-merge-box">Merge</button><button class="b11 bh" style="flex:1" id="ivac-proxy-btn-export">Export</button></div>
<div class="proxy-msg" id="ivac-msg-proxy"></div>
</div>
</div>

<div class="tp" id="pe">
<div class="sc">
<div class="enc-section">
<div class="enc-title">🔐 SignIn Encryption Config</div>
<div class="enc-cfg-row"><label>Key (Secret)</label><input type="text" id="enc-signin-key" placeholder="Secret key"></div>
<div class="enc-cfg-row"><label>Skip (startAt)</label><input type="number" id="enc-signin-skip" min="0"></div>
<div class="enc-cfg-row"><label>Length</label><input type="number" id="enc-signin-length" min="1"></div>
<div class="enc-cfg-row"><label>Version</label> <select id="enc-signin-version"> <option value="1">v1 — block_mix</option> <option value="2">v2 — bitmix</option> <option value="3">v3 — cellular_shift</option> <option value="4">v4 — rc4_shift</option> <option value="5">v5 — lfsr_shift</option> <option value="6">v6 — polynomial</option> <option value="7">v7 — subst_reverse</option> <option value="8">v8 — prng</option> <option value="9">v9 — mod_square</option> <option value="10">v10 — logistic_shift</option> </select>
</div>

<div class="enc-cfg-actions"><button class="b5 bh" id="enc-signin-save">💾 Save</button><button class="b2 bh" id="enc-signin-activate">⚡ Activate</button><span class="enc-status" id="enc-signin-status">Inactive</span></div>
</div>

<div class="enc-section" style="margin-top:8px">
<div class="enc-title">🎯 Reserve Encryption Config</div>
<div class="enc-cfg-row"><label>Key (Secret)</label><input type="text" id="enc-reserve-key" placeholder="Secret key"></div>
<div class="enc-cfg-row"><label>Skip (startAt)</label><input type="number" id="enc-reserve-skip" min="0"></div>
<div class="enc-cfg-row"><label>Length</label><input type="number" id="enc-reserve-length" min="1"></div>
<div class="enc-cfg-row"><label>Version</label> <select id="enc-reserve-version"> <option value="1">v1 — block_mix</option> <option value="2">v2 — bitmix</option> <option value="3">v3 — cellular_shift</option> <option value="4">v4 — rc4_shift</option> <option value="5">v5 — lfsr_shift</option> <option value="6">v6 — polynomial</option> <option value="7">v7 — subst_reverse</option> <option value="8">v8 — prng</option> <option value="9">v9 — mod_square</option> <option value="10">v10 — logistic_shift</option> </select>
</div>

<div class="enc-cfg-actions"><button class="b5 bh" id="enc-reserve-save">💾 Save</button><button class="b2 bh" id="enc-reserve-activate">⚡ Activate</button><span class="enc-status" id="enc-reserve-status">Inactive</span></div>
</div>

<div class="enc-section" style="margin-top:8px">
<div class="enc-title">💳 Initiate Encryption Config</div>
<div class="enc-cfg-row"><label>Key (Secret)</label><input type="text" id="enc-initiate-key" placeholder="Secret key"></div>
<div class="enc-cfg-row"><label>Skip (startAt)</label><input type="number" id="enc-initiate-skip" min="0"></div>
<div class="enc-cfg-row"><label>Length</label><input type="number" id="enc-initiate-length" min="1"></div>
<div class="enc-cfg-row"><label>Version</label> <select id="enc-initiate-version"> <option value="1">v1 — block_mix</option> <option value="2">v2 — bitmix</option> <option value="3">v3 — cellular_shift</option> <option value="4">v4 — rc4_shift</option> <option value="5">v5 — lfsr_shift</option> <option value="6">v6 — polynomial</option> <option value="7">v7 — subst_reverse</option> <option value="8">v8 — prng</option> <option value="9">v9 — mod_square</option> <option value="10">v10 — logistic_shift</option> </select>
</div>

<div class="enc-cfg-actions"><button class="b5 bh" id="enc-initiate-save">💾 Save</button><button class="b2 bh" id="enc-initiate-activate">⚡ Activate</button><span class="enc-status" id="enc-initiate-status">Inactive</span></div>
</div>

</div>
</div>
</div>

<div class="ft">
<div class="ft-top"><div class="fl"><button id="fn">N</button><button id="fc">C</button><button id="fp2">P</button><button id="fl2">L</button><button id="fr2">R</button></div> <div class="tg" id="signin-timeout-toggle" title="Signin Timeout: ON = 20s timeout, force retry" style="width:28px;height:16px;margin-left:6px;flex-shrink:0"><div class="tg-dot"></div></div></div>
<span>RJ SLOT PRO-H2</span>
</div>

<div class="cdbar" id="cdbar">
<div class="cd-cell cd-otp" id="cd-otp" style="display:none"><span class="cd-icon">📱</span><span class="cd-label">OTP</span><span class="cd-time" id="cd-otp-time">--:--</span></div>
<div class="cd-sep" id="cd-sep" style="display:none"></div>
<div class="cd-cell cd-token" id="cd-token" style="display:none"><span class="cd-icon">🔑</span><span class="cd-label">TOKEN</span><span class="cd-time" id="cd-token-time">--:--</span></div>
<div class="cd-empty" id="cd-empty">⏱ no active session</div>
</div>
</div>

<div id="profile-manager">
<div class="pm-header" id="pm-drag-handle"><span class="pm-title">📋 PROFILE MANAGER</span><button class="pm-close" id="pm-close-btn">&minus;</button></div>
<div class="pm-body">
<div class="pm-select-row"><select id="pm-profile-select"><option value="">Select Profile</option></select><button class="pm-btn-new" id="pm-new-btn">NEW</button><button class="pm-btn-del" id="pm-del-btn">DEL</button></div>
<div class="pm-section"><h4>PERSONAL INFO</h4>
<div class="pm-grid"><input type="text" id="pm-name" placeholder="Name"><input type="email" id="pm-email" placeholder="Email"></div>
<div class="pm-grid"><input type="tel" id="pm-phone1" placeholder="Phone 1"><input type="tel" id="pm-phone2" placeholder="Phone 2"></div>
<div class="pm-grid"><input type="password" id="pm-mobile-pass" placeholder="Mobile Pass"><input type="password" id="pm-email-pass" placeholder="Email Pass"></div>
<div class="pm-grid" style="grid-template-columns:1fr"><input type="text" id="pm-appointment-id" placeholder="Appointment ID" spellcheck="false" style="font-family:monospace;font-size:.7rem"></div>
</div>

<div class="pm-action-row"><button class="pm-btn-export" id="pm-export-btn">📤 EXPORT</button><button class="pm-btn-import" id="pm-import-btn">📥 IMPORT</button><button class="pm-btn-save" id="pm-save-btn">💾 SAVE</button></div>
</div>
</div>

<div id="rj-netlog">
<div class="netlog-header" id="netlog-drag"><span class="netlog-title">📡 NETWORK LOG</span><div class="netlog-tools"><button id="netlog-clear">Clear</button><button id="netlog-close">−</button></div></div>
<div class="netlog-steps" id="netlog-steps">
<div class="nl-step" data-step="advance">Adv</div>
<div class="nl-step" data-step="signin">Sign</div>
<div class="nl-step" data-step="verify">Verify</div>
<div class="nl-step" data-step="book">Book</div>
<div class="nl-step" data-step="reserve">Resrv</div>
<div class="nl-step" data-step="initiate">Initiate</div>
</div>

<div class="netlog-meta"> <span id="netlog-stats">0 entries • auto-clear in 3:00</span> <span id="netlog-filter-wrap"><select id="netlog-filter"><option value="">All</option><option value="signup">Sign Up</option><option value="signin">Signin</option><option value="verify">Verify</option><option value="reserve">Reserve</option><option value="book">Book</option><option value="initiate">Initiate</option><option value="captcha">Captcha</option><option value="sms">SMS</option><option value="slot">Slot Status</option><option value="upload">Upload</option><option value="invoice">Invoice</option><option value="advance">Advance</option><option value="network">Network</option></select></span>
</div>

<div class="netlog-body" id="netlog-body"></div>
</div> <input type="file" id="pm-import-file" accept=".json" style="display:none"> <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
`;
document.body.insertAdjacentHTML('beforeend', h2html);

encConfigInit();

// === Encryption Tab Event Listeners ===
document.getElementById('enc-signin-save')?.addEventListener('click', () => {
    encConfigReadFromUI('signin');
    encConfigSave('signin');
    logStatus('💾 Signin encryption config saved', 'g');
});
document.getElementById('enc-signin-activate')?.addEventListener('click', () => {
    encConfigReadFromUI('signin');
    const cfg = encConfig.signin;
    cfg.active = !cfg.active;
    encConfigSave('signin');
    encConfigApplyToUI('signin');
    logStatus(cfg.active ? `⚡ Signin encryption ACTIVATED (v${cfg.version})` : '🔓 Signin encryption deactivated', cfg.active ? 'g' : 'y');
});
document.getElementById('enc-reserve-save')?.addEventListener('click', () => {
    encConfigReadFromUI('reserve');
    encConfigSave('reserve');
    logStatus('💾 Reserve encryption config saved', 'g');
});
document.getElementById('enc-reserve-activate')?.addEventListener('click', () => {
    encConfigReadFromUI('reserve');
    const cfg = encConfig.reserve;
    cfg.active = !cfg.active;
    encConfigSave('reserve');
    encConfigApplyToUI('reserve');
    logStatus(cfg.active ? `⚡ Reserve encryption ACTIVATED (v${cfg.version})` : '🔓 Reserve encryption deactivated', cfg.active ? 'g' : 'y');
});
document.getElementById('enc-initiate-save')?.addEventListener('click', () => {
    encConfigReadFromUI('initiate');
    encConfigSave('initiate');
    logStatus('💾 Initiate encryption config saved', 'g');
});
document.getElementById('enc-initiate-activate')?.addEventListener('click', () => {
    encConfigReadFromUI('initiate');
    const cfg = encConfig.initiate;
    cfg.active = !cfg.active;
    encConfigSave('initiate');
    encConfigApplyToUI('initiate');
    logStatus(cfg.active ? `⚡ Initiate encryption ACTIVATED (v${cfg.version})` : '🔓 Initiate encryption deactivated', cfg.active ? 'g' : 'y');
});
// Per-endpoint token-mode checkboxes (signin/reserve = raw when checked; initiate = encrypt when checked)
(function initTokenModeChecks() {
    [['chk-signin-raw', 'rj_chk_signin_raw'], ['chk-reserve-raw', 'rj_chk_reserve_raw'], ['chk-initiate-enc', 'rj_chk_initiate_enc']].forEach(([id, key]) => {
        const el = document.getElementById(id); if (!el) return;
        try { el.checked = localStorage.getItem(key) === '1'; } catch(e) {}
        el.addEventListener('change', () => { try { localStorage.setItem(key, el.checked ? '1' : '0'); } catch(e) {} });
    });
})();
// === Bundle Reload Button Listeners ===
document.getElementById('enc-bundle-reload')?.addEventListener('click', () => {
    logStatus('🔄 Re-loading config from bundle…', 'y');
    encConfigAutoFetch(false);
});
document.getElementById('enc-bundle-force')?.addEventListener('click', () => {
    logStatus('💡 Force re-resolve (ignoring cache)…', 'y');
    encConfigAutoFetch(true);
});


// ==================== TAB SWITCHING ====================
const tmap = { l: 'pl', s: 'ps', u: 'pu', f: 'pf', e: 'pe', x: 'px' };
const lmap = { l: 'll', s: 'ls', u: 'lu', f: 'lf', e: 'le' };
document.querySelectorAll('#p .t').forEach(t => {
    t.addEventListener('click', () => {
        const k = t.dataset.t;
        document.querySelectorAll('#p .t').forEach(x => x.classList.remove('a'));
        t.classList.add('a');
        document.querySelectorAll('#p .tp').forEach(x => x.classList.remove('a'));
        if (tmap[k]) document.getElementById(tmap[k])?.classList.add('a');
        document.querySelectorAll('#p .sl>div').forEach(x => x.classList.remove('a'));
        document.getElementById(lmap[k] || 'll')?.classList.add('a');
    });
});

// ==================== CLOCK ====================
function tick() {
    const o = { timeZone: 'Asia/Dhaka', hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' };
    const d = { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' };
    const te = document.getElementById('tk'), de = document.getElementById('dk');
    if (te) te.innerText = new Intl.DateTimeFormat('en-US', o).format(new Date());
    if (de) de.innerText = new Intl.DateTimeFormat('en-US', d).format(new Date());
}
tick(); setInterval(tick, 1000);

    // ==================== DRAGGING ====================
    function makeDraggable(dragHandle, targetElement) {
        let isDragging = false, startX, startY, initialLeft, initialTop, pointerId = null;
        dragHandle.style.touchAction = 'none';
        dragHandle.addEventListener('pointerdown', function(e) {
            if (e.button !== undefined && e.button !== 0) return; // left button only
            if (e.target.closest('button') || e.target.closest('select') || e.target.closest('input')) return;
            isDragging = true; pointerId = e.pointerId;
            const rect = targetElement.getBoundingClientRect();
            initialLeft = rect.left; initialTop = rect.top;
            startX = e.clientX; startY = e.clientY;
            targetElement.style.left = initialLeft + 'px';
            targetElement.style.top = initialTop + 'px';
            targetElement.style.right = 'auto';
            targetElement.style.bottom = 'auto';
            targetElement.style.transform = 'none';
            targetElement.style.transition = 'none';
            // capture so we keep getting moves even over iframes (captcha) / fast drags
            try { dragHandle.setPointerCapture(e.pointerId); } catch(err) {}
            e.preventDefault();
        });
        dragHandle.addEventListener('pointermove', function(e) {
            if (!isDragging || e.pointerId !== pointerId) return;
            targetElement.style.left = (initialLeft + e.clientX - startX) + 'px';
            targetElement.style.top = (initialTop + e.clientY - startY) + 'px';
            e.preventDefault();
        });
        const endDrag = function(e) {
            if (!isDragging) return;
            if (e && e.pointerId !== undefined && e.pointerId !== pointerId) return;
            isDragging = false; pointerId = null;
            targetElement.style.transition = '';
            try { if (e && e.pointerId !== undefined) dragHandle.releasePointerCapture(e.pointerId); } catch(err) {}
        };
        dragHandle.addEventListener('pointerup', endDrag);
        dragHandle.addEventListener('pointercancel', endDrag);
    }

    const panel = document.getElementById('p');
    const panelHeader = document.getElementById('dh');
    if (panelHeader && panel) makeDraggable(panelHeader, panel);
    const pmPanel = document.getElementById('profile-manager');
    const pmHeader = document.getElementById('pm-drag-handle');
    if (pmHeader && pmPanel) makeDraggable(pmHeader, pmPanel);

// ==================== MINIMIZE & FAB ====================
const fab = document.getElementById('p-fab');
const mb = document.getElementById('mb');
function minimizePanel() { if(panel) panel.classList.add('hidden'); if(fab) fab.classList.remove('hidden'); }
function maximizePanel() { if(panel) panel.classList.remove('hidden'); if(fab) fab.classList.add('hidden'); }
if(mb) mb.addEventListener('click', minimizePanel);
if(fab) fab.addEventListener('click', maximizePanel);

// ==================== PASSWORD EYE ====================
document.querySelectorAll('#p .pw .eye').forEach(btn => {
    btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const inp = this.parentElement.querySelector('input');
        if (inp) {
            inp.type = inp.type === 'password' ? 'text' : 'password';
            this.innerHTML = inp.type === 'password' ? '&#128065;' : '&#128526;';
        }
    });
});

// ==================== TOGGLE SWITCHES ====================
document.querySelectorAll('#p .tg').forEach(el => {
    el.addEventListener('click', () => el.classList.toggle('on'));
});

// Default ON: popup-toggle
document.getElementById('popup-toggle')?.classList.add('on');

// Date-target toggle (ON = Latest / last date, OFF = Earliest / first date) — default Latest, persisted
(function initDateTargetToggle() {
    const el = document.getElementById('date-target-toggle'); if (!el) return;
    try { const saved = localStorage.getItem('rj_date_target'); if (saved === 'earliest') el.classList.remove('on'); else el.classList.add('on'); } catch(e) {}
    el.addEventListener('click', () => { setTimeout(() => { try { localStorage.setItem('rj_date_target', el.classList.contains('on') ? 'latest' : 'earliest'); } catch(e) {} logStatus(el.classList.contains('on') ? '📆 Date target: Latest (last)' : '📆 Date target: Earliest (first)', 'g'); }, 20); });
})();

// ==================== ADVANCE-TOGGLE SPECIAL ====================
document.getElementById('advance-toggle')?.addEventListener('click', () => {
    setTimeout(() => {
        if (typeof applyAdvanceModeToLoginField === 'function') {
            applyAdvanceModeToLoginField();
            const advanceOn = !!document.getElementById('advance-toggle')?.classList.contains('on');
            logStatus(advanceOn
                ? '🔑 Advance mode ON — login field switched to Email (Forgot mode)'
                : '🔑 Advance mode OFF — login field switched to Phone (Signin mode)',
                advanceOn ? 'g' : 'y');
        }
    }, 0);
});

// ==================== CAPTCHA MODE BUTTONS ====================
const csi = document.getElementById('csi'), csr = document.getElementById('csr');
csi?.addEventListener('click', () => { csi.classList.add('a'); csr?.classList.remove('a'); cfMode = 'signin'; resetCaptcha(); });
csr?.addEventListener('click', () => { csr.classList.add('a'); csi?.classList.remove('a'); cfMode = 'reserve'; resetCaptcha(); });

document.getElementById('captcha-toggle')?.addEventListener('click', () => {
    setTimeout(() => {
        const useApi = document.getElementById('captcha-toggle')?.classList.contains('on');
        if (useApi) hideManualCaptcha();
    }, 60);
});

// ==================== SINGLE / AUTO TOGGLE ====================
document.querySelectorAll('#p .toggle-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        if (this.classList.contains('b8')) { this.classList.remove('b8'); this.classList.add('b5'); }
        else { this.classList.remove('b5'); this.classList.add('b8'); }
    });
});

// ==================== PROFILE MANAGER ====================
const PM_STORAGE_KEY = 'rj_slot_profiles_v4';
const EMPTY_PROFILE = { name: "", email: "", phone1: "", phone2: "", mobilePass: "", emailPass: "", appointmentId: "" };

let profiles = {};
let activeProfileName = "Default";
try {
    const saved = JSON.parse(localStorage.getItem(PM_STORAGE_KEY));
    if (saved && typeof saved === 'object' && Object.keys(saved).length > 0) { profiles = saved; }
} catch(e) {}
if (!Object.keys(profiles).length) { profiles = { "Default": { ...EMPTY_PROFILE } }; }
activeProfileName = Object.keys(profiles)[0];

const pmSelectMain  = document.getElementById('main-profile-select');
const pmSelect      = document.getElementById('pm-profile-select');
const pmName        = document.getElementById('pm-name');
const pmEmail       = document.getElementById('pm-email');
const pmPhone1      = document.getElementById('pm-phone1');
const pmPhone2      = document.getElementById('pm-phone2');
const pmMobilePass  = document.getElementById('pm-mobile-pass');
const pmEmailPass   = document.getElementById('pm-email-pass');
const pmAppointmentId = document.getElementById('pm-appointment-id');
const loginPhoneInp = document.getElementById('login-phone');
const loginPwInp    = document.getElementById('login-password');

function persistProfiles() { try { localStorage.setItem(PM_STORAGE_KEY, JSON.stringify(profiles)); } catch(e) {} }

function refreshProfileSelects() {
    if (pmSelect) {
        pmSelect.innerHTML = '';
        Object.keys(profiles).forEach(n => {
            const o = document.createElement('option');
            o.value = n; o.textContent = n;
            if (n === activeProfileName) o.selected = true;
            pmSelect.appendChild(o);
        });
    }
    if (pmSelectMain) {
        pmSelectMain.innerHTML = '<option value="">-- Select Profile --</option>';
        Object.keys(profiles).forEach(n => {
            const o = document.createElement('option');
            o.value = n; o.textContent = n;
            if (n === activeProfileName) o.selected = true;
            pmSelectMain.appendChild(o);
        });
    }
    try { if (typeof window.__rjRefreshManualProfileSelect === 'function') window.__rjRefreshManualProfileSelect(); } catch(e) {}
}

function applyAdvanceModeToLoginField() {
    if (!loginPhoneInp) return;
    const p = profiles[activeProfileName] || { ...EMPTY_PROFILE };
    const advTg = document.getElementById('advance-toggle');
    const advanceOn = !!advTg?.classList.contains('on');
    if (advanceOn) {
        loginPhoneInp.type        = 'email';
        loginPhoneInp.placeholder = 'Email';
        loginPhoneInp.value       = p.email || '';
        loginPhoneInp.title       = 'Email (Forgot Password mode)';
    } else {
        loginPhoneInp.type        = 'tel';
        loginPhoneInp.placeholder = 'Phone 1';
        loginPhoneInp.value       = p.phone1 || '';
        loginPhoneInp.title       = 'Phone (Signin mode)';
    }
}

function loadProfileToForm(name) {
    activeProfileName = name;
    const p = profiles[name] || { ...EMPTY_PROFILE };
    if (pmName)            pmName.value            = p.name          || '';
    if (pmEmail)           pmEmail.value           = p.email         || '';
    if (pmPhone1)          pmPhone1.value          = p.phone1        || '';
    if (pmPhone2)          pmPhone2.value          = p.phone2        || '';
    if (pmMobilePass)      pmMobilePass.value      = p.mobilePass    || '';
    if (pmEmailPass)       pmEmailPass.value       = p.emailPass     || '';
    if (pmAppointmentId)   pmAppointmentId.value   = p.appointmentId || '';
    applyAdvanceModeToLoginField();
    if (loginPwInp)    loginPwInp.value    = p.mobilePass || '';

    try {
        const suMobile    = document.getElementById('ivac-mobile');
        const suEmail     = document.getElementById('ivac-email');
        const suSurname   = document.getElementById('ivac-surname');
        const suGivenName = document.getElementById('ivac-given-name');
        const suPassword  = document.getElementById('ivac-password');
        if (suMobile)    suMobile.value    = p.phone1 || '';
        if (suEmail)     suEmail.value     = p.email  || '';
        if (p.name) {
            const nameParts = p.name.split(' ');
            if (suSurname)   suSurname.value   = nameParts.length > 1 ? nameParts.slice(-1)[0] : p.name;
            if (suGivenName) suGivenName.value = nameParts.length > 1 ? nameParts.slice(0,-1).join(' ') : '';
        } else {
            if (suSurname)   suSurname.value = '';
            if (suGivenName) suGivenName.value = '';
        }
        if (suPassword)  suPassword.value  = p.mobilePass || '';
    } catch(e) {}
    try { if (typeof window.__rjSyncManualProfileSelect === 'function') window.__rjSyncManualProfileSelect(name); } catch(e) {}
}

function saveFormToProfile() {
    profiles[activeProfileName] = {
        name:          pmName?.value || '',
        email:         pmEmail?.value || '',
        phone1:        pmPhone1?.value || '',
        phone2:        pmPhone2?.value || '',
        mobilePass:    pmMobilePass?.value || '',
        emailPass:     pmEmailPass?.value || '',
        appointmentId: (pmAppointmentId?.value || '').trim().replace(/^["']|["']$/g, '')
    };
    persistProfiles();
}

refreshProfileSelects();
loadProfileToForm(activeProfileName);

document.getElementById('fp2')?.addEventListener('click', () => { document.getElementById('profile-manager')?.classList.toggle('open'); });
document.getElementById('pm-close-btn')?.addEventListener('click', () => {
    const btn = document.getElementById('pm-save-btn');
    const hasUnsaved = btn?.textContent?.includes('*');
    if (hasUnsaved) {
        const choice = confirm(`Unsaved changes in profile "${activeProfileName}".\n\n• OK = Save and close\n• Cancel = Discard changes`);
        if (choice) { saveFormToProfile(); markPmFormSaved(); logStatus(`✓ Saved: ${activeProfileName}`, 'g'); }
        else { loadProfileToForm(activeProfileName); markPmFormSaved(); logStatus(`↺ Discarded unsaved changes`, 'y'); }
    }
    document.getElementById('profile-manager')?.classList.remove('open');
});

pmSelect?.addEventListener('change', e => {
    if (!e.target.value) return;
    saveFormToProfile(); loadProfileToForm(e.target.value); refreshProfileSelects();
    logStatus(`✓ Profile loaded: ${e.target.value}`, 'g');
});
pmSelectMain?.addEventListener('change', e => {
    if (!e.target.value) return;
    saveFormToProfile(); loadProfileToForm(e.target.value); refreshProfileSelects();
    logStatus(`✓ Profile: ${e.target.value}`, 'g');
});

document.getElementById('pm-new-btn')?.addEventListener('click', () => {
    const name = prompt('Enter new profile name:');
    if (!name) return;
    if (profiles[name]) { alert('Profile already exists!'); return; }
    profiles[name] = { ...EMPTY_PROFILE };
    activeProfileName = name; persistProfiles(); refreshProfileSelects(); loadProfileToForm(name);
    logStatus(`✓ Profile created: ${name}`, 'g');
});
document.getElementById('pm-del-btn')?.addEventListener('click', () => {
    const names = Object.keys(profiles);
    if (names.length <= 1) { alert('Cannot delete the last profile.'); return; }
    if (!confirm(`Delete profile "${activeProfileName}"?`)) return;
    delete profiles[activeProfileName];
    activeProfileName = Object.keys(profiles)[0]; persistProfiles(); refreshProfileSelects(); loadProfileToForm(activeProfileName);
    logStatus(`⚠ Profile deleted`, 'y');
});
document.getElementById('pm-save-btn')?.addEventListener('click', () => {
    saveFormToProfile(); loadProfileToForm(activeProfileName);
    logStatus(`✓ Saved: ${activeProfileName}`, 'g'); markPmFormSaved();
});

function markPmFormDirty() {
    const btn = document.getElementById('pm-save-btn'); if (!btn) return;
    btn.style.boxShadow = '0 0 0 2px rgba(74,222,128,.7)'; btn.style.transition = 'box-shadow .3s';
    if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
    btn.textContent = '💾 SAVE *';
}
function markPmFormSaved() {
    const btn = document.getElementById('pm-save-btn'); if (!btn) return;
    btn.style.boxShadow = '';
    if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
}
[pmName, pmEmail, pmPhone1, pmPhone2, pmMobilePass, pmEmailPass, pmAppointmentId].forEach(inp => { inp?.addEventListener('input', markPmFormDirty); });

document.getElementById('pm-export-btn')?.addEventListener('click', () => {
    saveFormToProfile();
    const blob = new Blob([JSON.stringify(profiles, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `rj-profiles-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
    logStatus('✓ Profiles exported', 'g');
});
const pmImportInput = document.getElementById('pm-import-file');
document.getElementById('pm-import-btn')?.addEventListener('click', () => pmImportInput?.click());
pmImportInput?.addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = ev => {
        try {
            const imported = JSON.parse(ev.target.result);
            profiles = { ...profiles, ...imported }; persistProfiles(); refreshProfileSelects();
            logStatus(`✓ Imported ${Object.keys(imported).length} profile(s)`, 'g');
        } catch (err) { logStatus(`❌ Invalid JSON file`, 'r'); }
    };
    r.readAsText(file); e.target.value = '';
});

document.getElementById('fn')?.addEventListener('click', () => { document.getElementById('pm-new-btn')?.click(); });
document.getElementById('fc')?.addEventListener('click', () => {
    if (!confirm('Clear login fields and saved session (incl. persistent storage)?')) return;
    if (loginPhoneInp) loginPhoneInp.value = '';
    if (loginPwInp)    loginPwInp.value    = '';
    const otpInp = document.getElementById('login-otp'); if (otpInp) otpInp.value = '';
    raceCoord.resetAll(); clearAllSession();
    try { stopOtpTimer('signinOtp'); stopOtpTimer('advanceOtp'); } catch(e) {}
    try { if (timers.token.intervalId) clearInterval(timers.token.intervalId); timers.token.intervalId = null; timers.token.expiresAt = null; timers.token.beeped = false; if (typeof refreshTokenCdUI === 'function') refreshTokenCdUI(); } catch(e) {}
    logStatus('🧹 Cleared all fields and session (all storage layers)', 'y');
});
document.getElementById('fl2')?.addEventListener('click', () => { document.getElementById('profile-manager')?.classList.add('open'); logStatus('📋 Profile Manager opened', 'g'); });
document.getElementById('fr2')?.addEventListener('click', () => { try { resetCaptcha(); logStatus('↻ Captcha reset', 'y'); } catch(e) {} });

// "A" button: delete appointment ID from active profile + clear session state
document.getElementById('pl-del-appt')?.addEventListener('click', () => {
    try {
        if (profiles[activeProfileName]) { profiles[activeProfileName].appointmentId = ''; persistProfiles(); }
        if (pmAppointmentId) pmAppointmentId.value = '';
        sessionState.appointmentId = null; sessionState.bookedAt = null; persistSession();
        logStatus(`🗑 Appointment ID deleted from profile "${activeProfileName}"`, 'y');
    } catch(e) {}
});

// E_encrpt button: fully clear encryption config.
// A half-cleared previous config keeps signin auto-retrying (dangerous) — this wipes
// the live config, localStorage, and the Encrypt-tab input fields so nothing lingers.
document.getElementById('enc-clear-btn')?.addEventListener('click', () => {
    try { stopFlag.value = true; } catch (e) {}          // halt any running/retrying pipeline
    try { if (typeof stopAutoEncScan === 'function') stopAutoEncScan(true); } catch (e) {}  // stop A_E auto-scan
    encConfig.signin  = {};
    encConfig.reserve = {};
    try {
        localStorage.removeItem(ENC_SIGNIN_KEY);
        localStorage.removeItem(ENC_RESERVE_KEY);
        localStorage.removeItem(ENC_BUNDLE_HASH_KEY);
    } catch (e) {}
    // clear the Encrypt-tab input fields for both purposes
    for (const p of ['signin', 'reserve']) {
        const keyInp = document.getElementById(`enc-${p}-key`);
        const skipInp = document.getElementById(`enc-${p}-skip`);
        const lenInp = document.getElementById(`enc-${p}-length`);
        const verSel = document.getElementById(`enc-${p}-version`);
        const statusEl = document.getElementById(`enc-${p}-status`);
        if (keyInp) keyInp.value = '';
        if (skipInp) skipInp.value = '';
        if (lenInp) lenInp.value = '';
        if (verSel) verSel.value = '';
        if (statusEl) { statusEl.textContent = 'Inactive'; statusEl.style.color = '#8888aa'; }
    }
    logStatus('🧹 Encryption config cleared — signin auto-retry stopped', 'g');
});

// SCAN button: manually resolve encryption config from the live bundle.
// On a successful fresh resolve that activates signin, auto-fire the signin pipeline
// (Task 3 — auto-signin ONLY after a manual scan, never from background polling).
// Shared: run ONE bundle scan; if it activates the signin config, auto-start Signin.
// Returns true when signin config became active (so callers like A_E can stop looping).
async function scanAndMaybeAutoSignin(reason) {
    localStorage.removeItem(ENC_BUNDLE_HASH_KEY);
    if (reason) logStatus(reason, 'y');
    const res = await encConfigAutoFetch(true);
    const signinReady = !!(res && res.signin && encConfig.signin && encConfig.signin.active && encConfig.signin.key);
    if (!signinReady) return false;
    // config is active — decide whether to fire signin
    if (typeof isSessionValid === 'function' && isSessionValid()) {
        logStatus('🔓 Already logged in — auto-signin skipped', 'y');
        return true;
    }
    if (typeof pipelineRunning !== 'undefined' && pipelineRunning) {
        logStatus('⚠ Pipeline already running — auto-signin skipped', 'y');
        return true;
    }
    try { stopFlag.value = false; } catch (e) {}
    logStatus('✅ Config active → Auto-start Signin…', 'g');
    startPipelineFrom('signin');
    return true;
}

document.getElementById('scan-btn')?.addEventListener('click', async () => {
    const ok = await scanAndMaybeAutoSignin('🔍 Manual scan — resolving encryption secret from live bundle…');
    if (!ok) logStatus('⚠ Scan finished but signin config not active — auto-signin skipped', 'y');
});

// A_E: auto-scan every 2s (same work as manual SCAN). As soon as encryption config
// is found/activated, it turns itself OFF and auto-starts Signin. Click again to cancel.
const autoEncScan = { timerId: null, busy: false };
function stopAutoEncScan(silent) {
    if (autoEncScan.timerId) { clearInterval(autoEncScan.timerId); autoEncScan.timerId = null; }
    autoEncScan.busy = false;
    const btn = document.getElementById('auto-enc-btn');
    if (btn) { btn.classList.remove('scanning'); btn.textContent = 'A_E'; }
    if (!silent) logStatus('⏹ Auto-scan (A_E) stopped', 'y');
}
async function autoEncScanTick() {
    if (autoEncScan.busy) return;            // don't overlap scans
    autoEncScan.busy = true;
    try {
        const ok = await scanAndMaybeAutoSignin('🔁 A_E auto-scan — checking bundle for encryption config…');
        if (ok) { stopAutoEncScan(true); logStatus('✅ A_E: config found → auto-scan OFF, Signin started', 'g'); }
    } catch (e) { console.error('[A_E] scan error:', e); }
    finally { autoEncScan.busy = false; }
}
document.getElementById('auto-enc-btn')?.addEventListener('click', () => {
    if (autoEncScan.timerId) { stopAutoEncScan(false); return; }   // toggle OFF
    const btn = document.getElementById('auto-enc-btn');
    if (btn) { btn.classList.add('scanning'); btn.textContent = '⏳'; }
    logStatus('🔁 A_E auto-scan ON — checking every 2s until encryption config is found…', 'g');
    autoEncScanTick();                                             // fire immediately
    autoEncScan.timerId = setInterval(autoEncScanTick, 2000);      // then every 2s
});

// ==================== COUNTDOWN MANAGER ====================
const TIMER_OTP_MS   = 5 * 60  * 1000;
const TIMER_TOKEN_MS = 15  * 60  * 1000;
const WARN_THRESHOLD_MS = 30  * 1000;

const timers = {
    signinOtp:  { expiresAt: null, btnId: 'bsi',        intervalId: null, beeped: false },
    advanceOtp: { expiresAt: null, btnId: 'badv-phone', intervalId: null, beeped: false },
    token:      { expiresAt: null, btnId: null,         intervalId: null, beeped: false }
};

function fmtRemaining(ms) {
    if (ms <= 0) return '00:00';
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function beepSoft() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = 880; gain.gain.value = 0.08;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
        setTimeout(() => { osc.stop(); ctx.close(); }, 400);
    } catch(e) {}
}

// LOUD beeps: master gain multiplier + a short attack so it's punchy, not faint.
const BEEP_GAIN = 6.0;   // scale up the old faint volumes; ~0.10 → ~0.6 (capped near max)
function playBeep(freq, durationMs, volume) {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const vol = Math.min(0.95, (volume || 0.08) * BEEP_GAIN);
        osc.type = 'triangle'; osc.frequency.value = freq;            // triangle = brighter/louder than sine
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + 0.01);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (durationMs / 1000));
        setTimeout(() => { try { osc.stop(); ctx.close(); } catch(e) {} }, durationMs + 50);
    } catch(e) {}
}

function playBeepSequence(beeps) {
    let offset = 0;
    beeps.forEach(b => { setTimeout(() => playBeep(b.freq, b.durationMs, b.volume), offset); offset += b.durationMs + 70; });
}

// Loud VOICE-ONLY announcement for a success milestone (no beep). Prefixes the ACTIVE PROFILE NAME
// so you know which account it's for, e.g. "SHIKHA 2. OTP sent successfully".
function announceSuccess(text) {
    try {
        speakBangla(text);
    } catch(e) {}
}

function beepOtpOrVerify() { playBeep(660, 300, 0.16); }
function beepReserve() { playBeepSequence([{ freq: 880, durationMs: 160, volume: 0.16 }, { freq: 1100, durationMs: 220, volume: 0.16 }]); }
function beepBook() { playBeepSequence([{ freq: 880, durationMs: 140, volume: 0.16 }, { freq: 1100, durationMs: 140, volume: 0.16 }, { freq: 1320, durationMs: 220, volume: 0.16 }]); }
function beepInitiateAndSpeak() {
    playBeepSequence([
        { freq: 523.25, durationMs: 190, volume: 0.16 },
        { freq: 659.25, durationMs: 190, volume: 0.16 },
        { freq: 783.99, durationMs: 380, volume: 0.18 }
    ]);
    setTimeout(() => speakBangla('Payment করুন'), 900);
}

function speakBangla(text) {
    try {
        if (!('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'bn-BD'; utter.rate = 0.98; utter.pitch = 1.0; utter.volume = 1.0;   // max volume
        const voices = window.speechSynthesis.getVoices();
        const bnVoice = voices.find(v => /^bn/i.test(v.lang)) || voices.find(v => /bangla|bengali/i.test(v.name));
        if (bnVoice) utter.voice = bnVoice;
        window.speechSynthesis.speak(utter);
    } catch(e) {}
}
try { if ('speechSynthesis' in window) { window.speechSynthesis.getVoices(); if (window.speechSynthesis.onvoiceschanged !== undefined) window.speechSynthesis.onvoiceschanged = () => {}; } } catch(e) {}

function attachInlineCd(btn, slotKey) {
    if (!btn) return null;
    let span = btn.querySelector('.btn-inline-cd');
    if (!span) { span = document.createElement('span'); span.className = 'btn-inline-cd'; btn.appendChild(span); }
    return span;
}
function clearInlineCd(btn) { const span = btn?.querySelector('.btn-inline-cd'); if (span) span.remove(); }

function tickOtpTimer(slotKey) {
    const t = timers[slotKey];
    const btn = document.getElementById(t.btnId);
    if (!btn || !t.expiresAt) return;
    const remain = t.expiresAt - Date.now();
    const span = attachInlineCd(btn, slotKey);
    if (!span) return;
    if (remain <= 0) {
        clearInterval(t.intervalId); t.intervalId = null; t.expiresAt = null; t.beeped = false;
        clearInlineCd(btn);
        logStatus(`⌛ ${slotKey === 'signinOtp' ? 'Signin' : 'Advance'} OTP expired`, 'r');
        return;
    }
    span.textContent = fmtRemaining(remain);
    if (remain <= WARN_THRESHOLD_MS) { span.classList.add('warn'); if (!t.beeped) { beepSoft(); t.beeped = true; } }
    else { span.classList.remove('warn'); }
}

function startOtpTimer(slotKey) {
    const t = timers[slotKey];
    if (t.intervalId) clearInterval(t.intervalId);
    t.expiresAt = Date.now() + TIMER_OTP_MS;
    t.beeped = false;
    tickOtpTimer(slotKey);
    t.intervalId = setInterval(() => tickOtpTimer(slotKey), 1000);
}

function stopOtpTimer(slotKey) {
    const t = timers[slotKey];
    if (t.intervalId) { clearInterval(t.intervalId); t.intervalId = null; }
    t.expiresAt = null; t.beeped = false;
    const btn = document.getElementById(t.btnId);
    if (btn) clearInlineCd(btn);
}

function refreshTokenCdUI() {
    const t = timers.token;
    const cdbar = document.getElementById('cdbar');
    const empty = document.getElementById('cd-empty');
    const otpCell = document.getElementById('cd-otp');
    const tokenCell = document.getElementById('cd-token');
    const sep = document.getElementById('cd-sep');
    const tokenTime = document.getElementById('cd-token-time');

    const anyOtpActive = timers.signinOtp.expiresAt || timers.advanceOtp.expiresAt;
    if (otpCell) otpCell.style.display = anyOtpActive ? '' : 'none';
    if (sep) sep.style.display = (anyOtpActive && t.expiresAt) ? '' : 'none';

    if (anyOtpActive) {
        const otpRemain = Math.max(
            timers.signinOtp.expiresAt ? timers.signinOtp.expiresAt - Date.now() : 0,
            timers.advanceOtp.expiresAt ? timers.advanceOtp.expiresAt - Date.now() : 0
        );
        const otpTimeEl = document.getElementById('cd-otp-time');
        if (otpTimeEl) otpTimeEl.textContent = fmtRemaining(otpRemain);
        if (otpCell) { if (otpRemain <= WARN_THRESHOLD_MS) otpCell.classList.add('warn'); else otpCell.classList.remove('warn'); }
    }

    if (!t.expiresAt) {
        if (cdbar && !anyOtpActive) cdbar.style.display = 'none';
        if (empty && !anyOtpActive) empty.style.display = '';
        if (tokenCell) tokenCell.style.display = 'none';
        return;
    }
    const remain = t.expiresAt - Date.now();
    if (cdbar) cdbar.style.display = '';
    if (empty) empty.style.display = 'none';
    if (tokenCell) tokenCell.style.display = '';

    if (remain <= 0) {
        tokenTime.textContent = '00:00';
        tokenCell.classList.remove('warn'); tokenCell.classList.add('expired');
        clearInterval(t.intervalId); t.intervalId = null; t.expiresAt = null;
        logStatus('🔒 Bearer token expired — session cleared. Login again.', 'r');
        try { clearAllSession(); } catch(e) {}
        try { stopOtpTimer('signinOtp'); stopOtpTimer('advanceOtp'); } catch(e) {}
        setTimeout(() => { tokenCell.classList.remove('expired'); refreshTokenCdUI(); }, 3000);
        return;
    }
    tokenTime.textContent = fmtRemaining(remain);
    if (remain <= WARN_THRESHOLD_MS) { tokenCell.classList.add('warn'); if (!t.beeped) { beepSoft(); t.beeped = true; } }
    else { tokenCell.classList.remove('warn'); }
}

function startTokenTimer() {
    const t = timers.token;
    if (t.intervalId) clearInterval(t.intervalId);
    t.expiresAt = Date.now() + TIMER_TOKEN_MS;
    t.beeped = false;
    refreshTokenCdUI();
    t.intervalId = setInterval(refreshTokenCdUI, 1000);
}

function startTokenTimerWithExpiry(expiresAt) {
    const t = timers.token;
    if (t.intervalId) clearInterval(t.intervalId);
    t.expiresAt = expiresAt;
    t.beeped = false;
    refreshTokenCdUI();
    t.intervalId = setInterval(refreshTokenCdUI, 1000);
}

refreshTokenCdUI();

function flashButton(btn, statusEmoji, color, durationMs) {
    if (!btn) return;
    const original = btn.dataset._origText || btn.textContent.replace(/\s*\d{2}:\d{2}\s*$/, '').trim();
    if (!btn.dataset._origText) btn.dataset._origText = original;
    const cdSpan = btn.querySelector('.btn-inline-cd');
    btn.textContent = statusEmoji;
    if (cdSpan) btn.appendChild(cdSpan);
    if (color === 'g') btn.style.background = 'linear-gradient(135deg,#10b981,#059669)';
    else if (color === 'r') btn.style.background = 'linear-gradient(135deg,#ef4444,#b91c1c)';
    else if (color === 'y') btn.style.background = 'linear-gradient(135deg,#f59e0b,#d97706)';
    setTimeout(() => {
        btn.textContent = original;
        if (cdSpan) btn.appendChild(cdSpan);
        btn.style.background = ''; btn.style.borderColor = '';
    }, durationMs || 1500);
}

// ==================== PROXY MANAGEMENT ====================
const PROXY_STORAGE_KEY = 'rj_proxy_list';
const PROXY_ACTIVE_KEY  = 'rj_proxy_active';

function loadProxies() { try { const raw = localStorage.getItem(PROXY_STORAGE_KEY); return raw ? JSON.parse(raw) : []; } catch(e) { return []; } }
function saveProxies(list) { try { localStorage.setItem(PROXY_STORAGE_KEY, JSON.stringify(list)); } catch(e) {} }
function getActiveProxyId() { try { return localStorage.getItem(PROXY_ACTIVE_KEY) || ''; } catch(e) { return ''; } }
function setActiveProxyId(id) { try { id ? localStorage.setItem(PROXY_ACTIVE_KEY, id) : localStorage.removeItem(PROXY_ACTIVE_KEY); } catch(e) {} }

function parseProxyLine(line, defaultScheme) {
    const s = String(line || '').trim(); if (!s) return null;
    let scheme = defaultScheme || 'http'; let body = s;
    const schemeMatch = s.match(/^(https?|socks[45]):\/\/(.+)$/i);
    if (schemeMatch) { scheme = schemeMatch[1].toLowerCase(); body = schemeMatch[2]; }
    const parts = body.split(':');
    if (parts.length !== 2 && parts.length !== 4) return null;
    const host = parts[0].trim(); const port = parseInt(parts[1], 10);
    if (!host || isNaN(port) || port < 1 || port > 65535) return null;
    return { id: `${scheme}_${host}_${port}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, scheme, host, port, user: parts[2]?.trim() || '', password: parts[3]?.trim() || '', label: `${host}:${port}` };
}

function formatProxyString(p) {
    if (!p) return 'system';
    const auth = p.user ? `${p.user}${p.password ? ':' + p.password : ''}@` : '';
    return `${p.scheme}://${auth}${p.host}:${p.port}`;
}

function refreshProxyPicker() {
    const list = loadProxies(); const activeId = getActiveProxyId();
    const pickers = [
        { el: document.getElementById('ivac-proxy-picker'),  emptyLabel: '-- Saved proxies --' },
        { el: document.getElementById('login-proxy-picker'), emptyLabel: '-- Direct (no proxy) --' }
    ];
    pickers.forEach(({ el, emptyLabel }) => {
        if (!el) return;
        el.innerHTML = `<option value="">${emptyLabel}</option>`;
        list.forEach(p => { const opt = document.createElement('option'); opt.value = p.id; opt.textContent = `${p.scheme.toUpperCase()} ${p.label}${p.user ? ' (' + p.user + ')' : ''}`; if (p.id === activeId) opt.selected = true; el.appendChild(opt); });
    });
    updateLoginToggleButton();
}

function updateLoginToggleButton() {
    const btn = document.getElementById('login-proxy-toggle'); if (!btn) return;
    const active = getActiveProxy();
    if (_proxyConnected && active) { btn.textContent = 'Disconnect'; btn.className = 'b2 bh'; btn.title = `Disconnect from ${active.label}`; }
    else if (active) { btn.textContent = 'Connect'; btn.className = 'b5 bh'; btn.title = `Connect to ${active.label}`; }
    else { btn.textContent = 'Connect'; btn.className = 'b0 bh'; btn.title = 'Select a proxy first'; }
}

function refreshProxyStatusLine() {
    const line = document.getElementById('ivac-proxy-status-line');
    if (line) {
        const active = getActiveProxy();
        if (active && _proxyConnected) line.innerHTML = `<span style="color:#4ade80">●</span> Extension proxy: <span style="color:#a78bfa">${formatProxyString(active)}</span>`;
        else if (active) line.innerHTML = `<span style="color:#facc15">○</span> Extension proxy: <span style="color:#94a3b8">${formatProxyString(active)}</span> <span style="color:#94a3b8">(not connected)</span>`;
        else line.innerHTML = `<span style="color:#94a3b8">●</span> Extension proxy: <span style="color:#94a3b8">system</span>`;
    }
    updateLoginToggleButton();
}

function getActiveProxy() { const id = getActiveProxyId(); return loadProxies().find(p => p.id === id) || null; }

// ── PER-CALL PROXY ROTATION ─────────────────────────────────────────────────
// Rotation ON  → every API call egresses via a proxy from the pool. Sticky-on-success
//               (keeps the same proxy while it works) / rotate-on-error (switches on failure).
// Rotation OFF → falls back to the single connected proxy (window._rjActiveProxy), or direct.
// Pool = saved proxies, optionally narrowed to the start–end range (1-indexed) in the Fetch tab.
window._rjRotState = window._rjRotState || { current: null };
function rjRotationOn() { return !!document.getElementById('ivac-parallel-proxy-rotation-toggle')?.classList.contains('on'); }
function rjProxyPool() {
    const all = loadProxies();
    if (!all.length) return [];
    const s = parseInt(document.getElementById('ivac-parallel-proxy-start')?.value, 10);
    const e = parseInt(document.getElementById('ivac-parallel-proxy-end')?.value, 10);
    if (!isNaN(s) && !isNaN(e) && s >= 1 && e >= s) return all.slice(s - 1, e);   // 1-indexed inclusive
    return all;
}
function pickProxyForCall() {
    if (rjRotationOn()) {
        const pool = rjProxyPool();
        if (!pool.length) return null;
        const cur = window._rjRotState.current;
        if (cur && pool.some(p => p.id === cur.id)) return cur;   // sticky: keep the working proxy
        const next = pool[Math.floor(Math.random() * pool.length)];
        window._rjRotState.current = next;
        try { logStatus(`🌀 Proxy → ${next.label}`, 'y'); } catch(e) {}
        return next;
    }
    // rotation off → single connected proxy (if any)
    return (typeof window !== 'undefined') ? window._rjActiveProxy : null;
}
function rotateProxyOnError(usedProxy) {
    if (!rjRotationOn()) return;
    const pool = rjProxyPool();
    if (pool.length < 1) { window._rjRotState.current = null; return; }
    // pick a DIFFERENT proxy than the one that just failed
    const others = pool.filter(p => !usedProxy || p.id !== usedProxy.id);
    const nextPool = others.length ? others : pool;
    const next = nextPool[Math.floor(Math.random() * nextPool.length)];
    window._rjRotState.current = next;
    try { logStatus(`🔁 Proxy error → rotating to ${next.label}`, 'y'); } catch(e) {}
}

let _proxyConnected = false;
function setProxyMsg(msg, err) { const el = document.getElementById('ivac-msg-proxy'); if (!el) return; el.textContent = msg; el.style.color = err ? '#fca5a5' : '#4ade80'; setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000); }

window._rjActiveProxy = null;
function updateActiveProxyGlobal() { const active = getActiveProxy(); window._rjActiveProxy = (active && _proxyConnected) ? { ...active } : null; }

document.getElementById('ivac-proxy-btn-add')?.addEventListener('click', () => {
    const scheme = document.getElementById('ivac-proxy-scheme')?.value || 'http'; const host = document.getElementById('ivac-proxy-host')?.value.trim(); const portRaw= document.getElementById('ivac-proxy-port')?.value.trim(); const user = document.getElementById('ivac-proxy-user')?.value.trim(); const password = document.getElementById('ivac-proxy-password')?.value;
    if (!host) { setProxyMsg('❌ Host required', true); return; } const port = parseInt(portRaw, 10); if (isNaN(port) || port < 1 || port > 65535) { setProxyMsg('❌ Invalid port', true); return; }
    const list = loadProxies(); const dup = list.find(p => p.scheme === scheme && p.host === host && p.port === port); if (dup) { setProxyMsg(`⚠ Already exists: ${host}:${port}`, true); return; }
    list.push({ id: `${scheme}_${host}_${port}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, scheme, host, port, user: user || '', password: password || '', label: `${host}:${port}` });
    saveProxies(list); refreshProxyPicker();
    document.getElementById('ivac-proxy-host').value = ''; document.getElementById('ivac-proxy-port').value = ''; document.getElementById('ivac-proxy-user').value = ''; document.getElementById('ivac-proxy-password').value = '';
    setProxyMsg(`✓ Added ${host}:${port}`);
});

document.getElementById('ivac-proxy-picker')?.addEventListener('change', (e) => {
    const id = e.target.value; if (!id) { setActiveProxyId(''); _proxyConnected = false; updateActiveProxyGlobal(); refreshProxyStatusLine(); return; }
    setActiveProxyId(id); const p = loadProxies().find(x => x.id === id);
    if (p) { const schemeEl = document.getElementById('ivac-proxy-scheme'); const hostEl = document.getElementById('ivac-proxy-host'); const portEl = document.getElementById('ivac-proxy-port'); const userEl = document.getElementById('ivac-proxy-user'); const passEl = document.getElementById('ivac-proxy-password'); if (schemeEl) schemeEl.value = p.scheme; if (hostEl) hostEl.value = p.host; if (portEl) portEl.value = p.port; if (userEl) userEl.value = p.user || ''; if (passEl) passEl.value = p.password || ''; }
    _proxyConnected = false; updateActiveProxyGlobal(); refreshProxyStatusLine(); setProxyMsg(`✓ Selected ${p?.label || ''} — click Connect to activate`);
});

document.getElementById('ivac-proxy-btn-remove')?.addEventListener('click', () => {
    const picker = document.getElementById('ivac-proxy-picker'); const id = picker?.value; if (!id) { setProxyMsg('❌ Select a proxy first', true); return; }
    const list = loadProxies(); const p = list.find(x => x.id === id); if (!p) { setProxyMsg('❌ Not found', true); return; } if (!confirm(`Remove ${p.label}?`)) return;
    const filtered = list.filter(x => x.id !== id); saveProxies(filtered); if (getActiveProxyId() === id) { setActiveProxyId(''); _proxyConnected = false; } refreshProxyPicker(); refreshProxyStatusLine(); updateActiveProxyGlobal(); setProxyMsg(`✓ Removed ${p.label}`);
});

document.getElementById('ivac-proxy-btn-connect')?.addEventListener('click', () => {
    const picker = document.getElementById('ivac-proxy-picker'); const id = picker?.value;
    if (!id) { const scheme = document.getElementById('ivac-proxy-scheme')?.value || 'http'; const host = document.getElementById('ivac-proxy-host')?.value.trim(); const portRaw= document.getElementById('ivac-proxy-port')?.value.trim(); if (!host || !portRaw) { setProxyMsg('❌ Select a proxy or fill the form first', true); return; } const port = parseInt(portRaw, 10); if (isNaN(port)) { setProxyMsg('❌ Invalid port', true); return; } const ephemeral = { id: '_ephemeral', scheme, host, port, user: document.getElementById('ivac-proxy-user')?.value.trim() || '', password: document.getElementById('ivac-proxy-password')?.value || '', label: `${host}:${port}` }; _proxyConnected = true; window._rjActiveProxy = ephemeral; const line = document.getElementById('ivac-proxy-status-line'); if (line) line.innerHTML = `<span style="color:#4ade80">●</span> Extension proxy: <span style="color:#a78bfa">${formatProxyString(ephemeral)}</span> <span style="color:#facc15">(ephemeral)</span>`; setProxyMsg(`✓ Connected (ephemeral) ${ephemeral.label}`); return; }
    const p = loadProxies().find(x => x.id === id); if (!p) { setProxyMsg('❌ Proxy not found', true); return; } _proxyConnected = true; updateActiveProxyGlobal(); refreshProxyStatusLine(); setProxyMsg(`✓ Connected ${p.label}`);
});

document.getElementById('ivac-proxy-btn-disconnect')?.addEventListener('click', () => { _proxyConnected = false; updateActiveProxyGlobal(); refreshProxyStatusLine(); setProxyMsg('✓ Disconnected — using system proxy'); });

document.getElementById('ivac-proxy-btn-merge-box')?.addEventListener('click', () => {
    const txt = document.getElementById('ivac-proxy-import-export')?.value || ''; const lines = txt.split(/[\r\n]+/).filter(s => s.trim()); if (!lines.length) { setProxyMsg('❌ Paste box is empty', true); return; }
    const list = loadProxies(); const defaultScheme = document.getElementById('ivac-proxy-scheme')?.value || 'http'; let added = 0, skipped = 0, invalid = 0;
    lines.forEach(line => { const parsed = parseProxyLine(line, defaultScheme); if (!parsed) { invalid++; return; } const dup = list.find(p => p.scheme === parsed.scheme && p.host === parsed.host && p.port === parsed.port); if (dup) { skipped++; return; } list.push(parsed); added++; });
    saveProxies(list); refreshProxyPicker(); const parts = []; if (added) parts.push(`+${added} added`); if (skipped) parts.push(`${skipped} dup`); if (invalid) parts.push(`${invalid} invalid`); setProxyMsg(`✓ Merge: ${parts.join(', ') || '0'}`); if (added) document.getElementById('ivac-proxy-import-export').value = '';
});

document.getElementById('ivac-proxy-btn-export')?.addEventListener('click', () => {
    const list = loadProxies(); if (!list.length) { setProxyMsg('❌ No proxies to export', true); return; }
    const textFmt = list.map(p => { const auth = p.user ? `:${p.user}${p.password ? ':' + p.password : ''}` : ''; return `${p.host}:${p.port}${auth}`; }).join('\n');
    document.getElementById('ivac-proxy-import-export').value = textFmt;
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `rj-proxies-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url); setProxyMsg(`✓ Exported ${list.length} proxies (text + JSON)`);
});

document.getElementById('ivac-proxy-btn-import-file')?.addEventListener('click', () => { document.getElementById('ivac-proxy-file-input')?.click(); });
document.getElementById('ivac-proxy-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return; const reader = new FileReader();
    reader.onload = (ev) => { try { const imported = JSON.parse(ev.target.result); if (!Array.isArray(imported)) { setProxyMsg('❌ Invalid file: not an array', true); return; } const list = loadProxies(); let added = 0, skipped = 0, invalid = 0; imported.forEach(item => { if (!item.host || !item.port) { invalid++; return; } const dup = list.find(p => p.scheme === item.scheme && p.host === item.host && p.port === item.port); if (dup) { skipped++; return; } list.push({ id: `imp_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, scheme: item.scheme || 'http', host: String(item.host), port: parseInt(item.port, 10), user: item.user || '', password: item.password || '', label: item.label || `${item.host}:${item.port}` }); added++; }); saveProxies(list); refreshProxyPicker(); setProxyMsg(`✓ Import: +${added}, ${skipped} dup, ${invalid} invalid`); } catch(err) { setProxyMsg('❌ Invalid JSON file', true); } };
    reader.readAsText(file); e.target.value = '';
});

refreshProxyPicker(); refreshProxyStatusLine(); updateActiveProxyGlobal();

    // ==================== UPLOAD TAB ====================
    document.getElementById('ivac-btn-file-upload-checking')?.addEventListener('click', async function() {
        if (!sessionState.accessToken) { logStatus('❌ No active session — Signin first', 'r'); return; }
        try { _uploadArmed = true; uploadQueueFill(); } catch(e) {}   // start pre-solving the upload pool now (early lead time)
        logStatus('📋 Checking file upload status…', 'y');
        const logId = netLogAdd({ method: 'GET', url: API_SLOT_STATUS, tag: 'slot', state: 'pending', note: 'file-upload-checking' });
        try {
            const r = await H2.fetchH2(API_SLOT_STATUS, { method: 'GET', headers: { 'accept': 'application/json, text/plain, */*', 'authorization': `Bearer ${sessionState.accessToken}`, 'cache-control': 'no-cache, no-store, must-revalidate', 'pragma': 'no-cache', 'x-device-id': getDeviceId() }, referrer: API_REFERRER, body: null });
            let body = null; try { body = await r.json(); } catch(e) { body = null; }
            const ok = r.ok && body && (body.successFlag === true || body.statusCode === 200);
            netLogUpdate(logId, { status: r.status, state: ok ? 'ok' : 'fail', note: ok ? `slotOpen=${body.data?.slotOpen} • file: ${body.data?.fileUploadStatus || '?'} • ${body.data?.appointmentDate || ''}` : (body?.message || `HTTP ${r.status}`) });
            if (ok) { const d = body.data || {}; const slotOpen = d.slotOpen ? '🟢 OPEN' : '🔴 CLOSED'; logStatus(`✅ File Check: ${slotOpen} • file: ${d.fileUploadStatus || 'unknown'} • ${d.appointmentDate || ''}`, 'g'); if (d.slotOpen) { try { announceSuccess('Slot is open'); } catch(e) {} } }
            else { logStatus(`❌ File check failed: ${body?.message || `HTTP ${r.status}`}`, 'r'); }
        } catch (err) { if (err.name === 'AbortError') netLogUpdate(logId, { state: 'cancel', status: '⊘' }); else netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); logStatus(`❌ File check error: ${err.message}`, 'r'); }
    });

    document.getElementById('ivac-btn-appointment')?.addEventListener('click', async function() {
        if (!sessionState.accessToken) { logStatus('❌ No active session — Signin first', 'r'); return; }
        logStatus('📋 Creating appointment…', 'y');
        const logId = netLogAdd({ method: 'POST', url: "https://api.ivacbd.com/iams/api/v1/appointment", tag: 'book', state: 'pending', note: 'appointment' });
        try {
            const r = await H2.fetchH2("https://api.ivacbd.com/iams/api/v1/appointment", { method: 'POST', headers: { 'accept': 'application/json, text/plain, */*', 'authorization': `Bearer ${sessionState.accessToken}`, 'cache-control': 'no-cache', 'x-device-id': getDeviceId() }, referrer: API_REFERRER, body: null });
            let body = null; try { body = await r.json(); } catch(e) { body = null; }
            const ok = r.ok && body && (body.successFlag === true || body.statusCode === 200);
            netLogUpdate(logId, { status: r.status, state: ok ? 'ok' : 'fail', note: ok ? `appointmentId=${body.data?.appointmentId?.slice(0,8) || '?'}` : (body?.message || `HTTP ${r.status}`) });
            if (ok) { const d = body.data || {}; if (d.appointmentId) { sessionState.appointmentId = d.appointmentId; sessionState.bookedAt = Date.now(); persistSession(); try { if (profiles[activeProfileName]) { profiles[activeProfileName].appointmentId = d.appointmentId; persistProfiles(); if (pmAppointmentId) pmAppointmentId.value = d.appointmentId; } } catch(e) {} } logStatus(`✅ Appointment: ${(d.appointmentId||'?').slice(0,8)}… • ${d.ivacCenter||''} • ${d.appointmentSlot||''}`, 'g'); try { announceSuccess('Appointment created'); } catch(e) {} }
            else { logStatus(`❌ Appointment failed: ${body?.message || `HTTP ${r.status}`}`, 'r'); }
        } catch (err) { if (err.name === 'AbortError') netLogUpdate(logId, { state: 'cancel', status: '⊘' }); else netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); logStatus(`❌ Appointment error: ${err.message}`, 'r'); }
    });

    const UPLOAD_MAX_TRIES = 4;   // transient 503/429 retries with a fresh distinct token each time
    // Persisted (per-profile, reload-surviving) upload Files, keyed by input id. Filled by
    // initPersistentUploads; uploadFile() falls back to these when no fresh file is picked.
    var rjSavedUploads = rjSavedUploads || {};
    // Send a multipart/form-data upload with the file bytes encoded by hand, so the payload
    // survives BOTH transports: native page fetch (Blob body) and the GM_xmlhttpRequest
    // fallback (raw binary string). A plain FormData loses its File when it has to go through
    // GM_xmlhttpRequest, which is why uploads returned 200 but stored nothing.
    async function sendMultipartUpload(url, headers, file, fields) {
        const boundary = '----RJUpload' + Math.random().toString(16).slice(2) + Date.now().toString(16);
        const fileBytes = new Uint8Array(await file.arrayBuffer());
        const enc = s => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff; return a; };
        const parts = [];
        parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`));
        parts.push(fileBytes);
        parts.push(enc('\r\n'));
        for (const k in fields) parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${fields[k]}\r\n`));
        parts.push(enc(`--${boundary}--\r\n`));
        let total = 0; parts.forEach(p => total += p.length);
        const bytes = new Uint8Array(total); let off = 0; parts.forEach(p => { bytes.set(p, off); off += p.length; });
        const contentType = 'multipart/form-data; boundary=' + boundary;
        const allHeaders = { ...headers, 'content-type': contentType };

        // 1) native page fetch with a Blob body (HTTP/2, real bytes)
        try {
            const pageFetch = (typeof unsafeWindow !== 'undefined' && unsafeWindow.fetch) ? unsafeWindow.fetch : fetch;
            // credentials:'omit' — this endpoint does NOT return Access-Control-Allow-Credentials,
            // so 'include' is rejected by the CORS preflight (blocks the request). Bearer token is
            // the real auth; the file binds via the token, not the cookie.
            return await pageFetch(url, { method: 'POST', headers: allHeaders, credentials: 'omit', referrer: API_REFERRER, body: new Blob([bytes], { type: contentType }) });
        } catch (e) {
            // 2) GM fallback — send the raw bytes as a binary string
            const gmApi = (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) || (typeof GM !== 'undefined' && GM.xmlHttpRequest);
            if (!gmApi) throw e;
            let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return await new Promise((resolve, reject) => {
                gmApi({
                    method: 'POST', url, headers: allHeaders, data: bin, binary: true, timeout: 30000,
                    onload: r => resolve(new Response(r.responseText, { status: r.status, statusText: r.statusText })),
                    onerror: () => reject(new Error('GM upload network error')),
                    ontimeout: () => reject(new Error('GM upload timeout'))
                });
            });
        }
    }

    async function uploadFile(fileInputId, isPrimary, label) {
        if (!sessionState.accessToken) { logStatus('❌ No active session', 'r'); return; }
        const fileInput = document.getElementById(fileInputId);
        // Prefer a freshly-picked file; else fall back to the PERSISTED file (survives reload,
        // per-profile, IndexedDB). Browser security forbids setting input.files programmatically,
        // so the saved File is kept in memory (rjSavedUploads) and used directly here.
        const file = (fileInput?.files?.length > 0) ? fileInput.files[0] : (rjSavedUploads[fileInputId] || null);
        if (!file) { logStatus(`❌ ${label}: no file selected`, 'r'); return; }   // never upload an empty part
        const logId = netLogAdd({ method: 'POST', url: "https://api.ivacbd.com/iams/api/v1/file/upload_file_v23", tag: 'upload', state: 'pending', note: `${label}` });

        for (let attempt = 1; attempt <= UPLOAD_MAX_TRIES; attempt++) {
            // A DISTINCT, not-in-use token for EVERY attempt (never reuse a token across a
            // request — that is what caused the 503). claimFreshUploadToken serialises claims
            // and guarantees uniqueness even when several files upload at once.
            let uploadEntry;
            try { uploadEntry = await claimFreshUploadToken(); }
            catch(e) { netLogUpdate(logId, { state: 'fail', status: 'err', note: `captcha: ${e.message}` }); logStatus(`❌ ${label} captcha: ${e.message}`, 'r'); return; }
            const uploadToken = uploadEntry.token;
            logStatus(`📄 Uploading ${label}${attempt > 1 ? ` (try ${attempt}/${UPLOAD_MAX_TRIES})` : ''}…`, 'y');
            try {
                // Build the multipart body by hand so the real file bytes are ALWAYS sent —
                // GM_xmlhttpRequest drops File objects from a FormData (→ 200 with an empty file
                // part, i.e. "server e data jaina"). sendMultipartUpload sends raw bytes on both
                // the native-fetch and GM paths.
                const r = await sendMultipartUpload(
                    "https://api.ivacbd.com/iams/api/v1/file/upload_file_v23",
                    { 'accept': 'application/json, text/plain, */*', 'authorization': `Bearer ${sessionState.accessToken}`, 'cache-control': 'no-cache, no-store, must-revalidate', 'pragma': 'no-cache', 'x-sec-runtime-state': _runtimeState(), 'x-token': uploadToken },
                    file, { isPrimary: String(isPrimary) }
                );
                let body = null; try { body = await r.json(); } catch(e) { body = null; }
                const ok = r.ok && body && (body.successFlag === true || body.statusCode === 200);
                // success or server-declared-invalid → token spent, release (stays out of queue).
                // transient (bodyless 503 / 429) → token never reached the server: DON'T reuse it here
                // (reusing the same token is exactly what 503s). Release it back to the queue and
                // claim a brand-new one on the next attempt.
                const transient = !ok && !shouldBurnToken(r.status, body);
                releaseUploadToken(uploadEntry, transient);   // transient → back to queue; else discard
                if (ok) { netLogUpdate(logId, { status: r.status, state: 'ok', note: 'uploaded' }); logStatus(`✅ ${label} uploaded`, 'g'); try { announceSuccess(label + ' uploaded'); } catch(e) {} return; }
                if (transient && attempt < UPLOAD_MAX_TRIES) {
                    netLogUpdate(logId, { status: r.status, state: 'pending', note: `503/429 → retry ${attempt+1}` });
                    logStatus(`⏳ ${label} ${r.status} — retrying with a fresh token…`, 'y');
                    await new Promise(res => setTimeout(res, 700 * attempt));   // small backoff
                    continue;
                }
                netLogUpdate(logId, { status: r.status, state: 'fail', note: body?.message || `HTTP ${r.status}` });
                logStatus(`❌ ${label} failed: ${body?.message || `HTTP ${r.status}`}`, 'r');
                return;
            } catch (err) {
                releaseUploadToken(uploadEntry, true);        // network error → token still valid, requeue
                if (attempt < UPLOAD_MAX_TRIES) { logStatus(`⏳ ${label} error — retrying…`, 'y'); await new Promise(res => setTimeout(res, 700 * attempt)); continue; }
                netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); logStatus(`❌ ${label} error: ${err.message}`, 'r');
                return;
            }
        }
    }
    document.getElementById('ivac-btn-file-upload')?.addEventListener('click', () => uploadFile('ivac-file-upload', true, 'Patient File'));
    document.getElementById('ivac-btn-file-upload-2')?.addEventListener('click', () => uploadFile('ivac-file-upload-2', false, 'Attendant 1'));
    document.getElementById('ivac-btn-file-upload-3')?.addEventListener('click', () => uploadFile('ivac-file-upload-3', false, 'Attendant 2'));
    document.getElementById('ivac-btn-file-upload-4')?.addEventListener('click', () => uploadFile('ivac-file-upload-4', false, 'Attendant 3'));

    // ============ PERSISTENT PDF UPLOADS (per-profile, IndexedDB) ============
    // Patient/Attendant PDFs stay saved across reload until overwritten (new pick) or cleared (🗑).
    // Browser forbids setting input.files programmatically, so saved Files live in rjSavedUploads
    // (memory) and uploadFile() falls back to them. Bytes persist in IndexedDB keyed per profile.
    (function initPersistentUploads() {
        const SLOTS = [
            { input: 'ivac-file-upload',   slot: 'patient', label: 'Patient File' },
            { input: 'ivac-file-upload-2', slot: 'atten1',  label: 'Attendant 1' },
            { input: 'ivac-file-upload-3', slot: 'atten2',  label: 'Attendant 2' },
            { input: 'ivac-file-upload-4', slot: 'atten3',  label: 'Attendant 3' },
        ];
        const DB = 'rj_uploads', STORE = 'files';
        function openDB() { return new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
        async function idbPut(k, v) { const db = await openDB(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
        async function idbGet(k) { const db = await openDB(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readonly'); const rq = t.objectStore(STORE).get(k); rq.onsuccess = () => res(rq.result || null); rq.onerror = () => rej(rq.error); }); }
        async function idbDel(k) { const db = await openDB(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).delete(k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
        const keyFor = (slot) => `${(typeof activeProfileName !== 'undefined' && activeProfileName) || 'default'}::${slot}`;

        function setLabel(input, name) { const el = document.getElementById('rj-svd-' + input); if (!el) return; if (name) { el.innerHTML = '💾 <span style="color:#4ade80">' + name + '</span> <span data-clr="' + input + '" title="clear saved file" style="cursor:pointer;color:#f87171;font-weight:800">🗑</span>'; el.style.display = 'block'; } else { el.textContent = ''; el.style.display = 'none'; } }

        // inject a tiny saved-file status line under each input row
        SLOTS.forEach(s => { const inp = document.getElementById(s.input); if (!inp || document.getElementById('rj-svd-' + s.input)) return; const row = inp.closest('.fr') || inp.parentElement; const d = document.createElement('div'); d.id = 'rj-svd-' + s.input; d.style.cssText = 'display:none;font:700 .58rem Consolas,monospace;color:#4ade80;word-break:break-all;margin:0 0 3px 2px'; row.insertAdjacentElement('afterend', d); });

        // clear (🗑) via delegation
        document.addEventListener('click', async (e) => { const t = e.target; if (t && t.dataset && t.dataset.clr) { const input = t.dataset.clr; const s = SLOTS.find(x => x.input === input); if (!s) return; delete rjSavedUploads[input]; try { await idbDel(keyFor(s.slot)); } catch (err) {} setLabel(input, ''); logStatus(`🗑 ${s.label} saved file cleared`, 'y'); } });

        // on new file pick → save bytes to IDB + memory
        SLOTS.forEach(s => { const inp = document.getElementById(s.input); if (!inp) return; inp.addEventListener('change', async () => { const f = inp.files && inp.files[0]; if (!f) return; try { const buf = await f.arrayBuffer(); await idbPut(keyFor(s.slot), { name: f.name, type: f.type || 'application/pdf', bytes: buf, savedAt: Date.now() }); rjSavedUploads[s.input] = f; setLabel(s.input, f.name); logStatus(`💾 ${s.label} saved (${Math.round(f.size / 1024)}KB)`, 'g'); } catch (err) { logStatus(`⚠ ${s.label} save failed: ${err.message}`, 'y'); } }); });

        // load the active profile's saved files into memory + labels
        async function loadForProfile() { for (const s of SLOTS) { try { const rec = await idbGet(keyFor(s.slot)); if (rec && rec.bytes) { rjSavedUploads[s.input] = new File([rec.bytes], rec.name, { type: rec.type || 'application/pdf' }); setLabel(s.input, rec.name); } else { delete rjSavedUploads[s.input]; setLabel(s.input, ''); } } catch (err) {} } }
        window.__rjReloadSavedUploads = loadForProfile;

        setTimeout(loadForProfile, 700);   // initial
        ['main-profile-select', 'pm-profile-select'].forEach(id => { const sel = document.getElementById(id); if (sel) sel.addEventListener('change', () => setTimeout(loadForProfile, 200)); });
    })();

    const MISSION_MAP = { dhaka: { mission: 'Dhaka', ivacCenter: 'IVAC, Dhaka (JFP)' }, chittagong: { mission: 'Chittagong', ivacCenter: 'IVAC, Chittagong' }, khulna: { mission: 'Khulna', ivacCenter: 'IVAC, Khulna' }, rajshahi: { mission: 'Rajshahi', ivacCenter: 'IVAC, Rajshahi' }, sylhet: { mission: 'Sylhet', ivacCenter: 'IVAC, Sylhet' } };

    document.getElementById('ivac-btn-appointment-booking')?.addEventListener('click', async function() {
        if (!sessionState.accessToken) { logStatus('❌ No active session', 'r'); return; }
        const missionSelect = document.getElementById('ivac-appointment-mission'); const selectedValue = missionSelect?.value || 'dhaka'; const missionData = MISSION_MAP[selectedValue]; if (!missionData) { logStatus('❌ Invalid mission', 'r'); return; }
        logStatus(`🏛 Confirming: ${missionData.mission}`, 'y');
        const logId = netLogAdd({ method: 'POST', url: "https://api.ivacbd.com/iams/api/v1/appointment/appointment-booking-config", tag: 'book', state: 'pending' });
        try {
            const r = await H2.fetchH2("https://api.ivacbd.com/iams/api/v1/appointment/appointment-booking-config", { method: 'POST', headers: { 'accept': 'application/json', 'authorization': `Bearer ${sessionState.accessToken}`, 'content-type': 'application/json', 'x-device-id': getDeviceId() }, referrer: API_REFERRER, body: JSON.stringify({ mission: missionData.mission, ivacCenter: missionData.ivacCenter }) });
            let body = null; try { body = await r.json(); } catch(e) { body = null; }
            const ok = r.ok && body && (body.successFlag === true || body.statusCode === 200);
            netLogUpdate(logId, { status: r.status, state: ok ? 'ok' : 'fail', note: ok ? `confirmed` : (body?.message || `HTTP ${r.status}`) });
            if (ok) { const d = body.data || {}; if (d.appointmentId) { sessionState.appointmentId = d.appointmentId; sessionState.bookedAt = Date.now(); persistSession(); try { if (profiles[activeProfileName]) { profiles[activeProfileName].appointmentId = d.appointmentId; persistProfiles(); if (pmAppointmentId) pmAppointmentId.value = d.appointmentId; } } catch(e) {} } logStatus(`✅ Confirmed: ${missionData.mission} • ${d.appointmentSlot||''}`, 'g'); try { announceSuccess('Mission confirmed'); } catch(e) {} }
            else { logStatus(`❌ Confirm failed: ${body?.message || `HTTP ${r.status}`}`, 'r'); }
        } catch (err) { netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); logStatus(`❌ Confirm error: ${err.message}`, 'r'); }
    });

    document.getElementById('ivac-btn-file-checking')?.addEventListener('click', async function() {
        if (!sessionState.accessToken) { logStatus('❌ No active session', 'r'); return; }
        logStatus('📋 Checking file overview…', 'y');
        const logId = netLogAdd({ method: 'POST', url: "https://api.ivacbd.com/iams/api/v1/file/over-views", tag: 'upload', state: 'pending' });
        try {
            const r = await H2.fetchH2("https://api.ivacbd.com/iams/api/v1/file/over-views", { method: 'POST', headers: { 'accept': 'application/json', 'authorization': `Bearer ${sessionState.accessToken}`, 'x-device-id': getDeviceId() }, referrer: API_REFERRER, body: null });
            let body = null; try { body = await r.json(); } catch(e) { body = null; }
            const ok = r.ok && body && (body.successFlag === true || body.statusCode === 200);
            netLogUpdate(logId, { status: r.status, state: ok ? 'ok' : 'fail', note: ok ? `fileStatus=${body.data?.fileUploadStatus||'?'}` : (body?.message || `HTTP ${r.status}`) });
            if (ok) logStatus(`✅ File Check: ${body.data?.fileUploadStatus||'unknown'}`, 'g'); else logStatus(`❌ File Checking failed: ${body?.message || `HTTP ${r.status}`}`, 'r');
        } catch (err) { netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); logStatus(`❌ File Checking error: ${err.message}`, 'r'); }
    });

    document.getElementById('ivac-btn-file-delete')?.addEventListener('click', async function() {
        const fileNumber = (document.getElementById('ivac-file-delete-number')?.value || '').trim();
        if (!sessionState.accessToken) { logStatus('❌ No active session', 'r'); return; }
        if (!fileNumber) { logStatus('❌ Enter file number', 'r'); return; }
        const url = `https://api.ivacbd.com/iams/api/v1/file/delete?fileNumber=${encodeURIComponent(fileNumber)}`;
        logStatus(`🗑 Deleting file: ${fileNumber}`, 'y');
        const logId = netLogAdd({ method: 'DELETE', url, tag: 'upload', state: 'pending' });
        try {
            const r = await H2.fetchH2(url, { method: 'DELETE', headers: { 'accept': 'application/json', 'authorization': `Bearer ${sessionState.accessToken}`, 'x-device-id': getDeviceId() }, referrer: API_REFERRER, body: null });
            let body = null; try { body = await r.json(); } catch(e) { body = null; }
            const ok = r.ok && body && (body.successFlag === true || body.statusCode === 200);
            netLogUpdate(logId, { status: r.status, state: ok ? 'ok' : 'fail' });
            if (ok) logStatus(`✅ File deleted: ${fileNumber}`, 'g'); else logStatus(`❌ Delete failed: ${body?.message || `HTTP ${r.status}`}`, 'r');
        } catch (err) { netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); logStatus(`❌ Delete error: ${err.message}`, 'r'); }
    });

    // ==================== INVOICE DOWNLOAD ====================
    let invoiceRetryActive = false;
    async function autoDownloadInvoice(url) {
        logStatus('📥 Downloading invoice…', 'y');
        try {
            const r = await pageFetch(url, { method: 'GET', headers: { 'accept': 'application/pdf, */*', 'authorization': sessionState.accessToken ? `Bearer ${sessionState.accessToken}` : '', 'x-device-id': getDeviceId() }, credentials: 'omit' });
            const blob = await r.blob(); const downloadUrl = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = downloadUrl; a.download = `invoice-${Date.now()}.pdf`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(downloadUrl);
            logStatus('✅ Invoice downloaded!', 'g');
        } catch(e) {
            const gmApi = (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) || (typeof GM !== 'undefined' && GM.xmlHttpRequest);
            if (gmApi) {
                gmApi({ method: 'GET', url: url, responseType: 'blob', headers: { 'accept': 'application/pdf, */*', 'authorization': sessionState.accessToken ? `Bearer ${sessionState.accessToken}` : '', 'x-device-id': getDeviceId() },
                    onload: (resp) => { try { const blob = resp.response; const downloadUrl = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = downloadUrl; a.download = `invoice-${Date.now()}.pdf`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(downloadUrl); logStatus('✅ Invoice downloaded!', 'g'); } catch(e) { logStatus('✅ Invoice ready — check tab', 'g'); } },
                    onerror: () => { logStatus('✅ Invoice ready — check tab', 'g'); } });
            } else { logStatus('✅ Invoice ready — check tab', 'g'); }
        }
        try { beepInitiateAndSpeak(); } catch(e) {}
    }
    async function checkInvoiceLoaded(url) {
        const result = { loaded: false, status: null, msg: '' };
        try {
            const r = await pageFetch(url, { method: 'GET', headers: { 'accept': 'application/pdf, application/json, */*', 'authorization': sessionState.accessToken ? `Bearer ${sessionState.accessToken}` : '', 'x-device-id': getDeviceId() }, credentials: 'omit' });
            if (!invoiceRetryActive) return result;
            const contentType = r.headers.get('content-type') || ''; result.status = r.status;
            if (r.status === 200 && contentType.includes('pdf')) { result.loaded = true; return result; }
            const text = await r.text();
            if (!invoiceRetryActive) return result;
            if (text.startsWith('%PDF')) { result.loaded = true; return result; }
            try { const json = JSON.parse(text); result.msg = json.message || ''; if ((r.status === 200 || r.status === 201) && json.data && (json.successFlag === true || json.statusCode === 200 || json.statusCode === 201)) result.loaded = true; } catch(e) { if (r.status === 200 && text.length > 200) { const lt = text.toLowerCase(); const hasInvoice = lt.includes('invoice') || lt.includes('payment') || lt.includes('ivac'); const hasError = lt.includes('error') || lt.includes('not found') || lt.includes('fail'); if (hasInvoice && !hasError) result.loaded = true; } }
            return result;
        } catch(e) {
            return new Promise((resolve) => {
                const gmApi = (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) || (typeof GM !== 'undefined' && GM.xmlHttpRequest);
                if (!gmApi) { result.status = 'ERR'; result.msg = 'no fetch available'; resolve(result); return; }
                gmApi({ method: 'GET', url: url, headers: { 'accept': 'application/pdf, application/json, */*', 'authorization': sessionState.accessToken ? `Bearer ${sessionState.accessToken}` : '', 'x-device-id': getDeviceId() }, timeout: 20000,
                    onload: (response) => {
                        if (!invoiceRetryActive) { resolve(result); return; }
                        const status = response.status; const rawText = response.responseText || ''; const headersStr = (response.responseHeaders || '').toLowerCase();
                        const isPdf = rawText.startsWith('%PDF') || headersStr.includes('application/pdf'); let isSuccessJson = false;
                        try { const json = JSON.parse(rawText); result.msg = json.message || ''; if (status === 200 || status === 201) { if (json.successFlag === true || json.statusCode === 200 || json.statusCode === 201) { if (json.data && (typeof json.data === 'object' ? Object.keys(json.data).length > 0 : !!json.data)) isSuccessJson = true; if (json.message === 'Success' || json.message === 'OK') isSuccessJson = true; } } } catch(e) { if (status === 200 && rawText.length > 200) { const lt = rawText.toLowerCase(); const hasInvoice = lt.includes('invoice') || lt.includes('payment') || lt.includes('ivac') || lt.includes('visa application'); const hasError = lt.includes('error') || lt.includes('not found') || lt.includes('fail'); if (hasInvoice && !hasError) isSuccessJson = true; } }
                        result.status = status; result.loaded = isPdf || isSuccessJson; resolve(result);
                    },
                    onerror: () => { result.status = 'ERR'; result.msg = 'network error'; resolve(result); },
                    ontimeout: () => { result.status = 'TMO'; result.msg = 'timeout'; resolve(result); } });
            });
        }
    }
    document.getElementById('ivac-btn-invoice-download')?.addEventListener('click', function() {
        const btn = this;
        if (invoiceRetryActive) { invoiceRetryActive = false; if (btn.dataset.origStyle) btn.style.cssText = btn.dataset.origStyle; btn.textContent = 'Submit'; logStatus('⏹ Invoice stopped', 'y'); return; }
        const trxId = (document.getElementById('ivac-invoice-trxid')?.value || '').trim();
        if (!trxId) { logStatus('❌ Enter trxId first', 'r'); return; }
        const url = `https://api.ivacbd.com/iams/api/v1/invoice/download?txrId=${encodeURIComponent(trxId)}`;
        if (!btn.dataset.origStyle) btn.dataset.origStyle = btn.style.cssText;
        invoiceRetryActive = true;
        btn.style.cssText = btn.dataset.origStyle + ';background:linear-gradient(135deg,#ef4444,#b91c1c)!important;border:1px solid #f87171!important;color:#fff!important';
        btn.textContent = '■ STOP';
        logStatus(`🧾 Invoice loading… will auto-reload until loaded`, 'g');
        window.open(url, 'rjInvoiceTab');
        (async () => {
            let attempts = 0; const maxAttempts = 300;
            while (invoiceRetryActive && attempts < maxAttempts) {
                attempts++; await new Promise(r => setTimeout(r, 1000));
                if (!invoiceRetryActive) break;
                const result = await checkInvoiceLoaded(url);
                if (!invoiceRetryActive) break;
                if (result.loaded) { invoiceRetryActive = false; if (btn.dataset.origStyle) btn.style.cssText = btn.dataset.origStyle; btn.textContent = 'Submit'; logStatus('✅ Invoice loaded! Auto-downloading…', 'g'); autoDownloadInvoice(url); return; }
                try { const tab = window.open('', 'rjInvoiceTab'); if (tab && !tab.closed) tab.location.href = url; else window.open(url, 'rjInvoiceTab'); } catch(e) { try { window.open(url, 'rjInvoiceTab'); } catch(e2) {} }
                const statusStr = result.status || '?'; const msgStr = result.msg ? `: ${result.msg.slice(0, 35)}` : '';
                logStatus(`⏳ Invoice not ready (${statusStr}${msgStr}) • attempt ${attempts}/${maxAttempts}`, 'y');
            }
            if (invoiceRetryActive) { invoiceRetryActive = false; if (btn.dataset.origStyle) btn.style.cssText = btn.dataset.origStyle; btn.textContent = 'Submit'; logStatus(`⏹ Invoice stopped (${maxAttempts} attempts)`, 'y'); }
        })();
    });

    // ==================== SIGNUP: UI HANDLERS ====================
    function suMsg(elId, msg, type) { const el = document.getElementById(elId); if (!el) return; el.textContent = msg || ''; el.className = 'su-msg ' + (type === 'g' ? 'g' : type === 'r' ? 'r' : type === 'y' ? 'y' : ''); }
    function updateMobileBadge() { const b = document.getElementById('su-mobile-badge'); if (!b) return; if (signupState.mobileVerified) { b.textContent = '✓ VERIFIED'; b.className = 'su-badge on'; } else { b.textContent = 'NOT VERIFIED'; b.className = 'su-badge off'; } }
    function updateEmailBadge() { const b = document.getElementById('su-email-badge'); if (!b) return; if (signupState.emailVerified) { b.textContent = '✓ VERIFIED'; b.className = 'su-badge on'; } else { b.textContent = 'NOT VERIFIED'; b.className = 'su-badge off'; } }

    document.getElementById('ivac-password-toggle')?.addEventListener('click', function(e) { e.stopPropagation(); const inp = document.getElementById('ivac-password'); if (inp) { inp.type = inp.type === 'password' ? 'text' : 'password'; this.innerHTML = inp.type === 'password' ? '👁' : '😎'; } });
    document.getElementById('ivac-btn-signup-stop')?.addEventListener('click', function() { signupState.stopRequested = true; try { stopSmsFetcher('signup stop'); } catch(e) {} suMsg('ivac-msg-submit', '⏹ Stopped', 'y'); logStatus('🛑 Signup halted', 'r'); });

    document.getElementById('ivac-btn-mobile')?.addEventListener('click', async function() {
        const phone = (document.getElementById('ivac-mobile')?.value || '').trim(); const email = (document.getElementById('ivac-email')?.value || '').trim();
        if (!phone) { suMsg('ivac-msg-mobile', '❌ Enter mobile number', 'r'); return; } if (!/^01[3-9]\d{8}$/.test(phone)) { suMsg('ivac-msg-mobile', '❌ Invalid BD mobile', 'r'); return; }
        suMsg('ivac-msg-mobile', '⏳ Sending OTP to mobile…', 'y'); logStatus('📱 Sending mobile OTP…', 'y');
        let mobileOtpToken; try { mobileOtpToken = await getCaptchaTokenSmart(); } catch(e) { suMsg('ivac-msg-mobile', `❌ Captcha: ${e.message}`, 'r'); flashButton(this, '✗', 'r'); return; }
        const logId = netLogAdd({ method: 'POST', url: "https://api.ivacbd.com/iams/api/v1/otp/signupOtp", tag: 'signup', state: 'pending', note: 'mobile-otp' });
        try {
            const r = await H2.fetchH2("https://api.ivacbd.com/iams/api/v1/otp/signupOtp", { method: 'POST', headers: { 'accept': 'application/json', 'content-type': 'application/json', 'x-token': mobileOtpToken }, referrer: "https://appointment.ivacbd.com/", body: JSON.stringify({ phone, email, otpChannel: "PHONE" }) });
            let body = null; try { body = await r.json(); } catch(e) {}
            const ok = r.ok && body && (body.successFlag === true || body.statusCode === 200);
            netLogUpdate(logId, { status: r.status, state: ok ? 'ok' : 'fail', note: ok ? `requestId=${body?.data?.requestId?.slice(0,8)||'?'}` : (body?.message || `HTTP ${r.status}`) });
            if (ok) { signupState.mobileRequestId = body?.data?.requestId || body?.requestId || null; suMsg('ivac-msg-mobile', '✅ OTP sent to mobile!', 'g'); logStatus('✅ Mobile OTP sent!', 'g'); flashButton(this, '✓', 'g'); try { announceSuccess('Mobile OTP sent successfully'); } catch(e) {} startSmsFetcher(phone, async (otp) => { const otpInput = document.getElementById('ivac-mobile-otp'); if (otpInput && !otpInput.value) { otpInput.value = otp; suMsg('ivac-msg-mobile', `📩 Auto OTP: ${otp}`, 'g'); logStatus(`📩 Signup Mobile OTP: ${otp}`, 'g'); } return undefined; }, false, false); }
            else { const msg = body?.message || `HTTP ${r.status}`; suMsg('ivac-msg-mobile', `❌ ${msg}`, 'r'); logStatus(`❌ Mobile OTP failed: ${msg}`, 'r'); flashButton(this, '✗', 'r'); }
        } catch (err) { netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); suMsg('ivac-msg-mobile', `❌ Error: ${err.message}`, 'r'); logStatus(`❌ Mobile OTP error: ${err.message}`, 'r'); flashButton(this, '✗', 'r'); }
    });

    document.getElementById('ivac-btn-get-mobile-otp')?.addEventListener('click', async function() {
        const phone = (document.getElementById('ivac-mobile')?.value || '').trim();
        if (!phone) { suMsg('ivac-msg-mobile', '❌ Enter mobile number first', 'r'); return; }
        suMsg('ivac-msg-mobile', '⏳ Fetching OTP from SMS server…', 'y'); logStatus('📱 Manual OTP fetch for signup…', 'y'); flashButton(this, '⟳', 'y');
        startSmsFetcher(phone, async (otp) => { const otpInput = document.getElementById('ivac-mobile-otp'); if (otpInput) { otpInput.value = otp; otpInput.style.transition = 'background .3s'; otpInput.style.background = 'linear-gradient(180deg,#1a3a1a,#0a2a0a)'; setTimeout(() => { otpInput.style.background = ''; }, 1500); } suMsg('ivac-msg-mobile', `📩 OTP: ${otp}`, 'g'); logStatus(`📩 Signup OTP fetched: ${otp}`, 'g'); return undefined; }, true, true);
    });

    document.getElementById('ivac-btn-mobile-verify')?.addEventListener('click', async function() {
        const otp = (document.getElementById('ivac-mobile-otp')?.value || '').trim(); const phone = (document.getElementById('ivac-mobile')?.value || '').trim();
        if (!otp) { suMsg('ivac-msg-mobile', '❌ Enter OTP first', 'r'); return; } if (!/^\d{4,8}$/.test(otp)) { suMsg('ivac-msg-mobile', '❌ Invalid OTP', 'r'); return; } if (!phone) { suMsg('ivac-msg-mobile', '❌ Enter mobile first', 'r'); return; } if (!signupState.mobileRequestId) { suMsg('ivac-msg-mobile', '❌ No requestId — click Mobile first', 'r'); return; }
        suMsg('ivac-msg-mobile', '⏳ Verifying mobile OTP…', 'y'); logStatus('🔓 Verifying mobile OTP…', 'y');
        let mobileVerifyToken; try { mobileVerifyToken = await getCaptchaTokenSmart(); } catch(e) { suMsg('ivac-msg-mobile', `❌ Captcha: ${e.message}`, 'r'); flashButton(this, '✗', 'r'); return; }
        const logId = netLogAdd({ method: 'POST', url: "https://api.ivacbd.com/iams/api/v1/otp/verify-otp", tag: 'signup', state: 'pending', note: `verify-mobile ${otp}` });
        try {
            const r = await H2.fetchH2("https://api.ivacbd.com/iams/api/v1/otp/verify-otp", { method: 'POST', headers: { 'accept': 'application/json, text/plain, */*', 'content-type': 'application/json', 'x-token': mobileVerifyToken }, referrer: "https://appointment.ivacbd.com/", body: JSON.stringify({ requestId: signupState.mobileRequestId, phone: phone, code: otp, otpChannel: "PHONE" }) });
            let body = null; try { body = await r.json(); } catch(e) {}
            const verified = r.ok && body && (body.successFlag === true || body.message === 'Success' || body.statusCode === 200);
            netLogUpdate(logId, { status: r.status, state: verified ? 'ok' : 'fail', note: verified ? 'mobile verified' : (body?.message || `HTTP ${r.status}`) });
            if (verified) { signupState.mobileVerified = true; updateMobileBadge(); suMsg('ivac-msg-mobile', '✅ Mobile verified!', 'g'); logStatus('✅ Mobile verified!', 'g'); flashButton(this, '✓', 'g'); try { stopSmsFetcher('mobile verified'); announceSuccess('Mobile verified successfully'); } catch(e) {} }
            else { const msg = body?.message || `HTTP ${r.status}`; suMsg('ivac-msg-mobile', `❌ ${msg}`, 'r'); logStatus(`❌ Mobile verify failed: ${msg}`, 'r'); flashButton(this, '✗', 'r'); }
        } catch (err) { netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); suMsg('ivac-msg-mobile', `❌ Error: ${err.message}`, 'r'); logStatus(`❌ Mobile verify error: ${err.message}`, 'r'); flashButton(this, '✗', 'r'); }
    });

    document.getElementById('ivac-btn-email')?.addEventListener('click', async function() {
        const email = (document.getElementById('ivac-email')?.value || '').trim();
        if (!email) { suMsg('ivac-msg-email', '❌ Enter email', 'r'); return; } if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { suMsg('ivac-msg-email', '❌ Invalid email', 'r'); return; }
        suMsg('ivac-msg-email', '⏳ Sending OTP to email…', 'y'); logStatus('📧 Sending email OTP…', 'y');
        let emailOtpToken; try { emailOtpToken = await getCaptchaTokenSmart(); } catch(e) { suMsg('ivac-msg-email', `❌ Captcha: ${e.message}`, 'r'); flashButton(this, '✗', 'r'); return; }
        const logId = netLogAdd({ method: 'POST', url: "https://api.ivacbd.com/iams/api/v1/otp/signupOtp", tag: 'signup', state: 'pending', note: 'email-otp' });
        try {
            const r = await H2.fetchH2("https://api.ivacbd.com/iams/api/v1/otp/signupOtp", { method: 'POST', headers: { 'accept': 'application/json, text/plain, */*', 'content-type': 'application/json', 'cache-control': 'no-cache, no-store, must-revalidate', 'pragma': 'no-cache', 'x-token': emailOtpToken }, referrer: "https://appointment.ivacbd.com/", body: JSON.stringify({ email, otpChannel: "EMAIL" }) });
            let body = null; try { body = await r.json(); } catch(e) {}
            const ok = r.ok && body && (body.successFlag === true || body.statusCode === 200);
            netLogUpdate(logId, { status: r.status, state: ok ? 'ok' : 'fail', note: ok ? `requestId=${body?.data?.requestId?.slice(0,8)||'?'}` : (body?.message || `HTTP ${r.status}`) });
            if (ok) { signupState.emailRequestId = body?.data?.requestId || body?.requestId || null; suMsg('ivac-msg-email', '✅ OTP sent to email!', 'g'); logStatus('✅ Email OTP sent!', 'g'); flashButton(this, '✓', 'g'); try { announceSuccess('Email OTP sent successfully'); } catch(e) {} }
            else { const msg = body?.message || `HTTP ${r.status}`; suMsg('ivac-msg-email', `❌ ${msg}`, 'r'); logStatus(`❌ Email OTP failed: ${msg}`, 'r'); flashButton(this, '✗', 'r'); }
        } catch (err) { netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); suMsg('ivac-msg-email', `❌ Error: ${err.message}`, 'r'); logStatus(`❌ Email OTP error: ${err.message}`, 'r'); flashButton(this, '✗', 'r'); }
    });

    document.getElementById('ivac-btn-get-email-otp')?.addEventListener('click', function() { suMsg('ivac-msg-email', '⚠ Email OTP auto-fetch not implemented yet', 'y'); logStatus('⚠ Email OTP fetch — coming soon', 'y'); flashButton(this, '?', 'y'); });

    document.getElementById('ivac-btn-email-verify')?.addEventListener('click', async function() {
        const otp = (document.getElementById('ivac-email-otp')?.value || '').trim(); const email = (document.getElementById('ivac-email')?.value || '').trim();
        if (!otp) { suMsg('ivac-msg-email', '❌ Enter OTP first', 'r'); return; } if (!/^\d{4,8}$/.test(otp)) { suMsg('ivac-msg-email', '❌ Invalid OTP', 'r'); return; } if (!email) { suMsg('ivac-msg-email', '❌ Enter email first', 'r'); return; } if (!signupState.emailRequestId) { suMsg('ivac-msg-email', '❌ No requestId — click Email first', 'r'); return; }
        suMsg('ivac-msg-email', '⏳ Verifying email OTP…', 'y'); logStatus('🔓 Verifying email OTP…', 'y');
        let emailVerifyToken; try { emailVerifyToken = await getCaptchaTokenSmart(); } catch(e) { suMsg('ivac-msg-email', `❌ Captcha: ${e.message}`, 'r'); flashButton(this, '✗', 'r'); return; }
        const logId = netLogAdd({ method: 'POST', url: "https://api.ivacbd.com/iams/api/v1/otp/verify-otp", tag: 'signup', state: 'pending', note: `verify-email ${otp}` });
        try {
            const r = await H2.fetchH2("https://api.ivacbd.com/iams/api/v1/otp/verify-otp", { method: 'POST', headers: { 'accept': 'application/json, text/plain, */*', 'content-type': 'application/json', 'x-token': emailVerifyToken }, referrer: "https://appointment.ivacbd.com/", body: JSON.stringify({ requestId: signupState.emailRequestId, email: email, code: otp, otpChannel: "EMAIL" }) });
            let body = null; try { body = await r.json(); } catch(e) {}
            const verified = r.ok && body && (body.successFlag === true || body.message === 'Success' || body.statusCode === 200);
            netLogUpdate(logId, { status: r.status, state: verified ? 'ok' : 'fail', note: verified ? 'email verified' : (body?.message || `HTTP ${r.status}`) });
            if (verified) { signupState.emailVerified = true; updateEmailBadge(); suMsg('ivac-msg-email', '✅ Email verified!', 'g'); logStatus('✅ Email verified!', 'g'); flashButton(this, '✓', 'g'); try { announceSuccess('Email verified successfully'); } catch(e) {} }
            else { const msg = body?.message || `HTTP ${r.status}`; suMsg('ivac-msg-email', `❌ ${msg}`, 'r'); logStatus(`❌ Email verify failed: ${msg}`, 'r'); flashButton(this, '✗', 'r'); }
        } catch (err) { netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); suMsg('ivac-msg-email', `❌ Error: ${err.message}`, 'r'); logStatus(`❌ Email verify error: ${err.message}`, 'r'); flashButton(this, '✗', 'r'); }
    });

    // ==================== SIGNUP: ACCOUNT REGISTRATION (direct, no conditions) ====================
    document.getElementById('ivac-btn-submit-info')?.addEventListener('click', async function() {
        const btn = this;
        const phone     = (document.getElementById('ivac-mobile')?.value || '').trim();
        const email     = (document.getElementById('ivac-email')?.value || '').trim();
        const dobRaw    = (document.getElementById('ivac-dob')?.value || '').trim();
        const passport  = (document.getElementById('ivac-passport')?.value || '').trim();
        const nid       = (document.getElementById('ivac-nid')?.value || '').trim();
        const surName   = (document.getElementById('ivac-surname')?.value || '').trim();
        const givenName = (document.getElementById('ivac-given-name')?.value || '').trim();
        const password  = document.getElementById('ivac-password')?.value || '';

        // DOB -> ISO. DD.MM.YYYY or YYYY-MM-DD; otherwise sent as typed.
        let dob = dobRaw;
        const m = dobRaw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (m) { try { dob = new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00.000Z`).toISOString(); } catch(e) {} }
        else if (/^\d{4}-\d{2}-\d{2}/.test(dobRaw)) { try { dob = new Date(dobRaw).toISOString(); } catch(e) {} }

        suMsg('ivac-msg-submit', '⏳ Submitting…', 'y');
        logStatus(`📝 Account Registration → ${email || phone}`, 'y');
        let signupToken; try { signupToken = await getCaptchaTokenSmart(); } catch(e) { suMsg('ivac-msg-submit', `❌ Captcha: ${e.message}`, 'r'); flashButton(btn, '✗', 'r'); return; }
        const signupBody = { phone, email, nid, passport, givenName, surName, dob, password };
        console.log('[RJ Signup] Request body:', { ...signupBody, password: '***' });
        const logId = netLogAdd({ method: 'POST', url: API_SIGNUP, tag: 'signup', state: 'pending', note: 'account-registration' });
        try {
            const response = await H2.fetchH2(API_SIGNUP, {
                method: 'POST',
                headers: { 'accept': 'application/json, text/plain, */*', 'content-type': 'application/json', 'x-token': signupToken },
                referrer: API_REFERRER,
                body: JSON.stringify(signupBody)
            });
            let body; try { body = await response.json(); } catch(e) { body = { message: 'Invalid response from server' }; }
            const ok = response.ok && (body.successFlag === true || body.statusCode === 200 || body.statusCode === 201);
            netLogUpdate(logId, { status: response.status, state: ok ? 'ok' : 'fail', note: body?.message || `HTTP ${response.status}` });
            if (ok) {
                suMsg('ivac-msg-submit', `✅ ${body.message || 'Created'}`, 'g');
                logStatus(`✅ Account created: ${email || phone}`, 'g'); flashButton(btn, '✓', 'g');
                try { showMilestonePopup('Account Created', `Signup successful for ${email || phone}`, '🎉'); } catch(e) {} try { announceSuccess('Account created successfully'); } catch(e) {}
                try { const prof = profiles[activeProfileName]; if (prof) { if (!prof.phone1) prof.phone1 = phone; if (!prof.email) prof.email = email; if (!prof.mobilePass) prof.mobilePass = password; if (!prof.name && (givenName||surName)) prof.name = `${givenName} ${surName}`.trim(); persistProfiles(); } } catch(e) {}
            } else {
                const msg = body?.message || body?.error || `HTTP ${response.status}`;
                suMsg('ivac-msg-submit', `❌ ${msg}`, 'r'); logStatus(`❌ Signup failed: ${msg}`, 'r'); flashButton(btn, '✗', 'r');
            }
        } catch (err) {
            netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message });
            suMsg('ivac-msg-submit', `❌ Error: ${err.message}`, 'r'); logStatus(`❌ Signup error: ${err.message}`, 'r'); flashButton(btn, '✗', 'r');
        }
    });

    document.querySelectorAll('#p .t[data-t="s"]').forEach(t => { t.addEventListener('click', () => { setTimeout(() => { const prof = profiles[activeProfileName] || {}; const fields = { 'ivac-mobile': prof.phone1 || '', 'ivac-email': prof.email || '', 'ivac-surname': (() => { const p = (prof.name||'').split(' '); return p.length > 1 ? p.slice(-1)[0] : prof.name || ''; })(), 'ivac-given-name': (() => { const p = (prof.name||'').split(' '); return p.length > 1 ? p.slice(0,-1).join(' ') : ''; })(), 'ivac-password': prof.mobilePass || '' }; Object.entries(fields).forEach(([id, val]) => { const el = document.getElementById(id); if (el && !el.value && val) el.value = val; }); }, 50); }); });

    document.getElementById('pl-button')?.addEventListener('click', () => { window.open('https://appointment.ivacbd.com/appointment/time-slot', '_blank'); });

// ==================== ADVANCE (FORGOT) LOGIN PIPELINE (H2) ====================
const advanceState = { requestId: null, forgotPhone: null, signinPhone: null, otp: null, bearerToken: null, running: false };
function resetAdvanceState() { advanceState.requestId = null; advanceState.forgotPhone = null; advanceState.signinPhone = null; advanceState.otp = null; advanceState.bearerToken = null; advanceState.running = false; }
function getAdvanceProfileData() { const p = profiles[activeProfileName] || {}; return { phone1: (p.phone1||'').trim(), phone2: (p.phone2||'').trim(), email: (p.email||'').trim(), password: p.mobilePass || '' }; }
function swapLoginPhoneField(value, placeholder, kind) { const inp = document.getElementById('login-phone'); if (!inp) return; inp.type = (kind === 'email') ? 'email' : 'tel'; inp.placeholder = placeholder; inp.value = value; inp.style.transition = 'box-shadow .4s'; inp.style.boxShadow = '0 0 0 2px rgba(167,139,250,.6)'; setTimeout(() => { inp.style.boxShadow = ''; }, 800); }

async function forgotStep1_sendOtp(signal) {
    const prof = getAdvanceProfileData(); let captchaToken; try { captchaToken = await getCaptchaTokenSmart(); } catch(e) { logStatus(`✗ Captcha: ${e.message}`, 'r'); return { win: false }; }
    if (raceCoord.hasWon('advance')) { if (captchaToken) tokenQueueAddTagged(captchaToken, 'turnstile'); return { win: false, cancelled: true }; }
    logStatus(`📧 [1/4] Forgot OTP for ${prof.email}…`, 'y');
    const localAc = new AbortController(); const onParentAbort = () => { try { localAc.abort(); } catch(e) {} }; signal?.addEventListener('abort', onParentAbort); registerTokenInFlight(captchaToken, localAc);
    const logId = netLogAdd({ method: 'POST', url: API_FORGOT, tag: 'advance', state: 'pending' });
    try {
        const r = await H2.fetchH2(API_FORGOT, { method: 'POST', signal: localAc.signal, headers: { 'accept': 'application/json', 'content-type': 'application/json', 'x-device-id': getDeviceId() }, referrer: API_REFERRER, body: JSON.stringify({ email: prof.email, otpChannel: 'PHONE', c: encTokenForCall(captchaToken, 'signin') }) });
        const body = await r.json().catch(() => ({}));
        const burn = shouldBurnToken(r.status, body); if (burn) tokenQueueInvalidate(captchaToken); else unregisterTokenInFlight(captchaToken, localAc);
        const ok = r.ok && (body.successFlag === true || body.statusCode === 200);
        netLogUpdate(logId, { status: r.status, state: ok ? 'ok' : 'fail' });
        if (!ok || !body.data?.requestId) { logStatus(`❌ [1/4] Forgot failed: ${body.message || `HTTP ${r.status}`}`, 'r'); return { win: false }; }
        if (raceCoord.hasWon('advance')) return { win: false, cancelled: true };
        raceCoord.declareWin('advance', { win: true }); advanceState.requestId = body.data.requestId;
        logStatus(`✅ [1/4] Forgot OTP sent → Phone 2`, 'g'); swapLoginPhoneField(prof.phone2, 'Phone 2', 'tel'); startOtpTimer('advanceOtp'); return { win: true };
    } catch (err) { if (err.name === 'AbortError') netLogUpdate(logId, { state: 'cancel', status: '⊘' }); else netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); return { win: false, cancelled: err.name === 'AbortError' }; } finally { try { signal?.removeEventListener('abort', onParentAbort); } catch(e) {} try { unregisterTokenInFlight(captchaToken, localAc); } catch(e) {} }
}

async function forgotStep2_fetchOtp() {
    const prof = getAdvanceProfileData(); logStatus(`📱 [2/4] Fetching OTP…`, 'y'); const otpInp = document.getElementById('login-otp'); if (otpInp) otpInp.value = '';
    const otp = await new Promise((resolve) => { startSmsFetcher(prof.phone2, async (fetchedOtp) => { resolve(fetchedOtp); return undefined; }, false, false); setTimeout(() => resolve(null), 150 * 1000); });
    if (!otp) { logStatus(`❌ [2/4] No OTP received`, 'r'); return { win: false }; }
    advanceState.otp = otp; logStatus(`✅ [2/4] OTP: ${otp}`, 'g'); try { announceSuccess('OTP received'); } catch(e) {} swapLoginPhoneField(prof.phone1, 'Phone 1', 'tel'); return { win: true };
}

async function forgotStep3_signin(signal) {
    const prof = getAdvanceProfileData(); let captchaToken; try { captchaToken = await getCaptchaTokenSmart(); } catch(e) { logStatus(`✗ [3/4] Captcha: ${e.message}`, 'r'); return { win: false }; }
    if (raceCoord.hasWon('signin')) { if (captchaToken) tokenQueueAddTagged(captchaToken, 'turnstile'); return { win: false, cancelled: true }; }
    const localAc = new AbortController(); const onParentAbort = () => { try { localAc.abort(); } catch(e) {} }; signal?.addEventListener('abort', onParentAbort); registerTokenInFlight(captchaToken, localAc);
    logStatus(`🔑 [3/4] Signin for ${prof.phone1}…`, 'y');
    try {
        const { ok, status, body } = await performSignin(prof.phone1, prof.password, captchaToken);
        const burn = shouldBurnToken(status, body); if (burn) tokenQueueInvalidate(captchaToken); else unregisterTokenInFlight(captchaToken, localAc);
        if (!ok || !body?.data?.accessToken) { logStatus(`❌ [3/4] Signin failed: ${body?.message || `HTTP ${status}`}`, 'r'); return { win: false }; }
        if (raceCoord.hasWon('signin')) return { win: false, cancelled: true };
        raceCoord.declareWin('signin', { win: true, data: body });
        advanceState.bearerToken = body.data.accessToken; saveSession(body.data, prof.phone1); sessionState.requestId = advanceState.requestId; persistSession(); logStatus(`✅ [3/4] Signin done`, 'g'); return { win: true };
    } catch (err) { if (err.name === 'AbortError') return { win: false, cancelled: true }; logStatus(`❌ [3/4] Signin error: ${err.message}`, 'r'); return { win: false }; } finally { try { signal?.removeEventListener('abort', onParentAbort); } catch(e) {} try { unregisterTokenInFlight(captchaToken, localAc); } catch(e) {} }
}

async function forgotStep4_verify(signal) {
    logStatus(`🔓 [4/4] Verifying…`, 'y'); const logId = netLogAdd({ method: 'POST', url: API_VERIFY, tag: 'verify', state: 'pending' });
    try {
        const r = await H2.fetchH2(API_VERIFY, { method: 'POST', signal, headers: { 'accept': 'application/json, text/plain, */*', 'authorization': `Bearer ${advanceState.bearerToken}`, 'cache-control': 'no-cache, no-store, must-revalidate', 'content-type': 'application/json', 'pragma': 'no-cache' }, referrer: API_REFERRER, body: JSON.stringify({ requestId: advanceState.requestId, phone: advanceState.forgotPhone, code: advanceState.otp, otpChannel: 'PHONE' }) });
        let body = null; try { body = await r.json(); } catch(e) { body = null; }
        const verified = r.status === 404 || (r.ok && body && (body.successFlag === true || body.message === 'Success'));
        netLogUpdate(logId, { status: r.status, state: verified ? 'ok' : 'fail' });
        if (verified) {
            raceCoord.declareWin('verify', { win: true }); logStatus(`🎉 [4/4] Forgot login complete!`, 'g'); try { stopOtpTimer('advanceOtp'); stopOtpTimer('signinOtp'); } catch(e) {} try { stopSmsFetcher('Forgot login complete'); } catch(e) {}
            markSessionVerified(); if (sessionState.loggedInAt) { const expiresAt = sessionState.loggedInAt + TIMER_TOKEN_MS; if (expiresAt - Date.now() > 0) startTokenTimerWithExpiry(expiresAt); }
            showMilestonePopup('Verified', 'OTP Verified successfully!', '✅'); return { win: true };
        } else { logStatus(`❌ [4/4] Verify failed: ${body?.message || `HTTP ${r.status}`}`, 'r'); return { win: false }; }
    } catch (err) { if (err.name === 'AbortError') netLogUpdate(logId, { state: 'cancel', status: '⊘' }); else netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); return { win: false, cancelled: err.name === 'AbortError' }; }
}

const advBtn = document.getElementById('badv-phone');
if (advBtn) {
    advBtn.addEventListener('click', async function() {
        const advTg = document.getElementById('advance-toggle'); if (!advTg?.classList.contains('on')) { logStatus('⚠ Turn ON Advance toggle', 'y'); return; }
        if (advanceState.running) return; resetAdvanceState(); advanceState.running = true; stopFlag.value = false;
        const prof = getAdvanceProfileData(); if (!prof.email || !prof.phone1 || !prof.phone2 || !prof.password) { logStatus('❌ Profile incomplete for Advance', 'r'); advanceState.running = false; return; }
        advanceState.signinPhone = prof.phone1; advanceState.forgotPhone = prof.phone2;
        try {
            const r1 = await runStepSmart('advance', forgotStep1_sendOtp); if (!r1.win) return; if (!isAutoOn()) { logStatus('⏸ Auto OFF — stopped', 'y'); return; }
            const r2 = await forgotStep2_fetchOtp(); if (!r2.win) return; if (!isAutoOn()) return;
            const r3 = await runStepSmart('signin', forgotStep3_signin); if (!r3.win) return; if (!isAutoOn()) return;
            const r4 = await runStepSmart('verify', forgotStep4_verify); if (!r4.win) return;
            logStatus('🎉 Forgot login done! Continuing → Book → Reserve → Initiate', 'g');
            if (!stopFlag.value) { advanceState.running = false; await startPipelineFrom('book'); }
        } catch(e) { logStatus(`❌ Advance error: ${e.message}`, 'r'); } finally { advanceState.running = false; }
    });
}

// ==================== SMS OTP AUTO-FETCHER ====================
const SMS_FIRST_DELAY_MS = 4000; const SMS_POLL_INTERVAL_MS = 2000; const SMS_MAX_ATTEMPTS = 40;
const smsFetcher = { active: false, intervalId: null, attempts: 0, usedOtps: new Set(), currentPhone: null, onSuccess: null };

function extractOtpFromResponse(rawText) { if (!rawText) return null; try { const d = JSON.parse(rawText); if (d.status === 'success' && d.otp) { const otpStr = String(d.otp).trim(); if (/^\d{4,8}$/.test(otpStr)) return otpStr; } return null; } catch(e) { return null; } }

async function fetchSmsOnce(phone) {
    if (!phone) return null; const cleanPhone = String(phone).replace(/[^0-9]/g, ''); const url = `${API_SMS_SERVER}?action=get_latest_otp&mobile_no=${cleanPhone}`;
    const logId = netLogAdd({ method: 'GET', url, tag: 'sms', state: 'pending', note: `SMS poll #${smsFetcher.attempts}` });
    try {
        const r = await pageFetch(url, { method: 'GET', credentials: 'omit' });
        const text = await r.text();
        const otp = extractOtpFromResponse(text);
        netLogUpdate(logId, { state: otp ? 'ok' : 'pending', note: otp ? `OTP: ${otp}` : 'no OTP' });
        return otp;
    } catch(e) {
        return new Promise((resolve) => {
            const gmApi = (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) || (typeof GM !== 'undefined' && GM.xmlHttpRequest);
            if (!gmApi) { netLogUpdate(logId, { state: 'fail' }); resolve(null); return; }
            gmApi({ method: 'GET', url, timeout: 8000, onload: (response) => { const otp = extractOtpFromResponse(response.responseText || ''); netLogUpdate(logId, { state: otp ? 'ok' : 'pending', note: otp ? `OTP: ${otp}` : 'no OTP' }); resolve(otp); }, onerror: () => { netLogUpdate(logId, { state: 'fail' }); resolve(null); }, ontimeout: () => { netLogUpdate(logId, { state: 'fail', note: 'timeout' }); resolve(null); } });
        });
    }
}

function stopSmsFetcher(reason) { if (smsFetcher.intervalId) { clearInterval(smsFetcher.intervalId); smsFetcher.intervalId = null; } if (smsFetcher.active) { smsFetcher.active = false; logStatus(`📱 SMS stopped: ${reason}`, 'y'); } }

async function smsPollTick() {
    if (!smsFetcher.active) return; if (smsFetcher.attempts >= SMS_MAX_ATTEMPTS) { stopSmsFetcher('timeout'); return; } smsFetcher.attempts++;
    const otp = await fetchSmsOnce(smsFetcher.currentPhone); if (!otp) return; if (smsFetcher.usedOtps.has(otp)) return;
    smsFetcher.usedOtps.add(otp); const otpInput = document.getElementById('login-otp');
    if (otpInput) { otpInput.value = otp; otpInput.style.transition = 'background .3s'; otpInput.style.background = 'linear-gradient(180deg,#1a3a1a,#0a2a0a)'; setTimeout(() => { otpInput.style.background = ''; }, 1500); }
    logStatus(`📩 OTP received: ${otp}`, 'g'); try { announceSuccess('OTP received'); } catch(e) {}
    smsFetcher.active = false; if (smsFetcher.intervalId) { clearInterval(smsFetcher.intervalId); smsFetcher.intervalId = null; }
    if (typeof smsFetcher.onSuccess === 'function') { try { await smsFetcher.onSuccess(otp); } catch(e) {} }
}

function startSmsFetcher(phone, onSuccessCallback, keepUsed = false, instant = false) {
    if (smsFetcher.intervalId) { clearInterval(smsFetcher.intervalId); smsFetcher.intervalId = null; } if (!keepUsed) smsFetcher.usedOtps.clear(); smsFetcher.attempts = 0; smsFetcher.active = true; smsFetcher.currentPhone = phone; smsFetcher.onSuccess = onSuccessCallback;
    const delay = instant ? 0 : (keepUsed ? 1000 : SMS_FIRST_DELAY_MS);
    if (delay > 0) logStatus(`📱 SMS fetcher in ${delay/1000}s…`, 'y'); else logStatus(`📱 SMS fetcher starting…`, 'y');
    setTimeout(async () => { if (!smsFetcher.active) return; await smsPollTick(); if (smsFetcher.active) { smsFetcher.intervalId = setInterval(smsPollTick, SMS_POLL_INTERVAL_MS); } }, delay);
}

document.getElementById('botp')?.addEventListener('click', function() {
    const phone = sessionState.phone || document.getElementById('login-phone')?.value?.trim();
    if (!phone) { logStatus('❌ No phone number', 'r'); return; }
    flashButton(this, '⟳', 'y'); logStatus(`📱 Manual OTP fetch for ${phone}…`, 'y');
    startSmsFetcher(phone, async (otp) => { const verifyBtn = document.getElementById('bve'); if (verifyBtn) verifyBtn.click(); return undefined; }, false, true);
});

// ==================== SLOT DUTY WATCHER (H2) ====================
const SLOT_CHECK_INTERVAL_MS = 10 * 1000;
const slotDuty = { active: false, intervalId: null, chainRunning: false };

async function checkSlotStatus() {
    if (!sessionState.accessToken) return null;
    const logId = netLogAdd({ method: 'GET', url: API_SLOT_STATUS, tag: 'slot', state: 'pending' });
    try {
        const r = await H2.fetchH2(API_SLOT_STATUS, { method: 'GET', headers: { 'accept': 'application/json', 'authorization': `Bearer ${sessionState.accessToken}` } });
        let body = null; try { body = await r.json(); } catch(e) {} const ok = r.ok && body?.statusCode === 200 && body?.successFlag === true;
        if (!ok) { netLogUpdate(logId, { status: r.status, state: 'fail' }); return null; }
        netLogUpdate(logId, { status: r.status, state: body.data?.slotOpen ? 'ok' : 'pending', note: body.data?.slotOpen ? '✅ OPEN' : '⏳ closed' }); return body.data;
    } catch (err) { netLogUpdate(logId, { state: 'fail', note: err.message }); return null; }
}

async function slotDutyTick() {
    if (!slotDuty.active || slotDuty.chainRunning || pipelineRunning) return;
    const data = await checkSlotStatus(); if (!data || !data.slotOpen) return;
    logStatus(`🎯 SLOT OPENED!`, 'g'); slotDuty.chainRunning = true;
    try { stopFlag.value = false; resetAllStepStatus(); setStepStatus('book', 'active'); const bRes = await runStepSmart('book', stepBook); if (!bRes.win || stopFlag.value) return; setStepStatus('reserve', 'active'); const rRes = await runStepSmart('reserve', stepReserve); if (!rRes.win || stopFlag.value) return; setStepStatus('initiate', 'active'); const iRes = await runStepSmart('initiate', stepInitiate); if (iRes.win) { logStatus('🎉 Slot duty COMPLETE!', 'g'); stopSlotDuty('complete'); document.getElementById('reserve-toggle')?.classList.remove('on'); } } finally { slotDuty.chainRunning = false; }
}

function startSlotDuty() { if (slotDuty.intervalId) clearInterval(slotDuty.intervalId); slotDuty.active = true; slotDuty.chainRunning = false; logStatus('🛡 Slot duty ON', 'g'); slotDutyTick(); slotDuty.intervalId = setInterval(slotDutyTick, SLOT_CHECK_INTERVAL_MS); }
function stopSlotDuty(reason) { if (slotDuty.intervalId) { clearInterval(slotDuty.intervalId); slotDuty.intervalId = null; } if (slotDuty.active) { slotDuty.active = false; logStatus(`🛡 Slot duty OFF${reason ? ' ('+reason+')' : ''}`, 'y'); } }

document.getElementById('reserve-toggle')?.addEventListener('click', () => { setTimeout(() => { const isOn = document.getElementById('reserve-toggle')?.classList.contains('on'); if (isOn) startSlotDuty(); else stopSlotDuty('toggle off'); }, 50); });

// ==================== NETWORK LOG SYSTEM ====================
const NET_LOG_MAX = 200; const NET_LOG_AUTO_CLEAR_MS = 3 * 60 * 1000; const netLog = []; let netLogAutoStart = Date.now(); let netLogFilter = '';
function renderNetLog() { const body = document.getElementById('netlog-body'); const stats = document.getElementById('netlog-stats'); if (!body || !stats) return; const list = netLogFilter ? netLog.filter(e => (e.tag||'').toLowerCase() === netLogFilter) : netLog; if (!list.length) { body.innerHTML = '<div class="nl-empty">No network activity yet.</div>'; } else { body.innerHTML = list.slice().reverse().map(e => { const stCls = e.state || 'pending'; const stTxt = e.status || (e.state === 'pending' ? '…' : '?'); const tag = e.tag ? `<span class="nl-tag">${e.tag}</span>` : ''; return `<div class="nl-entry ${stCls}"><span class="nl-time">${e.time}</span><span class="nl-method">${e.method}</span><span class="nl-status ${stCls}">${stTxt}</span><span class="nl-url">${tag}${e.note || e.url || ''}</span></div>`; }).join(''); } const elapsed = Math.max(0, NET_LOG_AUTO_CLEAR_MS - (Date.now() - netLogAutoStart)); const m = Math.floor(elapsed / 60000), s = Math.floor((elapsed % 60000) / 1000); stats.textContent = `${netLog.length} entries • auto-clear in ${m}:${String(s).padStart(2,'0')}`; }
function netLogAdd(entry) { entry.id = Date.now() + '-' + Math.random().toString(36).slice(2,7); entry.time = new Date().toLocaleTimeString('en-US', { hour12: false }); netLog.push(entry); if (netLog.length > NET_LOG_MAX) netLog.shift(); renderNetLog(); return entry.id; }
function netLogUpdate(id, patch) { const e = netLog.find(x => x.id === id); if (!e) return; Object.assign(e, patch); renderNetLog(); }
function netLogClear() { netLog.length = 0; netLogAutoStart = Date.now(); renderNetLog(); }
setInterval(() => { if (Date.now() - netLogAutoStart >= NET_LOG_AUTO_CLEAR_MS) netLogClear(); }, 1000);

document.getElementById('netlog-filter')?.addEventListener('change', e => { netLogFilter = e.target.value; renderNetLog(); });
document.getElementById('netlog-clear')?.addEventListener('click', () => { netLogClear(); });
document.getElementById('netlog-close')?.addEventListener('click', () => { document.getElementById('rj-netlog')?.classList.remove('open'); });

(() => { const np = document.getElementById('rj-netlog'); const handle = document.getElementById('netlog-drag'); if (!np || !handle) return; let dragging = false, sx, sy, ol, ot; handle.addEventListener('mousedown', e => { if (e.target.closest('button') || e.target.closest('select')) return; const r = np.getBoundingClientRect(); dragging = true; sx = e.clientX; sy = e.clientY; ol = r.left; ot = r.top; np.style.left = ol + 'px'; np.style.top = ot + 'px'; np.style.right = 'auto'; np.style.bottom = 'auto'; e.preventDefault(); }); document.addEventListener('mousemove', e => { if (!dragging) return; np.style.left = (ol + e.clientX - sx) + 'px'; np.style.top = (ot + e.clientY - sy) + 'px'; }); document.addEventListener('mouseup', () => { dragging = false; }); })();

(() => { const oldFn = document.getElementById('fn'); if (!oldFn) return; const fresh = oldFn.cloneNode(true); oldFn.parentNode.replaceChild(fresh, oldFn); fresh.addEventListener('click', () => { const p = document.getElementById('rj-netlog'); if (!p) return; p.classList.toggle('open'); renderNetLog(); }); })();

// ==================== TOKEN QUEUE ====================
const TOKEN_TTL_MS = 1.5 * 60 * 1000; const TOKEN_QUEUE_MAX = 5; const tokenQueue = [];
function tokenQueueAddTagged(token, source) { if (!token) return; if (tokenQueue.some(t => t.token === token)) return; tokenQueue.push({ token, source: source || 'unknown', createdAt: Date.now() }); if (tokenQueue.length > TOKEN_QUEUE_MAX) tokenQueue.shift(); }
function tokenQueueCleanExpired() { const now = Date.now(); for (let i = tokenQueue.length - 1; i >= 0; i--) { if (now - tokenQueue[i].createdAt > TOKEN_TTL_MS) tokenQueue.splice(i, 1); } }
function tokenQueueGet() { tokenQueueCleanExpired(); return tokenQueue.length ? tokenQueue[0].token : null; }
function tokenQueueConsume() { tokenQueueCleanExpired(); return tokenQueue.length ? tokenQueue.shift().token : null; }

const tokenInFlight = new Map();
function registerTokenInFlight(token, controller) { if (!token || !controller) return; let set = tokenInFlight.get(token); if (!set) { set = new Set(); tokenInFlight.set(token, set); } set.add(controller); }
function unregisterTokenInFlight(token, controller) { if (!token || !controller) return; const set = tokenInFlight.get(token); if (!set) return; set.delete(controller); if (set.size === 0) tokenInFlight.delete(token); }
function abortAllUsingToken(token) { const set = tokenInFlight.get(token); if (!set || set.size === 0) return 0; const count = set.size; const controllers = Array.from(set); tokenInFlight.delete(token); controllers.forEach(c => { try { c.abort(); } catch(e) {} }); return count; }

function shouldBurnToken(status, body) { if (!status) return false; if (status >= 500 && status < 600) { return !!(body && (body.message || body.data || body.error || body.successFlag !== undefined)); } if (status === 429) return false; return true; }

function tokenQueueInvalidate(token) {
    const i = tokenQueue.findIndex(t => t.token === token); if (i === -1) { abortAllUsingToken(token); return; } const removed = tokenQueue.splice(i, 1)[0];
    abortAllUsingToken(token);
    const isApiMode = document.getElementById('captcha-toggle')?.classList.contains('on');
    if (!isApiMode && removed.source === 'turnstile') { setTimeout(() => { const turnstileCount = tokenQueue.filter(t => t.source === 'turnstile').length; if (turnstileCount >= TOKEN_QUEUE_MAX) return; if (cfWidgetId === null || typeof turnstile === 'undefined' || cfToken) return; try { turnstile.reset(cfWidgetId); cfToken = null; } catch(e) {} }, 500); }
}

let captchaSolvingCount = 0; let captchaSolvingSource = null;
function markSolveStart(source) { captchaSolvingCount++; captchaSolvingSource = source; renderTokenQueue(); }
function markSolveEnd() { captchaSolvingCount = Math.max(0, captchaSolvingCount - 1); if (captchaSolvingCount === 0) captchaSolvingSource = null; renderTokenQueue(); }

setInterval(() => {
    try {
        if (cfToken) {
            if (Date.now() - cfTokenAt > TOKEN_TTL_MS) {
                // this widget token is too old (the underlying Cloudflare token has expired) — drop it
                // and mint a fresh one, otherwise cfToken stays non-null and blocks all refills.
                cfToken = null;
                const useApi = document.getElementById('captcha-toggle')?.classList.contains('on');
                if (!useApi && cfWidgetId !== null && typeof turnstile !== 'undefined') { try { turnstile.reset(cfWidgetId); } catch(e) {} }
            } else {
                tokenQueueAddTagged(cfToken, 'turnstile');   // still fresh — keep it queued
            }
        }
    } catch(e) {}
    tokenQueueCleanExpired();
}, 1000);

const _scriptLoadedAt = Date.now(); let _lastTurnstileReset = 0;
setInterval(() => {
    tokenQueueCleanExpired(); const useApi = document.getElementById('captcha-toggle')?.classList.contains('on'); const wantSource = useApi ? (CAPTCHA_PROVIDERS[getSelectedCaptchaProvider()]?.cssClass || 'capmonster') : 'turnstile'; const matchingCount = tokenQueue.filter(t => t.source === wantSource).length;
    if (useApi) { const provider = getSelectedCaptchaProvider(); const config = CAPTCHA_PROVIDERS[provider]; const providerTag = config ? config.cssClass : 'capmonster'; const matchingProviderCount = tokenQueue.filter(t => t.source === providerTag).length; const gap = TOKEN_QUEUE_MAX - matchingProviderCount - captchaSolvingCount; if (gap > 0) { const hasKey = !!getCaptchaApiKey(provider); if (!hasKey) return; for (let i = 0; i < gap; i++) { (async () => { try { markSolveStart(providerTag); const t = await solveCaptchaByProvider(provider); tokenQueueAddTagged(t, providerTag); } catch (e) { console.log(`[RJ Captcha] ${config?.name || provider} solve error:`, e.message); } finally { markSolveEnd(); } })(); } } }
    // Manual (Turnstile): top up whenever the queue is BELOW max (not only when empty), so a freed
    // slot gets refilled. One reset per tick with a cooldown → fills the gap within a few seconds
    // WITHOUT resetting mid-solve (cfToken guard) so the widget can actually finish solving.
    else { if (matchingCount >= TOKEN_QUEUE_MAX) return; if (Date.now() - _scriptLoadedAt < 15000) return; if (Date.now() - _lastTurnstileReset < 7000) return; if (typeof turnstile === 'undefined' || cfWidgetId === null || cfToken || _renderInFlight) return; try { resetCaptcha(); _lastTurnstileReset = Date.now(); } catch(e) {} }
}, 3000);

function renderTokenQueue() {
    const slotsEl = document.getElementById('tq-slots'); const infoEl = document.getElementById('tq-info'); if (!slotsEl || !infoEl) return; tokenQueueCleanExpired();
    let html = ''; for (let i = 0; i < TOKEN_QUEUE_MAX; i++) { const tok = tokenQueue[i]; if (tok) { const age = Date.now() - tok.createdAt; const isExpiring = (TOKEN_TTL_MS - age) < 30000; html += `<span class="tq-slot ${tok.source}${isExpiring ? ' expiring' : ''}" title="${tok.source} • ${Math.floor(age/1000)}s"></span>`; } else if (captchaSolvingCount > 0 && i === tokenQueue.length) { html += `<span class="tq-slot solving" title="Solving…"></span>`; } else { html += `<span class="tq-slot empty"></span>`; } } slotsEl.innerHTML = html;
    const useApi = document.getElementById('captcha-toggle')?.classList.contains('on'); let info; if (captchaSolvingCount > 0) { info = `${tokenQueue.length}/${TOKEN_QUEUE_MAX} • solving…`; infoEl.classList.add('solving'); } else if (tokenQueue.length === 0) { info = `0/${TOKEN_QUEUE_MAX} • idle (${useApi ? 'API' : 'manual'})`; infoEl.classList.remove('solving'); } else { const provider = getSelectedCaptchaProvider(); const config = CAPTCHA_PROVIDERS[provider]; info = `${tokenQueue.length}/${TOKEN_QUEUE_MAX} • ${useApi ? (config?.name || provider) : 'turnstile'}`; infoEl.classList.remove('solving'); } infoEl.textContent = info;
}
setInterval(renderTokenQueue, 1000); document.getElementById('captcha-toggle')?.addEventListener('click', () => { setTimeout(renderTokenQueue, 50); }); setTimeout(renderTokenQueue, 200);

// Dedicated UPLOAD token pool indicator (mirrors the main queue widget, in the Upload tab)
function renderUploadQueue() {
    const slotsEl = document.getElementById('upq-slots'); const infoEl = document.getElementById('upq-info');
    if (!slotsEl || !infoEl || typeof uploadTokenQueue === 'undefined') return;
    try { uploadQueueClean(); } catch(e) {}
    const MAX = (typeof UPLOAD_Q_MAX === 'number') ? UPLOAD_Q_MAX : 4;
    const solving = (typeof _uploadFillerBusy === 'number') ? _uploadFillerBusy : 0;
    let html = '';
    for (let i = 0; i < MAX; i++) {
        const tok = uploadTokenQueue[i];
        if (tok) { const age = Date.now() - tok.createdAt; const isExp = (TOKEN_TTL_MS - age) < 30000; html += `<span class="tq-slot ${tok.source}${isExp ? ' expiring' : ''}" title="${tok.source} • ${Math.floor(age/1000)}s"></span>`; }
        else if (solving > 0 && i === uploadTokenQueue.length) { html += `<span class="tq-slot solving" title="Solving…"></span>`; }
        else { html += `<span class="tq-slot empty"></span>`; }
    }
    slotsEl.innerHTML = html;
    const useApi = document.getElementById('captcha-toggle')?.classList.contains('on');
    const wants = (typeof _uploadWantsTokens === 'function') ? _uploadWantsTokens() : false;
    let info;
    if (solving > 0) { info = `${uploadTokenQueue.length}/${MAX} • solving…`; infoEl.classList.add('solving'); }
    else { const armed = (typeof _uploadArmed !== 'undefined' && _uploadArmed); infoEl.classList.remove('solving'); info = `${uploadTokenQueue.length}/${MAX} • ${!useApi ? 'manual' : ((wants || armed) ? 'ready' : 'idle')}`; }
    infoEl.textContent = info;
}
setInterval(renderUploadQueue, 1000); setTimeout(renderUploadQueue, 300);

// ==================== CAPTCHA PROVIDERS (SILENT) ====================
const CAPTCHA_PROVIDERS = {
    capmonster: { name: 'CapMonster', createUrl: 'https://api.capmonster.cloud/createTask', resultUrl: 'https://api.capmonster.cloud/getTaskResult', taskType: 'TurnstileTaskProxyless', keyStorage: 'capmonster_api_key', cssClass: 'capmonster' },
    capsolver: { name: 'CapSolver', createUrl: 'https://api.capsolver.com/createTask', resultUrl: 'https://api.capsolver.com/getTaskResult', taskType: 'AntiTurnstileTaskProxyLess', keyStorage: 'capsolver_api_key', cssClass: 'capsolver' },
    '2captcha': { name: '2Captcha', createUrl: 'https://api.2captcha.com/createTask', resultUrl: 'https://api.2captcha.com/getTaskResult', taskType: 'TurnstileTaskProxyless', keyStorage: '2captcha_api_key', cssClass: 'twocaptcha' },
    yescaptcha: { name: 'YesCaptcha', createUrl: 'https://api.yescaptcha.com/createTask', resultUrl: 'https://api.yescaptcha.com/getTaskResult', taskType: 'TurnstileTaskProxyless', keyStorage: 'yescaptcha_api_key', cssClass: 'yescaptcha' }
};

function getSelectedCaptchaProvider() { try { return localStorage.getItem('rj_captcha_provider') || 'capmonster'; } catch(e) { return 'capmonster'; } }
function setSelectedCaptchaProvider(provider) { try { localStorage.setItem('rj_captcha_provider', provider); } catch(e) {} }
function getCaptchaApiKey(provider) {
    provider = provider || getSelectedCaptchaProvider();
    const config = CAPTCHA_PROVIDERS[provider]; if (!config) return '';
    const stored = localStorage.getItem(config.keyStorage) || '';
    const live = document.getElementById('ivac-captcha-api-input')?.value || '';
    return (stored || live).trim();
}

document.getElementById('ivac-captcha-api-input')?.addEventListener('input', (e) => {
    const v = (e.target.value || '').trim();
    if (v) { const provider = getSelectedCaptchaProvider(); const config = CAPTCHA_PROVIDERS[provider]; if (config) localStorage.setItem(config.keyStorage, v); }
});
document.getElementById('ivac-btn-captcha-save')?.addEventListener('click', () => {
    const k = (document.getElementById('ivac-captcha-api-input')?.value || '').trim();
    if (!k) { logStatus('❌ API key empty', 'r'); return; }
    const provider = getSelectedCaptchaProvider(); const config = CAPTCHA_PROVIDERS[provider];
    if (config) { try { localStorage.setItem(config.keyStorage, k); logStatus(`✓ ${config.name} key saved`, 'g'); } catch(e) { logStatus(`❌ Save error`, 'r'); } }
});
document.getElementById('ivac-btn-captcha-reset')?.addEventListener('click', () => {
    const provider = getSelectedCaptchaProvider(); const config = CAPTCHA_PROVIDERS[provider];
    if (config) localStorage.removeItem(config.keyStorage);
    const inp = document.getElementById('ivac-captcha-api-input'); if (inp) inp.value = '';
    logStatus(`⚠ ${config?.name || 'Captcha'} key cleared`, 'y');
});
(() => {
    const provider = getSelectedCaptchaProvider(); const sel = document.getElementById('ivac-captcha-provider-select');
    if (sel) sel.value = provider; const config = CAPTCHA_PROVIDERS[provider];
    if (config) { const savedKey = localStorage.getItem(config.keyStorage) || ''; const inp = document.getElementById('ivac-captcha-api-input'); if (savedKey && inp) inp.value = savedKey; }
})();
document.getElementById('ivac-captcha-provider-select')?.addEventListener('change', (e) => {
    const provider = e.target.value; setSelectedCaptchaProvider(provider);
    const config = CAPTCHA_PROVIDERS[provider];
    if (config) { const savedKey = localStorage.getItem(config.keyStorage) || ''; const inp = document.getElementById('ivac-captcha-api-input'); if (inp) inp.value = savedKey; logStatus(`🔄 Captcha provider: ${config.name}`, 'g'); }
    renderTokenQueue();
});

function silentGMRequest(url, body, timeoutMs) {
    return new Promise((resolve, reject) => {
        const gmApi = (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) || (typeof GM !== 'undefined' && GM.xmlHttpRequest);
        if (!gmApi) { reject(new Error('No GM_xmlhttpRequest available')); return; }
        let completed = false;
        const timeoutId = setTimeout(() => { if (!completed) { completed = true; reject(new Error('Silent captcha request timeout')); } }, timeoutMs || 20000);
        gmApi({
            method: 'POST', url: url, headers: { 'Content-Type': 'application/json' }, data: JSON.stringify(body), timeout: timeoutMs || 20000,
            onload: function(response) { if (completed) return; completed = true; clearTimeout(timeoutId); let parsed; try { parsed = JSON.parse(response.responseText); } catch(e) { reject(new Error('Invalid JSON response')); return; } resolve({ status: response.status, body: parsed }); },
            onerror: function(err) { if (completed) return; completed = true; clearTimeout(timeoutId); reject(new Error('GM network error: ' + (err.error || 'unknown'))); },
            ontimeout: function() { if (completed) return; completed = true; clearTimeout(timeoutId); reject(new Error('GM timeout')); }
        });
    });
}

async function solveCaptchaSilent(provider) {
    provider = provider || getSelectedCaptchaProvider();
    const config = CAPTCHA_PROVIDERS[provider];
    if (!config) throw new Error('Unknown captcha provider: ' + provider);
    const key = getCaptchaApiKey(provider);
    if (!key) throw new Error(`No ${config.name} API key`);
    const websiteURL = API_REFERRER || location.origin + '/';
    let taskId;
    try {
        const createBody = { clientKey: key, task: { type: config.taskType, websiteURL: websiteURL, websiteKey: CF_SITEKEY } };
        const createResponse = await silentGMRequest(config.createUrl, createBody, 15000);
        if (createResponse.body.errorId && createResponse.body.errorId !== 0) { throw new Error(createResponse.body.errorDescription || createResponse.body.errorCode || `${config.name} create error`); }
        taskId = createResponse.body.taskId;
        if (!taskId) throw new Error(`No taskId from ${config.name}`);
    } catch(e) { throw new Error(`${config.name} create: ${e.message}`); }
    await new Promise(r => setTimeout(r, 2000));
    for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
            const resultBody = { clientKey: key, taskId: taskId };
            const pollResponse = await silentGMRequest(config.resultUrl, resultBody, 10000);
            if (pollResponse.body.errorId && pollResponse.body.errorId !== 0) { throw new Error(pollResponse.body.errorDescription || pollResponse.body.errorCode || `${config.name} poll error`); }
            if (pollResponse.body.status === 'ready') {
                const token = pollResponse.body.solution?.token || pollResponse.body.solution?.gRecaptchaResponse;
                if (!token) throw new Error(`No token in ${config.name} solution`);
                console.log(`[RJ Captcha Silent] ${config.name} solved in ${Math.round((Date.now() - (window._captchaStartTime || Date.now()))/1000)}s`);
                return token;
            }
        } catch(e) { if (attempt > 55) throw e; continue; }
    }
    throw new Error(`${config.name} timeout (60s)`);
}

let _captchaSolvingActive = false;
let _lastSilentSolveTime = 0;
const SILENT_SOLVE_COOLDOWN = 500;

async function getCaptchaTokenSmart() {
    // ALWAYS reuse a queued token first (manual turnstile OR API-solved) — at API-call
    // time any valid token in the queue is used, regardless of how it was solved.
    tokenQueueCleanExpired();
    const queuedAny = tokenQueue.find(t => t.token);
    if (queuedAny) { console.log(`[RJ Captcha] Reusing queued token (${queuedAny.source}, ${tokenQueue.length}/${TOKEN_QUEUE_MAX})`); return queuedAny.token; }

    const useApi = document.getElementById('captcha-toggle')?.classList.contains('on');
    if (!useApi) {
        showManualCaptcha();
        for (let i = 0; i < 60; i++) {
            tokenQueueCleanExpired();
            const q = tokenQueue.find(t => t.token);
            if (q) { console.log(`[RJ Captcha] Manual token picked from queue (${q.source})`); return q.token; }
            if (cfToken) { tokenQueueAddTagged(cfToken, 'turnstile'); return cfToken; }
            await new Promise(r => setTimeout(r, 1000));
        }
        throw new Error('Manual captcha not solved within 60s');
    }
    const provider = getSelectedCaptchaProvider();
    const providerTag = CAPTCHA_PROVIDERS[provider]?.cssClass || 'capmonster';
    tokenQueueCleanExpired();
    const reusable = tokenQueue.find(t => t.source === providerTag);
    if (reusable) { console.log(`[RJ Captcha Silent] Using queued token from ${provider}`); return reusable.token; }
    const now = Date.now();
    if (now - _lastSilentSolveTime < SILENT_SOLVE_COOLDOWN) { await new Promise(r => setTimeout(r, SILENT_SOLVE_COOLDOWN - (now - _lastSilentSolveTime))); }
    if (_captchaSolvingActive) {
        let waited = 0;
        while (_captchaSolvingActive && waited < 30000) { await new Promise(r => setTimeout(r, 500)); waited += 500; const queued = tokenQueue.find(t => t.source === providerTag); if (queued) return queued.token; }
    }
    _captchaSolvingActive = true; _lastSilentSolveTime = Date.now(); window._captchaStartTime = Date.now();
    try { markSolveStart(providerTag); const token = await solveCaptchaSilent(provider); tokenQueueAddTagged(token, providerTag); console.log(`[RJ Captcha Silent] Token queued (${tokenQueue.length}/${TOKEN_QUEUE_MAX})`); return token; }
    finally { markSolveEnd(); _captchaSolvingActive = false; }
}

async function solveCaptchaByProvider(provider) { return solveCaptchaSilent(provider); }

// ── FILE-UPLOAD TOKEN: claim a DISTINCT pre-solved token per file ───────────────
// File upload isn't a race, so each file must get its OWN fresh token (never a reused one).
// We CLAIM (remove) the freshest queued token so the next file grabs a different one — instant,
// like the queue, and reuse-proof, like 10.0.5. If the queue is empty we solve live (10.0.5 style).
// Returns the whole queue entry {token, source, createdAt} so a transient failure can re-queue it.
function _requeueTokenEntry(entry) {
    if (!entry || !entry.token) return;
    tokenQueueCleanExpired();
    if (tokenQueue.some(t => t.token === entry.token)) return;
    tokenQueue.push(entry);                              // keep original createdAt (true age)
    if (tokenQueue.length > TOKEN_QUEUE_MAX) tokenQueue.shift();
}

// Tokens currently held by an in-flight upload. A token in this set is NEVER handed to a second
// upload — that concurrent-reuse is the root of the multi-file 503.
const _uploadInUse = new Set();
// Serialise claims so two files can't race into solving/claiming the SAME token.
let _uploadClaimChain = Promise.resolve();

// Release a claimed token after its upload finishes. requeue=true → transient failure, the token
// was never accepted by the server, so return it to the queue for another attempt; otherwise the
// token is spent (success or hard reject) and simply dropped.
function releaseUploadToken(entry, requeue) {
    if (!entry || !entry.token) return;
    _uploadInUse.delete(entry.token);
    // transient failure (bodyless 503/429): the server never accepted this token, so it can be
    // reused for another upload — un-spend it and return it to the DEDICATED upload pool (never the
    // shared queue). Spent/success tokens are just dropped.
    if (requeue) {
        _uploadSpent.delete(entry.token);
        uploadQueueClean();
        if (!uploadTokenQueue.some(t => t.token === entry.token) && (Date.now() - entry.createdAt) < TOKEN_TTL_MS) {
            uploadTokenQueue.push(entry);
            if (uploadTokenQueue.length > UPLOAD_Q_MAX) uploadTokenQueue.shift();
        }
    }
}

function claimFreshUploadToken() {
    // chain onto the previous claim so claims run one-at-a-time (no shared-token race)
    const p = _uploadClaimChain.then(() => _doClaimUploadToken());
    _uploadClaimChain = p.catch(() => {});
    return p;
}
// Every token ever handed to an upload — so the same token is NEVER sent twice, even across files
// or retries. Reusing a token the server has already seen is exactly what returns 503.
const _uploadSpent = new Set();

// ── DEDICATED UPLOAD TOKEN QUEUE ────────────────────────────────────────────
// Upload needs tokens the SERVER HAS NEVER SEEN. The shared tokenQueue is unsafe: signin/verify/
// book/reserve REUSE queued tokens without removing them, so a "queued" token may already be spent
// → 503. So uploads use their OWN pool, solved in the background and consumed ONCE each. Never
// shared with other steps ⇒ no reuse ⇒ no 503, and pre-solved ⇒ instant at click time.
const UPLOAD_Q_MAX = 4;
const uploadTokenQueue = [];                 // [{token, source, createdAt}]
let _uploadFillerBusy = 0;
let _uploadArmed = false;                     // set true on "File Upload Checking" click → start pre-solving early
function uploadQueueClean() { const now = Date.now(); for (let i = uploadTokenQueue.length - 1; i >= 0; i--) { if (now - uploadTokenQueue[i].createdAt > TOKEN_TTL_MS) uploadTokenQueue.splice(i, 1); } }
// Only pre-solve while the user actually intends to upload (a file is selected) so we don't burn
// captcha credits needlessly. API mode only — manual mode solves on demand in the claim path.
function _uploadWantsTokens() { return ['ivac-file-upload', 'ivac-file-upload-2', 'ivac-file-upload-3', 'ivac-file-upload-4'].some(id => (document.getElementById(id)?.files?.length || 0) > 0); }
function uploadQueueFill() {
    try {
        if (!document.getElementById('captcha-toggle')?.classList.contains('on')) return;   // API mode only
        if (!_uploadArmed && !_uploadWantsTokens()) return;   // armed by File-Upload-Checking click OR a selected file
        uploadQueueClean();
        const provider = getSelectedCaptchaProvider();
        if (!getCaptchaApiKey(provider)) return;
        const src = CAPTCHA_PROVIDERS[provider]?.cssClass || 'capmonster';
        const gap = UPLOAD_Q_MAX - uploadTokenQueue.length - _uploadFillerBusy;
        for (let i = 0; i < gap; i++) {
            _uploadFillerBusy++;
            (async () => {
                try { const t = await solveCaptchaByProvider(provider); if (t && !_uploadSpent.has(t) && !uploadTokenQueue.some(x => x.token === t)) uploadTokenQueue.push({ token: t, source: src, createdAt: Date.now() }); }
                catch (e) {}
                finally { _uploadFillerBusy--; }
            })();
        }
    } catch (e) {}
}
setInterval(uploadQueueFill, 3000);

async function _doClaimUploadToken() {
    uploadQueueClean();
    // 1) take a pre-solved, never-used token from the dedicated upload pool (instant)
    for (let i = 0; i < uploadTokenQueue.length; i++) {
        const e = uploadTokenQueue[i];
        if (_uploadSpent.has(e.token) || _uploadInUse.has(e.token)) continue;
        uploadTokenQueue.splice(i, 1);
        _uploadInUse.add(e.token); _uploadSpent.add(e.token);
        console.log(`[RJ Upload] Dedicated token from pool (${e.source}, ${uploadTokenQueue.length} left)`);
        uploadQueueFill();                                   // top the pool back up
        return e;
    }
    // 2) pool empty → solve a dedicated fresh one right now
    const useApi = document.getElementById('captcha-toggle')?.classList.contains('on');
    if (useApi) {
        const provider = getSelectedCaptchaProvider();
        const src = CAPTCHA_PROVIDERS[provider]?.cssClass || 'capmonster';
        for (let tries = 0; tries < 3; tries++) {
            markSolveStart(src);
            let token;
            try { token = await solveCaptchaByProvider(provider); }   // fresh solve, NOT the shared queue
            finally { markSolveEnd(); }
            if (token && !_uploadSpent.has(token) && !_uploadInUse.has(token)) {
                _uploadInUse.add(token); _uploadSpent.add(token);
                console.log(`[RJ Upload] Solved dedicated fresh token (${src})`);
                return { token, source: src, createdAt: Date.now() };
            }
        }
        throw new Error('could not solve a fresh upload token');
    }
    // Manual (Turnstile) mode: force the widget to mint a NEW token, then take one we've never used.
    const before = new Set([...tokenQueue.map(t => t.token), ..._uploadSpent]);
    try { resetCaptcha(); } catch(e) {}
    if (typeof showManualCaptcha === 'function') showManualCaptcha();
    for (let i = 0; i < 90; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const candidate = (cfToken && !before.has(cfToken) && !_uploadSpent.has(cfToken) && !_uploadInUse.has(cfToken))
            ? cfToken
            : (tokenQueue.find(t => t.source === 'turnstile' && !before.has(t.token) && !_uploadSpent.has(t.token) && !_uploadInUse.has(t.token))?.token || null);
        if (candidate) {
            const idx = tokenQueue.findIndex(t => t.token === candidate);
            if (idx !== -1) tokenQueue.splice(idx, 1);            // claim out so no other call reuses it
            _uploadInUse.add(candidate); _uploadSpent.add(candidate);
            console.log('[RJ Upload] Got fresh manual token');
            return { token: candidate, source: 'turnstile', createdAt: Date.now() };
        }
    }
    throw new Error('no fresh manual captcha within 90s');
}

// ==================== RACE COORDINATOR ====================
const raceCoord = {
    _winners: new Map(), _controllers: new Map(),
    reset(stepName) { this._winners.delete(stepName); const set = this._controllers.get(stepName); if (set) { for (const ac of set) { try { ac.abort(); } catch(e) {} } set.clear(); } this._controllers.delete(stepName); },
    resetAll() { for (const k of [...this._winners.keys()]) this.reset(k); },
    track(stepName, ac) { if (this._winners.has(stepName)) { try { ac.abort(); } catch(e) {} return false; } if (!this._controllers.has(stepName)) this._controllers.set(stepName, new Set()); this._controllers.get(stepName).add(ac); return true; },
    untrack(stepName, ac) { this._controllers.get(stepName)?.delete(ac); },
    declareWin(stepName, result) { if (this._winners.has(stepName)) return false; this._winners.set(stepName, result); const set = this._controllers.get(stepName); if (set) { for (const ac of set) { try { ac.abort(); } catch(e) {} } set.clear(); } console.log(`[RJ Race] ★ ${stepName} WON`); return true; },
    hasWon(stepName) { return this._winners.has(stepName); },
    getWinner(stepName) { return this._winners.get(stepName); }
};

// ==================== STOP FLAG + STEP RUNNER ====================
const stopFlag = { value: false };
let _forceStep = false;
let _autoReserveKicked = false;   // date load hole ekbar-i auto-reserve fire korte
const STEP_ORDER = ['signin', 'verify', 'book', 'reserve', 'initiate'];
function isSingleOn()   { return document.getElementById('btn-single')?.classList.contains('b5'); }
function isAutoOn()     { return document.getElementById('btn-auto')?.classList.contains('b5'); }
function isParallelOn() { return document.getElementById('parallel-toggle')?.classList.contains('on'); }
function getStepDelaySec(stepName) { const map = { signin:'rt-signin', verify:'rt-verify', reserve:'rt-reserve', book:'rt-book', initiate:'rt-initiate' }; return Math.max(0, +document.getElementById(map[stepName])?.value || 1); }
function getParallelStep(stepName) { const map = { advance: ['ivac-parallel-advance-hits', 'ivac-parallel-advance-ms'], signin: ['ivac-parallel-signin-hits', 'ivac-parallel-signin-ms'], verify: ['ivac-parallel-loginotp-hits', 'ivac-parallel-loginotp-ms'], book: ['ivac-parallel-book-hits', 'ivac-parallel-book-ms'], reserve: ['ivac-parallel-reserveslot-hits', 'ivac-parallel-reserveslot-ms'], initiate: ['ivac-parallel-initiate-hits', 'ivac-parallel-initiate-ms'] }; const [hId, mId] = map[stepName] || []; return { hits: +document.getElementById(hId)?.value || 1, ms: +document.getElementById(mId)?.value || 0 }; }
function setStepStatus(stepName, state) { document.querySelectorAll('#netlog-steps .nl-step').forEach(el => { if (el.dataset.step === stepName) { el.classList.remove('active', 'success', 'fail'); if (state) el.classList.add(state); } }); }
function resetAllStepStatus() { document.querySelectorAll('#netlog-steps .nl-step').forEach(el => { el.classList.remove('active', 'success', 'fail'); }); }

function isSessionValid() { if (!sessionState.accessToken || !sessionState.loggedInAt) return false; if (Date.now() - sessionState.loggedInAt >= 15 * 60 * 1000) { try { clearAllSession(); } catch(e) {} return false; } return true; }
function isStepAlreadyDone(step) { const now = Date.now(); switch (step) { case 'signin': return isSessionValid(); case 'verify': return isSessionValid() && !!sessionState.isVerified; case 'reserve': if (!isSessionValid()) return false; if (!sessionState.reservationId || !sessionState.reservedAt) return false; return (now - sessionState.reservedAt) < ((sessionState.reserveTtlSec || 600) * 1000); case 'book': if (!isSessionValid()) return false; return !!sessionState.appointmentId && sessionState.bookedAt && (now - sessionState.bookedAt) < (5 * 60 * 1000); case 'initiate': return false; default: return false; } }

async function runStepOnce(stepName, fnFactory) {
    if (stopFlag.value) return { win: false, cancelled: true };
    const parallel = isParallelOn();
    const initialConfig = parallel ? getParallelStep(stepName) : { hits: 1, ms: 0 };
    const N = parallel && initialConfig.hits > 1 ? initialConfig.hits : 1;

    if (N === 1) {
        const ac = new AbortController();
        if (!raceCoord.track(stepName, ac)) return { win: false, cancelled: true };
        try { const res = await fnFactory(ac.signal, 1); raceCoord.untrack(stepName, ac); if (res?.win) raceCoord.declareWin(stepName, res); return res || { win: false }; }
        catch (err) { raceCoord.untrack(stepName, ac); if (err.name === 'AbortError') return { win: false, cancelled: true }; return { win: false }; }
    }

    const controllers = new Set(); const inFlight = new Map(); let winResult = null; let cancelled = false; let fireCounter = 0; let initialBurstDone = false; const fireQueue = { burstRemaining: N, refillsNeeded: 0 };
    function fireOne() {
        if (stopFlag.value || winResult || cancelled || raceCoord.hasWon(stepName)) return null;
        const id = ++fireCounter; const ac = new AbortController(); if (!raceCoord.track(stepName, ac)) return null;
        controllers.add(ac);
        const p = (async () => { try { const res = await fnFactory(ac.signal, id); if (res?.win) raceCoord.declareWin(stepName, res); return { id, ok: !!res?.win, res }; } catch (err) { if (err.name === 'AbortError') return { id, ok: false, cancelled: true }; return { id, ok: false, error: err }; } finally { controllers.delete(ac); raceCoord.untrack(stepName, ac); } })();
        inFlight.set(id, p); return p;
    }
    (async () => {
        if (fireQueue.burstRemaining > 0) { fireOne(); fireQueue.burstRemaining--; }
        while (!stopFlag.value && !winResult && !cancelled && !raceCoord.hasWon(stepName)) {
            const currentMs = getParallelStep(stepName).ms || 0; if (currentMs > 0) await new Promise(r => setTimeout(r, currentMs));
            if (stopFlag.value || winResult || cancelled || raceCoord.hasWon(stepName)) break;
            const currentHits = getParallelStep(stepName).hits || 1; const firedSoFar = fireCounter - fireQueue.refillsNeeded;
            if (currentHits > firedSoFar && fireQueue.burstRemaining < (currentHits - firedSoFar)) fireQueue.burstRemaining = currentHits - firedSoFar;
            if (fireQueue.burstRemaining > 0) { fireOne(); fireQueue.burstRemaining--; if (fireQueue.burstRemaining === 0) initialBurstDone = true; }
            else if (fireQueue.refillsNeeded > 0) { fireOne(); fireQueue.refillsNeeded--; }
        }
    })();
    while (!winResult && !stopFlag.value) {
        if (raceCoord.hasWon(stepName)) { winResult = raceCoord.getWinner(stepName); break; }
        if (inFlight.size === 0) { if (!initialBurstDone && fireQueue.burstRemaining > 0) { await new Promise(r => setTimeout(r, 50)); continue; } if (fireQueue.refillsNeeded > 0) { await new Promise(r => setTimeout(r, 50)); continue; } break; }
        const promises = Array.from(inFlight.values()); const settled = await Promise.race(promises); inFlight.delete(settled.id);
        if (settled.cancelled) continue;
        if (settled.ok) { winResult = settled.res; cancelled = true; raceCoord.declareWin(stepName, settled.res); break; }
        fireQueue.refillsNeeded++;
    }
    return winResult || { win: false };
}

async function runStepSmart(stepName, fnFactory) {
    raceCoord.reset(stepName); setStepStatus(stepName, 'active');
    while (!stopFlag.value) {
        const result = await runStepOnce(stepName, fnFactory);
        if (result.win) { setStepStatus(stepName, 'success'); return result; }
        if (stopFlag.value) { setStepStatus(stepName, ''); return result; }
        if (!isSingleOn()) { setStepStatus(stepName, 'fail'); logStatus(`✗ ${stepName} failed — retry OFF`, 'r'); return result; }
        const delay = getStepDelaySec(stepName); logStatus(`↻ ${stepName} retry in ${delay}s`, 'y'); raceCoord.reset(stepName);
        for (let s = 0; s < delay && !stopFlag.value; s++) { await new Promise(r => setTimeout(r, 1000)); }
    }
    return { win: false, cancelled: true };
}

// ==================== STEP FACTORIES — H2 ONLY ====================
async function stepSignin(signal) {
    if (!_forceStep && isStepAlreadyDone('signin')) { logStatus(`⏭ Signin already done`, 'g'); return { win: true, skipped: true }; }
    const phone = document.getElementById('login-phone')?.value.trim(); const password = document.getElementById('login-password')?.value.trim();
    if (!phone || !password) { logStatus('❌ phone/password empty', 'r'); return { win: false }; }
    let captchaToken; try { captchaToken = await getCaptchaTokenSmart(); } catch (e) { logStatus(`✗ captcha: ${e.message}`, 'r'); return { win: false }; }
    if (raceCoord.hasWon('signin')) { logStatus(`⏭ Signin race already won — bailing`, 'y'); if (captchaToken) tokenQueueAddTagged(captchaToken, 'turnstile'); return { win: false, cancelled: true }; }
    const localAc = new AbortController(); const onParentAbort = () => { try { localAc.abort(); } catch(e) {} }; signal?.addEventListener('abort', onParentAbort); registerTokenInFlight(captchaToken, localAc);
    const signinTimeoutOn = document.getElementById('signin-timeout-toggle')?.classList.contains('on');
    let signinTimeoutId = null;
    if (signinTimeoutOn) { signinTimeoutId = setTimeout(() => { logStatus('⏱ Signin timeout (20s) — forcing retry', 'y'); localAc.abort(); }, 20000); }
    const logId = netLogAdd({ method: 'POST', url: API_SIGNIN_V2, tag: 'signin', state: 'pending' });
    try {
        const encryptedCaptcha = encTokenForCall(captchaToken, 'signin');
        const r = await H2.fetchH2(API_SIGNIN_V2, { method: 'POST', signal: localAc.signal, headers: { 'accept':'application/json, text/plain, */*','cache-control':'no-cache, no-store, must-revalidate','content-type':'application/json','pragma':'no-cache','x-sec-navigation-state': _navState() }, referrer: API_REFERRER, body: JSON.stringify({ phone, password, c: encryptedCaptcha }) });
        if (signinTimeoutId) { clearTimeout(signinTimeoutId); signinTimeoutId = null; }
        const body = await r.json(); netLogUpdate(logId, { status: r.status, state: r.ok && body.successFlag ? 'ok' : 'fail' });
        const burn = shouldBurnToken(r.status, body); if (burn) tokenQueueInvalidate(captchaToken); else unregisterTokenInFlight(captchaToken, localAc);
        if (r.ok && body.successFlag && body.data?.accessToken) {
            raceCoord.declareWin('signin', { win: true, data: body });
            saveSession(body.data, phone); try { startOtpTimer('signinOtp'); } catch(e) {}
            showMilestonePopup('OTP Sent', 'OTP sent to ' + phone, '📩'); try { announceSuccess('OTP sent successfully'); } catch(e) {}
            if (isAutoOn()) startSmsFetcher(phone, async (otp) => { return undefined; }, false);
            return { win: true, data: body };
        } return { win: false };
    } catch (err) { if (signinTimeoutId) { clearTimeout(signinTimeoutId); signinTimeoutId = null; } if (err.name === 'AbortError') { netLogUpdate(logId, { state: 'cancel', status: '⊘' }); return { win: false, cancelled: false }; } netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); return { win: false, cancelled: false }; } finally { try { signal?.removeEventListener('abort', onParentAbort); } catch(e) {} try { unregisterTokenInFlight(captchaToken, localAc); } catch(e) {} }
}

async function stepVerify(signal) {
    if (!_forceStep && isStepAlreadyDone('verify')) { logStatus(`⏭ Verify already done`, 'g'); return { win: true, skipped: true }; }
    let otp = document.getElementById('login-otp')?.value.trim();
    if (!otp) {
        if (_forceStep) { logStatus('❌ OTP empty', 'r'); return { win: false }; }
        logStatus('⏳ Waiting for OTP…', 'y');
        const waitStart = Date.now();
        while (!otp && Date.now() - waitStart < 90000 && !signal?.aborted && !stopFlag.value) {
            if (raceCoord.hasWon('verify')) return { win: false, cancelled: true };
            await new Promise(r => setTimeout(r, 500)); otp = document.getElementById('login-otp')?.value.trim();
        }
        if (!otp) { logStatus('❌ OTP not received', 'r'); return { win: false }; }
    }
    if (!sessionState.accessToken || !sessionState.requestId) { if (_forceStep) logStatus('⚠ No session — attempting anyway', 'y'); else { logStatus('❌ No session', 'r'); return { win: false }; } }
    if (raceCoord.hasWon('verify')) { logStatus(`⏭ Verify race already won — bailing`, 'y'); return { win: false, cancelled: true }; }
    const logId = netLogAdd({ method: 'POST', url: API_VERIFY, tag: 'verify', state: 'pending', note: `verify ${otp}` });
    try {
        const r = await H2.fetchH2(API_VERIFY, { method: 'POST', signal, headers: { 'accept': 'application/json, text/plain, */*', 'authorization': `Bearer ${sessionState.accessToken}`, 'cache-control': 'no-cache, no-store, must-revalidate', 'content-type': 'application/json', 'pragma': 'no-cache' }, referrer: API_REFERRER, body: JSON.stringify({ requestId: sessionState.requestId, phone: sessionState.phone, code: otp, otpChannel: 'PHONE' }) });
        let body = null; try { body = await r.json(); } catch(e) {} const verified = isVerifiedResponse(r.status, body);
        netLogUpdate(logId, { status: r.status, state: verified ? 'ok' : 'fail', note: verified ? 'verified' : (body?.message || `HTTP ${r.status}`) });
        if (verified) {
            raceCoord.declareWin('verify', { win: true, data: body });
            try { stopOtpTimer('signinOtp'); stopOtpTimer('advanceOtp'); } catch(e) {}
            try { stopSmsFetcher('OTP verified'); } catch(e) {}
            document.getElementById('login-otp').value = '';
            markSessionVerified(); showMilestonePopup('Verified', 'OTP Verified successfully!', '✅');
            if (sessionState.loggedInAt) { const sessionExpiresAt = sessionState.loggedInAt + TIMER_TOKEN_MS; const remainingMs = sessionExpiresAt - Date.now(); if (remainingMs > 0) { startTokenTimerWithExpiry(sessionExpiresAt); const min = Math.floor(remainingMs / 60000); const sec = Math.floor((remainingMs % 60000) / 1000); logStatus(`✅ Verified • session ${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')} left`, 'g'); } }
        } else { if (!_forceStep && isAutoOn() && sessionState.phone) { document.getElementById('login-otp').value = ''; logStatus('⚠ Verify failed — restarting SMS fetcher', 'y'); startSmsFetcher(sessionState.phone, async () => { return undefined; }, true); } }
        return { win: verified, data: body };
    } catch (err) { if (err.name === 'AbortError') netLogUpdate(logId, { state: 'cancel', status: '⊘' }); else netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); return { win: false, cancelled: err.name === 'AbortError' }; }
}

// ==================== RESERVE: slot-id (= saved appointmentId) + date picker ====================
// Reserve endpoint is now /slots/{appointmentId}/reserve-slot with body {c, appointmentDate}.
// The {appointmentId} is the SAME id saved to the profile after file upload (initiate uses it too).
function getReserveAppointmentId() {
    let id = sessionState.appointmentId;
    if (!id) { try { const p = profiles[activeProfileName]?.appointmentId?.trim().replace(/^["']|["']$/g, ''); if (p && p.length >= 10) id = p; } catch(e) {} }
    return id || '';
}

// The reserve-slot URL uses a CENTER-FIXED slot UUID (e.g. 54ea9f13-…), NOT the per-user
// appointmentId. It stays the same across accounts for a given center, so the user pastes it
// once into the Slot ID box (persisted). Falls back to appointmentId only if the box is empty.
const RESERVE_SLOT_ID_KEY = 'rj_reserve_slot_id';
const RESERVE_SLOT_ID_FIXED = '54ea9f13-f1e2-4cea-9e08-f525e8242ccf';   // fixed reserve slot id
function _cleanUuid(v) { const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(String(v || '')); return m ? m[1] : (String(v || '').trim()); }
function getReserveSlotId() {
    // Box value wins if present; otherwise ALWAYS the fixed slot id. Profile is never used here
    // (profile stores the appointmentId, a different thing).
    const inp = document.getElementById('ivac-reserve-slot-id');
    const v = _cleanUuid(inp?.value);
    return v || RESERVE_SLOT_ID_FIXED;
}
function saveReserveSlotId(v) {
    v = _cleanUuid(v); if (!v) return;
    try { localStorage.setItem(RESERVE_SLOT_ID_KEY, v); } catch(e) {}   // persistence only; not tied to profile
}

// dd-mm-yyyy display, YYYY-MM-DD value (API format)
function _fmtDateDisplay(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : iso; }
// normalize any date-ish value to a single YYYY-MM-DD string (never an array)
function _normDate(v) {
    if (Array.isArray(v)) return _normDate(v[0]);
    let s = String(v == null ? '' : v).trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s); if (m) return `${m[3]}-${m[2]}-${m[1]}`;   // DD-MM-YYYY (page format)
    m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s); if (m) return `${m[3]}-${m[2]}-${m[1]}`;   // DD/MM/YYYY
    return '';
}

// Scrape the appointment dates the site itself is showing on the /appointment/time-slot page.
// The date dropdown renders each date as a leaf element like "12-07-2026" (DD-MM-YYYY, dash only).
// We deliberately ignore slash-format dates (e.g. our own panel clock "08/05/2026") and skip
// anything inside our own UI so only the site's real date list is captured.
function scrapePageDates() {
    const set = new Set();
    const onlyDash = (t) => {
        const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(t) || null;
        if (m) return `${m[3]}-${m[2]}-${m[1]}`;
        const m2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t) || null;
        return m2 ? `${m2[1]}-${m2[2]}-${m2[3]}` : '';
    };
    try {
        document.querySelectorAll('button, span, li, div, option, p').forEach(el => {
            if (el.children && el.children.length) return;               // leaf nodes only
            if (el.closest('#p, #rj-netlog, [id^="ivac-"], [id^="rj-"]')) return;   // skip our own UI
            const iso = onlyDash((el.textContent || '').trim());
            if (iso) set.add(iso);
        });
    } catch (e) {}
    return [...set].sort();   // YYYY-MM-DD sorts chronologically
}

function populateReserveDates(dates) {
    const sel = document.getElementById('ivac-reserve-date');
    const arr = (Array.isArray(dates) ? dates : []).map(_normDate).filter(Boolean);
    const uniq = [...new Set(arr)].sort();
    if (!sel || !uniq.length) return null;
    const prev = sel.value;
    sel.innerHTML = '<option value="">📅 Reserve date…</option>' + uniq.map(d => `<option value="${d}">${_fmtDateDisplay(d)}</option>`).join('');
    // keep previous choice if still present, else auto-select the first (earliest) date
    // keep the user's manual pick if still present; else auto-pick per the Latest/Earliest toggle
    if (prev && uniq.includes(prev)) sel.value = prev;
    else { const latest = document.getElementById('date-target-toggle')?.classList.contains('on'); sel.value = latest ? uniq[uniq.length - 1] : uniq[0]; }
    sessionState.abcDate = sel.value || uniq[0];
    return sel.value;
}

// Sync dropdown: prefer the dates the page is already showing; fall back to get-booking-config API.
async function loadReserveDates() {
    const pageDates = scrapePageDates();
    if (pageDates.length) { const first = populateReserveDates(pageDates); logStatus(`📅 ${pageDates.length} date(s) synced from page • first: ${_fmtDateDisplay(first)}`, 'g'); return pageDates; }
    if (!sessionState.accessToken) { logStatus('❌ No dates on page & no session — signin first', 'r'); return null; }
    const logId = netLogAdd({ method: 'GET', url: API_BOOK, tag: 'book', state: 'pending', note: 'load dates' });
    try {
        const r = await H2.fetchH2(API_BOOK, { method: 'GET', headers: { 'accept': 'application/json, text/plain, */*', 'authorization': `Bearer ${sessionState.accessToken}`, 'cache-control': 'no-cache, no-store, must-revalidate', 'pragma': 'no-cache' }, referrer: API_REFERRER, body: null });
        let body = null; try { body = await r.json(); } catch(e) {}
        // get-booking-config also returns the appointmentId — capture it the SAME way Book does:
        // save to session + active profile (Profile Manager field) and show the id popup, but only
        // when it's newly obtained (this runs on the auto-sync tick, so don't repeat every time).
        try {
            const apptId = body?.data?.appointmentId;
            if (apptId && apptId !== sessionState.appointmentId) {
                sessionState.appointmentId = apptId; sessionState.bookedAt = Date.now(); persistSession();
                if (profiles[activeProfileName]) { profiles[activeProfileName].appointmentId = apptId; persistProfiles(); if (pmAppointmentId) pmAppointmentId.value = apptId; }
                logStatus(`📋 Appointment ID saved: ${apptId}`, 'g');
                showMilestonePopup('Booked', 'Appointment ID: ' + apptId, '📋'); try { announceSuccess('Booking successful'); } catch(e) {}
            }
        } catch(e) {}
        const dates = body?.data?.appointmentDate;
        const arr = Array.isArray(dates) ? dates : (dates ? [dates] : []);
        netLogUpdate(logId, { status: r.status, state: arr.length ? 'ok' : 'fail', note: arr.length ? `${arr.length} dates` : (body?.message || `HTTP ${r.status}`) });
        if (arr.length) { const first = populateReserveDates(arr); logStatus(`📅 ${arr.length} date(s) from booking config • first: ${_fmtDateDisplay(first)}`, 'g'); }
        else logStatus('⚠ No dates found (page or booking config)', 'y');
        return arr;
    } catch (err) { netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); logStatus(`✗ Load dates: ${err.message}`, 'r'); return null; }
}

// Auto-sync: mirror the time-slot page's date list into the dropdown when on that page; and when
// NOT on that page (working from a single panel), auto-pull the dates from get-booking-config so
// the dropdown fills dynamically without visiting /appointment/time-slot. API pull is throttled.
(function initReserveDateAutoSync() {
    let last = '';
    let lastApiTry = 0;
    // AUTO-RESERVE: date dropdown e date load + select howar SATHE SATHE, Auto ON thakle nije
    // theke reserve (→ initiate) chain shuru kore — manual click er dorkar nei. Date gulo jokhon
    // alada auto date-sync poll die ashe (pipeline cholmaan noy), tokhon reserve nijei fire kore.
    const maybeAutoReserve = () => {
        try {
            const sel = document.getElementById('ivac-reserve-date');
            if (!sel || !sel.value) return;                          // date load + select hoyeche?
            if (!isAutoOn()) return;                                 // Auto OFF hole kichu na
            if (!sessionState.accessToken || !sessionState.isVerified) return;
            if (!sessionState.appointmentId) return;                 // book (appointmentId) chai
            if (sessionState.reservationId) return;                  // already reserved
            if (pipelineRunning || slotDuty.chainRunning) return;    // pipeline already cholche
            if (_autoReserveKicked || raceCoord.hasWon('reserve')) return;
            _autoReserveKicked = true;
            logStatus('▶ Auto reserve — date loaded, chain shuru', 'g');
            manualStepClick('reserve');                             // manual click er hubohu behavior
        } catch (e) {}
    };
    const tick = async () => {
        try {
            const sel = document.getElementById('ivac-reserve-date'); if (!sel) return;
            const dates = scrapePageDates();
            if (dates.length) {                              // on the time-slot page → mirror live
                const sig = dates.join(',');
                if (sig !== last) { last = sig; populateReserveDates(dates); }
                maybeAutoReserve();
                return;
            }
            // not on the page: pull via API only while we still need it. Once we already have an
            // appointmentId (get-booking-config / Book succeeded — the popup with the id was shown)
            // OR the dropdown already holds dates, STOP the auto get-booking-config polling.
            const hasDates = sel.options.length > 1;         // >1 means more than the placeholder
            // Already have an appointmentId — from this session OR SAVED IN THE PROFILE (persists across
            // sessions). If the profile has it, adopt it into the session and DON'T call get-booking-config
            // at all — no API call needed once the id is known.
            let haveId = !!sessionState.appointmentId;
            if (!haveId) {
                try { const pid = profiles[activeProfileName]?.appointmentId?.trim().replace(/^["']|["']$/g, ''); if (pid && pid.length >= 10) { sessionState.appointmentId = pid; haveId = true; } } catch (e) {}
            }
            // Only after VERIFY (not right after signin) so the auto date-pull never fires
            // get-booking-config out of pipeline order (signin → verify → book → reserve → initiate).
            if (!hasDates && !haveId && sessionState.accessToken && sessionState.isVerified && (Date.now() - lastApiTry > 20000)) {
                lastApiTry = Date.now();
                try { await loadReserveDates(); } catch (e) {}
            }
            maybeAutoReserve();   // date load hoye thakle Auto ON e reserve chain shuru
        } catch (e) {}
    };
    try { const start = () => { setInterval(tick, 1500); tick(); }; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start(); } catch (e) {}
})();

async function stepReserve(signal) {
    if (!_forceStep && isStepAlreadyDone('reserve')) { logStatus(`⏭ Reserve already done`, 'g'); return { win: true, skipped: true }; }
    if (!sessionState.accessToken) { if (_forceStep) logStatus('⚠ No session', 'y'); else { logStatus('❌ No session', 'r'); return { win: false }; } }
    let captchaToken; try { captchaToken = await getCaptchaTokenSmart(); } catch (e) { logStatus(`✗ Captcha: ${e.message}`, 'r'); return { win: false }; }
    if (raceCoord.hasWon('reserve')) { logStatus(`⏭ Reserve race already won — returning token`, 'y'); if (captchaToken) tokenQueueAddTagged(captchaToken, 'capmonster'); return { win: false, cancelled: true }; }
    const encryptedCaptchaToken = encTokenForCall(captchaToken, 'reserve');
    // slot id = center-fixed Slot ID box (falls back to appointmentId); date = picker → session → booking-config
    const slotId = getReserveSlotId();
    if (!slotId) { logStatus('❌ No Slot ID — paste the reserve Slot ID (54ea9f13-…)', 'r'); if (captchaToken) tokenQueueAddTagged(captchaToken, 'capmonster'); return { win: false }; }
    let appointmentDate = _normDate(document.getElementById('ivac-reserve-date')?.value) || _normDate(sessionState.abcDate);
    if (!appointmentDate) { try { const arr = await loadReserveDates(); appointmentDate = _normDate(arr && arr[0]); } catch(e) {} }
    if (!appointmentDate) { logStatus('❌ No appointment date — press ↻', 'r'); if (captchaToken) tokenQueueAddTagged(captchaToken, 'capmonster'); return { win: false }; }
    const RESERVE_URL = `https://api.ivacbd.com/iams/api/v1/slots/${slotId}/reserve-slot`;
    const localAc = new AbortController(); const onParentAbort = () => { try { localAc.abort(); } catch(e) {} }; signal?.addEventListener('abort', onParentAbort); registerTokenInFlight(captchaToken, localAc);
    const logId = netLogAdd({ method: 'POST', url: RESERVE_URL, tag: 'reserve', state: 'pending', note: `reserve-slot ${_fmtDateDisplay(appointmentDate)} (H/2)` });
    try {
        const r = await H2.fetchH2(RESERVE_URL, { method: 'POST', signal: localAc.signal, headers: { 'accept': 'application/json, text/plain, */*', 'authorization': `Bearer ${sessionState.accessToken}`, 'cache-control': 'no-cache, no-store, must-revalidate', 'content-type': 'application/json', 'pragma': 'no-cache', 'x-v-request-meta': 'windos.s' }, referrer: API_REFERRER, body: JSON.stringify({ c: encryptedCaptchaToken, appointmentDate }) });
        let body = null; try { body = await r.json(); } catch(e) {} const reserved = isReservedResponse(body, r.status);
        const burn = shouldBurnToken(r.status, body); if (burn) tokenQueueInvalidate(captchaToken); else unregisterTokenInFlight(captchaToken, localAc);
        netLogUpdate(logId, { status: r.status, state: reserved ? 'ok' : 'fail', note: reserved ? `${body?.status||body?.data?.status||'?'} • ${body?.appointmentDate||body?.data?.appointmentDate||''}` : (body?.message || `HTTP ${r.status}`) });
        if (reserved) {
            raceCoord.declareWin('reserve', { win: true, data: body });
            const rd = (body && body.data && (body.data.reservationId || body.data.status)) ? body.data : body;   // success payload may nest under .data
            // reservation id may arrive under several names — pick whichever is present
            const _rid = rd.reservationId || rd.reserveId || rd.reservation_id || rd.tranId || rd.trxId || rd.transactionId || rd.bookingId || rd.id || (body && (body.reservationId || (body.data && body.data.reservationId))) || null;
            sessionState.reservationId = _rid; sessionState.reserveTtlSec = rd.reserveTtlSeconds || null; sessionState.reserveStatus = rd.status || null; sessionState.abcDate = rd.appointmentDate || appointmentDate || null; sessionState.reservedAt = Date.now(); persistSession();
                        // Auto-extract: fill reserve ID in Upload tran ID placeholder
        try { const trxInp = document.getElementById('ivac-invoice-trxid'); if (trxInp && _rid) { trxInp.value = _rid; logStatus(`✅ Reserve ID auto-filled in tran ID field`, 'g'); } else if (trxInp && !_rid) { logStatus(`⚠ Reserved but no reservation-id in response — check field name`, 'y'); } } catch(e) {}
            logStatus(`✅ Reserved (${rd.status||'OK'}) • ${rd.appointmentDate||appointmentDate||''} • TTL ${rd.reserveTtlSeconds||'?'}s`, 'g');
            showMilestonePopup('Reserve Booked', 'Slot reserved!', '🎯'); try { announceSuccess('Slot reserved successfully'); } catch(e) {}
        } return { win: reserved, data: body };
    } catch (err) { if (err.name === 'AbortError') netLogUpdate(logId, { state: 'cancel', status: '⊘' }); else netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message }); return { win: false, cancelled: err.name === 'AbortError' }; } finally { try { signal?.removeEventListener('abort', onParentAbort); } catch(e) {} try { unregisterTokenInFlight(captchaToken, localAc); } catch(e) {} }
}

// ==================== ✅ FIXED BOOK STEP WITH SMART SKIP ====================
async function stepBook(signal) {
    // 🔍 STEP 1: Check Profile Manager for saved appointmentId
    try {
        const savedApptId = profiles[activeProfileName]?.appointmentId?.trim().replace(/^["']|["']$/g, '');
        if (savedApptId && savedApptId.length >= 10) {
            sessionState.appointmentId = savedApptId;
            sessionState.bookedAt = Date.now();
            persistSession();
            logStatus(`⏭ Book skipped — saved appointmentId: ${savedApptId}`, 'g');
            try { announceSuccess('Booking ready'); } catch(e) {}
            return { win: true, skipped: true, fromProfile: true };
        }
    } catch(e) {}

    // 🔍 STEP 2: Check Session State for appointmentId (within 5 min)
    if (!_forceStep) {
        if (isStepAlreadyDone('book')) {
            logStatus(`⏭ Book already done — using session appointmentId`, 'g');
            return { win: true, skipped: true };
        }
    }

    // ❌ STEP 3: No appointmentId found - API Call
    if (!sessionState.accessToken) {
        if (_forceStep) logStatus('⚠ No session', 'y');
        else { logStatus('❌ No session', 'r'); return { win: false }; }
    }

    if (raceCoord.hasWon('book')) {
        logStatus(`⏭ Book race already won — bailing`, 'y');
        return { win: false, cancelled: true };
    }

    const logId = netLogAdd({ method: 'GET', url: API_BOOK, tag: 'book', state: 'pending' });
    try {
        const r = await H2.fetchH2(API_BOOK, {
            method: 'GET', signal,
            headers: {
                'accept': 'application/json, text/plain, */*',
                'authorization': `Bearer ${sessionState.accessToken}`,
                'cache-control': 'no-cache, no-store, must-revalidate',
                'pragma': 'no-cache'
            },
            referrer: API_REFERRER,
            body: null
        });

        let body = null;
        try { body = await r.json(); } catch(e) { body = null; }

        const ok = r.ok && body && (body.successFlag === true || body.message === 'Success' || body.statusCode === 200);
        netLogUpdate(logId, {
            status: r.status,
            state: ok ? 'ok' : 'fail',
            note: ok ? `appointmentId ${body.data?.appointmentId?.slice(0,8)||'?'}` : (body?.message || `HTTP ${r.status}`)
        });

        if (ok && body.data) {
            raceCoord.declareWin('book', { win: true, data: body });

            // ✅ Save to Session State
            sessionState.appointmentId = body.data.appointmentId || sessionState.appointmentId;
            // appointmentDate is now an array of available dates → fill the reserve date picker (auto-first)
            { const ad = body.data.appointmentDate; if (Array.isArray(ad) && ad.length) { populateReserveDates(ad); } else if (ad) { sessionState.abcDate = ad; } }
            sessionState.abcSlot = body.data.appointmentSlot || null;
            sessionState.ivacCenter = body.data.ivacCenter || null;
            sessionState.mission = body.data.mission || null;
            sessionState.numberOfApplicants = body.data.numberOfApplicants || null;
            sessionState.totalAmount = body.data.totalAmount || null;
            sessionState.fileUploadStatus = body.data.fileUploadStatus || null;
            sessionState.visaCodes = body.data.visaCodes || null;
            sessionState.bookedAt = Date.now();
            persistSession();

            // ✅ Save to Profile Manager
            try {
                if (body.data.appointmentId && profiles[activeProfileName]) {
                    profiles[activeProfileName].appointmentId = body.data.appointmentId;
                    persistProfiles();
                    if (pmAppointmentId) pmAppointmentId.value = body.data.appointmentId;
                }
            } catch(e) {}

            logStatus(`✅ Booked: ${body.data.ivacCenter||''} ${body.data.appointmentSlot||''} • ৳${body.data.totalAmount||'?'}`, 'g');
            showMilestonePopup('Booked', 'Appointment ID: ' + (body.data.appointmentId || ''), '📋'); try { announceSuccess('Booking successful'); } catch(e) {}
            return { win: true, data: body };
        }
        return { win: false, data: body };
    } catch (err) {
        if (err.name === 'AbortError') netLogUpdate(logId, { state: 'cancel', status: '⊘' });
        else netLogUpdate(logId, { state: 'fail', status: 'err', note: err.message });
        return { win: false, cancelled: err.name === 'AbortError' };
    }
}

async function stepInitiate(signal) {
    if (!sessionState.accessToken) { if (_forceStep) logStatus('⚠ No session', 'y'); else { logStatus('❌ No session', 'r'); return { win: false }; } }
    let appointmentId = sessionState.appointmentId; let source = 'sessionState';
    if (!appointmentId) { try { const profApptId = profiles[activeProfileName]?.appointmentId?.trim().replace(/^["']|["']$/g, ''); if (profApptId && profApptId.length >= 10) { appointmentId = profApptId; sessionState.appointmentId = profApptId; source = `profile`; } } catch(e) {} }
    if (!appointmentId) { logStatus('❌ No appointmentId', 'r'); return { win: false }; }
    if (raceCoord.hasWon('initiate')) { logStatus(`⏭ Initiate race already won — bailing`, 'y'); return { win: false, cancelled: true }; }
    logStatus(`💳 Initiate: ${appointmentId.slice(0,8)}…`, 'y');
    let initiateToken; try { initiateToken = await getCaptchaTokenSmart(); } catch(e) { logStatus(`❌ Initiate captcha: ${e.message}`, 'r'); return { win: false }; }
    const logId = netLogAdd({ method: 'POST', url: API_INITIATE, tag: 'initiate', state: 'pending' });
    try {
        // The payment endpoint returns NO CORS headers → native fetch is always preflight-blocked
        // (No ACAO), so we go straight through GM_xmlhttpRequest (forceGM). GM alone gets a 403
        // from the "spellbound" WAF, so we also send the real browser fingerprint headers
        // (sec-ch-ua / sec-fetch-* / accept-language / origin) to look like the genuine page
        // request. This is a best-effort attempt to pass the payment WAF — not guaranteed.
        // TOGGLE "Initiate Net": checked (default) -> native fetch = DevTools Network Fetch/XHR e
        // DEKHABE (asol page-o axios/XHR die kore, tai CORS thake). Unchecked -> forceGM = GM_xmlhttp
        // (CORS-immune kintu Network e lukano). native e origin/sec-* forbidden header browser nijei
        // boshay, tai native path e segulo baad; GM path e fingerprint header lage (WAF pass).
        // x-token = RAW captcha token. Only Signin & Reserve (body "c") use encryption; initiate
        // (like upload/signup) sends the raw token. The "1."-prefix is the raw token's own format.
        const initiateXToken = initiateToken;
        const useNative = document.getElementById('chk-initiate-net')?.checked !== false;
        const initHeaders = useNative
            ? { 'accept':'application/json, text/plain, */*', 'authorization':`Bearer ${sessionState.accessToken}`, 'content-type':'application/json', 'x-token':initiateXToken }
            : { 'accept':'application/json, text/plain, */*', 'accept-language':'en-US,en;q=0.9', 'authorization':`Bearer ${sessionState.accessToken}`, 'cache-control':'no-cache, no-store, must-revalidate', 'content-type':'application/json', 'pragma':'no-cache', 'priority':'u=1, i', 'sec-ch-ua':'"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"', 'sec-ch-ua-mobile':'?0', 'sec-ch-ua-platform':'"Windows"', 'sec-fetch-dest':'empty', 'sec-fetch-mode':'cors', 'sec-fetch-site':'same-site', 'origin':'https://appointment.ivacbd.com', 'x-token':initiateXToken };
        const r = await H2.fetchH2Critical(API_INITIATE, { method: 'POST', signal, forceGM: !useNative, headers: initHeaders, referrer: API_REFERRER, body: JSON.stringify({ appointmentId }) });
        const ct = r.headers.get('content-type') || '';
        const body = ct.includes('application/json') ? await r.json() : await r.text().then(t => { try { return JSON.parse(t); } catch(e) { return { raw: t }; } });
        const isSuccess = r.ok || body?.statusCode === 201 || body?.successFlag === true;
        netLogUpdate(logId, { status: r.status, state: isSuccess ? 'ok' : 'fail' });
        if (isSuccess) {
            raceCoord.declareWin('initiate', { win: true, data: body });
            const url = extractPaymentUrl(body) || body?.data?.webview_url || body?.data?.url || body?.data?.paymentUrl || body?.data?.redirectUrl;
            if (url) { logStatus('✅ Payment URL received!', 'g'); try { beepInitiateAndSpeak(); } catch(e) {} showPaymentPopup(url, sessionState.phone || appointmentId.slice(0, 8)); stopFlag.value = true; return { win: true, data: body }; }
            logStatus(`⚠ Initiate succeeded but no payment URL`, 'y'); return { win: false, data: body };
        }
        return { win: false };
    } catch (err) { if (err.name === 'AbortError') netLogUpdate(logId, { state: 'cancel', status: '⊘' }); else netLogUpdate(logId, { state: 'fail', status: 'err' }); return { win: false, cancelled: err.name === 'AbortError' }; }
}

const STEP_FACTORY = { signin: stepSignin, verify: stepVerify, reserve: stepReserve, book: stepBook, initiate: stepInitiate };

async function manualStepClick(stepName) {
    const stepFn = STEP_FACTORY[stepName]; if (!stepFn) return;
    if (pipelineRunning) { stopFlag.value = true; pipelineRunning = false; pipelineConcurrentCount = 0; raceCoord.resetAll(); logStatus('⏸ Auto pipeline paused — manual override', 'y'); await new Promise(r => setTimeout(r, 150)); }
    _forceStep = true; stopFlag.value = false;
    try {
        const result = await runStepSmart(stepName, stepFn);
        if (result.win && isAutoOn()) { const nextIdx = STEP_ORDER.indexOf(stepName) + 1; if (nextIdx < STEP_ORDER.length) { logStatus(`▶ Auto → ${STEP_ORDER[nextIdx]}`, 'g'); await manualStepClick(STEP_ORDER[nextIdx]); } }
    } catch(e) { logStatus(`❌ ${stepName} error: ${e.message}`, 'r'); } finally { _forceStep = false; }
}

document.getElementById('bsi')?.addEventListener('click', () => manualStepClick('signin'));
document.getElementById('bve')?.addEventListener('click', () => manualStepClick('verify'));
document.getElementById('brs')?.addEventListener('click', () => manualStepClick('reserve'));
document.getElementById('bbk')?.addEventListener('click', () => manualStepClick('book'));
document.getElementById('bin')?.addEventListener('click', () => manualStepClick('initiate'));
document.getElementById('ivac-btn-load-dates')?.addEventListener('click', () => loadReserveDates());
(function initReserveSlotIdBox() {
    const inp = document.getElementById('ivac-reserve-slot-id'); if (!inp) return;
    try { inp.value = _cleanUuid(localStorage.getItem(RESERVE_SLOT_ID_KEY) || '') || RESERVE_SLOT_ID_FIXED; } catch(e) { inp.value = RESERVE_SLOT_ID_FIXED; }
    inp.addEventListener('change', () => { const v = _cleanUuid(inp.value); inp.value = v; if (v) { saveReserveSlotId(v); logStatus(`🆔 Reserve Slot ID saved: ${v.slice(0,8)}…`, 'g'); } });
})();
document.getElementById('ivac-reserve-date')?.addEventListener('change', (e) => { if (e.target.value) { sessionState.abcDate = e.target.value; logStatus(`📅 Reserve date: ${_fmtDateDisplay(e.target.value)}`, 'g'); } });

// ==================== PIPELINE STARTER + SCHEDULER ====================
const schedules = { advance: { timerId: null, targetMs: null, countdownId: null }, signin: { timerId: null, targetMs: null, countdownId: null } };
function parseScheduleTime(str) { if (!str) return null; const m = String(str).trim().match(/^(\d{1,2}):(\d{2}):(\d{2}):(\d{3})\s*(AM|PM)$/i); if (!m) return null; let h = parseInt(m[1], 10); const mi = parseInt(m[2], 10); const s = parseInt(m[3], 10); const ms = parseInt(m[4], 10); const ap = m[5].toUpperCase(); if (ap === 'PM' && h !== 12) h += 12; if (ap === 'AM' && h === 12) h = 0; const target = new Date(); target.setHours(h, mi, s, ms); if (target.getTime() < Date.now()) target.setDate(target.getDate() + 1); return target; }
function fmtCountdown(ms) { if (ms <= 0) return '00:00:00.000'; const totalSec = Math.floor(ms / 1000); const h = Math.floor(totalSec / 3600); const m = Math.floor((totalSec % 3600) / 60); const s = totalSec % 60; const milli = ms % 1000; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(milli).padStart(3,'0')}`; }
function cancelSchedule(key) { const s = schedules[key]; if (!s) return; if (s.timerId) { clearTimeout(s.timerId); s.timerId = null; } if (s.countdownId) { clearInterval(s.countdownId); s.countdownId = null; } s.targetMs = null; }
function cancelAllSchedules() { cancelSchedule('advance'); cancelSchedule('signin'); }
function scheduleButton(key, label, fireAction) { const inputId = key === 'advance' ? 'sched-advance' : 'sched-signin'; const inp = document.getElementById(inputId); const timeStr = inp?.value?.trim(); const target = parseScheduleTime(timeStr); if (!target) { logStatus(`❌ Invalid ${label} time`, 'r'); return false; } cancelSchedule(key); const s = schedules[key]; s.targetMs = target.getTime(); const delayMs = s.targetMs - Date.now(); logStatus(`⏰ ${label} scheduled for ${timeStr}`, 'y'); s.countdownId = setInterval(() => { const remain = s.targetMs - Date.now(); if (remain <= 0) { clearInterval(s.countdownId); s.countdownId = null; return; } logStatus(`⏰ ${label} in ${fmtCountdown(remain)}`, 'y'); }, 100); s.timerId = setTimeout(() => { s.timerId = null; if (s.countdownId) { clearInterval(s.countdownId); s.countdownId = null; } s.targetMs = null; logStatus(`🚀 ${label} FIRING NOW!`, 'g'); try { fireAction(); } catch(e) {} }, delayMs); return true; }

let pipelineRunning = false; let pipelineConcurrentCount = 0;
async function startPipelineFrom(startStep) {
    if (!STEP_FACTORY[startStep]) { logStatus(`❌ Unknown step: ${startStep}`, 'r'); return; }
    pipelineConcurrentCount++; pipelineRunning = true;
    if (pipelineConcurrentCount === 1) { stopFlag.value = false; raceCoord.resetAll(); resetAllStepStatus(); }
    try {
        const startIdx = STEP_ORDER.indexOf(startStep); const auto = isAutoOn(); const endIdx = auto ? STEP_ORDER.length - 1 : startIdx;
        for (let i = startIdx; i <= endIdx && !stopFlag.value; i++) { const step = STEP_ORDER[i]; logStatus(`▶ Step ${i+1}/${endIdx+1}: ${step}`, 'y'); const result = await runStepSmart(step, STEP_FACTORY[step]); if (!result.win) { if (!stopFlag.value) logStatus(`⏹ Stopped at ${step}`, 'r'); break; } }
    } finally { pipelineConcurrentCount = Math.max(0, pipelineConcurrentCount - 1); if (pipelineConcurrentCount === 0) { pipelineRunning = false; _forceStep = false; } }
}

(() => {
    const bsgn = document.getElementById('bsgn');
    if (bsgn) { const fresh = bsgn.cloneNode(true); bsgn.parentNode.replaceChild(fresh, bsgn);
        fresh.addEventListener('click', () => {
            if (schedules.signin.timerId) { cancelSchedule('signin'); logStatus('⏰ Signin schedule cancelled', 'y'); return; }
            const timeStr = document.getElementById('sched-signin')?.value?.trim();
            if (timeStr && timeStr.length > 0) { scheduleButton('signin', 'Signin', () => { if (pipelineRunning) return; startPipelineFrom('signin'); }); }
            else { if (pipelineRunning) { logStatus('⚠ Pipeline already running', 'y'); return; } logStatus('🚀 Signin pipeline starting…', 'g'); startPipelineFrom('signin'); }
        });
    }
    const badv = document.getElementById('badv');
    if (badv) { const fresh = badv.cloneNode(true); badv.parentNode.replaceChild(fresh, badv);
        fresh.addEventListener('click', () => {
            if (schedules.advance.timerId) { cancelSchedule('advance'); logStatus('⏰ Advance schedule cancelled', 'y'); return; }
            const timeStr = document.getElementById('sched-advance')?.value?.trim();
            if (timeStr && timeStr.length > 0) { scheduleButton('advance', 'Advance', () => { document.getElementById('badv-phone')?.click(); }); }
            else { document.getElementById('badv-phone')?.click(); }
        });
    }
})();

(() => { const old = document.getElementById('bst'); if (!old) return; const fresh = old.cloneNode(true); old.parentNode.replaceChild(fresh, old); fresh.addEventListener('click', () => { stopFlag.value = true; pipelineRunning = false; pipelineConcurrentCount = 0; _autoReserveKicked = false; raceCoord.resetAll(); try { cancelAllSchedules(); } catch(e) {} try { stopSmsFetcher('Stop All'); } catch(e) {} invoiceRetryActive = false; try { stopSlotDuty('Stop All'); } catch(e) {} try { if (typeof stopAutoEncScan === 'function') stopAutoEncScan(true); } catch(e) {} try { if (typeof window.__rjManualStopAll === 'function') window.__rjManualStopAll(); } catch(e) {} logStatus('🛑 ALL halted', 'r'); }); })();

(() => { ['btn-single', 'btn-auto'].forEach(id => { const old = document.getElementById(id); if (!old) return; const fresh = old.cloneNode(true); old.parentNode.replaceChild(fresh, old); fresh.addEventListener('click', function() { if (this.classList.contains('b8')) { this.classList.remove('b8'); this.classList.add('b5'); } else { this.classList.remove('b5'); this.classList.add('b8'); } }); }); })();

// ==================== PAYMENT POPUP ====================
function showPaymentPopup(paymentUrl, identifier) {
    const existing = document.getElementById('rj-payment-overlay'); if (existing) existing.remove();
    const overlay = document.createElement('div'); overlay.id = 'rj-payment-overlay'; overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:999999999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);font-family:'Segoe UI',system-ui,sans-serif;`;
    const card = document.createElement('div'); card.style.cssText = `width:380px;background:#1a1a2e;border-radius:14px;box-shadow:0 25px 60px rgba(0,0,0,.85),0 0 0 1px rgba(124,58,237,.3);overflow:hidden;`;
    card.innerHTML = `<div style="padding:12px 18px 8px;display:flex;justify-content:space-between;align-items:center"><div style="color:#fff;font-size:17px;font-weight:800">Proceed to SecurePay</div><button id="rj-pay-x" style="background:none;border:none;color:#888;font-size:22px;cursor:pointer">×</button></div><div style="padding:6px 22px 14px"><div style="color:#d0d0e6;font-size:12px;margin-bottom:12px">Payment link opened in new tab.<a href="${paymentUrl}" target="_blank" style="color:#4ade80;text-decoration:none;font-family:Consolas,monospace;font-size:11px;word-break:break-all;display:block;margin-top:6px">${paymentUrl}</a></div></div><div style="padding:0 22px 18px;display:flex;gap:8px"><button id="rj-pay-visa" style="flex:1;background:linear-gradient(135deg,#10b981,#059669);border:none;color:#fff;padding:11px 0;border-radius:8px;font-size:12px;font-weight:800;cursor:pointer">VISA CARD</button><button id="rj-pay-copy" style="flex:1;background:linear-gradient(135deg,#facc15,#eab308);border:none;color:#000;padding:11px 0;border-radius:8px;font-size:12px;font-weight:800;cursor:pointer">Copy Link</button><button id="rj-pay-close" style="flex:1;background:linear-gradient(135deg,#9ca3af,#6b7280);border:none;color:#fff;padding:11px 0;border-radius:8px;font-size:12px;font-weight:800;cursor:pointer">Close</button></div>`;
    overlay.appendChild(card); document.body.appendChild(overlay); try { window.open(paymentUrl, '_blank'); } catch(e) {}
    document.getElementById('rj-pay-x').onclick = () => overlay.remove(); document.getElementById('rj-pay-close').onclick = () => overlay.remove();
    document.getElementById('rj-pay-visa').onclick = () => { try { window.open(paymentUrl, '_blank'); } catch(e) {} };
    document.getElementById('rj-pay-copy').onclick = function() { navigator.clipboard.writeText(paymentUrl).then(() => { this.textContent = '✓ Copied!'; setTimeout(() => { this.textContent = 'Copy Link'; }, 1500); }).catch(() => { const ta = document.createElement('textarea'); ta.value = paymentUrl; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); this.textContent = '✓ Copied!'; setTimeout(() => { this.textContent = 'Copy Link'; }, 1500); }); };
}

// ==================== LOGOUT ====================
document.getElementById('blo')?.addEventListener('click', () => {
    raceCoord.resetAll();
    try { if (typeof smsFetcher !== 'undefined') { smsFetcher.usedOtps.clear(); stopSmsFetcher('logout'); } } catch(e) {}
    clearAllSession();
    try { stopOtpTimer('signinOtp'); stopOtpTimer('advanceOtp'); } catch(e) {}
    try { if (timers.token.intervalId) clearInterval(timers.token.intervalId); timers.token.intervalId = null; timers.token.expiresAt = null; timers.token.beeped = false; refreshTokenCdUI(); } catch(e) {}
    document.getElementById('login-otp').value = '';
    logStatus('🔓 Logged out', 'y');
});

// ==================== FETCH TAB CUSTOM REQUEST (repeat loop) ====================
// Accepts BOTH the JSON config { "url":..., "method":..., "headers":{}, "body":... }
// AND a browser "Copy as fetch" snippet: fetch("URL", { headers:{...}, body:..., method:... }).
function parseFetchInput(raw) {
    raw = (raw || '').trim();
    if (/^fetch\s*\(/.test(raw)) {
        const urlM = raw.match(/fetch\s*\(\s*(["'`])([\s\S]*?)\1/);
        const url = urlM ? urlM[2] : null;
        let opts = {};
        const braceStart = raw.indexOf('{', urlM ? urlM.index + urlM[0].length : 0);
        if (braceStart !== -1) {
            let depth = 0, end = -1, q = null;
            for (let i = braceStart; i < raw.length; i++) {
                const ch = raw[i];
                if (q) { if (ch === '\\') { i++; continue; } if (ch === q) q = null; continue; }
                if (ch === '"' || ch === "'" || ch === '`') q = ch;
                else if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
            }
            if (end !== -1) { try { opts = JSON.parse(raw.slice(braceStart, end + 1)); } catch(e) { opts = {}; } }
        }
        return { url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ?? null };
    }
    const c = JSON.parse(raw);
    return { url: c.url, method: c.method || 'GET', headers: c.headers || {}, body: c.body ?? null };
}

const _fetchLoop = { running: false, timer: null, config: null, count: 0 };
function _setFetchLoopBtn(running) {
    const btn = document.getElementById('ivac-btn-fetch-send');
    if (!btn) return;
    btn.textContent = running ? '⏹ Stop' : '▶ Start';
    btn.classList.toggle('b8', running);   // red while running
    btn.classList.toggle('b5', !running);  // green while idle
}
function stopFetchLoop(reason) {
    if (_fetchLoop.timer) { clearInterval(_fetchLoop.timer); _fetchLoop.timer = null; }
    _fetchLoop.running = false;
    _setFetchLoopBtn(false);
    if (reason) logStatus(`⏹ Fetch loop stopped (${reason})`, 'y');
}
// FIRE-AND-FORGET: response er jonno wait kore na. Stop na kora porjonto proti delay-ms e
// ekta notun request fire kore (overlapping). Ekbar-ta sathe sathe, tarpor setInterval.
function _fetchLoopFire() {
    if (!_fetchLoop.running) return;
    const c = _fetchLoop.config;
    const n = ++_fetchLoop.count;
    let body = c.body; if (body && typeof body === 'object') body = JSON.stringify(body);
    // GM toggle ON (default) → GM_xmlhttpRequest (CORS-immune, but invisible to DevTools Fetch/XHR).
    // OFF → native fetch (shows in DevTools Network, but blocked on no-CORS URLs).
    const useGM = document.getElementById('ivac-fetch-gm-toggle')?.classList.contains('on') !== false;
    H2.fetchH2(c.url, { method: c.method, headers: c.headers, body, forceGM: useGM })
        .then(async r => {
            const text = await r.text();
            let pretty = text; try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch(e) {}
            console.log(`%c[RJ Fetch Loop #${n}] ${c.method} ${r.status}`, 'color:#4ade80;font-weight:700', pretty.slice(0, 1500));
            logStatus(`📡 #${n} ${c.method} ${r.status} ${r.statusText}`, r.ok ? 'g' : 'y');
        })
        .catch(err => {
            console.log(`%c[RJ Fetch Loop #${n}] error: ${err.message}`, 'color:#fca5a5;font-weight:700');
            logStatus(`❌ #${n} Fetch error: ${err.message}`, 'r');
        });
}
document.getElementById('ivac-btn-fetch-send')?.addEventListener('click', () => {
    if (_fetchLoop.running) { stopFetchLoop('manual'); return; }
    let config;
    try { config = parseFetchInput(document.getElementById('ivac-fetch-input')?.value || ''); }
    catch(e) { logStatus('❌ Invalid input — paste a fetch(...) snippet or {url,method,headers,body} JSON', 'r'); return; }
    if (!config.url) { logStatus('❌ Missing url in request', 'r'); return; }
    _fetchLoop.config = config;
    _fetchLoop.count = 0;
    _fetchLoop.running = true;
    _setFetchLoopBtn(true);
    const delay = Math.max(0, +document.getElementById('ivac-fetch-delay')?.value || 1000);
    logStatus(`▶ Fetch loop started — ${config.method} every ${delay}ms (fire-and-forget)`, 'g');
    _fetchLoopFire();                                        // prothom ta sathe sathe
    _fetchLoop.timer = setInterval(_fetchLoopFire, delay);   // response er opekkha na kore
});

// ==================== FIX UI POSITION ====================
setTimeout(() => { if (panel) { panel.style.transform = 'translateY(-50%)'; panel.style.top = '50%'; panel.style.right = '20px'; } }, 100);

// ==================== SESSION RESTORE ====================
setTimeout(() => { try { const restored = restoreSession(); if (restored) { const ageMin = Math.floor((Date.now() - sessionState.loggedInAt) / 60000); const ageSec = Math.floor(((Date.now() - sessionState.loggedInAt) % 60000) / 1000); const status = sessionState.isVerified ? 'verified' : 'unverified (need OTP)'; const h2Status = H2.getStats().h2Confirmed ? 'H/2 ✅' : 'H/2 ⏳'; logStatus(`🔓 Session restored • ${status} • ${ageMin}m ${ageSec}s old • ${h2Status}`, 'g'); if (sessionState.phone) { const phoneInp = document.getElementById('login-phone'); if (phoneInp && !phoneInp.value) phoneInp.value = sessionState.phone; } } } catch(e) {} }, 600);

// ==================== SERVER-UP WATCHER + CONFIG-GATED AUTO-START ====================
// 503 window এ থেকেও (reload ছাড়াই) background poll করে — server up হলেই bundle live-scan
// করে encryption config resolve করে; config ready (Encrypt tab এ Active) হলে তবেই Signin
// auto শুরু করে। logged-in/valid session থাকলে কিছুই auto-click হয় না।
// ── AUTO-START WATCHER DISABLED ──────────────────────────────────────────────
// The old watcher polled every 1s and called encConfigAutoFetch(false) in a loop,
// which fetched/parsed the huge bundle repeatedly and hung the browser — and could
// fire signin off a stale/half-resolved config. Per request, encryption config is now
// resolved ONLY on a manual SCAN (⟳) click, and auto-signin fires from that same
// handler once the config is freshly resolved and activated (see scan-btn handler).
(function serverUpWatcherAutoStart() {
    /* intentionally disabled — see scan-btn handler for manual scan + auto-signin */
})();

// ==================================================================
//  ★★★ MANUAL PANEL MODULE (clone UI, wired to RJ engine) ★★★
// ==================================================================
(function manualPanelModule() {
    const mpStop = { value: false };
    function manualStopAllImpl() { mpStop.value = true; }
    window.__rjManualStopAll = manualStopAllImpl;

    const mpCss = `
    #ivac-manual-dom-modal{position:fixed;top:148.5px;left:131px;width:265px;background:rgb(26,26,26);border:1px solid rgb(51,51,51);border-radius:10px;box-shadow:rgba(0,0,0,0.4) 0px 20px 40px;z-index:2147483646;font-family:Inter,-apple-system,sans-serif;display:flex;flex-direction:column}
    #ivac-manual-dom-modal.mp-hidden{display:none !important}
    #ivac-manual-fab{position:fixed;bottom:22px;left:86px;width:54px;height:54px;background:linear-gradient(135deg,#667eea,#5a67d8);border-radius:50%;color:#fff;font-size:1.1rem;font-weight:900;z-index:2147483647;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(102,126,234,.55),inset 0 2px 0 rgba(255,255,255,.25);cursor:pointer;border:2px solid rgba(255,255,255,.15);font-family:'Segoe UI',sans-serif}
    #ivac-manual-fab.mp-hidden{display:none !important}
    .ivac-manual-fetch-checkbox{display:none}
    .ivac-manual-fetch-slider{position:relative;display:inline-block;width:30px;height:16px;background-color:#555;border-radius:16px;transition:.4s;cursor:pointer;vertical-align:middle}
    .ivac-manual-fetch-slider:before{position:absolute;content:"";height:12px;width:12px;left:2px;bottom:2px;background-color:white;border-radius:50%;transition:.4s}
    .ivac-manual-fetch-checkbox:checked + .ivac-manual-fetch-slider{background-color:#0891b2}
    .ivac-manual-fetch-checkbox:checked + .ivac-manual-fetch-slider:before{transform:translateX(14px)}
    #ivac-manual-dom-modal .mp-on{background:#059669 !important;box-shadow:0 0 8px rgba(16,185,129,.6) !important}
    `;
    const mpStyle = document.createElement('style'); mpStyle.textContent = mpCss; document.head.appendChild(mpStyle);

    const mpHtml = `
    <div id="ivac-manual-fab">M</div>
    <div id="ivac-manual-dom-modal" class="mp-hidden" data-ivac-manual-modal="true">
        <div id="mp-header" style="padding:8px 10px;cursor:move;background:rgb(102,126,234);color:white;border-radius:10px 10px 0 0;display:flex;justify-content:space-between;align-items:center;user-select:none;">
            <div style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:800;"><span style="font-size:15px;">🖐</span><span>Manual</span></div>
            <div style="display:flex;gap:4px;">
              <button type="button" id="mp-min" style="width:24px;height:24px;border:none;border-radius:6px;background:rgba(255,255,255,0.15);color:#fff;cursor:pointer;font-size:14px;line-height:1;">−</button>
              <button type="button" id="mp-close" style="width:24px;height:24px;border:none;border-radius:6px;background:rgba(255,255,255,0.15);color:#fff;cursor:pointer;font-size:12px;line-height:1;">✖</button>
            </div>
        </div>
        <div style="padding:8px;background:rgb(26,26,26);">
            <div style="background:#2a2a2a;border:1px solid #444;border-radius:6px;padding:6px;">
                <div style="display:flex;gap:4px;margin-bottom:5px;align-items:center;">
                    <select id="mp-profile-select" title="Select profile" style="flex:1;min-width:0;padding:7px 8px;border:1px solid #555;border-radius:4px;font-size:10px;background:#333;color:#fff;min-height:28px;"><option value="">Profile</option></select>
                </div>
                <div style="display:flex;gap:4px;margin-bottom:5px;align-items:center;">
                    <button type="button" id="mp-btn-number-password" title="Fill phone+password from selected profile" style="flex:1;min-width:0;padding:7px 8px;font-size:10px;border-radius:4px;border:none;cursor:pointer;color:#fff;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:28px;background:#7f1d1d;">Number Password</button>
                    <button type="button" id="mp-signin-btn" style="flex:1;min-width:0;padding:7px 8px;font-size:10px;border-radius:4px;border:none;cursor:pointer;color:#fff;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:28px;background:#0891b2;">Signin</button>
                    <label title="ON: API fetch. OFF: DOM click Sign In Now." style="display:flex;align-items:center;flex-shrink:0;"><span class="ivac-manual-fetch-toggle"><input type="checkbox" id="mp-signin-fetch-toggle" class="ivac-manual-fetch-checkbox"><span class="ivac-manual-fetch-slider"></span></span></label>
                    <input type="number" id="mp-signin-sec" min="0.1" max="60" step="0.1" value="1" placeholder="Sec" title="Signin retry delay (sec)" style="width:36px;min-width:36px;padding:6px 3px;border:1px solid #555;border-radius:4px;font-size:10px;background:#333;color:#fff;box-sizing:border-box;text-align:center;">
                </div>
                <div style="display:flex;gap:4px;margin-bottom:5px;align-items:center;">
                    <button type="button" id="mp-get-otp-btn" style="flex:1;min-width:0;padding:7px 8px;font-size:10px;border-radius:4px;border:none;cursor:pointer;color:#fff;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:28px;background:#c026d3;">Get Signin OTP</button>
                    <button type="button" id="mp-verify-btn" style="flex:1;min-width:0;padding:7px 8px;font-size:10px;border-radius:4px;border:none;cursor:pointer;color:#fff;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:28px;background:#d97706;">Verify</button>
                    <label title="ON: API fetch. OFF: DOM click Verify OTP." style="display:flex;align-items:center;flex-shrink:0;"><span class="ivac-manual-fetch-toggle"><input type="checkbox" id="mp-verify-fetch-toggle" class="ivac-manual-fetch-checkbox"><span class="ivac-manual-fetch-slider"></span></span></label>
                    <input type="number" id="mp-verify-sec" min="0.1" max="60" step="0.1" value="1" placeholder="Sec" title="Verify retry delay (sec)" style="width:36px;min-width:36px;padding:6px 3px;border:1px solid #555;border-radius:4px;font-size:10px;background:#333;color:#fff;box-sizing:border-box;text-align:center;">
                </div>
                <div style="display:flex;gap:4px;margin-bottom:5px;align-items:center;">
                    <input type="text" id="mp-otp-input" maxlength="6" inputmode="numeric" placeholder="OTP" title="Manual OTP input (6 digits)" style="flex:1;min-width:0;padding:7px 8px;border:1px solid #555;border-radius:4px;font-size:10px;background:#333;color:#fff;min-height:28px;">
                    <button type="button" id="mp-date-page-btn" style="min-width:0;padding:7px 8px;font-size:10px;border-radius:4px;border:none;cursor:pointer;color:#fff;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:28px;flex:0 0 84px;background:#2563eb;">Date Page</button>
                </div>
                <div style="display:flex;gap:4px;margin-bottom:5px;align-items:center;">
                    <button type="button" id="mp-reserve-btn" style="flex:1;min-width:0;padding:7px 8px;font-size:10px;border-radius:4px;border:none;cursor:pointer;color:#fff;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:28px;background:#0d9488;">Reserveslot</button>
                    <label title="ON: API fetch. OFF: DOM click Continue Booking." style="display:flex;align-items:center;flex-shrink:0;"><span class="ivac-manual-fetch-toggle"><input type="checkbox" id="mp-reserve-fetch-toggle" class="ivac-manual-fetch-checkbox"><span class="ivac-manual-fetch-slider"></span></span></label>
                    <input type="number" id="mp-reserve-sec" min="0.1" max="60" step="0.1" value="1" placeholder="Sec" title="Reserve retry delay (sec)" style="width:36px;min-width:36px;padding:6px 3px;border:1px solid #555;border-radius:4px;font-size:10px;background:#333;color:#fff;box-sizing:border-box;text-align:center;">
                </div>
                <div style="display:flex;gap:4px;margin-bottom:5px;align-items:center;">
                    <button type="button" id="mp-book-btn" style="flex:1;min-width:0;padding:7px 8px;font-size:10px;border-radius:4px;border:none;cursor:pointer;color:#fff;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:28px;background:#059669;">Book</button>
                    <input type="number" id="mp-book-sec" min="0.1" max="60" step="0.1" value="1" placeholder="Sec" title="Book retry delay (sec)" style="width:36px;min-width:36px;padding:6px 3px;border:1px solid #555;border-radius:4px;font-size:10px;background:#333;color:#fff;box-sizing:border-box;text-align:center;">
                </div>
                <div style="display:flex;gap:4px;margin-bottom:5px;align-items:center;">
                    <button type="button" id="mp-initiate-btn" style="flex:1;min-width:0;padding:7px 8px;font-size:10px;border-radius:4px;border:none;cursor:pointer;color:#fff;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:28px;background:#7c3aed;">Initiate</button>
                    <input type="number" id="mp-initiate-sec" min="0.1" max="60" step="0.1" value="1" placeholder="Sec" title="Initiate retry delay (sec)" style="width:36px;min-width:36px;padding:6px 3px;border:1px solid #555;border-radius:4px;font-size:10px;background:#333;color:#fff;box-sizing:border-box;text-align:center;">
                </div>
                <div style="display:flex;gap:4px;margin-bottom:0;align-items:center;">
                    <button type="button" id="mp-btn-single" title="Single: retry on failure (mirrors main Single)" style="flex:1 1 0%;min-width:0;padding:7px 8px;font-size:10px;border-radius:4px;border:none;cursor:pointer;color:#fff;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:28px;background:#b91c1c;">Single</button>
                    <input type="number" id="mp-auto-delay-sec" min="1" max="999" value="1" placeholder="Sec" title="Auto delay between steps" style="width:42px;min-width:42px;padding:6px 3px;border:1px solid #555;border-radius:4px;font-size:10px;background:#333;color:#fff;box-sizing:border-box;text-align:center;">
                    <button type="button" id="mp-btn-auto" title="Auto: chain to next step after success (mirrors main Auto)" style="flex:1 1 0%;min-width:0;padding:7px 8px;font-size:10px;border-radius:4px;border:none;cursor:pointer;color:#fff;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:28px;background:#b91c1c;">Auto</button>
                </div>
            </div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', mpHtml);

    const modal = document.getElementById('ivac-manual-dom-modal');
    const mpFab = document.getElementById('ivac-manual-fab');

    function mpMinimize() { modal.classList.add('mp-hidden'); mpFab.classList.remove('mp-hidden'); }
    function mpMaximize() { modal.classList.remove('mp-hidden'); mpFab.classList.add('mp-hidden'); }
    document.getElementById('mp-min')?.addEventListener('click', mpMinimize);
    document.getElementById('mp-close')?.addEventListener('click', () => { modal.classList.add('mp-hidden'); mpFab.classList.remove('mp-hidden'); });
    mpFab.addEventListener('click', mpMaximize);

    try { makeDraggable(document.getElementById('mp-header'), modal); } catch(e) {}

    function refreshManualProfileSelectImpl() {
        const sel = document.getElementById('mp-profile-select'); if (!sel) return;
        const cur = sel.value;
        sel.innerHTML = '<option value="">Profile</option>';
        Object.keys(profiles).forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
        sel.value = (profiles[activeProfileName] ? activeProfileName : (profiles[cur] ? cur : ''));
    }
    function syncManualProfileSelectImpl(name) { const sel = document.getElementById('mp-profile-select'); if (sel && profiles[name]) sel.value = name; }
    window.__rjRefreshManualProfileSelect = refreshManualProfileSelectImpl;
    window.__rjSyncManualProfileSelect = syncManualProfileSelectImpl;
    refreshManualProfileSelectImpl();

    document.getElementById('mp-profile-select')?.addEventListener('change', (e) => {
        if (!e.target.value) return;
        try { saveFormToProfile(); } catch(err) {}
        loadProfileToForm(e.target.value);
        try { refreshProfileSelects(); } catch(err) {}
        logStatus(`✓ Manual profile: ${e.target.value}`, 'g');
    });

    function syncSingleAutoVisual() {
        const s = document.getElementById('mp-btn-single'); const a = document.getElementById('mp-btn-auto');
        if (s) s.style.background = isSingleOn() ? '#059669' : '#b91c1c';
        if (a) a.style.background = isAutoOn() ? '#059669' : '#b91c1c';
    }
    function toggleRjButton(id) { const b = document.getElementById(id); if (!b) return; if (b.classList.contains('b8')) { b.classList.remove('b8'); b.classList.add('b5'); } else { b.classList.remove('b5'); b.classList.add('b8'); } }
    document.getElementById('mp-btn-single')?.addEventListener('click', () => { toggleRjButton('btn-single'); syncSingleAutoVisual(); });
    document.getElementById('mp-btn-auto')?.addEventListener('click', () => { toggleRjButton('btn-auto'); syncSingleAutoVisual(); });
    setInterval(syncSingleAutoVisual, 800); syncSingleAutoVisual();

    function mpSetNativeValue(el, value) {
        try { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, value); } catch(e) { el.value = value; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function mpEnableBtn(btn) { if (!btn) return; try { btn.removeAttribute('disabled'); btn.disabled = false; btn.classList.remove('disabled', 'opacity-50', 'cursor-not-allowed', 'pointer-events-none'); btn.style.opacity = '1'; btn.style.cursor = 'pointer'; btn.style.pointerEvents = 'auto'; } catch(e) {} }
    function mpVisibleButtons() { return Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null && !b.closest('#ivac-manual-dom-modal') && !b.closest('#p') && !b.closest('#profile-manager') && !b.closest('#rj-netlog')); }
    function mpFindButtonByText(matchers) {
        for (const b of mpVisibleButtons()) {
            const txt = (b.textContent || b.innerText || '').trim().toLowerCase();
            if (matchers.some(m => txt === m || txt.includes(m))) return b;
        }
        return null;
    }
    function mpFindSigninNow() { const b = mpFindButtonByText(['sign in now', 'signin now']); return b; }
    function mpFindContinueBooking() { return mpFindButtonByText(['continue booking']); }
    function mpFindVerifyBtn() { return mpFindButtonByText(['verify otp', 'verify now', 'verify']); }

    function mpGetPhone() {
        const fromSession = sessionState.phone;
        const fromProfile = (profiles[activeProfileName]?.phone1 || '').trim();
        const pageInp = document.querySelector('input[name="phone"], input[type="tel"], input[placeholder*="01"]');
        const fromPage = pageInp && pageInp.value ? pageInp.value.trim() : '';
        return fromSession || fromProfile || fromPage || (document.getElementById('login-phone')?.value || '').trim();
    }

    function mpFillOtpToPage(otp) {
        if (!otp || otp.length !== 6) return false;
        const allInputs = Array.from(document.querySelectorAll('input'));
        const boxes = allInputs.filter(i => i.getAttribute('maxlength') === '1' && i.offsetParent !== null);
        if (boxes.length >= 6) {
            for (let i = 0; i < 6; i++) { mpSetNativeValue(boxes[i], otp[i]); if (i < 5 && boxes[i+1]) setTimeout(() => boxes[i+1].focus(), 25 * i); }
            setTimeout(() => { try { boxes[5].blur(); boxes[5].dispatchEvent(new Event('blur', { bubbles: true })); } catch(e) {} }, 250);
            setTimeout(() => { const vb = mpFindVerifyBtn(); mpEnableBtn(vb); }, 300);
            return true;
        }
        const single = document.querySelector('input[maxlength="6"], input[placeholder*="OTP"], #login-otp');
        if (single) { mpSetNativeValue(single, otp); single.dispatchEvent(new Event('blur', { bubbles: true })); setTimeout(() => mpEnableBtn(mpFindVerifyBtn()), 200); return true; }
        return false;
    }

    async function mpDomClickLoop(label, finder, secInputId, postEnable) {
        mpStop.value = false;
        const sec = Math.max(0.1, +document.getElementById(secInputId)?.value || 1);
        while (!mpStop.value) {
            const btn = finder();
            if (btn) { if (postEnable) mpEnableBtn(btn); btn.click(); logStatus(`🖐 Manual ${label}: clicked page button`, 'g'); }
            else { logStatus(`⚠ Manual ${label}: page button not found`, 'y'); }
            if (!isSingleOn()) break;
            await new Promise(r => setTimeout(r, sec * 1000));
        }
    }

    function mpSyncSec(step, secInputId, rtId) { const v = document.getElementById(secInputId)?.value; if (v != null && document.getElementById(rtId)) document.getElementById(rtId).value = v; }

    document.getElementById('mp-btn-number-password')?.addEventListener('click', () => {
        const sel = document.getElementById('mp-profile-select');
        if (sel && sel.value && profiles[sel.value]) { try { saveFormToProfile(); } catch(e) {} loadProfileToForm(sel.value); try { refreshProfileSelects(); } catch(e) {} }
        const prof = profiles[activeProfileName] || {};
        const phone = (prof.phone1 || '').trim();
        const pass = prof.mobilePass || '';
        const lp = document.getElementById('login-phone'); const lpass = document.getElementById('login-password');
        if (lp) lp.value = phone; if (lpass) lpass.value = pass;
        const pagePhone = document.querySelector('input[name="phone"], input[type="tel"], input[placeholder*="01"]');
        const pagePass = document.querySelector('input[name="password"], input[type="password"]');
        if (pagePhone) mpSetNativeValue(pagePhone, phone);
        if (pagePass) mpSetNativeValue(pagePass, pass);
        setTimeout(() => mpEnableBtn(mpFindSigninNow()), 100);
        setTimeout(() => mpEnableBtn(mpFindSigninNow()), 500);
        setTimeout(() => mpEnableBtn(mpFindSigninNow()), 1000);
        logStatus(`📋 Manual: filled phone+password for ${activeProfileName}`, 'g');
    });

    document.getElementById('mp-signin-btn')?.addEventListener('click', async () => {
        const apiMode = document.getElementById('mp-signin-fetch-toggle')?.checked;
        if (apiMode) { mpSyncSec('signin', 'mp-signin-sec', 'rt-signin'); logStatus('🔑 Manual Signin (API via queue)…', 'y'); await manualStepClick('signin'); }
        else { logStatus('🖐 Manual Signin (DOM: Sign In Now)…', 'y'); await mpDomClickLoop('Signin', mpFindSigninNow, 'mp-signin-sec', true); }
    });

    document.getElementById('mp-get-otp-btn')?.addEventListener('click', () => {
        const phone = mpGetPhone();
        if (!phone) { logStatus('❌ Manual: no phone for OTP', 'r'); return; }
        logStatus(`📱 Manual OTP fetch for ${phone}…`, 'y');
        startSmsFetcher(phone, async (otp) => {
            const mi = document.getElementById('mp-otp-input'); if (mi) { mi.value = otp; mi.style.background = '#1a3a1a'; setTimeout(() => mi.style.background = '#333', 1200); }
            const li = document.getElementById('login-otp'); if (li) li.value = otp;
            mpFillOtpToPage(otp);
            logStatus(`📩 Manual OTP: ${otp}`, 'g');
            return undefined;
        }, false, true);
    });

    document.getElementById('mp-verify-btn')?.addEventListener('click', async () => {
        const mi = (document.getElementById('mp-otp-input')?.value || '').trim();
        if (mi) { const li = document.getElementById('login-otp'); if (li) li.value = mi; mpFillOtpToPage(mi); }
        const apiMode = document.getElementById('mp-verify-fetch-toggle')?.checked;
        if (apiMode) { mpSyncSec('verify', 'mp-verify-sec', 'rt-verify'); logStatus('🔓 Manual Verify (API)…', 'y'); await manualStepClick('verify'); }
        else { logStatus('🖐 Manual Verify (DOM: Verify OTP)…', 'y'); await mpDomClickLoop('Verify', mpFindVerifyBtn, 'mp-verify-sec', true); }
    });

    document.getElementById('mp-date-page-btn')?.addEventListener('click', () => { window.open('https://appointment.ivacbd.com/appointment/time-slot', '_blank'); logStatus('🗓 Manual: opened Date (time-slot) page', 'g'); });

    document.getElementById('mp-reserve-btn')?.addEventListener('click', async () => {
        const apiMode = document.getElementById('mp-reserve-fetch-toggle')?.checked;
        if (apiMode) { mpSyncSec('reserve', 'mp-reserve-sec', 'rt-reserve'); logStatus('🎯 Manual Reserve (API)…', 'y'); await manualStepClick('reserve'); }
        else { logStatus('🖐 Manual Reserve (DOM: Continue Booking)…', 'y'); await mpDomClickLoop('Reserve', mpFindContinueBooking, 'mp-reserve-sec', false); }
    });

    document.getElementById('mp-book-btn')?.addEventListener('click', async () => { mpSyncSec('book', 'mp-book-sec', 'rt-book'); logStatus('📋 Manual Book (API)…', 'y'); await manualStepClick('book'); });

    document.getElementById('mp-initiate-btn')?.addEventListener('click', async () => { mpSyncSec('initiate', 'mp-initiate-sec', 'rt-initiate'); logStatus('💳 Manual Initiate (API)…', 'y'); await manualStepClick('initiate'); });

    function mpAutoCloseNotices() {
        try {
            document.querySelectorAll('button[aria-label="Close notice"], button[aria-label="Close popup"]').forEach(b => { if (b.offsetParent !== null) { b.click(); } });
        } catch(e) {}
    }
    try {
        const mo = new MutationObserver(() => mpAutoCloseNotices());
        mo.observe(document.body, { childList: true, subtree: true });
        setInterval(mpAutoCloseNotices, 1500);
        mpAutoCloseNotices();
    } catch(e) {}

    logStatus('🖐 Manual Panel ready (minimized)', 'g');
})();


})();
