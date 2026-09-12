// extract-core.js — decode an IVAC index.js bundle STRING into the values the
// bot needs. Same generic (pattern-based, not per-build-name) decode as
// ivac-extract, packaged as a function so the local UI can call it.
//
//   const { extract } = require('./extract-core');
//   const out = extract(bundleSourceString);
'use strict';
const vm = require('vm');

function extract(S) {
  const first = (re) => { const m = re.exec(S); return m ? (m[1] || m[0]) : ''; };

  const out = {
    extractedAt: new Date().toISOString(),
    apiBase: first(/(https?:\/\/[a-zA-Z0-9.\-]+\/iams\/api\/v\d+)/) || first(/(https?:\/\/[a-zA-Z0-9.\-]+\/api\/v\d+)/),
    endpoints: {},
    slotId: first(/\/slots\/([0-9a-zA-Z-]{30,40})\/reserve-slot/),
    dgepayUuid: '',
    initiatePath: '',
  };

  const EPS = [
    ['signin', /(\/auth\/[a-z0-9-]*sign-?in[a-z0-9-]*)/i],
    ['signup', /(\/auth\/signup)(?![a-z/])/i],
    ['signupConsent', /(\/auth\/signup\/consent)/i],
    ['signupStatus', /(\/auth\/signup\/status)/i],
    ['signupOtp', /(\/otp\/signup[a-zA-Z0-9_-]*)/i],
    ['verifySigninOtp', /(\/otp\/verifySigninOtp[a-z0-9_-]*)/i],
    ['verifyOtp', /(\/otp\/verify-otp[a-z0-9_-]*)/i],
    ['uploadFile', /(\/file\/upload_file[a-z0-9_-]*)/i],
    ['overView', /(\/file\/over-view[a-z0-9_-]*)/i],
    ['getBookingConfig', /(\/appointment\/get-booking-config[a-z0-9_-]*)/i],
    ['bookingConfig', /(\/appointment\/appointment-booking-config[a-z0-9_-]*)/i],
    ['fileConfirmation', /(\/file\/file-confirmation[a-z0-9_-]*)/i],
    ['paymentAmount', /(\/file\/payment-amount[a-z0-9_-]*)/i],
  ];
  for (const [name, re] of EPS) { const m = re.exec(S); if (m) out.endpoints[name] = m[1]; }

  const reAllEp = /\/(?:auth|otp|file|appointment|forgot-password|profile|invoice|high-commissions|ivac-centers|slots|payment)\/[a-zA-Z0-9/_-]{2,60}/g;
  out.allEndpoints = [...new Set((S.match(reAllEp) || []))].sort();

  // ── obfuscation decode: dg-epay uuid / initiate path ────────────────────────
  function grabBalanced(str, start) {
    let j = str.indexOf('{', start);
    if (j < 0) return ['', str.length];
    let depth = 0;
    for (let k = j; k < str.length; k++) {
      const c = str[k];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return [str.slice(start, k + 1), k + 1]; }
    }
    return ['', str.length];
  }
  function grabFn(name) { const i = S.indexOf('function ' + name + '('); return i < 0 ? '' : grabBalanced(S, i)[0]; }
  function indexAll(sub) { const o = []; let i = 0; for (;;) { const j = S.indexOf(sub, i); if (j < 0) break; o.push(j); i = j + sub.length; } return o; }
  function grabRotation(arr) {
    const tgt = '(' + arr + ')';
    for (const idx of indexAll('!function(')) {
      const [body, end] = grabBalanced(S, idx + 1);
      if (body && S.slice(end, end + tgt.length) === tgt) return '!' + body + tgt;
    }
    return '';
  }

  // wrapper-decoder defs (1 or 2 args): function X(a){return Y(..)} / function X(a,b){return Y(..)}
  const reWrapAny = /function \w+\(\w+(?:,\w+)?\)\{return \w+\([^{}]*\)\}/g;

  const realArr = new Set();
  for (const m of S.matchAll(/function (\w+)\(\)\{(?:var|const|let) \w+=\[/g)) realArr.add(m[1]);
  const reScope = /function\*?\s*\w*\s*\([^)]*\)\s*\{|=>\s*\{/g;

  // Robust concat extractor: a '+'-joined chain of terms where each term is a
  // string literal OR ident(args) with BALANCED parens/quotes (so string args
  // containing "(" or ")" don't break parsing — the flaw regex extraction has).
  function extractConcats(text) {
    const out = []; const n = text.length;
    const skipString = (i) => { const q = text[i]; i++; while (i < n) { const c = text[i]; if (c === '\\') { i += 2; continue; } if (c === q) return i + 1; i++; } return -1; };
    const parseTerm = (i) => {
      const c = text[i];
      if (c === '"' || c === "'" || c === '`') return skipString(i);
      if (/[A-Za-z_$]/.test(c)) { let j = i; while (j < n && /[\w$.]/.test(text[j])) j++; if (text[j] !== '(') return -1;
        let depth = 0; while (j < n) { const d = text[j]; if (d === '"' || d === "'" || d === '`') { j = skipString(j); if (j < 0) return -1; continue; } if (d === '(') depth++; else if (d === ')') { depth--; if (depth === 0) return j + 1; } j++; } return -1; }
      return -1;
    };
    for (let i = 0; i < n; i++) {
      if (!/["'`A-Za-z_$]/.test(text[i])) continue;
      let j = parseTerm(i); if (j < 0) continue;
      let terms = 1, k = j;
      for (;;) { while (k < n && /\s/.test(text[k])) k++; if (text[k] !== '+') break; let m = k + 1; while (m < n && /\s/.test(text[m])) m++; const e = parseTerm(m); if (e < 0) break; terms++; k = e; }
      if (terms >= 3) { out.push(text.slice(i, k)); i = k; }
    }
    return out;
  }

  // One decode pass. broad=false → original (inline handler, string-led concats).
  // broad=true → delegated fns included, decoder-call-led concats, seed from idents.
  function decodePass(broad) {
    const regions = [];
    for (const pi of indexAll('paymentMethod')) {
      regions.push(S.slice(Math.max(0, pi - 500), pi + 6000));
      if (broad) {   // also pull in the fns the handler delegates to (URL may be built
        //             there) — the callee can be CALLED `rV(...)` or PASSED `(rV,n,..)`.
        const head = S.slice(Math.max(0, pi - 40), pi + 500);
        const ids = new Set();
        for (const m of head.matchAll(/\b([A-Za-z$_][\w$]{0,3})\b/g)) ids.add(m[1]);
        for (const id of ids) {
          if (/^(var|let|const|function|return|null|void|this|new|typeof)$/.test(id)) continue;
          let b = grabFn(id);
          if (!b) { const j = S.indexOf(id + '=('); if (j >= 0) { const gb = grabBalanced(S, j); b = gb[0] || S.slice(j, j + 6000); } }
          if (b && b.length > 40 && b.length < 12000) regions.push(b);
        }
      }
      if (!broad) break;   // original looked only at the first paymentMethod region
    }
    if (!regions.length) return '';
    const searchText = regions.join('\n');

    let cands;
    if (broad) {
      cands = [...new Set(extractConcats(searchText))];          // robust, balanced
      // prefer URL/uuid-shaped concats (a quoted piece with a digit or '-'); the
      // real initiate URL is a LONG concat, so rank by segment count and cap — keeps
      // big bundles fast and puts the true URL builder near the top.
      const urlish = cands.filter((c) => /"[^"]*[-0-9][^"]*"[)]?\+/.test(c) || /"[^"]*[-0-9][^"]*"$/.test(c));
      if (urlish.length) cands = urlish;
      cands.sort((a, b) => (b.match(/\+/g) || []).length - (a.match(/\+/g) || []).length);
      cands = cands.slice(0, 20);
    } else {
      const reCand = /"[^"]{0,12}"(?:\+(?:\w+\([^()]*\)|"[^"]*"|\w+\(\w+\)))+/g;
      cands = [...new Set(searchText.match(reCand) || [])];
    }
    if (!cands.length) return '';

    const regionWrapSeed = new Set();
    for (const w of (searchText.match(/function \w+\(\w+,\w+\)\{return \w+\([^{}]*\)\}/g) || [])) { const m = /return (\w+)\(/.exec(w); if (m) regionWrapSeed.add(m[1]); }

    function scopeWrappers(cand) {
      let cpos = S.indexOf(cand); if (cpos < 0) return [];
      const from = Math.max(0, cpos - 4000); let best = '', bestLen = 1e9, m;
      reScope.lastIndex = 0; const seg = S.slice(from, cpos);
      while ((m = reScope.exec(seg))) {
        const st = from + m.index + m[0].length - 1;
        const [b2, end] = grabBalanced(S, st);
        if (st < cpos && cpos < end && b2.length < bestLen) { best = b2; bestLen = b2.length; }
      }
      return best ? (best.match(reWrapAny) || []) : [];
    }

    // Build a decoder prelude for a specific set of seed identifiers (kept small
    // per-candidate so big bundles don't blow up one giant eval).
    function buildPrelude(seed) {
      const seen = new Set(); const arrays = new Set(); const defs = [];
      function add(name) {
        if (seen.has(name)) return; seen.add(name);
        const body = grabFn(name); if (!body) return;
        defs.push(body);
        for (const a of body.matchAll(/=(\w+)\(\)/g)) arrays.add(a[1]);
        for (const r of body.matchAll(/return (\w+)\(/g)) if (r[1] !== name && S.includes('function ' + r[1] + '(')) add(r[1]);
      }
      for (const b of seed) add(b);
      const pre = [];
      for (const a of arrays) { if (!realArr.has(a)) continue; const af = grabFn(a); if (af) pre.push(af); const rot = grabRotation(a); if (rot) pre.push(rot); }
      pre.push(...defs);
      return pre;
    }

    if (!broad) {
      // original: one prelude from region wrappers, eval all string-led candidates
      if (!regionWrapSeed.size) return '';
      const prelude = buildPrelude(regionWrapSeed);
      if (!prelude.length) return '';
      const ctx = {}; vm.createContext(ctx);
      try { vm.runInContext(prelude.join(';\n') + ';', ctx, { timeout: 8000 }); } catch (e) { return ''; }
      let ssl = '';
      for (const c of cands) {
        try {
          const v = vm.runInContext('(function(){' + scopeWrappers(c).join('\n') + '\nreturn (' + c + ');})()', ctx, { timeout: 2000 });
          if (typeof v !== 'string') continue;
          const m = /payment\/[0-9a-zA-Z_-]+(?:\/dg-epay)?\/initiate/.exec(v);
          if (m) { if (m[0].includes('/dg-epay/initiate')) return m[0]; if (!ssl) ssl = m[0]; }
        } catch (e) {}
      }
      return ssl;
    }

    // broad: ONE combined prelude, seeded only from the capped candidate set (keeps
    // the eval small on big bundles) + region wrappers; then eval each candidate.
    const seed = new Set(regionWrapSeed);
    for (const c of cands) for (const m of c.matchAll(/(\w+)\(/g)) seed.add(m[1]);
    if (!seed.size) return '';
    const tryEval = (c, ctx) => {
      try {
        const v = vm.runInContext('(function(){' + scopeWrappers(c).join('\n') + '\nreturn (' + c + ');})()', ctx, { timeout: 2000 });
        if (typeof v !== 'string') return null;
        const m = /payment\/[0-9a-zA-Z_-]+(?:\/dg-epay)?\/initiate/.exec(v);
        return m ? m[0] : null;
      } catch (e) { return null; }
    };
    let ssl = '';
    // (a) fast path: ONE combined prelude (short timeout), eval all capped candidates
    const prelude = buildPrelude(seed);
    if (prelude.length) {
      const ctx = {}; vm.createContext(ctx);
      let ok = true; try { vm.runInContext(prelude.join(';\n') + ';', ctx, { timeout: 5000 }); } catch (e) { ok = false; }
      if (ok) for (const c of cands) { const r = tryEval(c, ctx); if (r) { if (r.includes('/dg-epay/initiate')) return r; if (!ssl) ssl = r; } }
    }
    if (ssl) return ssl;
    // (b) fallback: per-candidate small prelude (big bundles where the combined
    //     prelude is too large to eval) — early-return on first dg-epay hit.
    for (const c of cands) {
      const s2 = new Set(regionWrapSeed);
      for (const m of c.matchAll(/(\w+)\(/g)) s2.add(m[1]);
      const p2 = buildPrelude(s2);
      if (!p2.length && !scopeWrappers(c).length) continue;
      const ctx = {}; vm.createContext(ctx);
      try { vm.runInContext(p2.join(';\n') + ';', ctx, { timeout: 4000 }); } catch (e) { continue; }
      const r = tryEval(c, ctx); if (r) { if (r.includes('/dg-epay/initiate')) return r; if (!ssl) ssl = r; }
    }
    return ssl;
  }

  function decodeInitiatePath() {
    const r1 = decodePass(false);              // original (fast, proven on inline builds)
    if (r1 && r1.includes('/dg-epay/initiate')) return r1;
    const r2 = decodePass(true);               // extended (delegated builds)
    return (r2 && r2.includes('/dg-epay/initiate')) ? r2 : (r1 || r2);
  }

  if (!out.apiBase) { out.apiBase = 'https://api.ivacbd.com/iams/api/v1'; out.apiBaseNote = 'default (not plaintext in bundle; this base is stable)'; }

  const ip = decodeInitiatePath();
  if (ip) {
    out.initiatePath = '/' + ip.replace(/^\//, '');
    const u = /payment\/([0-9a-zA-Z_-]{20,40})\/dg-epay\/initiate/.exec(ip);
    if (u) out.dgepayUuid = u[1];
  }
  return out;
}

module.exports = { extract };
