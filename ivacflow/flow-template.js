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

  { name: 'VERIFY OTP', method: 'POST', epKey: 'verifySigninOtp', fallback: '/iams/api/v1/otp/verifySigninOtp',
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

  { name: 'RESERVE', method: 'POST', slotPath: true, fallback: '/iams/api/v1/slots/{id}/reserve-slot',
    headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer {{ivac:token}}', 'content-type': 'application/json', 'x-v-request-meta': '{{ivac:reqMeta}}' },
    body: { c: '{{ivac:captcha}}', appointmentDate: '{{ivac:appointmentDate}}' } },

  { name: 'PAYMENT AMOUNT', method: 'GET', epKey: 'paymentAmount', fallback: '/iams/api/v1/file/payment-amount',
    headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer {{ivac:token}}' }, body: null },

  { name: 'PAYMENT INITIATE', method: 'POST', initiatePath: true, fallback: '/iams/api/v1/payment/{uuid}/dg-epay/initiate',
    headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer {{ivac:token}}', 'content-type': 'application/json' },
    body: { reservationId: '{{ivac:reservationId}}', amount: '{{ivac:amount}}' } },
];

// Merge the extracted values into the template → concrete paths per step.
function buildTemplate(ex) {
  const eps = (ex && ex.endpoints) || {};
  const apiBase = (ex && ex.apiBase) || 'https://api.ivacbd.com/iams/api/v1';
  const prefix = '/iams/api/v1';
  const norm = (p) => p ? (p.startsWith('/iams') ? p : (prefix + p)) : '';
  return STEPS.map((s) => {
    let path = '', found = false;
    if (s.literal) { path = s.literal; found = true; }
    else if (s.slotPath) {
      const id = (ex && ex.slotId) || '{id}';
      path = prefix + '/slots/' + id + '/reserve-slot'; found = !!(ex && ex.slotId);
    } else if (s.initiatePath) {
      if (ex && ex.initiatePath) { path = norm(ex.initiatePath); found = true; }
      else { path = s.fallback; found = false; }
    } else if (s.epKey && eps[s.epKey]) { path = norm(eps[s.epKey]); found = true; }
    else { path = s.fallback; found = false; }
    return { name: s.name, method: s.method, path, found,
      headers: s.headers, body: s.body || null, note: s.note || '' };
  });
}

module.exports = { STEPS, buildTemplate };
