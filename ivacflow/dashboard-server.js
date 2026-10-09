// dashboard-server.js — the IVAC Node dashboard, ivac-flow edition.
//
// Double-click IVAC.bat → this serves http://localhost:8777 with a table where
// you drop an index.js bundle and it extracts (live, offline) the real:
//   apiBase · slotId · dgepayUuid · initiatePath · all endpoints · request ছাঁচ
// and shows the cipher info. Save/Load to values.json.
//
// Honest scope: this does the OFFLINE bundle-extraction faithfully. The live
// probe / token bridge / rust push (which need a running site + real captcha)
// are shown as info only — not wired to a real backend here.
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { extract } = require('./extract-core');
const { buildTemplate } = require('./flow-template');       // pre-walk preview only
const { buildLiveTemplate } = require('./live-template');     // authoritative — 100% from the live walk
const { injectUploadExposure } = require('./upload-expose');  // expose the upload action for the walk
// transport-only headers that carry no app meaning — the only things dropped from
// the live capture. Everything else (x-device-id, sec-*, user-agent, …) is kept.
const HDR_NOISE = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'cookie', 'origin', 'referer']);
// build { "METHOD /path": {headers} } from the real intercepted calls so the
// template's per-step headers come LIVE from what the app actually sent.
function buildLiveByPath(calls) {
  const map = {};
  for (const c of (calls || [])) {
    if (!c || !c.url) continue;
    const p = String(c.url).replace(/^https?:\/\/[^/]+/, '');
    const entry = { headers: c.headers || {} };
    map[(c.method || '') + ' ' + p] = entry;   // method+path key
    map[p] = entry;                              // path-only key (loose match)
    const pq = p.replace(/\?.*$/, '');
    if (pq !== p) { map[(c.method || '') + ' ' + pq] = entry; map[pq] = entry; }
  }
  return map;
}
// cipher এখন headless browser দিয়ে বের হয় (সাইটের নিজের function) — extract-ciphers.js
// এর static key-extraction এর বদলে। table-এ একই key/skip/len/algo/output ভরে।
const { extractCiphersHeadless } = require('./cipher-headless');

// ═══ C-TOKEN POOL — relay raw → headless site-cipher → signin/reserve c ═══════
//  dashboard পেজের উপরে pool count table (signin/reserve/raw ready) দেখায়, আর
//  Go বট GET /captcha?role=signin|reserve|raw দিয়ে ready token টানে।
const { CipherBox } = require('./lib/cipherbox');
const POOL = { signin: [], reserve: [], raw: [] };
const POOL_TTL = 180000;                        // token আয়ু (raw আসার মুহূর্ত থেকে)
let   POOL_RELAY = String(process.env.RELAY_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const POOL_TARGET = { signin: 25, reserve: 25, raw: 20 };
let   POOL_WORKERS = 3;
const POOL_RAW_KEEP = 2;
let   POOL_ENABLED = false; // default STOPPED — user clicks ▶️ Start to begin pulling
const poolCipher = new CipherBox();
const poolSeen = new Map();
const poolStat = { pulled: 0, empty: 0, relayErr: '', relayOk: false, made: 0, failed: 0, fillErr: '', inflight: 0 };

function poolPrune(r) { const t = Date.now(); POOL[r] = POOL[r].filter(x => x.exp > t); return POOL[r]; }
function poolCounts() { return { signin: poolPrune('signin').length, reserve: poolPrune('reserve').length, raw: poolPrune('raw').length }; }
function poolSeenPrune() { const t = Date.now(); poolSeen.forEach((exp, k) => { if (exp <= t) poolSeen.delete(k); }); }
function poolAdd(role, value, exp, tried) {
  if (!POOL[role]) return { ok: false, error: 'bad role' };
  const q = poolPrune(role); poolSeenPrune();
  if (poolSeen.has(value)) return { ok: false, error: 'duplicate' };
  const until = exp || (Date.now() + POOL_TTL);
  if (until <= Date.now()) return { ok: false, error: 'expired' };
  q.push({ value, exp: until, tried: !!tried }); poolSeen.set(value, until);
  return { ok: true };
}
function poolTakeUntriedRaw() { const rq = poolPrune('raw'); for (let i = 0; i < rq.length; i++) if (!rq[i].tried) return rq.splice(i, 1)[0]; return null; }
function poolGiveBack(raw) { if (!raw || raw.exp <= Date.now()) return; poolSeen.delete(raw.value); poolAdd('raw', raw.value, raw.exp, true); }

function poolPullOne() {
  return new Promise((resolve) => {
    let done = false; const fin = v => { if (!done) { done = true; resolve(v); } };
    try {
      const req = http.get(POOL_RELAY + '/pull', { timeout: 8000 }, (res) => {
        const c = []; res.on('data', d => c.push(d));
        res.on('end', () => { try { const j = JSON.parse(Buffer.concat(c).toString('utf8') || '{}'); poolStat.relayOk = true; poolStat.relayErr = ''; fin(j && j.token ? String(j.token) : ''); } catch (_) { poolStat.relayErr = 'bad json'; fin(''); } });
      });
      req.on('error', e => { poolStat.relayOk = false; poolStat.relayErr = e.message; fin(''); });
      req.on('timeout', () => { poolStat.relayErr = 'timeout'; req.destroy(); fin(''); });
    } catch (e) { poolStat.relayErr = e.message; fin(''); }
  });
}
let poolPulling = false;
async function poolRelayTick() {
  if (!POOL_ENABLED || poolPulling) return;
  const need = POOL_TARGET.raw + POOL_TARGET.signin + POOL_TARGET.reserve;
  if (poolPrune('raw').length >= need) return;
  poolPulling = true;
  try { const tok = await poolPullOne(); if (tok) { if (poolAdd('raw', tok).ok) poolStat.pulled++; } else poolStat.empty++; }
  finally { poolPulling = false; }
}
function poolFillerTick() {
  if (!POOL_ENABLED) return;   // #6 Stop: halt c-making too (fully paused)
  if (!poolCipher.ready) return;
  for (const role of ['signin', 'reserve']) {
    while (poolStat.inflight < POOL_WORKERS && poolPrune(role).length + poolStat.inflight < POOL_TARGET[role]) {
      if (poolPrune('raw').length <= POOL_RAW_KEEP) break;
      const item = poolTakeUntriedRaw(); if (!item) break;
      poolStat.inflight++;
      ((raw, forRole) => {
        poolCipher.encrypt(raw.value, forRole).then(r => {
          poolStat.inflight--;
          if (r.ok) { const a = poolAdd(forRole, r.value, raw.exp); if (a.ok) { poolStat.made++; return; } poolStat.failed++; poolStat.fillErr = a.error; poolGiveBack(raw); return; }
          poolStat.failed++; poolStat.fillErr = r.error || 'unknown'; poolGiveBack(raw);
        }).catch(e => { poolStat.inflight--; poolStat.failed++; poolStat.fillErr = e.message; poolGiveBack(raw); });
      })(item, role);
    }
  }
}
function poolSweep() { ['signin', 'reserve', 'raw'].forEach(poolPrune); poolSeenPrune(); }
// bundle বদলালে আগের ঢাকা token বাদ (পুরনো cipher), cipher-ঘর নতুন করে গরম হয়
function poolUseBundle(file) { try { POOL.signin = []; POOL.reserve = []; poolCipher.use(file).catch(() => {}); } catch (_) {} }
// startup: আগের bundle থাকলে cipher-ঘর গরম করি
(function poolWarm() {
  const cand = [path.join(__dirname, '.cipher-bundle.js'), path.join(__dirname, '.host-bundle.js')];
  for (const f of cand) { try { if (fs.existsSync(f)) { poolCipher.use(f).catch(() => {}); break; } } catch (_) {} }
})();
setInterval(poolRelayTick, 400);
setInterval(poolFillerTick, 700);
setInterval(poolSweep, 5000);

// Keep chromium browser servers warm so each walk connects instantly instead
// of paying the ~3s cold start. One headless (background walks) + one headed
// (visible "browser-এ চালাও"). flow-capture connects via cfg.connectWs.
let chromiumLib = null;
try { chromiumLib = require('playwright').chromium; } catch (_) {}
const warmServers = { headless: null, headed: null };
function findChromeExe() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === 'chrome' || e.name === 'chrome.exe' || e.name === 'headless_shell' || e.name === 'chrome-headless-shell') return p;
    }
  }
  return undefined;
}
async function getWarmWs(headless) {
  if (!chromiumLib) return '';
  const key = headless ? 'headless' : 'headed';
  const s = warmServers[key];
  try {
    if (s && s.process() && s.process().exitCode == null && !s.process().killed) return s.wsEndpoint();
  } catch (_) {}
  const args = ['--no-first-run', '--no-default-browser-check'];
  try {
    let srv;
    try { srv = await chromiumLib.launchServer({ headless, args }); }
    catch (e) { const exe = findChromeExe(); if (!exe) throw e; srv = await chromiumLib.launchServer({ headless, args, executablePath: exe }); }
    warmServers[key] = srv;
    return srv.wsEndpoint();
  } catch (_) { return ''; }
}

const SITE = process.env.IVAC_SITE || 'https://appointment.ivacbd.com/';

// GET a URL as text (follows one level of asset resolution). Uses the system's
// network — works on the user's machine (may be blocked in a sandbox).
function httpGet(url, timeoutMs) {
  timeoutMs = timeoutMs || 30000;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    // browser-এর মতো পুরো header — Cloudflare অনেক সময় plain request-ও ছেড়ে দেয়,
    // তাই browser লঞ্চ ছাড়াই দ্রুত পথ খোলে।
    const headers = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9'
    };
    const req = mod.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(httpGet(new URL(res.headers.location, url).href, timeoutMs));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject); req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

// From the site HTML, find the big index-*.js asset URL and download it.
// Plain-HTTP fetch is blocked by Cloudflare (403) because it can't pass the
// browser challenge. Use the real browser (Playwright) to open the site, let
// Cloudflare clear, find the index bundle, and download it through the page's
// own (CF-cleared) session. Falls back to plain httpGet if the browser fails.
// ── WARM browser (একবার খোলে, বারবার reuse) ────────────────────────────────
// আগে প্রতি sync-এ নতুন Chromium launch হতো (~৩-৫s) + পুরো SPA লোডের অপেক্ষা
// (domcontentloaded, ভারী) → ~৩০s। এখন browser+context একবার খুলে গরম রাখি:
//   • প্রথম sync ছাড়া আর কখনো launch লাগে না
//   • CF cookie context-এ থেকে যায়, তাই পরের বার challenge নেই
//   • goto 'commit'-এ থামে (পুরো লোডের অপেক্ষা না) — Vite HTML-এ index.js এর
//     <script> ট্যাগ প্রথম response-এই থাকে, তাই সঙ্গে সঙ্গে পড়ে ফেলি
//   • bundle context.request দিয়ে নামাই (CF cookie সহ, দ্রুত)
let _warmBrowser = null, _warmCtx = null;
const _WARM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// syncHeadless reads config.json's "headless" for the SYNC browser. Cloudflare
// HARD-BLOCKS headless Chromium (it serves the challenge page forever, so the bundle
// <script> never appears). So the sync browser DEFAULTS TO HEADFUL (headless:false) —
// a real visible window passes CF exactly like the user's own browser. Set
// "syncHeadless": true in config.json only if the site has no CF and you want it hidden.
function syncHeadless() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    if (typeof c.syncHeadless === 'boolean') return c.syncHeadless;
  } catch (_) {}
  return false; // default: headful → passes Cloudflare
}

