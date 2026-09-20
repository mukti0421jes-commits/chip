import * as pdfjsLib from './lib/pdf.min.mjs';
import { parseVisaPdf, parseRefBlock } from './pdf-extract.js';
import { ocrImage, parsePassport } from './ocr.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const SITE = 'https://indianvisa-bangladesh.nic.in/visa/';

// ---------- ফর্ম স্কিমা: tab → field সমূহ (k=value id, flag=YES/NO, chk=checkbox) ----------
const TABS = [
  { t: 'Mission', f: [
    ['countryname_id', 'Country you apply from', 'BGD = Bangladesh'],
    ['missioncode_id', 'Indian Mission/Office', 'BGDD Dhaka, BGDC Chittagong...'],
    ['nationality_id', 'Nationality', 'BGD = Bangladesh'],
    ['visaTypeText', 'Visa Type (dropdown লেখা)', 'যেমন TOURIST VISA / MEDICAL VISA / MISCELLANEOUS VISA — সাইটের লেখা মিলিয়ে বসে'],
    ['visaPurposeDropdown', 'Visiting India for (purpose code)', 'কোড জানা থাকলে; খালি থাকলে উপরের লেখা দিয়ে মিলবে। 544=TOURIST, 545=MEDICAL, 537=BUSINESS'],
  ]},
  { t: 'A. Personal', f: [
    ['surname', 'Surname'], ['givenName', 'Given Name'],
    ['gender', 'Gender', 'MALE / FEMALE / X'], ['dob_id', 'Date of Birth', 'DD/MM/YYYY'],
    ['birth_place', 'Town/City of birth'], ['country_birth', 'Country of birth'],
    ['nic_number', 'National ID No'], ['identity_marks', 'Identification marks'],
    ['religion', 'Religion'], ['education', 'Education'],
    ['nationality_by', 'Nationality by', 'BY BIRTH / NATURALIZATION'], ['prev_nationality', 'Prev. Nationality'],
    ['#chk:changedName', 'নাম পরিবর্তন হয়েছে?'], ['prev_surname', 'Previous Surname'], ['prev_given_name', 'Previous Given Name'],
  ]},
  { t: 'B. Passport', f: [
    ['passport_no', 'Passport No'], ['passport_issue_place', 'Place of Issue'],
    ['passport_issue_date', 'Issue Date', 'DD/MM/YYYY'], ['passport_expiry_date', 'Expiry Date', 'DD/MM/YYYY'],
    ['#yn:otherPassport', 'Other passport held?'],
    ['other_ppt_country_issue', 'Other: Country of Issue'], ['other_ppt_no', 'Other: Passport/IC No'],
    ['other_ppt_issue_date', 'Other: Issue Date'], ['other_ppt_issue_place', 'Other: Place of Issue'],
    ['other_ppt_nat', 'Other: Nationality'],
  ]},
  { t: 'C. Contact', f: [
    ['pres_country', 'Present Country'], ['pres_add1', 'Present House/Street'],
    ['pres_add2', 'Present Village/Town/City'], ['pres_add3', 'Present State/District'],
    ['pincode', 'Postal/Zip Code'], ['pres_phone', 'Phone No'],
    ['isd_code1', 'Mobile ISD', 'e.g. 880'], ['mobile', 'Mobile No', 'ISD ছাড়া'],
    ['email_id', 'Email'], ['email_re_id', 'Re-enter Email'],
    ['#chk:sameAddress', 'Permanent = Present?'],
    ['perm_address1', 'Permanent House/Street'], ['perm_address2', 'Permanent Village/Town'], ['perm_address3', 'Permanent State'],
  ]},
  { t: 'D. Family', f: [
    ['fthrname', "Father's Name"], ['father_nationality', 'Father Nationality'],
    ['father_previous_nationality', 'Father Prev. Nationality'], ['father_place_of_birth', 'Father Birth Place'],
    ['father_country_of_birth', 'Father Birth Country'],
    ['mother_name', "Mother's Name"], ['mother_nationality', 'Mother Nationality'],
    ['mother_previous_nationality', 'Mother Prev. Nationality'], ['mother_place_of_birth', 'Mother Birth Place'],
    ['mother_country_of_birth', 'Mother Birth Country'],
    ['marital_status', 'Marital', 'MARRIED / SINGLE'],
    ['spouse_name', 'Spouse Name'], ['spouse_nationality', 'Spouse Nationality'],
    ['spouse_previous_nationality', 'Spouse Prev. Nationality'], ['spouse_place_of_birth', 'Spouse Birth Place'],
    ['spouse_country_of_birth', 'Spouse Birth Country'],
    ['#yn:grandparent', 'Grandparent Pakistan?'], ['grandparent_details', 'Grandparent details'],
  ]},
  { t: 'E. Visa', f: [
    ['visa_serreq_id_112', 'Places to Visit'], ['visa_serreq_id_334', 'Places (2)'],
    ['duration', 'Duration (months)'], ['visa_entry_id', 'No. of Entries', 'SINGLE/MULTIPLE...'],
    ['jouryney_id', 'Date of Journey', 'DD/MM/YYYY'],
    ['entrypoint', 'Port of Arrival'], ['exitpointprc', 'Port of Exit'],
  ]},
  { t: 'F. Prev Visit', f: [
    ['#yn:visitedIndia', 'Visited India before?'],
    ['prv_visit_add1', 'Prev Address 1'], ['prv_visit_add2', 'Prev Address 2'], ['prv_visit_add3', 'Prev Address 3'],
    ['visited_city', 'Cities Visited'], ['old_visa_no', 'Prev Visa No'],
    ['old_visa_type_id', 'Prev Visa Type'], ['oldvisaissueplace', 'Prev Visa Place'], ['oldvisaissuedate', 'Prev Visa Date'],
    ['country_visited', 'Countries (10 yrs)'],
    ['#yn:refused', 'Visa refused before?'], ['refuse_details', 'Refusal details'],
    ['#yn:saarc', 'SAARC visited (3yr)?'],
  ]},
  { t: 'G. Profession', f: [
    ['occupation', 'Occupation'], ['occupationOther', 'Occupation (other)'],
    ['occ_flag', 'Occupation of', 'F/M/S'], ['empname', 'Employer name'],
    ['empdesignation', 'Designation'], ['empaddress', 'Employer Address'], ['empphone', 'Employer Phone'],
    ['previous_occupation', 'Past Occupation'],
    ['#yn:military', 'Military/Police service?'],
    ['previous_organization', 'Mil Organization'], ['previous_designation', 'Mil Designation'],
    ['previous_rank', 'Mil Rank'], ['previous_posting', 'Mil Posting'],
  ]},
  { t: 'H. Stay/Hotel', f: [
    ['place_of_stay1', 'Place/Hotel Name'], ['pos_address1', 'Hotel Address'],
    ['pos_state_id1', 'State'], ['pos_dist_id1', 'District'], ['pos_phone1', 'Phone'],
  ]},
  { t: 'I. References', f: [
    ['nameofsponsor_ind', 'India — Name'], ['add1ofsponsor_ind', 'India Address 1'],
    ['add2ofsponsor_ind', 'India Address 2'], ['stateofsponsor_ind', 'India State'],
    ['districtofsponsor_ind', 'India District'], ['phoneofsponsor_ind', 'India Phone'],
    ['nameofsponsor_msn', 'BD — Name'], ['add1ofsponsor_msn', 'BD Address 1'],
    ['add2ofsponsor_msn', 'BD Address 2'], ['phoneofsponsor_msn', 'BD Phone'],
  ]},
];

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
let toastEl = null, toastTimer = null;
function toast(msg, ok = true) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;max-width:90%;padding:12px 18px;border-radius:10px;color:#fff;font-family:inherit;font-size:14px;font-weight:700;box-shadow:0 6px 24px rgba(0,0,0,.3);opacity:0;transition:opacity .2s,bottom .2s;pointer-events:none';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.style.background = ok ? 'linear-gradient(135deg,#0b6b4e,#12b886)' : '#dc2626';
  toastEl.style.opacity = '1'; toastEl.style.bottom = '28px';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; toastEl.style.bottom = '18px'; }, 2600);
}
function status(msg, ok = true) { if (statusEl) { statusEl.textContent = msg; statusEl.className = ok ? 'ok' : 'err'; } toast(msg, ok); }

