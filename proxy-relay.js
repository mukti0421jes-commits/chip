// ============================================================================
//  proxy-relay.js  —  RJ SLOT proxy relay  (REAL browser via Playwright)
// ----------------------------------------------------------------------------
//  কেন এই ভার্সন:
//    Cloudflare কোড-নকল TLS (cycletls) ধরে ফেলে → 403/495।
//    এখানে relay-র ভিতরে আসল Chromium চলে; request ওই আসল ব্রাউজারের
//    নেটওয়ার্ক স্ট্যাক দিয়ে যায় → TLS/JA3 হুবহু আসল Chrome → Cloudflare পাস (503/200)।
//    প্রতি proxy-র জন্য আলাদা browser context → rotation বজায় থাকে।
//
//  এন্ডপয়েন্ট (userscript যা কল করে — কিছুই বদলায়নি):
//    POST /relay  { url, method, headers, body, proxy } -> { status, statusText, body }
//    POST /ip     { proxy }                             -> { ip } | { error }
//
//  একবার সেটআপ (startrelay.bat নিজে করে নেবে):
//    npm i playwright
//    npx playwright install chromium
//  তারপর:  node proxy-relay.js
// ============================================================================
'use strict';

const http = require('http');

const PORT = 8781;
const HOST = '127.0.0.1';
const ORIGIN_URL = 'https://appointment.ivacbd.com/';   // fetch এই origin থেকে হবে (CORS মেলে)

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.error('\n[!] playwright paoa jayni. ei folder e chalao:');
  console.error('      npm i playwright');
  console.error('      npx playwright install chromium\n');
  process.exit(1);
}

let browser = null;
const pages = new Map();      // proxyKey -> { context, page, ready }
const busy = new Map();       // proxyKey -> Promise chain (একটা context-এ একসাথে একটা request)

function proxyKey(p) { return p ? `${p.scheme}://${p.host}:${p.port}:${p.user || ''}` : 'direct'; }

// Headful (visible) Chromium — Cloudflare detects/blocks HEADLESS automation regardless of
// proxy IP, so a real visible window passes far more often. Set RELAY_HEADLESS=1 to force headless.
const HEADLESS = process.env.RELAY_HEADLESS === '1';
async function getBrowser() {
  if (browser) return browser;
  browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--start-minimized'
    ]
  });
  return browser;
}

// প্রতি proxy-র জন্য একটা context + একটা page (appointment.ivacbd.com-এ বসানো)
async function getPage(proxy) {
  const key = proxyKey(proxy);
  const existing = pages.get(key);
  if (existing && existing.ready) return existing;

  const b = await getBrowser();
  const ctxOpts = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true
  };
  if (proxy && proxy.host) {
    ctxOpts.proxy = {
      server: `${(proxy.scheme || 'http')}://${proxy.host}:${proxy.port}`,
      username: proxy.user || undefined,
      password: proxy.password || undefined
    };
  }
  const context = await b.newContext(ctxOpts);
  // light stealth — hide the most common headless/automation tells Cloudflare checks
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch (e) {}
    try { Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }); } catch (e) {}
    try { window.chrome = window.chrome || { runtime: {} }; } catch (e) {}
  });
  const page = await context.newPage();
  // origin-এ বসাই যাতে fetch একই সাইট থেকে যায় (userscript যেভাবে করে)।
  // networkidle → Cloudflare challenge (jodi thake) settle howar somoy dei.
  try { await page.goto(ORIGIN_URL, { waitUntil: 'networkidle', timeout: 60000 }); }
  catch (e) { try { await page.goto(ORIGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e2) { /* fetch cheshta korbo */ } }
  const entry = { context, page, ready: true };
  pages.set(key, entry);
  return entry;
}

// একই context-এ request-গুলো সিরিয়াল করি (page.evaluate একসাথে একটা)
function serialize(key, fn) {
  const prev = busy.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  busy.set(key, next.catch(() => {}));
  return next;
}