async function getWarmCtx() {
  if (_warmCtx) { try { await _warmCtx.pages(); return _warmCtx; } catch (_) { _warmCtx = null; _warmBrowser = null; } }
  if (!chromiumLib) throw new Error('playwright নেই');
  const headless = syncHeadless();
  // anti-detection: real UA, a windowed viewport, and args that reduce the automation
  // fingerprint so Cloudflare treats this like a genuine browser.
  const args = ['--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled',
    '--start-maximized'];
  try { _warmBrowser = await chromiumLib.launch({ headless, args }); }
  catch (e) { const exe = findChromeExe(); if (!exe) throw e; _warmBrowser = await chromiumLib.launch({ headless, args, executablePath: exe }); }
  _warmCtx = await _warmBrowser.newContext({
    userAgent: _WARM_UA,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  // hide navigator.webdriver — the classic headless tell Cloudflare checks.
  await _warmCtx.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (_) {}
  });
  _warmBrowser.on('disconnected', () => { _warmBrowser = null; _warmCtx = null; });
  console.log('[sync] browser ready (headless=' + headless + ')');
  return _warmCtx;
}
// pickBundleUrl — HTML থেকে app bundle এর URL বের করে, নাম-নিরপেক্ষভাবে।
// bundle এর নাম প্রতি deploy-এ বদলায় (hash), তাই নাম দিয়ে খোঁজা যাবে না।
// নিয়ম: script src যেটা সাইটের নিজের /assets/…js-এ থাকে সেটাই bundle;
// cloudflareinsights/beacon (external analytics) কখনো নয়।
function pickBundleUrl(html, site) {
  const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  const notBeacon = (s) => !/cloudflareinsights|\/beacon/i.test(s);
  let pick =
    srcs.find((s) => /(^|\/)assets\/[^"']+\.js(\?|$)/i.test(s) && notBeacon(s)) ||
    srcs.find((s) => /\.js(\?|$)/i.test(s) && notBeacon(s));
  return pick ? new URL(pick, site).href : '';
}
// browser path = আসল real-browser এর মতো (~৫s)। warm context reuse করে page খুলে
// goto → HTML থেকে bundle URL → page session-এই download (real browser যেভাবে করে)।
// আগের ctx.request-first চেষ্টা বাদ — সেটা CF ছাড়া hang করে ১৫s নষ্ট করত।
async function fetchBundleViaBrowser(site) {
  const t0 = Date.now();
  const ctx = await getWarmCtx();
  const page = await ctx.newPage();
  try {
    await page.goto(site, { waitUntil: 'commit', timeout: 30000 });
    console.log('[sync] goto committed +' + (Date.now() - t0) + 'ms');
    // Cloudflare shows a JS "checking your browser" interstitial FIRST; it auto-solves
    // in a few seconds and then loads the real SPA (whose HTML carries the bundle
    // <script>). So poll for the bundle for up to ~40s: while the page is still the CF
    // challenge, keep waiting; the moment the real page loads, pickBundleUrl finds it.
    let abs = '', sawCF = false;
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const html = await page.content().catch(() => '');
      abs = pickBundleUrl(html, site);
      if (abs) break;
      // detect the Cloudflare interstitial so the log explains the wait
      if (!sawCF && /just a moment|checking your browser|cf-browser-verification|challenge-platform|cloudflare/i.test(html)) {
        sawCF = true;
        console.log('[sync] Cloudflare challenge detected — waiting for it to clear…');
      }
      await page.waitForTimeout(300);
    }
    if (!abs) {
      throw new Error(sawCF
        ? 'Cloudflare challenge clear holo na (headless block?) — config.json e "syncHeadless": false rakhun, ba browser window ta ekbar hate solve korun'
        : 'bundle .js পাওয়া যায়নি (সাইট লোড হয়নি)');
    }
    console.log('[sync] bundle url found +' + (Date.now() - t0) + 'ms → ' + abs);
    // download in the page session — CF cookie সহ, real browser এর পথ।
    const js = await page.evaluate(async (u) => { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.text(); }, abs);
    console.log('[sync] bundle downloaded +' + (Date.now() - t0) + 'ms (' + js.length + ' bytes)');
    return { name: abs.split('/').pop().split('?')[0], js };
  } finally {
    await page.close().catch(() => {});   // page বন্ধ, browser+context গরম থাকে
  }
}
async function fetchBundleFromSite(site) {
  const t0 = Date.now();
  // ① খুব ছোট timeout-এ plain HTTP চেষ্টা (২.৫s)। সাইট plain request ছাড়লে
  //    তখনই নামে; না ছাড়লে দ্রুত fail করে browser-এ যায় (আগে ৮s নষ্ট হতো)।
  try {
    const html = await httpGet(site, 2500);
    const abs = pickBundleUrl(html, site);
    if (abs) {
      const js = await httpGet(abs, 15000);
      if (js && js.length > 1000) { console.log('[sync] via plain-HTTP +' + (Date.now() - t0) + 'ms'); return { name: abs.split('/').pop().split('?')[0], js }; }
    }
  } catch (eHttp) { console.log('[sync] plain-HTTP miss (' + eHttp.message + ') → browser'); }
  // ② browser (warm) — real browser এর মতো ~৫s।
  return await fetchBundleViaBrowser(site);
}
// startup-এ browser গরম করে রাখি (fire-and-forget) — প্রথম sync-ও যেন launch-এর
// জন্য অপেক্ষা না করে। playwright না থাকলে চুপচাপ বাদ।
setTimeout(() => { getWarmCtx().catch(() => {}); }, 1500);

const PORT = process.env.PORT || 8777;
const HOST_PORT = PORT + 1;   // dedicated origin that serves the loaded bundle AT ROOT (SPA)
const VALUES = path.join(__dirname, 'values.json');

// Serve the loaded bundle as a real SPA at http://localhost:HOST_PORT/ so the
// app's client-side router sees "/" and renders the real home/login (not 404).
// Any path returns the host HTML (SPA fallback); /assets/index.js returns the bundle.
const HOST_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>IVAC</title></head>' +
  '<body><div id="app"></div><div id="root"></div><div id="__nuxt"></div><div id="__next"></div>' +
  '<script type="module" src="/assets/index.js"></script></body></html>';
// expose the bundle's own upload action so the headless walk can fire a REAL
// /file/upload POST (the only request carrying x-sec-runtime-state), cached per src.
let _exposeCache = { src: null, out: null };
function serveBundleSrc(src) {
  if (_exposeCache.src === src) return _exposeCache.out;
  let out = src;
  try { const r = injectUploadExposure(src); out = r.src; if (r.ok) console.log('[host] upload-action exposed for walk:', r.name); } catch (_) {}
  _exposeCache = { src, out };
  return out;
}
http.createServer((q, s) => {
  if (q.url === '/assets/index.js') {
    if (!lastBundle.src) { s.writeHead(404); return s.end('// no bundle loaded'); }
    s.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' }); return s.end(serveBundleSrc(lastBundle.src));
  }
  s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); s.end(HOST_HTML);
}).listen(HOST_PORT, () => {}).on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log('\n  ⚠ IVAC Node আগে থেকেই চলছে (port ' + HOST_PORT + ' ব্যস্ত)।');
    console.log('  → এই window বন্ধ করে http://localhost:' + PORT + ' খুলুন,');
    console.log('    অথবা পুরনো IVAC window/টাস্ক বন্ধ করে আবার চালান।\n');
    process.exit(1);
  }
  throw e;
});
let snapshot = { config: null, template: [], allEndpoints: [], bundleName: '', at: '' };

// ── PUSH TO THE GO BOT ───────────────────────────────────────────────────────
// Whenever an extraction produces a fresh snapshot, hand it straight to the bot
// so nobody has to press Save and copy a file across. The bot keeps it as a
// FALLBACK: it fills only what the bot's own live scan could not resolve.
//
// config.json:
//   "botUrl"       — e.g. "http://127.0.0.1:8080"; leave empty to disable
//   "botTokenFile" — path to the bot's ivacflow_token.txt. The bot writes that
//                    file on first start and refuses a push without it.
let BOT_CFG = { url: '', tokenFile: '' };
try {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  BOT_CFG.url = (c && c.botUrl) || '';
  BOT_CFG.tokenFile = (c && c.botTokenFile) || '';
} catch (_) {}

function readBotToken() {
  const tries = [];
  if (BOT_CFG.tokenFile) tries.push(BOT_CFG.tokenFile);
  tries.push(path.join(__dirname, 'ivacflow_token.txt'));
  tries.push(path.join(__dirname, '..', 'ivacflow_token.txt'));
  for (const f of tries) {
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch (_) {}
  }
  return '';
}

// pushToBot sends the current snapshot to the bot. It never throws and never
// blocks: if the bot is down, or no botUrl is set, it logs one line and moves on.
let lastPushed = '';
function pushToBot(reason) {
  if (!BOT_CFG.url || !snapshot || !snapshot.config) return;
  const body = JSON.stringify(snapshot);
  if (body === lastPushed) return;   // several paths rebuild an identical snapshot
  const token = readBotToken();
  if (!token) {
    console.log('  ⚠ bot push skipped: ivacflow_token.txt পাওয়া যায়নি (বট একবার চালু করুন)');
    return;
  }
  let u; try { u = new URL('/api/ivacflowPush', BOT_CFG.url); } catch (_) { return; }
  const req = http.request({
    protocol: u.protocol, hostname: u.hostname, port: u.port,
    path: u.pathname, method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-ivacflow-token': token,
    },
    timeout: 8000,
  }, (res) => {
    let out = ''; res.on('data', (d) => { out += d; });
    res.on('end', () => {
      if (res.statusCode === 200) {
        lastPushed = body;
        console.log('  ✅ bot-এ push হলো (' + reason + ')');
      } else {
        console.log('  ⚠ bot push ব্যর্থ (HTTP ' + res.statusCode + '): ' + out.slice(0, 200));
      }
    });
  });
  req.on('timeout', () => { req.destroy(); });
  req.on('error', (e) => { console.log('  ⚠ bot push ব্যর্থ: ' + (e && e.message)); });
  req.end(body);
}
let lastBundle = { name: '', src: '' };   // raw source of the last-loaded bundle (for "browser-এ চালাও")