let state = { profiles: {}, activeId: null };
let working = null;   // {name, values, flags} — এডিটরে যেটা দেখাচ্ছে
let workingId = null;
let curTab = 0;
let indRefs = [];   // [{name, addr, state, dist, phone}]

// ---------- India reference bulk list ----------
// bulk টেক্সট → reference তালিকা।
// প্রতিটি reference = কয়েকটি লাইনের একটি block; দুটি reference এর মাঝে একটি ফাঁকা লাইন।
// block-এর ভেতর: ১ম লাইন = নাম, শেষ সংখ্যা-লাইন = ফোন, মাঝেরগুলো = ঠিকানা।
function parseBulk(text) {
  const refs = [];
  // reference আলাদা করার লাইন: খালি লাইন, অথবা শুধু ড্যাশ/সমান/আন্ডারস্কোর/তারা দেওয়া লাইন
  // সেপারেটর লাইন: ASCII ড্যাশ/সমান/ইত্যাদি বা ইউনিকোড box-drawing (─ ━ ═ …) দিয়ে বানানো
  const norm = String(text || '').replace(/\r/g, '')
    .replace(/^[ \t]*[-–—_=*.·•~‐-―─-╿]{3,}[ \t]*$/gm, '');
  const blocks = norm.split(/\n[ \t]*\n+/);
  for (const block of blocks) {
    // পুরনো "|" ফরম্যাটও চলে — pipe সরিয়ে লাইনগুলোকেই ধরি
    const lines = block.split('\n')
      .map((l) => l.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (!lines.length) continue;
    const r = parseRefBlock(lines);
    if (r && r.name) refs.push(r);
  }
  return refs;
}
function renderIndRefPick() {
  const sel = $('indRefPick');
  sel.innerHTML = '<option value="">— বেছে নিন —</option>';
  indRefs.forEach((r, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = r.name + (r.dist ? ' · ' + r.dist : '');
    sel.appendChild(o);
  });
}
function applyIndRef(r) {
  // এডিটর খোলা থাকলে সেখানে, নাহলে সক্রিয় profile-এ India reference বসাই
  const target = (working && workingId) ? working
    : (state.activeId && state.profiles[state.activeId]) || null;
  if (!target) { status('আগে একটা profile Active/Edit করুন।', false); return; }
  const v = target.values;
  v.nameofsponsor_ind = r.name;
  if (r.state) v.stateofsponsor_ind = r.state;
  if (r.dist) v.districtofsponsor_ind = r.dist;
  if (r.phone) v.phoneofsponsor_ind = r.phone;
  // প্রথম ঘরে প্রথম ২টি শব্দ, বাকিটা পরের ঘরে (present/permanent-এর মতো)
  const w = String(r.addr || '').split(/\s+/).filter(Boolean);
  v.add1ofsponsor_ind = w.slice(0, 2).join(' ');
  v.add2ofsponsor_ind = w.slice(2).join(' ');
  if (working && workingId) {
    // এডিটরে দেখাচ্ছে — ঘরগুলো রিফ্রেশ
    if (TABS[curTab].t === 'I. References') renderFields();
    status('✔ India reference বসানো হয়েছে — Save করুন।');
  } else {
    state.profiles[state.activeId] = target;
    persist();
    status('✔ "' + (target.name || '') + '" profile-এ India reference বসানো হয়েছে।');
  }
}

// ---------------- storage ----------------
function load() {
  chrome.storage.local.get(['vaProfiles', 'vaActiveId', 'vaEnabled', 'vaAutoContinue', 'vaJourneyDate', 'vaIndRefs', 'vaHotels', 'vaHotelsRaw'], (r) => {
    state.profiles = r.vaProfiles || {};
    state.activeId = r.vaActiveId || null;
    $('enableToggle').checked = r.vaEnabled !== false;
    $('autoContinueToggle').checked = r.vaAutoContinue === true;
    $('journeyDate').value = r.vaJourneyDate || '';
    indRefs = Array.isArray(r.vaIndRefs) ? r.vaIndRefs : [];
    $('indRefBulk').value = r.vaIndRefsRaw || '';
    renderIndRefPick();
    hotels = Array.isArray(r.vaHotels) ? r.vaHotels : [];
    $('hotelBulk').value = r.vaHotelsRaw || '';
    renderHotelPick();
    renderProfiles();
  });
}
function persist() {
  chrome.storage.local.set({ vaProfiles: state.profiles, vaActiveId: state.activeId });
}

// ---------------- profile list ----------------
function renderProfiles() {
  const box = $('profiles');
  box.innerHTML = '';
  const ids = Object.keys(state.profiles);
  $('noProfiles').style.display = ids.length ? 'none' : 'block';
  for (const id of ids) {
    const p = state.profiles[id];
    const div = document.createElement('div');
    div.className = 'prof' + (id === state.activeId ? ' active' : '');
    div.innerHTML = `<div class="nm">${p.name || '(no name)'}</div>
      <div class="btns">
        <button data-a="use">✔ Active</button>
        <button data-a="edit">✏️ Edit</button>
        <button class="danger" data-a="del">🗑 Delete</button>
      </div>`;
    div.querySelector('.nm').onclick = () => { state.activeId = id; persist(); renderProfiles(); status('Active profile: ' + p.name); };
    div.querySelector('[data-a=use]').onclick = () => { state.activeId = id; persist(); renderProfiles(); status('Active: ' + p.name); };
    div.querySelector('[data-a=edit]').onclick = () => openEditor(id);
    div.querySelector('[data-a=del]').onclick = () => {
      if (!confirm(p.name + ' — মুছে ফেলবেন?')) return;
      delete state.profiles[id];
      if (state.activeId === id) state.activeId = Object.keys(state.profiles)[0] || null;
      persist(); renderProfiles(); if (workingId === id) closeEditor();
    };
    box.appendChild(div);
  }
}

// ---------------- editor ----------------
function openEditor(id) {
  workingId = id;
  const p = state.profiles[id];
  working = { name: p.name || '', values: { ...(p.values || {}) }, flags: { ...(p.flags || {}) } };
  $('editorCard').classList.remove('hidden');
  $('editName').textContent = working.name;
  curTab = 0;
  renderTabs();
  renderFields();
  $('editorCard').scrollIntoView({ behavior: 'smooth' });
}
function closeEditor() { $('editorCard').classList.add('hidden'); working = null; workingId = null; }

function renderTabs() {
  const box = $('tabs'); box.innerHTML = '';
  TABS.forEach((tab, i) => {
    const b = document.createElement('button');
    b.textContent = tab.t; if (i === curTab) b.className = 'on';
    b.onclick = () => { curTab = i; renderTabs(); renderFields(); };
    box.appendChild(b);
  });
}

function renderFields() {
  const box = $('fields'); box.innerHTML = '';
  for (const f of TABS[curTab].f) {
    const [key, label, hint] = f;
    const div = document.createElement('div');
    div.className = 'fld';
    if (key.startsWith('#yn:') || key.startsWith('#chk:')) div.className = 'fld full';

    if (key.startsWith('#yn:')) {
      const fk = key.slice(4);
      div.innerHTML = `<label>${label}</label>`;
      const sel = document.createElement('select');
      sel.innerHTML = `<option value="">—</option><option value="YES">YES</option><option value="NO">NO</option>`;
      sel.value = working.flags[fk] || '';
      sel.onchange = () => { working.flags[fk] = sel.value; };
      div.appendChild(sel);
    } else if (key.startsWith('#chk:')) {
      const fk = key.slice(5);
      div.innerHTML = `<label style="display:flex;gap:8px;align-items:center">
        <input type="checkbox" ${working.flags[fk] ? 'checked' : ''}> ${label}</label>`;
      div.querySelector('input').onchange = (e) => { working.flags[fk] = e.target.checked; };
    } else {
      div.innerHTML = `<label>${label} <span style="color:#64748b">#${key}</span></label>`;
      const inp = document.createElement('input');
      inp.value = working.values[key] || '';
      inp.oninput = () => { working.values[key] = inp.value; };
      div.appendChild(inp);
      if (hint) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = hint; div.appendChild(h); }
    }
    box.appendChild(div);
  }
}