async function doRequest(proxy, url, method, headers, body) {
  const key = proxyKey(proxy);
  const args = { url, method: String(method || 'GET').toUpperCase(), headers: headers || {}, body: (body != null ? String(body) : null) };
  const evalFetch = async (page) => page.evaluate(async (a) => {
    try {
      const init = { method: a.method, headers: a.headers || {}, credentials: 'omit' };
      if (a.body != null && a.method !== 'GET' && a.method !== 'HEAD') init.body = a.body;
      const r = await fetch(a.url, init);
      const text = await r.text();
      return { status: r.status, statusText: r.statusText, body: text };
    } catch (e) {
      return { status: 0, statusText: 'fetch-error', body: String(e && e.message || e) };
    }
  }, args);
  return serialize(key, async () => {
    let entry = await getPage(proxy);
    let out;
    try {
      out = await evalFetch(entry.page);
    } catch (e) {
      // Cloudflare/proxy often navigates the page → "Execution context was destroyed".
      // Rebuild a fresh page for this proxy and retry ONCE.
      const msg = String(e && e.message || e);
      try { const p = pages.get(key); if (p) { await p.context.close().catch(() => {}); pages.delete(key); } } catch (_) {}
      try { entry = await getPage(proxy); out = await evalFetch(entry.page); }
      catch (e2) { out = { status: 0, statusText: 'relay-error', body: 'relay: ' + msg }; }
    }
    // status 0 = the in-page fetch threw (CORS-masked Cloudflare block OR connection fail),
    // and browser fetch hides the real reason. Ask Playwright's own HTTP client (through the
    // SAME proxy context) for the REAL status so we can tell 403 (Cloudflare) from a proxy error.
    if (out && out.status === 0) {
      try {
        const rr = await entry.context.request.fetch(url, {
          method: args.method, headers: args.headers,
          data: (args.body != null && args.method !== 'GET' && args.method !== 'HEAD') ? args.body : undefined,
          timeout: 45000, ignoreHTTPSErrors: true, failOnStatusCode: false
        });
        const realStatus = rr.status();
        const realBody = await rr.text().catch(() => '');
        console.log(`[diag] ${proxy.host}:${proxy.port} browser-fetch=0 → context.request REAL status = ${realStatus}`);
        out = { status: realStatus, statusText: rr.statusText ? rr.statusText() : '', body: realBody, _via: 'context.request' };
      } catch (e3) {
        console.log(`[diag] ${proxy.host}:${proxy.port} browser-fetch=0, context.request FAILED: ${String(e3 && e3.message || e3)}`);
        out = { status: 0, statusText: 'proxy-connect-error', body: String(e3 && e3.message || e3) };
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return; }

  if (req.method === 'POST' && req.url === '/relay') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { return sendJson(res, 400, { error: 'bad json' }); }
    const { url, method, headers, body, proxy } = payload || {};
    if (!url || !proxy || !proxy.host) return sendJson(res, 400, { error: 'missing url/proxy' });
    try {
      const out = await doRequest(proxy, url, method || 'GET', headers || {}, body);
      console.log(`[relay] ${method || 'GET'} ${url} via ${proxy.host}:${proxy.port} -> ${out.status}`);
      return sendJson(res, 200, out);
    } catch (e) {
      console.log(`[relay] FAIL ${url} via ${proxy.host}:${proxy.port} -> ${e.message}`);
      // context ভেঙে গেলে পরের বার নতুন করে বানাই
      try { const k = proxyKey(proxy); const p = pages.get(k); if (p) { await p.context.close().catch(() => {}); pages.delete(k); } } catch (_) {}
      return sendJson(res, 200, { error: e.message });
    }
  }

  if (req.method === 'POST' && req.url === '/ip') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { return sendJson(res, 400, { error: 'bad json' }); }
    const proxy = payload && payload.proxy;
    if (!proxy || !proxy.host) return sendJson(res, 400, { error: 'missing proxy' });
    try {
      const out = await doRequest(proxy, 'https://api.ipify.org?format=json', 'GET', {}, null);
      let ip = '';
      try { ip = JSON.parse(out.body).ip; } catch (_) { ip = (out.body || '').trim(); }
      if (!ip) return sendJson(res, 200, { error: 'no ip (status ' + out.status + ')' });
      console.log(`[ip]    ${proxy.host}:${proxy.port} -> ${ip}`);
      return sendJson(res, 200, { ip });
    } catch (e) {
      console.log(`[ip]    FAIL ${proxy.host}:${proxy.port} -> ${e.message}`);
      return sendJson(res, 200, { error: e.message });
    }
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, async () => {
  console.log('====================================================');
  console.log(`  RJ relay (REAL browser / Playwright) on http://${HOST}:${PORT}`);
  console.log('  Chromium chalu hocche...');
  console.log('  ei window khola rakhun. bondho korte: Ctrl + C');
  console.log('====================================================');
  try { await getBrowser(); console.log('  ✓ Chromium ready'); }
  catch (e) { console.error('  [!] Chromium launch failed:', e.message); console.error('      chalao: npx playwright install chromium'); }
});

process.on('SIGINT', async () => { try { if (browser) await browser.close(); } catch (_) {} process.exit(0); });
