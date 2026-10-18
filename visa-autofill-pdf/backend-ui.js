/* backend-ui.js — শেয়ারড UI: login overlay, ব্যালেন্স ব্যাজ, "X TK কাটবে?" কনফার্ম মডাল।
   যেকোনো এক্সটেনশন পেজ এটা import করে ব্যবহার করতে পারে — নিজের CSS নিজেই বসায়। */
import { RJ_SERVER, rjLogin, rjRegister, rjMe, rjLogout, rjCharge } from './backend.js';

let injected = false;
function injectCss() {
  if (injected) return; injected = true;
  const s = document.createElement('style');
  s.textContent = `
  .rjov{position:fixed;inset:0;z-index:2147483600;background:rgba(6,14,24,.72);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:16px;font-family:"Noto Sans Bengali","Segoe UI",Arial,sans-serif}
  .rjbox{width:100%;max-width:380px;background:#fff;color:#0b1220;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.4);overflow:hidden}
  .rjhd{background:linear-gradient(135deg,#0b6b4e,#12b886);color:#fff;padding:16px 18px;font-weight:800;display:flex;align-items:center;gap:10px}
  .rjhd .l{width:34px;height:34px;border-radius:9px;background:#fff;color:#0b6b4e;display:flex;align-items:center;justify-content:center;font-weight:800}
  .rjbd{padding:18px}
  .rjtabs{display:flex;gap:8px;margin-bottom:12px}
  .rjtabs button{flex:1;padding:9px;border-radius:9px;border:1px solid #d7dee7;background:#fff;color:#0b1220;font-weight:700;cursor:pointer;font-family:inherit}
  .rjtabs button.on{background:linear-gradient(135deg,#0b6b4e,#12b886);border:none;color:#fff}
  .rjbd label{font-size:12px;color:#41506a;display:block;margin-top:8px}
  .rjbd input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d7dee7;border-radius:9px;margin-top:4px;font-size:14px;font-family:inherit}
  .rjbtn{width:100%;margin-top:14px;padding:11px;border:none;border-radius:10px;background:linear-gradient(135deg,#0b6b4e,#12b886);color:#fff;font-weight:800;font-size:15px;cursor:pointer;font-family:inherit}
  .rjbtn.sec{background:#eef2f7;color:#0b1220}
  .rjmsg{min-height:18px;font-size:13px;margin-top:10px;font-weight:700}.rjmsg.err{color:#dc2626}.rjmsg.ok{color:#0b6b4e}
  .rjnote{font-size:12px;color:#41506a;margin-top:10px;line-height:1.5}
  .rjrow{display:flex;gap:10px;margin-top:14px}.rjrow .rjbtn{margin-top:0}
  .rjlink{color:#0b6b4e;font-weight:700;text-decoration:underline;cursor:pointer}
  .rjchip{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.35);color:#fff;border-radius:20px;padding:4px 12px;font-size:13px;font-weight:700}
  .rjchip b{font-size:14px}
  @media (prefers-color-scheme: dark){
    .rjbox{background:#16233b;color:#f2f6fc}
    .rjtabs button{background:#0e1a2e;color:#f2f6fc;border-color:#2b3a52}
    .rjbd input{background:#0e1a2e;color:#f2f6fc;border-color:#2b3a52}
    .rjbtn.sec{background:#24344f;color:#f2f6fc}
    .rjnote,.rjbd label{color:#9fb3cd}
  }`;
  document.head.appendChild(s);
}

let cachedMe = null;      // {user, pricePerUse, currency, ...}
export function rjPrice() { return cachedMe ? cachedMe.pricePerUse : 2; }
export function rjCurrency() { return cachedMe ? cachedMe.currency : 'TK'; }

/* লগইন নিশ্চিত করে। logged in হলে সঙ্গে সঙ্গে me ফেরত; নাহলে overlay দেখায়,
   সফল login/register-এর পর resolve করে। returns me-data {user, pricePerUse, currency}. */
export function rjRequireLogin(opts = {}) {
  return new Promise(async (resolve) => {
    const { ok, j } = await rjMe();
    if (ok && j.user) { cachedMe = j; resolve(j); return; }
    showLoginOverlay(resolve, opts);
  });
}