$('saveBtn').onclick = () => {
  if (!working) return;
  state.profiles[workingId] = { name: working.name, values: working.values, flags: working.flags };
  if (!state.activeId) state.activeId = workingId;
  persist(); renderProfiles();
  status('✔ Save হয়েছে — এখন ফর্ম পেজে গিয়ে "এখন ভরো" চাপুন।');
};
$('closeEditor').onclick = closeEditor;

// সব ঠিকানা-সম্পর্কিত ঘর খালি করি (working profile-এ; Save করলে স্থায়ী হবে)
const ADDR_KEYS = [
  'pres_add1', 'pres_add2', 'pres_add3', 'pincode',
  'perm_address1', 'perm_address2', 'perm_address3',
  'add1ofsponsor_ind', 'add2ofsponsor_ind', 'stateofsponsor_ind', 'districtofsponsor_ind',
  'add1ofsponsor_msn', 'add2ofsponsor_msn',
  'place_of_stay1', 'pos_address1', 'pos_state_id1', 'pos_dist_id1',
  'prv_visit_add1', 'prv_visit_add2', 'prv_visit_add3',
];
$('clearAddrBtn').onclick = () => {
  if (!working) return;
  if (!confirm('এই profile-এর সব ঠিকানার ঘর খালি করবেন? (Save করলে স্থায়ী হবে)')) return;
  for (const k of ADDR_KEYS) delete working.values[k];
  renderFields();
  status('🧹 সব ঠিকানা মুছে দেওয়া হয়েছে — এখন Save করুন।');
};