// Track the current flow-capture child so a new walk (or a new bundle load)
// terminates the previous one — otherwise background walks pile up and starve
// a freshly requested visible browser, making it take ages to appear.
let currentWalk = null;
function killWalk() {
  const c = currentWalk; currentWalk = null;
  if (!c || c.killed || c.exitCode != null) return;
  try {
    if (process.platform === 'win32') {
      cp.spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } else {
      c.kill('SIGKILL');
    }
  } catch (_) {}
}

function body(req) { return new Promise((res) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => res(d)); }); }

// Cipher extraction — NOW via a headless browser running the bundle's OWN cipher
// (cipher-headless.js), replacing the old static extract-ciphers.js key-parsing.
// Same return shape { roles:[{role,version,algo,skip,len,key,output}], code, verified }
// so the dashboard's Cipher table fills exactly as before. Async (~15-20s, one browser).
async function extractCiphers(srcText) {
  const out = { roles: [], code: '', verified: '' };
  try {
    // headless harness একটা ফাইল থেকে bundle পরিবেশন করে — srcText ডিস্কে বসাই
    const bundleFile = path.join(__dirname, '.cipher-bundle.js');
    fs.writeFileSync(bundleFile, srcText);
    const r = await extractCiphersHeadless(bundleFile);
    if (r && r.roles) out.roles = r.roles;
    if (r && r.code) { out.code = r.code; try { fs.writeFileSync(path.join(__dirname, '.cipher-out.js'), r.code); } catch (_) {} }
    if (r && r.verified) out.verified = r.verified;
    if (r && r.error) out.error = r.error;
  } catch (e) { out.error = e.message; }
  return out;
}

