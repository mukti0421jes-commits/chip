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

async function getBrowser() {
  if (browser) return browser;
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
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
  const page = await context.newPage();
  // origin-এ বসাই যাতে fetch একই সাইট থেকে যায় (userscript যেভাবে করে)
  try { await page.goto(ORIGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch (e) { /* origin না লোড হলেও fetch চেষ্টা করব */ }
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
  return serialize(key, async () => {
    const { page } = await getPage(proxy);
    const result = await page.evaluate(async (args) => {
      try {
        const init = { method: args.method, headers: args.headers || {}, credentials: 'omit' };
        if (args.body != null && args.method !== 'GET' && args.method !== 'HEAD') init.body = args.body;
        const r = await fetch(args.url, init);
        const text = await r.text();
        return { status: r.status, statusText: r.statusText, body: text };
      } catch (e) {
        return { status: 0, statusText: 'fetch-error', body: String(e && e.message || e) };
      }
    }, { url, method: String(method || 'GET').toUpperCase(), headers: headers || {}, body: (body != null ? String(body) : null) });
    return result;
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
