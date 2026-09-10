// ivac-capture — live IVAC config capture via a real (headed) browser.
//
// It opens the real appointment.ivacbd.com in a Chromium window; YOU log in,
// pass the OTP and the Turnstile captcha, and click through to the payment
// step exactly as a normal user. Meanwhile this tool records every API request
// the site makes — method, URL, headers, and body — and, when you close the
// window (or Ctrl+C), writes two files next to it:
//
//   capture.json  — the full, raw request/response log (everything, verbatim)
//   values.json   — the decoded values the bot needs, pulled straight from the
//                    real requests: endpoint versions, reserve slot id, dg-epay
//                    uuid + initiate path, the cipher `c` samples, x-token and
//                    the x-sec-* headers.
//
// Nothing is decoded or guessed here — these are the ACTUAL requests the browser
// sent, so the obfuscation is irrelevant. Paste values.json's ids into the bot's
// manual overrides (or just read them) whenever IVAC redeploys.
//
// Usage:
//   npm install
//   npm run capture           # opens a browser window; do the flow, then close it
//
// Options (env):
//   URL=https://appointment.ivacbd.com/   start page (default)
//   HEADLESS=1                            run headless (no captcha/login help — capture only)
//   OUT=./                                output directory (default: this folder)

'use strict';

const fs = require('fs');
const path = require('path');

const START_URL = process.env.URL || 'https://appointment.ivacbd.com/';
const HEADLESS = process.env.HEADLESS === '1';
const OUT_DIR = process.env.OUT || __dirname;

// Only record calls to the IVAC API (skip images, fonts, analytics, etc.).
function isApi(url) {
  return /api\.ivacbd\.com|\/iams\/api\/|\/payment\/|\/slots\/|\/invoice\//.test(url);
}

const log = []; // one entry per API request (with its response, filled in later)
const byReqId = new Map();

function firstMatch(re) {
  for (const e of log) {
    const m = re.exec(e.url);
    if (m) return m;
  }
  return null;
}

function firstBodyField(urlRe, field) {
  for (const e of log) {
    if (!urlRe.test(e.url) || !e.body) continue;
    try {
      const j = JSON.parse(e.body);
      if (j && typeof j[field] === 'string' && j[field]) return j[field];
    } catch (_) {}
  }
  return '';
}

function firstHeader(urlRe, name) {
  for (const e of log) {
    if (urlRe.test(e.url) && e.headers && e.headers[name]) return e.headers[name];
  }
  return '';
}

function buildValues() {
  const v = {
    capturedAt: new Date().toISOString(),
    apiBase: (firstMatch(/^(https?:\/\/[^/]+\/iams\/api\/v\d+)/) || [])[1] || '',
    endpoints: {},
    slotId: (firstMatch(/\/slots\/([^/]+)\/reserve-slot/) || [])[1] || '',
    dgepayUuid: (firstMatch(/\/payment\/([^/]+)\/dg-epay\/initiate/) || [])[1] || '',
    initiatePath: (firstMatch(/(\/payment\/[^/]+\/(?:dg-epay\/)?initiate)/) || [])[1] || '',
    // cipher output the browser actually sent (encrypted captcha token in body `c`)
    cipher: {
      signin_c: firstBodyField(/\/auth\/[^/]*sign-?in/i, 'c'),
      reserve_c: firstBodyField(/\/slots\/[^/]+\/reserve-slot/, 'c'),
    },
    headers: {
      xToken_signin: firstHeader(/\/auth\/[^/]*sign-?in/i, 'x-token'),
      xToken_upload: firstHeader(/\/file\/upload_file/i, 'x-token'),
      xToken_initiate: firstHeader(/\/payment\/[^/]+\/(?:dg-epay\/)?initiate/, 'x-token'),
      xSecNavigationState: firstHeader(/\/auth\/[^/]*sign-?in/i, 'x-sec-navigation-state'),
      xSecRuntimeState: firstHeader(/\/file\/upload_file/i, 'x-sec-runtime-state'),
      xVRequestMeta: firstHeader(/\/slots\/[^/]+\/reserve-slot/, 'x-v-request-meta'),
    },
  };
  // endpoint version literals (whatever the current build uses)
  const eps = [
    ['signin', /(\/auth\/[a-z0-9-]*sign-?in[a-z0-9-]*)/i],
    ['verifySigninOtp', /(\/otp\/verifySigninOtp[a-z0-9_-]*)/i],
    ['uploadFile', /(\/file\/upload_file[a-z0-9_-]*)/i],
    ['overView', /(\/file\/over-view[a-z0-9_-]*)/i],
    ['getBookingConfig', /(\/appointment\/get-booking-config[a-z0-9_-]*)/i],
    ['bookingConfig', /(\/appointment\/appointment-booking-config[a-z0-9_-]*)/i],
    ['fileConfirmation', /(\/file\/file-confirmation[a-z0-9_-]*)/i],
  ];
  for (const [name, re] of eps) {
    const m = firstMatch(re);
    if (m) v.endpoints[name] = m[1];
  }
  return v;
}

function writeOut() {
  const cap = path.join(OUT_DIR, 'capture.json');
  const val = path.join(OUT_DIR, 'values.json');
  fs.writeFileSync(cap, JSON.stringify(log, null, 2));
  fs.writeFileSync(val, JSON.stringify(buildValues(), null, 2));
  console.log(`\n💾 saved ${log.length} API calls → ${cap}`);
  console.log(`💡 extracted values → ${val}`);
}

// exported for the offline self-test (test.js); the browser run below only starts
// when this file is executed directly.
module.exports = { buildValues, _log: log };

if (require.main !== module) return;

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('request', (req) => {
    const url = req.url();
    if (!isApi(url)) return;
    const entry = {
      time: new Date().toISOString(),
      method: req.method(),
      url,
      headers: req.headers(),
      body: req.postData() || '',
      status: null,
      response: '',
    };
    log.push(entry);
    byReqId.set(req, entry);
    console.log('▶', entry.method, url);
  });

  page.on('response', async (res) => {
    const entry = byReqId.get(res.request());
    if (!entry) return;
    entry.status = res.status();
    try {
      const t = await res.text();
      entry.response = t.length > 4000 ? t.slice(0, 4000) + '…' : t;
    } catch (_) {}
  });

  console.log(`\n🌐 opening ${START_URL}`);
  console.log('   → log in, pass OTP + captcha, go through to the payment step.');
  console.log('   → then just CLOSE the browser window (or press Ctrl+C) to save.\n');

  await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // save on Ctrl+C
  process.on('SIGINT', () => { try { writeOut(); } catch (_) {} process.exit(0); });
  // save when the browser/page is closed
  const done = new Promise((resolve) => {
    page.on('close', resolve);
    context.on('close', resolve);
    browser.on('disconnected', resolve);
  });
  await done;
  writeOut();
  await browser.close().catch(() => {});
  process.exit(0);
})().catch((e) => {
  console.error('capture error:', e);
  try { writeOut(); } catch (_) {}
  process.exit(1);
});
