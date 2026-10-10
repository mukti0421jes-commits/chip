'use strict';
// ═══════════════════════════════════════════════════════════════════
//  HARNESS — bundle-টা চালানোর পরিবেশ
//    • bundle + একটা খালি SPA shell লোকাল সার্ভারে দেয়
//    • Chromium খুলে প্রতিটা scenario-র জন্য আলাদা context বানায়
//    • সব outgoing request (endpoint / header / payload) রেকর্ড করে
//    • response গুলো keyword দেখে বানায় — কোনো hardcode path নেই,
//      তাই bundle-এ path বদলালেও mock ঠিকঠাক মেলে
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const API_HOST = /api\.ivacbd\.com/;
const SHELL = '<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head>' +
              '<body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';

// ── Chromium খুঁজে বের করা (Windows / macOS / Linux) ──────────────
function browserRoots() {
    const home = os.homedir();
    return [
        process.env.PLAYWRIGHT_BROWSERS_PATH,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null,
        path.join(home, 'AppData', 'Local', 'ms-playwright'),
        path.join(home, 'Library', 'Caches', 'ms-playwright'),
        path.join(home, '.cache', 'ms-playwright'),
        '/opt/pw-browsers'
    ].filter(Boolean);
}

function findChromium() {
    if (process.env.PROBE_CHROMIUM) return process.env.PROBE_CHROMIUM;
    const tails = [
        ['chrome-win64', 'chrome.exe'],
        ['chrome-win', 'chrome.exe'],
        ['chrome-linux', 'chrome'],
        ['Chromium.app', 'Contents', 'MacOS', 'Chromium'],
        ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
        ['chrome-linux', 'headless_shell']
    ];
    for (const root of browserRoots()) {
        let entries = [];
        try { entries = fs.readdirSync(root); } catch (_) { continue; }
        // পুরো chromium আগে, headless shell পরে (দুটোই চলে, প্রথমটা বেশি সম্পূর্ণ)
        const full = entries.filter(function (d) { return /^chromium-/.test(d); }).sort().reverse();
        const shell = entries.filter(function (d) { return /^chromium[_-]headless/.test(d); }).sort().reverse();
        for (const dir of [''].concat(full, shell)) {
            for (const tail of tails) {
                const file = path.join.apply(path, [root, dir].concat(tail));
                if (fs.existsSync(file)) return file;
            }
        }
    }
    // playwright-core নিজে কোনো browser নামায় না। কিন্তু PC-তে Chrome/Edge
    //   তো আছেই — playwright সেগুলোও চালাতে পারে। তাই আলাদা download না
    //   করেও কাজ চলে যায়।
    const home = os.homedir();
    const installed = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'
    ];
    for (const file of installed) {
        try { if (fs.existsSync(file)) return file; } catch (_) {}
    }
    throw new Error('Chromium পাওয়া গেল না।\n' +
        '  ঠিক করতে: npx playwright install chromium\n' +
        '  অথবা PROBE_CHROMIUM env var-এ chrome.exe এর পুরো পথ দিন।');
}

// ── bundle পরিবেশন করার সার্ভার ───────────────────────────────────
function startServer(bundlePath) {
    const code = fs.readFileSync(bundlePath);
    return new Promise(function (resolve) {
        const srv = http.createServer(function (req, res) {
            if (req.url === '/app.js') {
                res.writeHead(200, { 'content-type': 'application/javascript' });
                return res.end(code);
            }
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(SHELL);
        });
        srv.listen(0, function () {
            resolve({ port: srv.address().port, close: function () { srv.close(); } });
        });
    });
}

