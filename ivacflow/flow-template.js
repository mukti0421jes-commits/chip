// flow-template.js — the request "ছাঁচ" (shape) the IVAC app sends, step by step.
// Header/body FIELD NAMES + placeholder mapping are fixed (this is how the site
// builds each call); the concrete endpoint VERSION / slotId / dgepay uuid are
// filled in live from the uploaded bundle (see dashboard-server.js).
//
// Placeholders {{ivac:...}} are the values the bot fills at runtime.
'use strict';

// each step: key into extracted.endpoints (epKey) OR a literal path; method;
// header field names; body field names (with placeholder values).
const STEPS = [
  { name: 'SIGN IN', method: 'POST', epKey: 'signin', fallback: '/iams/api/v1/auth/v3-sign-in',
    headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json', 'x-sec-navigation-state': '{{ivac:navState}}' },
    body: { phone: '{{ivac:phone}}', password: '{{ivac:password}}', c: '{{ivac:captcha}}' } },

  { name: 'VERIFY OTP', method: 'POST', epKey: 'verifyOtp', fallback: '/iams/api/v1/otp/verifySigninOtp',
    headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer {{ivac:token}}', 'content-type': 'application/json' },
    body: { requestId: '{{ivac:requestId}}', phone: '{{ivac:phone}}', code: '{{ivac:otp}}', otpChannel: 'PHONE' } },

  { name: 'FILE CONFIRMATION', method: 'GET', epKey: 'fileConfirmation', fallback: '/iams/api/v1/file/file-confirmation_and_slot_status',
    headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer {{ivac:token}}' }, body: null },

  { name: 'OVERVIEW', method: 'POST', epKey: 'overView', fallback: '/iams/api/v1/file/over-view',
    headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer {{ivac:token}}' }, body: null },

  { name: 'APPOINTMENT', method: 'POST', literal: '/iams/api/v1/appointment',
    headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer {{ivac:token}}' }, body: null },

  { name: 'PRIMARY UPLOAD', method: 'POST', epKey: 'uploadFile', fallback: '/iams/api/v1/file/upload_file',
    headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer {{ivac:token}}',
      'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary{{ivac:boundary}}',
      'x-sec-runtime-state': '{{ivac:runtimeState}}', 'x-token': '{{ivac:captcha}}' },
    note: 'multipart — files (ফাইল), isPrimary · boundary প্রতিবার নতুন', body: null },

  { name: 'MISSION LIST', method: 'GET', literal: '/iams/api/v1/high-commissions',
    headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer {{ivac:token}}' }, body: null },

  { name: 'CENTER LIST', method: 'GET', literal: '/iams/api/v1/ivac-centers/2',
    headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer {{ivac:token}}' }, body: null },

  { name: 'CONFIG', method: 'POST', epKey: 'bookingConfig', fallback: '/iams/api/v1/appointment/appointment-booking-config',
    headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer {{ivac:token}}', 'content-type': 'application/json' },
    body: { mission: '{{ivac:mission}}', ivacCenter: '{{ivac:ivacCenter}}' } },

  { name: 'AMOUNT', method: 'GET', epKey: 'getBookingConfig', fallback: '/iams/api/v1/appointment/get-booking-config',
    headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer {{ivac:token}}' }, body: null },

  { name: 'RESERVE', method: 'POST', slotPath: true, fallback: '/iams/api/v1/slots/reserve-slot',
    headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer {{ivac:token}}', 'content-type': 'application/json', 'x-v-request-meta': '{{ivac:reqMeta}}' },
    body: { c: '{{ivac:captcha}}', appointmentDate: '{{ivac:appointmentDate}}' } },

  { name: 'PAYMENT AMOUNT', method: 'GET', epKey: 'paymentAmount', fallback: '/iams/api/v1/file/payment-amount',
    headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer {{ivac:token}}' }, body: null },

  { name: 'PAYMENT INITIATE', method: 'POST', initiatePath: true, fallback: '/iams/api/v1/payment/dg-epay/initiate',
    headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer {{ivac:token}}', 'content-type': 'application/json' },
    body: { reservationId: '{{ivac:reservationId}}', amount: '{{ivac:amount}}' } },
];

// Merge the extracted values into the template → concrete paths per step.
//
// HEADERS: when the real intercepted request for a step is available (liveByPath),
// the template's headers are taken LIVE from that request — EVERY header the app
// actually sent (so nothing like x-device-id is ever missed) — with the
// session-specific ones swapped for {{ivac:...}} placeholders the bot fills. Only
// pure transport noise is dropped. The hard-coded STEPS[].headers are a fallback
// for a step whose request was not captured.
const DYN_HDR = {
  'authorization': 'Bearer {{ivac:token}}',
  'x-token': '{{ivac:captcha}}',
  'x-sec-navigation-state': '{{ivac:navState}}',
  'x-sec-runtime-state': '{{ivac:runtimeState}}',
  'x-v-request-meta': '{{ivac:reqMeta}}',
  'x-device-id': '{{ivac:deviceId}}',
};
const DROP_HDR = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'cookie', 'origin', 'referer']);
function templatizeHeaders(liveHeaders, fallback) {
  if (!liveHeaders || !Object.keys(liveHeaders).length) return fallback;
  const out = {};
  for (const k0 of Object.keys(liveHeaders)) {
    const k = k0.toLowerCase();
    if (DROP_HDR.has(k)) continue;
    if (DYN_HDR[k]) { out[k] = DYN_HDR[k]; continue; }
    if (k === 'content-type' && /multipart\/form-data/i.test(liveHeaders[k0])) {
      out[k] = 'multipart/form-data; boundary=----WebKitFormBoundary{{ivac:boundary}}'; continue;
    }
    out[k] = liveHeaders[k0];   // keep the real static value (accept, content-type, accept-language, priority, sec-*, user-agent, …)
  }
  return out;
}

function buildTemplate(ex, liveByPath) {
  const eps = (ex && ex.endpoints) || {};
  const apiBase = (ex && ex.apiBase) || 'https://api.ivacbd.com/iams/api/v1';
  const prefix = '/iams/api/v1';
  const norm = (p) => p ? (p.startsWith('/iams') ? p : (prefix + p)) : '';
  const L = liveByPath || {};
  const liveFor = (path, method) => {
    if (!path) return null;
    const cand = [path, path.replace(/\?.*$/, '')];
    for (const c of cand) { const hit = L[(method || '') + ' ' + c] || L[c]; if (hit) return hit; }
    // loose match: same path ignoring a trailing uuid/id segment difference
    for (const key of Object.keys(L)) { const kp = key.replace(/^[A-Z]+ /, ''); if (kp === path || kp.replace(/\?.*$/, '') === path) return L[key]; }
    return null;
  };
  return STEPS.map((s) => {
    let path = '', found = false;
    if (s.literal) { path = s.literal; found = true; }
    else if (s.slotPath) {
      // ONLY the real reserve endpoint the app actually fired and we intercepted
      // (exact separator + embedded slot uuid as the bundle built it). Nothing
      // static, nothing guessed.
      const real = (ex && ex.endpoints && ex.endpoints.reserveSlot) || '';
      if (real) { path = norm(real); found = true; }
      else { path = ''; found = false; }
    } else if (s.initiatePath) {
      // ONLY the real payment-initiate path the app actually fired.
      if (ex && ex.initiatePath) { path = norm(ex.initiatePath); found = true; }
      else { path = ''; found = false; }
    } else if (s.epKey && eps[s.epKey]) { path = norm(eps[s.epKey]); found = true; }
    // Not captured from a real request → report it empty + found:false, never a
    // hard-coded guess. (The `fallback` fields on STEPS are now unused.)
    else { path = ''; found = false; }
    const live = found ? liveFor(path, s.method) : null;
    const headers = templatizeHeaders(live && live.headers, s.headers);
    return { name: s.name, method: s.method, path, found,
      headers, headersSource: (live && live.headers) ? 'live-capture' : 'template',
      body: s.body || null, note: s.note || '' };
  });
}

module.exports = { STEPS, buildTemplate, templatizeHeaders };
