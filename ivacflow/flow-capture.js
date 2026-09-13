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

const isApi = (u) => /\/iams\/api\/|\/api\/v\d+\/|\/payment\/|\/slots\/|\/invoice\/|api\.ivacbd\.com/.test(u);
const isTurnstile = (u) => /challenges\.cloudflare\.com|turnstile/i.test(u);

const ENDPOINT_RESPONSES = {
  '/auth/v2-sign-in': {
    successFlag: true, statusCode: 200, message: 'Success',
    data: {
      accessToken: 'MOCK.ACCESS.TOKEN', refreshToken: 'MOCK.REFRESH.TOKEN',
      requestId: 'mock-request-id', verified: true, status: 'ACTIVE',
      phone: MOCK.phone, userId: 'mock-user-id', tokenType: 'Bearer',
      expiresIn: 3600, otpRequired: true, otpChannel: 'PHONE',
      isRegistered: true, registered: true, isNewUser: false, newUser: false,
      profileCompleted: true, isProfileCompleted: true,
      user: { id: 'mock-user-id', phone: MOCK.phone, fullName: 'MOCK USER', email: 'mock@test.com', status: 'ACTIVE', verified: true, isRegistered: true, profileCompleted: true },
    },
  },
  '/auth/signup': {
    successFlag: true, statusCode: 200, message: 'Success',
    data: { requestId: 'mock-request-id', phone: MOCK.phone, status: 'PENDING', otpChannel: 'PHONE' },
  },
  '/otp/verifySigninOtp': {
    successFlag: true, statusCode: 200, message: 'Success',
    data: {
      verified: true, requestId: 'mock-request-id', status: 'VERIFIED',
      accessToken: 'MOCK.ACCESS.TOKEN', refreshToken: 'MOCK.REFRESH.TOKEN',
      tokenType: 'Bearer', expiresIn: 3600, userId: 'mock-user-id',
      isRegistered: true, registered: true, isNewUser: false, newUser: false,
      profileCompleted: true, isProfileCompleted: true,
      user: { id: 'mock-user-id', phone: MOCK.phone, fullName: 'MOCK USER', email: 'mock@test.com', status: 'ACTIVE', verified: true, isRegistered: true, profileCompleted: true },
    },
  },
  '/otp/verify': {
    successFlag: true, statusCode: 200, message: 'OTP verified',
    data: {
      verified: true, requestId: 'mock-request-id', status: 'VERIFIED',
      accessToken: 'MOCK.ACCESS.TOKEN', refreshToken: 'MOCK.REFRESH.TOKEN',
      tokenType: 'Bearer', expiresIn: 3600, userId: 'mock-user-id',
      isRegistered: true, registered: true, isNewUser: false, newUser: false,
      profileCompleted: true, isProfileCompleted: true,
      user: { id: 'mock-user-id', phone: MOCK.phone, fullName: 'MOCK USER', email: 'mock@test.com', status: 'ACTIVE', verified: true, isRegistered: true, profileCompleted: true },
    },
  },
  '/otp/signup': {
    successFlag: true, statusCode: 200, message: 'OTP sent',
    data: { requestId: 'mock-request-id', phone: MOCK.phone, otpChannel: 'PHONE', status: 'SENT' },
  },
  '/file/upload': {
    successFlag: true, statusCode: 200, message: 'File uploaded',
    data: {
      fileId: 'mock-file-id', fileName: 'passport.pdf', fileType: 'PASSPORT',
      status: 'UPLOADED', isPrimary: true, uploadedAt: new Date().toISOString(),
      mimeType: 'application/pdf', size: 1024,
    },
  },
  '/file/over-view': {
    successFlag: true, statusCode: 200, message: 'Success',
    data: {
      fileId: 'mock-file-id', fullName: 'MOCK USER', status: 'CONFIRMED',
      passportNumber: 'AB1234567', nationality: 'BANGLADESHI', gender: 'MALE',
      dateOfBirth: '1990-01-01', passportExpiry: '2030-01-01',
      visaType: 'TOURIST', travelDate: '2026-09-20',
      isPrimary: true, primary: true,
      data: [{ fullName: 'MOCK USER', primary: true, fileId: 'mock-file-id', passportNumber: 'AB1234567' }],
      files: [{ fileId: 'mock-file-id', fileName: 'passport.pdf', fileType: 'PASSPORT', isPrimary: true }],
    },
  },
  '/file/file-confirmation_and_slot_status': {
    successFlag: true, statusCode: 200, message: 'Success',
    data: {
      fileUploadConfirmed: true,
      slotOpen: true,
      paymentConfirm: false,
      uploadEnd: false,
    },
  },
  '/file/file-confirmation': {
    successFlag: true, statusCode: 200, message: 'Confirmed',
    data: {
      fileId: 'mock-file-id', confirmed: true, slotAvailable: true,
      status: 'CONFIRMED', confirmationId: 'mock-confirmation-id',
      applicantName: 'MOCK USER', passportNumber: 'AB1234567',
      visaType: 'TOURIST', mission: 'Indian High Commission',
      ivacCenter: 'IVAC Dhaka', slot_status: 'AVAILABLE',
    },
  },
  '/file/payment-amount': {
    successFlag: true, statusCode: 200, message: 'Success',
    data: {
      paymentAmount: 8200, amount: 8200, currency: 'BDT',
      fileId: 'mock-file-id', breakdown: [
        { name: 'Visa Fee', amount: 8000 }, { name: 'Service Charge', amount: 200 },
      ],
      totalAmount: 8200, paymentMethod: 'ONLINE',
    },
  },
  '/appointment/appointment-booking-config': {
    successFlag: true, statusCode: 200, message: 'Success',
    data: {
      appointmentId: 'mock-appointment-id', status: 'AVAILABLE',
      availableDates: ['2026-09-15', '2026-09-16', '2026-09-17'],
      appointmentDate: ['2026-09-15'],
      mission: { id: 1, name: 'Indian High Commission', commissionName: 'Dhaka' },
      ivacCenter: { id: 1, name: 'IVAC Dhaka', address: 'Dhaka' },
      slots: [{ id: 'mock-slot-id', date: '2026-09-15', time: '09:00', available: true }],
      config: { maxDate: '2026-12-31', minDate: '2026-09-15' },
    },
  },
  '/appointment/get-booking-config': {
    successFlag: true, statusCode: 200, message: 'Success',
    data: {
      amount: 8200, paymentAmount: 8200, currency: 'BDT',
      config: { maxDate: '2026-12-31', minDate: '2026-09-15' },
      appointmentId: 'mock-appointment-id',
      appointmentDate: ['2026-09-15'],
      slotOpen: true,
      serverTime: new Date().toISOString(),
      availableSlot: '09:00-11:00',
      slot: { id: 'mock-slot-id', date: '2026-09-15', time: '09:00', available: true },
    },
  },
  '/high-commissions': {
    successFlag: true, statusCode: 200, message: 'Success',
    data: [
      { id: 1, name: 'Indian High Commission', commissionName: 'Dhaka', country: 'India', status: 'ACTIVE' },
      { id: 2, name: 'Indian High Commission', commissionName: 'Chittagong', country: 'India', status: 'ACTIVE' },
    ],
  },
  '/ivac-centers': {
    successFlag: true, statusCode: 200, message: 'Success',
    data: [
      { id: 1, name: 'IVAC Dhaka', center: 'Dhaka', address: 'Jamuna Future Park, Dhaka', status: 'ACTIVE' },
      { id: 2, name: 'IVAC Chittagong', center: 'Chittagong', address: 'Chittagong', status: 'ACTIVE' },
    ],
  },
  '/slots/': {
    successFlag: true, statusCode: 200, message: 'Slot reserved',
    data: {
      reservationId: 'mock-reservation-id', reserveTtlSeconds: 660,
      appointmentDate: '2026-09-15', status: 'RESERVED',
      slotId: 'mock-slot-id', time: '09:00',
      expiresAt: new Date(Date.now() + 660000).toISOString(),
    },
  },
  '/payment/': {
    successFlag: true, statusCode: 200, message: 'Payment initiated',
    data: {
      webview_url: 'https://mock.gateway/pay', paymentUrl: 'https://mock.gateway/pay',
      transactionId: 'mock-txn-id', amount: 8200, currency: 'BDT',
      reservationId: 'mock-reservation-id', status: 'INITIATED',
      redirectUrl: 'https://mock.gateway/pay', gatewayRef: 'mock-gw-ref',
    },
  },
  '/auth/v3-sign-in': {
    successFlag: true, statusCode: 200, message: 'Success',
    data: {
      accessToken: 'MOCK.ACCESS.TOKEN', refreshToken: 'MOCK.REFRESH.TOKEN',
      requestId: 'mock-request-id', verified: true, status: 'ACTIVE',
      phone: MOCK.phone, userId: 'mock-user-id', tokenType: 'Bearer',
      expiresIn: 3600, otpRequired: true, otpChannel: 'PHONE',
      isRegistered: true, registered: true, isNewUser: false, newUser: false,
      profileCompleted: true, isProfileCompleted: true,
      user: { id: 'mock-user-id', phone: MOCK.phone, fullName: 'MOCK USER', email: 'mock@test.com', status: 'ACTIVE', verified: true, isRegistered: true, profileCompleted: true },
    },
  },
  '/forgot-password': {
    successFlag: true, statusCode: 200, message: 'Success',
    data: { requestId: 'mock-request-id', phone: MOCK.phone, status: 'SENT' },
  },
  '/profile': {
    successFlag: true, statusCode: 200, message: 'Success',
    data: { id: 'mock-user-id', phone: MOCK.phone, fullName: 'MOCK USER', email: 'mock@test.com', status: 'ACTIVE' },
  },
  '/invoice': {
    successFlag: true, statusCode: 200, message: 'Success',
    data: { invoiceId: 'mock-invoice-id', amount: 8200, status: 'PAID', downloadUrl: 'https://mock/invoice.pdf' },
  },
};

