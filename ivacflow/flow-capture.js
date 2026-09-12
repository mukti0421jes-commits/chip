// ivac-flow — headless flow capture with MOCKED responses.
//
// Drives the app in a headless browser using MOCK data, INTERCEPTS every API
// request and answers it with a MOCK success response so the app walks to the
// next step — no real login, no real captcha, no real server needed. It records
// every request the app builds (endpoint + payload shape + headers) into
// flow.json. A mock Turnstile token is injected so captcha-gated submits proceed.
//
// NOTE (honest): the cipher "c" / x-token it records encrypt the MOCK turnstile
// token, so they are STRUCTURE only — not usable values. The bot makes real ones
// at runtime with a real captcha token. This tool maps the FLOW (which endpoints,
// what payload fields, what headers, what response fields each step reads).
//
//   node flow-capture.js [config.json]
//
// config.json (all optional):
//   { "url": "https://appointment.ivacbd.com/",
//     "mock": { "phone":"01700000000", "password":"Test@1234", "otp":"123456",
//               "turnstile":"MOCK_TURNSTILE_TOKEN" },
//     "responses": { "/auth/v3-sign-in": { ...json the app should receive... } },
//     "steps": [ {"fill":"input[type=tel]","value":"$phone"}, {"click":"button[type=submit]"} , {"waitMs":1500} ],
//     "headless": true, "runMs": 20000 }

'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const cfgPath = process.argv[2] || path.join(__dirname, 'config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) {}

const URL = cfg.url || 'https://appointment.ivacbd.com/';
const MOCK = Object.assign({ phone: '01700000000', password: 'Test@1234', otp: '123456', turnstile: 'MOCK_TURNSTILE_TOKEN' }, cfg.mock || {});
let RESPONSES = cfg.responses || {};
// optional: load real captured response shapes from a file (per-endpoint), so the
// real app's strict (Zod) validation is satisfied and it advances step to step.
if (cfg.responsesFile) {
  try { RESPONSES = Object.assign({}, JSON.parse(fs.readFileSync(cfg.responsesFile, 'utf8')), RESPONSES); } catch (_) {}
}
const HEADLESS = cfg.headless !== false;
const RUN_MS = cfg.runMs || 20000;
const OUT = cfg.out || __dirname;

const isApi = (u) => /\/iams\/api\/|\/api\/v\d+\/|\/payment\/|\/slots\/|\/invoice\//.test(u);
const isTurnstile = (u) => /challenges\.cloudflare\.com|turnstile/i.test(u);

// default mock success body (covers most steps); per-endpoint overrides win.
const ENDPOINT_RESPONSES = {
  '/auth/': { successFlag: true, statusCode: 200, message: 'Success', data: { accessToken: 'MOCK.ACCESS.TOKEN', requestId: 'mock-request-id', verified: true, status: 'ACTIVE', phone: MOCK.phone } },
  '/otp/': { successFlag: true, statusCode: 200, message: 'OTP verified', data: { verified: true, requestId: 'mock-request-id', accessToken: 'MOCK.ACCESS.TOKEN', status: 'VERIFIED' } },
  '/file/upload': { successFlag: true, statusCode: 200, message: 'Success', data: { fileId: 'mock-file-id', fileName: 'passport.pdf', status: 'UPLOADED' } },
  '/file/over-view': { successFlag: true, statusCode: 200, message: 'Success', data: { fileId: 'mock-file-id', fullName: 'MOCK USER', status: 'CONFIRMED', data: [{ fullName: 'MOCK USER', primary: true }] } },
  '/file/file-confirmation': { successFlag: true, statusCode: 200, message: 'Success', data: { fileId: 'mock-file-id', confirmed: true, slotAvailable: true, status: 'CONFIRMED' } },
  '/file/payment-amount': { successFlag: true, statusCode: 200, message: 'Success', data: { paymentAmount: 8200, currency: 'BDT', fileId: 'mock-file-id' } },
  '/appointment/': { successFlag: true, statusCode: 200, message: 'Success', data: { appointmentId: 'mock-appointment-id', appointmentDate: ['2026-09-15'], status: 'AVAILABLE' } },
  '/slots/': { successFlag: true, statusCode: 200, message: 'Success', data: { reservationId: 'mock-reservation-id', reserveTtlSeconds: 660, appointmentDate: '2026-09-15', status: 'RESERVED' } },
  '/payment/': { successFlag: true, statusCode: 200, message: 'Success', data: { webview_url: 'https://mock.gateway/pay', transactionId: 'mock-txn-id', amount: 8200 } },
  '/high-commissions': { successFlag: true, statusCode: 200, message: 'Success', data: [{ id: 1, name: 'Indian High Commission', commissionName: 'Dhaka' }] },
  '/ivac-centers': { successFlag: true, statusCode: 200, message: 'Success', data: [{ id: 1, name: 'IVAC Dhaka', center: 'Dhaka' }] },
};

