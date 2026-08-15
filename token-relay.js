// RJ Turnstile Token Relay — tiny local queue so the Farm browser can hand solved tokens to the
// RJ SLOT browser (cross-browser). No deps. Run:  node token-relay.js   (default port 8787)
//
//   Farm  (browser A):  POST /push   { token }        → enqueue
//   RJSLOT(browser B):  GET  /pull                    → dequeue ONE fresh token (single-use)
//                       GET  /count                   → { fresh }
//                       GET  /peek                     → list (debug)
//
// Same machine  → both userscripts use http://127.0.0.1:8787
// Other machine → use the farm machine's LAN IP (e.g. http://192.168.0.10:8787) and open the port.
// Tokens are single-use and pruned after TTL_MS (~290s, matching Turnstile's ~300s life).

const http = require('http');
const PORT = process.env.PORT || 8787;
const TTL_MS = 150000;   // 2.5 min — Turnstile tokens live ~5min; we serve only fresh ones (safety margin)
let q = [];   // { token, at }

function prune() { const now = Date.now(); q = q.filter(x => now - x.at < TTL_MS); }
function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const u = (req.url || '').split('?')[0];
  prune();

  if (req.method === 'POST' && u === '/push') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let tok = null;
      try { tok = JSON.parse(body || '{}').token; } catch (e) { tok = null; }
      if (!tok || typeof tok !== 'string' || tok.length < 20) return send(res, 400, { ok: false, error: 'no token' });
      if (!q.some(x => x.token === tok)) q.push({ token: tok, at: Date.now() });
      send(res, 200, { ok: true, fresh: q.length });
    });
    return;
  }
  if (req.method === 'GET' && u === '/pull') {
    const item = q.shift() || null;   // FIFO, single-use (prune() above already dropped >TTL tokens)
    return send(res, 200, { token: item ? item.token : null, at: item ? item.at : 0, ageMs: item ? (Date.now() - item.at) : 0, ttlMs: TTL_MS, fresh: q.length });
  }
  if (req.method === 'GET' && u === '/count') return send(res, 200, { fresh: q.length });
  if (req.method === 'GET' && u === '/peek') return send(res, 200, { fresh: q.length, tokens: q.map(x => x.token.slice(0, 24) + '…') });
  if (u === '/' ) return send(res, 200, { ok: true, service: 'rj-token-relay', fresh: q.length });
  send(res, 404, { ok: false });
}).listen(PORT, () => console.log('[RJ Token Relay] listening on http://0.0.0.0:' + PORT + '  (fresh queue, TTL ' + (TTL_MS/1000) + 's)'));
