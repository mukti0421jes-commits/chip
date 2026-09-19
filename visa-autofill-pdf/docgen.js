/* ===================================================================
   Visa Autofill (PDF) — docgen.js
   Medical/Ayush Invitation Letter (PDF) থেকে তথ্য পড়ে প্রতিজন আবেদনকারীর
   জন্য Undertaking / Parental Consent letter (PDF) অফলাইনে বানায়।
   jsPDF (lib/jspdf.umd.min.js — window.jspdf) আগে লোড থাকতে হবে।
   =================================================================== */

const clean = (s) => (s || '').replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim();

// মিশন → চিঠির ঠিকানা-লাইন
export const MISSIONS = {
  BGDD: { city: 'Dhaka', line1: 'High Commission of India' },
  BGDC: { city: 'Chittagong', line1: 'Assistant High Commission of India' },
  BGDR: { city: 'Rajshahi', line1: 'Assistant High Commission of India' },
  BGDS: { city: 'Sylhet', line1: 'Assistant High Commission of India' },
  BGDK: { city: 'Khulna', line1: 'Assistant High Commission of India' },
};

function grab(T, re, i = 1) { const m = T.match(re); return m ? clean(m[i]) : ''; }

function ageFrom(dobStr) {
  const m = String(dobStr).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const dob = new Date(+m[3], +m[2] - 1, +m[1]);
  const now = new Date();
  let a = now.getFullYear() - dob.getFullYear();
  const md = now.getMonth() - dob.getMonth();
  if (md < 0 || (md === 0 && now.getDate() < dob.getDate())) a--;
  return a;
}
export function isMinor(person) { const a = ageFrom(person.dob); return a !== null && a < 12; }

