/* RJ Automation landing/dashboard */
const $ = (id) => document.getElementById(id);
let TOKEN = localStorage.getItem('rj_token') || '';
let CFG = {};

async function api(path, method, body) {
  const r = await fetch('/api/' + path, {
    method: method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}
function msg(el, text, ok) { const e = $(el); e.textContent = text; e.className = 'msg ' + (ok ? 'ok' : 'err'); }

// download link
$('dlBtn').href = '/download/rj-automation.zip';

// tabs
$('tabLogin').onclick = () => { $('tabLogin').className = 'on'; $('tabReg').className = ''; $('loginForm').classList.remove('hidden'); $('regForm').classList.add('hidden'); };
$('tabReg').onclick = () => { $('tabReg').className = 'on'; $('tabLogin').className = ''; $('regForm').classList.remove('hidden'); $('loginForm').classList.add('hidden'); };

$('regBtn').onclick = async () => {
  const { ok, j } = await api('register', 'POST', { email: $('rEmail').value, password: $('rPass').value });
  if (!ok) return msg('authMsg', j.error || 'ব্যর্থ', false);
  TOKEN = j.token; localStorage.setItem('rj_token', TOKEN); showDash();
};
$('loginBtn').onclick = async () => {
  const { ok, j } = await api('login', 'POST', { email: $('lEmail').value, password: $('lPass').value });
  if (!ok) return msg('authMsg', j.error || 'ব্যর্থ', false);
  TOKEN = j.token; localStorage.setItem('rj_token', TOKEN); showDash();
};
$('logoutBtn').onclick = () => { TOKEN = ''; localStorage.removeItem('rj_token'); location.reload(); };
$('refreshBtn').onclick = showDash;

$('rcBtn').onclick = async () => {
  const { ok, j } = await api('recharge', 'POST', { method: $('rcMethod').value, amount: +$('rcAmount').value, txnid: $('rcTxn').value });
  if (!ok) return msg('rcMsg', j.error || 'ব্যর্থ', false);
  msg('rcMsg', j.message || 'জমা হয়েছে', true); $('rcTxn').value = ''; $('rcAmount').value = ''; loadHistory();
};

async function showDash() {
  const { ok, j } = await api('me');
  if (!ok) { $('authCard').classList.remove('hidden'); $('dash').classList.add('hidden'); $('navUser').innerHTML = ''; return; }
  CFG = j;
  $('authCard').classList.add('hidden'); $('dash').classList.remove('hidden');
  $('bal').textContent = j.user.balance; $('price').textContent = j.pricePerUse;
  $('cur').textContent = j.currency; $('cur2').textContent = j.currency; $('minR').textContent = j.minRecharge;
  $('rcAmount').placeholder = j.minRecharge;
  $('navUser').innerHTML = '<span style="color:#fff">' + j.user.email + ' · <b>' + j.user.balance + ' ' + j.currency + '</b></span>' + (j.user.isAdmin ? ' · <a href="/admin" style="color:#fff;text-decoration:underline">admin</a>' : '');
  const p = j.payment || {};
  $('payNums').innerHTML = Object.keys(p).filter((k) => p[k]).map((k) => '<div class="num">' + k.toUpperCase() + ': ' + p[k] + '</div>').join('');
  loadHistory();
}
async function loadHistory() {
  const { ok, j } = await api('history');
  if (!ok) return;
  const rows = [];
  (j.recharges || []).forEach((r) => rows.push({ at: r.at, t: 'রিচার্জ (' + r.method + ')', a: '+' + r.amount, s: r.status }));
  (j.txns || []).forEach((t) => rows.push({ at: t.at, t: t.type === 'recharge' ? 'রিচার্জ গৃহীত' : (t.note || 'webfile'), a: (t.amount > 0 ? '+' : '') + t.amount, s: '' }));
  rows.sort((a, b) => b.at - a.at);
  $('histTbl').querySelector('tbody').innerHTML = '<tr><th>সময়</th><th>বিবরণ</th><th>টাকা</th><th>অবস্থা</th></tr>' +
    rows.slice(0, 40).map((r) => '<tr><td>' + new Date(r.at).toLocaleString() + '</td><td>' + r.t + '</td><td>' + r.a + '</td><td>' + (r.s || '') + '</td></tr>').join('');
}
if (TOKEN) showDash();
