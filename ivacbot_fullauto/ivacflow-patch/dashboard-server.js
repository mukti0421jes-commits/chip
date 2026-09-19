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
const { buildTemplate } = require('./flow-template');

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
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(httpGet(new URL(res.headers.location, url).href));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}

// From the site HTML, find the big index-*.js asset URL and download it.
async function fetchBundleFromSite(site) {
  const html = await httpGet(site);
  const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]);
  // prefer an assets/index-*.js; else the last script
  let pick = srcs.find((s) => /assets\/index[-.]/i.test(s)) || srcs.reverse().find((s) => /\.js(\?|$)/.test(s));
  if (!pick) throw new Error('index-*.js পাওয়া যায়নি (page HTML-এ script src নেই — Cloudflare আটকাচ্ছে?)');
  const abs = new URL(pick, site).href;
  const js = await httpGet(abs);
  return { name: abs.split('/').pop().split('?')[0], js };
}

const PORT = process.env.PORT || 8777;
const HOST_PORT = PORT + 1;   // dedicated origin that serves the loaded bundle AT ROOT (SPA)
const VALUES = path.join(__dirname, 'values.json');

// Serve the loaded bundle as a real SPA at http://localhost:HOST_PORT/ so the
// app's client-side router sees "/" and renders the real home/login (not 404).
// Any path returns the host HTML (SPA fallback); /assets/index.js returns the bundle.
const HOST_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>IVAC</title></head>' +
  '<body><div id="app"></div><div id="root"></div><div id="__nuxt"></div><div id="__next"></div>' +
  '<script type="module" src="/assets/index.js"></script></body></html>';
