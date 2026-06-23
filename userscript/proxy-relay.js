#!/usr/bin/env node
/* proxy-relay.js — local forwarder so the RJ SLOT userscript can actually
 * route its requests through a chosen HTTP/HTTPS/SOCKS proxy.
 *
 * Why: a Tampermonkey userscript cannot change the browser's proxy. fetch()
 * and GM_xmlhttpRequest have no per-request proxy option. So we run this tiny
 * local server; the userscript POSTs the real request + the chosen proxy here,
 * and this relay performs the outbound request THROUGH that proxy and returns
 * the response. Egress IP then = the proxy's IP.
 *
 * Setup (once):
 *     npm init -y
 *     npm i node-fetch@2 proxy-agent
 *
 * Run:
 *     node proxy-relay.js            # listens on http://127.0.0.1:8781
 *
 * Test a proxy quickly in the browser console / curl:
 *     curl -s http://127.0.0.1:8781/ip \
 *       -H 'content-type: application/json' \
 *       -d '{"proxy":{"scheme":"http","host":"1.2.3.4","port":8080}}'
 */
const http = require('http');
let fetch, ProxyAgent;
try {
  fetch = require('node-fetch');                 // v2 (CommonJS)
  ({ ProxyAgent } = require('proxy-agent'));      // proxy-agent v6+
} catch (e) {
  console.error('\n[proxy-relay] Missing deps. Run:  npm i node-fetch@2 proxy-agent\n');
  process.exit(1);
}

const PORT = process.env.PORT ? +process.env.PORT : 8781;
const HOST = '127.0.0.1';

function proxyUrl(p) {
  if (!p || !p.host || !p.port) return null;
  const scheme = (p.scheme || 'http').toLowerCase();
  const auth = p.user ? `${encodeURIComponent(p.user)}${p.password ? ':' + encodeURIComponent(p.password) : ''}@` : '';
  return `${scheme}://${auth}${p.host}:${p.port}`;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 25 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return; }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // health check
  if (url.pathname === '/' || url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, service: 'rj-proxy-relay', port: PORT });
  }

  // /ip — verify a proxy actually changes the egress IP
  if (url.pathname === '/ip') {
    let cfg = {};
    if (req.method === 'POST') { try { cfg = JSON.parse(await readBody(req) || '{}'); } catch (e) {} }
    const pu = proxyUrl(cfg.proxy);
    try {
      const opts = pu ? { agent: new ProxyAgent(pu) } : {};
      const r = await fetch('https://api.ipify.org?format=json', { ...opts, timeout: 20000 });
      const j = await r.json();
      return sendJson(res, 200, { ip: j.ip, via: pu ? pu.replace(/:[^:@/]+@/, ':***@') : 'direct' });
    } catch (e) { return sendJson(res, 502, { error: e.message }); }
  }

  // /relay — main forwarder
  if (url.pathname === '/relay' && req.method === 'POST') {
    let cfg;
    try { cfg = JSON.parse(await readBody(req) || '{}'); } catch (e) { return sendJson(res, 400, { error: 'bad json' }); }
    const { url: target, method = 'GET', headers = {}, body = null, proxy = null } = cfg;
    if (!target) return sendJson(res, 400, { error: 'missing url' });

    const pu = proxyUrl(proxy);
    const opts = { method, headers, redirect: 'manual', timeout: 45000 };
    if (body !== null && body !== undefined && method !== 'GET' && method !== 'HEAD') opts.body = body;
    if (pu) opts.agent = new ProxyAgent(pu);

    try {
      const r = await fetch(target, opts);
      const text = await r.text();
      const outHeaders = {};
      r.headers.forEach((v, k) => { outHeaders[k] = v; });
      console.log(`[relay] ${method} ${target} -> ${r.status} ${pu ? '(via ' + proxy.host + ':' + proxy.port + ')' : '(direct)'}`);
      return sendJson(res, 200, { status: r.status, statusText: r.statusText, headers: outHeaders, body: text });
    } catch (e) {
      console.log(`[relay] ${method} ${target} -> ERROR ${e.message}`);
      return sendJson(res, 502, { error: e.message });
    }
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`\n[rj-proxy-relay] listening on http://${HOST}:${PORT}`);
  console.log('  POST /relay  { url, method, headers, body, proxy:{scheme,host,port,user,password} }');
  console.log('  POST /ip     { proxy:{...} }   → shows egress IP through the proxy');
  console.log('  Keep this running while you use the userscript with proxy Connect.\n');
});
