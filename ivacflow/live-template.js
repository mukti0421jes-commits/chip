// live-template.js — build the request template PURELY from the live walk.
//
// NO request shape is assumed. Step list, order, method, path, headers AND body
// are all read from exactly what the loaded bundle fired during a mock-data walk
// (flow.json `calls`). A future bundle that renames endpoints, changes headers,
// renames/adds body fields, reorders or adds steps is captured automatically —
// this file does not change.
//
// Per-run values become {{ivac:*}} placeholders, decided by VALUE, not field name:
//   1. values we fed the walk as mock input      → {{ivac:<mockName>}}
//   2. values an earlier response produced (chained) → {{ivac:<liveKey>}}
//   3. high-entropy tokens / uuids / jwt (captcha, auth, device, meta) → {{ivac:<liveKey>}}
//   otherwise the literal is kept (true constants like otpChannel:"PHONE").
// Placeholder names mirror the bundle's OWN field/header names, so renames in a
// future bundle flow straight through.
//
// The only non-bundle knowledge here is (a) the mock values we typed and (b) a
// short safety-net list of client-generated session headers (x-device-id, x-sec-*,
// …) that never appear in a response or mock, so value-matching alone cannot see
// them. Neither is request shape; both survive bundle changes.
'use strict';

// client-generated per-session headers (names mirror whatever the bundle sends).
// Matched case-insensitively; a header not here is still captured — just by value.
// TRUE per-user/per-session secrets → placeholder the bot fills (these are NOT
// reusable across users, so a captured value must never leak into the template).
const SESSION_HDR = {
  'authorization': (v) => /^bearer\s/i.test(v || '') ? 'Bearer {{ivac:token}}' : '{{ivac:token}}',
  'x-token': () => '{{ivac:captcha}}',
  'x-device-id': () => '{{ivac:deviceId}}',
};
// BUNDLE-DERIVED security headers → output the REAL captured value, NOT a
// placeholder. The bundle COMPUTES these from its own constants (deterministic,
// same per bundle: x-sec-navigation-state, x-sec-runtime-state, x-v-request-meta,
// …), so ivacflow — which runs the live bundle — is exactly where they should be
// extracted. The x-sec-* / x-v-* families are matched by prefix, so any future
// bundle-derived security header flows through automatically, no code change.
function isBundleSecHdr(k) {
  return /^x-sec-/.test(k) || /^x-v-/.test(k);
}
// pure transport noise — the ONLY headers dropped. everything else is kept.
const NOISE_HDR = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'cookie', 'origin', 'referer']);

function isHighEntropy(v) {
  if (typeof v !== 'string') return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true; // uuid
  if ((v.match(/\./g) || []).length >= 2 && v.length >= 20 && /^[A-Za-z0-9._-]+$/.test(v)) return true; // jwt-ish
  if (v.length >= 16 && /[A-Za-z]/.test(v) && /[0-9]/.test(v) && !/\s/.test(v)) return true; // token blob
  return false;
}

// collect every string value seen in all captured responses (for chain detection)
function responseValueSet(responses) {
  const set = new Map(); // value -> producing key (last wins)
  const walk = (o, key) => {
    if (o == null) return;
    if (typeof o === 'string') { if (o.length >= 6) set.set(o, key || 'value'); return; }
    if (typeof o === 'number') { if (String(o).length >= 6) set.set(String(o), key || 'value'); return; }
    if (Array.isArray(o)) { for (const x of o) walk(x, key); return; }
    if (typeof o === 'object') { for (const k of Object.keys(o)) walk(o[k], k); }
  };
  try { walk(responses, ''); } catch (_) {}
  return set;
}

function classifyValue(val, key, mockByVal, respVals) {
  const s = (typeof val === 'number') ? String(val) : val;
  if (typeof s !== 'string') return { v: val, dyn: false };
  if (mockByVal.has(s)) return { v: '{{ivac:' + mockByVal.get(s) + '}}', dyn: true };
  if (respVals.has(s)) return { v: '{{ivac:' + (key || respVals.get(s)) + '}}', dyn: true };
  if (isHighEntropy(s)) return { v: '{{ivac:' + (key || 'dyn') + '}}', dyn: true };
  return { v: val, dyn: false };
}