// ---------------- new / import ----------------
function newId() { return 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }

$('newProfile').onclick = () => {
  const id = newId();
  state.profiles[id] = { name: 'New Profile', values: {}, flags: {} };
  persist(); renderProfiles(); openEditor(id);
};

function saveImported(res) {
  const id = newId();
  state.profiles[id] = { name: res.name, values: res.values, flags: res.flags };
  state.activeId = id;
  persist(); renderProfiles();
  status('✔ "' + res.name + '" পড়া হয়েছে — Edit করে যাচাই করে Save করুন।');
  openEditor(id);
}

// text-PDF: সব পেজের লেখা এক করে ফেরত দেয় (0 হলে বুঝব এটা image-PDF)।
// কলাম-ওলা অংশ (References ইত্যাদি) ধরার জন্য বড় x-ফাঁকে Tab বসাই, আর লাইন
// মাঝ-কলামে শুরু হলে সামনে Tab দিয়ে প্যাড করি (label≈41, India≈170, BD≈300)।
async function pdfText(doc) {
  let plain = '', tabbed = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    // plain: আগের মতো y ধরে জোড়া (family/address/occupation ইত্যাদির জন্য)
    let line = '', lastY = null;
    for (const it of tc.items) {
      const y = Math.round(it.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 3) { plain += line + '\n'; line = ''; }
      line += it.str; lastY = y;
    }
    plain += line + '\n';
    // tabbed: row-wise, প্রতি item Tab দিয়ে + x-band leading pad (শুধু References কলামের জন্য)
    const rows = new Map();
    for (const it of tc.items) { const y = Math.round(it.transform[5]); if (!rows.has(y)) rows.set(y, []); rows.get(y).push(it); }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      const items = rows.get(y).filter((it) => it.str.trim() !== '').sort((a, b) => a.transform[4] - b.transform[4]);
      if (!items.length) continue;
      const x0 = items[0].transform[4];
      let tl = x0 >= 285 ? '\t\t' : x0 >= 130 ? '\t' : '', first = true;
      for (const it of items) { if (!first) tl += '\t'; tl += it.str; first = false; }
      tabbed += tl + '\n';
    }
  }
  return plain + '\n<<<TABS>>>\n' + tabbed;
}

