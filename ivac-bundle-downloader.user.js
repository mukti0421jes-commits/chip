// ==UserScript==
// @name         IVAC Appointment Bundle Downloader (Auto)
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Auto-detect bundle.js and download it automatically (no button). Reloads only until the bundle appears, then downloads once and stops.
// @author       Your Name
// @match        https://appointment.ivacbd.com/*
// @match        https://appointment-dev-ivacbd-v2.dgi-rnd.com/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      appointment.ivacbd.com
// @connect      appointment-dev-ivacbd-v2.dgi-rnd.com
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const JS_FILE_PATTERN     = /^[a-zA-Z0-9]{8,}-[a-zA-Z0-9]+\.js$/;
    const CHECK_INTERVAL      = 200;     // ms between in-page scans
    const MAX_SCAN_ATTEMPTS   = 40;      // ~8s of scanning before giving up this load
    const RELOAD_DELAY        = 1500;    // ms to wait before reloading when no bundle yet
    const MAX_RELOADS         = 30;      // safety cap so it never loops forever

    // reloadCount persists across reloads via sessionStorage
    let reloadCount = parseInt(sessionStorage.getItem('rj_bundle_reloads') || '0', 10);

    let scanAttempts   = 0;
    let downloadStarted = false;

    // ---------- tiny status chip (top-right) ----------
    const status = document.createElement('div');
    status.style.cssText = 'position:fixed;top:15px;right:15px;z-index:2147483647;padding:8px 14px;background:#1e293b;color:#e2e8f0;border-radius:8px;font-size:12px;font-family:system-ui,monospace;box-shadow:0 4px 12px rgba(0,0,0,.3)';
    function setStatus(t, ok) { status.textContent = t; status.style.background = ok ? '#065f46' : '#1e293b'; }
    (document.body || document.documentElement).appendChild(status);
    setStatus('🔎 bundle খুঁজছি…');

    // ---------- download ----------
    function doDownload(url, filename) {
        if (downloadStarted) return;
        downloadStarted = true;
        sessionStorage.removeItem('rj_bundle_reloads'); // success → reset reload counter
        setStatus('📥 ডাউনলোড: ' + filename, true);

        const gm = (typeof GM_download !== 'undefined') ? GM_download : null;
        if (gm) {
            try {
                gm({
                    url: url,
                    name: filename,
                    saveAs: false,
                    onload:  () => setStatus('✅ ডাউনলোড সম্পন্ন: ' + filename, true),
                    onerror: () => fallbackAnchor(url, filename),
                    ontimeout: () => fallbackAnchor(url, filename)
                });
                return;
            } catch (e) { /* fall through */ }
        }
        fallbackAnchor(url, filename);
    }

    function fallbackAnchor(url, filename) {
        // last resort — goes to the browser's default Downloads folder
        try {
            const a = document.createElement('a');
            a.href = url; a.download = filename; a.style.display = 'none';
            document.body.appendChild(a); a.click();
            setTimeout(() => a.remove(), 200);
            setStatus('✅ ডাউনলোড (fallback): ' + filename, true);
        } catch (e) {
            setStatus('❌ ডাউনলোড ব্যর্থ — console দেখুন', false);
            console.error('[Bundle DL] download failed:', e);
        }
    }

    // ---------- find the bundle on the current page ----------
    function matchName(name) {
        return name && (JS_FILE_PATTERN.test(name) || name.includes('bundle'));
    }

    function findBundle() {
        // 1) <script src> tags
        for (const sc of document.querySelectorAll('script[src]')) {
            const src = sc.getAttribute('src'); if (!src) continue;
            const name = src.split('/').pop().split('?')[0];
            if (matchName(name)) {
                return { url: src.startsWith('http') ? src : new URL(src, location.origin).href, name };
            }
        }
        // 2) performance resource entries
        try {
            for (const r of performance.getEntriesByType('resource')) {
                const name = r.name.split('/').pop().split('?')[0];
                if (matchName(name) && r.name.includes(location.origin)) return { url: r.name, name };
            }
        } catch (e) {}
        return null;
    }

    function scan() {
        if (downloadStarted) return;
        const hit = findBundle();
        if (hit) { doDownload(hit.url, hit.name); return; }

        scanAttempts++;
        if (scanAttempts < MAX_SCAN_ATTEMPTS) {
            setTimeout(scan, CHECK_INTERVAL);
        } else {
            maybeReload(); // page didn't expose the bundle this load → reload and try again
        }
    }

    // ---------- reload only when needed, with a hard cap ----------
    function maybeReload() {
        if (downloadStarted) return;
        if (reloadCount >= MAX_RELOADS) {
            setStatus('⛔ bundle পাওয়া যায়নি (' + MAX_RELOADS + ' reload). থামানো হলো।', false);
            sessionStorage.removeItem('rj_bundle_reloads');
            return;
        }
        reloadCount++;
        sessionStorage.setItem('rj_bundle_reloads', String(reloadCount));
        setStatus('⏳ bundle আসেনি, reload #' + reloadCount + '…', false);
        setTimeout(() => location.reload(), RELOAD_DELAY);
    }

    // ---------- watch for late-injected bundle scripts (SPA) ----------
    const observer = new MutationObserver(muts => {
        if (downloadStarted) { observer.disconnect(); return; }
        for (const m of muts) {
            for (const node of m.addedNodes) {
                if (node.nodeType === 1 && node.tagName === 'SCRIPT' && node.src) {
                    const name = node.src.split('/').pop().split('?')[0];
                    if (matchName(name)) {
                        const url = node.src.startsWith('http') ? node.src : new URL(node.src, location.origin).href;
                        doDownload(url, name);
                        observer.disconnect();
                        return;
                    }
                }
            }
        }
    });
    try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}

    if (window.PerformanceObserver) {
        try { new PerformanceObserver(() => { if (!downloadStarted) scan(); }).observe({ entryTypes: ['resource'] }); } catch (e) {}
    }

    // start
    scan();
})();
