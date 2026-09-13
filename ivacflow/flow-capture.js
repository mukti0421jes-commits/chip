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
if (cfg.responsesFile) {
  try { RESPONSES = Object.assign({}, JSON.parse(fs.readFileSync(cfg.responsesFile, 'utf8')), RESPONSES); } catch (_) {}
}
const HEADLESS = cfg.headless !== false;
const RUN_MS = cfg.runMs || 20000;
const OUT = cfg.out || __dirname;

const isApi = (u) => /\/iams\/api\/|\/api\/v\d+\/|\/payment\/|\/slots\/|\/invoice\/|api\.ivacbd\.com/.test(u);
const isTurnstile = (u) => /challenges\.cloudflare\.com|turnstile/i.test(u);

// ── Extract slotId and dgepayUuid from any IVAC bundle ──
// Tries ALL array functions in the bundle (not just the first one).
function extractBundleIds(bundleSrc) {
  const ids = { slotId: '', dgepayUuid: '', paymentEndpoint: '' };

  // slotId: plaintext /slots/<uuid>/reserve-slot
  const slotMatch = bundleSrc.match(/\/slots\/([0-9a-f-]{30,40})\/reserve-slot/);
  if (slotMatch) ids.slotId = slotMatch[1];

  // Also try plaintext slotId in other patterns
  if (!ids.slotId) {
    const slotMatch2 = bundleSrc.match(/slotId['":\s]+["']([0-9a-f-]{30,40})["']/);
    if (slotMatch2) ids.slotId = slotMatch2[1];
  }

  // b64 decode helper
  function b64decode(str) {
    let t = '', n = '';
    for (let r, o, i = 0, a = 0; o = str.charAt(a++); ~o && (r = i % 4 ? 64 * r + o : o, i++ % 4) ? t += String.fromCharCode(255 & r >> (-2 * i & 6)) : 0)
      o = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/='.indexOf(o);
    for (let r = 0, o = t.length; r < o; r++) n += '%' + ('00' + t.charCodeAt(r).toString(16)).slice(-2);
    return decodeURIComponent(n);
  }

  // Find ALL array functions (pattern: function XX(){const e=[...]; return(XX=function(){return e})()})
  const arrFnRe = /function (\w{2,3})\(\)\{const e=\[("[^"]*"(?:,"[^"]*")*)\]\n?return\(\1=function\(\)\{return e\}\)\(\)\}/g;
  let afm;
  while ((afm = arrFnRe.exec(bundleSrc)) !== null) {
    const arrName = afm[1];
    let arr;
    try { arr = JSON.parse('[' + afm[2] + ']'); } catch(_) { continue; }
    const origArr = [...arr];

    // Try all rotations of this array
    for (let rot = 0; rot < arr.length; rot++) {
      try {
        const allDecoded = [];
        for (let i = 0; i < arr.length; i++) {
          try { allDecoded.push(b64decode(arr[i])); } catch(_) { allDecoded.push(''); }
        }
        const joined = allDecoded.join('|');
        // Look for payment UUID pattern
        const payMatch = joined.match(/payment\/([0-9a-f-]{30,40})\/dg-epay\/initiate/);
        if (payMatch) {
          ids.dgepayUuid = payMatch[1];
          ids.paymentEndpoint = '/payment/' + payMatch[1] + '/dg-epay/initiate';
          return ids;
        }
        // Also look for slotId if not yet found
        if (!ids.slotId) {
          const slotInArr = joined.match(/slots\/([0-9a-f-]{30,40})\/reserve/);
          if (slotInArr) ids.slotId = slotInArr[1];
        }
      } catch(_) {}
      arr.push(arr.shift());
    }
  }
  return ids;
}

// Auto-detect bundle file and extract IDs
let BUNDLE_IDS = { slotId: '', dgepayUuid: '', paymentEndpoint: '' };
const bundlePath = cfg.bundlePath || '';
if (bundlePath) {
  try {
    const src = fs.readFileSync(bundlePath, 'utf8');
    BUNDLE_IDS = extractBundleIds(src);
    console.log('📦 bundle IDs:', JSON.stringify(BUNDLE_IDS));
  } catch (_) {}
} else {
  try {
    const files = fs.readdirSync(__dirname);
    for (const f of files) {
      if (f.endsWith('.js') && !f.startsWith('flow') && !f.startsWith('extract') && !f.startsWith('dashboard') && !f.startsWith('_debug')) {
        const fp = path.join(__dirname, f);
        const stat = fs.statSync(fp);
        if (stat.size > 500000) {
          const src = fs.readFileSync(fp, 'utf8');
          if (src.includes('reserve-slot') && src.includes('appointment')) {
            BUNDLE_IDS = extractBundleIds(src);
            if (BUNDLE_IDS.slotId) {
              console.log('📦 auto-detected bundle:', f);
              console.log('📦 bundle IDs:', JSON.stringify(BUNDLE_IDS));
              break;
            }
          }
        }
      }
    }
  } catch (_) {}
}

// ── Flow state machine ──
// Tracks which API calls have been made to return context-appropriate mock responses
const flowState = {
  signedIn: false,
  otpVerified: false,
  fileUploaded: false,
  fileConfirmed: false,
  slotReserved: false,
  paymentInitiated: false,
  capturedSlotId: '',
  capturedDgepayUuid: '',
};

const SLOT_ID = cfg.slotId || BUNDLE_IDS.slotId || '';
const DGEPAY_UUID = cfg.dgepayUuid || BUNDLE_IDS.dgepayUuid || '';

const NOW_ISO = new Date().toISOString();
const FUTURE_DATE = '2026-09-15';
const FUTURE_DATES = ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'];

function mockBodyFor(url) {
  // User-supplied overrides first
  for (const key of Object.keys(RESPONSES)) if (url.includes(key)) return RESPONSES[key];

  // ── Auth sign-in (v2, v3, any version) ──
  if (/\/auth\/.*sign-?in/i.test(url)) {
    flowState.signedIn = true;
    return {
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
    };
  }

  // ── OTP verify ──
  if (/\/otp\/verify/i.test(url)) {
    flowState.otpVerified = true;
    return {
      successFlag: true, statusCode: 200, message: 'Success',
      data: {
        verified: true, requestId: 'mock-request-id', status: 'VERIFIED',
        accessToken: 'MOCK.ACCESS.TOKEN', refreshToken: 'MOCK.REFRESH.TOKEN',
        tokenType: 'Bearer', expiresIn: 3600, userId: 'mock-user-id',
        isRegistered: true, registered: true, isNewUser: false, newUser: false,
        profileCompleted: true, isProfileCompleted: true,
        user: { id: 'mock-user-id', phone: MOCK.phone, fullName: 'MOCK USER', email: 'mock@test.com', status: 'ACTIVE', verified: true, isRegistered: true, profileCompleted: true },
      },
    };
  }

  // ── OTP send/signup ──
  if (/\/otp\/(send|signup|resend)/i.test(url)) {
    return {
      successFlag: true, statusCode: 200, message: 'OTP sent',
      data: { requestId: 'mock-request-id', phone: MOCK.phone, otpChannel: 'PHONE', status: 'SENT' },
    };
  }

  // ── Auth signup ──
  if (/\/auth\/signup/i.test(url)) {
    return {
      successFlag: true, statusCode: 200, message: 'Success',
      data: { requestId: 'mock-request-id', phone: MOCK.phone, status: 'PENDING', otpChannel: 'PHONE' },
    };
  }

  // ── File upload ──
  if (/\/file\/upload/i.test(url)) {
    flowState.fileUploaded = true;
    return {
      successFlag: true, statusCode: 200, message: 'File uploaded',
      data: {
        fileId: 'mock-file-id', fileName: 'passport.pdf', fileType: 'PASSPORT',
        status: 'UPLOADED', isPrimary: true, uploadedAt: NOW_ISO,
        mimeType: 'application/pdf', size: 1024,
      },
    };
  }

  // ── File over-view / overview ──
  if (/\/file\/over-?view/i.test(url)) {
    flowState.fileUploaded = true;
    const applicant = {
      applicationId: 'APP-MOCK-001', fullName: 'MOCK USER', isPrimary: true,
      commissionId: 'COM-MOCK-001', webFileNumber: 'WEB-MOCK-001',
      visaType: 'TOURIST', passport: 'AB1234567', name: 'MOCK USER',
      email: 'mock@test.com', phone: '+8801700000000', contactNumber: '+8801700000000',
      dob: '1990-01-01', dateOfBirth: '1990-01-01',
      nidOrBr: '1234567890123', nid: '1234567890123',
      commissionName: 'Mock Commission', status: 'CONFIRMED',
      fileId: 'mock-file-id', id: 'mock-file-id',
      passportNumber: 'AB1234567', nationality: 'BANGLADESHI', gender: 'MALE',
      passportExpiry: '2030-01-01', primary: true,
    };
    return {
      successFlag: true, statusCode: 200, message: 'Success',
      data: [applicant],
    };
  }

  // ── File confirmation + slot status (STATE-DRIVEN) ──
  if (/\/file\/file-confirmation/i.test(url) && /slot.?status/i.test(url)) {
    if (flowState.fileUploaded || flowState.fileConfirmed) {
      return {
        successFlag: true, statusCode: 200, message: 'Success',
        data: {
          fileUploadConfirmed: true, fileConfirmed: true,
          slotOpen: true, paymentConfirm: false,
          uploadEnd: false,
          uploadFile: true,
          serverTime: NOW_ISO,
          commissionId: 1, ivacId: 1,
          appointmentId: 'mock-appointment-id',
          reservationId: 'mock-reservation-id',
          slot: { date: FUTURE_DATE, time: '09:00' },
          mission: { id: 1, name: 'Indian High Commission' },
          ivacCenter: { id: 1, name: 'IVAC Dhaka' },
        },
      };
    }
    // File NOT yet uploaded — tell app to show file upload step
    // App routing: if(uploadFile && !uploadEnd && !fileUploadConfirmed) → file upload page
    return {
      successFlag: true, statusCode: 200, message: 'Success',
      data: {
        fileUploadConfirmed: false,
        slotOpen: true, paymentConfirm: false,
        uploadEnd: false,
        uploadFile: true,
        serverTime: NOW_ISO,
      },
    };
  }

  // ── File confirmation (without slot_status) ──
  if (/\/file\/file-confirmation/i.test(url)) {
    flowState.fileConfirmed = true;
    return {
      successFlag: true, statusCode: 200, message: 'Confirmed',
      data: {
        fileId: 'mock-file-id', confirmed: true, slotAvailable: true,
        status: 'CONFIRMED', confirmationId: 'mock-confirmation-id',
        applicantName: 'MOCK USER', passportNumber: 'AB1234567',
        visaType: 'TOURIST', mission: 'Indian High Commission',
        ivacCenter: 'IVAC Dhaka', slot_status: 'AVAILABLE',
        fileUploadConfirmed: true, fileConfirmed: true,
      },
    };
  }

  // ── Payment amount ──
  if (/\/file\/payment-amount/i.test(url)) {
    return {
      successFlag: true, statusCode: 200, message: 'Success',
      data: {
        paymentAmount: 8200, amount: 8200, currency: 'BDT',
        fileId: 'mock-file-id',
        breakdown: [{ name: 'Visa Fee', amount: 8000 }, { name: 'Service Charge', amount: 200 }],
        totalAmount: 8200, paymentMethod: 'ONLINE',
      },
    };
  }

  // ── High commissions ──
  if (/\/high-commission/i.test(url)) {
    return {
      successFlag: true, statusCode: 200, message: 'Success',
      data: {
        id: 'COM-MOCK-001', name: 'Indian High Commission',
        commissionName: 'Dhaka', country: 'India', status: 'ACTIVE',
        high_commissions: [
          { id: 'COM-MOCK-001', name: 'Indian High Commission', missionName: 'Dhaka', commissionName: 'Dhaka', country: 'India', status: 'ACTIVE' },
        ],
        centers: [
          { id: 'CTR-MOCK-001', name: 'IVAC Dhaka', centerName: 'IVAC Dhaka (Jamuna Future Park)', address: 'Jamuna Future Park, Dhaka', status: 'ACTIVE', commissionId: 'COM-MOCK-001' },
        ],
      },
    };
  }

  // ── IVAC centers ──
  if (/\/ivac-center/i.test(url)) {
    return {
      successFlag: true, statusCode: 200, message: 'Success',
      data: [
        { id: 'CTR-MOCK-001', name: 'IVAC Dhaka', centerName: 'IVAC Dhaka', center: 'Dhaka', address: 'Jamuna Future Park, Dhaka', status: 'ACTIVE', commissionId: 'COM-MOCK-001' },
      ],
    };
  }

  // ── Visa types ──
  if (/\/visa.?type/i.test(url)) {
    return {
      successFlag: true, statusCode: 200, message: 'Success',
      data: [
        { id: 1, name: 'TOURIST', label: 'Tourist Visa', status: 'ACTIVE' },
        { id: 2, name: 'MEDICAL', label: 'Medical Visa', status: 'ACTIVE' },
        { id: 3, name: 'ENTRY', label: 'Entry Visa', status: 'ACTIVE' },
      ],
    };
  }

  // ── Booking config ──
  if (/\/appointment.*booking-config/i.test(url) || /\/get-booking-config/i.test(url)) {
    return {
      successFlag: true, statusCode: 200, message: 'Success',
      data: {
        amount: 8200, paymentAmount: 8200, currency: 'BDT',
        config: { maxDate: '2026-12-31', minDate: FUTURE_DATE },
        appointmentId: 'mock-appointment-id',
        appointmentDate: FUTURE_DATES,
        availableDates: FUTURE_DATES,
        slotOpen: true,
        serverTime: NOW_ISO,
        availableSlot: '09:00-11:00',
        slot: { id: 'mock-slot-id', date: FUTURE_DATE, time: '09:00', available: true },
        slots: [{ id: 'mock-slot-id', date: FUTURE_DATE, time: '09:00', available: true }],
        mission: { id: 1, name: 'Indian High Commission', commissionName: 'Dhaka' },
        ivacCenter: { id: 1, name: 'IVAC Dhaka', address: 'Dhaka' },
        fileUploadOpen: true, fileUploadStarted: true,
        uploadWindowOpen: true, uploadStart: true, uploadEnd: false,
      },
    };
  }

  // ── Reserve slot (capture slotId from URL) ──
  if (/\/slots\/.*\/reserve/i.test(url)) {
    const sm = url.match(/\/slots\/([0-9a-zA-Z_-]{20,40})\/reserve/);
    if (sm) flowState.capturedSlotId = sm[1];
    flowState.slotReserved = true;
    return {
      successFlag: true, statusCode: 200, message: 'Slot reserved',
      data: {
        reservationId: 'mock-reservation-id', reserveTtlSeconds: 660,
        appointmentDate: FUTURE_DATE, status: 'RESERVED',
        slotId: sm ? sm[1] : 'mock-slot-id', time: '09:00',
        expiresAt: new Date(Date.now() + 660000).toISOString(),
      },
    };
  }

  // ── Payment initiate (capture dgepayUuid from URL) ──
  if (/\/payment\/.*\/(dg-epay|ssl)\/initiate/i.test(url) || /\/payment\/.*\/initiate/i.test(url)) {
    const pm = url.match(/\/payment\/([0-9a-zA-Z_-]{20,40})\//);
    if (pm) flowState.capturedDgepayUuid = pm[1];
    flowState.paymentInitiated = true;
    return {
      successFlag: true, statusCode: 200, message: 'Payment initiated',
      data: {
        webview_url: 'https://mock.gateway/pay', paymentUrl: 'https://mock.gateway/pay',
        transactionId: 'mock-txn-id', amount: 8200, currency: 'BDT',
        reservationId: 'mock-reservation-id', status: 'INITIATED',
        redirectUrl: 'https://mock.gateway/pay', gatewayRef: 'mock-gw-ref',
      },
    };
  }

  // ── Profile ──
  if (/\/profile/i.test(url)) {
    return {
      successFlag: true, statusCode: 200, message: 'Success',
      data: { id: 'mock-user-id', phone: MOCK.phone, fullName: 'MOCK USER', email: 'mock@test.com', status: 'ACTIVE' },
    };
  }

  // ── Invoice ──
  if (/\/invoice/i.test(url)) {
    return {
      successFlag: true, statusCode: 200, message: 'Success',
      data: { invoiceId: 'mock-invoice-id', amount: 8200, status: 'PAID', downloadUrl: 'https://mock/invoice.pdf' },
    };
  }

  // ── Forgot password ──
  if (/\/forgot-password/i.test(url)) {
    return {
      successFlag: true, statusCode: 200, message: 'Success',
      data: { requestId: 'mock-request-id', phone: MOCK.phone, status: 'SENT' },
    };
  }

  // ── Generic fallback — return a rich response covering many possible fields ──
  return {
    successFlag: true, statusCode: 200, message: 'Success',
    data: {
      accessToken: 'MOCK.ACCESS.TOKEN', requestId: 'mock-request-id',
      verified: true, status: 'SUCCESS', isRegistered: true, isNewUser: false,
      profileCompleted: true, appointmentId: 'mock-appointment-id',
      fileId: 'mock-file-id', paymentAmount: 8200, amount: 8200,
      reservationId: 'mock-reservation-id', reserveTtlSeconds: 660,
      appointmentDate: FUTURE_DATES, webview_url: 'https://mock.gateway/pay',
      userId: 'mock-user-id', phone: MOCK.phone, fullName: 'MOCK USER',
      slotOpen: true, fileUploadOpen: true, uploadWindowOpen: true,
      fileUploadConfirmed: flowState.fileUploaded,
      data: [{ fullName: 'MOCK USER', primary: true, commissionName: 'Dhaka', ivacCenter: null }],
    },
  };
}


// Turnstile stub
function turnstileInitScript(token) {
  return `(() => {
    const T = ${JSON.stringify(token)};
    window.__mockTurnstile = T;
    const stub = {
      render: (el, opts) => {
        try { if (opts && opts.callback) setTimeout(() => opts.callback(T), 50); } catch(e){}
        return 'mock-widget';
      },
      getResponse: () => T,
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
    const origAppend = Element.prototype.appendChild;
    Element.prototype.appendChild = function(child) {
      if (child.tagName === 'SCRIPT' && child.src && /challenges\\\\.cloudflare|turnstile/i.test(child.src)) {
        const onloadMatch = child.src.match(/[?&]onload=([^&]+)/);
        const cbName = onloadMatch ? onloadMatch[1] : 'onloadTurnstileCallback';
        const fake = document.createElement('script');
        fake.textContent = '/* turnstile blocked */';
        const result = origAppend.call(this, fake);
        setTimeout(() => { if (typeof window[cbName] === 'function') try { window[cbName](); } catch(e){} }, 50);
        return result;
      }
      return origAppend.call(this, child);
    };
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
    const _fireTurnstileOnload = () => {
      if (typeof window.onloadTurnstileCallback === 'function') {
        try { window.onloadTurnstileCallback(); } catch(e){}
        return true;
      }
      return false;
    };
    if (!_fireTurnstileOnload()) {
      let _polls = 0;
      const _tmr = setInterval(() => {
        _polls++;
        if (_fireTurnstileOnload()) clearInterval(_tmr);
      }, 200);
      setTimeout(() => clearInterval(_tmr), 15000);
    }
  })();`;
}

const HOST_ORIGIN = cfg.hostOrigin || '';
const HOLD_OPEN_MS = cfg.holdOpenMs || 0;
const LIVE_CAPTURE = !!cfg.liveCapture;
const RESPONSES_OUT = cfg.responsesOut || path.join(OUT, 'responses.json');
const log = [];
const responsesMap = {};
function writeResponses() { try { fs.writeFileSync(RESPONSES_OUT, JSON.stringify(responsesMap, null, 2)); } catch (_) {} }

function extractFromCaptured(entries) {
  const extracted = { dgepayUuid: '', initiatePath: '', slotId: '', endpoints: {} };
  // Use runtime-captured IDs first, then from entries, then from static extraction
  if (flowState.capturedSlotId) extracted.slotId = flowState.capturedSlotId;
  if (flowState.capturedDgepayUuid) extracted.dgepayUuid = flowState.capturedDgepayUuid;
  for (const e of entries) {
    const urlPath = e.url.replace(/^https?:\/\/[^/]+/, '');
    if (!extracted.dgepayUuid) {
      const initMatch = /\/payment\/([0-9a-zA-Z_-]{20,40})\/dg-epay\/initiate/.exec(urlPath);
      if (initMatch) { extracted.dgepayUuid = initMatch[1]; extracted.initiatePath = initMatch[0]; }
    }
    if (!extracted.slotId) {
      const slotMatch = /\/slots\/([0-9a-f-]{20,40})\/reserve-slot/.exec(urlPath);
      if (slotMatch) extracted.slotId = slotMatch[1];
    }
    if (/\/payment\/.*\/dg-epay\/initiate/.test(urlPath)) extracted.endpoints.paymentInitiate = urlPath;
    if (/\/payment\/.*initiate/.test(urlPath)) extracted.endpoints.paymentInitiate = extracted.endpoints.paymentInitiate || urlPath;
    if (/\/auth\/.*sign-?in/i.test(urlPath)) extracted.endpoints.signin = urlPath;
    if (/\/otp\/verify/i.test(urlPath)) extracted.endpoints.verifyOtp = urlPath;
    if (/\/file\/upload/i.test(urlPath)) extracted.endpoints.uploadFile = urlPath;
    if (/\/file\/over-?view/i.test(urlPath)) extracted.endpoints.overView = urlPath;
    if (/\/file\/file-confirmation/i.test(urlPath)) extracted.endpoints.fileConfirmation = urlPath;
    if (/\/file\/payment-amount/i.test(urlPath)) extracted.endpoints.paymentAmount = urlPath;
    if (/\/appointment.*booking-config/i.test(urlPath)) extracted.endpoints.bookingConfig = urlPath;
    if (/\/slots\/.*reserve/i.test(urlPath)) extracted.endpoints.reserveSlot = urlPath;
  }
  // Fallback to static extraction
  if (!extracted.slotId && BUNDLE_IDS.slotId) extracted.slotId = BUNDLE_IDS.slotId;
  if (!extracted.dgepayUuid && BUNDLE_IDS.dgepayUuid) extracted.dgepayUuid = BUNDLE_IDS.dgepayUuid;
  if (extracted.dgepayUuid && !extracted.initiatePath) extracted.initiatePath = '/payment/' + extracted.dgepayUuid + '/dg-epay/initiate';
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

  const isAsset = (u) => /\.(css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|map)(\?|$)/i.test(u) || /fonts\.(googleapis|gstatic)\.com/.test(u);
  const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-token, x-sec-navigation-state, x-sec-runtime-state, x-v-request-meta, x-requested-with, accept',
    'access-control-max-age': '86400',
  };

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
    if (HOST_ORIGIN && url.startsWith(HOST_ORIGIN)) return route.continue();
    if (isTurnstile(url)) return route.fulfill({ status: 200, headers: { 'content-type': 'application/javascript' }, body: '/* turnstile blocked */' });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_HEADERS, body: '' });
    if (isApi(url)) {
      const mockResp = mockBodyFor(url);
      const shortUrl = url.replace(/^https?:\/\/[^/]+/, '');
      console.log(`  ✓ ${method} ${shortUrl}`);
      log.push({ time: new Date().toISOString(), method, url, headers: req.headers(), body: req.postData() || '' });
      writeFlow();
      if (LIVE_CAPTURE) return route.continue();
      return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'application/json' }, CORS_HEADERS), body: JSON.stringify(mockResp) });
    }
    if (isAsset(url) || /fonts\.|youtube\.com|ytimg\.com|googleapis\.com/i.test(url)) return route.fulfill({ status: 200, body: '' });
    return route.continue();
  });

  page.on('pageerror', e => { console.log('  page-error:', e.message.substring(0, 200)); if (e.stack) console.log('  stack:', e.stack.substring(0, 600)); });
  console.log('🌐 loading (headless):', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000);

  // ── Phase 0: Close modals/popups and navigate to Sign In ──
  for (let i = 0; i < 5; i++) {
    const closed = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        if (r.width === 0) continue;
        if (/absolute.*right|close/i.test(b.className) || b.getAttribute('aria-label')?.match(/close/i)) {
          b.click(); return true;
        }
      }
      const overlays = document.querySelectorAll('[class*="fixed"][class*="inset"], [class*="modal-overlay"], [class*="backdrop"]');
      if (overlays.length) { overlays[overlays.length - 1].click(); return true; }
      return false;
    }).catch(() => false);
    if (!closed) break;
    await page.waitForTimeout(500);
  }

  // Navigate to Sign In page
  const wentToSignin = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('a, button')];
    for (const el of candidates) {
      const txt = (el.textContent || '').trim();
      const href = el.getAttribute('href') || '';
      if (/^sign\s*in$/i.test(txt) || (href.includes('/signin') && !href.includes('/signup') && /sign\s*in/i.test(txt))) {
        el.click(); return txt;
      }
    }
    for (const el of candidates) {
      const href = el.getAttribute('href') || '';
      if (href.includes('/signin') && !href.includes('/signup')) { el.click(); return (el.textContent || '').trim(); }
    }
    return '';
  }).catch(() => '');
  if (wentToSignin) console.log(`  → navigated to Sign In ("${wentToSignin}")`);
  await page.waitForTimeout(2000);

  // ── Adaptive UI walker ──
  const WALK_TIMEOUT = cfg.walkTimeoutMs || 60000;
  const STEP_PAUSE = 2000;
  const walkStart = Date.now();
  let prevCaptures = 0;
  let idleRounds = 0;
  const MAX_IDLE = 12;

  let _homeIdleCount = 0;
  let _lastPath = '';
  let _samePathCount = 0;

  while (Date.now() - walkStart < WALK_TIMEOUT && idleRounds < MAX_IDLE) {
    const curPath = new globalThis.URL(page.url()).pathname;
    if (idleRounds === 0 || curPath !== _lastPath) {
      console.log(`  [step] path=${curPath} captures=${log.length}`);
    }

    // Track same-path stuck detection
    if (curPath === _lastPath) {
      _samePathCount++;
    } else {
      _samePathCount = 0;
      _lastPath = curPath;
    }

    // If stuck on home page after OTP, navigate to appointment flow
    if (curPath === '/' && log.length >= 2) {
      _homeIdleCount++;
      if (_homeIdleCount >= 2) {
        // Try progressively deeper routes
        const routes = ['/appointment/file-upload', '/appointment/notice', '/appointment/continue-payment', '/appointment/time-slot'];
        const tryRoute = routes[Math.min(_homeIdleCount - 2, routes.length - 1)];
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
    } else if (!curPath.includes('appointment') && curPath !== '/') {
      _homeIdleCount = 0;
    }

    // 1. Close any modal/overlay popups
    await page.evaluate(() => {
      const overlays = document.querySelectorAll('[class*="modal"], [class*="overlay"], [class*="popup"], .fixed.inset-0, [role="dialog"]');
      for (const o of overlays) {
        const btn = o.querySelector('button[class*="close"], button[aria-label*="close" i], button:last-child, .close, [data-dismiss]');
        if (btn) try { btn.click(); } catch (_) {}
      }
    }).catch(() => {});

    // 2. Handle SELECT dropdowns (mission, center, visa type)
    await page.evaluate(() => {
      document.querySelectorAll('select').forEach(sel => {
        const r = sel.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (sel.selectedIndex > 0) return; // already selected
        if (sel.options.length > 1) {
          sel.value = sel.options[1].value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          sel.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    }).catch(() => {});

    // 2b. Handle custom React dropdown/listbox (click to open, then select first option)
    await page.evaluate(() => {
      // Look for unselected custom selects (e.g., "Select Mission", "Select Center")
      const triggers = document.querySelectorAll('[role="combobox"], [role="listbox"], [class*="select"], [class*="dropdown"]');
      for (const t of triggers) {
        const txt = (t.textContent || '').trim().toLowerCase();
        if (/select|choose|pick/i.test(txt) && t.getBoundingClientRect().width > 0) {
          t.click();
        }
      }
    }).catch(() => {});
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const opts = document.querySelectorAll('[role="option"], [class*="option"]:not([class*="selected"]), li[class*="item"]');
      if (opts.length > 0) {
        // Click first non-placeholder option
        for (const o of opts) {
          const txt = (o.textContent || '').trim().toLowerCase();
          if (txt && !/select|choose|pick|--/i.test(txt)) {
            o.click();
            break;
          }
        }
      }
    }).catch(() => {});

    // 3. Detect visible inputs and fill them
    const inputInfos = await page.evaluate(() => {
      const results = [];
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
      };
      document.querySelectorAll('input, textarea, select').forEach((inp, idx) => {
        if (!visible(inp)) return;
        if (inp.tagName === 'SELECT') return; // handled above
        if (inp.value && inp.value.length > 0) return;
        if (inp.type === 'hidden' || inp.type === 'checkbox' || inp.type === 'radio' || inp.type === 'file') return;
        const hint = (inp.type + ' ' + (inp.name || '') + ' ' + (inp.placeholder || '') + ' ' + (inp.getAttribute('aria-label') || '')).toLowerCase();
        const tag = '__iflow_' + idx;
        inp.setAttribute('data-iflow', tag);
        results.push({ tag, hint, type: inp.type, inputMode: inp.inputMode, maxLength: inp.maxLength });
      });
      return results;
    }).catch(() => []);

    for (const info of inputInfos) {
      const h = info.hint;
      let val = '';
      if (/phone|mobile|tel/.test(h) || info.type === 'tel') val = MOCK.phone;
      else if (/password|pass/.test(h) || info.type === 'password') val = MOCK.password;
      else if (/otp|verify|code|token/.test(h) || info.inputMode === 'numeric' || info.maxLength == 6 || info.maxLength == 4) val = MOCK.otp;
      else if (/email/.test(h) || info.type === 'email') val = 'mock@test.com';
      else if (/name|full.?name/.test(h)) val = 'MOCK USER';
      else if (/passport/.test(h)) val = 'AB1234567';
      else if (/date|dob|birth|expir/.test(h) || info.type === 'date') val = FUTURE_DATE;
      else val = MOCK.phone;

      if (val) {
        try {
          const loc = page.locator(`[data-iflow="${info.tag}"]`);
          await loc.focus({ timeout: 1000 });
          await loc.fill(val, { timeout: 2000 });
        } catch (_) {
          try {
            await page.locator(`[data-iflow="${info.tag}"]`).click({ timeout: 1000 });
            await page.keyboard.type(val, { delay: 30 });
          } catch (_2) {}
        }
      }
    }

    // 3b. Phone input fallback
    try {
      const phoneEmpty = await page.evaluate(() => {
        const ph = document.querySelector('input[name="phone"], input[name="mobile"], input[placeholder*="01"]');
        return ph && (!ph.value || ph.value.length === 0);
      });
      if (phoneEmpty) {
        const phoneLocator = page.locator('input[name="phone"], input[name="mobile"], input[placeholder*="01"]').first();
        await phoneLocator.focus({ timeout: 1000 });
        await phoneLocator.fill(MOCK.phone, { timeout: 2000 });
      }
    } catch (_) {}

    // 4. Handle file upload inputs
    await page.evaluate(() => {
      document.querySelectorAll('input[type="file"]').forEach(fi => fi.removeAttribute('required'));
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

    await page.waitForTimeout(500);

    // 5. Handle checkboxes (terms, declarations)
    await page.evaluate(() => {
      document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        if (!cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          cb.dispatchEvent(new Event('input', { bubbles: true }));
          // Also click the label if any
          const label = cb.closest('label') || document.querySelector(`label[for="${cb.id}"]`);
          if (label) label.click();
        }
      });
    }).catch(() => {});

    // 6. Ensure Turnstile + enable disabled buttons
    await page.evaluate((token) => {
      if (window.turnstile) {
        document.querySelectorAll('[data-callback]').forEach(el => {
          const cbName = el.getAttribute('data-callback');
          if (cbName && typeof window[cbName] === 'function') try { window[cbName](token); } catch(_){}
        });
      }
      document.querySelectorAll('input[name="cf-turnstile-response"], input[name="g-recaptcha-response"], input[name*="turnstile"], input[name*="captcha"]').forEach(i => {
        i.value = token;
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new Event('change', { bubbles: true }));
      });
      document.querySelectorAll('.cf-turnstile, [data-sitekey]').forEach(el => {
        const cbName = el.getAttribute('data-callback');
        if (cbName && typeof window[cbName] === 'function') try { window[cbName](token); } catch(e){}
      });
      document.querySelectorAll('button[disabled], input[type="submit"][disabled]').forEach(b => {
        b.disabled = false;
        b.removeAttribute('disabled');
      });
    }, MOCK.turnstile).catch(() => {});

    await page.waitForTimeout(300);

    // 6b. Handle mission/center page dropdowns
    if (curPath.includes('mission') && _samePathCount >= 0) {
      // Ensure commissionId is set in ALL Zustand persist stores in localStorage
      // Then reload the page so the store rehydrates with the value
      const didInject = await page.evaluate(() => {
        const keys = Object.keys(localStorage);
        let injected = false;
        for (const key of keys) {
          try {
            const val = JSON.parse(localStorage.getItem(key));
            if (val && val.state && 'commissionId' in val.state && !val.state.commissionId) {
              val.state.commissionId = 'COM-MOCK-001';
              localStorage.setItem(key, JSON.stringify(val));
              injected = true;
            }
          } catch(_) {}
        }
        return injected;
      }).catch(() => false);
      if (didInject) {
        console.log('  → injected commissionId into store, reloading...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }
    if (curPath.includes('mission') && _samePathCount >= 1) {
      // Try multiple approaches to select dropdowns
      const ddResult = await page.evaluate(() => {
        let actions = [];
        // Approach 1: Find all divs/buttons that look like dropdown triggers
        const allEls = [...document.querySelectorAll('div, button, span')];
        for (const el of allEls) {
          const txt = (el.textContent || '').trim().toLowerCase();
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 20 || r.height > 60) continue;
          // Look for "select" placeholder text
          if (/^select\b|^choose\b|^pick\b/i.test(txt)) {
            el.click();
            actions.push('clicked-trigger:' + txt.substring(0, 30));
            break;
          }
        }
        return actions;
      }).catch(() => []);
      if (ddResult.length > 0) {
        console.log('  → mission dropdown:', ddResult.join(', '));
        await page.waitForTimeout(800);
        // Now click the first visible option in any dropdown/listbox
        await page.evaluate(() => {
          const opts = [...document.querySelectorAll('[role="option"], li, div[class*="option"]')];
          for (const o of opts) {
            const txt = (o.textContent || '').trim();
            const r = o.getBoundingClientRect();
            if (r.width > 50 && r.height > 10 && txt.length > 2 && !/select|choose|pick/i.test(txt)) {
              o.click();
              return;
            }
          }
        }).catch(() => {});
        await page.waitForTimeout(500);
        // Try to find and click a second dropdown (center)
        await page.evaluate(() => {
          const allEls = [...document.querySelectorAll('div, button, span')];
          for (const el of allEls) {
            const txt = (el.textContent || '').trim().toLowerCase();
            const r = el.getBoundingClientRect();
            if (r.width < 100 || r.height < 20 || r.height > 60) continue;
            if (/^select\b|^choose\b|^pick\b/i.test(txt)) {
              el.click();
              break;
            }
          }
        }).catch(() => {});
        await page.waitForTimeout(500);
        await page.evaluate(() => {
          const opts = [...document.querySelectorAll('[role="option"], li, div[class*="option"]')];
          for (const o of opts) {
            const txt = (o.textContent || '').trim();
            const r = o.getBoundingClientRect();
            if (r.width > 50 && r.height > 10 && txt.length > 2 && !/select|choose|pick/i.test(txt)) {
              o.click();
              return;
            }
          }
        }).catch(() => {});
        await page.waitForTimeout(500);
      }
      // Approach 2: If dropdowns won't populate, call booking-config via direct fetch
      // Use the absolute API base URL that the bundle uses (appointment.ivacbd.com)
      if (_samePathCount >= 2) {
        console.log('  → mission dropdowns empty, calling booking-config directly...');
        await page.evaluate(async () => {
          try {
            // Find the API base URL from any XHR that was made
            const apiBase = performance.getEntriesByType('resource')
              .map(r => r.name)
              .find(n => /ivacbd\.com.*\/iams\/api/i.test(n) || /\/iams\/api/i.test(n));
            let base = '';
            if (apiBase) {
              const m = apiBase.match(/^(https?:\/\/[^/]+\/iams\/api\/v\d+)/);
              if (m) base = m[1];
            }
            if (!base) base = 'https://appointment.ivacbd.com/iams/api/v1';
            const authStore = JSON.parse(localStorage.getItem('auth-storage') || '{}');
            const token = authStore?.state?.accessToken || 'MOCK.ACCESS.TOKEN';
            await fetch(base + '/appointment/appointment-booking-config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
              body: JSON.stringify({ mission: 'COM-MOCK-001', ivacCenter: 'CTR-MOCK-001' }),
            });
          } catch(_) {}
        }).catch(() => {});
        await page.waitForTimeout(500);
        // Update Zustand store with mission/center selection before navigating
        await page.evaluate(() => {
          const keys = Object.keys(localStorage);
          for (const key of keys) {
            try {
              const val = JSON.parse(localStorage.getItem(key));
              if (val && val.state && 'appointmentInfo' in val.state) {
                val.state.appointmentInfo = Object.assign(val.state.appointmentInfo || {}, {
                  mission: 'COM-MOCK-001', missionName: 'Indian High Commission',
                  ivacCenter: 'CTR-MOCK-001', centerName: 'IVAC Dhaka',
                  commissionId: 'COM-MOCK-001',
                });
                val.state.currentStep = 'time-slot';
                localStorage.setItem(key, JSON.stringify(val));
              }
            } catch(_) {}
          }
        }).catch(() => {});
        // Reload to rehydrate then navigate
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1000);
        await page.evaluate(() => {
          try {
            window.history.pushState({ startTimer: true }, '', '/appointment/time-slot');
            window.dispatchEvent(new PopStateEvent('popstate'));
          } catch(_) {}
        }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    }

    // 7. Handle time-slot page: click calendar day, then slot
    if (curPath.includes('time-slot') && _samePathCount >= 1) {
      // Click a day in the calendar
      const dayClicked = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        for (const b of btns) {
          const txt = b.textContent.trim();
          if (/^1[5-9]$|^2[0-5]$/.test(txt) && b.getBoundingClientRect().width > 0) {
            const cls = b.className || '';
            if (cls.includes('rounded') || cls.includes('day') || cls.includes('calendar') || b.closest('[class*="calendar"]')) {
              b.click(); return txt;
            }
          }
        }
        // fallback: click any numbered button that looks like a date
        for (const b of btns) {
          const txt = b.textContent.trim();
          if (/^[1-2][0-9]$/.test(txt) && b.getBoundingClientRect().width > 20) {
            b.click(); return txt;
          }
        }
        return '';
      }).catch(() => '');
      if (dayClicked) console.log(`  → clicked day ${dayClicked}`);
      await page.waitForTimeout(1500);

      // Click slot button if visible
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const slotBtns = btns.filter(b => {
          const txt = b.textContent.trim().toLowerCase();
          return (txt.includes('your') || txt.includes('provi') || txt.includes('slot') || txt.includes('09:00') || txt.includes('11:00')) && txt.length > 5;
        });
        if (slotBtns.length > 0) slotBtns[0].click();
      }).catch(() => {});
      await page.waitForTimeout(500);
    }

    // 8. Find and click the most likely submit/action button
    const clicked = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
      };
      const btns = [...document.querySelectorAll('button, [role="button"], input[type="submit"], a[href]')];
      const actionWords = /submit|sign.?in|log.?in|continue|verify|next|proceed|confirm|upload|pay|book|reserve|send|apply|okay|ok|start|enter|now|take|appointment|save|select|choose/i;
      const skipWords = /cancel|back|close|dismiss|reset|clear|forgot|already|privacy|terms|cookie|sign.?up|create.?account|register|sign.?in.?then|log.?out|sign.?out|resend|check.?payment|profile|find.?answer|download/i;
      let best = null;
      let bestScore = -1;
      for (const b of btns) {
        if (!visible(b)) continue;
        const txt = (b.textContent || '').trim().toLowerCase();
        const ariaLabel = (b.getAttribute('aria-label') || '').toLowerCase();
        const combined = txt + ' ' + ariaLabel;
        if (skipWords.test(combined) && !actionWords.test(combined)) continue;
        // Skip calendar day buttons
        if (/^[0-9]{1,2}$/.test(txt)) continue;
        let score = 0;
        if (b.type === 'submit') score += 5;
        if (actionWords.test(combined)) score += 10;
        if (b.classList.contains('primary') || /primary|submit|action/.test(b.className)) score += 3;
        if (/bg-blue|bg-green|bg-primary|btn-primary|btn-success|bg-\[/.test(b.className)) score += 2;
        if (txt.length > 0 && txt.length < 30) score += 1;
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

    // 9. Check progress
    if (log.length > prevCaptures) {
      idleRounds = 0;
      prevCaptures = log.length;
      console.log(`  ✓ step captured (${log.length} API calls so far)`);
    } else {
      if (clicked) console.log(`  … clicked "${clicked}" but no new API call  [page: ${page.url()}]`);
      else {
        const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 200) || '').catch(() => '');
        console.log(`  … nothing to click  [${curPath}]  text:"${bodyText.replace(/\n/g,' ').substring(0,100)}"`);
      }
      idleRounds++;
    }

    // If payment initiate captured, we're done
    if (log.some(e => /\/payment\/.*\/initiate/.test(e.url))) {
      console.log('  ✓ payment initiate captured — flow complete');
      break;
    }

    // 6c. Handle time-slot page — click available dates and slots
    if (curPath.includes('time-slot') && _samePathCount >= 1 && _samePathCount <= 3) {
      // Click calendar date buttons (day numbers)
      const dateClicked = await page.evaluate(() => {
        // Find calendar date cells — typically buttons with just a number
        const btns = [...document.querySelectorAll('button, td, div[role="gridcell"]')];
        for (const b of btns) {
          const txt = (b.textContent || '').trim();
          const r = b.getBoundingClientRect();
          if (/^\d{1,2}$/.test(txt) && r.width > 20 && r.height > 20 && !b.disabled) {
            const num = parseInt(txt);
            if (num >= 15 && num <= 28) { // Pick a date in the middle/end of month
              b.click();
              return txt;
            }
          }
        }
        // If no specific date, click any available date
        for (const b of btns) {
          const txt = (b.textContent || '').trim();
          const r = b.getBoundingClientRect();
          if (/^\d{1,2}$/.test(txt) && r.width > 20 && r.height > 20 && !b.disabled) {
            b.click();
            return txt;
          }
        }
        return null;
      }).catch(() => null);
      if (dateClicked) {
        console.log('  → clicked date:', dateClicked);
        await page.waitForTimeout(1000);
      }
      // Click time slot buttons
      const slotClicked = await page.evaluate(() => {
        const all = [...document.querySelectorAll('button, div[role="button"], label')];
        for (const el of all) {
          const txt = (el.textContent || '').trim().toLowerCase();
          const r = el.getBoundingClientRect();
          if (r.width > 50 && r.height > 20 && /\d{1,2}:\d{2}|am|pm|morning|afternoon|slot/i.test(txt) && !el.disabled) {
            el.click();
            return txt.substring(0, 30);
          }
        }
        return null;
      }).catch(() => null);
      if (slotClicked) {
        console.log('  → clicked slot:', slotClicked);
        await page.waitForTimeout(500);
      }
    }

    // If stuck too long on time-slot, attempt direct API calls using absolute URLs
    if (idleRounds >= 6 && curPath.includes('time-slot')) {
      console.log('  → stuck on time-slot, attempting direct API calls...');
      // Discover the API base URL from intercepted requests
      const apiBase = await page.evaluate(() => {
        const entries = performance.getEntriesByType('resource');
        for (const e of entries) {
          const m = e.name.match(/^(https?:\/\/[^/]+\/iams\/api\/v\d+)/);
          if (m) return m[1];
        }
        return null;
      }).catch(() => null) || 'https://appointment.ivacbd.com/iams/api/v1';

      const authToken = await page.evaluate(() => {
        try { return JSON.parse(localStorage.getItem('auth-storage') || '{}')?.state?.accessToken || 'MOCK.ACCESS.TOKEN'; }
        catch { return 'MOCK.ACCESS.TOKEN'; }
      }).catch(() => 'MOCK.ACCESS.TOKEN');

      const slotId = SLOT_ID || flowState.capturedSlotId || 'mock-slot-id';

      // Reserve slot
      await page.evaluate(async (args) => {
        try { await fetch(args.base + '/slots/' + args.slotId + '/reserve-slot', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + args.token }, body: JSON.stringify({ c: 'MOCK_TURNSTILE_TOKEN', appointmentDate: '2026-09-15' }) }); } catch(_) {}
      }, { base: apiBase, token: authToken, slotId }).catch(() => {});
      console.log('  → reserve-slot (direct)');

      // Payment amount
      await page.evaluate(async (args) => {
        try { await fetch(args.base + '/file/payment-amount', { headers: { 'Authorization': 'Bearer ' + args.token } }); } catch(_) {}
      }, { base: apiBase, token: authToken }).catch(() => {});
      console.log('  → payment-amount (direct)');

      // Payment initiate
      let payEndpoint = BUNDLE_IDS.paymentEndpoint || (DGEPAY_UUID ? `/payment/${DGEPAY_UUID}/dg-epay/initiate` : '');
      if (!payEndpoint) {
        const runtimeEndpoint = await page.evaluate(() => {
          try {
            for (const s of document.querySelectorAll('script:not([src])')) {
              const txt = s.textContent || '';
              const m = txt.match(/payment\/([0-9a-f-]{30,40})\/dg-epay\/initiate/);
              if (m) return '/payment/' + m[1] + '/dg-epay/initiate';
            }
          } catch(_) {}
          return null;
        }).catch(() => null);
        if (runtimeEndpoint) payEndpoint = runtimeEndpoint;
      }
      if (!payEndpoint) payEndpoint = '/payment/mock-uuid/dg-epay/initiate';

      await page.evaluate(async (args) => {
        try { await fetch(args.base + args.payEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + args.token, 'x-token': 'MOCK_TURNSTILE_TOKEN' }, body: JSON.stringify({ appointmentId: 'mock-appointment-id' }) }); } catch(_) {}
      }, { base: apiBase, token: authToken, payEndpoint }).catch(() => {});
      console.log('  → payment-initiate (direct)');
      console.log('  all steps complete (direct fallback)');
      break;
    }
  }

  writeFlow();

  if (HOLD_OPEN_MS > 0) {
    console.log(`🖐 manual mode — window open for ${Math.round(HOLD_OPEN_MS / 1000)}s`);
    let closed = false; page.on('close', () => { closed = true; });
    const t0 = Date.now();
    while (!closed && Date.now() - t0 < HOLD_OPEN_MS) { await page.waitForTimeout(1000).catch(() => { closed = true; }); }
    writeFlow();
  }

  console.log(`\n💾 captured ${log.length} API call(s) → ${path.join(OUT, 'flow.json')}`);
  const captured = extractFromCaptured(log);
  console.log('📋 extracted:', JSON.stringify(captured, null, 2));
  await browser.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('flow-capture error:', e); process.exit(1); });

module.exports = { mockBodyFor, turnstileInitScript, isApi };
