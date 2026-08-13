// ==UserScript==
// @name         IVAC Turnstile Token Farm (RJ) — 4 widgets
// @namespace    rj-turnstile-farm
// @version      0.1.0
// @description  Test panel: renders 4 Turnstile widgets on appointment.ivacbd.com, auto re-solves each after it passes, and pools the solved tokens (localStorage + BroadcastChannel 'rj_tokens') so the RJ SLOT code can consume them. Runs on the real domain so tokens are valid.
// @match        https://appointment.ivacbd.com/*
// @match        https://*.ivacbd.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// ==/UserScript==

(function () {
  'use strict';
  if (window.__rjFarm) return; window.__rjFarm = 1;

  var N = 4;                                   // number of widgets
  var TTL = 290000;                            // token ~300s; drop a bit early
  var RESOLVE_DELAY = 800;                     // ms after a solve before re-rendering that widget
  var SITEKEY = '';
  try { SITEKEY = localStorage.getItem('rj_farm_sitekey') || ''; } catch (e) {}
  if (!SITEKEY) SITEKEY = '0x4AAAAAACghKkJHL1t7UkuZ';   // RJ SLOT's known sitekey (editable in UI)

  var pool = [];                               // { token, at }
  var widgets = [];                            // { wid, el, statusEl }
  var bc = null; try { bc = new BroadcastChannel('rj_tokens'); } catch (e) {}
  // relay: pushes each solved token to the RJ SLOT browser (cross-browser). Edit in the UI box.
  var RELAY = '';
  try { RELAY = localStorage.getItem('rj_relay_url') || ''; } catch (e) {}
  if (!RELAY) RELAY = 'http://127.0.0.1:8787';
  var GMx = (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest : null;
  var pushed = 0;
  function relayPush(tok) {
    if (!GMx || !RELAY) return;
    try {
      GMx({
        method: 'POST', url: RELAY.replace(/\/+$/, '') + '/push', timeout: 8000,
        headers: { 'Content-Type': 'application/json' }, data: JSON.stringify({ token: tok }),
        onload: function () { pushed++; var e = document.getElementById('rjfw-relay'); if (e) e.textContent = 'relay ✓ ' + pushed; },
        onerror: function () { var e = document.getElementById('rjfw-relay'); if (e) { e.textContent = 'relay ✗ (server chalu?)'; e.style.color = '#fca5a5'; } },
        ontimeout: function () { var e = document.getElementById('rjfw-relay'); if (e) e.textContent = 'relay ⏱'; }
      });
    } catch (e) {}
  }

  // ---- token pool ----
  function prune() { var now = Date.now(); for (var i = pool.length - 1; i >= 0; i--) if (now - pool[i].at > TTL) pool.splice(i, 1); }
  function addToken(tok) {
    if (!tok || pool.some(function (p) { return p.token === tok; })) return;
    pool.push({ token: tok, at: Date.now() });
    try { localStorage.setItem('rj_farm_tokens', JSON.stringify(pool)); } catch (e) {}
    if (bc) try { bc.postMessage({ type: 'token', token: tok, at: Date.now() }); } catch (e) {}
    relayPush(tok);   // → RJ SLOT browser via the relay
    refresh();
  }

  // ---- detect the site's REAL sitekey (if its own widget renders) — more reliable than hardcoded ----
  try {
    var W = window;
    var hookRender = function (ts) {
      if (!ts || ts.__rjFarmHook) return; ts.__rjFarmHook = 1;
      var orig = ts.render;
      ts.render = function (el, opts) {
        try {
          var id = (el && el.id) || (typeof el === 'string' ? el : '');
          if (('' + id).indexOf('rjfw') !== 0 && opts && opts.sitekey && opts.sitekey !== SITEKEY) {
            // learned the site's live sitekey — adopt it for our widgets
            SITEKEY = opts.sitekey; try { localStorage.setItem('rj_farm_sitekey', SITEKEY); } catch (e) {}
            var inp = document.getElementById('rjfw-key'); if (inp) inp.value = SITEKEY;
          }
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    };
    var ivk = setInterval(function () { if (W.turnstile) { hookRender(W.turnstile); clearInterval(ivk); } }, 200);
    setTimeout(function () { try { clearInterval(ivk); } catch (e) {} }, 30000);
  } catch (e) {}

  // ---- load Turnstile api.js (explicit render) ----
  if (!document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')) {
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.defer = true; document.head.appendChild(s);
  }

  // ---- UI ----
  var panel, freshEl, listEl;
  function buildUI() {
    panel = document.createElement('div');
    panel.id = 'rjfw-panel';
    panel.style.cssText = 'position:fixed;top:14px;left:14px;z-index:2147483647;width:300px;background:linear-gradient(160deg,#0d0d1e,#12122c,#0a0a18);border:1px solid rgba(124,58,237,.5);border-radius:12px;box-shadow:0 18px 46px rgba(0,0,0,.85);font-family:Segoe UI,system-ui,sans-serif;color:#e0e0f0;overflow:hidden';
    var slots = '';
    for (var i = 0; i < N; i++) slots += '<div style="margin-bottom:6px"><div id="rjfw' + i + '"></div><div id="rjfws' + i + '" style="font:700 .55rem Consolas,monospace;color:#8888aa;margin-top:2px">#' + (i + 1) + ' loading…</div></div>';
    panel.innerHTML =
      '<div id="rjfw-head" style="cursor:move;display:flex;justify-content:space-between;align-items:center;padding:9px 11px;background:linear-gradient(90deg,#0a0a18,#16162f,#0a0a18);border-bottom:1px solid rgba(124,58,237,.3)">' +
        '<span style="font-weight:800;font-size:.76rem;color:#c4b5fd">🌾 Turnstile Token Farm (4)</span>' +
        '<span id="rjfw-min" style="cursor:pointer;color:#a78bfa;font-weight:800;padding:0 6px">–</span></div>' +
      '<div style="padding:10px 11px">' +
        '<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">' +
          '<div style="flex:1;font:800 .72rem Segoe UI">fresh tokens: <span id="rjfw-fresh" style="color:#4ade80">0</span></div>' +
          '<button id="rjfw-cpall" style="padding:5px 8px;border:0;border-radius:5px;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;font-weight:800;font-size:.6rem;cursor:pointer">Copy all</button>' +
        '</div>' +
        '<div style="display:flex;gap:5px;align-items:center;margin-bottom:8px"><input id="rjfw-relayurl" value="' + RELAY + '" spellcheck="false" title="Relay URL — same PC: http://127.0.0.1:8787 ; other PC: http://LAN-IP:8787" style="flex:1;min-width:0;padding:5px 6px;border-radius:5px;border:1px solid #3a3a5e;background:#12122c;color:#7dd3fc;font:700 .56rem Consolas,monospace">' +
          '<button id="rjfw-relayapply" style="padding:5px 8px;border:0;border-radius:5px;background:#333;color:#fff;font-weight:800;font-size:.6rem;cursor:pointer">Set</button>' +
          '<span id="rjfw-relay" style="font:700 .55rem Consolas,monospace;color:#8888aa">relay …</span></div>' +
        slots +
        '<div id="rjfw-list" style="max-height:70px;overflow:auto;font:600 .5rem Consolas,monospace;color:#6b6b8a;background:#12122c;border:1px solid #222;border-radius:5px;padding:5px;margin:6px 0"></div>' +
        '<div style="display:flex;gap:5px;align-items:center"><input id="rjfw-key" value="' + SITEKEY + '" spellcheck="false" style="flex:1;min-width:0;padding:5px 6px;border-radius:5px;border:1px solid #3a3a5e;background:#12122c;color:#c4b5fd;font:700 .56rem Consolas,monospace">' +
          '<button id="rjfw-apply" style="padding:5px 8px;border:0;border-radius:5px;background:#333;color:#fff;font-weight:800;font-size:.6rem;cursor:pointer">Apply key</button></div>' +
      '</div>';
    document.documentElement.appendChild(panel);
    freshEl = document.getElementById('rjfw-fresh');
    listEl = document.getElementById('rjfw-list');
    for (var i = 0; i < N; i++) widgets.push({ wid: null, el: document.getElementById('rjfw' + i), statusEl: document.getElementById('rjfws' + i) });

    document.getElementById('rjfw-min').onclick = function () { var b = panel.querySelector('div:nth-child(2)'); if (b) b.style.display = b.style.display === 'none' ? 'block' : 'none'; };
    document.getElementById('rjfw-cpall').onclick = function () { prune(); var all = pool.map(function (p) { return p.token; }).join('\n'); try { navigator.clipboard.writeText(all); } catch (e) {} this.textContent = 'Copied ' + pool.length; setTimeout(function () { document.getElementById('rjfw-cpall').textContent = 'Copy all'; }, 1200); };
    document.getElementById('rjfw-apply').onclick = function () { var k = document.getElementById('rjfw-key').value.trim(); if (k) { SITEKEY = k; try { localStorage.setItem('rj_farm_sitekey', k); } catch (e) {} location.reload(); } };
    document.getElementById('rjfw-relayapply').onclick = function () { var r = document.getElementById('rjfw-relayurl').value.trim(); if (r) { RELAY = r; try { localStorage.setItem('rj_relay_url', r); } catch (e) {} this.textContent = 'Set ✓'; var s = this; setTimeout(function () { s.textContent = 'Set'; }, 1000); } };
    // drag
    var h = document.getElementById('rjfw-head'), dx = 0, dy = 0, drag = false;
    h.onmousedown = function (e) { drag = true; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop; e.preventDefault(); };
    document.addEventListener('mousemove', function (e) { if (!drag) return; panel.style.left = (e.clientX - dx) + 'px'; panel.style.top = (e.clientY - dy) + 'px'; });
    document.addEventListener('mouseup', function () { drag = false; });
  }

  function setStatus(i, txt, color) { var w = widgets[i]; if (w && w.statusEl) { w.statusEl.textContent = '#' + (i + 1) + ' ' + txt; w.statusEl.style.color = color || '#8888aa'; } }
  function refresh() {
    prune();
    if (freshEl) freshEl.textContent = pool.length;
    if (listEl) listEl.innerHTML = pool.slice(-8).reverse().map(function (p) { return '• ' + p.token.slice(0, 26) + '… (' + Math.max(0, Math.round((TTL - (Date.now() - p.at)) / 1000)) + 's)'; }).join('<br>');
  }

  function renderWidget(i) {
    if (typeof turnstile === 'undefined') return;
    var w = widgets[i]; if (!w || !w.el) return;
    try {
      if (w.wid !== null) { try { turnstile.remove(w.wid); } catch (e) {} w.el.innerHTML = ''; }
      w.wid = turnstile.render(w.el, {
        sitekey: SITEKEY, size: 'normal', theme: 'dark', appearance: 'always',
        callback: function (token) {
          addToken(token);
          setStatus(i, '✓ solved → pooled', '#4ade80');
          setTimeout(function () { try { turnstile.reset(w.wid); setStatus(i, '↻ re-solving…', '#fcd34d'); } catch (e) { renderWidget(i); } }, RESOLVE_DELAY);
        },
        'error-callback': function (c) { setStatus(i, '✗ error ' + (c || '') + ' (sitekey/domain?)', '#fca5a5'); return true; },
        'expired-callback': function () { setStatus(i, '⚠ expired — reset', '#fbbf24'); try { turnstile.reset(w.wid); } catch (e) {} },
        'timeout-callback': function () { setStatus(i, '⚠ timeout — reset', '#fbbf24'); try { turnstile.reset(w.wid); } catch (e) {} }
      });
      setStatus(i, 'rendered — waiting…', '#8888aa');
    } catch (e) { setStatus(i, 'render err: ' + e.message, '#fca5a5'); }
  }

  function start() {
    buildUI();
    try { var saved = JSON.parse(localStorage.getItem('rj_farm_tokens') || '[]'); if (Array.isArray(saved)) { pool = saved; prune(); } } catch (e) {}
    var iv = setInterval(function () {
      if (typeof turnstile === 'undefined' || !document.getElementById('rjfw0')) return;
      clearInterval(iv);
      for (var i = 0; i < N; i++) renderWidget(i);
    }, 200);
    setInterval(refresh, 1000);
  }

  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
