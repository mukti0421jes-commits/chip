// ==UserScript==
// @name         IVAC Appointment - Turnstile Solver with Login/Reserve
// @namespace    http://tampermonkey.net/
// @version      34.5
// @description  Full Turnstile Solver with Login & Reserve - Cipher Enabled
// @author       YourName
// @match        https://appointment.ivacbd.com/*
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // CONFIG
    // ==========================================
    const TURNSTILE_SITEKEY = '0x4AAAAAACghKkJHL1t7UkuZ';
    const TURNSTILE_THEME = 'dark';
    const TURNSTILE_SIZE = 'normal';

    const CIPHER_SERVER_URLS = ['http://localhost:8799/cipher', 'http://127.0.0.1:8799/cipher'];

    // ==========================================
    // STYLES
    // ==========================================
    const styles = `
        .turnstile-modern-ui {
            position: fixed;
            top: 15px;
            left: 50%;
            transform: translateX(-50%);
            width: 96%;
            max-width: 1300px;
            max-height: 88vh;
            overflow-y: auto;
            background: linear-gradient(145deg, #0f1724, #1a2332);
            border-radius: 24px;
            padding: 20px 24px 16px;
            box-shadow: 0 30px 80px rgba(0,0,0,0.9), inset 0 1px 1px rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.06);
            z-index: 999999;
            font-family: -apple-system, 'Segoe UI', 'Inter', system-ui, sans-serif;
            color: #e8edf5;
            scrollbar-width: thin;
            scrollbar-color: #2a3a4a transparent;
            backdrop-filter: blur(10px);
        }
        .turnstile-modern-ui::-webkit-scrollbar { width: 5px; }
        .turnstile-modern-ui::-webkit-scrollbar-track { background: transparent; }
        .turnstile-modern-ui::-webkit-scrollbar-thumb { background: #2a3a4a; border-radius: 10px; }

        .modern-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid rgba(255,255,255,0.06);
            flex-wrap: wrap;
            gap: 10px;
            position: sticky;
            top: 0;
            background: linear-gradient(180deg, #0f1724 80%, transparent);
            z-index: 10;
            padding-top: 4px;
        }
        .modern-header-left {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
        }
        .modern-logo {
            font-weight: 700;
            font-size: 18px;
            background: linear-gradient(135deg, #60a5fa, #a78bfa);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            letter-spacing: -0.5px;
        }
        .modern-badge {
            font-size: 10px;
            padding: 3px 12px;
            border-radius: 20px;
            font-weight: 500;
            letter-spacing: 0.3px;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.08);
            color: #94a3b8;
        }
        .modern-badge.active {
            background: rgba(74, 222, 128, 0.15);
            border-color: rgba(74, 222, 128, 0.2);
            color: #4ade80;
        }
        .modern-badge.encrypt {
            background: rgba(251, 191, 36, 0.12);
            border-color: rgba(251, 191, 36, 0.15);
            color: #fbbf24;
        }
        .modern-badge.cipher {
            background: rgba(96, 165, 250, 0.12);
            border-color: rgba(96, 165, 250, 0.15);
            color: #60a5fa;
        }
        .modern-header-actions {
            display: flex;
            gap: 6px;
            align-items: center;
        }
        .modern-btn {
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.08);
            color: #cbd5e1;
            font-size: 12px;
            padding: 5px 14px;
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.2s;
            font-weight: 500;
        }
        .modern-btn:hover {
            background: rgba(255,255,255,0.12);
            border-color: rgba(255,255,255,0.15);
            transform: translateY(-1px);
        }
        .modern-btn:active { transform: scale(0.95); }
        .modern-btn-icon {
            background: none;
            border: none;
            color: #64748b;
            font-size: 20px;
            cursor: pointer;
            padding: 0 4px;
            transition: all 0.2s;
            line-height: 1;
        }
        .modern-btn-icon:hover {
            color: #e2e8f0;
            transform: rotate(90deg);
        }

        .cipher-code-section {
            background: rgba(0,0,0,0.3);
            border-radius: 14px;
            padding: 12px 16px;
            margin-bottom: 12px;
            border: 1px solid rgba(255,255,255,0.05);
        }
        .cipher-code-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            flex-wrap: wrap;
            gap: 8px;
        }
        .cipher-code-header .label {
            font-weight: 600;
            font-size: 13px;
            color: #60a5fa;
        }
        .cipher-code-header .actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }
        .cipher-code-header .actions button {
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.08);
            color: #94a3b8;
            font-size: 11px;
            padding: 3px 12px;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .cipher-code-header .actions button:hover {
            background: rgba(255,255,255,0.12);
            color: #e8edf5;
        }
        .cipher-code-input {
            width: 100%;
            min-height: 80px;
            max-height: 200px;
            background: rgba(0,0,0,0.4);
            border: 1px solid rgba(255,255,255,0.06);
            border-radius: 10px;
            color: #a78bfa;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            padding: 10px 14px;
            resize: vertical;
            outline: none;
            transition: all 0.3s;
            line-height: 1.5;
            box-sizing: border-box;
        }
        .cipher-code-input:focus {
            border-color: rgba(96, 165, 250, 0.3);
            box-shadow: 0 0 20px rgba(96, 165, 250, 0.05);
        }
        .cipher-code-input::placeholder {
            color: #475569;
        }
        .cipher-status-text {
            font-size: 11px;
            margin-top: 6px;
            color: #64748b;
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }
        .cipher-status-text .dot {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            flex-shrink: 0;
        }
        .cipher-status-text .dot.loaded {
            background: #4ade80;
        }
        .cipher-status-text .dot.loading {
            background: #fbbf24;
            animation: pulse 1s ease-in-out infinite;
        }
        .cipher-status-text .dot.error {
            background: #ef4444;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .section-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin: 12px 0 14px 0;
            padding: 8px 16px;
            border-radius: 14px;
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.05);
        }
        .section-header .icon { font-size: 18px; }
        .section-header .label { font-weight: 600; font-size: 14px; letter-spacing: 0.3px; }
        .section-header .label.login { color: #60a5fa; }
        .section-header .label.reserve { color: #a78bfa; }
        .section-header .sub {
            font-size: 11px;
            color: #64748b;
            margin-left: auto;
        }
        .section-header .status-badge {
            font-size: 9px;
            padding: 2px 10px;
            border-radius: 12px;
            background: rgba(74, 222, 128, 0.1);
            color: #4ade80;
            border: 1px solid rgba(74, 222, 128, 0.15);
        }

        .modern-grid {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 12px;
            margin-bottom: 10px;
        }

        .modern-card {
            background: rgba(255,255,255,0.03);
            border-radius: 16px;
            padding: 10px 12px 12px;
            border: 1px solid rgba(255,255,255,0.05);
            transition: all 0.3s;
            position: relative;
            overflow: visible;
            min-height: 160px;
        }
        .modern-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 2px;
            background: linear-gradient(90deg, transparent, rgba(96, 165, 250, 0.2), transparent);
            opacity: 0;
            transition: opacity 0.3s;
        }
        .modern-card:hover {
            border-color: rgba(255,255,255,0.12);
            background: rgba(255,255,255,0.05);
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(0,0,0,0.3);
        }
        .modern-card:hover::before { opacity: 1; }
        .modern-card.login-card::before {
            background: linear-gradient(90deg, transparent, #60a5fa, transparent);
        }
        .modern-card.reserve-card::before {
            background: linear-gradient(90deg, transparent, #a78bfa, transparent);
        }

        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        .card-title {
            font-weight: 600;
            font-size: 12px;
            letter-spacing: 0.3px;
        }
        .card-title.login { color: #60a5fa; }
        .card-title.reserve { color: #a78bfa; }
        .card-badge {
            font-size: 8px;
            padding: 2px 8px;
            border-radius: 10px;
            background: rgba(251, 191, 36, 0.1);
            color: #fbbf24;
            border: 1px solid rgba(251, 191, 36, 0.1);
            font-weight: 500;
            white-space: nowrap;
        }
        .card-badge.success {
            background: rgba(74, 222, 128, 0.1);
            color: #4ade80;
            border-color: rgba(74, 222, 128, 0.15);
        }

        .turnstile-wrapper-modern {
            display: flex !important;
            justify-content: center !important;
            align-items: center !important;
            width: 100% !important;
            min-height: 90px !important;
            height: auto !important;
            background: rgba(0,0,0,0.2) !important;
            border-radius: 12px !important;
            padding: 8px !important;
            border: 1px solid rgba(255,255,255,0.04) !important;
            transition: all 0.3s !important;
            overflow: visible !important;
        }
        .turnstile-wrapper-modern:hover {
            border-color: rgba(255,255,255,0.08) !important;
        }
        .turnstile-wrapper-modern iframe {
            height: auto !important;
            min-height: 70px !important;
            width: 100% !important;
            max-width: 300px !important;
            display: block !important;
            margin: 0 auto !important;
            border: none !important;
        }

        .card-actions {
            display: flex;
            gap: 5px;
            margin-top: 10px;
            flex-wrap: wrap;
        }
        .card-btn {
            flex: 1;
            border: none;
            color: white;
            font-weight: 600;
            font-size: 11px;
            padding: 6px 0;
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.25s;
            letter-spacing: 0.3px;
            position: relative;
            overflow: hidden;
            min-width: 60px;
        }
        .card-btn::after {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 0;
            height: 0;
            background: rgba(255,255,255,0.2);
            border-radius: 50%;
            transform: translate(-50%, -50%);
            transition: width 0.4s, height 0.4s;
        }
        .card-btn:active::after {
            width: 200px;
            height: 200px;
        }
        .card-btn-login {
            background: linear-gradient(135deg, #3b82f6, #2563eb);
        }
        .card-btn-login:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 15px rgba(59, 130, 246, 0.3);
        }
        .card-btn-login:active { transform: scale(0.95); }
        .card-btn-reserve {
            background: linear-gradient(135deg, #8b5cf6, #7c3aed);
        }
        .card-btn-reserve:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 15px rgba(139, 92, 246, 0.3);
        }
        .card-btn-reserve:active { transform: scale(0.95); }
        .card-btn-reload {
            background: rgba(255,255,255,0.06);
            color: #94a3b8;
            flex: 0 0 36px;
            font-size: 14px;
            padding: 6px 0;
            border-radius: 10px;
            border: 1px solid rgba(255,255,255,0.06);
        }
        .card-btn-reload:hover {
            background: rgba(255,255,255,0.12);
            color: #e2e8f0;
        }
        .card-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none !important;
        }
        .card-btn.success {
            background: #22c55e !important;
        }
        .card-btn.failed {
            background: #ef4444 !important;
        }

        .phone-input-section {
            display: flex;
            gap: 8px;
            align-items: center;
            padding: 8px 0;
            flex-wrap: wrap;
        }
        .phone-input-section input {
            background: rgba(0,0,0,0.4);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 8px;
            padding: 6px 12px;
            color: #e8edf5;
            font-size: 12px;
            outline: none;
            transition: all 0.3s;
            flex: 1;
            min-width: 120px;
        }
        .phone-input-section input:focus {
            border-color: rgba(96, 165, 250, 0.3);
            box-shadow: 0 0 20px rgba(96, 165, 250, 0.05);
        }
        .phone-input-section input::placeholder {
            color: #475569;
        }
        .phone-input-section .label {
            font-size: 10px;
            color: #94a3b8;
            font-weight: 500;
        }

        .modern-footer {
            margin-top: 12px;
            padding-top: 10px;
            border-top: 1px solid rgba(255,255,255,0.05);
            display: flex;
            justify-content: center;
            gap: 20px;
            font-size: 10px;
            color: #475569;
            flex-wrap: wrap;
        }
        .modern-footer span {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .modern-notification {
            position: fixed;
            bottom: 25px;
            right: 25px;
            padding: 12px 22px;
            background: #1a2332;
            color: #e8edf5;
            border-radius: 14px;
            font-size: 13px;
            z-index: 9999999;
            box-shadow: 0 15px 50px rgba(0,0,0,0.6);
            animation: slideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
            border: 1px solid rgba(255,255,255,0.06);
            font-family: -apple-system, 'Segoe UI', system-ui, sans-serif;
            max-width: 420px;
            backdrop-filter: blur(10px);
        }
        .modern-notification.success { border-left: 3px solid #4ade80; }
        .modern-notification.error { border-left: 3px solid #ef4444; }
        .modern-notification.info { border-left: 3px solid #60a5fa; }

        @keyframes slideIn {
            from { transform: translateX(100px); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOut {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(100px); opacity: 0; }
        }

        @media (max-width: 1100px) { .modern-grid { grid-template-columns: repeat(4, 1fr); } }
        @media (max-width: 850px) {
            .modern-grid { grid-template-columns: repeat(3, 1fr); }
            .turnstile-modern-ui { padding: 14px 16px; }
        }
        @media (max-width: 600px) {
            .modern-grid { grid-template-columns: repeat(2, 1fr); }
            .modern-header { flex-direction: column; align-items: stretch; }
            .modern-header-actions { justify-content: flex-end; }
            .turnstile-wrapper-modern iframe {
                max-width: 100% !important;
            }
            .phone-input-section {
                flex-direction: column;
                align-items: stretch;
            }
            .card-actions {
                flex-direction: column;
            }
        }
        @media (max-width: 400px) {
            .modern-grid { grid-template-columns: 1fr; }
        }
    `;

    // ==========================================
    // STATE
    // ==========================================
    let turnstileLoadPromise = null;

    let tokenStore = {
        login: {},
        reserve: {}
    };

    let isProcessing = {};
    let widgetInstances = { login: {}, reserve: {} };
    let turnstileTokens = { login: {}, reserve: {} };

    // ==========================================
    // CIPHER FUNCTIONS
    // ==========================================
    let cipherFunctions = {
        login: null,
        reserve: null,
        loaded: false,
        rawCode: null,
        code: null
    };

    const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

    function logStatus(message, color = 'w') {
        const colors = { w: '#ffffff', y: '#fbbf24', r: '#ef4444', g: '#4ade80', b: '#60a5fa' };
        console.log(`%c${message}`, `color: ${colors[color] || colors.w}`);
    }

    function loadCipherScript(scriptText) {
        if (!scriptText || !scriptText.trim()) { cipherFunctions.loaded = false; return false; }
        try {
            const fn = new Function('rawToken', 'purpose', `
                "use strict";
                ${scriptText}
                if (typeof encryptToken === 'function') return encryptToken(rawToken, purpose);
                if (typeof encryptCaptchaToken === 'function') return encryptCaptchaToken(rawToken, purpose);
                if (typeof ProcessToken === 'function') return ProcessToken(rawToken, purpose);
                return rawToken;
            `);
            fn('test_token', 'Signin');
            cipherFunctions.login   = (data) => { try { const r = fn(data, 'Signin');  return (r && typeof r === 'object') ? r : { c: String(r) }; } catch(e) { return { c: btoa(data) }; } };
            cipherFunctions.reserve = (data) => { try { const r = fn(data, 'Reserve'); return (r && typeof r === 'object') ? r : { c: String(r) }; } catch(e) { return { c: btoa(data) }; } };
            cipherFunctions.loaded = true;
            cipherFunctions.rawCode = scriptText;
            console.log('[Cipher] ✅ Loaded via encryptToken router');
            return true;
        } catch(e) {
            console.error('[Cipher] ❌ Parse error:', e);
            cipherFunctions.loaded = false;
            return false;
        }
    }

    function applyCipherScript(text, auto) {
        if (!text || !text.trim()) { if (!auto) logStatus('❌ Cipher file is empty', 'r'); return; }
        const ta = document.getElementById('cipher-code-input');
        if (ta) ta.value = text;
        try { localStorage.setItem('turnstile_cipher_code', text); } catch(e) {}
        const ok = loadCipherScript(text);
        updateCipherUI(ok);
        const statusText = document.getElementById('cipher-status-text');
        if (statusText) {
            statusText.innerHTML = ok
                ? `<span class="dot loaded"></span> ✅ encryptToken(Signin/Reserve) loaded — ${text.length} characters`
                : `<span class="dot error"></span> ❌ Script parse error — check the cipher file`;
        }
        if (ok) logStatus(auto ? '✅ Cipher auto-loaded & Encryption ON' : '✅ Cipher loaded from server, saved & Encryption ON', 'g');
        else logStatus('❌ Cipher script parse error — check the file', 'r');
    }

    function updateCipherUI(loaded) {
        const statusEl = document.getElementById('cipher-status');
        if (statusEl) {
            statusEl.textContent = loaded ? '🔑 Loaded' : '❌ Failed';
            statusEl.className = `modern-badge cipher ${loaded ? 'active' : ''}`;
        }
    }

    function loadCipherFromServer(auto = false) {
        const btn = document.getElementById('cipher-load-btn');
        if (btn) { btn.textContent = '⏳'; setTimeout(() => { btn.textContent = '🔑'; }, 1500); }
        if (!auto) logStatus('🔑 Loading cipher from local server…', 'y');

        const statusText = document.getElementById('cipher-status-text');
        if (statusText) statusText.innerHTML = `<span class="dot loading"></span> Loading cipher from server...`;

        const gm = (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest) ||
                   (typeof GM !== 'undefined' && GM.xmlHttpRequest);

        let idx = 0;
        const tryNext = () => {
            if (idx >= CIPHER_SERVER_URLS.length) {
                // Server not reachable — try localStorage cache
                try {
                    const savedCode = localStorage.getItem('turnstile_cipher_code');
                    if (savedCode) { applyCipherScript(savedCode, auto); return; }
                } catch(e) {}
                if (!auto) logStatus('❌ Cipher server not reachable — start cipher server on port 8799', 'r');
                if (statusText) statusText.innerHTML = `<span class="dot error"></span> ❌ Server unreachable. Start: node cipher-server.js`;
                return;
            }
            const url = CIPHER_SERVER_URLS[idx++];
            if (gm) {
                gm({ method: 'GET', url, timeout: 8000,
                    onload: (r) => {
                        if (r.status >= 200 && r.status < 300 && r.responseText && r.responseText.trim()) {
                            applyCipherScript(r.responseText, auto);
                        } else { tryNext(); }
                    },
                    onerror: tryNext, ontimeout: tryNext
                });
            } else {
                fetch(url, { method: 'GET', cache: 'no-store' })
                    .then(r => r.ok ? r.text() : Promise.reject())
                    .then(t => applyCipherScript(t, auto))
                    .catch(tryNext);
            }
        };
        tryNext();
    }

    function saveCipherCodeManually() {
        const input = document.getElementById('cipher-code-input');
        if (input && input.value && input.value.trim()) {
            applyCipherScript(input.value, false);
            showNotification('✅ Cipher code saved and loaded!', 'success');
        } else {
            showNotification('❌ Please paste cipher code first', 'error');
        }
    }

    // ==========================================
    // ENCRYPT TOKEN - Uses cipher functions
    // ==========================================
    async function encryptTokenWithCipher(token, type) {
        if (!cipherFunctions.loaded) {
            console.warn('⚠️ Cipher not loaded, loading from server...');
            await new Promise((resolve) => {
                loadCipherFromServer(true);
                setTimeout(resolve, 2000);
            });
        }

        if (cipherFunctions.loaded) {
            try {
                let encrypted;

                console.log(`🔐 Encrypting ${type} token using cipher...`);
                console.log(`📝 Raw token: ${token.substring(0, 30)}...`);

                if (type === 'login' && cipherFunctions.login) {
                    console.log(`🔐 Using encryptToken('Signin') from cipher`);
                    encrypted = cipherFunctions.login(token);
                } else if (type === 'reserve' && cipherFunctions.reserve) {
                    console.log(`🔐 Using encryptToken('Reserve') from cipher`);
                    encrypted = cipherFunctions.reserve(token);
                } else {
                    console.warn(`⚠️ No specific cipher function for ${type}`);
                    if (cipherFunctions.login) {
                        encrypted = cipherFunctions.login(token);
                    } else if (cipherFunctions.reserve) {
                        encrypted = cipherFunctions.reserve(token);
                    } else {
                        throw new Error('No cipher function available');
                    }
                }

                if (encrypted && typeof encrypted === 'object' && encrypted.c) {
                    console.log(`✅ ${type} encryption successful`);
                    console.log(`🔐 Encrypted 'c': ${encrypted.c.substring(0, 80)}...`);

                    if (encrypted.c === token) {
                        console.warn(`⚠️ Encryption produced same as raw token! Using fallback.`);
                        return createFallbackEncryption(token, type);
                    }

                    console.log(`📊 Token vs Encrypted: ✅ DIFFERENT`);
                    return encrypted;
                } else if (typeof encrypted === 'string') {
                    if (encrypted === token) {
                        console.warn(`⚠️ Encryption produced same as raw token! Using fallback.`);
                        return createFallbackEncryption(token, type);
                    }
                    console.log(`📊 Token vs Encrypted: ✅ DIFFERENT`);
                    return { c: encrypted };
                } else {
                    console.warn(`⚠️ Unexpected encryption result, using fallback`);
                    return createFallbackEncryption(token, type);
                }
            } catch (error) {
                console.error(`❌ Cipher encryption error:`, error);
                return createFallbackEncryption(token, type);
            }
        }

        console.warn(`⚠️ Cipher not loaded, using fallback for ${type}`);
        return createFallbackEncryption(token, type);
    }

    function createFallbackEncryption(token, type) {
        try {
            const timestamp = Date.now();
            const randomNonce = Math.random().toString(36).substring(2, 10);

            const payload = {
                token: token,
                type: type,
                timestamp: timestamp,
                nonce: randomNonce,
                version: '2.0'
            };

            const jsonString = JSON.stringify(payload);
            const base64Encoded = btoa(jsonString);
            const encrypted = `enc_${type}_${base64Encoded}`;

            console.log(`🔐 Fallback encryption created for ${type}`);
            console.log(`🔐 Encrypted: ${encrypted.substring(0, 80)}...`);

            return { c: encrypted, _fallback: true };
        } catch (error) {
            console.error('❌ Fallback encryption error:', error);
            return { c: btoa(token + '_' + Date.now()), _fallback: true };
        }
    }

    // ==========================================
    // NOTIFICATION
    // ==========================================
    function showNotification(message, type = 'info') {
        const colors = { success: '#4ade80', error: '#ef4444', info: '#60a5fa' };
        const notification = document.createElement('div');
        notification.className = `modern-notification ${type}`;
        notification.style.borderLeft = `3px solid ${colors[type] || colors.info}`;
        notification.textContent = message;
        document.body.appendChild(notification);
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
            setTimeout(() => notification.remove(), 400);
        }, 4000);
    }

    // ==========================================
    // TOKEN FUNCTIONS
    // ==========================================
    function storeToken(type, token, containerId) {
        const index = containerId.split('-').pop();
        if (!tokenStore[type]) tokenStore[type] = {};
        tokenStore[type][index] = token;
        turnstileTokens[type][index] = token;

        console.log(`✅ ${type} #${index} token received: ${token.substring(0, 30)}...`);

        const card = document.querySelector(`.modern-card[data-type="${type}"][data-index="${index}"]`);
        if (card) {
            const badge = card.querySelector('.card-badge');
            if (badge) {
                badge.textContent = '✅ Token Ready';
                badge.className = 'card-badge success';
            }
        }
    }

    function getToken(type, index) {
        return tokenStore[type]?.[index] || null;
    }

    function clearToken(type, index) {
        if (tokenStore[type]) delete tokenStore[type][index];
        if (turnstileTokens[type]) delete turnstileTokens[type][index];
    }

    function clearAllTokens() {
        tokenStore = { login: {}, reserve: {} };
        turnstileTokens = { login: {}, reserve: {} };
    }

    // ==========================================
    // LOGIN FUNCTION - Uses cipher encryption
    // ==========================================
    async function loginUserV2(phone, password, rawCaptchaToken) {
        try {
            console.log(`🔐 Login attempt for ${phone}...`);
            console.log(`📝 Raw captcha token: ${rawCaptchaToken.substring(0, 30)}...`);

            const encrypted = await encryptTokenWithCipher(rawCaptchaToken, 'login');
            const encryptedCaptcha = encrypted.c;

            console.log(`🔐 Encrypted captcha 'c': ${encryptedCaptcha.substring(0, 80)}...`);

            const requestBody = {
                phone: phone,
                password: password,
                c: encryptedCaptcha
            };

            console.log(`📤 Login Request Body:`, requestBody);

            const response = await fetch("https://api.ivacbd.com/iams/api/v1/auth/sign-in-v2", {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            const data = await response.json();
            console.log('📥 Login response:', data);

            if (response.ok && data?.successFlag === true && data?.data?.accessToken) {
                const token = data.data.accessToken;
                const reqId = data.data.requestId;

                const authData = {
                    state: {
                        token: token,
                        requestId: reqId,
                        phone: phone,
                        isAuthenticated: true,
                        isVerified: false
                    },
                    version: 0
                };
                localStorage.setItem('auth-storage', JSON.stringify(authData));
                localStorage.setItem('accessToken', token);
                localStorage.setItem('requestId', reqId);
                localStorage.setItem('ivac_phone', phone);
                localStorage.setItem('ivac_password', password);

                window.authToken = token;
                window.requestId = reqId;
                window.currentPhone = phone;

                return {
                    success: true,
                    token,
                    requestId: reqId,
                    otpSent: true,
                    data: data
                };
            }

            const errorMsg = data?.message || data?.error || 'Login failed';
            console.warn('⚠️ Login failed:', errorMsg);
            return { success: false, message: errorMsg };

        } catch (error) {
            console.error('❌ Login error:', error);
            return { success: false, message: error.message || 'Login error' };
        }
    }

    // ==========================================
    // RESERVE FUNCTION - Uses cipher encryption
    // ==========================================
    async function makeReserveRequest(authToken, rawCaptchaToken) {
        try {
            console.log('📅 Reserve request...');
            console.log(`📝 Raw captcha token: ${rawCaptchaToken.substring(0, 30)}...`);

            const encrypted = await encryptTokenWithCipher(rawCaptchaToken, 'reserve');
            const encryptedToken = encrypted.c;

            console.log(`🔐 Encrypted 'c': ${encryptedToken.substring(0, 80)}...`);

            const requestBody = {
                c: encryptedToken
            };

            console.log(`📤 Reserve Request Body:`, requestBody);

            const response = await fetch("https://api.ivacbd.com/iams/api/v1/slots/reserveSlot", {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify(requestBody)
            });

            const data = await response.json();
            console.log('📥 Reserve response:', data);

            if (response.ok && (data?.status === "OK_NEW" || data?.reservationId)) {
                if (data.reservationId) {
                    localStorage.setItem('ivac-reservation-id', JSON.stringify({
                        id: data.reservationId,
                        countByType: data.countByType || '-',
                        time: Date.now()
                    }));
                }
                return { success: true, data: data };
            }

            return {
                success: false,
                message: data?.message || 'Reservation failed'
            };

        } catch (error) {
            console.error('❌ Reserve error:', error);
            return { success: false, message: error.message || 'Reserve error' };
        }
    }

    // ==========================================
    // PERFORM CARD LOGIN
    // ==========================================
    async function performCardLogin(index, phone, password) {
        const key = `login-action-${index}`;
        if (isProcessing[key]) return;

        isProcessing[key] = true;

        const btn = document.querySelector(`.login-action-btn[data-index="${index}"]`);
        const card = document.querySelector(`.modern-card[data-type="login"][data-index="${index}"]`);

        try {
            if (btn) {
                btn.disabled = true;
                btn.textContent = '⏳ Getting token...';
            }

            const token = getToken('login', index);

            if (!token) {
                showNotification(`❌ No login token available for #${index}. Please solve Turnstile first.`, 'error');
                if (btn) {
                    btn.textContent = '❌ No Token';
                    btn.className = 'card-btn card-btn-login login-action-btn failed';
                    setTimeout(() => {
                        btn.textContent = '🔐 Login';
                        btn.className = 'card-btn card-btn-login login-action-btn';
                        btn.disabled = false;
                    }, 3000);
                }
                return;
            }

            if (btn) {
                btn.textContent = '⏳ Logging in...';
            }

            const result = await loginUserV2(phone, password, token);

            if (result.success) {
                if (btn) {
                    btn.textContent = '✅ Logged In';
                    btn.className = 'card-btn card-btn-login login-action-btn success';
                    setTimeout(() => {
                        btn.textContent = '🔐 Login';
                        btn.className = 'card-btn card-btn-login login-action-btn';
                        btn.disabled = false;
                    }, 3000);
                }

                if (card) {
                    const badge = card.querySelector('.card-badge');
                    if (badge) {
                        badge.textContent = '✅ Logged In';
                        badge.className = 'card-badge success';
                    }
                }

                showNotification(`✅ Login #${index} successful!`, 'success');

                const globalStatus = document.getElementById('global-login-status');
                if (globalStatus) {
                    globalStatus.textContent = '✅ Logged In';
                    globalStatus.className = 'modern-badge active';
                }

            } else {
                if (btn) {
                    btn.textContent = '❌ Failed';
                    btn.className = 'card-btn card-btn-login login-action-btn failed';
                    setTimeout(() => {
                        btn.textContent = '🔐 Login';
                        btn.className = 'card-btn card-btn-login login-action-btn';
                        btn.disabled = false;
                    }, 3000);
                }
                showNotification(`❌ Login #${index} failed: ${result.message}`, 'error');
            }

        } catch (error) {
            console.error(`❌ Login #${index} error:`, error);
            if (btn) {
                btn.textContent = '❌ Error';
                btn.className = 'card-btn card-btn-login login-action-btn failed';
                setTimeout(() => {
                    btn.textContent = '🔐 Login';
                    btn.className = 'card-btn card-btn-login login-action-btn';
                    btn.disabled = false;
                }, 3000);
            }
            showNotification(`❌ Login #${index} error: ${error.message}`, 'error');
        } finally {
            delete isProcessing[key];
        }
    }

    // ==========================================
    // PERFORM CARD RESERVE
    // ==========================================
    async function performCardReserve(index) {
        const key = `reserve-action-${index}`;
        if (isProcessing[key]) return;

        isProcessing[key] = true;

        const btn = document.querySelector(`.reserve-action-btn[data-index="${index}"]`);
        const card = document.querySelector(`.modern-card[data-type="reserve"][data-index="${index}"]`);

        try {
            let authToken = localStorage.getItem('accessToken');

            if (!authToken) {
                try {
                    const authData = JSON.parse(localStorage.getItem('auth-storage'));
                    if (authData?.state?.token) {
                        authToken = authData.state.token;
                    }
                } catch (e) {}
            }

            if (!authToken) {
                showNotification(`❌ No auth token found. Please login first for #${index}`, 'error');
                if (btn) {
                    btn.textContent = '❌ Login First';
                    btn.className = 'card-btn card-btn-reserve reserve-action-btn failed';
                    setTimeout(() => {
                        btn.textContent = '📅 Reserve';
                        btn.className = 'card-btn card-btn-reserve reserve-action-btn';
                        btn.disabled = false;
                    }, 3000);
                }
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.textContent = '⏳ Getting token...';
            }

            const token = getToken('reserve', index);

            if (!token) {
                showNotification(`❌ No reserve token available for #${index}. Please solve Turnstile first.`, 'error');
                if (btn) {
                    btn.textContent = '❌ No Token';
                    btn.className = 'card-btn card-btn-reserve reserve-action-btn failed';
                    setTimeout(() => {
                        btn.textContent = '📅 Reserve';
                        btn.className = 'card-btn card-btn-reserve reserve-action-btn';
                        btn.disabled = false;
                    }, 3000);
                }
                return;
            }

            if (btn) {
                btn.textContent = '⏳ Reserving...';
            }

            const result = await makeReserveRequest(authToken, token);

            if (result.success) {
                if (btn) {
                    btn.textContent = '✅ Reserved!';
                    btn.className = 'card-btn card-btn-reserve reserve-action-btn success';
                    setTimeout(() => {
                        btn.textContent = '📅 Reserve';
                        btn.className = 'card-btn card-btn-reserve reserve-action-btn';
                        btn.disabled = false;
                    }, 3000);
                }

                if (card) {
                    const badge = card.querySelector('.card-badge');
                    if (badge) {
                        badge.textContent = '✅ Reserved';
                        badge.className = 'card-badge success';
                    }
                }

                let message = `✅ Reserve #${index} successful!`;
                if (result.data) {
                    if (result.data.appointmentDate) message += ` Date: ${result.data.appointmentDate}`;
                    if (result.data.appointmentSlot) message += ` Slot: ${result.data.appointmentSlot}`;
                }
                showNotification(message, 'success');

                const globalStatus = document.getElementById('global-reserve-status');
                if (globalStatus) {
                    globalStatus.textContent = '✅ Reserved';
                    globalStatus.className = 'modern-badge active';
                }

            } else {
                if (btn) {
                    btn.textContent = '❌ Failed';
                    btn.className = 'card-btn card-btn-reserve reserve-action-btn failed';
                    setTimeout(() => {
                        btn.textContent = '📅 Reserve';
                        btn.className = 'card-btn card-btn-reserve reserve-action-btn';
                        btn.disabled = false;
                    }, 3000);
                }
                showNotification(`❌ Reserve #${index} failed: ${result.message}`, 'error');
            }

        } catch (error) {
            console.error(`❌ Reserve #${index} error:`, error);
            if (btn) {
                btn.textContent = '❌ Error';
                btn.className = 'card-btn card-btn-reserve reserve-action-btn failed';
                setTimeout(() => {
                    btn.textContent = '📅 Reserve';
                    btn.className = 'card-btn card-btn-reserve reserve-action-btn';
                    btn.disabled = false;
                }, 3000);
            }
            showNotification(`❌ Reserve #${index} error: ${error.message}`, 'error');
        } finally {
            delete isProcessing[key];
        }
    }

    // ==========================================
    // RENDER TURNSTILE FUNCTIONS
    // ==========================================
    function loadTurnstileScript() {
        if (turnstileLoadPromise) return turnstileLoadPromise;

        turnstileLoadPromise = new Promise((resolve) => {
            if (typeof turnstile !== 'undefined') {
                console.log('✅ Turnstile already loaded');
                resolve();
                return;
            }

            console.log('📥 Loading Turnstile script...');
            const script = document.createElement('script');
            script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
            script.async = true;
            script.defer = true;

            script.onload = () => {
                console.log('✅ Turnstile script loaded');
                setTimeout(resolve, 1500);
            };

            script.onerror = () => {
                console.error('❌ Failed to load Turnstile script');
                resolve();
            };

            document.head.appendChild(script);
        });

        return turnstileLoadPromise;
    }

    async function renderLoginTurnstile(containerId, retryCount = 0) {
        const container = document.getElementById(containerId);
        if (!container) {
            console.warn(`Container ${containerId} not found`);
            return;
        }

        container.innerHTML = '';
        container.style.display = 'flex';
        container.style.justifyContent = 'center';
        container.style.alignItems = 'center';
        container.style.minHeight = '90px';
        container.style.width = '100%';

        try {
            await loadTurnstileScript();
            if (typeof turnstile === 'undefined') {
                if (retryCount < 5) {
                    setTimeout(() => renderLoginTurnstile(containerId, retryCount + 1), 2000);
                }
                return;
            }

            const wrapper = document.createElement('div');
            wrapper.className = 'turnstile-wrapper-modern';
            wrapper.style.width = '100%';
            wrapper.style.minHeight = '90px';
            container.appendChild(wrapper);

            const loading = document.createElement('div');
            loading.textContent = '⏳ Loading Turnstile...';
            loading.style.cssText = 'color: #94a3b8; font-size: 13px; padding: 15px; text-align: center;';
            wrapper.appendChild(loading);

            const widgetId = turnstile.render(wrapper, {
                sitekey: TURNSTILE_SITEKEY,
                theme: TURNSTILE_THEME,
                size: TURNSTILE_SIZE,
                callback: function(token) {
                    console.log(`✅ Login #${containerId.split('-').pop()} solved!`);
                    if (loading) loading.remove();
                    storeToken('login', token, containerId);
                },
                'expired-callback': function() {
                    console.log(`⏰ Login #${containerId.split('-').pop()} expired`);
                    const index = containerId.split('-').pop();
                    clearToken('login', index);
                    if (loading) {
                        loading.textContent = '⏳ Expired - Reloading...';
                        loading.style.display = 'block';
                    }
                },
                'error-callback': function(error) {
                    console.error('Turnstile error:', error);
                    if (loading) {
                        loading.textContent = '❌ Error - Retrying...';
                    }
                    setTimeout(() => renderLoginTurnstile(containerId, retryCount + 1), 3000);
                }
            });

            widgetInstances.login[containerId] = widgetId;
            console.log(`✅ Login widget #${containerId.split('-').pop()} rendered`);

            setTimeout(() => {
                if (loading && loading.parentNode) {
                    const iframe = wrapper.querySelector('iframe');
                    if (iframe) loading.style.display = 'none';
                }
            }, 3000);

        } catch (error) {
            console.error('Error rendering login turnstile:', error);
            if (retryCount < 5) {
                setTimeout(() => renderLoginTurnstile(containerId, retryCount + 1), 3000);
            }
        }
    }

    async function renderReserveTurnstile(containerId, retryCount = 0) {
        const container = document.getElementById(containerId);
        if (!container) {
            console.warn(`Container ${containerId} not found`);
            return;
        }

        container.innerHTML = '';
        container.style.display = 'flex';
        container.style.justifyContent = 'center';
        container.style.alignItems = 'center';
        container.style.minHeight = '90px';
        container.style.width = '100%';

        try {
            await loadTurnstileScript();
            if (typeof turnstile === 'undefined') {
                if (retryCount < 5) {
                    setTimeout(() => renderReserveTurnstile(containerId, retryCount + 1), 2000);
                }
                return;
            }

            const wrapper = document.createElement('div');
            wrapper.className = 'turnstile-wrapper-modern';
            wrapper.style.width = '100%';
            wrapper.style.minHeight = '90px';
            container.appendChild(wrapper);

            const loading = document.createElement('div');
            loading.textContent = '⏳ Loading Turnstile...';
            loading.style.cssText = 'color: #94a3b8; font-size: 13px; padding: 15px; text-align: center;';
            wrapper.appendChild(loading);

            const widgetId = turnstile.render(wrapper, {
                sitekey: TURNSTILE_SITEKEY,
                theme: TURNSTILE_THEME,
                size: TURNSTILE_SIZE,
                callback: function(token) {
                    console.log(`✅ Reserve #${containerId.split('-').pop()} solved!`);
                    if (loading) loading.remove();
                    storeToken('reserve', token, containerId);
                },
                'expired-callback': function() {
                    console.log(`⏰ Reserve #${containerId.split('-').pop()} expired`);
                    const index = containerId.split('-').pop();
                    clearToken('reserve', index);
                    if (loading) {
                        loading.textContent = '⏳ Expired - Reloading...';
                        loading.style.display = 'block';
                    }
                },
                'error-callback': function(error) {
                    console.error('Turnstile error:', error);
                    if (loading) {
                        loading.textContent = '❌ Error - Retrying...';
                    }
                    setTimeout(() => renderReserveTurnstile(containerId, retryCount + 1), 3000);
                }
            });

            widgetInstances.reserve[containerId] = widgetId;
            console.log(`✅ Reserve widget #${containerId.split('-').pop()} rendered`);

            setTimeout(() => {
                if (loading && loading.parentNode) {
                    const iframe = wrapper.querySelector('iframe');
                    if (iframe) loading.style.display = 'none';
                }
            }, 3000);

        } catch (error) {
            console.error('Error rendering reserve turnstile:', error);
            if (retryCount < 5) {
                setTimeout(() => renderReserveTurnstile(containerId, retryCount + 1), 3000);
            }
        }
    }

    // ==========================================
    // BUILD UI
    // ==========================================
    function buildUI() {
        if (document.getElementById('turnstile-modern-ui')) {
            document.getElementById('turnstile-modern-ui').style.display = 'block';
            return;
        }

        const styleEl = document.createElement('style');
        styleEl.textContent = styles;
        document.head.appendChild(styleEl);

        const template = document.createElement('div');
        template.id = 'turnstile-modern-ui';
        template.className = 'turnstile-modern-ui';

        const header = document.createElement('div');
        header.className = 'modern-header';
        header.innerHTML = `
            <div class="modern-header-left">
                <span class="modern-logo">✦ Turnstile</span>
                <span class="modern-badge">10x</span>
                <span class="modern-badge active">🤖 Auto</span>
                <span class="modern-badge encrypt">🔐 Encrypt</span>
                <span class="modern-badge cipher" id="cipher-status">⏳ Loading...</span>
                <span class="modern-badge" id="global-login-status">⏳ Not logged in</span>
                <span class="modern-badge" id="global-reserve-status">⏳ Not reserved</span>
            </div>
            <div class="modern-header-actions">
                <button class="modern-btn" id="cipher-load-btn" title="Load Cipher">🔑</button>
                <button class="modern-btn" id="refresh-all-turnstile" title="Refresh All">⟳ Refresh</button>
                <button class="modern-btn-icon" id="toggle-turnstile-ui" title="Toggle">−</button>
                <button class="modern-btn-icon" id="close-turnstile-ui" title="Close">✕</button>
            </div>
        `;
        template.appendChild(header);

        let isMinimized = false;
        const toggleBtn = header.querySelector('#toggle-turnstile-ui');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                const content = document.getElementById('modern-content');
                if (content) {
                    isMinimized = !isMinimized;
                    content.style.display = isMinimized ? 'none' : 'block';
                    toggleBtn.textContent = isMinimized ? '+' : '−';
                }
            });
        }

        const closeBtn = header.querySelector('#close-turnstile-ui');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                template.style.display = 'none';
            });
        }

        const refreshBtn = header.querySelector('#refresh-all-turnstile');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                clearAllTokens();

                for (let i = 1; i <= 5; i++) {
                    const loginContainer = `login-turnstile-${i}`;
                    const widgetId = widgetInstances.login?.[loginContainer];
                    if (widgetId && typeof turnstile !== 'undefined') {
                        turnstile.reset(widgetId);
                    } else {
                        renderLoginTurnstile(loginContainer);
                    }

                    const reserveContainer = `reserve-turnstile-${i}`;
                    const reserveWidgetId = widgetInstances.reserve?.[reserveContainer];
                    if (reserveWidgetId && typeof turnstile !== 'undefined') {
                        turnstile.reset(reserveWidgetId);
                    } else {
                        renderReserveTurnstile(reserveContainer);
                    }
                }

                showNotification('🔄 All widgets refreshed', 'info');
            });
        }

        const cipherLoadBtn = header.querySelector('#cipher-load-btn');
        if (cipherLoadBtn) {
            cipherLoadBtn.addEventListener('click', () => {
                loadCipherFromServer(false);
            });
        }

        const content = document.createElement('div');
        content.id = 'modern-content';

        // Cipher Code Section
        const cipherSection = document.createElement('div');
        cipherSection.className = 'cipher-code-section';
        cipherSection.innerHTML = `
            <div class="cipher-code-header">
                <span class="label">🔐 Cipher Code (Login & Reserve Encryption)</span>
                <div class="actions">
                    <button id="cipher-save-btn">💾 Save</button>
                    <button id="cipher-clear-btn">🗑️ Clear</button>
                    <button id="cipher-auto-btn">🔄 Auto Load</button>
                </div>
            </div>
            <textarea id="cipher-code-input" class="cipher-code-input" placeholder="Paste your cipher code here or click Auto Load to fetch from server..." spellcheck="false"></textarea>
            <div id="cipher-status-text" class="cipher-status-text">
                <span class="dot loading"></span> Waiting for cipher code...
            </div>
        `;
        content.appendChild(cipherSection);

        const saveBtn = document.getElementById('cipher-save-btn');
        if (saveBtn) saveBtn.addEventListener('click', saveCipherCodeManually);

        const clearBtn = document.getElementById('cipher-clear-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                const input = document.getElementById('cipher-code-input');
                if (input) {
                    input.value = '';
                    localStorage.removeItem('turnstile_cipher_code');
                    showNotification('🗑️ Cipher code cleared', 'info');
                }
            });
        }

        const autoBtn = document.getElementById('cipher-auto-btn');
        if (autoBtn) {
            autoBtn.addEventListener('click', () => {
                loadCipherFromServer(false);
            });
        }

        const cipherInput = document.getElementById('cipher-code-input');
        if (cipherInput) {
            cipherInput.addEventListener('input', function() {
                const statusText = document.getElementById('cipher-status-text');
                if (statusText) {
                    statusText.innerHTML = `<span class="dot loading"></span> Code changed - click Save to apply`;
                }
            });
        }

        // Login Section
        const loginSection = document.createElement('div');
        loginSection.innerHTML = `
            <div class="section-header">
                <span class="icon">🔑</span>
                <span class="label login">Login Renders (encryptLogin)</span>
                <span class="status-badge">🔐 Encrypted</span>
                <span class="sub">Solve → Login API</span>
            </div>
        `;
        content.appendChild(loginSection);

        const loginGrid = document.createElement('div');
        loginGrid.className = 'modern-grid';

        for (let i = 1; i <= 5; i++) {
            const card = document.createElement('div');
            card.className = 'modern-card login-card';
            card.dataset.type = 'login';
            card.dataset.index = i;
            card.innerHTML = `
                <div class="card-header">
                    <span class="card-title login">🔑 Login #${i}</span>
                    <span class="card-badge">⏳ Waiting</span>
                </div>
                <div id="login-turnstile-${i}" style="display:flex;justify-content:center;align-items:center;min-height:90px;width:100%;"></div>
                <div class="phone-input-section">
                    <span class="label">📱</span>
                    <input type="text" class="login-phone-input" data-index="${i}" placeholder="Phone" value="01944714251">
                    <span class="label">🔑</span>
                    <input type="password" class="login-password-input" data-index="${i}" placeholder="Password" value="@Gmail123">
                </div>
                <div class="card-actions">
                    <button class="card-btn card-btn-login login-action-btn" data-index="${i}">🔐 Login</button>
                    <button class="card-btn card-btn-reload login-reload-btn" data-index="${i}">⟳</button>
                </div>
            `;
            loginGrid.appendChild(card);

            const containerId = `login-turnstile-${i}`;
            setTimeout(() => renderLoginTurnstile(containerId), 500 * i);

            const loginBtn = card.querySelector('.login-action-btn');
            if (loginBtn) {
                loginBtn.addEventListener('click', async (e) => {
                    const idx = e.target.dataset.index;
                    const phoneInput = card.querySelector(`.login-phone-input[data-index="${idx}"]`);
                    const passwordInput = card.querySelector(`.login-password-input[data-index="${idx}"]`);
                    const phone = phoneInput?.value?.trim() || '01944714251';
                    const password = passwordInput?.value || '@Gmail123';
                    await performCardLogin(idx, phone, password);
                });
            }

            const reloadBtn = card.querySelector('.login-reload-btn');
            if (reloadBtn) {
                reloadBtn.addEventListener('click', (e) => {
                    const idx = e.target.dataset.index;
                    clearToken('login', idx);
                    const containerId = `login-turnstile-${idx}`;
                    const widgetId = widgetInstances.login?.[containerId];
                    if (widgetId && typeof turnstile !== 'undefined') {
                        turnstile.reset(widgetId);
                    } else {
                        renderLoginTurnstile(containerId);
                    }
                });
            }

            const phoneInput = card.querySelector('.login-phone-input');
            const passwordInput = card.querySelector('.login-password-input');
            if (phoneInput) {
                phoneInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter' && loginBtn) loginBtn.click();
                });
            }
            if (passwordInput) {
                passwordInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter' && loginBtn) loginBtn.click();
                });
            }
        }
        content.appendChild(loginGrid);

        // Reserve Section
        const reserveSection = document.createElement('div');
        reserveSection.innerHTML = `
            <div class="section-header">
                <span class="icon">📅</span>
                <span class="label reserve">Reserve Renders (encryptReserve)</span>
                <span class="status-badge">🔐 Encrypted</span>
                <span class="sub">Solve → Reserve API</span>
            </div>
        `;
        content.appendChild(reserveSection);

        const reserveGrid = document.createElement('div');
        reserveGrid.className = 'modern-grid';

        for (let i = 1; i <= 5; i++) {
            const card = document.createElement('div');
            card.className = 'modern-card reserve-card';
            card.dataset.type = 'reserve';
            card.dataset.index = i;
            card.innerHTML = `
                <div class="card-header">
                    <span class="card-title reserve">📅 Reserve #${i}</span>
                    <span class="card-badge">⏳ Waiting</span>
                </div>
                <div id="reserve-turnstile-${i}" style="display:flex;justify-content:center;align-items:center;min-height:90px;width:100%;"></div>
                <div class="card-actions">
                    <button class="card-btn card-btn-reserve reserve-action-btn" data-index="${i}">📅 Reserve Slot</button>
                    <button class="card-btn card-btn-reload reserve-reload-btn" data-index="${i}">⟳</button>
                </div>
            `;
            reserveGrid.appendChild(card);

            const containerId = `reserve-turnstile-${i}`;
            setTimeout(() => renderReserveTurnstile(containerId), 500 * i + 250);

            const reserveBtn = card.querySelector('.reserve-action-btn');
            if (reserveBtn) {
                reserveBtn.addEventListener('click', async (e) => {
                    const idx = e.target.dataset.index;
                    await performCardReserve(idx);
                });
            }

            const reloadBtn = card.querySelector('.reserve-reload-btn');
            if (reloadBtn) {
                reloadBtn.addEventListener('click', (e) => {
                    const idx = e.target.dataset.index;
                    clearToken('reserve', idx);
                    const containerId = `reserve-turnstile-${idx}`;
                    const widgetId = widgetInstances.reserve?.[containerId];
                    if (widgetId && typeof turnstile !== 'undefined') {
                        turnstile.reset(widgetId);
                    } else {
                        renderReserveTurnstile(containerId);
                    }
                });
            }
        }
        content.appendChild(reserveGrid);

        const footer = document.createElement('div');
        footer.className = 'modern-footer';
        footer.innerHTML = `
            <span>🔐 Login → encryptLogin → 'c' → Login API</span>
            <span>🔐 Reserve → encryptReserve → 'c' → Reserve API</span>
            <span>🌐 Requests visible in Network tab</span>
            <span>🛡️ Uses fetch() for API calls</span>
        `;
        content.appendChild(footer);

        template.appendChild(content);
        document.body.appendChild(template);

        // Check for saved auth token
        try {
            const authToken = localStorage.getItem('accessToken');
            if (authToken) {
                const globalStatus = document.getElementById('global-login-status');
                if (globalStatus) {
                    globalStatus.textContent = '✅ Token stored';
                    globalStatus.className = 'modern-badge active';
                }
            }
        } catch (e) {}

        // Auto-load cipher from server on startup (falls back to localStorage cache)
        setTimeout(() => loadCipherFromServer(true), 1200);
    }

    // ==========================================
    // INIT
    // ==========================================
    function init() {
        console.log('🚀 Starting Turnstile Solver with Login/Reserve...');
        console.log('📌 Flow: Solve Turnstile → Encrypt → Login/Reserve API');
        console.log('🔐 Login uses encryptLogin from Cipher Code section');
        console.log('🔐 Reserve uses encryptReserve from Cipher Code section');
        console.log('🌐 API requests use fetch() - visible in Network tab');

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                setTimeout(buildUI, 1500);
            });
        } else {
            setTimeout(buildUI, 1500);
        }
    }

    init();

    window.__turnstileUI = {
        loadCipher: loadCipherFromServer,
        encryptToken: encryptTokenWithCipher,
        loginUserV2: loginUserV2,
        makeReserveRequest: makeReserveRequest,
        performCardLogin: performCardLogin,
        performCardReserve: performCardReserve,
        getTokens: () => turnstileTokens,
        getCipherStatus: () => cipherFunctions.loaded
    };

    console.log('✨ Turnstile UI with Login/Reserve loaded!');
    console.log('🔐 Cipher encryption is active for both login and reserve');
    console.log('🌐 API requests will appear in Network tab');
})();