// ---------- Invitation Letter parse ----------
export function parseInvitation(rawText) {
  const T = rawText.replace(/\r/g, '');
  const data = {
    fileRef: grab(T, /File Reference No\.?\s*:?\s*([A-Z0-9]+)/i),
    hospital: {
      name: grab(T, /Hospital Details[\s\S]*?Name\s+([^\n]+?)\s*\n\s*Address/i),
      address: grab(T, /Hospital Details[\s\S]*?Address\s+([^\n]+?)\s*\n\s*City\/District/i),
      city: grab(T, /Hospital Details[\s\S]*?City\/District\s+([A-Za-z .'-]+?)\s+State/i),
      state: grab(T, /Hospital Details[\s\S]*?City\/District[\s\S]*?State\s+([A-Za-z .'-]+?)\s*\n/i),
    },
    diagnosis: grab(T, /Diagnosis\/?\s*Proposed Treatment\s+([^\n]+)/i) || 'MEDICAL TREATMENT',
    patient: {},
    attendants: [],
  };

  // Patient block
  const pB = T.slice(T.search(/Details of the Patient/i));
  data.patient = {
    surname: grab(pB, /Surname\s+([A-Z][A-Za-z' -]*?)\s+Given name/i),
    given: grab(pB, /Given name\s+([A-Z][A-Za-z' -]*?)\s*\n/i),
    gender: grab(pB, /Gender\s+(MALE|FEMALE)/i).toUpperCase(),
    dob: grab(pB, /Date of Birth\s+(\d{2}\/\d{2}\/\d{4})/i),
    passport: grab(pB, /Passport No\.?\s+([A-Z0-9]+)/i),
    contactNative: grab(pB, /Contact Number \(in Native\s*Country\)\s*([0-9]+)/i),
    contactLocal: '',
    email: grab(pB, /Email Id\s+([^\s]+@[^\s]+)/i),
    relation: 'PATIENT',
  };

  // Attendants
  const re = /Sr No\.?\s*(\d+)\s+Surname\s+([A-Z][A-Za-z' -]*?)\s+Given Name\s+([A-Z][A-Za-z' -]*?)\s+Gender\s+(MALE|FEMALE)\s+Date of Birth\s+(\d{2}\/\d{2}\/\d{4})\s+Nationality\s+[A-Za-z]+\s+Passport No\.?\s+([A-Z0-9]+)([\s\S]*?)(?=Sr No\.?\s*\d+\s+Surname|\(Authorised|Page \d+ of|$)/gi;
  let m;
  while ((m = re.exec(T)) !== null) {
    const tail = m[7] || '';
    data.attendants.push({
      sr: m[1], surname: clean(m[2]), given: clean(m[3]), gender: m[4].toUpperCase(),
      dob: m[5], passport: clean(m[6]),
      relation: (grab(tail, /Relationship with the patient\s+([A-Za-z ]+)/i) || '').toUpperCase(),
      contactNative: grab(tail, /Contact Number \(In Native\s*Country\)\s*([0-9]+)/i) || data.patient.contactNative,
      email: grab(tail, /Email Id\s+([^\s]+@[^\s]+)/i) || data.patient.email,
    });
  }
  return data;
}

const full = (p) => clean((p.given || '') + ' ' + (p.surname || ''));

// আজকের তারিখ "25 August 2026" ফরম্যাটে
function today() {
  const M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const d = new Date();
  return d.getDate() + ' ' + M[d.getMonth()] + ' ' + d.getFullYear();
}

// ---------- jsPDF রেন্ডারার ----------
function newDoc() {
  const { jsPDF } = window.jspdf;
  return new jsPDF({ unit: 'pt', format: 'a4' });
}
function makeWriter(doc, sig) {
  const M = 56, PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight(), W = PW - 2 * M;
  let y = 60;
  function ensure(h) { if (y + h > PH - 60) { doc.addPage(); y = 60; } }
  function para(text, o = {}) {
    const size = o.size || 11, bold = o.bold, align = o.align || 'left', gap = (o.gap == null ? 11 : o.gap);
    doc.setFont('times', bold ? 'bold' : 'normal'); doc.setFontSize(size);
    const lines = doc.splitTextToSize(text, W);
    ensure(lines.length * size * 1.45);
    const x = align === 'center' ? PW / 2 : align === 'right' ? PW - M : M;
    doc.text(lines, x, y, { align, maxWidth: W, lineHeightFactor: 1.45 });
    y += lines.length * size * 1.45 + gap;
  }
  function gapY(h) { y += h; }
  return { para, gapY, get y() { return y; }, doc, M, W };
}

// প্যাসেঞ্জারের নাম দিয়ে ফাইলনেম
const fname = (kind, p) => (kind + '_' + full(p)).replace(/[^A-Za-z0-9]+/g, '_') + '.pdf';

// ১) রোগীর Undertaking (Medical Visa)
export function buildPatientUndertaking(data, mission) {
  const doc = newDoc(); const w = makeWriter(doc);
  const p = data.patient, ms = MISSIONS[mission] || MISSIONS.BGDD;
  const hosp = data.hospital;
  w.para('To', { gap: 2 });
  w.para('The Visa Officer', { gap: 2 });
  w.para(ms.line1, { gap: 2 });
  w.para(ms.city + ', Bangladesh', { gap: 14 });
  w.para('Subject: Undertaking for Medical Visa Application.', { bold: true, gap: 14 });
  w.para('I, ' + full(p) + ', holder of Bangladesh Passport No. ' + p.passport + ', am applying for a Medical Visa to travel to India for treatment at ' + hosp.name + ', located at ' + hosp.address + ', ' + hosp.state + ', India.');
  w.para('I am seeking medical treatment for ' + data.diagnosis + ' as advised by the concerned medical specialists. The purpose of my visit is solely for medical consultation, treatment, and related follow-up procedures at the above-mentioned hospital.');
  if (data.attendants.length) {
    w.para('I would also like to request the issuance of Medical Attendant Visas for my attendants:', { gap: 6 });
    data.attendants.forEach((a, i) => w.para('Attendant ' + (i + 1) + ': ' + full(a) + ' (Passport No. ' + a.passport + ')', { gap: 4 }));
    w.gapY(6);
  }
  w.para('I undertake that:', { gap: 6 });
  const names = data.attendants.map(full);
  const namesJoined = names.length ? names.slice(0, -1).join(', ') + (names.length > 1 ? ' and ' : '') + names[names.length - 1] : '';
  const items = [
    'All information provided in the visa application and supporting documents is true and correct to the best of my knowledge.',
    (names.length ? 'My attendants, ' + namesJoined + ', will accompany me only for the purpose of providing necessary assistance during my medical treatment.' : 'I will travel solely for the purpose of medical treatment.'),
    'We shall abide by all laws, rules, and regulations of India during our stay.',
    'We shall not engage in any activity other than those permitted under the respective visa categories.',
    'We shall bear all expenses related to travel, accommodation, medical treatment, and other associated costs during our stay in India.',
    'We shall leave India upon completion of the medical treatment and within the validity period of the visas granted.',
  ];
  items.forEach((t, i) => w.para((i + 1) + '.  ' + t, { gap: 5 }));
  w.gapY(6);
  w.para('I respectfully request the High Commission of India to kindly consider our visa applications and grant the necessary Medical Visa and Medical Attendant Visas.');
  w.para('Thank you for your kind consideration.', { gap: 18 });
  w.para('Yours faithfully,', { gap: 22 });
  w.para(full(p), { bold: true, gap: 2 });
  w.para('Passport No: ' + p.passport, { gap: 2 });
  w.para('Date: ' + today(), { gap: 2 });
  if (p.contactNative) w.para('Contact Number: ' + p.contactNative, { gap: 2 });
  return { doc, filename: fname('Undertaking_Patient', p) };
}

// ২) সহযাত্রীর Undertaking (Medical Attendant Visa)
export function buildAttendantUndertaking(data, att, mission) {
  const doc = newDoc(); const w = makeWriter(doc);
  const p = data.patient, ms = MISSIONS[mission] || MISSIONS.BGDD, hosp = data.hospital;
  w.para('To', { gap: 2 });
  w.para('The Visa Officer', { gap: 2 });
  w.para(ms.line1, { gap: 2 });
  w.para(ms.city + ', Bangladesh', { gap: 14 });
  w.para('Subject: Undertaking for Medical Attendant Visa Application.', { bold: true, gap: 14 });
  w.para('I, ' + full(att) + ', holder of Bangladesh Passport No. ' + att.passport + ', am applying for a Medical Attendant Visa to accompany my patient ' + full(p) + ', holder of Bangladesh Passport No. ' + p.passport + ', who is travelling to India for medical treatment at ' + hosp.name + ', located at ' + hosp.address + ', ' + hosp.state + ', India.');
  w.para('The patient is seeking medical treatment for ' + data.diagnosis + ' as advised by the concerned medical specialists. I will be accompanying the patient solely to provide the necessary care and assistance during the medical consultation, treatment, and related follow-up procedures at the above-mentioned hospital.');
  w.para('Details of the patient I will be accompanying:', { gap: 6 });
  w.para('Name: ' + full(p), { gap: 3 });
  w.para('Passport Number: ' + p.passport, { gap: 10 });
  w.para('I undertake that:', { gap: 6 });
  const items = [
    'All information provided in the visa application and supporting documents is true and correct to the best of my knowledge.',
    'I, ' + full(att) + ', will accompany the patient only for the purpose of providing necessary assistance during the medical treatment.',
    'We shall abide by all laws, rules, and regulations of India during our stay.',
    'We shall not engage in any activity other than those permitted under the respective visa categories.',
    'We shall bear all expenses related to travel, accommodation, medical treatment, and other associated costs during our stay in India.',
    'We shall leave India upon completion of the medical treatment and within the validity period of the visa granted.',
  ];
  items.forEach((t, i) => w.para((i + 1) + '.  ' + t, { gap: 5 }));
  w.gapY(6);
  w.para('I respectfully request the High Commission of India to kindly consider this application and grant the necessary Medical Attendant Visa.');
  w.para('Thank you for your kind consideration.', { gap: 18 });
  w.para('Yours faithfully,', { gap: 22 });
  w.para(full(att), { bold: true, gap: 2 });
  w.para('Passport No: ' + att.passport, { gap: 2 });
  w.para('Date: ' + today(), { gap: 2 });
  if (att.contactNative) w.para('Contact Number: ' + att.contactNative, { gap: 2 });
  return { doc, filename: fname('Undertaking_Attendant', att) };
}

// ৩) নাবালকের Parental Consent Letter
export function buildParentalConsent(data, child, mission) {
  const doc = newDoc(); const w = makeWriter(doc);
  const ms = MISSIONS[mission] || MISSIONS.BGDD, hosp = data.hospital;
  // বাবা = রোগী (পুরুষ) নাহলে স্বামী; মা = WIFE/মহিলা attendant
  const people = [data.patient, ...data.attendants];
  const father = (data.patient.gender === 'MALE') ? data.patient : (people.find((x) => /HUSBAND|FATHER/.test(x.relation)) || data.patient);
  const mother = people.find((x) => /WIFE|MOTHER/.test(x.relation)) || people.find((x) => x.gender === 'FEMALE') || {};
  w.para('PARENTAL CONSENT LETTER', { bold: true, align: 'center', size: 13, gap: 14 });
  w.para('Date: ' + today(), { gap: 10 });
  w.para('To', { gap: 2 });
  w.para('The Visa Officer', { gap: 2 });
  w.para(ms.line1, { gap: 2 });
  w.para(ms.city + ', Bangladesh', { gap: 14 });
  w.para('Subject: Consent for Medical Treatment and Travel of Minor Child', { bold: true, gap: 14 });
  w.para('We, Mr. ' + full(father) + ' (Father) and Mrs. ' + full(mother) + ' (Mother), hereby give our full consent and permission for our minor child, ' + full(child) + ', Passport No. ' + child.passport + ', Date of Birth ' + child.dob + ', to travel to India for medical treatment at ' + hosp.name + ', India.');
  w.para('We have no objection to our child obtaining an Indian Medical Visa and undergoing the required medical treatment in India. We fully understand the purpose of the visit and accept responsibility for all matters related to the child’s travel, stay, and treatment.');
  w.para('We confirm that the information provided is true and correct.', { gap: 14 });
  w.para('Father’s Details', { bold: true, gap: 4 });
  w.para('Name: ' + full(father), { gap: 3 });
  w.para('Passport No.: ' + father.passport, { gap: 3 });
  w.para('Mobile No.: ' + (father.contactNative || ''), { gap: 3 });
  w.para('Signature:', { gap: 16 });
  w.para('Mother’s Details', { bold: true, gap: 4 });
  w.para('Name: ' + full(mother), { gap: 3 });
  w.para('Passport No.: ' + (mother.passport || ''), { gap: 3 });
  w.para('Mobile No.: ' + (mother.contactNative || father.contactNative || ''), { gap: 3 });
  w.para('Signature:', { gap: 16 });
  w.para('Place: ' + ms.city + ', Bangladesh', { gap: 2 });
  return { doc, filename: fname('Parental_Consent', child) };
}
