/* ===================================================================
   Visa Autofill (PDF) — content script
   indianvisa-bangladesh.nic.in ফর্মে সেভ করা তথ্য অটো-ফিল করে।
   প্রতিটা পেজে যেসব field id আছে শুধু সেগুলোই ভরে (page-router লাগে না)।
   =================================================================== */

(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function showBadge(text, color = '#e67e22') {
    let b = document.getElementById('vafill-badge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'vafill-badge';
      b.style.cssText =
        'position:fixed;top:10px;right:10px;z-index:2147483647;padding:8px 14px;' +
        'border-radius:6px;color:#fff;font:13px Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)';
      document.body.appendChild(b);
    }
    b.style.background = color;
    b.textContent = text;
  }

  // select-এ value মিললে value দিয়ে, নাহলে দৃশ্যমান লেখা (option text) দিয়ে মেলায়।
  // ফলে "BANGLADESH" বা "BGD" — দুটোর যেকোনোটাই কাজ করে।
  function setValueSmart(el, raw) {
    if (el == null || raw == null || raw === '') return false;
    const val = String(raw).trim();
    if (el.tagName === 'SELECT') {
      const opts = Array.from(el.options);
      let opt = opts.find((o) => o.value === val);
      if (!opt) opt = opts.find((o) => o.value.toUpperCase() === val.toUpperCase());
      if (!opt) opt = opts.find((o) => (o.textContent || '').trim().toUpperCase() === val.toUpperCase());
      if (!opt) opt = opts.find((o) => (o.textContent || '').trim().toUpperCase().includes(val.toUpperCase()) && val.length > 2);
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function fillById(id, value) {
    const el = document.getElementById(id);
    if (!el) return false;
    return setValueSmart(el, value);
  }

  function clickRadio(id, shouldWant) {
    const el = document.getElementById(id);
    if (!el) return false;
    if (!el.checked) el.click();
    return true;
  }

  function setCheckbox(id, want) {
    const el = document.getElementById(id);
    if (!el) return false;
    if (!!el.checked !== !!want) el.click();
    return true;
  }

  function setAutoConfirm(enabled) {
    document.dispatchEvent(new CustomEvent('ivac-macros-autoconfirm', { detail: { enabled } }));
  }

  // MAIN world-এ jQuery কাজ চালাতে (chosen Purpose + datepicker বন্ধ)
  function mainWorld(detail) {
    document.dispatchEvent(new CustomEvent('vafill-main', { detail }));
  }

  // state বদলানোর পর AJAX-এ district আসতে সময় লাগে — option না আসা পর্যন্ত অপেক্ষা
  async function waitAndSet(id, value, timeoutMs = 6000) {
    if (!value) return false;
    const start = Date.now();
    await sleep(400);
    while (Date.now() - start < timeoutMs) {
      const el = document.getElementById(id);
      if (el && el.options && el.options.length > 1) {
        if (setValueSmart(el, value)) return true;
      }
      await sleep(250);
    }
    return fillById(id, value);
  }

  // flags → সঠিক radio/checkbox
  async function applyFlags(flags) {
    if (!flags) return;
    if (flags.changedName) { setCheckbox('changedSurnameCheck', true); await sleep(200); }
    if (flags.sameAddress) setCheckbox('sameAddress_id', true);

    if (flags.otherPassport) clickRadio(flags.otherPassport === 'YES' ? 'other_ppt_1' : 'other_ppt_2');
    // Grandfather/Grandmother Pakistan প্রশ্ন — নিয়ম অনুযায়ী সবসময় "No"
    clickRadio('grandparent_flag2');
    if (flags.visitedIndia) { clickRadio(flags.visitedIndia === 'YES' ? 'old_visa_flag1' : 'old_visa_flag2'); await sleep(200); }
    if (flags.refused) clickRadio(flags.refused === 'YES' ? 'refuse_flag1' : 'refuse_flag2');
    if (flags.saarc) clickRadio(flags.saarc === 'YES' ? 'saarc_flag1' : 'saarc_flag2');
    if (flags.military) clickRadio(flags.military === 'YES' ? 'prev_org1' : 'prev_org2');
  }

  // Additional Questions পেজ: প্রতিটা প্রশ্নের radio "No" + declaration checkbox টিক
  function fillAdditionalQuestions() {
    const groups = {};
    document.querySelectorAll('input[type="radio"]').forEach((r) => {
      const k = r.name || r.id;
      (groups[k] = groups[k] || []).push(r);
    });
    let n = 0;
    for (const k in groups) {
      const no = groups[k].find((r) => /^\s*n(o)?\s*$/i.test(r.value)) ||
        groups[k].find((r) => /\bno\b/i.test(r.value)) ||
        groups[k].find((r) => /\bno\b/i.test((document.querySelector('label[for="' + r.id + '"]') || {}).textContent || ''));
      if (no) { if (!no.checked) no.click(); n++; }
    }
    // declaration checkbox (নিচের "I ... hereby declare")
    document.querySelectorAll('input[type="checkbox"]').forEach((c) => { if (!c.disabled && !c.checked) c.click(); });
    showBadge('✔ সব প্রশ্ন No + declaration টিক — যাচাই করে Continue চাপুন', '#27ae60');
    return n;
  }

  // Registration পেজ: dropdown গুলো ধাপে ধাপে AJAX-এ লোড হয়, তাই ক্রম মেনে অপেক্ষা করে ভরি
  async function fillRegistration(data) {
    const v = data.values || {};
    if (v.countryname_id) { fillById('countryname_id', v.countryname_id); await sleep(700); }
    if (v.missioncode_id) { fillById('missioncode_id', v.missioncode_id); await sleep(500); }
    // Nationality option AJAX-এ আসে — অপেক্ষা করে সেট (এতে Purpose AJAX-ও শুরু হয়)
    if (v.nationality_id) { await waitAndSet('nationality_id', v.nationality_id, 8000); await sleep(500); }

    const setTexts = () => {
      fillById('dob_id', v.dob_id);
      fillById('email_id', v.email_id);
      fillById('email_re_id', v.email_re_id || v.email_id);
      fillById('jouryney_id', v.jouryney_id);
    };
    setTexts();
    mainWorld({ purpose: v.visaPurposeDropdown || '' }); // chosen Purpose + datepicker বন্ধ
    await sleep(700);
    setTexts(); // AJAX reset ঠেকাতে আবার
    mainWorld({ purpose: v.visaPurposeDropdown || '' });

    const cap = document.getElementById('captcha');
    if (cap) cap.focus();
    showBadge('✔ ফিল হয়েছে — CAPTCHA টাইপ করে Continue চাপুন', '#27ae60');
  }

  async function fillPage(data) {
    const values = data.values || {};
    const flags = data.flags || {};

    // radio/checkbox আগে সেট করি (এগুলো লুকানো field দেখায়/লুকায়)
    await applyFlags(flags);
    await sleep(150);

    // প্রথমে present-country/state জাতীয় dropdown সেট, যাতে dependent AJAX শুরু হয়
    if (values.pres_country) { fillById('pres_country', values.pres_country); await sleep(300); }
    if (values.stateofsponsor_ind) { fillById('stateofsponsor_ind', values.stateofsponsor_ind); }
    if (values.marital_status) { fillById('marital_status', values.marital_status); await sleep(250); }
    if (values.occupation) { fillById('occupation', values.occupation); await sleep(200); }

    // dependent district আলাদাভাবে অপেক্ষা করে সেট করি
    const deferred = new Set(['districtofsponsor_ind', 'pos_dist_id1', 'pos_dist_id2']);

    for (const [id, val] of Object.entries(values)) {
      if (deferred.has(id)) continue;
      fillById(id, val);
    }

    if (values.districtofsponsor_ind) await waitAndSet('districtofsponsor_ind', values.districtofsponsor_ind);
    if (values.pos_dist_id1) await waitAndSet('pos_dist_id1', values.pos_dist_id1);

    showBadge('✔ ফিল হয়েছে — যাচাই করে Continue চাপুন', '#27ae60');
  }

  async function run() {
    chrome.storage.local.get(['vaProfiles', 'vaActiveId', 'vaEnabled', 'vaAutoContinue'], async (res) => {
      if (res.vaEnabled === false) return;
      const profiles = res.vaProfiles || {};
      const active = res.vaActiveId && profiles[res.vaActiveId];
      if (!active) {
        showBadge('⚠ কোনো profile সিলেক্ট করা নেই — extension আইকনে ক্লিক করুন', '#c0392b');
        return;
      }
      const path = window.location.pathname;

      // এই পেজগুলোতে CAPTCHA/আপলোড/চূড়ান্ত-রিভিউ — কখনো অটো-ক্লিক নয়
      if (/PhotoUpload/i.test(path)) { showBadge('⚠ ছবি আপলোড ম্যানুয়ালি করুন', '#c0392b'); return; }
      if (/DocumentUpload/i.test(path)) { showBadge('⚠ ডকুমেন্ট আপলোড ম্যানুয়ালি করুন', '#c0392b'); return; }
      if (/Confirm/i.test(path)) { showBadge('👀 সব যাচাই করে তারপর Confirm করুন', '#e67e22'); return; }

      // Additional Questions পেজ: ৬টা প্রশ্নই "No" + declaration checkbox টিক
      if (/AdditionalQuestion/i.test(path)) {
        fillAdditionalQuestions();
        if (res.vaAutoContinue === true) {
          await sleep(500);
          const btn = document.getElementById('continue');
          if (btn) { showBadge('➡ অটো-Continue...', '#2980b9'); await sleep(400); btn.click(); }
        }
        return;
      }

      const isRegistration = /Registration/i.test(path);
      setAutoConfirm(true);
      const purpose = (active.values || {}).visaPurposeDropdown || '';
      try {
        // Registration পেজ আলাদা — cascading dropdown ক্রম মেনে ভরতে হয়
        if (isRegistration) {
          await fillRegistration(active);
          return; // Registration পেজে কখনো অটো-Continue নয়
        }

        await fillPage(active);
        await sleep(1200);
        await fillPage(active); // resume করলে সাইট নিজে reset করতে পারে — আবার বসাই

        // chosen Purpose সেট + খোলা datepicker বন্ধ (পেজের jQuery দিয়ে, MAIN world)
        mainWorld({ purpose });
        setTimeout(() => mainWorld({ purpose }), 1500); // purpose option AJAX-এ এলে আবার

        if (res.vaAutoContinue === true) {
          await sleep(500);
          const btn = document.getElementById('continue');
          if (btn) { showBadge('➡ অটো-Continue...', '#2980b9'); await sleep(400); btn.click(); }
        }
      } catch (err) {
        showBadge('✘ এরর — কনসোল দেখুন (F12)', '#c0392b');
        console.error('[Visa Autofill] error:', err);
      } finally {
        setAutoConfirm(false);
      }
    });
  }

  if (document.readyState === 'complete') setTimeout(run, 500);
  else window.addEventListener('load', () => setTimeout(run, 500));
})();