// ── keyword-ভিত্তিক response builder ─────────────────────────────
//   ⚠️ default সবসময় data:null — অচেনা endpoint-এ বানানো object
//      দিলে কিছু পেজ ফাঁকা render করে (payment-amount-এ প্রমাণিত)।
function buildResponse(url, state) {
    if (/reserve/i.test(url)) {
        return {
            status: 'OK_NEW', reservationId: 'res-1', appointmentDate: state.dates[0],
            countByType: { TOURIST: 1 }, reserveTtlSeconds: 660, message: 'Reserved booking'
        };
    }
    let data = null;
    if (/sign-?in/i.test(url)) {
        data = {
            accessToken: state.jwt, requestId: state.requestId,
            userId: state.userId, expiresAt: new Date(Date.now() + 3e5).toISOString()
        };
    } else if (/otp/i.test(url)) {
        data = { accessToken: state.jwt, userId: state.userId, expiresAt: new Date(Date.now() + 864e5).toISOString() };
    } else if (/confirm|slot.?status/i.test(url)) {
        data = Object.assign({ num: 1 }, state.gate);
    } else if (/booking.?config/i.test(url)) {
        data = state.booking;
    } else if (/over.?views?/i.test(url)) {
        data = state.overview;
    } else if (/ivac.?center/i.test(url)) {
        // দেখানোর নামটা UI যে key থেকে পড়ে সেটা bundle ভেদে বদলাতে পারে,
        // তাই চেনা কয়েকটা নামেই একই মান বসাই — নইলে dropdown ফাঁকা ফোটে
        data = [{ id: 11, ivacId: 11, centerName: state.ivacCenter, ivacName: state.ivacCenter, name: state.ivacCenter }];
    } else if (/high.?comm|mission/i.test(url)) {
        data = [{ id: 2, missionId: 2, missionName: state.mission, name: state.mission }];
    }
    return { data: data, statusCode: 200, successFlag: true, message: 'Success', serverTime: new Date().toISOString() };
}

// ── ভুয়া JWT (আসল অ্যাকাউন্ট লাগে না) ────────────────────────────
function fakeJwt(userId) {
    const seg = function (o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); };
    const iat = Math.floor(Date.now() / 1000);
    return seg({ kid: 'probe', typ: 'JWT', alg: 'RS256' }) +
           '.' + seg({ sub: userId, aud: 'iams-api', iss: 'iams', iat: iat, exp: iat + 86400 }) + '.sig';
}

// ── প্রতি scenario-র ডিফল্ট state ─────────────────────────────────
function makeState(overrides) {
    const userId = '00000000-0000-0000-0000-000000000000';
    const dates = [1, 2, 3].map(function (i) {
        return new Date(Date.now() + i * 864e5).toISOString().slice(0, 10);
    });
    const base = {
        jwt: fakeJwt(userId),
        userId: userId,
        requestId: '11111111-1111-1111-1111-111111111111',
        phone: '01711111111',
        password: 'Probe@1234',
        otp: '123456',
        dates: dates,
        mission: 'Dhaka',
        ivacCenter: 'IVAC, Dhaka (JFP)',
        overview: [{ applicationId: 'BGD0001', name: 'Probe', primary: true, isPrimary: true, passport: 'A1' }],
        gate: { uploadFile: true, fileUploadConfirmed: false, slotOpen: false, paymentConfirm: false, uploadEnd: false }
    };
    const state = Object.assign(base, overrides || {});
    // ⚠️ booking বানানোর সময় state.dates ব্যবহার করি, উপরের local `dates` নয় —
    //    নইলে override করা তারিখ উপেক্ষিত হতো, আর ছাঁচে তারিখটা "স্থির" ভেবে
    //    হার্ডকোড হয়ে যেত।
    state.booking = state.booked ? {
        appointmentDate: state.dates, appointmentId: state.appointmentId || 'a1',
        appointmentSlot: state.appointmentSlot || '09:00 AM - 10:00 AM',
        numberOfApplicants: 1, totalAmount: 1200, ivacCenter: state.ivacCenter,
        mission: state.mission, fileUploadStatus: 'MISSION_CENTER_SELECTED', visaCodes: null
    } : {
        appointmentDate: [], appointmentId: null, appointmentSlot: null, numberOfApplicants: 1,
        totalAmount: 0, ivacCenter: null, mission: null, fileUploadStatus: 'PENDING', visaCodes: null
    };
    return state;
}