function mockBodyFor(url) {
  for (const key of Object.keys(RESPONSES)) if (url.includes(key)) return RESPONSES[key];
  for (const key of Object.keys(ENDPOINT_RESPONSES)) if (url.includes(key)) return ENDPOINT_RESPONSES[key];
  return {
    successFlag: true, statusCode: 200, message: 'Success',
    data: {
      accessToken: 'MOCK.ACCESS.TOKEN', requestId: 'mock-request-id',
      verified: true, appointmentId: 'mock-appointment-id',
      fileId: 'mock-file-id', paymentAmount: 8200,
      reservationId: 'mock-reservation-id', reserveTtlSeconds: 660,
      appointmentDate: ['2026-09-15'], webview_url: 'https://mock.gateway/pay',
      data: [{ fullName: 'MOCK USER', primary: true, commissionName: 'Dhaka', ivacCenter: null }],
    },
  };
}

// Turnstile stub: any widget render immediately "succeeds" with our mock token,
// and window.turnstile.getResponse() returns it — so captcha-gated forms proceed.
function turnstileInitScript(token) {
  return `(() => {
    const T = ${JSON.stringify(token)};
    window.__mockTurnstile = T;
    const stub = {
      render: (el, opts) => { try { opts && opts.callback && opts.callback(T); } catch(e){} return 'mock-widget'; },
      getResponse: () => T, reset: () => {}, remove: () => {}, execute: () => { return T; },
      isExpired: () => false, ready: (cb) => { try { cb && cb(); } catch(e){} },
    };
    // re-define on every script load attempt so async Turnstile SDK can't overwrite
    Object.defineProperty(window, 'turnstile', { get: () => stub, set: () => {}, configurable: false });
    // fill hidden turnstile inputs as they appear
    const fill = () => document.querySelectorAll('input[name="cf-turnstile-response"],input[name="g-recaptcha-response"]').forEach(i => { i.value = T; });
    new MutationObserver(fill).observe(document.documentElement, { childList: true, subtree: true });
    fill();
  })();`;
}

const HOST_ORIGIN = cfg.hostOrigin || '';   // app origin whose own files should load normally
const HOLD_OPEN_MS = cfg.holdOpenMs || 0;   // keep window open for manual driving (0 = off)
const LIVE_CAPTURE = !!cfg.liveCapture;     // hit the real server, record real responses
const RESPONSES_OUT = cfg.responsesOut || path.join(OUT, 'responses.json');
const log = [];
const responsesMap = {};
function writeResponses() { try { fs.writeFileSync(RESPONSES_OUT, JSON.stringify(responsesMap, null, 2)); } catch (_) {} }

function writeFlow() {
  const summary = log.map((e) => {
    let fields = null; try { const j = JSON.parse(e.body); fields = Object.keys(j); } catch (_) {}
    const hdr = {}; for (const k of ['x-token', 'x-sec-navigation-state', 'x-sec-runtime-state', 'x-v-request-meta', 'authorization', 'content-type']) if (e.headers[k]) hdr[k] = e.headers[k];
    return { method: e.method, url: e.url, payloadFields: fields, headers: hdr };
  });
  try { fs.writeFileSync(path.join(OUT, 'flow.json'), JSON.stringify({ capturedAt: new Date().toISOString(), calls: log, summary }, null, 2)); } catch (_) {}
}

// If Playwright's own Chromium isn't downloaded (e.g. pinned system build),
// fall back to any chrome executable under PLAYWRIGHT_BROWSERS_PATH.
function findChromeExe() {
  if (cfg.executablePath) return cfg.executablePath;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === 'chrome' || e.name === 'headless_shell' || e.name === 'chrome-headless-shell') return p;
    }
  }
  return undefined;
}

