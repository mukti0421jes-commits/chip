/* backend.js — RJ Automation সার্ভার ইন্টিগ্রেশন (pay-as-you-go)
   সব এক্সটেনশন পেজ এই মডিউল ব্যবহার করে: login/register, ব্যালেন্স, per-use charge, server OCR।
   টোকেন chrome.storage.local এ 'rjToken' হিসেবে থাকে — সব পেজ একই টোকেন শেয়ার করে। */

export const RJ_SERVER = 'https://app.duttauzzal.shop';

function getTok() {
  return new Promise((res) => chrome.storage.local.get(['rjToken'], (r) => res(r.rjToken || '')));
}
function setTok(t) {
  return new Promise((res) => chrome.storage.local.set({ rjToken: t || '' }, () => res()));
}

export async function rjGetToken() { return getTok(); }
export async function rjLoggedIn() { return !!(await getTok()); }
export async function rjLogout() { await setTok(''); }

async function api(path, method, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) { const t = await getTok(); if (t) headers.Authorization = 'Bearer ' + t; }
  let r;
  try {
    r = await fetch(RJ_SERVER + '/api/' + path, {
      method: method || 'GET', headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, status: 0, j: { error: 'সার্ভারে সংযোগ হচ্ছে না (ইন্টারনেট/সার্ভার চেক করুন)' } };
  }
  let j = {}; try { j = await r.json(); } catch (_) {}
  if (r.status === 401) await setTok('');   // টোকেন নষ্ট → লগআউট
  return { ok: r.ok, status: r.status, j };
}

export async function rjLogin(email, password) {
  const { ok, j } = await api('login', 'POST', { email, password }, false);
  if (ok && j.token) await setTok(j.token);
  return { ok, j };
}
export async function rjRegister(email, password) {
  const { ok, j } = await api('register', 'POST', { email, password }, false);
  if (ok && j.token) await setTok(j.token);
  return { ok, j };
}
export async function rjMe() { return api('me', 'GET'); }

/* per-use charge — note: কোন কাজের জন্য (webfile/passport/undertaking/pdf-edit/invoice)
   return: {ok, balance}  অথবা  {low:true, balance, need}  অথবা  {error} */
export async function rjCharge(note) {
  const { ok, status, j } = await api('charge', 'POST', { note: note || 'webfile' });
  if (ok) return { ok: true, balance: j.balance };
  if (status === 402) return { ok: false, low: true, balance: j.balance, need: j.need };
  if (status === 401) return { ok: false, needLogin: true, error: j.error || 'login লাগবে' };
  return { ok: false, error: j.error || 'চার্জ ব্যর্থ' };
}

/* server-side OCR (key সার্ভারে লুকানো) — dataUrl = 'data:image/...;base64,...' */
export async function rjOcr(dataUrl) {
  const { ok, j } = await api('ocr', 'POST', { imageBase64: dataUrl });
  if (!ok) throw new Error(j.error || 'OCR ব্যর্থ');
  return j.text || '';
}
