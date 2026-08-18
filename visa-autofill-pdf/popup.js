import * as pdfjsLib from './lib/pdf.min.mjs';
import { parseVisaPdf } from './pdf-extract.js';
import { ocrImage, parsePassport } from './ocr.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const SITE = 'https://indianvisa-bangladesh.nic.in/visa/';

// ---------- ফর্ম স্কিমা: tab → field সমূহ (k=value id, flag=YES/NO, chk=checkbox) ----------
const TABS = [
  { t: 'Mission', f: [
    ['countryname_id', 'Country you apply from', 'BGD = Bangladesh'],
    ['missioncode_id', 'Indian Mission/Office', 'BGDD Dhaka, BGDC Chittagong...'],
    ['nationality_id', 'Nationality', 'BGD = Bangladesh'],
    ['visaPurposeDropdown', 'Visiting India for (purpose code)', '544=TOURIST T1, 545=MEDICAL M1, 546=MEDICAL M2, 537=BUSINESS B1, 233=TRANSIT'],
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
function status(msg, ok = true) { statusEl.textContent = msg; statusEl.className = ok ? 'ok' : 'err'; }

let state = { profiles: {}, activeId: null };
let working = null;   // {name, values, flags} — এডিটরে যেটা দেখাচ্ছে
let workingId = null;
let curTab = 0;

// ---------------- storage ----------------
function load() {
  chrome.storage.local.get(['vaProfiles', 'vaActiveId', 'vaEnabled', 'vaAutoContinue'], (r) => {
    state.profiles = r.vaProfiles || {};
    state.activeId = r.vaActiveId || null;
    $('enableToggle').checked = r.vaEnabled !== false;
    $('autoContinueToggle').checked = r.vaAutoContinue === true;
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

// text-PDF: সব পেজের লেখা এক করে ফেরত দেয় (0 হলে বুঝব এটা image-PDF)
async function pdfText(doc) {
  let full = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = '', lastY = null;
    for (const it of tc.items) {
      const y = Math.round(it.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 3) { full += line + '\n'; line = ''; }
      line += it.str; lastY = y;
    }
    full += line + '\n';
  }
  return full;
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

// ---------------- toggles & actions ----------------
$('enableToggle').onchange = (e) => chrome.storage.local.set({ vaEnabled: e.target.checked });
$('autoContinueToggle').onchange = (e) => chrome.storage.local.set({ vaAutoContinue: e.target.checked });
$('openSite').onclick = () => chrome.tabs.create({ url: SITE });

$('fillNow').onclick = async () => {
  if (!state.activeId) { status('আগে একটা profile Active করুন।', false); return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /indianvisa-bangladesh\.nic\.in\/visa/.test(tab.url || '')) {
    chrome.tabs.reload(tab.id);
    status('➡ পেজ রিলোড হচ্ছে — তথ্য বসছে...');
  } else {
    status('এটা ভিসা ফর্মের পেজ নয়। "Visa Website খুলুন" চাপুন।', false);
  }
};

load();
