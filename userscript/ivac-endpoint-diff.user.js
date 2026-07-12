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
    const ENDPOINTS = [
        { name: 'Signin',        my: '/iams/api/v1/auth/sign-in-v4',                        sig: 'sign-in-v4',                 re: /sign-in-v\d+|auth\/sign-?in[\w-]*/g },
        { name: 'Verify',        my: '/iams/api/v1/otp/verifySigninOtp',                    sig: 'verifySigninOtp',            re: /verifySigninOtp|verify[A-Za-z]*Otp/g },
        { name: 'Book',          my: '/iams/api/v1/appointment/get-booking-config',         sig: 'get-booking-config',         re: /get-booking-config|booking-config/g },
        { name: 'Reserve',       my: '/iams/api/v1/slots/{id}/reserve-slot',                sig: 'reserve-slot',               re: /reserve-slot|reserveSlot/g },
        { name: 'Initiate',      my: '/iams/api/v1/payment/dg-epay/initiate',               sig: 'dg-epay',                    re: /dg-?epay|payment\/[\w-]+\/initiate/g, obf: true },
        { name: 'BookingConfirm',my: '/iams/api/v1/appointment/appointment-booking-config', sig: 'appointment-booking-config', re: /appointment-booking-config/g },
        { name: 'Upload',        my: '/iams/api/v1/file/upload-file',                       sig: 'upload-file',                re: /upload-file|file\/upload[\w-]*/g },
        { name: 'SlotStatus',    my: '/iams/api/v1/file/file-confirmation-and-slot-status', sig: 'file-confirmation-and-slot-status', re: /file-confirmation-and-slot-status/g },
        { name: 'SignupOTP',     my: '/iams/api/v1/otp/signupOtp',                          sig: 'signupOtp',                  re: /signupOtp/g },
        { name: 'VerifyOTP',     my: '/iams/api/v1/otp/verifyOtp',                          sig: 'verifyOtp',                  re: /\bverifyOtp\b/g },
        { name: 'ForgotOTP',     my: '/iams/api/v1/forgot-password/sendOtp',                sig: 'forgot-password',            re: /forgot-password/g }
    ];

    function scan(bundleText) {
        return ENDPOINTS.map(ep => {
            const present = bundleText.indexOf(ep.sig) !== -1;
            // collect distinct variant matches for context / change detection
            const variants = [...new Set((bundleText.match(ep.re) || []))];
            let status;
            if (present) status = 'OK';
            else if (variants.length) status = 'CHANGED';
            else status = ep.obf ? 'OBFUSCATED' : 'MISSING';
            return { ...ep, present, variants, status };
        });
    }

    function report(results, chunkInfo) {
        const C = { ok: 'color:#16a34a;font-weight:700', chg: 'color:#f59e0b;font-weight:800;background:#3a2a00;padding:1px 4px', miss: 'color:#ef4444;font-weight:800;background:#3a0000;padding:1px 4px', obf: 'color:#8888aa', head: 'color:#a78bfa;font-weight:800;font-size:13px', dim: 'color:#8888aa' };
        console.log('%c━━━ IVAC Endpoint Diff ━━━', C.head);
        console.log('%c' + chunkInfo, C.dim);
        let changed = 0, missing = 0;
        results.forEach(r => {
            if (r.status === 'OK') {
                console.log('%c✓ ' + r.name + '%c  ' + r.sig + '%c  (unchanged)', C.ok, C.dim, C.dim);
            } else if (r.status === 'CHANGED') {
                changed++;
                console.log('%c⚠ ' + r.name + ' CHANGED%c  expected "' + r.sig + '" — found instead: [ ' + r.variants.join(' , ') + ' ]', C.chg, C.dim);
                console.log('%c     your code uses: ' + r.my, C.dim);
            } else if (r.status === 'MISSING') {
                missing++;
                console.log('%c✗ ' + r.name + ' NOT FOUND%c  "' + r.sig + '" not in bundle — endpoint may have been renamed/removed', C.miss, C.dim);
                console.log('%c     your code uses: ' + r.my, C.dim);
            } else {
                console.log('%c• ' + r.name + '%c  obfuscated in bundle (built by concatenation) — cannot verify literally. Your code: ' + r.my, C.obf, C.dim);
            }
        });
        const summary = changed || missing
            ? `%c⚠ ${changed} changed, ${missing} missing — review the endpoints above.`
            : '%c✓ All verifiable endpoints match your code.';
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

    async function run(force) {
        console.log('%c[IVAC EP Diff] scanning bundle chunks…', 'color:#a78bfa');
        const urls = await findBundleUrls();
        if (!urls.length) { console.warn('[IVAC EP Diff] no /assets/*.js chunks found (server 503 / not loaded yet)'); return; }
        // pick the chunk(s) that actually contain endpoint strings; scan the concatenation of all
        // matching chunks so segments split across chunks are still seen.
        let combined = '', used = [];
        for (const u of urls) {
            const t = await fetchText(u);
            if (!t) continue;
            if (/sign-in|reserve-slot|get-booking-config|upload-file|verifySigninOtp/.test(t)) { combined += '\n' + t; used.push(u.split('/').pop()); }
        }
        if (!combined) { console.warn('[IVAC EP Diff] endpoints not found in any chunk (all obfuscated or wrong build?)'); return; }
        const results = scan(combined);
        report(results, `chunks scanned: ${used.join(', ')}`);
    }

    // auto-run shortly after load; also expose a manual trigger
    setTimeout(() => run(false), 2500);
    try { unsafeWindow.__ivacEpDiff = () => run(true); } catch (e) { window.__ivacEpDiff = () => run(true); }
    console.log('%c[IVAC EP Diff] loaded — auto-scan in ~2.5s. Re-run any time: __ivacEpDiff()  (or click the badge)', 'color:#8888aa');
})();
