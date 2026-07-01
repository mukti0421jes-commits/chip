// ============================================================================
//  proxy-relay.js  —  RJ SLOT local proxy relay  (zero dependency)
// ----------------------------------------------------------------------------
//  কেন লাগে:
//    Browser-এর userscript নিজে fetch-এ proxy বসাতে পারে না। তাই সে request-টা
//    এই ছোট প্রোগ্রামকে (127.0.0.1:8781) পাঠায়, আর বলে দেয় "এই proxy দিয়ে পাঠাও"।
//    এই প্রোগ্রাম তখন ওই proxy (host:port:user:pass) দিয়ে আসল request করে,
//    উত্তরটা browser-কে ফেরত দেয়। এক relay দিয়েই যত খুশি browser চলবে।
//
//  চালানোর নিয়ম:
//    1) PC-তে Node.js থাকতে হবে   (দেখুন:  node -v)
//    2) এই ফাইলটা সেভ করুন
//    3) টার্মিনালে:  node proxy-relay.js
//    4) "RJ relay listening on http://127.0.0.1:8781" দেখালে তৈরি
//    5) কাজের সময় এই উইন্ডোটা খোলা রাখুন
//
//  সাপোর্টেড proxy স্কিম:  http, https, socks5, socks4a/socks4 (auth সহ)
//  এন্ডপয়েন্ট (userscript এগুলোই কল করে):
//    POST /relay  { url, method, headers, body, proxy } -> { status, statusText, headers, body }
//    POST /ip     { proxy }                             -> { ip } | { error }
// ============================================================================
'use strict';

const http  = require('http');
const https = require('https');
const net   = require('net');
const tls   = require('tls');
const { URL } = require('url');

const PORT = 8781;
const HOST = '127.0.0.1';
const CONNECT_TIMEOUT_MS = 25000;

// ---------------------------------------------------------------------------
//  ছোট util: n বাইট না আসা পর্যন্ত অপেক্ষা (socks handshake-এর জন্য)
// ---------------------------------------------------------------------------
function makeByteReader(socket) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    pump();
  });
  function pump() {
    while (waiters.length && buf.length >= waiters[0].n) {
      const w = waiters.shift();
      const out = buf.subarray(0, w.n);
      buf = buf.subarray(w.n);
      w.resolve(out);
    }
  }
  return {
    read(n) { return new Promise((resolve) => { waiters.push({ n, resolve }); pump(); }); },
    leftover() { return buf; }
  };
}

// ---------------------------------------------------------------------------
//  proxy দিয়ে target host:port পর্যন্ত raw TCP tunnel বানায়
//  সফল হলে cb(null, socket) — socket তখন target-এর সাথে সরাসরি কথা বলার জন্য প্রস্তুত
// ---------------------------------------------------------------------------
function tunnel(proxy, host, port, cb) {
  const scheme = String(proxy.scheme || 'http').toLowerCase();
  if (scheme === 'socks5' || scheme === 'socks4' || scheme === 'socks4a') {
    return socksTunnel(proxy, host, port, scheme, cb);
  }
  return httpConnectTunnel(proxy, host, port, cb);
}

// ----- HTTP / HTTPS proxy → CONNECT method (Basic auth) --------------------
function httpConnectTunnel(proxy, host, port, cb) {
  const pPort = parseInt(proxy.port, 10);
  const useTls = String(proxy.scheme).toLowerCase() === 'https';
  const socket = useTls
    ? tls.connect({ host: proxy.host, port: pPort, servername: proxy.host, rejectUnauthorized: false })
    : net.connect({ host: proxy.host, port: pPort });

  let done = false;
  const fail = (e) => { if (!done) { done = true; try { socket.destroy(); } catch (_) {} cb(e); } };
  const ok   = (s) => { if (!done) { done = true; cb(null, s); } };

  socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error('proxy CONNECT timeout')));
  socket.on('error', fail);

  socket.on(useTls ? 'secureConnect' : 'connect', () => {
    let head = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
    if (proxy.user) {
      const cred = Buffer.from(`${proxy.user}:${proxy.password || ''}`).toString('base64');
      head += `Proxy-Authorization: Basic ${cred}\r\n`;
    }
    head += 'Connection: keep-alive\r\n\r\n';
    socket.write(head);

    let acc = Buffer.alloc(0);
    const onData = (d) => {
      acc = Buffer.concat([acc, d]);
      const idx = acc.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.removeListener('data', onData);
      socket.setTimeout(0);
      const statusLine = acc.toString('ascii', 0, acc.indexOf('\r\n'));
      const m = statusLine.match(/\s(\d{3})\s/);
      const code = m ? parseInt(m[1], 10) : 0;
      if (code === 200) ok(socket);
      else fail(new Error(`proxy CONNECT failed: ${statusLine.trim()}`));
    };
    socket.on('data', onData);
  });
}