// read flow.json → per-call endpoint + payload fields + extra headers + cipher "c"
function readCaptured(dir) {
  let flow; try { flow = JSON.parse(fs.readFileSync(path.join(dir, 'flow.json'), 'utf8')); } catch (_) { return []; }
  // merge captured extracted values into snapshot config when bundle extraction missed them
  if (flow.extracted && snapshot.config) {
    // apiBase from the LIVE intercepted request URLs OVERRIDES the static default —
    // every real API call carries it, so the walk-derived value is authoritative.
    if (flow.extracted.apiBase) {
      snapshot.config.apiBase = flow.extracted.apiBase;
      snapshot.config.apiBaseNote = 'live-capture (from intercepted request URL)';
    }
    if (!snapshot.config.dgepayUuid && flow.extracted.dgepayUuid) {
      snapshot.config.dgepayUuid = flow.extracted.dgepayUuid;
      snapshot.config.dgepayUuidSource = 'flow-capture';
    }
    if (!snapshot.config.initiatePath && flow.extracted.initiatePath) {
      snapshot.config.initiatePath = flow.extracted.initiatePath;
      snapshot.config.initiatePathSource = 'flow-capture';
    }
    if (!snapshot.config.slotId && flow.extracted.slotId) {
      snapshot.config.slotId = flow.extracted.slotId;
      snapshot.config.slotIdSource = 'flow-capture';
    }
    if (flow.extracted.endpoints) {
      if (!snapshot.config.endpoints) snapshot.config.endpoints = {};
      for (const [k, v] of Object.entries(flow.extracted.endpoints)) {
        if (!snapshot.config.endpoints[k]) snapshot.config.endpoints[k] = v;
      }
    }
    if (Array.isArray(flow.extracted.tokenMap) && flow.extracted.tokenMap.length) {
      snapshot.config.tokenMap = flow.extracted.tokenMap;   // dynamic per-step encrypted/raw
    }
    pushToBot('walk');   // the runtime ids (slotId / dgepayUuid) just landed
  }
  // TEMPLATE = 100% from the live walk. Step list, order, method, path, headers
  // AND body all come from exactly what the bundle fired (flow.calls); per-run
  // values are placeholdered by VALUE (mock inputs + response-chained + tokens),
  // not by any hard-coded field name. A future bundle flows through unchanged.
  if (Array.isArray(flow.calls) && flow.calls.length) {
    const responses = Array.isArray(flow.mockResponses) ? { _r: flow.mockResponses } : (flow.mockResponses || {});
    snapshot.template = buildLiveTemplate(flow.calls, { mock: flow.mock || {}, responses });
  }
  return (flow.calls || []).map((c) => {
    let fields = null, cipher = ''; try { const j = JSON.parse(c.body || '{}'); fields = Object.keys(j); if (j.c) cipher = j.c; } catch (_) {}
    const H = c.headers || {}; const hdr = {};
    // keep ALL headers the request actually carried (minus pure transport noise)
    // so nothing — x-device-id included — is ever dropped from the capture view.
    for (const k of Object.keys(H)) { if (!HDR_NOISE.has(k.toLowerCase())) hdr[k] = H[k]; }
    return { method: c.method, url: c.url.replace(/^https?:\/\/[^/]+/, ''), payloadFields: fields, headers: hdr, cipher, xToken: H['x-token'] || '' };
  });
}
function markProbed(captured) {
  if (!snapshot.template || !snapshot.template.length) return;
  const seen = captured.map((c) => c.url);
  for (const s of snapshot.template) {
    const tail = s.path.replace(/^\/iams\/api\/v\d+/, '');
    if (seen.some((o) => o.includes(tail.split('/').slice(0, 3).join('/')))) s.probed = true;
  }
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

const HTML = `<!doctype html><html lang="bn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>IVAC Node</title>
<style>
 :root{--bg:#0f1115;--card:#171a21;--line:#262b36;--ink:#e6e9ef;--dim:#98a1b3;--accent:#4f8cff;--ok:#37c978;--bad:#ff5f5f;--warn:#ffb020;}
 @media(prefers-color-scheme:light){:root{--bg:#f4f6fa;--card:#fff;--line:#e2e6ee;--ink:#151922;--dim:#5d6879;}}
 *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,"Segoe UI",Roboto,sans-serif}
 .wrap{max-width:1060px;margin:0 auto;padding:24px 18px 60px}
 h1{font-size:21px;margin:0 0 18px}h2{font-size:14px;margin:0 0 12px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
 .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:14px}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}
 .stat{display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;font-size:14px}
 .stat b{font-weight:600}.mono{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;word-break:break-all}
 .ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.dim{color:var(--dim)}
 .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
 button{font:inherit;border:0;border-radius:9px;padding:9px 16px;cursor:pointer;background:var(--accent);color:#fff}
 button.ghost{background:transparent;border:1px solid var(--line);color:var(--ink);padding:7px 13px;font-size:13px}
 button:disabled{opacity:.45;cursor:not-allowed}
 table{width:100%;border-collapse:collapse;font-size:13px}
 td{padding:5px 8px 5px 0;border-bottom:1px solid var(--line);vertical-align:middle}
 th{text-align:left;color:var(--dim);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;padding:5px 8px 5px 0;border-bottom:1px solid var(--line)}
 .mini{font-size:11px;padding:3px 8px;border-radius:7px}
 .a-box{border:1px solid var(--line);border-radius:9px;padding:8px 10px;margin-bottom:8px}
 .a-box.raw{border-style:dashed;opacity:.75}
 textarea.a-code{width:100%;margin-top:6px;font-family:ui-monospace,Consolas,monospace;font-size:11px;background:transparent;border:1px solid var(--line);border-radius:7px;color:var(--ink);padding:6px 8px}
 td:first-child{width:180px;color:var(--dim);font-size:12.5px}
 .drop{border:2px dashed var(--line);border-radius:11px;padding:16px;text-align:center;cursor:pointer;font-size:14px}
 .drop:hover,.drop.over{border-color:var(--accent)}
 .badge{font-size:11px;padding:2px 9px;border-radius:99px}.badge.ok{background:rgba(55,201,120,.16)}.badge.bad{background:rgba(255,95,95,.16)}
 .log{font:12px/1.7 ui-monospace,Consolas,monospace;color:var(--dim);max-height:150px;overflow:auto;white-space:pre-wrap;margin-top:8px}
 .prog{margin-top:12px;display:none}
 .prog.on{display:block}
 .prog .plabel{font-size:12.5px;margin-bottom:6px;display:flex;justify-content:space-between;gap:10px}
 .prog .bar{height:11px;border-radius:99px;background:var(--line);overflow:hidden}
 .prog .fill{height:100%;width:0;background:var(--accent);transition:width .45s ease;border-radius:99px}
 .prog .steps{font-size:11px;margin-top:7px;color:var(--dim);line-height:1.9}
 .hide{display:none}
</style></head><body><div class="wrap">
 <h1>IVAC Node <span class="dim" style="font-size:12px">— ivac-flow edition (offline bundle extractor)</span></h1>

 <!-- ═══ C-TOKEN POOL (relay raw → headless site-cipher → signin/reserve c) ═══ -->
 <div class="card" id="pool-card" style="border:1px solid rgba(45,212,191,.35)">
   <h2>🏭 C-Token Pool <span class="dim" style="font-size:11px">— relay থেকে raw, সাইটের cipher দিয়ে c · Go বট: GET /captcha?role=signin|reserve|raw</span></h2>
   <table style="width:100%;border-collapse:collapse;font-size:13px">
     <thead><tr style="color:#7dd3fc;text-align:left"><th style="padding:4px 6px">Role</th><th>Ready</th><th style="width:42%">Fill</th><th>Target</th></tr></thead>
     <tbody>
       <tr><td style="padding:5px 6px"><b>🔐 signin</b> <span class="dim" style="font-size:11px">c</span></td>
           <td><b id="pc-signin" class="mono" style="font-size:18px;color:#4ade80">0</b></td>
           <td><div style="height:7px;background:#12233a;border-radius:5px;overflow:hidden"><i id="pb-signin" style="display:block;height:100%;width:0;background:linear-gradient(90deg,#22c55e,#4ade80)"></i></div></td>
           <td><input type="number" id="pt-signin" min="0" max="500" value="25" style="width:60px"></td></tr>
       <tr><td style="padding:5px 6px"><b>🎟 reserve</b> <span class="dim" style="font-size:11px">c</span></td>
           <td><b id="pc-reserve" class="mono" style="font-size:18px;color:#7dd3fc">0</b></td>
           <td><div style="height:7px;background:#12233a;border-radius:5px;overflow:hidden"><i id="pb-reserve" style="display:block;height:100%;width:0;background:linear-gradient(90deg,#0ea5e9,#7dd3fc)"></i></div></td>
           <td><input type="number" id="pt-reserve" min="0" max="500" value="25" style="width:60px"></td></tr>
       <tr><td style="padding:5px 6px"><b>🪙 raw</b> <span class="dim" style="font-size:11px">pay/upload</span></td>
           <td><b id="pc-raw" class="mono" style="font-size:18px;color:#c4b5fd">0</b></td>
           <td><div style="height:7px;background:#12233a;border-radius:5px;overflow:hidden"><i id="pb-raw" style="display:block;height:100%;width:0;background:linear-gradient(90deg,#a855f7,#c4b5fd)"></i></div></td>
           <td><input type="number" id="pt-raw" min="0" max="500" value="20" style="width:60px"></td></tr>
     </tbody>
   </table>
   <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">
     <button id="pool-power" title="Start = relay/firm theke token tanbe o c banabe. Stop = token tana bondho." style="border:0;border-radius:6px;padding:6px 11px;font-weight:800;font-size:12px;cursor:pointer;color:#fff;background:#16a34a">▶️ Start</button>
     <span class="dim" style="font-size:12px">worker</span><input type="number" id="pt-workers" min="1" max="8" value="3" style="width:52px">
     <button id="pool-save" style="border:0;border-radius:6px;padding:6px 11px;font-weight:800;font-size:12px;cursor:pointer;color:#fff;background:linear-gradient(135deg,#6366f1,#4f46e5)">💾 Save</button>
     <button id="pool-clear" style="border:0;border-radius:6px;padding:6px 11px;font-weight:800;font-size:12px;cursor:pointer;color:#fff;background:#7f1d1d">🗑 Clear</button>
     <span id="pool-status" class="dim" style="font-size:11px;margin-left:auto">—</span>
   </div>
 </div>
 <script>
 (function(){
   var ed=false;['pt-signin','pt-reserve','pt-raw','pt-workers'].forEach(function(id){var e=document.getElementById(id);if(!e)return;e.addEventListener('focus',function(){ed=true;});e.addEventListener('blur',function(){setTimeout(function(){ed=false;},1500);});});
   function bar(id,r,t){var p=t>0?Math.min(100,Math.round(r/t*100)):(r>0?100:0);var el=document.getElementById(id);if(el)el.style.width=p+'%';}
   function poll(){fetch('/api/pool').then(function(r){return r.json();}).then(function(s){
     if(!s||!s.ok)return;
     document.getElementById('pc-signin').textContent=s.pool.signin;
     document.getElementById('pc-reserve').textContent=s.pool.reserve;
     document.getElementById('pc-raw').textContent=s.pool.raw;
     bar('pb-signin',s.pool.signin,s.target.signin);bar('pb-reserve',s.pool.reserve,s.target.reserve);bar('pb-raw',s.pool.raw,s.target.raw);
     if(!ed){document.getElementById('pt-signin').value=s.target.signin;document.getElementById('pt-reserve').value=s.target.reserve;document.getElementById('pt-raw').value=s.target.raw;document.getElementById('pt-workers').value=s.workers;}
     var cip=s.cipher.ready?('cipher ✓'+(s.cipher.pin?(' ['+s.cipher.pin+']'):'')):('cipher warming'+(s.cipher.error?(': '+s.cipher.error):'…'));
     var rel=s.relay.ok?('relay ✓ '+s.relay.pulled):('relay ✗ '+(s.relay.err||''));
     document.getElementById('pool-status').textContent=cip+' · '+rel+' · made '+s.fill.made+(s.fill.err?(' · '+s.fill.err):'');
     var pw=document.getElementById('pool-power');
     if(pw){ var on=(s.enabled!==false); pw.textContent=on?'⏸️ Stop':'▶️ Start'; pw.style.background=on?'#b91c1c':'#16a34a'; pw.dataset.on=on?'1':'0'; }
   }).catch(function(){var e=document.getElementById('pool-status');if(e)e.textContent='server?';});}
   var sb=document.getElementById('pool-save');if(sb)sb.onclick=function(){var b={signin:+document.getElementById('pt-signin').value,reserve:+document.getElementById('pt-reserve').value,raw:+document.getElementById('pt-raw').value,workers:+document.getElementById('pt-workers').value};fetch('/api/pool-set',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});ed=false;this.textContent='✓';var s=this;setTimeout(function(){s.textContent='💾 Save';},1000);};
   var cb=document.getElementById('pool-clear');if(cb)cb.onclick=function(){if(confirm('pool খালি করবেন?'))fetch('/api/pool-clear',{method:'POST'}).then(poll);};
   var pw=document.getElementById('pool-power');if(pw)pw.onclick=function(){var turnOn=(pw.dataset.on!=='1');fetch('/api/pool-power',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({on:turnOn})}).then(poll);};
   poll();setInterval(poll,1000);
 })();
 </script>

 <div class="grid">
   <div class="card"><h2>Bundle</h2>
     <div class="stat"><span>অবস্থা</span><b id="s-state"><span class="dim">bundle দিন</span></b></div>
     <div class="stat"><span>ফাইল</span><b id="s-file" class="mono dim">—</b></div>
     <div class="stat"><span>সর্বশেষ</span><b id="s-at" class="mono dim">—</b></div>
   </div>
   <div class="card"><h2>Config</h2>
     <div class="stat"><span>apiBase</span><b id="c-api" class="mono dim">—</b></div>
     <div class="stat"><span>slotId</span><b id="c-slot" class="mono dim">—</b></div>
     <div class="stat"><span>dgepayUuid</span><b id="c-uuid" class="mono dim">—</b></div>
     <div class="stat"><span>initiatePath</span><b id="c-init" class="mono dim">—</b></div>
   </div>
   <div class="card"><h2>Cipher</h2>
     <div class="stat"><span>system</span><b><span class="ok">bundle-এ আছে</span></b></div>
     <div class="dim" style="font-size:12px;margin-top:4px">cipher <b>system</b> (algorithm+key) কোড থেকে extract করা — cipher.go / rjenc.js।
       cipher <b>"c" এর মান</b> এখানে আসে না: runtime-এ আসল captcha token লাগে।</div>
   </div>
 </div>

 <div class="card"><h2>Sync <span class="dim" style="font-size:11px">— সার্ভার open হলে নিজে bundle নামিয়ে target extract করে (প্রতি ২s)</span></h2>
   <div class="row">
     <input type="text" id="site" value="https://appointment.ivacbd.com/" style="flex:1;min-width:200px;background:transparent;border:1px solid var(--line);border-radius:7px;padding:7px 9px;color:var(--ink);font:12.5px ui-monospace,monospace">
     <button id="sync">▶ Sync চালু</button>
     <button id="live" class="ghost">🔴 Live capture</button>
     <span class="dim" id="sync-note" style="font-size:12.5px">বন্ধ</span>
   </div>
   <div class="dim" id="resp-note" style="font-size:11px;margin-top:4px"></div>
   <div class="dim" style="font-size:11px;margin-top:5px">open হওয়ামাত্র bundle auto-নামায়। sync fail করলে নিচে ম্যানুয়ালি bundle দিন — একই জিনিস বের হবে।</div>
 </div>

 <div class="card"><h2>Bundle লোড</h2>
   <div class="drop" id="drop">index.js bundle টেনে আনুন, বা <b>ক্লিক করে বেছে নিন</b></div>
   <input type="file" id="file" accept=".js,.txt" class="hide">
   <div class="row" style="margin-top:12px">
     <button class="ghost" id="fetch">সাইট থেকে এখনই নামাও</button>
     <button class="ghost" id="probe" title="loaded bundle একটা browser window-তে চালিয়ে signin→initiate mock data দিয়ে হাঁটে, data ধরে">🖐 browser-এ চালাও</button>
     <button class="ghost" id="demo" title="৯ ধাপ signin→initiate mock walk — দৃশ্যমান window-তে চোখের সামনে">▶ Demo (দৃশ্যমান)</button>
     <button class="ghost" id="save" disabled>Save → values.json</button>
     <button class="ghost" id="load">Load values.json</button>
     <span class="dim" id="note" style="font-size:13px"></span>
   </div>
   <div class="row" style="margin-top:8px;font-size:12px">
     <label style="cursor:pointer"><input type="checkbox" id="cb-bundle" checked> loaded bundle চালাও (আপলোড করা index.js)</label>
     <label style="cursor:pointer"><input type="checkbox" id="cb-visible" checked> দৃশ্যমান window</label>
   </div>
   <div class="prog" id="prog">
     <div class="plabel"><span id="prog-done" class="dim">০/৭ ধাপ সম্পন্ন — ০%</span><span id="prog-rem" class="warn">বাকি ১০০%</span></div>
     <div class="bar"><div class="fill" id="prog-fill"></div></div>
     <div class="steps" id="prog-steps"></div>
   </div>
   <div class="log" id="log"></div>
 </div>

 <!-- Probe result runs internally (drives progress + cipher); hidden from the UI. -->
 <div class="card hide"><h2>Probe result</h2><div id="cap" class="dim"></div></div>

 <div class="card"><h2>Request ছাঁচ <span class="dim" style="font-size:11px">— সাইট যেভাবে পাঠায়, bot এতে শুধু মান বসায়</span></h2>
   <div id="tpl" class="dim">bundle দিলে এখানে সব ধাপের endpoint + header + body দেখা যাবে।</div>
 </div>

 <div class="card"><h2>Cipher</h2>
   <div id="cipher-box" class="dim">bundle চালালে প্রতিটা role-এর cipher (version · startAt · length · algorithm + cipher string) এখানে দেখা যাবে।</div>

   <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:10px">
     <div class="stat" style="padding-bottom:0">
       <span>🔑 standalone algorithm <span class="dim" style="font-size:11px">— টেবিল, Node ছাড়াই চলে</span></span>
       <b id="a-state"><span class="dim">— function পরে</span></b>
     </div>
     <div class="dim" id="a-same" style="font-size:12px;margin:2px 0 8px"></div>
     <div id="a-roles">
       <div class="a-box" data-role="signin"><b>signin</b> <span class="badge">টেবিল — function পরে</span> <span class="badge">startAt — · length —</span> <span class="dim">algorithm —</span>
         <div class="dim" style="font-size:11.5px;margin-top:3px">যাচাই: — <span class="dim">(function পরে)</span></div>
         <div style="display:flex;gap:6px;margin-top:6px"><button class="mini ghost a-copy" data-role="signin" disabled>📋 signin-এর কোড কপি</button><button class="mini ghost a-one" data-role="signin" disabled>শুধু এইটা আবার</button></div>
         <textarea class="a-code" readonly style="height:90px" placeholder="(function যোগ হলে এখানে signin-এর standalone code — table + function — বসবে)"></textarea></div>
       <div class="a-box" data-role="reserve"><b>reserve</b> <span class="badge">টেবিল — function পরে</span> <span class="badge">startAt — · length —</span> <span class="dim">algorithm —</span>
         <div class="dim" style="font-size:11.5px;margin-top:3px">যাচাই: — <span class="dim">(function পরে)</span></div>
         <div style="display:flex;gap:6px;margin-top:6px"><button class="mini ghost a-copy" data-role="reserve" disabled>📋 reserve-এর কোড কপি</button><button class="mini ghost a-one" data-role="reserve" disabled>শুধু এইটা আবার</button></div>
         <textarea class="a-code" readonly style="height:90px" placeholder="(function যোগ হলে এখানে reserve-এর standalone code — table + function — বসবে)"></textarea></div>
       <div class="a-box raw" data-role="upload"><b>upload</b> <span class="badge">RAW — টেবিল লাগে না</span>
         <div class="dim" style="font-size:11.5px;margin-top:3px">এই bundle-এ upload-এ কাঁচা token গেলে টেবিল ফাঁকা। ঢাকা শুরু হলে এখানেই টেবিল বসবে।</div>
         <textarea class="a-code" readonly style="height:44px" placeholder="(ফাঁকা — raw token)"></textarea>
         <div style="margin-top:6px"><button class="mini ghost a-one" data-role="upload" disabled>তবু চেষ্টা করে দেখো</button></div></div>
       <div class="a-box raw" data-role="pay"><b>pay</b> <span class="badge">RAW — টেবিল লাগে না</span>
         <div class="dim" style="font-size:11.5px;margin-top:3px">এই bundle-এ pay-এ কাঁচা token গেলে টেবিল ফাঁকা। ঢাকা শুরু হলে এখানেই টেবিল বসবে।</div>
         <textarea class="a-code" readonly style="height:44px" placeholder="(ফাঁকা — raw token)"></textarea>
         <div style="margin-top:6px"><button class="mini ghost a-one" data-role="pay" disabled>তবু চেষ্টা করে দেখো</button></div></div>
     </div>
     <button id="a-run" class="ghost" style="margin-top:8px;font-size:12px;padding:6px 12px" disabled>দুইটাই আবার বের করো <span class="dim">(function পরে)</span></button>
   </div>
 </div>

 <div class="card"><h2>Token usage <span class="dim" style="text-transform:none;font-size:12px">— কোন step-এ token encrypted (c) না raw (x-token), walk থেকে dynamic</span></h2>
   <table id="token-table"><thead><tr><th>step</th><th>field</th><th>form</th></tr></thead>
     <tbody id="token-body"><tr><td colspan="3" class="dim">bundle চালালে প্রতিটা step-এ token কীভাবে যায় (encrypted / raw) এখানে দেখা যাবে।</td></tr></tbody>
   </table>
 </div>

 <div class="card"><h2>Endpoint <span class="dim" style="text-transform:none;font-size:12px">— walk + bundle থেকে</span></h2>
   <table id="ep-table"><tbody><tr><td colspan="2" class="dim">bundle চালালে এখানে প্রতিটা endpoint (verify badge সহ) দেখা যাবে।</td></tr></tbody></table>
 </div>

 <div class="card"><h2>Payload key · Extra header · Gating</h2>
   <table id="dyn-table"><tbody><tr><td colspan="2" class="dim">bundle চালালে payload key / extra header / gating এখানে দেখা যাবে।</td></tr></tbody></table>
 </div>

 <div class="card"><h2>সব API path <span class="dim" id="ep-count"></span></h2>
   <div id="eps" class="mono dim" style="font-size:12px">—</div>
 </div>

<script>
const $=id=>document.getElementById(id);
const drop=$('drop'),file=$('file'),log=$('log');
function addLog(t){log.textContent+=t+"\\n";log.scrollTop=log.scrollHeight;}
drop.onclick=()=>file.click();
['dragover','dragenter'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('over');}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove('over');}));
drop.addEventListener('drop',ev=>{const f=ev.dataTransfer.files[0];if(f)send(f);});
file.onchange=()=>{if(file.files[0])send(file.files[0]);};
$('fetch').onclick=async()=>{
  addLog('⬇ সাইট থেকে bundle নামাচ্ছি…');$('note').textContent='নামছে…';
  const r=await fetch('/api/fetch-bundle',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  const j=await r.json();
  if(j.ok){addLog('✅ নামানো হলো — '+j.bundleName+' · cipher ready → pool চলবে');render(j);$('save').disabled=false;startAutoWalk();}
  else{addLog('❌ '+j.error);$('note').textContent='❌ '+j.error+' (এই মেশিনে ইন্টারনেট/সাইট লাগবে)';}
};
let pollTimer=null,autoTimer=null;
async function startAutoWalk(){
  addLog('⚙ background full-extract শুরু (দৃশ্যমান নয়) — dgepayUuid/initiatePath বের করছি…');
  $('note').textContent='background এ full extract হচ্ছে…';
  resetProgress();  // switch bar to the 7-step flow tracker at 0%
  const r=await fetch('/api/auto-walk',{method:'POST'}).then(x=>x.json()).catch(()=>null);
  if(!r||!r.ok){addLog('⚠ background walk: '+((r&&r.error)||'শুরু করা গেল না')+' — static ফল দেখানো হলো');$('note').textContent='done (static)';return;}
  if(autoTimer)clearInterval(autoTimer);
  let ticks=0;
  autoTimer=setInterval(async()=>{
    ticks++;
    const f=await fetch('/api/probe-flow').then(x=>x.json()).catch(()=>null);
    if(f&&f.ok){
      renderCap(f.captured||[]);         // updates captured panel + progress bar
      if(f.config)render(f);             // live-update CONFIG (dgepayUuid/initiatePath fill in)
      const done=(f.captured||[]).some(c=>String(c.url||'').indexOf('initiate')>=0);
      if(done){clearInterval(autoTimer);autoTimer=null;addLog('✅ full extract সম্পন্ন — সব field পাওয়া গেছে');$('note').textContent='✅ সম্পূর্ণ';return;}
    }
    if(ticks>80){clearInterval(autoTimer);autoTimer=null;addLog('⚠ walk timeout — যা পাওয়া গেছে দেখানো হলো');$('note').textContent='done (partial)';}
  },1500);
}
$('probe').onclick=async()=>{
  resetProgress();
  const useBundle=$('cb-bundle').checked, visible=$('cb-visible').checked;
  addLog('🖐 browser-এ চালাও — '+(useBundle?'loaded bundle (দৃশ্যমান, নিজে হাতে)':(visible?'সাইট দৃশ্যমান':'সাইট headless'))+'…');
  $('note').textContent='চলছে…';
  const r=await fetch('/api/probe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({useBundle,headless:!visible})});
  const j=await r.json();
  if(!j.ok){addLog('❌ probe: '+j.error);$('note').textContent='❌ probe: '+j.error;return;}
  if(j.manual){
    addLog('✅ '+(j.note||'window খুলেছে — নিজে হাতে চালান।'));
    addLog('   → popup বন্ধ করুন → Sign In → phone/password/OTP যা খুশি দিন (mock, তাই যেকোনো মান চলবে) → পরের ধাপে যান।');
    $('note').textContent='দৃশ্যমান window-এ নিজে হাতে চালান — ডেটা live আসছে…';
    if(pollTimer)clearInterval(pollTimer);
    pollTimer=setInterval(async()=>{
      const f=await fetch('/api/probe-flow').then(x=>x.json()).catch(()=>null);
      if(f&&f.ok){renderCap(f.captured||[]);if(f.template)renderTpl(f.template);if(f.config)render(f);}
    },2000);
    return;
  }
  addLog('✅ probe শেষ — '+j.observed.length+' টা request ধরা পড়েছে');
  if(j.config)render(j);
  if(j.template)renderTpl(j.template);renderCap(j.captured||[]);$('note').textContent='probe done';
};
const FLOW_STEPS=[
  {label:'Sign-in',re:/sign-?in/i},
  {label:'OTP verify',re:/otp\\/[a-z0-9-]*verify/i},
  {label:'File overview',re:/over-?view/i},
  {label:'Booking config',re:/get-booking-config/i},
  {label:'Slot reserve',re:/reserve-slot/i},
  {label:'Payment amount',re:/payment-amount/i},
  {label:'Payment initiate',re:/payment\\/.*initiate/i},
];
function setBar(pct,doneText,remText,stepsHtml){
  $('prog').classList.add('on');
  pct=Math.max(0,Math.min(100,Math.round(pct)));
  $('prog-fill').style.width=pct+'%';
  $('prog-done').textContent=doneText;
  $('prog-rem').textContent=remText;
  $('prog-rem').className=(pct>=100)?'ok':'warn';
  $('prog-steps').innerHTML=stepsHtml||'';
}
function renderProgress(captured){
  const urls=(captured||[]).map(e=>String((e&&e.url)||''));
  let done=0,chips='';
  for(const s of FLOW_STEPS){
    // obfuscated bundles swap - and _ in path names (reserve_slot vs reserve-slot),
    // so normalise separators before the step regex — else a real step shows as undone.
    const hit=urls.some(u=>s.re.test(u.replace(/[-_]+/g,'-')));
    if(hit)done++;
    chips+='<span style="margin-right:12px;white-space:nowrap">'+(hit?'✅':'⬜')+' '+s.label+'</span>';
  }
  const total=FLOW_STEPS.length;
  const pct=Math.round(done/total*100), rem=100-pct;
  setBar(pct, done+'/'+total+' ধাপ সম্পন্ন — '+pct+'%', rem===0?'✅ সম্পূর্ণ':'বাকি '+rem+'%', chips);
}
function resetProgress(){renderProgress([]);}
function stepName(url){
  const u=String(url||'');
  const n=u.replace(/[-_]+/g,'-');   // normalise - / _ so obfuscated paths still match
  if(/sign-?in/i.test(n))return'SIGN IN';
  if(/otp\\/verif/i.test(n))return'VERIFY OTP';
  if(/reserve-slot/i.test(n))return'RESERVE';
  if(/payment\\/.*initiate/i.test(n))return'PAYMENT INITIATE';
  if(/upload/i.test(n))return'PRIMARY UPLOAD';
  return u.replace(/^\\/iams\\/api\\/v\\d+/,'')||u;
}
function renderCipher(c){
  let h='';
  for(const e of (c||[])){
    // a step carries a cipher when its body has "c" or it sends an x-token header
    const hasC=!!e.cipher, xtok=(e.headers&&e.headers['x-token'])||'';
    if(!hasC && !xtok)continue;
    const field=hasC?'c':'x-token';
    const val=hasC?e.cipher:xtok;
    // startAt (skip), version, algorithm need the cipher-solver — added later; field+length known now
    h+='<div style="margin-bottom:8px">'+
       '<b>'+esc(stepName(e.url))+'</b> <span class="badge ok">ধরা পড়েছে</span> '+
       '<span class="badge">field '+field+' · startAt — · length '+String(val||'').length+' · algorithm —</span> '+
       '<span class="dim" style="font-size:11px">(startAt/algorithm — function পরে)</span>'+
       '<div class="mono dim" style="font-size:11px;word-break:break-all">'+esc(String(val||'').slice(0,64))+(String(val||'').length>64?'…':'')+'</div>'+
       '</div>';
  }
  $('cipher-box').innerHTML=h||'<span class="dim">কোনো cipher field ধরা পড়েনি।</span>';
}
function renderCap(c){
  renderProgress(c);
  renderCipher(c);
  if(!c.length){$('cap').innerHTML='<span class="dim">কোনো request ধরা পড়েনি (selector মিলল না, বা সাইট লোড হয়নি)।</span>';return;}
  let h='';
  for(const e of c){
    h+='<div style="border-top:1px solid var(--line);padding:10px 0">';
    h+='<div><span class="badge ok">ধরা পড়েছে</span> <b class="mono">'+e.method+' '+esc(e.url)+'</b></div>';
    if(e.payloadFields)h+='<div style="font-size:12px;margin:3px 0"><span class="dim">payload:</span> '+e.payloadFields.map(esc).join(', ')+'</div>';
    const hk=Object.keys(e.headers||{});
    if(hk.length){h+='<table>';for(const k of hk)h+='<tr><td>'+k+'</td><td class="mono">'+esc(e.headers[k])+'</td></tr>';h+='</table>';}
    if(e.cipher)h+='<div style="font-size:12px;margin-top:3px"><span class="dim">cipher c:</span> <span class="mono warn">'+esc(e.cipher.slice(0,60))+(e.cipher.length>60?'…':'')+'</span> <span class="dim">(mock token → গঠন আসল, মান নয়)</span></div>';
    h+='</div>';
  }
  $('cap').innerHTML=h;
}
$('demo').onclick=async()=>{
  resetProgress();
  addLog('▶ Demo — signin→initiate ৯ ধাপ mock walk, দৃশ্যমান window খুলছে…');$('note').textContent='demo চলছে…';
  const r=await fetch('/api/probe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({demo:true,headless:false})});
  const j=await r.json();
  if(j.ok){addLog('✅ demo শেষ — '+j.observed.length+' ধাপ ধরা পড়েছে');if(j.config)render(j);renderCap(j.captured||[]);$('note').textContent='demo done';}
  else{addLog('❌ demo: '+j.error);$('note').textContent='❌ '+j.error;}
};
$('save').onclick=async()=>{const r=await fetch('/api/save',{method:'POST'});$('note').textContent=(await r.json()).ok?'✅ saved → values.json':'❌ save ব্যর্থ';};
$('load').onclick=async()=>{const r=await fetch('/api/load');if(!r.ok){$('note').textContent='values.json নেই';return;}render(await r.json());$('note').textContent='loaded values.json';};

function send(f){
  addLog('⬆ '+f.name+' ('+(f.size/1048576).toFixed(2)+' MB) পাঠানো হচ্ছে…');
  $('note').textContent='আপলোড হচ্ছে…';
  setBar(0,'পড়া হচ্ছে…','বাকি ১০০%','');
  const reader=new FileReader();
  reader.onprogress=(e)=>{ if(e.lengthComputable){const p=Math.round(e.loaded/e.total*15);setBar(p,'ফাইল পড়া হচ্ছে… '+p+'%','বাকি '+(100-p)+'%','');} };
  reader.onerror=()=>{ addLog('❌ ফাইল পড়া যায়নি'); $('note').textContent='❌ ফাইল পড়া যায়নি'; };
  reader.onload=()=>{
    const text=reader.result;
    const xhr=new XMLHttpRequest();
    xhr.open('POST','/api/extract?name='+encodeURIComponent(f.name));
    xhr.setRequestHeader('content-type','text/plain');
    xhr.upload.onprogress=(e)=>{
      if(e.lengthComputable){
        const p=15+Math.round(e.loaded/e.total*70);   // 15%→85% during upload
        setBar(p,'আপলোড হচ্ছে… '+p+'%','বাকি '+(100-p)+'%','');
      }
    };
    xhr.upload.onload=()=>{
      let p=85; setBar(p,'ডিকোড হচ্ছে… '+p+'%','বাকি '+(100-p)+'%','');
      $('note').textContent='decoding…';
      if(window.__decTimer)clearInterval(window.__decTimer);
      window.__decTimer=setInterval(()=>{ p=Math.min(97,p+1); setBar(p,'ডিকোড হচ্ছে… '+p+'%','বাকি '+(100-p)+'%',''); },150);
    };
    xhr.onload=()=>{
      if(window.__decTimer){clearInterval(window.__decTimer);window.__decTimer=null;}
      let j={}; try{j=JSON.parse(xhr.responseText);}catch(_){}
      setBar(100,'✅ ডিকোড সম্পন্ন — ১০০%','✅ সম্পূর্ণ','');
      addLog('✅ decode শেষ — '+(j.config&&j.config.dgepayUuid?'dgepayUuid static-এ পাওয়া গেছে':'dgepayUuid static-এ নেই → background walk চালাচ্ছি'));
      render(j); $('save').disabled=false;
      startAutoWalk();   // background full-extract — endpoint/payload/header/slot/dgepay তোলে
    };
    xhr.onerror=()=>{ if(window.__decTimer){clearInterval(window.__decTimer);window.__decTimer=null;} addLog('❌ আপলোড ব্যর্থ'); $('note').textContent='❌ আপলোড ব্যর্থ'; };
    xhr.send(text);
  };
  reader.readAsText(f);
}
function chip(f){return f?'<span class="badge ok">যাচাই ✓</span>':'<span class="badge bad">fallback</span>';}
function val(v){return v?'<span class="ink">'+v+'</span>':'<span class="bad">(not found)</span>';}
function render(j){
  const c=j.config||{};
  $('s-state').innerHTML='<span class="ok">প্রস্তুত</span>';
  $('s-file').textContent=j.bundleName||'—';
  $('s-at').textContent=j.at||'—';
  $('c-api').innerHTML=val(c.apiBase); $('c-slot').innerHTML=val(c.slotId);
  $('c-uuid').innerHTML=val(c.dgepayUuid); $('c-init').innerHTML=val(c.initiatePath);
  renderTpl(j.template||[]);
  if(c.ciphers)renderCipherExtract(c.ciphers);
  renderTokenMap(c.tokenMap);
  renderEndpoints(c);
  renderDynamic(c);
  const eps=j.allEndpoints||[];
  $('ep-count').textContent='('+eps.length+')';
  $('eps').innerHTML=eps.length?eps.map(e=>esc(e)).join('<br>'):'—';
}
function renderCipherExtract(cx){
  const roles=(cx&&cx.roles)||[];
  if(!roles.length)return;   // keep the captured-based summary if extractor found nothing
  // top summary
  let h='';
  for(const r of roles){
    h+='<div style="margin-bottom:8px"><b>'+esc(r.role)+'</b> <span class="badge ok">যাচাই ✓</span> '+
       '<span class="badge">v'+esc(r.version)+' · startAt '+r.skip+' · length '+r.len+' · '+esc(r.algo)+'</span>'+
       '<div class="mono dim" style="font-size:11px;word-break:break-all">key: '+esc(String(r.key).slice(0,48))+(String(r.key).length>48?'…':'')+'</div></div>';
  }
  $('cipher-box').innerHTML=h;
  if(cx.verified)$('a-state').innerHTML='<span class="ok">যাচাই হয়েছে ✓ '+esc(cx.verified)+'</span>';
  // per-role standalone code boxes
  const byRole={}; for(const r of roles)byRole[(r.role||'').toLowerCase()]=r;
  document.querySelectorAll('#a-roles .a-box').forEach(box=>{
    const rk=box.getAttribute('data-role');
    const r=byRole[rk];
    const badges=box.querySelectorAll('.badge');
    const ta=box.querySelector('.a-code');
    if(r){
      if(badges[0])badges[0].textContent=r.algo;
      if(badges[1])badges[1].textContent='startAt '+r.skip+' · length '+r.len;
      if(ta&&cx.code){ta.value=cx.code;ta.placeholder='';}
      box.querySelectorAll('button').forEach(b=>b.disabled=false);
    }
  });
  const runBtn=$('a-run'); if(runBtn)runBtn.disabled=false;
}
function renderTokenMap(tm){
  if(!Array.isArray(tm)||!tm.length){$('token-body').innerHTML='<tr><td colspan="3" class="dim">token-বাহী কোনো request ধরা পড়েনি।</td></tr>';return;}
  const rows=tm.map(t=>'<tr><td>'+esc(t.step)+'</td><td class="mono">'+esc(t.field)+'</td><td>'+
    (t.encrypted?'<span class="badge ok">encrypted (cipher)</span>':'<span class="badge">raw</span>')+'</td></tr>');
  $('token-body').innerHTML=rows.join('');
}
function epRow(key,value,badge){
  const b=badge==='ok'?'<span class="badge ok">যাচাই ✓</span>':badge==='text'?'<span class="badge">লেখা থেকে</span>':badge==='miss'?'<span class="badge bad">পাওয়া যায়নি</span>':'';
  return '<tr><td>'+esc(key)+' '+b+'</td><td><input type="text" data-ep="'+esc(key)+'" value="'+esc(value||'')+'"></td></tr>';
}
function renderEndpoints(cfg){
  const eps=cfg.endpoints||{}, rows=[];
  rows.push(epRow('baseUrl',cfg.apiBase,cfg.apiBase?'ok':'miss'));
  // walk-verified endpoints
  const seen={};
  for(const k of Object.keys(eps)){ rows.push(epRow(k,eps[k],'ok')); seen[eps[k]]=1; }
  if(cfg.slotId)rows.push(epRow('slotId',cfg.slotId,'ok'));
  if(cfg.dgepayUuid)rows.push(epRow('dgepayUuid',cfg.dgepayUuid,'ok'));
  if(cfg.initiatePath)rows.push(epRow('initiatePath',cfg.initiatePath,'ok'));
  // from-bundle static paths not already shown
  for(const p of (cfg.allEndpoints||[])){ if(seen[p])continue; rows.push(epRow(p,p,'text')); }
  $('ep-table').innerHTML='<tbody>'+(rows.join('')||'<tr><td colspan=2 class="dim">—</td></tr>')+'</tbody>';
}
function dynRow(key,value,note){
  return '<tr><td>'+esc(key)+(note?' <span class="badge">'+esc(note)+'</span>':'')+'</td><td><input type="text" data-dyn="'+esc(key)+'" value="'+esc(value||'')+'"></td></tr>';
}
function renderDynamic(cfg){
  // known-from-template values; deeper extraction (epHeaders/secRuntimeState/sitekey) — function পরে
  const rows=[
    dynRow('signinCaptchaKey','c'),
    dynRow('verifyOtpChannel','PHONE'),
    dynRow('uploadFileField','files'),
    dynRow('uploadPrimaryField','isPrimary'),
    dynRow('epHeaders','','function পরে'),
    dynRow('secRuntimeState','','function পরে'),
    dynRow('sitekey','','function পরে'),
    dynRow('(gating path)','','function পরে'),
  ];
  $('dyn-table').innerHTML='<tbody>'+rows.join('')+'</tbody>';
}
// ── button wiring (cipher copy / re-run) ──
document.addEventListener('click',async(ev)=>{
  const t=ev.target.closest('button'); if(!t)return;
  if(t.classList.contains('a-copy')){
    const box=t.closest('.a-box'); const ta=box&&box.querySelector('.a-code');
    if(ta&&ta.value){try{await navigator.clipboard.writeText(ta.value);const o=t.textContent;t.textContent='✅ কপি হয়েছে';setTimeout(()=>t.textContent=o,1200);}catch(_){ta.select();document.execCommand('copy');}}
    return;
  }
  if(t.classList.contains('a-one')||t.id==='a-run'){
    t.disabled=true;const o=t.textContent;t.textContent='চলছে…';
    const r=await fetch('/api/recipher',{method:'POST'}).then(x=>x.json()).catch(()=>null);
    if(r&&r.ok&&r.config===undefined){renderCipherExtract(r.ciphers);}
    t.textContent=o;t.disabled=false;
    return;
  }
});
function renderTpl(t){
  let h='';
  for(const s of t){
    h+='<div style="border-top:1px solid var(--line);padding:10px 0">';
    h+='<div>'+chip(s.found)+(s.probed?' <span class="badge ok">probe ✓</span>':'')+' <b>'+s.name+'</b></div>';
    h+='<div class="mono dim" style="margin:4px 0">'+s.method+' '+s.path+'</div>';
    if(s.headers){h+='<table>';for(const k in s.headers)h+='<tr><td>'+k+'</td><td class="mono">'+s.headers[k]+'</td></tr>';h+='</table>';}
    if(s.body){h+='<table>';for(const k in s.body)h+='<tr><td>'+k+'</td><td class="mono">'+s.body[k]+'</td></tr>';h+='</table>';}
    else h+='<span class="dim">— body নেই —</span>';
    if(s.note)h+='<div class="dim" style="font-size:11px;margin-top:3px">'+s.note+'</div>';
    h+='</div>';
  }
  $('tpl').innerHTML=h||'—';
}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
// ── Sync: poll server every 2s; auto-extract when the served bundle appears/changes ──
let syncTimer=null,lastBundleName='';
$('sync').onclick=()=>{
  if(syncTimer){clearInterval(syncTimer);syncTimer=null;$('sync').textContent='▶ Sync চালু';$('sync-note').textContent='বন্ধ';return;}
  $('sync').textContent='⏸ Sync বন্ধ';$('sync-note').innerHTML='<span class="warn">দেখছি…</span>';
  let syncFetched=false, syncBusy=false;
  const tick=async()=>{
    if(syncBusy||syncFetched)return;
    const site=$('site').value.trim();
    let s=null; try{s=await fetch('/api/server-status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({site})}).then(r=>r.json());}catch(_){}
    if(!s||!s.open){$('sync-note').innerHTML='<span class="bad">সার্ভার বন্ধ</span> <span class="dim">'+((s&&s.error)||'')+'</span>';return;}
    // open — Cloudflare-protected sites return no bundleName here, but the
    // browser fetch will find it. Fetch once as soon as the site is reachable.
    $('sync-note').innerHTML='<span class="ok">open</span> <span class="dim">'+(s.cf?'(Cloudflare — browser দিয়ে নামছে)':(s.bundleName||''))+'</span>';
    syncBusy=true;
    addLog('🔔 সার্ভার open — auto নামাচ্ছি (browser দিয়ে)…');
    const j=await fetch('/api/fetch-bundle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({site})}).then(r=>r.json()).catch(()=>null);
    if(j&&j.ok){syncFetched=true;lastBundleName=j.bundleName;render(j);$('save').disabled=false;startAutoWalk();addLog('✅ auto নামানো হলো — '+j.bundleName);$('sync-note').innerHTML='<span class="ok">synced ✓</span> <span class="dim">'+j.bundleName+'</span>';}
    else{addLog('❌ auto নামানো fail — '+((j&&j.error)||'')+' — ম্যানুয়ালি bundle দিন');$('sync-note').innerHTML='<span class="warn">open কিন্তু নামানো fail</span>';}
    syncBusy=false;
  };
  tick(); syncTimer=setInterval(tick,2000);
};
$('live').onclick=async()=>{
  const site=$('site').value.trim();
  addLog('🔴 Live capture — আসল সাইট খুলছে; নিজে login+captcha করে এগোন…');
  const j=await fetch('/api/live-capture',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({site})}).then(r=>r.json()).catch(()=>null);
  if(j&&j.ok){addLog('✅ '+(j.note||'live window খুলেছে'));
    if(window.__respTimer)clearInterval(window.__respTimer);
    window.__respTimer=setInterval(async()=>{
      const c=await fetch('/api/responses-count').then(r=>r.json()).catch(()=>null);
      if(c&&c.ok)$('resp-note').innerHTML='<span class="ok">responses ধরা পড়েছে: '+c.count+'</span> <span class="dim">'+(c.keys||[]).join(' · ')+'</span>';
      const f=await fetch('/api/probe-flow').then(r=>r.json()).catch(()=>null);
      if(f&&f.ok)renderCap(f.captured||[]);
    },2000);
  } else addLog('❌ live capture: '+((j&&j.error)||'fail')+' (এই মেশিনে সাইট/নেট লাগবে)');
};
// load existing snapshot if server already has one
fetch('/api/state').then(r=>r.json()).then(j=>{if(j&&j.config)render(j);}).catch(()=>{});
// show existing responses.json count on load
fetch('/api/responses-count').then(r=>r.json()).then(c=>{if(c&&c.count)$('resp-note').innerHTML='<span class="ok">responses.json আছে: '+c.count+' ধাপ</span> — offline walk প্রস্তুত';}).catch(()=>{});
</script></div></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(HTML); }

    // ── C-TOKEN POOL routes ──
    const pj = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (u === '/captcha' && req.method === 'GET') {
      const role = ((req.url.split('role=')[1] || '').split('&')[0] || '').toLowerCase();
      if (role === 'raw' || role === 'pay') { const rr = poolPrune('raw'); const one = rr.shift(); return one ? pj(200, { ok: true, value: one.value, valid_count: rr.length, from: 'raw' }) : pj(200, { ok: false, error: 'pool empty (raw)' }); }
      if (role !== 'signin' && role !== 'reserve') return pj(200, { ok: false, error: 'bad role' });
      const q = poolPrune(role); const item = q.shift();
      if (item) return pj(200, { ok: true, value: item.value, valid_count: q.length, from: 'ready' });
      const raw = poolTakeUntriedRaw(); if (!raw) return pj(200, { ok: false, error: 'pool empty (' + role + ')' });
      const enc = await poolCipher.encrypt(raw.value, role); if (!enc.ok) { poolGiveBack(raw); return pj(200, { ok: false, error: 'cipher fail: ' + enc.error }); }
      return pj(200, { ok: true, value: enc.value, valid_count: poolPrune('raw').length, from: 'raw+cipher', via: enc.via });
    }
    if (u === '/api/pool' && req.method === 'GET') {
      return pj(200, { ok: true, pool: poolCounts(), target: POOL_TARGET, workers: POOL_WORKERS, ttl_ms: POOL_TTL, enabled: POOL_ENABLED,
        cipher: { ready: poolCipher.ready, error: poolCipher.error || '', pin: poolCipher.pin ? poolCipher.pin.name : '' },
        relay: { url: POOL_RELAY, ok: poolStat.relayOk, err: poolStat.relayErr, pulled: poolStat.pulled, empty: poolStat.empty },
        fill: { made: poolStat.made, failed: poolStat.failed, inflight: poolStat.inflight, err: poolStat.fillErr } });
    }
    if (u === '/api/pool-set' && req.method === 'POST') {
      const raw = await body(req); let b = {}; try { b = JSON.parse(raw || '{}'); } catch (_) {}
      ['signin', 'reserve', 'raw'].forEach(k => { const v = parseInt(b[k], 10); if (v >= 0) POOL_TARGET[k] = Math.min(v, 500); });
      const w = parseInt(b.workers, 10); if (w > 0) POOL_WORKERS = Math.min(w, 8);
      if (b.enabled !== undefined) POOL_ENABLED = !!b.enabled;
      if (b.relay) POOL_RELAY = String(b.relay).replace(/\/+$/, '');
      return pj(200, { ok: true, target: POOL_TARGET, workers: POOL_WORKERS, enabled: POOL_ENABLED, relay: POOL_RELAY });
    }
    if (u === '/api/pool-clear' && req.method === 'POST') { POOL.signin = []; POOL.reserve = []; POOL.raw = []; poolSeen.clear(); return pj(200, { ok: true, pool: poolCounts() }); }
    // #6 Start/Stop switch: Stop halts relay/firm token pulling (poolRelayTick +
    // filler both gate on POOL_ENABLED). Existing pool tokens stay servable.
    if (u === '/api/pool-power' && req.method === 'POST') {
      const raw = await body(req); let b = {}; try { b = JSON.parse(raw || '{}'); } catch (_) {}
      POOL_ENABLED = !!b.on;
      console.log(POOL_ENABLED ? '▶️ Pool START — relay theke token tana chalu' : '⏸️ Pool STOP — relay theke token tana bondho');
      return pj(200, { ok: true, enabled: POOL_ENABLED });
    }

    if (u === '/api/extract' && req.method === 'POST') {
      const src = await body(req);
      const name = decodeURIComponent((req.url.split('name=')[1] || '').split('&')[0] || 'bundle.js');
      const config = extract(src, { skipInitiate: true });
      config.ciphers = await extractCiphers(src);   // headless per-role cipher (site's own function)
      poolUseBundle(path.join(__dirname, '.cipher-bundle.js'));   // pool cipher-ঘর নতুন bundle-এ
      const template = buildTemplate(config);
      lastBundle = { name, src };   // keep raw source so "browser-এ চালাও" can run THIS bundle
      snapshot = { config, template, allEndpoints: config.allEndpoints || [], bundleName: name, at: new Date().toLocaleString() };
      pushToBot('file-extract');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(snapshot));
    }
    if (u === '/api/recipher' && req.method === 'POST') {
      if (!lastBundle.src) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'আগে bundle load করুন' })); }
      const ciphers = await extractCiphers(lastBundle.src);
      if (snapshot.config) snapshot.config.ciphers = ciphers;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ciphers }));
    }
    if (u === '/api/fetch-bundle' && req.method === 'POST') {
      const raw = await body(req); let site = SITE;
      try { const b = JSON.parse(raw || '{}'); if (b.site) site = b.site; } catch (_) {}
      try {
        const { name, js } = await fetchBundleFromSite(site);
        const config = extract(js, { skipInitiate: true });
        config.ciphers = await extractCiphers(js);   // headless per-role cipher (site's own function)
        poolUseBundle(path.join(__dirname, '.cipher-bundle.js'));   // pool cipher-ঘর নতুন bundle-এ
        lastBundle = { name, src: js };   // keep raw so "browser-এ চালাও" can run it
        snapshot = { config, template: buildTemplate(config), allEndpoints: config.allEndpoints || [], bundleName: name, at: new Date().toLocaleString(), source: 'site' };
        pushToBot('site-fetch');
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(Object.assign({ ok: true }, snapshot)));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    }

    // Sync poll: is the site reachable, and which bundle is it serving now?
    // Returns the current bundle filename so the client can auto-extract when it
    // first appears or changes — no hardcoding, purely what the site serves.
    if (u === '/api/server-status') {
      const raw = await body(req); let site = SITE;
      try { const b = JSON.parse(raw || '{}'); if (b.site) site = b.site; } catch (_) {}
      try {
        const html = await httpGet(site);
        const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]);
        let pick = srcs.find((s) => /assets\/index[-.]/i.test(s)) || srcs.reverse().find((s) => /\.js(\?|$)/.test(s)) || '';
        const bundleName = pick ? new URL(pick, site).href.split('/').pop().split('?')[0] : '';
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, open: true, bundleName }));
      } catch (e) {
        // A Cloudflare 403 (or any HTTP status) means the site IS up — it just
        // blocks plain requests; the browser fetch will get through. Only a real
        // network failure (ECONNREFUSED / timeout / DNS) means truly closed.
        const msg = String(e.message || e);
        const reachable = /HTTP\s+\d/.test(msg);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, open: reachable, bundleName: '', cf: reachable, error: msg }));
      }
    }

    if (u === '/api/auto-walk' && req.method === 'POST') {
      // BACKGROUND, HEADLESS, AUTOMATIC: run the loaded bundle with no visible
      // window and no manual steps — flow-capture's built-in fiber-mutation driver
      // walks signin→initiate on its own, capturing the runtime-only fields
      // (dgepayUuid, initiatePath, slotId) that static decode can't resolve.
      if (!lastBundle.src) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'আগে একটা bundle load করুন।' })); }
      try {
        const outDir = __dirname;
        const bundleFile = path.join(outDir, '.host-bundle.js');
        fs.writeFileSync(bundleFile, lastBundle.src);
        try { fs.unlinkSync(path.join(outDir, 'flow.json')); } catch (_) {}
        const cfgFile = path.join(outDir, '.auto-cfg.json');
        const autoWs = await getWarmWs(true);
        fs.writeFileSync(cfgFile, JSON.stringify({
          url: 'http://localhost:' + HOST_PORT + '/',
          hostOrigin: 'http://localhost:' + HOST_PORT,
          headless: true, walkTimeoutMs: 45000, runMs: 55000,
          // balanced pace — আগের 0.5/1000ms থেকে দ্রুত, কিন্তু প্রতি ধাপে যথেষ্ট
          // pause রেখে যাতে signin→reserve→initiate পুরোটা পৌঁছে endpoint/payload/
          // header/slot/dgepay সব capture হয় (খুব আক্রমণাত্মক নয়, তাই miss হয় না)।
          speed: 0.75, stepPause: 550,
          connectWs: autoWs,
          bundlePath: bundleFile, out: outDir,
          mock: { phone: '01700000000', password: 'Test@1234', otp: '123456', turnstile: 'MOCK_TURNSTILE_TOKEN_abc123' },
        }));
        killWalk();
        const c = cp.spawn('node', [path.join(__dirname, 'flow-capture.js'), cfgFile],
          { cwd: __dirname, env: Object.assign({}, process.env), stdio: 'ignore', windowsHide: true });
        c.on('error', () => {}); c.unref(); currentWalk = c;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, started: true }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    }

    if (u === '/api/probe' && req.method === 'POST') {
      // run the flow-capture probe against the live site, headless; merge the
      // endpoints it actually observes into the template (marks them verified).
      const raw = await body(req); let site = SITE; let headless = true; let useBundle = false; let demo = false;
      try { const b = JSON.parse(raw || '{}');
        if (b.site) site = b.site;
        if (b.headless === false) headless = false;
        if (b.useBundle) useBundle = true;
        if (b.demo) demo = true;
      } catch (_) {}
      // demo: the full signin->initiate mock walk on the bundled fixture (a real host page)
      if (demo) { site = 'file://' + path.join(__dirname, 'mock-fixture.html'); useBundle = false; }
      // run the LOADED bundle in a visible browser (host page serves it)
      if (useBundle) {
        if (!lastBundle.src) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'আগে একটা index.js bundle load করুন (উপরে ফাইল দিন)।' })); }
        site = 'http://localhost:' + HOST_PORT + '/';
      }
      try {
        const cfgFile = path.join(__dirname, '.probe-cfg.json');
        const outDir = __dirname;
        try { fs.unlinkSync(path.join(outDir, 'flow.json')); } catch (_) {}   // clear old captures
        const mock = { phone: '01700000000', password: 'Test@1234', otp: '123456', turnstile: 'MOCK_TURNSTILE_TOKEN_abc123' };

        if (useBundle) {
          // MANUAL, VISIBLE: run the loaded bundle as the real app; user drives by
          // hand; all APIs mocked + captured (streamed to flow.json). Return now,
          // dashboard polls /api/probe-flow.
          const responsesFile = path.join(outDir, 'responses.json');
          const headedWs = await getWarmWs(false);
          fs.writeFileSync(cfgFile, JSON.stringify({ url: site, headless: false, runMs: 900000, out: outDir,
            hostOrigin: 'http://localhost:' + HOST_PORT, holdOpenMs: 900000, mock, connectWs: headedWs,
            responsesFile: fs.existsSync(responsesFile) ? responsesFile : undefined,
            steps: [
              { waitMs: 3000 },
              { closeOverlays: 6 },      // close advisory + notice popups (topmost first)
              { waitMs: 500 },
              { clickText: 'Sign In' },  // go to /signin
              { waitMs: 1500 },
              { fill: 'input[name="phone"]', value: '$phone' },
              { fill: 'input[name="password"]', value: '$password' },
              { clickText: 'Sign In Now' },
              { waitMs: 3000 },
              // OTP page (if responses.json advances it): fill + verify
              { fill: 'input[name*="otp" i]:visible, input[maxlength="6"]:visible, input[inputmode="numeric"]:visible', value: '$otp' },
              { clickText: 'Verify' },
              { waitMs: 2500 },
            ] }));
          killWalk();
          const c = cp.spawn('node', [path.join(__dirname, 'flow-capture.js'), cfgFile],
            { cwd: __dirname, env: Object.assign({}, process.env), stdio: 'ignore', windowsHide: true });
          c.on('error', () => {}); c.unref(); currentWalk = c;
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, manual: true, note: 'দৃশ্যমান window খুলছে — popup বন্ধ করে Sign In → নিজে হাতে চালান। ধরা-পড়া ডেটা নিচে live আসবে।' }));
        }

        // AUTO (demo / real site): walk signin->initiate with mock data, then finish.
        const autoSiteWs = await getWarmWs(headless);
        fs.writeFileSync(cfgFile, JSON.stringify({ url: site, headless, runMs: 30000, out: outDir, mock, connectWs: autoSiteWs,
          steps: [
            { waitMs: 3500 },
            { fill: 'input[type="tel"], input[name*="phone" i], input[placeholder*="phone" i], input[placeholder*="mobile" i]', value: '$phone' },
            { fill: 'input[type="password"]', value: '$password' },
            { click: '#signin button[type="submit"], button[type="submit"]:visible, button:visible:has-text("Sign"), button:visible:has-text("Login"), button:visible:has-text("Continue")' },
            { waitMs: 3500 },
            { fill: 'input[name*="otp" i]:visible, input[maxlength="6"]:visible, input[inputmode="numeric"]:visible', value: '$otp' },
            { click: '#otp button[type="submit"], button[type="submit"]:visible, button:visible:has-text("Verify"), button:visible:has-text("Continue")' },
            { waitMs: 3500 },
          ] }));
        killWalk();
        await new Promise((resolve, reject) => {
          const c = cp.spawn('node', [path.join(__dirname, 'flow-capture.js'), cfgFile],
            { cwd: __dirname, env: Object.assign({}, process.env), windowsHide: true });
          currentWalk = c;
          let err = ''; c.stderr.on('data', (d) => err += d);
          c.on('error', reject);
          c.on('close', (code) => code === 0 ? resolve() : reject(new Error(err || ('exit ' + code))));
        });
        const captured = readCaptured(outDir);
        markProbed(captured);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, observed: captured.map((c) => c.url), captured, template: snapshot.template, config: snapshot.config, bundleName: snapshot.bundleName, at: snapshot.at }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    }

    if (u === '/api/live-capture' && req.method === 'POST') {
      // open the REAL site visibly; user logs in + solves captcha + walks the flow;
      // record real requests AND real responses -> responses.json (for offline replay).
      const raw = await body(req); let site = SITE;
      try { const b = JSON.parse(raw || '{}'); if (b.site) site = b.site; } catch (_) {}
      try {
        const cfgFile = path.join(__dirname, '.live-cfg.json');
        try { fs.unlinkSync(path.join(__dirname, 'flow.json')); } catch (_) {}
        const liveWs = await getWarmWs(false);
        fs.writeFileSync(cfgFile, JSON.stringify({ url: site, headless: false, runMs: 1800000,
          out: __dirname, liveCapture: true, holdOpenMs: 1800000, connectWs: liveWs,
          responsesOut: path.join(__dirname, 'responses.json'), steps: [{ waitMs: 2000 }] }));
        killWalk();
        const c = cp.spawn('node', [path.join(__dirname, 'flow-capture.js'), cfgFile],
          { cwd: __dirname, env: Object.assign({}, process.env), stdio: 'ignore', windowsHide: true });
        c.on('error', () => {}); c.unref(); currentWalk = c;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, live: true, note: 'আসল সাইট খুলছে — নিজে login+captcha করে ধাপে ধাপে এগোন; প্রতিটা আসল response responses.json-এ জমা হবে। শেষে এই window বন্ধ করুন।' }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    }
    if (u === '/api/responses-count') {
      let n = 0, keys = []; try { const r = JSON.parse(fs.readFileSync(path.join(__dirname, 'responses.json'), 'utf8')); keys = Object.keys(r); n = keys.length; } catch (_) {}
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, count: n, keys }));
    }

    if (u === '/api/probe-flow') {
      const captured = readCaptured(__dirname);
      markProbed(captured);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, captured, template: snapshot.template, config: snapshot.config, bundleName: snapshot.bundleName, at: snapshot.at }));
    }

    if (u === '/api/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(snapshot)); }
    if (u === '/api/save' && req.method === 'POST') {
      fs.writeFileSync(VALUES, JSON.stringify(snapshot, null, 2));
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}');
    }
    if (u === '/api/load') {
      if (!fs.existsSync(VALUES)) { res.writeHead(404); return res.end('{}'); }
      snapshot = JSON.parse(fs.readFileSync(VALUES, 'utf8'));
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(snapshot));
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e && e.message || e) })); }
});

server.listen(PORT, () => {
  const url = 'http://localhost:' + PORT;
  console.log('\n  IVAC Node dashboard →  ' + url + '\n  (এই window বন্ধ করলে বন্ধ হবে)\n');
  const cp = require('child_process');
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
            : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { const c = cp.spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true }); c.on('error', () => {}); c.unref(); } catch (_) {}
  // Pre-warm the headless browser server so the first bundle-drop walk starts
  // instantly. (The headed one warms lazily on the first "browser-এ চালাও".)
  getWarmWs(true).then((ws) => { if (ws) console.log('  ⚡ browser pre-warmed — walks start instantly'); });
});
