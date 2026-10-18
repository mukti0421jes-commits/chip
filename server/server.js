/* RJ Automation — backend (pure Node.js, no external deps)
   Pay-as-you-go: accounts, balance, per-use charge, manual bKash/Nagad recharge,
   admin approval, and a server-side OCR proxy (key hidden). Data in data/db.json. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const CFG_PATH = path.join(ROOT, 'config.json');
const DB_PATH = path.join(ROOT, 'data', 'db.json');
const PUBLIC = path.join(ROOT, 'public');

// ---------- config ----------
function loadConfig() {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.sample.json'), 'utf8'));
  let cfg = base;
  if (fs.existsSync(CFG_PATH)) cfg = Object.assign(base, JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')));
  // env overrides (handy on Render)
  cfg.port = +(process.env.PORT || cfg.port);
  if (process.env.JWT_SECRET) cfg.jwtSecret = process.env.JWT_SECRET;
  if (process.env.OCR_SPACE_KEY) cfg.ocrSpaceKey = process.env.OCR_SPACE_KEY;
  if (process.env.ADMIN_EMAIL) cfg.admin.email = process.env.ADMIN_EMAIL;
  if (process.env.ADMIN_PASSWORD) cfg.admin.password = process.env.ADMIN_PASSWORD;
  return cfg;
}
const CFG = loadConfig();

// ---------- tiny JSON db ----------
let DB = { users: {}, txns: [], recharges: [] };
function loadDb() { try { DB = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (_) { DB = { users: {}, txns: [], recharges: [] }; } }
let saveTimer = null;
function saveDb() { fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2)); }
loadDb();

// ---------- auth helpers ----------
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', CFG.jwtSecret).update(body).digest());
  return body + '.' + sig;
}
function verifyToken(token) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const exp = b64u(crypto.createHmac('sha256', CFG.jwtSecret).update(body).digest());
  if (exp !== sig) return null;
  try {
    const p = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch (_) { return null; }
}
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function newId(p) { return p + crypto.randomBytes(6).toString('hex'); }
const now = () => Date.now();

// ---------- http helpers ----------
function send(res, code, obj, headers) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': typeof obj === 'string' ? 'text/html; charset=utf-8' : 'application/json' }, headers || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = ''; let big = false;
    req.on('data', (c) => { data += c; if (data.length > 8 * 1024 * 1024) { big = true; req.destroy(); } });
    req.on('end', () => { if (big) return resolve(null); try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}
function authUser(req) {
  const h = req.headers['authorization'] || '';
  const p = verifyToken(h.replace(/^Bearer\s+/i, ''));
  if (!p || !p.uid) return null;
  return DB.users[p.uid] || null;
}
function userPublic(u) { return { id: u.id, email: u.email, balance: u.balance, isAdmin: !!u.isAdmin }; }

// ---------- API ----------
async function api(req, res, url) {
  const route = url.pathname;
  const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
  if (body === null) return send(res, 400, { error: 'bad request' });

  // --- register ---
  if (route === '/api/register' && req.method === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    const pw = String(body.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && !/^01\d{9}$/.test(email)) return send(res, 400, { error: 'সঠিক ইমেইল বা মোবাইল দিন' });
    if (pw.length < 4) return send(res, 400, { error: 'পাসওয়ার্ড কমপক্ষে ৪ অক্ষর' });
    if (Object.values(DB.users).some((u) => u.email === email)) return send(res, 409, { error: 'এই অ্যাকাউন্ট আগে থেকেই আছে' });
    const salt = crypto.randomBytes(8).toString('hex');
    const u = { id: newId('u_'), email, salt, passHash: hashPw(pw, salt), balance: 0, createdAt: now(), isAdmin: false };
    DB.users[u.id] = u; saveDb();
    return send(res, 200, { token: sign({ uid: u.id, exp: now() + 30 * 864e5 }), user: userPublic(u) });
  }

  // --- login ---
  if (route === '/api/login' && req.method === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    const pw = String(body.password || '');
    // admin login (from config)
    if (email === String(CFG.admin.email).toLowerCase() && pw === CFG.admin.password) {
      let a = Object.values(DB.users).find((u) => u.email === email);
      if (!a) { const salt = crypto.randomBytes(8).toString('hex'); a = { id: newId('u_'), email, salt, passHash: hashPw(pw, salt), balance: 0, createdAt: now(), isAdmin: true }; DB.users[a.id] = a; }
      a.isAdmin = true; saveDb();
      return send(res, 200, { token: sign({ uid: a.id, exp: now() + 30 * 864e5 }), user: userPublic(a) });
    }
    const u = Object.values(DB.users).find((x) => x.email === email);
    if (!u || u.passHash !== hashPw(pw, u.salt)) return send(res, 401, { error: 'ভুল ইমেইল/পাসওয়ার্ড' });
    return send(res, 200, { token: sign({ uid: u.id, exp: now() + 30 * 864e5 }), user: userPublic(u) });
  }

  // --- me ---
  if (route === '/api/me' && req.method === 'GET') {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'login লাগবে' });
    return send(res, 200, { user: userPublic(u), pricePerUse: CFG.pricePerUse, minRecharge: CFG.minRecharge, currency: CFG.currency, payment: CFG.payment, webStoreUrl: CFG.webStoreUrl || '' });
  }

  // --- charge (per webfile/action) ---
  if (route === '/api/charge' && req.method === 'POST') {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'login লাগবে' });
    const price = CFG.pricePerUse;
    if (u.balance < price) return send(res, 402, { error: 'ব্যালেন্স কম — রিচার্জ করুন', balance: u.balance, need: price });
    u.balance -= price;
    DB.txns.push({ id: newId('t_'), uid: u.id, type: 'charge', amount: -price, note: String(body.note || 'webfile'), at: now() });
    saveDb();
    return send(res, 200, { ok: true, balance: u.balance });
  }

  // --- recharge request (manual bKash/Nagad) ---
  if (route === '/api/recharge' && req.method === 'POST') {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'login লাগবে' });
    const amount = Math.round(+body.amount || 0);
    const method = String(body.method || '').toLowerCase();
    const txnid = String(body.txnid || '').trim();
    if (amount < CFG.minRecharge) return send(res, 400, { error: 'সর্বনিম্ন রিচার্জ ' + CFG.minRecharge + ' ' + CFG.currency });
    if (!['bkash', 'nagad', 'rocket'].includes(method)) return send(res, 400, { error: 'method ঠিক নয়' });
    if (txnid.length < 4) return send(res, 400, { error: 'লেনদেন নম্বর (TrxID) দিন' });
    const r = { id: newId('r_'), uid: u.id, email: u.email, amount, method, txnid, status: 'pending', at: now() };
    DB.recharges.push(r); saveDb();
    return send(res, 200, { ok: true, message: 'রিচার্জ জমা হয়েছে — যাচাইয়ের পর ব্যালেন্সে যোগ হবে।', recharge: r });
  }

  // --- history ---
  if (route === '/api/history' && req.method === 'GET') {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'login লাগবে' });
    return send(res, 200, {
      txns: DB.txns.filter((t) => t.uid === u.id).slice(-50).reverse(),
      recharges: DB.recharges.filter((r) => r.uid === u.id).slice(-50).reverse(),
    });
  }

  // --- OCR proxy (server holds key) ---
  if (route === '/api/ocr' && req.method === 'POST') {
    const u = authUser(req); if (!u) return send(res, 401, { error: 'login লাগবে' });
    if (!CFG.ocrSpaceKey) return send(res, 503, { error: 'সার্ভারে OCR key সেট করা নেই' });
    const dataUrl = String(body.imageBase64 || '');
    const m = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!m) return send(res, 400, { error: 'imageBase64 (data URL) দিন' });
    try {
      const buf = Buffer.from(m[2], 'base64');
      const fd = new FormData();
      fd.append('apikey', CFG.ocrSpaceKey);
      fd.append('language', 'eng'); fd.append('OCREngine', '2'); fd.append('scale', 'true'); fd.append('detectOrientation', 'true');
      fd.append('file', new Blob([buf], { type: m[1] }), 'img.jpg');
      const r = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: fd });
      const j = await r.json();
      if (j.IsErroredOnProcessing) return send(res, 502, { error: (j.ErrorMessage && j.ErrorMessage[0]) || 'OCR error' });
      const text = (j.ParsedResults && j.ParsedResults[0] && j.ParsedResults[0].ParsedText) || '';
      return send(res, 200, { text });
    } catch (e) { return send(res, 502, { error: 'OCR ব্যর্থ: ' + e.message }); }
  }

  // --- admin ---
  if (route.startsWith('/api/admin/')) {
    const u = authUser(req); if (!u || !u.isAdmin) return send(res, 403, { error: 'admin only' });
    if (route === '/api/admin/recharges' && req.method === 'GET') {
      return send(res, 200, { recharges: DB.recharges.slice().reverse(), users: Object.values(DB.users).map(userPublic) });
    }
    if (route === '/api/admin/approve' && req.method === 'POST') {
      const r = DB.recharges.find((x) => x.id === body.id);
      if (!r) return send(res, 404, { error: 'পাওয়া যায়নি' });
      if (r.status === 'approved') return send(res, 200, { ok: true, already: true });
      const tu = DB.users[r.uid]; if (!tu) return send(res, 404, { error: 'user নেই' });
      r.status = 'approved'; r.approvedAt = now();
      tu.balance += r.amount;
      DB.txns.push({ id: newId('t_'), uid: tu.id, type: 'recharge', amount: r.amount, note: r.method + ' ' + r.txnid, at: now() });
      saveDb();
      return send(res, 200, { ok: true, balance: tu.balance });
    }
    if (route === '/api/admin/reject' && req.method === 'POST') {
      const r = DB.recharges.find((x) => x.id === body.id);
      if (r) { r.status = 'rejected'; saveDb(); }
      return send(res, 200, { ok: true });
    }
  }

  return send(res, 404, { error: 'not found' });
}

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.zip': 'application/zip', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveStatic(res, rel) {
  let fp = path.join(PUBLIC, rel);
  if (!fp.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
  if (!fs.existsSync(fp)) return send(res, 404, 'not found');
  const ext = path.extname(fp).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}

// ---------- server ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // CORS (extension/other origins)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname.startsWith('/api/')) return api(req, res, url).catch((e) => send(res, 500, { error: e.message }));
  if (url.pathname === '/' || url.pathname === '') return serveStatic(res, 'index.html');
  if (url.pathname === '/admin') return serveStatic(res, 'admin.html');
  return serveStatic(res, url.pathname.replace(/^\/+/, ''));
});
server.listen(CFG.port, () => console.log('RJ backend running on :' + CFG.port));
