/* ===================================================================
   Visa Autofill (PDF) — ocr.js
   ছবি/scan থেকে (অফলাইন Tesseract OCR) passport তথ্য পড়ে ফর্ম-স্কিমায় ম্যাপ করে।
   MRZ (নিচের দুই লাইন) পাওয়া গেলে মূল ঘরগুলো সেখান থেকে (বেশি নির্ভুল) নেয়।
   window.Tesseract (lib/tesseract.min.js) আগে লোড থাকতে হবে।
   =================================================================== */

const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const L = (f) => chrome.runtime.getURL('lib/' + f);
const clean = (s) => (s || '').replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim();

function dmy(s) {
  if (!s) return '';
  const m = String(s).match(/(\d{1,2})\s*[-/ ]?\s*([A-Z]{3})\s*[-/ ]?\s*(\d{4})/i);
  if (m) return m[1].padStart(2, '0') + '/' + (MONTHS[m[2].toUpperCase()] || '01') + '/' + m[3];
  return '';
}
// MRZ সংখ্যা-ঘরে OCR-এর অক্ষর→সংখ্যা ভুল ঠিক করি
function fixDigits(s) {
  return String(s || '').toUpperCase()
    .replace(/O/g, '0').replace(/Q/g, '0').replace(/D/g, '0')
    .replace(/I/g, '1').replace(/L/g, '1')
    .replace(/Z/g, '2').replace(/S/g, '5').replace(/B/g, '8').replace(/G/g, '6');
}
function yymmdd(s, expiry) {
  const m = fixDigits(s).match(/(\d{2})(\d{2})(\d{2})/);
  if (!m) return '';
  let yy = parseInt(m[1], 10);
  const year = expiry ? 2000 + yy : (yy > 30 ? 1900 + yy : 2000 + yy);
  return m[3] + '/' + m[2] + '/' + year;
}
// ৩-অক্ষর দেশ কোড → পূর্ণ নাম (country_birth টেক্সট ঘরের জন্য)
const CCODE = { BGD: 'BANGLADESH', IND: 'INDIA', PAK: 'PAKISTAN', NPL: 'NEPAL', LKA: 'SRI LANKA', BTN: 'BHUTAN', MMR: 'MYANMAR' };

// imageLike (URL / Blob / <img> / <canvas>) → HTMLCanvasElement
async function toCanvas(imageLike) {
  if (imageLike && typeof imageLike.getContext === 'function') return imageLike; // already canvas
  let img;
  if (typeof imageLike === 'string') {
    img = await loadImg(imageLike);
  } else if (imageLike instanceof Blob) {
    const url = URL.createObjectURL(imageLike);
    try { img = await loadImg(url); } finally { URL.revokeObjectURL(url); }
  } else if (imageLike && imageLike.tagName === 'IMG') {
    img = imageLike;
  } else {
    return imageLike; // fallback — Tesseract নিজে সামলাবে
  }
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}
function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

// scale + grayscale (মৃদু কনট্রাস্ট) — OCR ভালো হয় বড় ও পরিষ্কার ছবিতে
function scaleGray(src, minW, binarize) {
  const sw = src.width, sh = src.height;
  const scale = Math.max(1, minW / sw);
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const im = ctx.getImageData(0, 0, c.width, c.height);
  const d = im.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
    d[i] = d[i + 1] = d[i + 2] = g; sum += g;
  }
  if (binarize) {
    const mean = sum / (d.length / 4);
    const thr = mean * 0.85; // একটু কম — MRZ অক্ষর মোটা থাকে
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] < thr ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  ctx.putImageData(im, 0, 0);
  return c;
}

// নিচের ~২৫% কেটে MRZ (দুই লাইন) আলাদা — সেখানে binarize + বড় করে OCR
function cropMrz(src) {
  const sh = src.height;
  const y = Math.round(sh * 0.70);
  const c = document.createElement('canvas');
  c.width = src.width; c.height = sh - y;
  c.getContext('2d').drawImage(src, 0, y, src.width, sh - y, 0, 0, src.width, sh - y);
  return scaleGray(c, 2200, true);
}

// ছবি → ~1MB এর নিচে JPEG blob (OCR.space ফ্রি লিমিট)
async function toJpegUnder1MB(imageLike) {
  const src = await toCanvas(imageLike);
  if (!src || typeof src.getContext !== 'function') return imageLike;
  for (const w of [1600, 1300, 1000, 800]) {
    const c = scaleGray(src, Math.min(w, src.width * (w / 1600)), false);
    for (const q of [0.82, 0.65, 0.5]) {
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= 1024 * 1024) return blob;
    }
  }
  return await new Promise((r) => src.toBlob(r, 'image/jpeg', 0.4));
}

