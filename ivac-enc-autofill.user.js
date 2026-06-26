// ==UserScript==
// @name         IVAC Enc Config Auto-Filler
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  IVAC bundle থেকে encryption config extract করে RJ SLOT Encrypt tab-এ auto-fill করে
// @author       RJ SLOT
// @match        https://appointment.ivacbd.com/*
// @match        https://appointment-dev-ivacbd-v2.dgi-rnd.com/*
// @match        https://appointment-dev-ivacbd-v2.dgi-rnd.com
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const BUNDLE_PATTERN = /\/assets\/[a-zA-Z0-9]{8,}-[a-zA-Z0-9]+\.js$/;
    const LOG = (...a) => console.log('[EncFiller]', ...a);

    // ── Step 1: intercept the bundle <script src="..."> before browser executes it ──

    const observer = new MutationObserver(mutations => {
        for (const mut of mutations) {
            for (const node of mut.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'SCRIPT' && node.src && BUNDLE_PATTERN.test(node.src)) {
                    const url = node.src;
                    node.remove();          // prevent original from executing
                    observer.disconnect();
                    LOG('Intercepted bundle:', url);
                    loadModifiedBundle(url);
                    return;
                }
            }
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // ── Step 2: fetch + patch + inject ──

    function loadModifiedBundle(url) {
        fetch(url)
            .then(r => {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.text();
            })
            .then(text => {
                // Inject exposure code just before the closing }() of the outermost IIFE.
                // XQ = signin config, JZ = reserve config — both are const-declared inside the IIFE.
                const insertionCode =
                    ';try{' +
                    'if(typeof XQ!=="undefined")window.__rjEncSignin=XQ;' +
                    'if(typeof JZ!=="undefined")window.__rjEncReserve=JZ;' +
                    'if(typeof _U!=="undefined"&&!window.__rjEncSignin)window.__rjEncSignin=_U;' +
                    '}catch(_ee){}';

                const lastClose = text.lastIndexOf('}()');
                const modified = lastClose !== -1
                    ? text.slice(0, lastClose) + insertionCode + text.slice(lastClose)
                    : text + insertionCode;

                const script = document.createElement('script');
                script.textContent = modified;
                document.documentElement.appendChild(script);
                LOG('Modified bundle injected.');

                // ── Step 3: wait for RJ SLOT UI then fill ──
                waitAndFill();
            })
            .catch(err => LOG('Bundle fetch error:', err));
    }

    // ── Step 3: poll until RJ SLOT UI elements exist ──

    function waitAndFill() {
        let attempts = 0;
        const tid = setInterval(() => {
            attempts++;
            if (attempts > 120) {           // 60-second timeout
                clearInterval(tid);
                LOG('Timeout — UI never appeared.');
                return;
            }

            const signin  = window.__rjEncSignin;
            const reserve = window.__rjEncReserve;
            const keyEl   = document.getElementById('enc-signin-key');

            if (keyEl && (signin || reserve)) {
                clearInterval(tid);
                LOG('Filling UI…', { signin, reserve });
                fillConfig('signin',  signin);
                fillConfig('reserve', reserve);
            }
        }, 500);
    }

    // ── Step 4: fill a single config section and click Save + Activate ──

    function fillConfig(purpose, cfg) {
        if (!cfg) return;

        setField('enc-' + purpose + '-key',     cfg.secret);
        setField('enc-' + purpose + '-skip',    cfg.startAt);
        setField('enc-' + purpose + '-length',  cfg.length);
        setField('enc-' + purpose + '-version', cfg.version);

        // Small delay so React/DOM can process the changes
        setTimeout(() => {
            clickBtn('enc-' + purpose + '-save');
            setTimeout(() => clickBtn('enc-' + purpose + '-activate'), 150);
        }, purpose === 'reserve' ? 400 : 100);
    }

    function setField(id, val) {
        const el = document.getElementById(id);
        if (!el || val === undefined || val === null) return;
        el.value = val;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function clickBtn(id) {
        const el = document.getElementById(id);
        if (el) { el.click(); LOG('Clicked:', id); }
    }

})();
