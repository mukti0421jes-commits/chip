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
        { name: 'Signin',        my: '/iams/api/v1/auth/v12-sign-in',                       leaf: '/auth/v12-sign-in',                sig: 'v12-sign-in' },
        { name: 'Verify',        my: '/iams/api/v1/otp/verifySigninOtp',                    leaf: '/otp/verifySigninOtp',             sig: 'verifySigninOtp' },
        { name: 'GetBookingConfig', my: '/iams/api/v1/appointment/get-booking-config',      leaf: '/appointment/get-booking-config',  sig: 'get-booking-config' },
        { name: 'Reserve',       my: '/iams/api/v1/slots/ccd3dd63-e781-48ba-a48d-c65eaa4fc663/reserve-slot', leaf: '/slots/ccd3dd63-e781-48ba-a48d-c65eaa4fc663/reserve-slot', sig: 'reserve-slot', exact: true },
        { name: 'Initiate',      my: '/iams/api/v1/payment/dg-epay/initiate',               leaf: '/payment/dg-epay/initiate',        sig: 'dg-epay', obf: true },
        { name: 'BookingConfirm',my: '/iams/api/v1/appointment/appointment-booking-config', leaf: '/appointment/appointment-booking-config', sig: 'appointment-booking-config' },
        { name: 'Upload',        my: '/iams/api/v1/file/upload_file',                       leaf: '/file/upload_file',                sig: 'upload_file' },
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

    // all quoted path literals in the bundle that share the leaf's parent dir (e.g. /forgot-password/*)
    function siblings(text, leaf) {
        const parent = leaf.replace(/\/[^/]+$/, '');           // /forgot-password/sendOtp → /forgot-password
        if (!parent || parent === leaf || parent.length < 3) return [];
        const esc = parent.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
        const re = new RegExp(esc + '\\/[A-Za-z0-9_{}-]+', 'g');
        return [...new Set(text.match(re) || [])];
    }
    function scan(bundleText) {
        return ENDPOINTS.map(ep => {
            if (ep.obf) return { ...ep, status: 'OBFUSCATED', bundle: '', sibs: [] };
            // EXACT-leaf match first (uuid treated as {id} unless ep.exact) — avoids a generic sig
            // grabbing the wrong sibling endpoint.
            const leafN = normId(ep.leaf);
            const hasExact = ep.exact ? (bundleText.indexOf(ep.leaf) !== -1)
                                      : (bundleText.indexOf(ep.leaf) !== -1 || (function () {
                                            // uuid-normalised presence: scan siblings for a {id}-equal match
                                            return siblings(bundleText, ep.leaf).some(s => normId(s) === leafN);
                                        })());
            if (hasExact) return { ...ep, status: 'OK', bundle: ep.exact ? ep.leaf : (extractLiteral(bundleText, ep.sig) || ep.leaf), sibs: [] };
            // not an exact match → show what the bundle has under the same parent (candidates)
            const sibs = siblings(bundleText, ep.leaf);
            if (sibs.length) return { ...ep, status: 'CHANGED', bundle: sibs[0], sibs };
            // sig not even present anywhere → truly missing / renamed / obfuscated
            if (bundleText.indexOf(ep.sig) === -1) return { ...ep, status: 'MISSING', bundle: '', sibs: [] };
            return { ...ep, status: 'CHANGED', bundle: extractLiteral(bundleText, ep.sig), sibs: [] };
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
                // yellow — the exact leaf isn't in the bundle. Show the candidate(s) under the same parent.
                console.log('%c⚠ ' + pad(r.name) + 'NOT AS EXPECTED%c', C.chg, '');
                console.log('%c      your code : ' + r.my + '   (leaf: ' + r.leaf + ')', C.dim);
                if (r.sibs && r.sibs.length > 1) {
                    console.log('%c      bundle has (under same path): ' + r.sibs.join('  ,  ') + '   ← check which one is correct', 'color:#f59e0b;font-weight:700');
                } else {
                    console.log('%c      bundle now: ' + r.bundle + '   ← likely update to this', 'color:#f59e0b;font-weight:700');
                }
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

    // Small round "S" button (top-left). One click = one endpoint scan (result in console + button colour).
    function makeButton() {
        if (document.getElementById('ivac-epdiff-btn')) return;
        const b = document.createElement('div');
        b.id = 'ivac-epdiff-btn';
        b.textContent = 'S';
        b.title = 'Scan IVAC endpoints vs your RJ SLOT code (see console)';
        b.style.cssText = 'position:fixed;top:14px;left:14px;z-index:2147483647;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:800 15px Consolas,monospace;color:#fff;cursor:pointer;user-select:none;box-shadow:0 4px 14px rgba(0,0,0,.5);background:linear-gradient(135deg,#6366f1,#4f46e5);border:2px solid rgba(255,255,255,.2)';
        b.addEventListener('click', async () => {
            b.textContent = '…'; b.style.background = 'linear-gradient(135deg,#f59e0b,#d97706)';
            const res = await run(true);
            if (res !== 'done') { b.textContent = '!'; b.title = 'No bundle (server 503/403 / not loaded) — try again when the site is open'; b.style.background = 'linear-gradient(135deg,#6b7280,#374151)'; }
            // if 'done', badge() below already set colour + text
        });
        (document.body || document.documentElement).appendChild(b);
    }
    function badge(changed, missing) {
        const b = document.getElementById('ivac-epdiff-btn'); if (!b) return;
        const bad = changed || missing;
        b.style.background = bad ? 'linear-gradient(135deg,#ef4444,#b91c1c)' : 'linear-gradient(135deg,#10b981,#059669)';
        b.textContent = 'S';
        b.title = bad ? `⚠ ${changed} changed / ${missing} missing — see console. Click to re-scan.` : '✓ All endpoints match your code. Click to re-scan.';
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
            if (/sign-in|reserve-slot|get-booking-config|upload_file|upload-file|verifySigninOtp/.test(t)) { combined += '\n' + t; used.push(u.split('/').pop()); }
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

    // ── MANUAL: no auto-scan / no loop. Add the "S" button; you click it to run one scan. ──
    function init() { makeButton(); }
    if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
    try { unsafeWindow.__ivacEpDiff = () => run(true); } catch (e) { window.__ivacEpDiff = () => run(true); }
    console.log('%c[IVAC EP Diff] loaded — MANUAL. Click the "S" button (top-left) to scan endpoints once. (or __ivacEpDiff())', 'color:#8888aa');
})();
