// ==UserScript==
// @name         IVAC Request Inspector
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Hooks fetch + XHR on the IVAC site and captures the REAL signin/verify/get-booking-config/reserve/initiate/upload requests — endpoint, whether encryption is used (c / x-token), headers and body — then diffs each against what your RJ SLOT code sends and highlights any change in the console. Read-only; nothing is sent anywhere.
// @author       RJ SLOT
// @match        https://appointment.ivacbd.com/*
// @match        https://*.ivacbd.com/*
// @match        https://ivacbd.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @noframes
// ==/UserScript==
(function () {
    'use strict';
    const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // ── what your RJ SLOT code sends, per endpoint (the reference to diff against) ──
    // match : substring that identifies the endpoint in the URL
    // method: expected HTTP method
    // headers: expected request header keys (lower-case)
    // body  : expected body field names (JSON) or FormData keys
    // enc   : which field carries the captcha token → tells us if the endpoint uses encryption
    //         ('c' = encrypted/raw token in body.c ; 'x-token' = token in the x-token header ; null = none)
    const SPEC = [
        { name: 'Signin',   match: 'sign-in',            method: 'POST', headers: ['accept', 'cache-control', 'content-type', 'pragma'], body: ['phone', 'password', 'c'], enc: 'c' },
        { name: 'Verify',   match: 'verifySigninOtp',    method: 'POST', headers: ['accept', 'authorization', 'content-type', 'x-device-id'], body: ['requestId', 'phone', 'code', 'otpChannel'], enc: null },
        { name: 'Book',     match: 'get-booking-config', method: 'GET',  headers: ['accept', 'authorization', 'cache-control', 'pragma'], body: [], enc: null },
        { name: 'Reserve',  match: 'reserve-slot',       method: 'POST', headers: ['accept', 'authorization', 'cache-control', 'content-type', 'pragma'], body: ['c', 'appointmentDate'], enc: 'c' },
        { name: 'Initiate', match: 'initiate',           method: 'POST', headers: ['accept', 'authorization', 'cache-control', 'content-type', 'pragma', 'x-token'], body: ['appointmentId'], enc: 'x-token' },
        { name: 'Upload',   match: 'upload_file',        method: 'POST', headers: ['accept', 'authorization', 'cache-control', 'pragma', 'x-sec-runtime-state', 'x-token'], body: ['files', 'isPrimary'], enc: 'x-token' }
    ];
    function specFor(url) { return SPEC.find(s => url.indexOf(s.match) !== -1) || null; }

    const seen = new Set();     // report each endpoint's shape once (until it changes)
    let issues = 0;

    function lc(o) { const r = {}; for (const k in o) r[String(k).toLowerCase()] = o[k]; return r; }
    function short(v) { v = String(v == null ? '' : v); return v.length > 60 ? v.slice(0, 40) + '…(' + v.length + ')' : v; }

    function headersToObj(h) {
        const o = {};
        try {
            if (!h) return o;
            if (h instanceof W.Headers || (h && typeof h.forEach === 'function' && !Array.isArray(h))) { h.forEach((v, k) => o[k] = v); return o; }
            if (Array.isArray(h)) { h.forEach(([k, v]) => o[k] = v); return o; }
            Object.assign(o, h);
        } catch (e) {}
        return o;
    }
    function parseBody(body) {
        if (body == null) return { kind: 'none', fields: [], raw: null };
        try { if (W.FormData && body instanceof W.FormData) { const f = []; for (const k of body.keys()) f.push(k); return { kind: 'formdata', fields: [...new Set(f)], raw: null }; } } catch (e) {}
        if (typeof body === 'string') { try { const j = JSON.parse(body); return { kind: 'json', fields: Object.keys(j), raw: j }; } catch (e) { return { kind: 'text', fields: [], raw: body }; } }
        if (typeof body === 'object') { try { return { kind: 'json', fields: Object.keys(body), raw: body }; } catch (e) {} }
        return { kind: '?', fields: [], raw: null };
    }

    function encInfo(spec, headers, bodyInfo) {
        // is the captcha/encryption token present where your code expects it?
        if (spec.enc === 'c') {
            const has = bodyInfo.raw && bodyInfo.raw.c != null;
            const val = has ? String(bodyInfo.raw.c) : '';
            return { expected: 'body.c', present: !!has, detail: has ? `c present • len ${val.length}${/^\d+\./.test(val) ? ' • looks encrypted (version prefix)' : (val.indexOf('.') > -1 ? ' • token-shaped' : '')}` : 'c MISSING' };
        }
        if (spec.enc === 'x-token') {
            const has = headers['x-token'] != null && headers['x-token'] !== '';
            return { expected: 'header x-token', present: !!has, detail: has ? `x-token present • len ${String(headers['x-token']).length}` : 'x-token MISSING' };
        }
        return { expected: 'none', present: null, detail: 'no captcha token expected' };
    }

    function diff(spec, method, headers, bodyInfo) {
        const out = [];
        if (spec.method && method && method.toUpperCase() !== spec.method) out.push({ t: 'method', msg: `method ${method.toUpperCase()} — expected ${spec.method}` });
        const hk = Object.keys(headers);
        spec.headers.forEach(h => { if (!(h in headers)) out.push({ t: 'hdr-missing', msg: `header MISSING: ${h}` }); });
        hk.forEach(h => { if (h.startsWith('sec-') || h === 'user-agent' || h === 'referer' || h === 'origin' || h === 'content-length' || h === 'accept-encoding' || h === 'accept-language') return; if (spec.headers.indexOf(h) === -1) out.push({ t: 'hdr-new', msg: `header NEW: ${h}: ${short(headers[h])}` }); });
        if (spec.body.length || bodyInfo.fields.length) {
            spec.body.forEach(f => { if (bodyInfo.fields.indexOf(f) === -1) out.push({ t: 'body-missing', msg: `body field MISSING: ${f}` }); });
            bodyInfo.fields.forEach(f => { if (spec.body.indexOf(f) === -1) out.push({ t: 'body-new', msg: `body field NEW: ${f}` }); });
        }
        return out;
    }

    function report(spec, url, method, headers, bodyInfo) {
        const enc = encInfo(spec, headers, bodyInfo);
        const diffs = diff(spec, method, headers, bodyInfo);
        // signature: only re-log when something changed
        const sig = spec.name + '|' + method + '|' + Object.keys(headers).sort().join(',') + '|' + bodyInfo.fields.slice().sort().join(',') + '|' + enc.present + '|' + diffs.map(d => d.msg).join(';');
        if (seen.has(sig)) return; seen.add(sig);

        const bad = diffs.length > 0;
        const C = { head: `color:#fff;font-weight:800;background:${bad ? '#b91c1c' : '#059669'};padding:2px 8px;border-radius:3px`, k: 'color:#a78bfa;font-weight:700', v: 'color:#c4b5fd', dim: 'color:#8888aa', warn: 'color:#fde047;font-weight:800;background:#3a2a00;padding:1px 4px', enc: 'color:#5eead4;font-weight:700' };
        console.groupCollapsed(`%c${bad ? '⚠ ' : '✓ '}${spec.name}%c  ${method} ${url.replace(/^https?:\/\/[^/]+/, '')}`, C.head, C.dim);
        console.log('%cEncryption:%c ' + enc.detail + '   (expected: ' + enc.expected + ')', C.enc, enc.present === false ? C.warn : C.dim);
        console.log('%cHeaders:', C.k);
        Object.keys(headers).forEach(h => console.log('   %c' + h + '%c: ' + short(headers[h]), C.v, C.dim));
        console.log('%cBody %c(' + bodyInfo.kind + '): %c[ ' + bodyInfo.fields.join(', ') + ' ]', C.k, C.dim, C.v);
        if (bad) {
            issues += diffs.length;
            console.log('%c⚠ CHANGES vs your RJ SLOT code:', C.warn);
            diffs.forEach(d => console.log('%c   • ' + d.msg, C.warn));
        } else {
            console.log('%c✓ matches your RJ SLOT code', 'color:#16a34a;font-weight:700');
        }
        console.groupEnd();
        badge();
    }

    function badge() {
        let el = document.getElementById('ivac-reqinspect-badge'); if (!document.body) return;
        if (!el) { el = document.createElement('div'); el.id = 'ivac-reqinspect-badge'; el.style.cssText = 'position:fixed;bottom:14px;left:14px;z-index:2147483647;font:700 12px Consolas,monospace;padding:7px 11px;border-radius:8px;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.5)'; document.body.appendChild(el); }
        el.style.background = issues ? 'linear-gradient(135deg,#ef4444,#b91c1c)' : 'linear-gradient(135deg,#10b981,#059669)';
        el.textContent = issues ? `⚠ Req changes: ${issues}` : `✓ Requests OK (${seen.size})`;
    }

    function capture(url, method, rawHeaders, body) {
        try {
            if (!/api\.ivacbd\.com/.test(url)) return;
            const spec = specFor(url); if (!spec) return;
            const headers = lc(headersToObj(rawHeaders));
            const bodyInfo = parseBody(body);
            report(spec, url, method || 'GET', headers, bodyInfo);
        } catch (e) {}
    }

    // ── hook fetch ──
    const _fetch = W.fetch;
    if (_fetch) {
        W.fetch = function (input, init) {
            try {
                const url = (typeof input === 'string') ? input : (input && input.url) || '';
                const method = (init && init.method) || (input && input.method) || 'GET';
                const headers = (init && init.headers) || (input && input.headers) || {};
                const body = (init && init.body) || (input && input.body) || null;
                capture(url, method, headers, body);
            } catch (e) {}
            return _fetch.apply(this, arguments);
        };
    }

    // ── hook XMLHttpRequest ──
    const XP = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
    if (XP) {
        const _open = XP.open, _set = XP.setRequestHeader, _send = XP.send;
        XP.open = function (m, u) { this.__ri = { method: m, url: u, headers: {} }; return _open.apply(this, arguments); };
        XP.setRequestHeader = function (k, v) { try { if (this.__ri) this.__ri.headers[k] = v; } catch (e) {} return _set.apply(this, arguments); };
        XP.send = function (b) { try { if (this.__ri) capture(this.__ri.url, this.__ri.method, this.__ri.headers, b); } catch (e) {} return _send.apply(this, arguments); };
    }

    console.log('%c[IVAC Req Inspector] hooked fetch + XHR. Do a signin/reserve/etc. (site UI or your script) — each request will be logged with an encryption/header/body diff vs your RJ SLOT code.', 'color:#a78bfa;font-weight:700');
})();
