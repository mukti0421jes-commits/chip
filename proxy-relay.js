// ============================================================================
//  proxy-relay.js  —  RJ SLOT local proxy relay  (Chrome-TLS via cycletls)
// ----------------------------------------------------------------------------
//  কেন এই ভার্সন:
//    আগের relay Node-এর ডিফল্ট TLS দিত → Cloudflare "bot" ভেবে 403 দিত।
//    এই ভার্সন cycletls দিয়ে Chrome-এর হুবহু TLS/JA3 ছাপ নকল করে,
//    তাই Cloudflare আসল ব্রাউজার ভাবে → request সার্ভারে পৌঁছায় (503/200)।
//
//  এন্ডপয়েন্ট (userscript যা কল করে — কিছুই বদলায়নি):
//    POST /relay  { url, method, headers, body, proxy } -> { status, statusText, headers, body }
//    POST /ip     { proxy }                             -> { ip } | { error }
//
//  চালানোর আগে একবার:  npm i cycletls     (startrelay.bat নিজেই করে নেবে)
//  তারপর:               node proxy-relay.js   (বা startrelay.bat ডাবল-ক্লিক)
// ============================================================================
'use strict';

const http = require('http');

const PORT = 8781;
const HOST = '127.0.0.1';

// Chrome 131 এর মতো JA3 + User-Agent
const CHROME_JA3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-21,29-23-24,0';
const CHROME_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// cycletls লোড
let initCycleTLS;
try {
  initCycleTLS = require('cycletls');
} catch (e) {
  console.error('\n[!] cycletls paoa jayni. ei folder e chalao:  npm i cycletls');
  console.error('    othoba startrelay.bat double-click korun (o nije install kore nebe).\n');
  process.exit(1);
}

let cycleTLS = null;
async function getClient() {
  if (!cycleTLS) cycleTLS = await initCycleTLS();
  return cycleTLS;
}

// proxy object -> cycletls proxy URL string
function proxyToUrl(p) {
  if (!p || !p.host) return '';
  const scheme = String(p.scheme || 'http').toLowerCase();
  const auth = p.user ? `${encodeURIComponent(p.user)}:${encodeURIComponent(p.password || '')}@` : '';
  return `${scheme}://${auth}${p.host}:${p.port}`;
}

function bodyToString(b) {
  if (b == null) return '';
  if (typeof b === 'string') return b;
  try { return JSON.stringify(b); } catch (_) { return String(b); }
}

// cycletls দিয়ে আসল request
async function doRequest(proxy, url, method, headers, body) {
  const client = await getClient();
  const m = String(method || 'GET').toLowerCase();
  const outHeaders = {};
  const lc = {};
  for (const k in (headers || {})) { outHeaders[k] = headers[k]; lc[k.toLowerCase()] = true; }
  // ব্রাউজার-ডিফল্ট (userscript যা দেয়নি সেগুলো)
  const target = String(url);
  const isApi = /(^|\.)ivacbd\.com/i.test(target);
  if (isApi) {
    if (!lc['origin'])          outHeaders['origin'] = 'https://appointment.ivacbd.com';
    if (!lc['referer'])         outHeaders['referer'] = 'https://appointment.ivacbd.com/';
    if (!lc['accept-language']) outHeaders['accept-language'] = 'en-US,en;q=0.9';
  }
  const opts = {
    body: bodyToString(body),
    ja3: CHROME_JA3,
    userAgent: CHROME_UA,
    headers: outHeaders,
    disableRedirect: true,
    timeout: 60
  };
  const px = proxyToUrl(proxy);
  if (px) opts.proxy = px;
  const resp = await client(target, opts, m);
  let outBody = resp.body;
  if (outBody != null && typeof outBody !== 'string') {
    try { outBody = JSON.stringify(outBody); } catch (_) { outBody = String(outBody); }
  }
  return { status: resp.status, statusText: '', headers: resp.headers || {}, body: outBody != null ? outBody : '' };
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
  console.log(`  RJ relay (Chrome-TLS / cycletls) on http://${HOST}:${PORT}`);
  console.log('  prothom bar cycletls ektu somoy nite pare (Go binary namay)।');
  console.log('  ei window khola rakhun। bondho korte: Ctrl + C');
  console.log('====================================================');
  try { await getClient(); console.log('  ✓ cycletls ready'); }
  catch (e) { console.error('  [!] cycletls init failed:', e.message); }
});

process.on('SIGINT', async () => { try { if (cycleTLS) await cycleTLS.exit(); } catch (_) {} process.exit(0); });
