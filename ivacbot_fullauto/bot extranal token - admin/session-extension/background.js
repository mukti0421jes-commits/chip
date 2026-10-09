// IVAC Session Login — background service worker.
//
// Pins this browser to the SAME egress IP the bot instance uses, so a re-used
// IVAC session stays stable (the session is bound to the IP it was created on).
//
//   • chrome.proxy            → route the whole browser through the instance's proxy
//   • onAuthRequired          → supply that proxy's username/password
//
// Credentials live in chrome.storage.session (in-memory, cleared when the browser
// closes) — never written to disk.
//
// SESSION-ONLY PIN: the proxy pin is meant to last ONLY the current browser session.
// chrome.proxy uses a 'regular' scope that would otherwise persist to the profile, so
// on the NEXT browser launch (onStartup) and on install/update we auto-clear it — that
// way no IP stays saved afterward, and the browser is never left locked to an old
// (cred-less) proxy IP that can't reach any site. Use the ✖ Disconnect button to clear
// it mid-session.

let CURRENT = null; // { host, port, user, pass }

async function loadCurrent() {
  if (CURRENT) return CURRENT;
  try {
    const v = await chrome.storage.session.get('proxyCreds');
    CURRENT = v.proxyCreds || null;
  } catch (_) {}
  return CURRENT;
}

function setProxy(p) {
  return new Promise((resolve) => {
    const config = {
      mode: 'fixed_servers',
      rules: {
        singleProxy: {
          scheme: (p.type || 'http').toLowerCase(),
          host: p.host,
          port: parseInt(p.port, 10),
        },
        // keep the bot (localhost / LAN) reachable without going through the proxy
        bypassList: ['localhost', '127.0.0.1', '[::1]'],
      },
    };
    chrome.proxy.settings.set({ value: config, scope: 'regular' }, () => {
      const err = chrome.runtime.lastError;
      resolve(err ? { ok: false, error: err.message } : { ok: true });
    });
  });
}

function clearProxy() {
  return new Promise((resolve) => {
    chrome.proxy.settings.clear({ scope: 'regular' }, () => {
      const err = chrome.runtime.lastError;
      resolve(err ? { ok: false, error: err.message } : { ok: true });
    });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.type === 'connectProxy' && msg.proxy && msg.proxy.host) {
        CURRENT = {
          host: msg.proxy.host,
          port: msg.proxy.port,
          user: msg.proxy.user || '',
          pass: msg.proxy.pass || '',
        };
        try { await chrome.storage.session.set({ proxyCreds: CURRENT }); } catch (_) {}
        sendResponse(await setProxy(msg.proxy));
      } else if (msg && msg.type === 'disconnectProxy') {
        CURRENT = null;
        try { await chrome.storage.session.remove('proxyCreds'); } catch (_) {}
        sendResponse(await clearProxy());
      } else if (msg && msg.type === 'lookupName' && msg.phone) {
        // Ask the bot which Client owns this phone, so the on-page badge can show
        // a name for any login method. Runs here because the service worker can
        // fetch the bot cross-origin without CORS.
        let name = '';
        try {
          const s = await chrome.storage.local.get(['botUrl', 'extKey']);
          const botUrl = (s.botUrl || 'http://localhost:8080').replace(/\/+$/, '');
          const extKey = s.extKey || '';
          if (extKey) {
            const r = await fetch(botUrl + '/api/sessionName?phone=' + encodeURIComponent(msg.phone), {
              headers: { 'X-Ext-Key': extKey },
            });
            if (r.ok) { const d = await r.json(); name = (d && d.name) || ''; }
          }
        } catch (_) {}
        sendResponse({ name });
      } else {
        sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // keep the channel open for the async response
});

// SESSION-ONLY PIN enforcement: wipe any lingering proxy the moment the browser starts
// a fresh session (and on install/update), so no pinned IP survives to the next launch
// and the browser is never stuck on an old proxy it can no longer authenticate to.
// NOTE: onStartup fires once per browser launch — NOT on every (ephemeral MV3) service
// worker restart — so an active in-session pin is left untouched.
chrome.runtime.onStartup.addListener(() => {
  CURRENT = null;
  clearProxy();
  try { chrome.storage.session.remove('proxyCreds'); } catch (_) {}
});
chrome.runtime.onInstalled.addListener(() => {
  CURRENT = null;
  clearProxy();
  try { chrome.storage.session.remove('proxyCreds'); } catch (_) {}
});

// Hand the proxy its credentials whenever it challenges for auth.
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) { callback({}); return; }
    loadCurrent().then((c) => {
      if (c && c.user) callback({ authCredentials: { username: c.user, password: c.pass } });
      else callback({});
    });
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);