function showLoginOverlay(resolve, opts) {
  injectCss();
  const ov = document.createElement('div'); ov.className = 'rjov';
  ov.innerHTML = `
    <div class="rjbox">
      <div class="rjhd"><div class="l">RJ</div><div>RJ Automation — লগইন</div></div>
      <div class="rjbd">
        <div class="rjtabs"><button class="on" data-t="login">লগইন</button><button data-t="reg">নতুন অ্যাকাউন্ট</button></div>
        <label>ইমেইল বা মোবাইল</label><input id="rjEmail" placeholder="example@mail.com / 01XXXXXXXXX">
        <label>পাসওয়ার্ড</label><input id="rjPass" type="password" placeholder="পাসওয়ার্ড">
        <button class="rjbtn" id="rjGo">লগইন</button>
        <div class="rjmsg" id="rjMsg"></div>
        <div class="rjnote">অ্যাকাউন্ট/রিচার্জ: <span class="rjlink" id="rjSite">${RJ_SERVER.replace('https://','')}</span> — এখানে রিচার্জ করে কাজ করুন।</div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  let mode = 'login';
  const q = (s) => ov.querySelector(s);
  const setMsg = (t, ok) => { const m = q('#rjMsg'); m.textContent = t || ''; m.className = 'rjmsg ' + (ok ? 'ok' : 'err'); };
  ov.querySelectorAll('.rjtabs button').forEach((b) => b.onclick = () => {
    mode = b.dataset.t;
    ov.querySelectorAll('.rjtabs button').forEach((x) => x.classList.toggle('on', x === b));
    q('#rjGo').textContent = mode === 'login' ? 'লগইন' : 'অ্যাকাউন্ট তৈরি করুন';
    setMsg('');
  });
  q('#rjSite').onclick = () => chrome.tabs ? chrome.tabs.create({ url: RJ_SERVER }) : window.open(RJ_SERVER, '_blank');
  q('#rjGo').onclick = async () => {
    const email = q('#rjEmail').value.trim(), pass = q('#rjPass').value;
    if (!email || !pass) { setMsg('ইমেইল ও পাসওয়ার্ড দিন', false); return; }
    setMsg('অপেক্ষা করুন...', true);
    const fn = mode === 'login' ? rjLogin : rjRegister;
    const { ok, j } = await fn(email, pass);
    if (!ok) { setMsg(j.error || 'ব্যর্থ', false); return; }
    const me = await rjMe();
    cachedMe = me.ok ? me.j : null;
    ov.remove();
    resolve(cachedMe || { user: j.user, pricePerUse: 2, currency: 'TK' });
  };
  q('#rjEmail').focus();
}

/* হেডারে ব্যালেন্স চিপ বসায় ও রিফ্রেশ করে। returns refresh() ফাংশন। */
export function rjMountBalance(hostEl) {
  injectCss();
  const chip = document.createElement('span');
  chip.className = 'rjchip';
  chip.innerHTML = '💰 <b id="rjBal">…</b> <span id="rjCur"></span>';
  hostEl.appendChild(chip);
  const refresh = async () => {
    const { ok, j } = await rjMe();
    if (ok && j.user) {
      cachedMe = j;
      chip.querySelector('#rjBal').textContent = j.user.balance;
      chip.querySelector('#rjCur').textContent = j.currency;
    }
  };
  refresh();
  return refresh;
}

/* "X TK কাটবে? হ্যাঁ/না" মডাল। হ্যাঁ দিলে চার্জ করে।
   returns {charged:true, balance} | {cancelled:true} | {low:true} (রিচার্জ পেজ খোলা হয়) */
export function rjChargeConfirm(note, label) {
  return new Promise(async (resolve) => {
    injectCss();
    // লগইন না থাকলে আগে লগইন করাই (তারপরই চার্জ কনফার্ম দেখাই)
    const me = await rjMe();
    if (!me.ok || !me.j || !me.j.user) {
      await new Promise((r) => showLoginOverlay((d) => { cachedMe = d; r(); }, {}));
    }
    const price = rjPrice(), cur = rjCurrency();
    const ov = document.createElement('div'); ov.className = 'rjov';
    ov.innerHTML = `
      <div class="rjbox">
        <div class="rjhd"><div class="l">RJ</div><div>নিশ্চিত করুন</div></div>
        <div class="rjbd">
          <div style="font-size:15px;line-height:1.6">
            <b>${label || 'এই কাজটি'}</b> করতে আপনার অ্যাকাউন্ট থেকে
            <b style="color:#0b6b4e">${price} ${cur}</b> কাটা হবে।<br>আপনি কি করতে চান?
          </div>
          <div class="rjmsg" id="rjCMsg"></div>
          <div class="rjrow">
            <button class="rjbtn sec" id="rjNo">না</button>
            <button class="rjbtn" id="rjYes">হ্যাঁ, করুন (${price} ${cur})</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const q = (s) => ov.querySelector(s);
    const setMsg = (t, ok) => { const m = q('#rjCMsg'); m.textContent = t || ''; m.className = 'rjmsg ' + (ok ? 'ok' : 'err'); };
    q('#rjNo').onclick = () => { ov.remove(); resolve({ cancelled: true }); };
    q('#rjYes').onclick = async () => {
      q('#rjYes').disabled = true; setMsg('প্রসেস হচ্ছে...', true);
      const r = await rjCharge(note);
      if (r.ok) { ov.remove(); resolve({ charged: true, balance: r.balance }); return; }
      if (r.low) {
        setMsg('ব্যালেন্স কম (আছে ' + (r.balance || 0) + ' ' + cur + ')। রিচার্জ করুন।', false);
        q('#rjYes').textContent = 'রিচার্জ করুন';
        q('#rjYes').disabled = false;
        q('#rjYes').onclick = () => { (chrome.tabs ? chrome.tabs.create({ url: RJ_SERVER }) : window.open(RJ_SERVER, '_blank')); ov.remove(); resolve({ low: true }); };
        return;
      }
      if (r.needLogin) { ov.remove(); resolve({ needLogin: true }); return; }
      setMsg(r.error || 'চার্জ ব্যর্থ', false); q('#rjYes').disabled = false;
    };
  });
}

export { rjLogout };
