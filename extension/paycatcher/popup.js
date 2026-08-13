function fetchSnippet(u) {
  return 'fetch("' + u + '", {\n  method: "GET", redirect: "manual", cache: "no-store", credentials: "include",\n  headers: { "Upgrade-Insecure-Requests": "1" }\n}).then(r => console.log("status:", r.status, r.type));';
}
var lastUrl = '';
function render(S) {
  S = S || {};
  document.getElementById('tid').textContent = S.tranId || '— waiting —';
  var urlEl = document.getElementById('url');
  if (S.url !== lastUrl) { urlEl.value = S.url || ''; lastUrl = S.url || ''; }
  var st = document.getElementById('st');
  st.textContent = S.status || 'waiting…';
  st.style.color = S.done ? '#4ade80' : (S.stopped ? '#8888aa' : (S.url ? '#fcd34d' : '#8888aa'));
  var auto = document.getElementById('auto');
  auto.textContent = 'auto: ' + (S.autofire ? 'ON' : 'OFF');
  auto.style.background = S.autofire ? '#4f46e5' : '#333';
  var ivl = document.getElementById('ivl');
  if (document.activeElement !== ivl && S.intervalMs) ivl.value = S.intervalMs;
}
function send(cmd, extra) { try { chrome.runtime.sendMessage(Object.assign({ cmd: cmd }, extra || {}), render); } catch (e) {} }

document.getElementById('cp').onclick = function () {
  var u = document.getElementById('url').value; if (!u) return;
  navigator.clipboard.writeText(fetchSnippet(u)).then(() => { this.textContent = 'Copied!'; setTimeout(() => this.textContent = 'Copy fetch', 1200); });
};
document.getElementById('fire').onclick = function () { send('fire'); };
document.getElementById('stop').onclick = function () { send('stop'); };
document.getElementById('rst').onclick = function () { send('reset'); };
document.getElementById('auto').onclick = function () { send('auto'); };
document.getElementById('ivl').onchange = function () { send('interval', { value: this.value }); };

send('get');
setInterval(() => send('get'), 700);   // live-refresh while open