(async () => {
  const exe = findChromeExe();
  let browser;
  try {
    browser = await chromium.launch({ headless: HEADLESS });
  } catch (e) {
    if (!exe) throw e;
    console.log('ℹ using system chromium:', exe);
    browser = await chromium.launch({ headless: HEADLESS, executablePath: exe });
  }
  const context = await browser.newContext();
  await context.addInitScript(turnstileInitScript(MOCK.turnstile));
  const page = await context.newPage();

  // Intercept EVERY API call: record it, then fulfill with a mock response so the
  // app advances without a real server / captcha.
  const isAsset = (u) => /\.(css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|map)(\?|$)/i.test(u) || /fonts\.(googleapis|gstatic)\.com/.test(u);
  const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-token, x-sec-navigation-state, x-sec-runtime-state, x-v-request-meta, x-requested-with, accept',
    'access-control-max-age': '86400',
  };
  // LIVE capture: don't mock — let requests hit the real server and record the
  // real responses to responses.json (which the offline mock-walk then replays).
  if (LIVE_CAPTURE) {
    page.on('response', async (resp) => {
      const url = resp.url();
      if (!isApi(url)) return;
      let bodyText = ''; try { bodyText = await resp.text(); } catch (_) { return; }
      let parsed; try { parsed = JSON.parse(bodyText); } catch (_) { return; }
      const key = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      responsesMap[key] = parsed; writeResponses();
    });
  }
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    // let the app's own origin (host page + bundle) load normally
    if (HOST_ORIGIN && url.startsWith(HOST_ORIGIN)) return route.continue();
    // block Turnstile SDK so it can't overwrite our stub
    if (isTurnstile(url)) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/javascript' }, body: '/* turnstile blocked — mock active */' });
    }
    // handle CORS preflight for API and any cross-origin request
    if (method === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS_HEADERS, body: '' });
    }
    if (isApi(url)) {
      log.push({ time: new Date().toISOString(), method, url, headers: req.headers(), body: req.postData() || '' });
      writeFlow();
      if (LIVE_CAPTURE) return route.continue();
      return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'application/json' }, CORS_HEADERS), body: JSON.stringify(mockBodyFor(url)) });
    }
    // stub external assets (fonts/css/images) so nothing errors the app
    if (isAsset(url)) return route.fulfill({ status: 200, body: '' });
    return route.continue();
  });

  console.log('🌐 loading (headless):', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // Drive the UI with mock data (steps from config; generic fallback otherwise).
  const steps = cfg.steps || [
    { fill: 'input[type="tel"], input[name*="phone" i], input[placeholder*="phone" i]', value: '$phone' },
    { fill: 'input[type="password"]', value: '$password' },
    { click: 'button[type="submit"], button:has-text("Sign"), button:has-text("Login"), button:has-text("Continue")' },
    { waitMs: 2500 },
    { fill: 'input[name*="otp" i], input[maxlength="6"], input[inputmode="numeric"]', value: '$otp' },
    { click: 'button[type="submit"], button:has-text("Verify"), button:has-text("Continue")' },
    { waitMs: 2500 },
  ];
  const val = (v) => (typeof v === 'string' && v[0] === '$') ? (MOCK[v.slice(1)] ?? v) : v;
  for (const st of steps) {
    try {
      if (st.waitMs) { await page.waitForTimeout(st.waitMs); continue; }
      if (st.press) { await page.keyboard.press(st.press).catch(() => {}); continue; }
      // close stacked modal overlays, topmost first (advisory / notice popups)
      if (st.closeOverlays) {
        for (let i = 0; i < (st.closeOverlays || 6); i++) {
          const n = await page.evaluate(() => {
            const els = document.querySelectorAll('.fixed.inset-0'); if (!els.length) return 0;
            const b = els[els.length - 1].querySelector('button'); if (b) b.click(); return els.length;
          }).catch(() => 0);
          if (!n) break; await page.waitForTimeout(600);
        }
        continue;
      }
      // click an element by its exact visible text (React buttons/links)
      if (st.clickText) {
        const el = page.getByText(new RegExp('^\\s*' + st.clickText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$')).first();
        if (await el.count()) await el.click({ timeout: 3000, force: !!st.force }).catch(() => {});
        continue;
      }
      if (st.fill) { const el = page.locator(st.fill).first(); if (await el.count()) await el.fill(String(val(st.value)), { timeout: 3000 }).catch(() => {}); }
      if (st.click) { const el = page.locator(st.click).first(); if (await el.count()) await el.click({ timeout: 3000, force: !!st.force }).catch(() => {}); }
    } catch (_) {}
  }
  await page.waitForTimeout(1500);
  writeFlow();

  // Manual mode: keep the (visible) window open so the user can drive the app by
  // hand; every request keeps getting mocked + captured (writeFlow streams it).
  if (HOLD_OPEN_MS > 0) {
    console.log(`🖐 manual mode — window খোলা থাকবে ${Math.round(HOLD_OPEN_MS / 1000)}s (বা বন্ধ করলে). নিজে হাতে চালান…`);
    let closed = false; page.on('close', () => { closed = true; });
    const t0 = Date.now();
    while (!closed && Date.now() - t0 < HOLD_OPEN_MS) { await page.waitForTimeout(1000).catch(() => { closed = true; }); }
    writeFlow();
  }

  console.log(`\n💾 captured ${log.length} API call(s) → ${path.join(OUT, 'flow.json')}`);
  await browser.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('flow-capture error:', e); process.exit(1); });

module.exports = { mockBodyFor, turnstileInitScript, isApi };