// ----- SOCKS5 / SOCKS4(a) proxy --------------------------------------------
function socksTunnel(proxy, host, port, scheme, cb) {
  const pPort = parseInt(proxy.port, 10);
  const socket = net.connect({ host: proxy.host, port: pPort });
  let done = false;
  const fail = (e) => { if (!done) { done = true; try { socket.destroy(); } catch (_) {} cb(e); } };
  const ok   = (s) => { if (!done) { done = true; cb(null, s); } };
  socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error('socks connect timeout')));
  socket.on('error', fail);

  socket.on('connect', async () => {
    try {
      const r = makeByteReader(socket);
      if (scheme === 'socks5') {
        // greeting
        const methods = proxy.user ? [0x00, 0x02] : [0x00];
        socket.write(Buffer.from([0x05, methods.length, ...methods]));
        const sel = await r.read(2);
        if (sel[0] !== 0x05) throw new Error('bad socks5 version');
        if (sel[1] === 0x02) {
          const u = Buffer.from(proxy.user || '', 'utf8');
          const p = Buffer.from(proxy.password || '', 'utf8');
          socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          const ares = await r.read(2);
          if (ares[1] !== 0x00) throw new Error('socks5 auth failed');
        } else if (sel[1] !== 0x00) {
          throw new Error('socks5 no acceptable auth method');
        }
        // connect request (domain)
        const hb = Buffer.from(host, 'utf8');
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb,
          Buffer.from([(port >> 8) & 0xff, port & 0xff])
        ]);
        socket.write(req);
        const head = await r.read(4);
        if (head[1] !== 0x00) throw new Error('socks5 connect failed (rep ' + head[1] + ')');
        const atyp = head[3];
        if (atyp === 0x01) await r.read(4 + 2);
        else if (atyp === 0x03) { const l = (await r.read(1))[0]; await r.read(l + 2); }
        else if (atyp === 0x04) await r.read(16 + 2);
        socket.setTimeout(0);
        ok(socket);
      } else {
        // socks4 / socks4a
        const userId = Buffer.from(proxy.user || '', 'utf8');
        let req;
        if (scheme === 'socks4a') {
          const hb = Buffer.from(host, 'utf8');
          req = Buffer.concat([
            Buffer.from([0x04, 0x01, (port >> 8) & 0xff, port & 0xff, 0, 0, 0, 1]),
            userId, Buffer.from([0x00]), hb, Buffer.from([0x00])
          ]);
        } else {
          const ip = host.split('.').map((x) => parseInt(x, 10));
          req = Buffer.concat([
            Buffer.from([0x04, 0x01, (port >> 8) & 0xff, port & 0xff, ip[0], ip[1], ip[2], ip[3]]),
            userId, Buffer.from([0x00])
          ]);
        }
        socket.write(req);
        const resp = await r.read(8);
        if (resp[1] !== 0x5a) throw new Error('socks4 connect failed (' + resp[1] + ')');
        socket.setTimeout(0);
        ok(socket);
      }
    } catch (e) { fail(e); }
  });
}

// ---------------------------------------------------------------------------
//  tunnel-এর উপর দিয়ে আসল HTTP(S) request চালায়, response সংগ্রহ করে
// ---------------------------------------------------------------------------
function requestThroughProxy(proxy, targetUrl, method, headers, body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) { return reject(new Error('bad url')); }
    const isHttps = u.protocol === 'https:';
    const port = u.port ? parseInt(u.port, 10) : (isHttps ? 443 : 80);

    tunnel(proxy, u.hostname, port, (err, sock) => {
      if (err) return reject(err);

      const lib = isHttps ? https : http;
      const agent = new lib.Agent({ keepAlive: false });
      // tunnel-করা socket-টাই connection হিসেবে দিই
      agent.createConnection = (opts, done) => {
        if (!isHttps) return done(null, sock);
        const tlsSock = tls.connect({ socket: sock, servername: u.hostname }, () => done(null, tlsSock));
        tlsSock.on('error', (e) => done(e));
      };

      const outHeaders = { ...headers };
      // node নিজে ঠিক করবে — পুরোনোগুলো সরিয়ে দিই
      delete outHeaders.host; delete outHeaders.Host;
      delete outHeaders['content-length']; delete outHeaders['Content-Length'];
      delete outHeaders.connection; delete outHeaders.Connection;

      const req = lib.request(
        targetUrl,
        { method, headers: outHeaders, agent, timeout: 60000 },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            resolve({
              status: res.statusCode,
              statusText: res.statusMessage || '',
              headers: res.headers,
              body: buf.toString('utf8')
            });
            try { sock.destroy(); } catch (_) {}
          });
        }
      );
      req.on('timeout', () => { req.destroy(new Error('target request timeout')); });
      req.on('error', reject);
      if (body != null) req.write(typeof body === 'string' ? body : String(body));
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
//  HTTP server + CORS + রাউটিং
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
      const out = await requestThroughProxy(proxy, url, method || 'GET', headers || {}, body);
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
      const out = await requestThroughProxy(proxy, 'https://api.ipify.org?format=json', 'GET', {}, null);
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

server.listen(PORT, HOST, () => {
  console.log('====================================================');
  console.log(`  RJ relay listening on http://${HOST}:${PORT}`);
  console.log('  এই উইন্ডো খোলা রাখুন। বন্ধ করতে: Ctrl + C');
  console.log('====================================================');
});