async function pdfPageToCanvas(page, scale = 2) {
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  return c;
}

async function importFile(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  try {
    if (isPdf) {
      const buf = new Uint8Array(await file.arrayBuffer());
      const doc = await pdfjsLib.getDocument({ data: buf }).promise;
      status('⏳ PDF পড়া হচ্ছে...');
      const text = await pdfText(doc);
      if (text.replace(/\s/g, '').length > 40) {
        // লেখা-সহ PDF (application form)
        saveImported(parseVisaPdf(text));
        return;
      }
      // image-only PDF → পেজ ছবি বানিয়ে OCR
      status('🔎 ছবি-PDF — OCR চলছে (কয়েক সেকেন্ড)...');
      let ocrText = '';
      for (let i = 1; i <= Math.min(doc.numPages, 2); i++) {
        const canvas = await pdfPageToCanvas(await doc.getPage(i), 2);
        ocrText += '\n' + await ocrImage(canvas, (p) => status('🔎 OCR ' + Math.round(p * 100) + '%'));
      }
      saveImported(parsePassport(ocrText));
      return;
    }
    // সরাসরি ছবি ফাইল
    status('🔎 ছবি OCR চলছে (কয়েক সেকেন্ড)...');
    const url = URL.createObjectURL(file);
    const text = await ocrImage(url, (p) => status('🔎 OCR ' + Math.round(p * 100) + '%'));
    URL.revokeObjectURL(url);
    saveImported(parsePassport(text));
  } catch (e) {
    console.error(e);
    status('✘ পড়া যায়নি: ' + e.message, false);
  }
}