let _statusCallCount = 0;
let _slotReserved = false;
function mockBodyFor(url) {
  for (const key of Object.keys(RESPONSES)) if (url.includes(key)) return RESPONSES[key];
  if (url.includes('reserve-slot') || url.includes('/slots/')) _slotReserved = true;
  if (url.includes('file-confirmation_and_slot_status')) {
    _statusCallCount++;
    if (_slotReserved) {
      return { successFlag: true, statusCode: 200, message: 'Success',
        data: { fileUploadConfirmed: true, slotOpen: true, paymentConfirm: false,
          commissionId: 1, ivacId: 1, appointmentId: 'mock-appointment-id',
          reservationId: 'mock-reservation-id', slot: { date: '2026-09-15', time: '09:00' } } };
    }
    return ENDPOINT_RESPONSES['/file/file-confirmation_and_slot_status'];
  }
  // match most specific endpoint first (longer key = more specific)
  const sorted = Object.keys(ENDPOINT_RESPONSES).sort((a, b) => b.length - a.length);
  for (const key of sorted) if (url.includes(key)) return ENDPOINT_RESPONSES[key];
  return {
    successFlag: true, statusCode: 200, message: 'Success',
    data: {
      accessToken: 'MOCK.ACCESS.TOKEN', requestId: 'mock-request-id',
      verified: true, status: 'SUCCESS', isRegistered: true, isNewUser: false,
      profileCompleted: true, appointmentId: 'mock-appointment-id',
      fileId: 'mock-file-id', paymentAmount: 8200, amount: 8200,
      reservationId: 'mock-reservation-id', reserveTtlSeconds: 660,
      appointmentDate: ['2026-09-15'], webview_url: 'https://mock.gateway/pay',
      userId: 'mock-user-id', phone: MOCK.phone, fullName: 'MOCK USER',
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
      render: (el, opts) => {
        console.log('[TURNSTILE] render called, callback:', !!(opts && opts.callback));
        try { if (opts && opts.callback) setTimeout(() => { console.log('[TURNSTILE] firing callback'); opts.callback(T); }, 50); } catch(e){}
        return 'mock-widget';
      },
      getResponse: (id) => T,
      reset: () => {},
      remove: () => {},
      execute: (container, opts) => {
        try { if (opts && opts.callback) setTimeout(() => opts.callback(T), 50); } catch(e){}
        return T;
      },
      isExpired: () => false,
      ready: (cb) => { try { if (cb) setTimeout(cb, 10); } catch(e){} },
    };
    Object.defineProperty(window, 'turnstile', { get: () => stub, set: () => {}, configurable: false });
    // intercept dynamic Turnstile script injection
    const origAppend = Element.prototype.appendChild;
    Element.prototype.appendChild = function(child) {
      if (child.tagName === 'SCRIPT' && child.src && /challenges\\.cloudflare|turnstile/i.test(child.src)) {
        // extract the onload callback name from the src URL
        const onloadMatch = child.src.match(/[?&]onload=([^&]+)/);
        const cbName = onloadMatch ? onloadMatch[1] : 'onloadTurnstileCallback';
        const fake = document.createElement('script');
        fake.textContent = '/* turnstile blocked */';
        const result = origAppend.call(this, fake);
        // fire the onload callback after a microtask so the app's setup code finishes
        setTimeout(() => {
          if (typeof window[cbName] === 'function') {
            try { window[cbName](); } catch(e){}
          }
        }, 50);
        return result;
      }
      return origAppend.call(this, child);
    };
    // fill hidden turnstile/recaptcha inputs as they appear
    const fill = () => {
      document.querySelectorAll('input[name="cf-turnstile-response"],input[name="g-recaptcha-response"]').forEach(i => { i.value = T; });
      document.querySelectorAll('[data-callback]').forEach(el => {
        const cbName = el.getAttribute('data-callback');
        if (cbName && typeof window[cbName] === 'function') try { window[cbName](T); } catch(e){}
      });
    };
    const _startObserver = () => {
      if (document.documentElement) {
        new MutationObserver(fill).observe(document.documentElement, { childList: true, subtree: true });
      } else {
        setTimeout(_startObserver, 50);
      }
    };
    _startObserver();
    fill();
    // The real Turnstile SDK loads with ?onload=onloadTurnstileCallback&render=explicit
    // When we block the script, that callback never fires. Fire it ourselves once the
    // app defines it (it's set before the script tag is added).
    const _fireTurnstileOnload = () => {
      if (typeof window.onloadTurnstileCallback === 'function') {
        console.log('[TURNSTILE] onloadTurnstileCallback found, firing');
        try { window.onloadTurnstileCallback(); } catch(e){ console.log('[TURNSTILE] onload error:', e.message); }
        return true;
      }
      return false;
    };
    if (!_fireTurnstileOnload()) {
      let _polls = 0;
      const _tmr = setInterval(() => {
        _polls++;
        if (_fireTurnstileOnload()) clearInterval(_tmr);
        else if (_polls % 25 === 0) console.log('[TURNSTILE] still polling for onloadCallback... polls:', _polls);
      }, 200);
      setTimeout(() => { clearInterval(_tmr); console.log('[TURNSTILE] poll timed out after 15s'); }, 15000);
    }
  })();`;
}

const HOST_ORIGIN = cfg.hostOrigin || '';   // app origin whose own files should load normally
const HOLD_OPEN_MS = cfg.holdOpenMs || 0;   // keep window open for manual driving (0 = off)
const LIVE_CAPTURE = !!cfg.liveCapture;     // hit the real server, record real responses
const RESPONSES_OUT = cfg.responsesOut || path.join(OUT, 'responses.json');
const log = [];
const responsesMap = {};
function writeResponses() { try { fs.writeFileSync(RESPONSES_OUT, JSON.stringify(responsesMap, null, 2)); } catch (_) {} }

function extractFromCaptured(entries) {
  const extracted = { dgepayUuid: '', initiatePath: '', slotId: '', endpoints: {} };
  for (const e of entries) {
    const urlPath = e.url.replace(/^https?:\/\/[^/]+/, '');
    const initMatch = /\/payment\/([0-9a-zA-Z_-]{20,40})\/dg-epay\/initiate/.exec(urlPath);
    if (initMatch) { extracted.dgepayUuid = initMatch[1]; extracted.initiatePath = initMatch[0]; }
    const slotMatch = /\/slots\/([0-9a-f-]{20,40})\/reserve-slot/.exec(urlPath);
    if (slotMatch) extracted.slotId = slotMatch[1];
    if (/\/payment\/.*\/dg-epay\/initiate/.test(urlPath)) extracted.endpoints.paymentInitiate = urlPath;
    if (/\/payment\/ssl\/initiate/.test(urlPath)) extracted.endpoints.sslInitiate = urlPath;
    if (/\/auth\/.*sign-?in/i.test(urlPath)) extracted.endpoints.signin = urlPath;
    if (/\/otp\/verify/i.test(urlPath)) extracted.endpoints.verifyOtp = urlPath;
    if (/\/file\/upload/i.test(urlPath)) extracted.endpoints.uploadFile = urlPath;
    if (/\/file\/over-view/i.test(urlPath)) extracted.endpoints.overView = urlPath;
    if (/\/file\/file-confirmation/i.test(urlPath)) extracted.endpoints.fileConfirmation = urlPath;
    if (/\/file\/payment-amount/i.test(urlPath)) extracted.endpoints.paymentAmount = urlPath;
    if (/\/appointment.*booking-config/i.test(urlPath)) extracted.endpoints.bookingConfig = urlPath;
  }
  return extracted;
}

function writeFlow() {
  const summary = log.map((e) => {
    let fields = null; try { const j = JSON.parse(e.body); fields = Object.keys(j); } catch (_) {}
    const hdr = {}; for (const k of ['x-token', 'x-sec-navigation-state', 'x-sec-runtime-state', 'x-v-request-meta', 'authorization', 'content-type']) if (e.headers[k]) hdr[k] = e.headers[k];
    return { method: e.method, url: e.url, payloadFields: fields, headers: hdr };
  });
  const captured = extractFromCaptured(log);
  try { fs.writeFileSync(path.join(OUT, 'flow.json'), JSON.stringify({ capturedAt: new Date().toISOString(), calls: log, summary, extracted: captured }, null, 2)); } catch (_) {}
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
  // Intercept the route guard's switch order string
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
    if (HOST_ORIGIN && url.startsWith(HOST_ORIGIN)) {
      return route.continue();
    }
    // block Turnstile SDK so it can't overwrite our stub
    if (isTurnstile(url)) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/javascript' }, body: '/* turnstile blocked — mock active */' });
    }
    // handle CORS preflight for API and any cross-origin request
    if (method === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS_HEADERS, body: '' });
    }
    if (isApi(url)) {
      const mockResp = mockBodyFor(url);
      console.log(`  ✓ ${method} ${url.replace(/^https?:\/\/[^/]+/,'')}`);
      log.push({ time: new Date().toISOString(), method, url, headers: req.headers(), body: req.postData() || '' });
      writeFlow();
      if (LIVE_CAPTURE) return route.continue();
      return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'application/json' }, CORS_HEADERS), body: JSON.stringify(mockResp) });
    }
    // stub external assets (fonts/css/images/youtube thumbnails) so nothing errors the app
    if (isAsset(url) || /fonts\.|youtube\.com|ytimg\.com|googleapis\.com/i.test(url)) return route.fulfill({ status: 200, body: '' });
    return route.continue();
  });

  page.on('pageerror', e => console.log('  page-error:', e.message.substring(0, 120)));
  console.log('🌐 loading (headless):', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000);

  // ── Phase 0: Close modals/popups and navigate to Sign In ──
  // IVAC shows advisory/notice modals on landing. Close them first.
  for (let i = 0; i < 5; i++) {
    const closed = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        if (r.width === 0) continue;
        // close buttons on modals (X icons, absolute positioned)
        if (/absolute.*right|close/i.test(b.className) || b.getAttribute('aria-label')?.match(/close/i)) {
          b.click(); return true;
        }
      }
      // also try clicking outside modals
      const overlays = document.querySelectorAll('[class*="fixed"][class*="inset"], [class*="modal-overlay"], [class*="backdrop"]');
      if (overlays.length) { overlays[overlays.length - 1].click(); return true; }
      return false;
    }).catch(() => false);
    if (!closed) break;
    await page.waitForTimeout(500);
  }

  // Navigate to Sign In page (not Sign Up)
  const wentToSignin = await page.evaluate(() => {
    // Look for "Sign In" link/button (not "Sign Up", not "Sign In Then")
    const candidates = [...document.querySelectorAll('a, button')];
    for (const el of candidates) {
      const txt = (el.textContent || '').trim();
      const href = el.getAttribute('href') || '';
      // exact "Sign In" text or href to /signin
      if (/^sign\s*in$/i.test(txt) || (href.includes('/signin') && !href.includes('/signup') && /sign\s*in/i.test(txt))) {
        el.click();
        return txt;
      }
    }
    // fallback: any link to /signin
    for (const el of candidates) {
      const href = el.getAttribute('href') || '';
      if (href.includes('/signin') && !href.includes('/signup')) {
        el.click();
        return (el.textContent || '').trim();
      }
    }
    return '';
  }).catch(() => '');
  if (wentToSignin) console.log(`  → navigated to Sign In ("${wentToSignin}")`);
  await page.waitForTimeout(2000);

  // ── Adaptive UI walker ──
  // Instead of hardcoded selectors, we scan the visible DOM for inputs and
  // buttons, classify them by type/name/placeholder, fill with appropriate
  // mock data, and click submit — repeating until the flow completes or
  // times out. This works with ANY IVAC bundle version.

  const WALK_TIMEOUT = cfg.walkTimeoutMs || 45000;
  const STEP_PAUSE = 1800;
  const walkStart = Date.now();
  let prevCaptures = 0;
  let idleRounds = 0;
  const MAX_IDLE = 8;

  let _homeIdleCount = 0;
  while (Date.now() - walkStart < WALK_TIMEOUT && idleRounds < MAX_IDLE) {
    if (idleRounds === 0) console.log(`  [step] path=${new globalThis.URL(page.url()).pathname} captures=${log.length}`);
    // 0. If stuck on home page, navigate directly to appointment flow
    try {
      const curPath = new globalThis.URL(page.url()).pathname;
      if (curPath === '/' && log.length >= 2) {
        _homeIdleCount++;
        if (_homeIdleCount >= 2) {
          const appointRoutes = ['/appointment/continue-payment', '/appointment/time-slot', '/appointment/file-upload', '/appointment/notice'];
          const tryRoute = appointRoutes[Math.min(_homeIdleCount - 2, appointRoutes.length - 1)];
          console.log(`  → navigating to ${tryRoute}`);
          await page.evaluate((r) => { window.history.pushState({}, '', r); window.dispatchEvent(new PopStateEvent('popstate')); }, tryRoute).catch(() => {});
          await page.waitForTimeout(500);
          const afterPath = new globalThis.URL(page.url()).pathname;
          if (afterPath === '/' || afterPath.includes('blocked') || afterPath.includes('declaration')) {
            await page.goto(HOST_ORIGIN + tryRoute, { waitUntil: 'domcontentloaded' }).catch(() => {});
          }
          await page.waitForTimeout(2000);
          continue;
        }
      } else if (!curPath.includes('appointment')) {
        _homeIdleCount = 0;
      }
    } catch (_) {}
    // 0b. Handle time-slot page: select date, slot, then continue
    try {
      const curPath2 = new globalThis.URL(page.url()).pathname;
      if (curPath2.includes('time-slot') && idleRounds >= 1 && idleRounds <= 5) {
        if (idleRounds === 1) {
          // Click calendar day 15
          const dayClicked = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            for (const b of btns) {
              if (b.textContent.trim() === '15' && b.className.includes('rounded-full')) {
                b.click(); return 'day-15-clicked';
              }
            }
            return 'no-day-15';
          }).catch(() => 'error');
          await page.waitForTimeout(2000);
        }
        if (idleRounds === 2) {
          // Find and click slot button (text contains "Your" and "provi")
          const slotResult = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const slotBtns = btns.filter(b => {
              const txt = b.textContent.trim().toLowerCase();
              return txt.includes('your') || txt.includes('provi') || txt.includes('slot') && txt.length > 15;
            });
            const info = slotBtns.map(b => b.textContent.trim().substring(0, 60));
            if (slotBtns.length > 0) { slotBtns[0].click(); return { clicked: true, info }; }
            return { clicked: false, info, allBtns: btns.filter(b => !/^[0-9]+$/.test(b.textContent.trim()) && b.textContent.trim().length > 3).map(b => b.textContent.trim().substring(0, 50)) };
          }).catch(() => ({ clicked: false }));
          await page.waitForTimeout(1000);
        }
        if (idleRounds === 3) {
          // Direct fetch approach: reserve slot + payment amount + payment initiate
          // all in one idle round (to avoid idleRounds reset from new log entries).
          const authToken = await page.evaluate(() => {
            try { return JSON.parse(localStorage.getItem('auth-storage') || '{}')?.state?.accessToken || 'MOCK.ACCESS.TOKEN'; }
            catch { return 'MOCK.ACCESS.TOKEN'; }
          }).catch(() => 'MOCK.ACCESS.TOKEN');

          // 1. Reserve slot
          const reserveResult = await page.evaluate(async (token) => {
            const entries = performance.getEntriesByType('resource').map(e => e.name);
            const apiEntry = entries.find(e => e.includes('/iams/api/') || e.includes('appointment'));
            const base = (apiEntry && apiEntry.match(/(https?:\/\/[^/]+)/)?.[1]) || location.origin;
            try {
              const r = await fetch(base + '/iams/api/v1/slots/54ea9f13-f1e2-4cea-9e18-f525e8242ccf/reserve-slot', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ c: 'MOCK_TURNSTILE_TOKEN', appointmentDate: '2026-09-15' }),
              });
              return { ok: true, status: r.status, data: JSON.stringify(await r.json()).substring(0, 200) };
            } catch (e) { return { ok: false, err: e.message }; }
          }, authToken).catch(e => ({ ok: false, err: e.message }));
          console.log('  → reserve-slot:', reserveResult.ok ? 'OK' : reserveResult.err);

          // 2. GET payment-amount
          const amountResult = await page.evaluate(async (token) => {
            const entries = performance.getEntriesByType('resource').map(e => e.name);
            const apiEntry = entries.find(e => e.includes('/iams/api/') || e.includes('appointment'));
            const base = (apiEntry && apiEntry.match(/(https?:\/\/[^/]+)/)?.[1]) || location.origin;
            try {
              const r = await fetch(base + '/iams/api/v1/file/payment-amount', {
                headers: { 'Authorization': 'Bearer ' + token },
              });
              return { ok: true, status: r.status, data: JSON.stringify(await r.json()).substring(0, 200) };
            } catch (e) { return { ok: false, err: e.message }; }
          }, authToken).catch(e => ({ ok: false, err: e.message }));
          console.log('  → payment-amount:', amountResult.ok ? 'OK' : amountResult.err);

          // 3. POST payment initiate (dgepay endpoint decoded from bundle)
          const payResult = await page.evaluate(async (token) => {
            const entries = performance.getEntriesByType('resource').map(e => e.name);
            const apiEntry = entries.find(e => e.includes('/iams/api/') || e.includes('appointment'));
            const base = (apiEntry && apiEntry.match(/(https?:\/\/[^/]+)/)?.[1]) || location.origin;
            try {
              const r = await fetch(base + '/iams/api/v1/payment/dcd59a95-d55e-41ad-b57c-60416e01617e/dg-epay/initiate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'x-token': 'MOCK_TURNSTILE_TOKEN' },
                body: JSON.stringify({ appointmentId: 'mock-appointment-id' }),
              });
              return { ok: true, status: r.status, data: JSON.stringify(await r.json()).substring(0, 200) };
            } catch (e) { return { ok: false, err: e.message }; }
          }, authToken).catch(e => ({ ok: false, err: e.message }));
          console.log('  → payment-initiate:', payResult.ok ? 'OK' : payResult.err);

          // All direct API calls done — break the walk loop
          console.log('  all steps complete');
          break;
        }
      }
    } catch (_) {}

    // 1. Close any modal/overlay popups
    await page.evaluate(() => {
      const overlays = document.querySelectorAll('[class*="modal"], [class*="overlay"], [class*="popup"], .fixed.inset-0, [role="dialog"]');
      for (const o of overlays) {
        const btn = o.querySelector('button[class*="close"], button[aria-label*="close" i], button:last-child, .close, [data-dismiss]');
        if (btn) try { btn.click(); } catch (_) {}
      }
    }).catch(() => {});

    // 2. Detect visible inputs and fill them with Playwright's .fill()
    // Playwright's fill() triggers real keyboard events that React picks up —
    // unlike nativeSetter which bypasses React's synthetic event system.
    const inputInfos = await page.evaluate(() => {
      const results = [];
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
      };
      document.querySelectorAll('input, textarea, select').forEach((inp, idx) => {
        if (!visible(inp)) return;
        if (inp.tagName === 'SELECT') {
          if (inp.selectedIndex <= 0 && inp.options.length > 1) {
            inp.value = inp.options[1].value;
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return;
        }
        if (inp.value && inp.value.length > 0) return;
        if (inp.type === 'hidden' || inp.type === 'checkbox' || inp.type === 'radio' || inp.type === 'file') return;
        const hint = (inp.type + ' ' + (inp.name || '') + ' ' + (inp.placeholder || '') + ' ' + (inp.getAttribute('aria-label') || '')).toLowerCase();
        // tag it with a unique data attr so Playwright can find it
        const tag = '__iflow_' + idx;
        inp.setAttribute('data-iflow', tag);
        results.push({ tag, hint, type: inp.type, inputMode: inp.inputMode, maxLength: inp.maxLength });
      });
      return results;
    }).catch(() => []);

    let filled = 0;
    for (const info of inputInfos) {
      const h = info.hint;
      let val = '';
      if (/phone|mobile|tel/.test(h) || info.type === 'tel') val = MOCK.phone;
      else if (/password|pass/.test(h) || info.type === 'password') val = MOCK.password;
      else if (/otp|verify|code|token/.test(h) || info.inputMode === 'numeric' || info.maxLength == 6 || info.maxLength == 4) val = MOCK.otp;
      else if (/email/.test(h) || info.type === 'email') val = 'mock@test.com';
      else if (/name|full.?name/.test(h)) val = 'MOCK USER';
      else if (/passport/.test(h)) val = 'AB1234567';
      else if (/date|dob|birth|expir/.test(h) || info.type === 'date') val = '2026-09-15';
      else val = MOCK.phone;

      if (val) {
        try {
          const loc = page.locator(`[data-iflow="${info.tag}"]`);
          await loc.focus({ timeout: 1000 });
          await loc.fill(val, { timeout: 2000 });
          filled++;
        } catch (_) {
          // fallback: type character by character (works even when fill() fails)
          try {
            await page.locator(`[data-iflow="${info.tag}"]`).click({ timeout: 1000 });
            await page.keyboard.type(val, { delay: 30 });
            filled++;
          } catch (_2) {}
        }
      }
    }

    // 2b. Explicit phone input fallback — the walker may miss it if type="text"
    try {
      const phoneEmpty = await page.evaluate(() => {
        const ph = document.querySelector('input[name="phone"], input[name="mobile"], input[placeholder*="01"]');
        return ph && (!ph.value || ph.value.length === 0);
      });
      if (phoneEmpty) {
        const phoneLocator = page.locator('input[name="phone"], input[name="mobile"], input[placeholder*="01"]').first();
        await phoneLocator.focus({ timeout: 1000 });
        await phoneLocator.fill(MOCK.phone, { timeout: 2000 });
        filled++;
      }
    } catch (_) {}

    // 3. Handle file upload inputs
    await page.evaluate(() => {
      const fileInputs = document.querySelectorAll('input[type="file"]');
      for (const fi of fileInputs) fi.removeAttribute('required');
    }).catch(() => {});
    const fileInputs = await page.locator('input[type="file"]').all().catch(() => []);
    for (const fi of fileInputs) {
      try {
        const buf = Buffer.from('%PDF-1.4 mock passport file content');
        const tmpFile = path.join(OUT, '_mock_passport.pdf');
        fs.writeFileSync(tmpFile, buf);
        await fi.setInputFiles(tmpFile, { timeout: 2000 });
        try { fs.unlinkSync(tmpFile); } catch (_) {}
      } catch (_) {}
    }

    await page.waitForTimeout(800);

    // 3b. Ensure Turnstile callback has fired + inject token into Zustand store
    await page.evaluate((token) => {
      // fire any pending turnstile callbacks
      if (window.turnstile && window.turnstile.render) {
        document.querySelectorAll('[data-callback]').forEach(el => {
          const cbName = el.getAttribute('data-callback');
          if (cbName && typeof window[cbName] === 'function') try { window[cbName](token); } catch(_){}
        });
      }
      // fill hidden turnstile/captcha response inputs
      document.querySelectorAll('input[name="cf-turnstile-response"], input[name="g-recaptcha-response"], input[name*="turnstile"], input[name*="captcha"]').forEach(i => {
        i.value = token;
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new Event('change', { bubbles: true }));
      });
      // Re-render Turnstile containers so callbacks fire with our token
      document.querySelectorAll('.cf-turnstile, [data-sitekey]').forEach(el => {
        const siteKey = el.getAttribute('data-sitekey') || 'mock';
        const cbName = el.getAttribute('data-callback');
        if (cbName && typeof window[cbName] === 'function') try { window[cbName](token); } catch(e){}
        if (window.turnstile) try { window.turnstile.render(el, { sitekey: siteKey, callback: (t) => {} }); } catch(e){}
      });
      // force-enable any disabled buttons
      document.querySelectorAll('button[disabled], input[type="submit"][disabled]').forEach(b => {
        b.disabled = false;
        b.removeAttribute('disabled');
      });
    }, MOCK.turnstile).catch(() => {});

    await page.waitForTimeout(300);

    // 4. Find and click the most likely submit/action button
    const clicked = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
      };
      const btns = [...document.querySelectorAll('button, [role="button"], input[type="submit"], a[href]')];
      const actionWords = /submit|sign.?in|log.?in|continue|verify|next|proceed|confirm|upload|pay|book|reserve|send|apply|okay|ok|start|enter|now|take|appointment/i;
      const skipWords = /cancel|back|close|dismiss|reset|clear|forgot|already|privacy|terms|cookie|sign.?up|create.?account|register|sign.?in.?then|log.?out|sign.?out|resend|check.?payment|profile|find.?answer/i;
      let best = null;
      let bestScore = -1;
      for (const b of btns) {
        if (!visible(b)) continue;
        const txt = (b.textContent || '').trim().toLowerCase();
        const ariaLabel = (b.getAttribute('aria-label') || '').toLowerCase();
        const combined = txt + ' ' + ariaLabel;
        if (skipWords.test(combined) && !actionWords.test(combined)) continue;
        let score = 0;
        if (b.type === 'submit') score += 5;
        if (actionWords.test(combined)) score += 10;
        if (b.classList.contains('primary') || /primary|submit|action/.test(b.className)) score += 3;
        if (/bg-blue|bg-green|bg-primary|btn-primary|btn-success|bg-\[/.test(b.className)) score += 2;
        if (txt.length > 0 && txt.length < 30) score += 1;
        // boost large prominent buttons (like "Sign In Now")
        const rect = b.getBoundingClientRect();
        if (rect.width > 200) score += 3;
        if (score > bestScore) { bestScore = score; best = b; }
      }
      if (!best) return '';
      best.disabled = false;
      best.removeAttribute('disabled');
      best.click();
      return (best.textContent || '').trim().substring(0, 40);
    }).catch(() => '');

    await page.waitForTimeout(STEP_PAUSE);
    writeFlow();

    // 5. Check progress
    if (log.length > prevCaptures) {
      idleRounds = 0;
      prevCaptures = log.length;
      console.log(`  ✓ step captured (${log.length} API calls so far)`);
    } else {
      const curUrl = page.url();
      if (clicked) console.log(`  … clicked "${clicked}" but no new API call  [page: ${curUrl}]`);
      else {
        const pageInfo = await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button, [role="button"], input[type="submit"], a[href]')];
          const visible = btns.filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
          return { total: btns.length, visible: visible.length, texts: visible.slice(0, 10).map(b => (b.textContent||'').trim().substring(0,40)), bodyLen: document.body?.innerHTML?.length || 0 };
        }).catch(() => ({}));
        const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 200) || '').catch(() => '');
        console.log(`  … nothing to click  [page: ${curUrl}]  btns:${pageInfo.visible}/${pageInfo.total} body:${pageInfo.bodyLen} text:"${bodyText.replace(/\n/g,' ').substring(0,120)}"`);
      }
      idleRounds++;
    }

    // If we've captured the payment initiate call, we're done
    if (log.some(e => /\/payment\/.*\/dg-epay\/initiate/.test(e.url) || /\/payment\/.*initiate/.test(e.url))) {
      console.log('  ✓ payment initiate captured — flow complete');
      break;
    }
  }

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
