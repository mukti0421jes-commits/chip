// RJ IVAC Payment Callback Catcher — service worker.
// Watches the network layer (webRequest, exactly what DevTools taps) for the dg-epay callback URL
// that carries BOTH tran_id and the encrypted `data` blob — the one page-JS/bookmarklets cannot
// reach. On capture it re-fires the callback (GET, with cookies) every 1s until 302/2xx = success,
// then navigates the active tab to finish the flow. Everything stays local; no external server.

const FILTER = { urls: ["*://api.ivacbd.com/*", "*://appointment.ivacbd.com/*", "*://*.dgepay.net/*"] };

let S = { url: null, tranId: '', status: 'waiting — pay, then the callback will be caught', tries: 0, done: false, firing: false, at: 0 };

function isCallback(u) {
  if (!u) return false;
  u = '' + u;
  return /callback/i.test(u) && /[?&]tran_id=/i.test(u) && /payment|dg-?epay/i.test(u);
}
function save() { try { chrome.storage.local.set({ S }); } catch (e) {} }
function badge(t, c) { try { chrome.action.setBadgeText({ text: t }); if (c) chrome.action.setBadgeBackgroundColor({ color: c }); } catch (e) {} }
function notify(title, message) { try { chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title, message }); } catch (e) {} }

function capture(url, via) {
  if (S.done || !isCallback(url)) return;
  if (S.url === url) return;
  S.url = url;
  S.tranId = (url.match(/[?&]tran_id=([^&#]+)/i) || [])[1] || '';
  S.status = 'CAPTURED (' + via + ') — firing…';
  S.at = Date.now();
  save(); badge('●', '#f59e0b');
  notify('Callback captured', 'tran_id=' + S.tranId.slice(0, 12) + '… — firing');
  console.log('[RJ PayCatcher] captured (' + via + '):', url);
  fireLoop();
}

// Network observers — catch the callback whether it is a request, a redirect target, or a response.
try { chrome.webRequest.onBeforeRequest.addListener(d => capture(d.url, 'request'), FILTER); } catch (e) {}
try { chrome.webRequest.onBeforeRedirect.addListener(d => { capture(d.redirectUrl, 'redirect→'); capture(d.url, 'redirect-from'); }, FILTER); } catch (e) {}
try { chrome.webRequest.onResponseStarted.addListener(d => capture(d.url, 'response'), FILTER); } catch (e) {}
try { chrome.webRequest.onCompleted.addListener(d => capture(d.url, 'completed'), FILTER); } catch (e) {}

// keep the SW alive while firing (MV3 can suspend idle workers)
try { chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }); chrome.alarms.onAlarm.addListener(() => { if (S.firing && !S.done) fireLoop(); }); } catch (e) {}

async function fireLoop() {
  if (S.firing || S.done || !S.url) return;
  S.firing = true;
  while (!S.done && S.tries < 120) {
    S.tries++;
    try {
      const r = await fetch(S.url, { method: 'GET', redirect: 'manual', cache: 'no-store', credentials: 'include', headers: { 'Upgrade-Insecure-Requests': '1' } });
      const tag = r.status + ' ' + r.type;
      if (r.type === 'opaqueredirect' || (r.status >= 200 && r.status < 400)) {
        S.done = true; S.status = '✓ SUCCESS (' + tag + ') after #' + S.tries; save(); badge('✓', '#10b981');
        notify('Payment confirmed', 'callback ' + tag + ' — done');
        try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab) chrome.tabs.update(tab.id, { url: S.url }); } catch (e) {}
        break;
      }
      S.status = '✗ #' + S.tries + ' ' + tag + ' — retrying'; save();
    } catch (e) {
      S.status = '✗ #' + S.tries + ' err (' + (e && e.message || '') + ') — retrying'; save();
    }
    await new Promise(res => setTimeout(res, 1000));
  }
  S.firing = false; save();
}

// popup <-> worker messaging
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg === 'get') { reply(S); return true; }
  if (msg === 'fire') { S.done = false; S.tries = 0; fireLoop(); reply(S); return true; }
  if (msg === 'reset') { S = { url: null, tranId: '', status: 'reset — waiting for callback', tries: 0, done: false, firing: false, at: 0 }; save(); badge('', '#000'); reply(S); return true; }
  return false;
});
