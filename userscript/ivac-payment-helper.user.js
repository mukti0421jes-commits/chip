// ==UserScript==
// @name         IVAC Payment Callback Helper (RJ)
// @namespace    rj-ivac-payment-helper
// @version      1.0.0
// @description  dg-epay callback page e boshe protite 1s por por SAME-tab, same-origin fetch kore retry kore. 302 (redirect) = success -> ekbar navigate. 403 (spellbound) = chup chap abar try. Kono external server nei.
// @author       RJ
// @match        https://api.ivacbd.com/*payment*callback*
// @match        https://api.ivacbd.com/*dg-epay/callback*
// @match        https://api.ivacbd.com/iams/api/v1/payment/*/callback*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // --- eta callback page tai hoy? ---
  var HERE = location.href;
  var isCallback = /\/(payment|dg-epay)\b/i.test(HERE) && /callback/i.test(HERE) && /[?&]tran_id=/i.test(HERE);
  if (!isCallback) return;

  var tranId = (HERE.match(/[?&]tran_id=([^&#]+)/i) || [])[1] || '(?)';

  // ---------------- config ----------------
  var DELAY_MS = 1000;      // proti try er majhe gap
  var callbackUrl = HERE;   // same-origin, jei page e achi seti tai
  var running = true;
  var count = 0;
  var done = false;

  // ---------------- UI ----------------
  var panel, cEl, sEl;
  function buildUI() {
    if (document.getElementById('rj-pay-panel')) return;
    panel = document.createElement('div');
    panel.id = 'rj-pay-panel';
    panel.style.cssText = 'position:fixed;top:16px;right:16px;width:290px;z-index:2147483647;background:linear-gradient(160deg,#0d0d1e,#12122c,#0a0a18);border:1px solid rgba(124,58,237,.45);border-radius:12px;box-shadow:0 18px 46px rgba(0,0,0,.85);font-family:Segoe UI,system-ui,sans-serif;color:#e0e0f0;overflow:hidden';
    panel.innerHTML =
      '<div id="rj-pay-head" style="cursor:move;display:flex;justify-content:space-between;align-items:center;padding:9px 12px;background:linear-gradient(90deg,#0a0a18,#16162f,#0a0a18);border-bottom:1px solid rgba(124,58,237,.3)">' +
        '<span style="font-weight:800;font-size:.78rem;color:#c4b5fd">RJ Payment Helper</span>' +
        '<span id="rj-pay-toggle" style="cursor:pointer;color:#a78bfa;font-weight:800;font-size:.72rem;padding:0 6px">⏸</span>' +
      '</div>' +
      '<div style="padding:10px 12px">' +
        '<div style="font:700 .62rem Consolas,monospace;color:#8888aa;word-break:break-all;margin-bottom:6px">tran_id: <span style="color:#c4b5fd">' + tranId + '</span></div>' +
        '<div id="rj-pay-status" style="font:800 .8rem Segoe UI;color:#fcd34d;margin-bottom:4px">▶ retrying…</div>' +
        '<div id="rj-pay-count" style="font:700 .66rem Consolas,monospace;color:#8888aa;word-break:break-all"></div>' +
      '</div>';
    (document.body || document.documentElement).appendChild(panel);
    cEl = document.getElementById('rj-pay-count');
    sEl = document.getElementById('rj-pay-status');

    document.getElementById('rj-pay-toggle').onclick = function () {
      running = !running;
      this.textContent = running ? '⏸' : '▶';
      if (running) { setStatus('▶ retrying…', '#fcd34d'); tick(); }
      else setStatus('⏸ paused', '#8888aa');
    };
    // drag
    var h = document.getElementById('rj-pay-head'), dx = 0, dy = 0, drag = false;
    h.onmousedown = function (e) { drag = true; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop; e.preventDefault(); };
    document.addEventListener('mousemove', function (e) { if (!drag) return; panel.style.left = (e.clientX - dx) + 'px'; panel.style.top = (e.clientY - dy) + 'px'; panel.style.right = 'auto'; });
    document.addEventListener('mouseup', function () { drag = false; });
  }
  function setStatus(t, c) { if (sEl) { sEl.textContent = t; sEl.style.color = c || '#fcd34d'; } }
  function setCount(t, c) { if (cEl) { cEl.textContent = t; cEl.style.color = c || '#8888aa'; } }

  // ---------------- retry loop ----------------
  // success = 302 (redirect). same-origin + redirect:'manual' => response.type === 'opaqueredirect'.
  // fail = 403 spellbound => abar try.
  function tick() {
    if (!running || done) return;
    count++;
    setCount('#' + count + ' — ' + new Date().toLocaleTimeString(), '#8888aa');

    fetch(callbackUrl, {
      method: 'GET',
      redirect: 'manual',              // 302 dhorar jonno — auto follow korbe na
      cache: 'no-store',
      headers: { 'Upgrade-Insecure-Requests': '1' }
    }).then(function (r) {
      // opaqueredirect => 302/3xx dhora poreche => SUCCESS
      if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400) || r.status === 0 && r.type === 'opaqueredirect') {
        succeed('302 redirect');
        return;
      }
      // r.ok / 200 o success dhora jete pare (kichu khetre server 200 diye success dei)
      if (r.status >= 200 && r.status < 300) {
        succeed(r.status + ' ok');
        return;
      }
      // 403 spellbound ba onno kichu => abar
      console.log('%c[RJ Pay #' + count + '] ' + r.status + ' ' + r.type + ' — retry', 'color:#fca5a5;font-weight:700');
      setStatus('✗ ' + r.status + ' — retrying', '#fca5a5');
      schedule();
    }).catch(function (e) {
      console.log('%c[RJ Pay #' + count + '] ERR ' + e.message + ' — retry', 'color:#fca5a5;font-weight:700');
      setStatus('✗ err — retrying', '#fca5a5');
      schedule();
    });
  }
  function schedule() { if (running && !done) setTimeout(tick, DELAY_MS); }

  function succeed(reason) {
    done = true; running = false;
    console.log('%c[RJ Pay] SUCCESS (' + reason + ') after #' + count + ' — navigating…', 'color:#4ade80;font-weight:800');
    setStatus('✓ SUCCESS — ' + reason, '#4ade80');
    setCount('navigating to success page…', '#4ade80');
    // ekbar navigate kore success page e land — 302 follow hobe browser navigation die
    setTimeout(function () { window.location.href = callbackUrl; }, 400);
  }

  // start
  if (document.body) buildUI();
  else document.addEventListener('DOMContentLoaded', buildUI);
  document.addEventListener('DOMContentLoaded', buildUI);
  tick();
})();
