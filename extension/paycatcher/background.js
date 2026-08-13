// RJ IVAC Payment Callback Catcher — service worker.
// Watches the network layer (webRequest, exactly what DevTools taps) for the dg-epay callback URL
// that carries BOTH tran_id and the encrypted `data` blob. On capture it AUTO-FIRES the callback
// (GET, with cookies) every `intervalMs` (default 1s) until 302/2xx = success, then navigates the
// active tab. State is persisted so an MV3 worker suspension can't stop the loop — it resumes.
// Everything local; no external server.

const FILTER = { urls: ["*://api.ivacbd.com/*", "*://appointment.ivacbd.com/*", "*://*.dgepay.net/*"] };
const DEFAULT = { url: null, tranId: '', status: 'waiting — pay, the callback will be caught', tries: 0, done: false, stopped: false, autofire: true, intervalMs: 1000, at: 0 };
let S = Object.assign({}, DEFAULT);
let loopTimer = null;
let running = false;   // true for the WHOLE loop (incl. the in-flight fetch) — prevents parallel loops

function isCallback(u) { u = '' + (u || ''); return /callback/i.test(u) && /[?&]tran_id=/i.test(u) && /payment|dg-?epay/i.test(u); }
function save() { try { chrome.storage.local.set({ S }); } catch (e) {} }
function badge(t, c) { try { chrome.action.setBadgeText({ text: t }); if (c) chrome.action.setBadgeBackgroundColor({ color: c }); } catch (e) {} }
function notify(title, message) { try { chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title, message }); } catch (e) {} }

// restore persisted state on worker startup + resume the loop if it was mid-flight
chrome.storage.local.get('S', d => {
  if (d && d.S) { S = Object.assign({}, DEFAULT, d.S); }
  if (S.url && S.autofire && !S.done && !S.stopped) startLoop();
});

function capture(url, via) {
  if (!isCallback(url)) return;
  if (S.url === url && !S.stopped) { if (!S.done && !running && S.autofire) startLoop(); return; }
  S.url = url;
  S.tranId = (url.match(/[?&]tran_id=([^&#]+)/i) || [])[1] || '';
  S.done = false; S.stopped = false; S.tries = 0; S.at = Date.now();
  S.status = 'CAPTURED (' + via + ') — auto-firing every ' + (S.intervalMs / 1000) + 's…';
  save(); badge('●', '#f59e0b');
  notify('Callback captured', 'tran_id=' + S.tranId.slice(0, 12) + '… — auto-firing');
  console.log('[RJ PayCatcher] captured (' + via + '):', url);
  if (S.autofire) startLoop();
}

// Network observers — catch the callback as a request, redirect target, or response.
try { chrome.webRequest.onBeforeRequest.addListener(d => capture(d.url, 'request'), FILTER); } catch (e) {}
try { chrome.webRequest.onBeforeRedirect.addListener(d => { capture(d.redirectUrl, 'redirect'); capture(d.url, 'redirect-from'); }, FILTER); } catch (e) {}
try { chrome.webRequest.onResponseStarted.addListener(d => capture(d.url, 'response'), FILTER); } catch (e) {}
try { chrome.webRequest.onCompleted.addListener(d => capture(d.url, 'completed'), FILTER); } catch (e) {}

// keepalive backstop: if the worker was suspended and the loop timer was lost, resume it
try {
  chrome.alarms.create('ka', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener(() => { if (S.url && S.autofire && !S.done && !S.stopped && !running) startLoop(); });
} catch (e) {}

function startLoop() { if (running || !S.url || S.done || S.stopped) return; running = true; tick(); }
function stopLoop() { running = false; if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; } }

async function tick() {
  loopTimer = null;
  if (!running || S.stopped || S.done || !S.url) { running = false; return; }
  S.tries++;
  try {
    const r = await fetch(S.url, { method: 'GET', redirect: 'manual', cache: 'no-store', credentials: 'include', headers: { 'Upgrade-Insecure-Requests': '1' } });
    const tag = r.status + ' ' + r.type;
    var ok = (r.type === 'opaqueredirect' || (r.status >= 200 && r.status < 400));
    if (ok) { S.okCount = (S.okCount || 0) + 1; if (S.okCount === 1) notify('Callback OK', 'callback ' + tag + ' — still firing every ' + (S.intervalMs / 1000) + 's'); }
    S.status = (ok ? '✓' : '🔁') + ' #' + S.tries + ' → ' + tag + (ok ? ' (ok x' + S.okCount + ') — firing every ' : ' — retry every ') + (S.intervalMs / 1000) + 's';
    badge(ok ? '✓' : '·', ok ? '#10b981' : '#f59e0b'); save();
  } catch (e) {
    S.status = '🔁 #' + S.tries + ' err (' + ((e && e.message) || '') + ') — retry every ' + (S.intervalMs / 1000) + 's'; save();
  }
  // continuous: keep firing every intervalMs until the user hits Stop (never auto-stops)
  if (!S.stopped && running) loopTimer = setTimeout(tick, S.intervalMs);
  else running = false;
}

// popup <-> worker
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  var m = (msg && msg.cmd) || msg;
  if (m === 'get') { reply(S); return true; }
  if (m === 'fire') { S.done = false; S.stopped = false; stopLoop(); startLoop(); reply(S); return true; }
  if (m === 'stop') { S.stopped = true; stopLoop(); S.status = '⏹ stopped at #' + S.tries; save(); reply(S); return true; }
  if (m === 'reset') { stopLoop(); S = Object.assign({}, DEFAULT); save(); badge('', '#000'); reply(S); return true; }
  if (m === 'interval') { var v = parseInt(msg.value, 10); if (v >= 200 && v <= 60000) { S.intervalMs = v; save(); } reply(S); return true; }
  if (m === 'auto') { S.autofire = !S.autofire; if (S.autofire && S.url && !S.done) startLoop(); else stopLoop(); save(); reply(S); return true; }
  return false;
});