// ---------- OCR.space (ফ্রি ক্লাউড OCR — অনেক নির্ভুল) ----------
export async function ocrSpace(imageLike, key, onProgress) {
  if (!key) throw new Error('OCR.space key নেই');
  if (onProgress) onProgress(0.15);
  const blob = await toJpegUnder1MB(imageLike);
  const fd = new FormData();
  fd.append('apikey', key);
  fd.append('language', 'eng');
  fd.append('OCREngine', '2');
  fd.append('scale', 'true');
  fd.append('detectOrientation', 'true');
  fd.append('isOverlayRequired', 'false');
  fd.append('file', blob, 'passport.jpg');
  if (onProgress) onProgress(0.4);
  const res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: fd });
  const j = await res.json();
  if (onProgress) onProgress(1);
  if (j.IsErroredOnProcessing) throw new Error((j.ErrorMessage && j.ErrorMessage[0]) || 'OCR.space error');
  return (j.ParsedResults && j.ParsedResults[0] && j.ParsedResults[0].ParsedText) || '';
}

// ---------- Tesseract দিয়ে ছবি OCR (full page + আলাদা MRZ পাস) ----------
export async function ocrImage(imageLike, onProgress) {
  if (typeof Tesseract === 'undefined') throw new Error('Tesseract লোড হয়নি');
  let full = imageLike, mrz = null;
  try {
    const canvas = await toCanvas(imageLike);
    if (canvas && typeof canvas.getContext === 'function') {
      full = scaleGray(canvas, 1500, false);
      mrz = cropMrz(canvas);
    }
  } catch (e) { /* preprocessing ব্যর্থ হলে raw ছবিতেই OCR */ }

  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: L('tesseract-worker.min.js'),
    corePath: L('tesseract-core-simd-lstm.wasm.js'),
    langPath: chrome.runtime.getURL('lib/'),
    gzip: false,
    workerBlobURL: false,
    logger: (m) => { if (onProgress && m.status === 'recognizing text') onProgress(m.progress * (mrz ? 0.7 : 1)); },
  });
  try {
    await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '3' });
    let text = (await worker.recognize(full)).data.text;
    // MRZ আলাদা পাস — শুধু MRZ অক্ষর, একরৈখিক ব্লক (নির্ভুলতা অনেক বাড়ে)
    if (mrz) {
      try {
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
        });
        if (onProgress) onProgress(0.85);
        const mt = (await worker.recognize(mrz)).data.text;
        text += '\n' + mt;
      } catch (e) { /* MRZ পাস ব্যর্থ — full pass-ই থাক */ }
    }
    if (onProgress) onProgress(1);
    return text;
  } finally {
    await worker.terminate();
  }
}

// ---------- MRZ (TD3) — check-digit ভ্যালিডেশন সহ নির্ভুল parser ----------
// MRZ check digit: weight 7,3,1; A-Z=10..35, digit=itself, '<'=0
function mrzCheck(s) {
  let sum = 0; const w = [7, 3, 1];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]; let v;
    if (c >= '0' && c <= '9') v = c.charCodeAt(0) - 48;
    else if (c >= 'A' && c <= 'Z') v = c.charCodeAt(0) - 55;
    else v = 0; // '<' বা অন্য
    sum += v * w[i % 3];
  }
  return sum % 10;
}
// সংখ্যা-ঘরে OCR অক্ষর→সংখ্যা করে check মিলিয়ে দেখি; মিললে বেশি আস্থা
function fixNumField(field, checkChar) {
  const fixed = fixDigits(field);
  const ok = String(mrzCheck(fixed)) === fixDigits(checkChar);
  return { val: fixed, ok };
}