http.createServer((q, s) => {
  if (q.url === '/assets/index.js') {
    if (!lastBundle.src) { s.writeHead(404); return s.end('// no bundle loaded'); }
    s.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' }); return s.end(lastBundle.src);
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
// so nobody has to press Save and copy a file around. The bot keeps it as a
// FALLBACK: it fills only what the bot's own live scan could not resolve.
//
// Config (config.json):
//   "botUrl"       — e.g. "http://127.0.0.1:8080"; omit to disable pushing
//   "botTokenFile" — path to the bot's ivacflow_token.txt (default: alongside
//                    this folder). The bot writes that file on first start and
//                    rejects a push without it.
let BOT_CFG = { url: '', tokenFile: '' };
try {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  BOT_CFG.url = (c && c.botUrl) || '';
  BOT_CFG.tokenFile = (c && c.botTokenFile) || '';
} catch (_) {}

function readBotToken() {
  const candidates = [];
  if (BOT_CFG.tokenFile) candidates.push(BOT_CFG.tokenFile);
  candidates.push(path.join(__dirname, 'ivacflow_token.txt'));
  candidates.push(path.join(__dirname, '..', 'ivacflow_token.txt'));
  for (const f of candidates) {
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch (_) {}
  }
  return '';
}

// pushToBot sends the current snapshot to the bot. It never throws and never
// blocks the dashboard: if the bot is down, or no botUrl is configured, it just
// logs a line and moves on.
let lastPushed = '';
function pushToBot(reason) {
  if (!BOT_CFG.url || !snapshot || !snapshot.config) return;
  const body = JSON.stringify(snapshot);
  // don't re-send an identical snapshot (several code paths rebuild it)
  if (body === lastPushed) return;
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

// Run extract-ciphers.js on the loaded bundle (static, ~0.2s) and return the
// per-role ciphers (algo · skip · len · key) plus the generated standalone
// cipher.js code, so the dashboard can auto-fill the Cipher table on load.
function extractCiphers(srcText) {
  const out = { roles: [], code: '', verified: '' };
  try {
    const bundleFile = path.join(__dirname, '.cipher-bundle.js');
    const outFile = path.join(__dirname, '.cipher-out.js');
    fs.writeFileSync(bundleFile, srcText);
    const r = cp.spawnSync('node', [path.join(__dirname, 'extract-ciphers.js'), bundleFile, outFile],
      { cwd: __dirname, encoding: 'utf8', timeout: 30000, windowsHide: true });
    const so = (r.stdout || '') + '\n' + (r.stderr || '');
    const re = /role=(\S+)\s+version=(\S+)\s+algo=(\S+)\s+skip=(\d+)\s+len=(\d+)/g;
    const keyByIdx = [];
    for (const m of so.matchAll(/key=("(?:\\.|[^"])*")/g)) { try { keyByIdx.push(JSON.parse(m[1])); } catch (_) { keyByIdx.push(''); } }
    let i = 0, mm;
    while ((mm = re.exec(so))) {
      out.roles.push({ role: mm[1], version: mm[2], algo: mm[3], skip: +mm[4], len: +mm[5], key: keyByIdx[i] || '' });
      i++;
    }
    const gm = so.match(/GUARANTEE:\s*([\d/]+)\s*verified/);
    if (gm) out.verified = gm[1];
    try { out.code = fs.readFileSync(outFile, 'utf8'); } catch (_) {}
  } catch (_) {}
  return out;
}

// read flow.json → per-call endpoint + payload fields + extra headers + cipher "c"
function readCaptured(dir) {
  let flow; try { flow = JSON.parse(fs.readFileSync(path.join(dir, 'flow.json'), 'utf8')); } catch (_) { return []; }
  // merge captured extracted values into snapshot config when bundle extraction missed them
  if (flow.extracted && snapshot.config) {
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
    snapshot.template = buildTemplate(snapshot.config);
    pushToBot('walk');   // runtime ids (slotId / dgepayUuid) just landed
  }
  return (flow.calls || []).map((c) => {
    let fields = null, cipher = ''; try { const j = JSON.parse(c.body || '{}'); fields = Object.keys(j); if (j.c) cipher = j.c; } catch (_) {}
    const H = c.headers || {}; const hdr = {};
    for (const k of ['x-token', 'x-sec-navigation-state', 'x-sec-runtime-state', 'x-v-request-meta', 'authorization', 'content-type']) if (H[k]) hdr[k] = H[k];
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
  if(j.ok){addLog('✅ নামানো হলো — '+j.bundleName);render(j);$('save').disabled=false;startAutoWalk();}
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
  {label:'OTP verify',re:/otp\\/verify/i},
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
    const hit=urls.some(u=>s.re.test(u));
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
  if(/sign-?in/i.test(u))return'SIGN IN';
  if(/otp\\/verif/i.test(u))return'VERIFY OTP';
  if(/reserve-slot/i.test(u))return'RESERVE';
  if(/payment\\/.*initiate/i.test(u))return'PAYMENT INITIATE';
  if(/upload/i.test(u))return'PRIMARY UPLOAD';
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
      startAutoWalk();   // background headless full-extract; visible browser stays optional
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
  const tick=async()=>{
    const site=$('site').value.trim();
    let s=null; try{s=await fetch('/api/server-status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({site})}).then(r=>r.json());}catch(_){}
    if(!s||!s.open){$('sync-note').innerHTML='<span class="bad">সার্ভার বন্ধ</span> <span class="dim">'+((s&&s.error)||'')+'</span>';return;}
    $('sync-note').innerHTML='<span class="ok">open</span> <span class="dim">'+(s.bundleName||'')+'</span>';
    if(s.bundleName && s.bundleName!==lastBundleName){
      lastBundleName=s.bundleName;
      addLog('🔔 সার্ভার open — bundle: '+s.bundleName+' — auto extract…');
      const j=await fetch('/api/fetch-bundle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({site})}).then(r=>r.json()).catch(()=>null);
      if(j&&j.ok){render(j);$('save').disabled=false;addLog('✅ auto extract হলো — '+j.bundleName);$('sync-note').innerHTML='<span class="ok">synced ✓</span> <span class="dim">'+s.bundleName+'</span>';}
      else{addLog('❌ auto extract fail — নিচে ম্যানুয়ালি bundle দিন');}
    }
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


    if (u === '/api/extract' && req.method === 'POST') {
      const src = await body(req);
      const name = decodeURIComponent((req.url.split('name=')[1] || '').split('&')[0] || 'bundle.js');
      const config = extract(src, { skipInitiate: true });
      config.ciphers = extractCiphers(src);   // instant per-role cipher extract (parallel to the walk)
      const template = buildTemplate(config);
      lastBundle = { name, src };   // keep raw source so "browser-এ চালাও" can run THIS bundle
      snapshot = { config, template, allEndpoints: config.allEndpoints || [], bundleName: name, at: new Date().toLocaleString() };
      pushToBot('file-extract');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(snapshot));
    }
    if (u === '/api/recipher' && req.method === 'POST') {
      if (!lastBundle.src) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'আগে bundle load করুন' })); }
      const ciphers = extractCiphers(lastBundle.src);
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
        config.ciphers = extractCiphers(js);   // instant per-role cipher extract, like file load
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
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, open: false, error: String(e.message || e) }));
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
          headless: true, walkTimeoutMs: 55000, runMs: 70000,
          speed: 0.5, stepPause: 1000,   // safe pace: slow enough that every bundle's walk reaches payment-initiate so the REAL captured path is shown
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
