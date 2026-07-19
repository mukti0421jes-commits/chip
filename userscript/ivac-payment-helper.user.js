// ==UserScript==
// @name         IVAC Payment Callback Helper (RJ)
// @namespace    rj-ivac-payment-helper
// @version      2.0.0
// @description  Page er fetch/XHR intercept kore dg-epay callback (tran_id) DYNAMICALLY detect kore. Detect hole SAME-tab same-origin fetch die protite 1s por por retry. 302 = success -> navigate. 403 (spellbound) = abar try. Kono external server nei.
// @author       RJ
// @match        https://api.ivacbd.com/*
// @match        https://appointment.ivacbd.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------------- config / state ----------------
  var DELAY_MS = 1000;          // proti try er majhe gap
  var callbackUrl = null;       // detect howa callback URL
  var tranId = '— detect hoyni';
  var detected = false;
  var running = false;
  var count = 0;
  var done = false;

  // ---------------- callback URL cinha ----------------
  function isCallbackUrl(u) {
    if (!u) return false;
    try { u = '' + u; } catch (e) { return false; }
    return /\/(payment|dg-epay)\b/i.test(u) && /callback/i.test(u) && /[?&]tran_id=/i.test(u);
  }
  function absUrl(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }

  // ---------------- INTERCEPT: page er fetch + XHR ----------------
  // dg-epay callback request ta page nijei kore (same tab XHR/fetch), tai seta wrap kore dhori.
  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      try {
        var u = (input && input.url) ? input.url : input;
        if (isCallbackUrl(u)) onDetect(absUrl(u));
      } catch (e) {}
      return _fetch.apply(this, arguments);
    };
  }
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { if (isCallbackUrl(url)) onDetect(absUrl(url)); } catch (e) {}
    return _open.apply(this, arguments);
  };

  // location nijei callback hole (navigation case)
  if (isCallbackUrl(location.href)) onDetect(location.href);

  function onDetect(u) {
    if (detected && callbackUrl === u) return;   // ekbar-i
    callbackUrl = u;
    tranId = (u.match(/[?&]tran_id=([^&#]+)/i) || [])[1] || '(?)';
    detected = true;
    console.log('%c[RJ Pay] callback DETECTED: ' + u, 'color:#4ade80;font-weight:800');
    refreshPanel();
    if (ball) { ball.style.background = 'linear-gradient(145deg,#f59e0b,#d97706)'; ball.style.borderColor = '#fbbf24'; }
    // detect hoa matro nije theke retry shuru
    if (!running && !done) startLoop();
  }

  // ---------------- UI ----------------
  var panel, cEl, sEl, tEl, ball, btn;

  function buildBall() {
    if (document.getElementById('rj-pay-ball')) return;
    ball = document.createElement('div');
    ball.id = 'rj-pay-ball';
    ball.title = 'RJ Payment Helper';
    ball.style.cssText = 'position:fixed;bottom:20px;right:20px;width:46px;height:46px;border-radius:50%;z-index:2147483647;background:linear-gradient(145deg,#10b981,#059669);border:2px solid #34d399;box-shadow:0 6px 18px rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;color:#fff;font:800 .95rem Segoe UI,system-ui,sans-serif;cursor:pointer;user-select:none';
    ball.textContent = 'P';
    if (detected) { ball.style.background = 'linear-gradient(145deg,#f59e0b,#d97706)'; ball.style.borderColor = '#fbbf24'; }
    document.documentElement.appendChild(ball);
    var moved = false, dx = 0, dy = 0, drag = false;
    ball.onmousedown = function (e) { drag = true; moved = false; dx = e.clientX - ball.offsetLeft; dy = e.clientY - ball.offsetTop; e.preventDefault(); };
    document.addEventListener('mousemove', function (e) { if (!drag) return; moved = true; ball.style.left = (e.clientX - dx) + 'px'; ball.style.top = (e.clientY - dy) + 'px'; ball.style.right = 'auto'; ball.style.bottom = 'auto'; });
    document.addEventListener('mouseup', function () { drag = false; });
    ball.onclick = function () { if (moved) return; showPanel(); };
  }
  function showPanel() {
    if (ball) ball.style.display = 'none';
    if (panel) { panel.style.display = 'block'; refreshPanel(); return; }
    buildUI();
  }
  function minimize() {
    if (panel) panel.style.display = 'none';
    if (!document.getElementById('rj-pay-ball')) buildBall();
    else ball.style.display = 'flex';
  }

  function buildUI() {
    if (document.getElementById('rj-pay-panel')) { panel.style.display = 'block'; if (ball) ball.style.display = 'none'; return; }
    panel = document.createElement('div');
    panel.id = 'rj-pay-panel';
    panel.style.cssText = 'position:fixed;bottom:20px;right:20px;width:290px;z-index:2147483647;background:linear-gradient(160deg,#0d0d1e,#12122c,#0a0a18);border:1px solid rgba(124,58,237,.45);border-radius:12px;box-shadow:0 18px 46px rgba(0,0,0,.85);font-family:Segoe UI,system-ui,sans-serif;color:#e0e0f0;overflow:hidden';
    panel.innerHTML =
      '<div id="rj-pay-head" style="cursor:move;display:flex;justify-content:space-between;align-items:center;padding:9px 12px;background:linear-gradient(90deg,#0a0a18,#16162f,#0a0a18);border-bottom:1px solid rgba(124,58,237,.3)">' +
        '<span style="font-weight:800;font-size:.78rem;color:#c4b5fd">RJ Payment Helper</span>' +
        '<span id="rj-pay-toggle" style="cursor:pointer;color:#a78bfa;font-weight:800;font-size:.9rem;padding:0 6px" title="minimize">–</span>' +
      '</div>' +
      '<div style="padding:10px 12px">' +
        '<div id="rj-pay-tran" style="font:700 .62rem Consolas,monospace;color:#8888aa;word-break:break-all;margin-bottom:6px">tran_id: <span style="color:#c4b5fd">' + tranId + '</span></div>' +
        '<button id="rj-pay-btn" style="width:100%;border:1px solid #34d399;border-radius:7px;background:linear-gradient(135deg,#10b981,#059669);color:#fff;font-weight:800;font-size:.8rem;padding:8px 0;cursor:pointer;margin-bottom:8px">▶ Start</button>' +
        '<div id="rj-pay-status" style="font:800 .8rem Segoe UI;color:#8888aa;margin-bottom:4px">callback detect er opekkha…</div>' +
        '<div id="rj-pay-count" style="font:700 .66rem Consolas,monospace;color:#8888aa;word-break:break-all"></div>' +
      '</div>';
    document.documentElement.appendChild(panel);
    cEl = document.getElementById('rj-pay-count');
    sEl = document.getElementById('rj-pay-status');
    tEl = document.getElementById('rj-pay-tran');
    btn = document.getElementById('rj-pay-btn');

    btn.onclick = function () {
      if (done) return;
      if (!detected) { setStatus('❌ akhono callback detect hoyni', '#fca5a5'); return; }
      if (running) { stopLoop('manual'); } else { startLoop(); }
    };
    document.getElementById('rj-pay-toggle').onclick = function () { minimize(); };
    var h = document.getElementById('rj-pay-head'), dx = 0, dy = 0, drag = false;
    h.onmousedown = function (e) { drag = true; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop; e.preventDefault(); };
    document.addEventListener('mousemove', function (e) { if (!drag) return; panel.style.left = (e.clientX - dx) + 'px'; panel.style.top = (e.clientY - dy) + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto'; });
    document.addEventListener('mouseup', function () { drag = false; });
    refreshPanel();
  }
  function setBtn(on) {
    if (!btn) return;
    btn.textContent = on ? '⏹ Stop' : (detected ? '▶ Start' : '⏳ waiting');
    btn.style.background = on ? 'linear-gradient(135deg,#ef4444,#b91c1c)' : 'linear-gradient(135deg,#10b981,#059669)';
    btn.style.borderColor = on ? '#f87171' : '#34d399';
    btn.style.opacity = detected ? '1' : '.6';
  }
  function refreshPanel() {
    if (tEl) tEl.innerHTML = 'tran_id: <span style="color:#c4b5fd">' + tranId + '</span>';
    if (sEl && !running && !done) setStatus(detected ? '✓ callback detect holo — Start chapun ba auto' : 'callback detect er opekkha…', detected ? '#4ade80' : '#8888aa');
    setBtn(running);
  }
  function setStatus(t, c) { if (sEl) { sEl.textContent = t; sEl.style.color = c || '#fcd34d'; } }
  function setCount(t, c) { if (cEl) { cEl.textContent = t; cEl.style.color = c || '#8888aa'; } }

  // ---------------- retry loop ----------------
  var timer = null;
  function startLoop() {
    if (!detected || !callbackUrl || done) return;
    running = true; setBtn(true);
    setStatus('▶ retrying…', '#fcd34d');
    tick();
  }
  function stopLoop(reason) {
    running = false; if (timer) { clearTimeout(timer); timer = null; }
    setBtn(false); if (reason) setStatus('⏹ stopped (' + reason + ')', '#8888aa');
  }
  function tick() {
    if (!running || done) return;
    count++;
    setCount('#' + count + ' — ' + new Date().toLocaleTimeString(), '#8888aa');
    fetch(callbackUrl, { method: 'GET', redirect: 'manual', cache: 'no-store', headers: { 'Upgrade-Insecure-Requests': '1' } })
      .then(function (r) {
        if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) { succeed('302 redirect'); return; }
        if (r.status >= 200 && r.status < 300) { succeed(r.status + ' ok'); return; }
        console.log('%c[RJ Pay #' + count + '] ' + r.status + ' ' + r.type + ' — retry', 'color:#fca5a5;font-weight:700');
        setStatus('✗ ' + r.status + ' — retrying', '#fca5a5');
        schedule();
      }).catch(function (e) {
        console.log('%c[RJ Pay #' + count + '] ERR ' + e.message + ' — retry', 'color:#fca5a5;font-weight:700');
        setStatus('✗ err — retrying', '#fca5a5');
        schedule();
      });
  }
  function schedule() { if (running && !done) timer = setTimeout(tick, DELAY_MS); }

  function succeed(reason) {
    done = true; running = false;
    console.log('%c[RJ Pay] SUCCESS (' + reason + ') after #' + count + ' — navigating…', 'color:#4ade80;font-weight:800');
    setStatus('✓ SUCCESS — ' + reason, '#4ade80');
    setCount('navigating to success page…', '#4ade80');
    if (btn) { btn.textContent = '✓ done'; btn.disabled = true; btn.style.opacity = '.7'; }
    if (ball) { ball.style.background = 'linear-gradient(145deg,#10b981,#059669)'; ball.textContent = '✓'; }
    setTimeout(function () { window.location.href = callbackUrl; }, 400);
  }

  // default e choto ball. SPA body swap e harale abar boshabe.
  function mount() { if (!document.getElementById('rj-pay-ball') && !document.getElementById('rj-pay-panel')) buildBall(); }
  mount();
  document.addEventListener('DOMContentLoaded', mount);
  window.addEventListener('load', mount);
  setInterval(mount, 1500);
})();
