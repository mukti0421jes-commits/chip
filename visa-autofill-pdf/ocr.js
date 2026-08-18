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
function yymmdd(s, expiry) {
  const m = String(s).match(/(\d{2})(\d{2})(\d{2})/);
  if (!m) return '';
  let yy = parseInt(m[1], 10);
  const year = expiry ? 2000 + yy : (yy > 30 ? 1900 + yy : 2000 + yy);
  return m[3] + '/' + m[2] + '/' + year;
}

// ---------- Tesseract দিয়ে ছবি OCR ----------
export async function ocrImage(imageLike, onProgress) {
  if (typeof Tesseract === 'undefined') throw new Error('Tesseract লোড হয়নি');
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: L('tesseract-worker.min.js'),
    corePath: L('tesseract-core-simd-lstm.wasm.js'),
    langPath: chrome.runtime.getURL('lib/'),
    gzip: false,
    workerBlobURL: false,
    logger: (m) => { if (onProgress && m.status === 'recognizing text') onProgress(m.progress); },
  });
  try {
    const { data: { text } } = await worker.recognize(imageLike);
    return text;
  } finally {
    await worker.terminate();
  }
}

// ---------- MRZ (TD3, দুই লাইন) parse ----------
function parseMrz(text) {
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, '').toUpperCase()).filter(Boolean);
  // MRZ লাইন = অনেক '<' + শুধু A-Z0-9<, দৈর্ঘ্য ~30+
  const cand = lines.filter((l) => /^[A-Z0-9<]{25,}$/.test(l) && (l.match(/</g) || []).length >= 2);
  if (cand.length < 2) return null;
  // line1 = নাম লাইন (P< দিয়ে শুরু বা << আছে), line2 = ডেটা লাইন (সংখ্যাবহুল)
  let l1 = cand.find((l) => /^P?[A-Z<]?[A-Z]{3}[A-Z<]/.test(l) && l.includes('<<')) || cand[0];
  let l2 = cand.find((l) => l !== l1 && /\d{6,}/.test(l)) || cand[1];
  const out = {};
  // নাম: l1 থেকে issuing country পরের অংশ; SURNAME<<GIVEN<GIVEN
  const nm = l1.replace(/^P</, '').replace(/^[A-Z]{3}/, '');
  const parts = nm.split('<<');
  if (parts[0]) out.surname = parts[0].replace(/</g, ' ').trim();
  if (parts[1]) out.given = parts[1].replace(/</g, ' ').trim();
  const cc = l1.match(/^P?<?([A-Z]{3})/);
  if (cc) out.nationality = cc[1];
  // l2: passportNo(9) check(1) nat(3) dob(6) check sex expiry(6) ...
  const m = l2.match(/^([A-Z0-9<]{9})\d?([A-Z]{3})(\d{6})\d?([MFX<])(\d{6})/);
  if (m) {
    out.passport = m[1].replace(/</g, '');
    if (!out.nationality) out.nationality = m[2];
    out.dob = yymmdd(m[3], false);
    out.sex = m[4] === '<' ? '' : m[4];
    out.expiry = yymmdd(m[5], true);
    const pn = l2.slice(28).match(/(\d{6,})/);
    if (pn) out.personal = pn[1];
  }
  return out;
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
  put('fthrname', nm(/Father'?s?\s+Na\w*[:.\s]+([A-Z][A-Z]+(?:\s+[A-Z.]+){0,4})/i));
  put('mother_name', nm(/Mother'?s?\s+Na\w*[:.\s]+([A-Z][A-Z]+(?:\s+[A-Z.]+){0,4})/i));
  put('spouse_name', nm(/Spouse'?s?\s+Na\w*[:.\s]+([A-Z][A-Z]+(?:\s+[A-Z.]+){0,4})/i));
  const tel = g(/Telephone No[:.\s]+\+?([\d][\d\s]{8,})/i);
  if (tel) { const d = tel.replace(/\s/g, ''); if (d.length >= 10) values['phoneofsponsor_msn'] = d; }
  const emg = nm(/Emergency Contact[\s\S]{0,40}?Name[:.\s]+([A-Z][A-Z]+(?:\s+[A-Z.]+){0,4})/i);

  // ---- Passport page ----
  put('surname', nm(/Surname\s+([A-Z][A-Z]+(?:\s+[A-Z.]+){0,3})/));
  put('givenName', nm(/Given Name\s+([A-Z][A-Z]+(?:\s+[A-Z.]+){0,3})/));
  put('nic_number', g(/Personal No[.:]?\s*([0-9]{6,})/i));
  // Bangladesh passport: B + ৮ সংখ্যা; মূলটা অগ্রাধিকার, প্রিভিয়াস আলাদা
  const bd = T.match(/\bB\d{8}\b/);
  put('passport_no', bd ? bd[0] : g(/\b([A-Z]{1,2}[0-9]{7,8})\b/));
  put('birth_place', nm(/Place of Birth\s+([A-Z][A-Z]+(?:\s+[A-Z.]+){0,2})/i));
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
    if (mrz.personal) values['nic_number'] = mrz.personal;
    if (mrz.nationality) { values['nationality_id'] = mrz.nationality; values['country_birth'] = mrz.nationality; }
  }

  // Registration (Mission) ডিফল্ট (passport-এ থাকে না)
  values['countryname_id'] = values['countryname_id'] || 'BGD';
  values['nationality_id'] = values['nationality_id'] || 'BGD';
  values['missioncode_id'] = values['missioncode_id'] || 'BGDD';

  const name = clean((values['givenName'] || '') + ' ' + (values['surname'] || '')) || 'Passport Profile';
  return { values, flags, name, _mrz: !!mrz };
}