function parseMrz(text) {
  const norm = (l) => l.replace(/[«≪‹‹]/g, '<').replace(/[^A-Z0-9<]/gi, '').toUpperCase();
  // MRZ লাইন: লম্বা + হয় অনেক '<' (নাম লাইন) নয় বড় সংখ্যা-রান (ডেটা লাইন)
  const raw = text.split('\n').map(norm).filter((l) => l.length >= 28 && ((l.match(/</g) || []).length >= 2 || /\d{6}/.test(l)));
  if (raw.length < 2) return null;
  const digitCount = (l) => (l.match(/\d/g) || []).length;
  // নাম লাইন (P/সংখ্যা কম, '<<' আছে) ও ডেটা লাইন (সংখ্যাবহুল)
  let l1 = raw.find((l) => /^P[A-Z<]/.test(l) && l.includes('<<')) ||
           raw.find((l) => l.includes('<<') && digitCount(l) <= 4) ||
           raw.slice().sort((a, b) => digitCount(a) - digitCount(b))[0];
  let l2 = raw.filter((l) => l !== l1).sort((a, b) => digitCount(b) - digitCount(a))[0];
  if (!l1 || !l2) return null;
  const pad = (l) => (l + '<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<').slice(0, 44);
  l1 = pad(l1); l2 = pad(l2);
  const out = { _conf: {} };

  // ---- Line 1: doc(1) type(1) issuing(3) + names ----
  const iss = l1.slice(2, 5).replace(/</g, '');
  if (/^[A-Z]{3}$/.test(iss)) out.nationality = iss;
  const nm = l1.slice(5);
  const parts = nm.split(/<<+/);
  const nameOk = (s) => /^[A-Z][A-Z ]{1,38}$/.test(s);
  if (parts[0]) { const s = parts[0].replace(/</g, ' ').replace(/\s+/g, ' ').trim(); if (nameOk(s)) out.surname = s; }
  if (parts[1]) { const s = parts[1].replace(/</g, ' ').replace(/\s+/g, ' ').trim(); if (nameOk(s)) out.given = s; }

  // ---- Line 2: fixed positions (TD3) ----
  const passport = l2.slice(0, 9), passChk = l2[9];
  const nat = l2.slice(10, 13).replace(/</g, '');
  const dob = l2.slice(13, 19), dobChk = l2[19];
  const sex = l2[20];
  const exp = l2.slice(21, 27), expChk = l2[27];
  const personal = l2.slice(28, 42), persChk = l2[42];

  const p = { val: passport.replace(/</g, ''), ok: String(mrzCheck(passport)) === passChk };
  out.passport = p.val; out._conf.passport = p.ok;
  if (/^[A-Z]{3}$/.test(nat)) out.nationality = out.nationality || nat;
  const d = fixNumField(dob, dobChk); out.dob = yymmdd(d.val, false); out._conf.dob = d.ok;
  out.sex = /[MF]/.test(sex) ? sex : '';
  const e = fixNumField(exp, expChk); out.expiry = yymmdd(e.val, true); out._conf.expiry = e.ok;
  const pn = fixNumField(personal, persChk); const pnv = pn.val.replace(/</g, '').replace(/^0+(?=\d)/, '');
  if (/\d{6,}/.test(pnv)) { out.personal = pnv; out._conf.personal = pn.ok; }
  return (out.surname || out.passport) ? out : null;
}

