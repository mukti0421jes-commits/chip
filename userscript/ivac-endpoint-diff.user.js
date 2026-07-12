// ==UserScript==
// @name         IVAC Endpoint Diff Checker
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Auto-extracts the API endpoint segments from the live IVAC bundle chunks, compares them with the endpoints your RJ SLOT script uses, and highlights any change in the console (and a tiny on-page badge). Run-only diagnostics — sends nothing.
// @author       RJ SLOT
// @match        https://appointment.ivacbd.com/*
// @match        https://*.ivacbd.com/*
// @match        https://ivacbd.com/*
// @connect      api.ivacbd.com
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @run-at       document-end
// @noframes
// ==/UserScript==
(function () {
    'use strict';

    // ── page-context fetch (same trick as the main script) ──
    const pageFetch = (() => {
        try { if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.fetch === 'function') return unsafeWindow.fetch.bind(unsafeWindow); } catch (e) {}
        return window.fetch.bind(window);
    })();
    function gmGet(url) {
        return new Promise((resolve, reject) => {
            const api = (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) || (typeof GM !== 'undefined' && GM.xmlHttpRequest);
            if (!api) return reject(new Error('no GM'));
            api({ method: 'GET', url, timeout: 30000, onload: r => resolve(r.responseText || ''), onerror: () => reject(new Error('gm error')), ontimeout: () => reject(new Error('gm timeout')) });
        });
    }
    async function fetchText(url) {
        try { const r = await pageFetch(url, { cache: 'no-store' }); if (r.ok) return await r.text(); } catch (e) {}
        try { return await gmGet(url); } catch (e) {}
        return null;
    }

    // ── collect all /assets/*.js chunk URLs (DOM + index.html) ──
    async function findBundleUrls() {
        const RE_G = /\/assets\/[a-zA-Z0-9]{8,}(?:-[a-zA-Z0-9]+)+\.js/g;
        const RE = /\/assets\/[a-zA-Z0-9]{8,}(?:-[a-zA-Z0-9]+)+\.js(?:$|\?)/;
        const seen = new Set(); const urls = [];
        const add = u => { if (u && !seen.has(u)) { seen.add(u); urls.push(u); } };
        // 1) already-loaded scripts in the DOM
        [...document.querySelectorAll('script[src]')].forEach(s => { if (RE.test(s.src)) add(s.src); });
        // 2) preload/modulepreload <link> tags (Vite emits these for chunks not yet executed)
        [...document.querySelectorAll('link[href]')].forEach(l => { if (RE.test(l.href)) add(l.href); });
        // 3) resources the browser has already fetched (works even when index.html fetch is CF-blocked)
        try { performance.getEntriesByType('resource').forEach(e => { if (RE.test(e.name)) add(e.name.startsWith('http') ? e.name : new URL(e.name, location.origin).href); }); } catch (e) {}
        // 4) last resort: parse index.html (may 403 during a Cloudflare block window)
        if (!urls.length) {
            const html = await fetchText(location.origin + '/');
            if (html) { let m; while ((m = RE_G.exec(html)) !== null) add(new URL(m[0], location.origin).href); }
        }
        return urls;
    }

    // ── the endpoints your RJ SLOT script currently uses ──
    // sig  = the distinctive leaf segment that should appear as a plain string in the bundle.
    // re   = a looser pattern to catch a CHANGED variant (e.g. sign-in-v4 → sign-in-v5).
    // obf  = true when the path is built via obfuscated concatenation (can't verify literally).
    // my    = full endpoint your RJ SLOT code calls (shown as reference)
    // leaf  = the path RELATIVE to the axios baseURL — this is the literal that appears in the bundle
    //         (bundle stores "/auth/sign-in-v4", "/slots/<uuid>/reserve-slot", etc.). We compare THIS.
    // sig   = distinctive substring used to locate the literal in the bundle
    // obf   = built by obfuscated concatenation → can't verify literally
    const ENDPOINTS = [
        { name: 'Signin',        my: '/iams/api/v1/auth/sign-in-v4',                        leaf: '/auth/sign-in-v4',                 sig: 'sign-in-v4' },
        { name: 'Verify',        my: '/iams/api/v1/otp/verifySigninOtp',                    leaf: '/otp/verifySigninOtp',             sig: 'verifySigninOtp' },
        { name: 'GetBookingConfig', my: '/iams/api/v1/appointment/get-booking-config',      leaf: '/appointment/get-booking-config',  sig: 'get-booking-config' },
        { name: 'Reserve',       my: '/iams/api/v1/slots/ccd3dd63-e781-48ba-a48d-c65eaa4fc663/reserve-slot', leaf: '/slots/ccd3dd63-e781-48ba-a48d-c65eaa4fc663/reserve-slot', sig: 'reserve-slot', exact: true },
        { name: 'Initiate',      my: '/iams/api/v1/payment/dg-epay/initiate',               leaf: '/payment/dg-epay/initiate',        sig: 'dg-epay', obf: true },
        { name: 'BookingConfirm',my: '/iams/api/v1/appointment/appointment-booking-config', leaf: '/appointment/appointment-booking-config', sig: 'appointment-booking-config' },
        { name: 'Upload',        my: '/iams/api/v1/file/upload-file',                       leaf: '/file/upload-file',                sig: 'upload-file' },
        { name: 'SlotStatus',    my: '/iams/api/v1/file/file-confirmation-and-slot-status', leaf: '/file/file-confirmation-and-slot-status', sig: 'file-confirmation-and-slot-status' },
        { name: 'SignupOTP',     my: '/iams/api/v1/otp/signupOtp',                          leaf: '/otp/signupOtp',                   sig: 'signupOtp' },
        { name: 'VerifyOTP',     my: '/iams/api/v1/otp/verifyOtp',                          leaf: '/otp/verifyOtp',                   sig: 'verifyOtp' },
        { name: 'ForgotOTP',     my: '/iams/api/v1/forgot-password/sendOtp',                leaf: '/forgot-password/sendOtp',         sig: 'forgot-password' }
    ];

    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const normId = s => (s || '').replace(UUID_RE, '{id}');   // so slots/<uuid>/ == slots/{id}/

    // Pull the WHOLE quoted string literal that contains `sig` (e.g. sign-in-v4 → "/auth/sign-in-v4").
    function extractLiteral(text, sig) {
        const i = text.indexOf(sig); if (i === -1) return '';
        const quotes = ['"', "'", '`'];
        let L = i; while (L > 0 && !quotes.includes(text[L - 1])) { if (i - L > 200) break; L--; }
        let R = i + sig.length; while (R < text.length && !quotes.includes(text[R])) { if (R - i > 200) break; R++; }
        return text.slice(L, R);
    }

    function scan(bundleText) {
        return ENDPOINTS.map(ep => {
            const present = bundleText.indexOf(ep.sig) !== -1;
            if (ep.obf) return { ...ep, status: present ? 'OBFUSCATED' : 'OBFUSCATED', bundle: '' };
            if (!present) return { ...ep, status: 'MISSING', bundle: '' };
            const bundle = extractLiteral(bundleText, ep.sig);      // e.g. /slots/<uuid>/reserve-slot
            // exact:true (reserve) → compare the real slot id too, so a changed uuid is caught;
            // otherwise treat any uuid as {id}.
            const match = ep.exact ? (bundle === ep.leaf) : (normId(bundle) === normId(ep.leaf));
            return { ...ep, status: match ? 'OK' : 'CHANGED', bundle };
        });
    }

    function report(results, chunkInfo) {
        const C = { ok: 'color:#16a34a;font-weight:700', chg: 'color:#f59e0b;font-weight:800;background:#3a2a00;padding:1px 4px', miss: 'color:#ef4444;font-weight:800;background:#3a0000;padding:1px 4px', obf: 'color:#8888aa', head: 'color:#a78bfa;font-weight:800;font-size:13px', dim: 'color:#8888aa' };
        console.log('%c━━━ IVAC Endpoint Diff ━━━', C.head);
        console.log('%c' + chunkInfo, C.dim);
        const pad = s => (s + '                ').slice(0, 16);
        let changed = 0, missing = 0;
        results.forEach(r => {
            if (r.status === 'OK') {
                // green — matches. Shows your full endpoint + the exact literal the bundle uses (reserve incl. real slot id)
                console.log('%c✓ ' + pad(r.name) + '%c' + r.my + '%c   ↔ bundle: ' + r.bundle, C.ok, 'color:#c4b5fd', C.dim);
            } else if (r.status === 'CHANGED') {
                changed++;
                // yellow — MISMATCH. Update your code to the bundle value.
                console.log('%c⚠ ' + pad(r.name) + 'MISMATCH%c', C.chg, '');
                console.log('%c      your code : ' + r.my + '   (leaf: ' + r.leaf + ')', C.dim);
                console.log('%c      bundle now: ' + r.bundle + '   ← update to this', 'color:#f59e0b;font-weight:700');
            } else if (r.status === 'MISSING') {
                missing++;
                // red — the segment is gone from the bundle (renamed/removed)
                console.log('%c✗ ' + pad(r.name) + 'NOT FOUND in bundle%c', C.miss, '');
                console.log('%c      your code : ' + r.my + '   — "' + r.sig + '" no longer present; endpoint likely renamed', 'color:#fca5a5');
            } else {
                console.log('%c• ' + pad(r.name) + '%cobfuscated in bundle — cannot verify literally. Your code: ' + r.my, C.obf, C.dim);
            }
        });
        // ── 🔧 ACTION NEEDED — copy-ready fixes for exactly what to change in your RJ SLOT script ──
        const BASE = 'https://api.ivacbd.com/iams/api/v1';
        // where each endpoint lives in your script (constant name, or a note for inline URLs)
        const WHERE = {
            Signin: 'API_SIGNIN_V2', Verify: 'API_VERIFY', GetBookingConfig: 'API_BOOK',
            Initiate: 'API_INITIATE', ForgotOTP: 'API_FORGOT', SlotStatus: 'API_SLOT_STATUS',
            Reserve: 'RESERVE_SLOT_ID_FIXED', BookingConfirm: 'appointment-booking-config URL (Upload tab handler)',
            Upload: 'upload-file URL (uploadFile fn)', SignupOTP: 'signupOtp URL (Sign Up handlers)', VerifyOTP: 'verifyOtp URL (Sign Up handlers)'
        };
        const actions = results.filter(r => r.status === 'CHANGED' || r.status === 'MISSING').map(r => {
            if (r.name === 'Reserve') {
                const m = (r.bundle || '').match(UUID_RE);
                const id = m ? m[0] : '<new-uuid-from-bundle>';
                return { name: r.name, line: `const RESERVE_SLOT_ID_FIXED = '${id}';   // ← set this new slot id` };
            }
            const full = r.bundle ? (BASE + r.bundle) : '<endpoint changed — check bundle>';
            const w = WHERE[r.name] || (r.name + ' URL');
            return { name: r.name, line: (w.startsWith('API_') ? `const ${w} = "${full}";` : `Update ${w}  →  "${full}"`) };
        });
        if (actions.length) {
            console.log('%c🔧 ACTION NEEDED — update these in your RJ SLOT script:', 'color:#f59e0b;font-weight:800;font-size:13px');
            actions.forEach(a => console.log('%c   ' + a.line, 'color:#fde047;font-weight:700;font-family:Consolas,monospace'));
        }
        const summary = changed || missing
            ? `%c⚠ ${changed} changed, ${missing} missing — see 🔧 ACTION NEEDED above.`
            : '%c✓ All verifiable endpoints match your code — nothing to update.';
        console.log(summary, changed || missing ? C.chg : C.ok);
        badge(changed, missing, results);
        return { changed, missing };
    }

    function badge(changed, missing, results) {
        let el = document.getElementById('ivac-epdiff-badge');
        if (!el) {
            el = document.createElement('div');
            el.id = 'ivac-epdiff-badge';
            el.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:2147483647;font:700 12px Consolas,monospace;padding:7px 11px;border-radius:8px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.5);color:#fff;user-select:none';
            el.title = 'Click to re-scan endpoints (see console)';
            el.addEventListener('click', () => run(true));
            document.body.appendChild(el);
        }
        const bad = changed || missing;
        el.style.background = bad ? 'linear-gradient(135deg,#ef4444,#b91c1c)' : 'linear-gradient(135deg,#10b981,#059669)';
        el.textContent = bad ? `⚠ EP diff: ${changed}C/${missing}M` : '✓ EP endpoints OK';
    }

    let _lastSig = '';   // signature of the chunk set last scanned → re-scan only when the build changes
    // returns: 'done' (scanned), 'nochunks' (server 503/403 / not loaded), 'nomatch' (chunks but no endpoints)
    async function run(force) {
        const urls = await findBundleUrls();
        if (!urls.length) return 'nochunks';
        // pick the chunk(s) that actually contain endpoint strings; scan the concatenation of all
        // matching chunks so segments split across chunks are still seen.
        let combined = '', used = [];
        for (const u of urls) {
            const t = await fetchText(u);
            if (!t) continue;
            if (/sign-in|reserve-slot|get-booking-config|upload-file|verifySigninOtp/.test(t)) { combined += '\n' + t; used.push(u.split('/').pop()); }
        }
        if (!combined) return 'nomatch';
        const sig = used.slice().sort().join('|');
        if (!force && sig === _lastSig) return 'done';   // same build already scanned — skip
        _lastSig = sig;
        console.log('%c[IVAC EP Diff] bundle loaded — scanning endpoints…', 'color:#a78bfa');
        const results = scan(combined);
        report(results, `chunks scanned: ${used.join(', ')}`);
        return 'done';
    }

    // ── LIVE WATCHER (mirrors the RJ SLOT encryption live-scan) ──────────────────
    // While the server is closed (503/403) the bundle isn't loadable, so poll quietly; the moment
    // index.js/chunks become available (server opens) it scans automatically and reports. After a
    // successful scan it keeps a slow re-check so a fresh deploy (new chunk hash) is caught too.
    (function watcher() {
        const tick = async () => {
            let res;
            try { res = await run(false); } catch (e) { res = 'err'; }
            if (res === 'done') {                 // scanned + reported once → STOP (no further polling)
                console.log('%c[IVAC EP Diff] scan complete — watcher stopped. Re-run any time: __ivacEpDiff() or click the badge.', 'color:#8888aa');
                return;
            }
            setTimeout(tick, 5000);               // server still 503/403 / bundle not ready → keep trying every 5s
        };
        setTimeout(tick, 1500);   // first attempt shortly after load
    })();

    try { unsafeWindow.__ivacEpDiff = () => run(true); } catch (e) { window.__ivacEpDiff = () => run(true); }
    console.log('%c[IVAC EP Diff] loaded — auto-scans the moment the bundle is available (retries while server is 503/403), then re-checks on new deploys. Force re-run: __ivacEpDiff()  (or click the badge)', 'color:#8888aa');
})();
