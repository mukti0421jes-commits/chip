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
}).listen(HOST_PORT, () => {});
let snapshot = { config: null, template: [], allEndpoints: [], bundleName: '', at: '' };
let lastBundle = { name: '', src: '' };   // raw source of the last-loaded bundle (for "browser-এ চালাও")

function body(req) { return new Promise((res) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => res(d)); }); }

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
 td:first-child{width:180px;color:var(--dim);font-size:12.5px}
 .drop{border:2px dashed var(--line);border-radius:11px;padding:16px;text-align:center;cursor:pointer;font-size:14px}
 .drop:hover,.drop.over{border-color:var(--accent)}
 .badge{font-size:11px;padding:2px 9px;border-radius:99px}.badge.ok{background:rgba(55,201,120,.16)}.badge.bad{background:rgba(255,95,95,.16)}
 .log{font:12px/1.7 ui-monospace,Consolas,monospace;color:var(--dim);max-height:150px;overflow:auto;white-space:pre-wrap;margin-top:8px}
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
   <div class="log" id="log"></div>
 </div>

 <div class="card"><h2>Probe result <span class="dim" style="font-size:11px">— "browser-এ চালাও": signin→initiate mock data দিয়ে, যা ধরা পড়ল</span></h2>
   <div id="cap" class="dim">"🖐 browser-এ চালাও" চাপলে এখানে প্রতিটা ধাপের endpoint + payload + extra header + cipher "c" দেখা যাবে।</div>
 </div>

 <div class="card"><h2>Request ছাঁচ <span class="dim" style="font-size:11px">— সাইট যেভাবে পাঠায়, bot এতে শুধু মান বসায়</span></h2>
   <div id="tpl" class="dim">bundle দিলে এখানে সব ধাপের endpoint + header + body দেখা যাবে।</div>
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
  if(j.ok){addLog('✅ নামানো হলো — '+j.bundleName);render(j);$('save').disabled=false;$('note').textContent='done';}
  else{addLog('❌ '+j.error);$('note').textContent='❌ '+j.error+' (এই মেশিনে ইন্টারনেট/সাইট লাগবে)';}
};
let pollTimer=null;
$('probe').onclick=async()=>{
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
function renderCap(c){
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
  addLog('▶ Demo — signin→initiate ৯ ধাপ mock walk, দৃশ্যমান window খুলছে…');$('note').textContent='demo চলছে…';
  const r=await fetch('/api/probe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({demo:true,headless:false})});
  const j=await r.json();
  if(j.ok){addLog('✅ demo শেষ — '+j.observed.length+' ধাপ ধরা পড়েছে');if(j.config)render(j);renderCap(j.captured||[]);$('note').textContent='demo done';}
  else{addLog('❌ demo: '+j.error);$('note').textContent='❌ '+j.error;}
};
$('save').onclick=async()=>{const r=await fetch('/api/save',{method:'POST'});$('note').textContent=(await r.json()).ok?'✅ saved → values.json':'❌ save ব্যর্থ';};
$('load').onclick=async()=>{const r=await fetch('/api/load');if(!r.ok){$('note').textContent='values.json নেই';return;}render(await r.json());$('note').textContent='loaded values.json';};

async function send(f){
  addLog('⬆ '+f.name+' ('+(f.size/1048576).toFixed(2)+' MB) পাঠানো হচ্ছে…');
  $('note').textContent='decoding…';
  const text=await f.text();
  const r=await fetch('/api/extract?name='+encodeURIComponent(f.name),{method:'POST',headers:{'content-type':'text/plain'},body:text});
  const j=await r.json();
  addLog('✅ decode শেষ — '+(j.config&&j.config.dgepayUuid?'dgepayUuid পাওয়া গেছে':'dgepayUuid পাওয়া যায়নি'));
  render(j); $('save').disabled=false; $('note').textContent='done';
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
  const eps=j.allEndpoints||[];
  $('ep-count').textContent='('+eps.length+')';
  $('eps').innerHTML=eps.length?eps.map(e=>esc(e)).join('<br>'):'—';
}
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
      const config = extract(src);
      const template = buildTemplate(config);
      lastBundle = { name, src };   // keep raw source so "browser-এ চালাও" can run THIS bundle
      snapshot = { config, template, allEndpoints: config.allEndpoints || [], bundleName: name, at: new Date().toLocaleString() };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(snapshot));
    }
    if (u === '/api/fetch-bundle' && req.method === 'POST') {
      const raw = await body(req); let site = SITE;
      try { const b = JSON.parse(raw || '{}'); if (b.site) site = b.site; } catch (_) {}
      try {
        const { name, js } = await fetchBundleFromSite(site);
        const config = extract(js);
        lastBundle = { name, src: js };   // keep raw so "browser-এ চালাও" can run it
        snapshot = { config, template: buildTemplate(config), allEndpoints: config.allEndpoints || [], bundleName: name, at: new Date().toLocaleString(), source: 'site' };
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
          fs.writeFileSync(cfgFile, JSON.stringify({ url: site, headless: false, runMs: 900000, out: outDir,
            hostOrigin: 'http://localhost:' + HOST_PORT, holdOpenMs: 900000, mock,
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
          const c = cp.spawn('node', [path.join(__dirname, 'flow-capture.js'), cfgFile],
            { cwd: __dirname, env: Object.assign({}, process.env), detached: true, stdio: 'ignore' });
          c.on('error', () => {}); c.unref();
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, manual: true, note: 'দৃশ্যমান window খুলছে — popup বন্ধ করে Sign In → নিজে হাতে চালান। ধরা-পড়া ডেটা নিচে live আসবে।' }));
        }

        // AUTO (demo / real site): walk signin->initiate with mock data, then finish.
        fs.writeFileSync(cfgFile, JSON.stringify({ url: site, headless, runMs: 30000, out: outDir, mock,
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
        await new Promise((resolve, reject) => {
          const c = cp.spawn('node', [path.join(__dirname, 'flow-capture.js'), cfgFile],
            { cwd: __dirname, env: Object.assign({}, process.env) });
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
        fs.writeFileSync(cfgFile, JSON.stringify({ url: site, headless: false, runMs: 1800000,
          out: __dirname, liveCapture: true, holdOpenMs: 1800000,
          responsesOut: path.join(__dirname, 'responses.json'), steps: [{ waitMs: 2000 }] }));
        const c = cp.spawn('node', [path.join(__dirname, 'flow-capture.js'), cfgFile],
          { cwd: __dirname, env: Object.assign({}, process.env), detached: true, stdio: 'ignore' });
        c.on('error', () => {}); c.unref();
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
  try { const c = cp.spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }); c.on('error', () => {}); c.unref(); } catch (_) {}
});