// ---------- OCR টেক্সট → ফর্ম-স্কিমা ----------
export function parsePassport(text) {
  const T = text.replace(/\r/g, '');
  const values = {};
  const flags = {};
  const g = (re, i = 1) => { const m = T.match(re); return m ? clean(m[i]) : ''; };
  const put = (id, v) => { if (v) values[id] = v; };
  // শুধু বৈধ বড়-হাতের নাম (OCR আবর্জনা বাদ)
  const nm = (re) => { const s = g(re); return /^[A-Z][A-Z]+(?:\s+[A-Z.]+){0,4}$/.test(s) && s.length <= 40 ? s : ''; };

  // ---- Data page (উপরের পাতা) ----
  put('fthrname', nm(/Father'?s?[ \t]+Na\w*[:.\s]+([A-Z][A-Z]+(?:[ \t]+[A-Z.]+){0,4})/i));
  put('mother_name', nm(/Mother'?s?[ \t]+Na\w*[:.\s]+([A-Z][A-Z]+(?:[ \t]+[A-Z.]+){0,4})/i));
  put('spouse_name', nm(/Spouse'?s?[ \t]+Na\w*[:.\s]+([A-Z][A-Z]+(?:[ \t]+[A-Z.]+){0,4})/i));
  const tel = g(/Telephone No[:.\s]+\+?([\d][\d\s]{8,})/i);
  if (tel) {
    let d = tel.replace(/\D/g, '');
    d = d.replace(/^880/, '');           // ISD আলাদা
    if (d.length >= 10) { values['mobile'] = d; values['isd_code1'] = '880'; values['phoneofsponsor_msn'] = tel.replace(/\D/g, ''); }
  }
  // Permanent Address: ... (Emergency Contact-এর আগ পর্যন্ত)
  const permM = T.match(/Permanent Address[:.\s]+([\s\S]*?)(?:Emergency Contact|Name\s*:|\n\n|$)/i);
  if (permM) {
    const parts = clean(permM[1]).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) {
      const w = clean(permM[1]).split(/\s+/).filter(Boolean);
      values['perm_address1'] = w.slice(0, 2).join(' ');
      const rest = w.slice(2).join(' ');
      if (rest) values['perm_address2'] = rest.length > 35 ? rest.slice(0, 35) : rest;
      const st = parts[parts.length - 1] || '';
      if (/^[A-Z ]+$/.test(st.toUpperCase())) values['perm_address3'] = st.replace(/\s*-?\s*\d.*$/, '').trim();
    }
  }

  // ---- Passport page ----
  put('surname', nm(/Surname[ \t]+([A-Z][A-Z]+(?:[ \t]+[A-Z.]+){0,3})/));
  put('givenName', nm(/Given Name[ \t]+([A-Z][A-Z]+(?:[ \t]+[A-Z.]+){0,3})/));
  put('nic_number', g(/Personal No[.:]?\s*([0-9]{6,})/i));
  put('passport_no', g(/Passport Number[ \t]+([A-Z]{1,2}[0-9]{6,8})/i) || (T.match(/\b[A-Z]{1,2}\d{7}\b/) || [])[0] || '');
  put('birth_place', nm(/Place of Birth[ \t]+([A-Z][A-Z]+(?:[ \t]+[A-Z.]+){0,2})/i));
  put('dob_id', dmy(g(/Date of Birth\s*([0-9]{1,2}\s+[A-Z]{3}\s+[0-9]{4})/i)));
  put('passport_issue_date', dmy(g(/Date of Issue\s*([0-9]{1,2}\s+[A-Z]{3}\s+[0-9]{4})/i)));
  put('passport_expiry_date', dmy(g(/Date of Expiry\s*([0-9]{1,2}\s+[A-Z]{3}\s+[0-9]{4})/i)));
  const issAuth = g(/Issuing Auth\w*\s*([A-Z/]+)/i);
  if (/DHAKA/i.test(issAuth) || /DHAKA/i.test(T)) values['passport_issue_place'] = 'DHAKA';
  const prevPp = g(/Previous Passport No[.:]?\s*([A-Z]{1,2}[0-9]{6,8})/i);
  if (prevPp) { values['other_ppt_no'] = prevPp; flags.otherPassport = 'YES'; values['other_ppt_country_issue'] = 'BANGLADESH'; values['other_ppt_nat'] = 'BANGLADESH'; }
  if (/BANGLADESH/i.test(T)) { values['country_birth'] = 'BANGLADESH'; values['nationality_id'] = 'BANGLADESH'; }

  // ---- MRZ (বেশি নির্ভুল — override) ----
  const mrz = parseMrz(T);
  if (mrz) {
    if (mrz.surname) values['surname'] = mrz.surname;
    if (mrz.given) values['givenName'] = mrz.given;
    if (mrz.passport) values['passport_no'] = mrz.passport;
    if (mrz.dob) values['dob_id'] = mrz.dob;
    if (mrz.expiry) values['passport_expiry_date'] = mrz.expiry;
    if (mrz.sex) values['gender'] = mrz.sex;
    if (mrz.personal && !values['nic_number']) values['nic_number'] = mrz.personal; // labeled Personal No বেশি নির্ভরযোগ্য
    if (mrz.nationality) {
      values['nationality_id'] = mrz.nationality;
      values['country_birth'] = CCODE[mrz.nationality] || values['country_birth'] || mrz.nationality;
    }
  }

  // Sex/Gender → সাইটের MALE/FEMALE
  const sx = (values['gender'] || g(/\bSex\b\s*([MFX])/i) || '').toUpperCase();
  if (sx === 'M') values['gender'] = 'MALE'; else if (sx === 'F') values['gender'] = 'FEMALE'; else if (sx === 'X') values['gender'] = 'X';

  // Registration (Mission) ডিফল্ট (passport-এ থাকে না)
  values['countryname_id'] = values['countryname_id'] || 'BGD';
  values['nationality_id'] = values['nationality_id'] || 'BGD';
  values['missioncode_id'] = values['missioncode_id'] || 'BGDD';

  const name = clean((values['givenName'] || '') + ' ' + (values['surname'] || '')) || 'Passport Profile';
  return { values, flags, name, _mrz: !!mrz };
}