const drop = $('drop'), fileInput = $('file');
drop.onclick = () => fileInput.click();
fileInput.onchange = () => { if (fileInput.files[0]) importFile(fileInput.files[0]); };
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f && (f.type === 'application/pdf' || f.type.startsWith('image/'))) importFile(f); });

// ---------------- journey date + india reference list ----------------
$('journeyDate').oninput = (e) => chrome.storage.local.set({ vaJourneyDate: e.target.value.trim() });

$('saveIndRefs').onclick = () => {
  const raw = $('indRefBulk').value || '';
  indRefs = parseBulk(raw);
  chrome.storage.local.set({ vaIndRefs: indRefs, vaIndRefsRaw: raw });
  renderIndRefPick();
  status('✔ ' + indRefs.length + ' টি India reference সেভ হয়েছে।');
};

$('indRefPick').onchange = (e) => {
  const i = e.target.value;
  if (i === '') return;
  const r = indRefs[Number(i)];
  if (r) applyIndRef(r);
};

// ---------------- hotel / place of stay bulk list ----------------
let hotels = [];
function renderHotelPick() {
  const sel = $('hotelPick');
  sel.innerHTML = '<option value="">— বেছে নিন —</option>';
  hotels.forEach((h, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = h.name + (h.dist ? ' · ' + h.dist : '');
    sel.appendChild(o);
  });
}
function applyHotel(h) {
  const target = (working && workingId) ? working
    : (state.activeId && state.profiles[state.activeId]) || null;
  if (!target) { status('আগে একটা profile Active/Edit করুন।', false); return; }
  const v = target.values;
  v.place_of_stay1 = h.name;
  v.pos_address1 = h.addr || '';
  if (h.state) v.pos_state_id1 = h.state;
  if (h.dist) v.pos_dist_id1 = h.dist;
  if (h.phone) v.pos_phone1 = h.phone;
  if (working && workingId) {
    if (TABS[curTab].t === 'H. Stay/Hotel') renderFields();
    status('✔ Hotel/Stay বসানো হয়েছে — Save করুন।');
  } else {
    state.profiles[state.activeId] = target;
    persist();
    status('✔ "' + (target.name || '') + '" profile-এ Hotel/Stay বসানো হয়েছে।');
  }
}
$('saveHotels').onclick = () => {
  const raw = $('hotelBulk').value || '';
  hotels = parseBulk(raw);
  chrome.storage.local.set({ vaHotels: hotels, vaHotelsRaw: raw });
  renderHotelPick();
  status('✔ ' + hotels.length + ' টি Hotel/Stay সেভ হয়েছে।');
};
$('hotelPick').onchange = (e) => {
  const i = e.target.value;
  if (i === '') return;
  const h = hotels[Number(i)];
  if (h) applyHotel(h);
};