function templatizeJsonBody(obj, mockByVal, respVals) {
  const walk = (o, key) => {
    if (o == null) return o;
    if (typeof o === 'string' || typeof o === 'number') return classifyValue(o, key, mockByVal, respVals).v;
    if (Array.isArray(o)) return o.map((x) => walk(x, key));
    if (typeof o === 'object') { const out = {}; for (const k of Object.keys(o)) out[k] = walk(o[k], k); return out; }
    return o;
  };
  return walk(obj, '');
}

function templatizeHeaders(liveHeaders, mockByVal, respVals) {
  const out = {};
  for (const k0 of Object.keys(liveHeaders || {})) {
    const k = k0.toLowerCase();
    if (NOISE_HDR.has(k)) continue;
    const val = liveHeaders[k0];
    // bundle-derived security header → keep the REAL captured value (checked BEFORE
    // the entropy classifier, which would otherwise mask a UUID/token-looking value).
    if (isBundleSecHdr(k)) { out[k] = val; continue; }
    if (SESSION_HDR[k]) { out[k] = SESSION_HDR[k](val); continue; }
    if (k === 'content-type' && /multipart\/form-data/i.test(val)) {
      out[k] = 'multipart/form-data; boundary=----WebKitFormBoundary{{ivac:boundary}}'; continue;
    }
    // any other header: value-match secrets (token/captcha reused in a custom
    // header) so even an unknown future session header is masked by value.
    const c = classifyValue(val, k.replace(/[^a-z0-9]+/gi, ''), mockByVal, respVals);
    out[k] = c.dyn ? c.v : val;   // keep real static value (accept, user-agent, …)
  }
  return out;
}

function nameFromPath(method, p) {
  const seg = p.replace(/^\/iams\/api\/v\d+/, '').replace(/^\/+/, '').split('?')[0].split('/').filter(Boolean);
  const label = seg.slice(-2).join('/') || p;
  return (method + ' ' + label).toUpperCase();
}

// mock: { phone, password, otp, ... } values we fed the walk.
// responses: parsed responses.json (optional) for chain detection.
function buildLiveTemplate(calls, opts) {
  opts = opts || {};
  const mock = opts.mock || {};
  const mockByVal = new Map();
  for (const k of Object.keys(mock)) { const v = mock[k]; if (v != null && String(v).length) mockByVal.set(String(v), k); }
  const respVals = responseValueSet(opts.responses || {});

  const steps = [];
  const seen = new Set(); // dedupe repeated identical endpoint hits, keep first (order preserved)
  for (const c of (calls || [])) {
    if (!c || !c.url) continue;
    const path = String(c.url).replace(/^https?:\/\/[^/]+/, '');
    if (!/\/iams\/api\//.test(path)) continue;            // only the IVAC API calls
    const dedupeKey = (c.method || '') + ' ' + path.replace(/\?.*$/, '');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const headers = templatizeHeaders(c.headers, mockByVal, respVals);

    let body = null, bodyNote = '';
    const ct = Object.keys(c.headers || {}).reduce((a, k) => k.toLowerCase() === 'content-type' ? c.headers[k] : a, '');
    if (c.body && /multipart\/form-data/i.test(ct || '')) {
      bodyNote = 'multipart/form-data — files + fields (boundary প্রতিবার নতুন); bot নিজে build করে';
      body = '{{ivac:multipart}}';
    } else if (c.body) {
      try { body = templatizeJsonBody(JSON.parse(c.body), mockByVal, respVals); }
      catch (_) { body = c.body; bodyNote = 'non-JSON body — verbatim'; }
    }

    steps.push({
      name: nameFromPath(c.method, path),
      method: c.method, path, found: true, source: 'live-capture',
      headers, body, note: bodyNote,
    });
  }
  return steps;
}

module.exports = { buildLiveTemplate, templatizeHeaders, templatizeJsonBody, isHighEntropy, SESSION_HDR, NOISE_HDR };