// ── একটা session = context + page + recorder ─────────────────────
//   authed=false হলে auth-storage বসে না (sign-in পেজের জন্য)
async function openSession(browser, port, state, opts) {
    const o = opts || {};
    const requests = [];
    const context = await browser.newContext();

    await context.route('**/*', async function (route) {
        const req = route.request();
        const url = req.url();
        if (API_HOST.test(url)) {
            requests.push({
                method: req.method(),
                url: url.replace(/^https?:\/\/[^/]+/, ''),
                headers: req.headers(),
                body: req.postData() || ''
            });
            return route.fulfill({
                status: 200, contentType: 'application/json',
                body: JSON.stringify(buildResponse(url, state))
            });
        }
        if (url.indexOf('http://127.0.0.1:' + port) === 0) return route.continue();
        return route.fulfill({ status: 200, body: '' });   // CDN / analytics — চুপচাপ গিলে ফেলি
    });

    await context.addInitScript(function (init) {
        if (init.authed) {
            localStorage.setItem('auth-storage', JSON.stringify({
                state: {
                    token: init.jwt, userId: init.userId, expiresAt: Date.now() + 864e5,
                    isAuthenticated: true, isVerified: true, requestId: init.requestId, phone: init.phone
                }, version: 0
            }));
        }
        // Turnstile widget-এর বদলে চেনা marker — এটাই cipher-এর ground truth input
        //
        // ⚠️ sitekey এখান থেকেই ধরা পড়ে। ওটা কোনো request-এ যায় না, আর bundle-এর
        //    কাঁচা লেখাতেও নাও থাকতে পারে (obfuscated string table-এ ঢুকে যায় —
        //    মাপা: নতুন bundle-এ `0x4…` regex-এ কিছুই মেলে না)। কিন্তু সাইট যখন
        //    নিজে widget বানায় তখন মানটা খোলা অবস্থায় হাতে আসে।
        window.__probeSitekey = '';
        window.turnstile = {
            render: function (_el, cfg) {
                try {
                    var sk = cfg && cfg.sitekey;
                    if (typeof sk === 'string' && sk) window.__probeSitekey = sk;
                } catch (_) {}
                setTimeout(function () { if (cfg && cfg.callback) cfg.callback(init.marker); }, 20);
                return 'probe-widget';
            },
            reset: function () {}, remove: function () {}, getResponse: function () { return init.marker; }
        };
        // bundle-এর নিজের cipher function গুলো ধরে রাখি — নাম নয়, আচরণ দেখে।
        //   শুধু চিনে রাখা নয়, ফাংশনটা মুড়েও দিই: সাইট যখন নিজে ওটা ডাকে
        //   তখন argument গুলো (text, secret, startAt, length) টুকে নিই।
        //   ⇒ secret আর bundle-এর লেখা ঘেঁটে খুঁজতে হয় না, ডাকা দেখেই পাওয়া যায়।
        //   obfuscation যেমনই হোক, ডাকার মুহূর্তে মান গুলো খোলা অবস্থায় থাকে।
        window.__probeCipher = [];
        window.__probeCipherCalls = [];
        var sample = '1.' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'.repeat(2);
        var realFreeze = Object.freeze;
        Object.freeze = function (obj) {
            try {
                var keys = Object.keys(obj);
                if (keys.length && keys.length <= 60) {
                    for (var i = 0; i < keys.length; i++) {
                        var fn = obj[keys[i]];
                        if (typeof fn !== 'function' || fn.length !== 4) continue;
                        var out;
                        try { out = fn(sample, 'probe', 5, 24); } catch (_) { continue; }
                        if (typeof out === 'string' && out.length === sample.length && out !== sample) {
                            var idx = window.__probeCipher.push({ name: keys[i], fn: fn }) - 1;
                            (function (orig, nm, target, key, myIdx) {
                                var wrapped = function (text, secret, startAt, length) {
                                    var r = orig.apply(this, arguments);
                                    try {
                                        if (typeof text === 'string' && typeof secret === 'string') {
                                            window.__probeCipherCalls.push({
                                                name: nm, idx: myIdx, text: text, secret: secret,
                                                startAt: startAt, length: length, out: r
                                            });
                                        }
                                    } catch (_) {}
                                    return r;
                                };
                                try { target[key] = wrapped; } catch (_) {}
                            })(fn, keys[i], obj, keys[i], idx);
                        }
                    }
                }
            } catch (_) {}
            return realFreeze.apply(this, arguments);
        };
    }, {
        authed: o.authed !== false,
        jwt: state.jwt, userId: state.userId, requestId: state.requestId,
        phone: state.phone, marker: o.marker
    });

    const page = await context.newPage();
    await page.goto('http://127.0.0.1:' + port + o.route, { waitUntil: 'domcontentloaded' }).catch(function () {});
    await page.waitForTimeout(o.settle || 3200);
    return {
        page: page,
        requests: requests,
        close: function () { return context.close(); }
    };
}

module.exports = { findChromium, startServer, makeState, openSession };