// ---------------- pre-loaded photo & passport pdf ----------------
function fileToDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
function kb(n) { return Math.round((n || 0) / 1024) + ' KB'; }

function renderUploadInfo(r) {
  if (r.vaPhotoName) $('photoInfo').innerHTML = '<span style="color:var(--accent2)">✔ ' + r.vaPhotoName + ' (' + kb(r.vaPhotoSize) + ')</span> <a href="#" id="photoClear" style="color:#f87171">মুছুন</a>';
  else $('photoInfo').textContent = 'কোনো ছবি দেওয়া নেই।';
  if (r.vaPassportName) $('pdfInfo').innerHTML = '<span style="color:var(--accent2)">✔ ' + r.vaPassportName + ' (' + kb(r.vaPassportSize) + ')</span> <a href="#" id="pdfClear" style="color:#f87171">মুছুন</a>';
  else $('pdfInfo').textContent = 'কোনো PDF দেওয়া নেই।';
  const pc = $('photoClear'); if (pc) pc.onclick = (e) => { e.preventDefault(); chrome.storage.local.remove(['vaPhotoData', 'vaPhotoName', 'vaPhotoType', 'vaPhotoSize'], loadUploads); };
  const dc = $('pdfClear'); if (dc) dc.onclick = (e) => { e.preventDefault(); chrome.storage.local.remove(['vaPassportData', 'vaPassportName', 'vaPassportType', 'vaPassportSize'], loadUploads); };
}
function loadUploads() {
  chrome.storage.local.get(['vaPhotoName', 'vaPhotoSize', 'vaPassportName', 'vaPassportSize'], renderUploadInfo);
}
async function saveUpload(file, kind) {
  try {
    const data = await fileToDataURL(file);
    const keys = kind === 'photo'
      ? { vaPhotoData: data, vaPhotoName: file.name, vaPhotoType: file.type || 'image/jpeg', vaPhotoSize: file.size }
      : { vaPassportData: data, vaPassportName: file.name, vaPassportType: file.type || 'application/pdf', vaPassportSize: file.size };
    chrome.storage.local.set(keys, () => {
      if (chrome.runtime.lastError) { status('✘ সেভ হয়নি (ফাইল বড়?): ' + chrome.runtime.lastError.message, false); return; }
      loadUploads();
      status('✔ ' + (kind === 'photo' ? 'ছবি' : 'পাসপোর্ট PDF') + ' সেভ হয়েছে — পেজে গেলে নিজে বসবে।');
    });
  } catch (e) { status('✘ ফাইল পড়া যায়নি: ' + e.message, false); }
}
function wireUpload(dropId, inputId, kind, accept) {
  const drop = $(dropId), inp = $(inputId);
  drop.onclick = () => inp.click();
  inp.onchange = () => { if (inp.files[0]) saveUpload(inp.files[0], kind); };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.style.borderColor = 'var(--line)'; }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f && accept(f)) saveUpload(f, kind); });
}
wireUpload('photoDrop', 'photoFile', 'photo', (f) => f.type.startsWith('image/'));
wireUpload('pdfDrop', 'pdfFile', 'pdf', (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
loadUploads();

// ---- extra named documents (vaDocs: [{id,label,filename,type,size,data}]) ----
let vaDocs = [];
function persistDocs() { chrome.storage.local.set({ vaDocs }, () => { if (chrome.runtime.lastError) status('✘ সেভ হয়নি (ফাইল বড়?)', false); }); }
function renderDocs() {
  const box = $('docList'); box.innerHTML = '';
  if (!vaDocs.length) { box.innerHTML = '<div class="sub">এখনো কোনো ডকুমেন্ট যোগ করা হয়নি।</div>'; return; }
  vaDocs.forEach((d, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px';
    const inp = document.createElement('input');
    inp.value = d.label || ''; inp.placeholder = 'নাম (সাইটের বিবরণ)';
    inp.style.cssText = 'flex:1;background:#0b1526;border:1px solid var(--line);border-radius:6px;color:#e2e8f0;padding:6px;font-size:11px';
    inp.oninput = () => { d.label = inp.value; persistDocs(); };
    const meta = document.createElement('span');
    meta.className = 'sub'; meta.style.cssText = 'font-size:10px;white-space:nowrap'; meta.textContent = kb(d.size);
    const del = document.createElement('button');
    del.textContent = '🗑'; del.className = 'danger'; del.style.cssText = 'padding:4px 7px';
    del.onclick = () => { vaDocs.splice(i, 1); persistDocs(); renderDocs(); };
    row.appendChild(inp); row.appendChild(meta); row.appendChild(del);
    box.appendChild(row);
    const fn = document.createElement('div'); fn.className = 'sub'; fn.style.cssText = 'font-size:10px;margin:-3px 0 4px';
    fn.textContent = '📎 ' + (d.filename || ''); box.appendChild(fn);
  });
}
$('addDoc').onclick = () => $('docFile').click();
$('docFile').onchange = async () => {
  const f = $('docFile').files[0]; if (!f) return;
  if (!(f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) { status('✘ শুধু PDF দিন (ছবি ছাড়া বাকি সব PDF).', false); $('docFile').value = ''; return; }
  try {
    const data = await fileToDataURL(f);
    vaDocs.push({ id: 'd_' + Date.now(), label: f.name.replace(/\.[^.]+$/, ''), filename: f.name, type: 'application/pdf', size: f.size, data });
    persistDocs(); renderDocs();
    status('✔ ডকুমেন্ট যোগ হয়েছে — নাম ঠিক করে দিন যেন সাইটের বিবরণের সাথে মেলে।');
  } catch (e) { status('✘ ফাইল পড়া যায়নি: ' + e.message, false); }
  $('docFile').value = '';
};
chrome.storage.local.get(['vaDocs'], (r) => { vaDocs = Array.isArray(r.vaDocs) ? r.vaDocs : []; renderDocs(); });

// ---------------- toggles & actions ----------------
$('enableToggle').onchange = (e) => chrome.storage.local.set({ vaEnabled: e.target.checked });
$('autoContinueToggle').onchange = (e) => chrome.storage.local.set({ vaAutoContinue: e.target.checked });
$('openSite').onclick = () => chrome.tabs.create({ url: SITE });

$('fillNow').onclick = async () => {
  if (!state.activeId) { status('আগে একটা profile Active করুন।', false); return; }
  // যেকোনো উইন্ডোয় খোলা ভিসা-পেজ খুঁজি (popup বা RJ full-page — দুই জায়গা থেকেই কাজ করবে)
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: 'https://indianvisa-bangladesh.nic.in/*' }); } catch (_) {}
  if (tabs.length) {
    try { await chrome.tabs.update(tabs[0].id, { active: true }); } catch (_) {}
    chrome.tabs.reload(tabs[0].id);
    status('➡ ভিসা পেজ রিলোড হচ্ছে — তথ্য বসছে...');
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /indianvisa-bangladesh\.nic\.in\/visa/.test(tab.url || '')) {
    chrome.tabs.reload(tab.id);
    status('➡ পেজ রিলোড হচ্ছে — তথ্য বসছে...');
  } else {
    status('ভিসা ফর্মের পেজ খোলা নেই। "Visa Website খুলুন" চাপুন।', false);
  }
};

// ---------------- RJ Automation (full page in new tab) ----------------
const openRJBtn = $('openRJ');
if (openRJBtn) openRJBtn.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('docgen.html') });

load();
