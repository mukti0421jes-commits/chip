function fetchSnippet(u) {
  return 'fetch("' + u + '", {\n  method: "GET", redirect: "manual", cache: "no-store", credentials: "include",\n  headers: { "Upgrade-Insecure-Requests": "1" }\n}).then(r => console.log("status:", r.status, r.type));';
}
function render(S) {
  S = S || {};
  document.getElementById('tid').textContent = S.tranId || '— waiting —';
  document.getElementById('url').value = S.url || '';
  document.getElementById('st').textContent = S.status || 'waiting…';
  document.getElementById('st').style.color = S.done ? '#4ade80' : (S.url ? '#fcd34d' : '#8888aa');
}
function ask(msg) { try { chrome.runtime.sendMessage(msg, render); } catch (e) {} }

document.getElementById('cp').onclick = function () {
  var u = document.getElementById('url').value; if (!u) return;
  navigator.clipboard.writeText(fetchSnippet(u)).then(() => { this.textContent = 'Copied!'; setTimeout(() => this.textContent = 'Copy fetch', 1200); });
};
document.getElementById('fire').onclick = function () { ask('fire'); };
document.getElementById('rst').onclick = function () { ask('reset'); };

ask('get');
setInterval(() => ask('get'), 1000);   // live-refresh while open
