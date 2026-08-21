/* ===================================================================
   Visa Autofill (PDF) — pdf-extract.js
   Indian Visa application প্রিন্ট-PDF এর লেখা থেকে ফর্ম-ফিল্ডে ম্যাপ করে।
   পরিষ্কার label-ওলা ঘরগুলো নির্ভুল; multi-column (ঠিকানা/reference/hotel)
   ঘরগুলো best-effort — save করার আগে edit করে নেওয়া যায়।
   =================================================================== */

const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

function toDate(s) {
  if (!s) return '';
  const m = String(s).trim().match(/(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{4})/);
  if (m) return m[1].padStart(2, '0') + '/' + (MONTHS[m[2].toUpperCase()] || '01') + '/' + m[3];
  const d = String(s).trim().match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (d) return d[1].padStart(2, '0') + '/' + d[2].padStart(2, '0') + '/' + d[3];
  return String(s).trim();
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim();
}

// লম্বা লেখা শব্দ ধরে maxLen অক্ষরের maxLines লাইনে ভাগ করে (৩৫-অক্ষরের ঘরগুলোর জন্য)
function packInto(text, maxLen, maxLines) {
  const words = clean(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (t.length <= maxLen) cur = t;
    else if (lines.length < maxLines - 1) { lines.push(cur); cur = w; }
    else cur = t; // শেষ লাইন — বাকিটা এখানেই (সাইট ৩৫-এ কেটে নেবে)
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

// PDF text (পুরোটা এক string) থেকে তথ্য বের করে {values, flags, name} ফেরত দেয়
export function parseVisaPdf(rawText) {
  // plain অংশ সব parsing-এ, tabbed অংশ শুধু References কলাম আলাদা করতে
  const split = rawText.replace(/\r/g, '').split('<<<TABS>>>');
  const T = split[0];
  const TAB = split[1] || '';
  const values = {};
  const flags = {};

  const grab = (re, idx = 1) => {
    const m = T.match(re);
    return m ? clean(m[idx]) : '';
  };
  const put = (id, v) => { if (v) values[id] = v; };

  // ---------- A. Personal ----------
  put('surname', grab(/Surname\s*\(As in Passport\)\s*([A-Z][A-Za-z' -]*?)\s*(?:\n|Given Name)/));
  put('givenName', grab(/Given Name\s*\(As in Passport\)\s*([A-Z][A-Za-z' -]*?)\s*(?:\n|Previous)/));
  put('gender', grab(/Gender\s+([A-Za-z]+)/));
  const marital = grab(/Marital Status\s+([A-Za-z]+)/);
  if (marital) values['marital_status'] = marital; // MARRIED/SINGLE → smart-select 0/1
  put('dob_id', toDate(grab(/Date of Birth\s+([0-9A-Za-z-]+)/)));
  put('religion', grab(/Religion\s+([A-Za-z]+)/));
  put('birth_place', grab(/Place of Birth Town\/City\s+([A-Za-z .'-]+?)\s+Country of Birth/));
  put('country_birth', grab(/Country of Birth\s+([A-Za-z .'-]+?)\s*(?:\n|Citizenship)/));
  put('nic_number', grab(/Citizenship\s*\/National ID No\s+([A-Za-z0-9]+)/));
  put('education', grab(/Educational Qualification\s+([A-Za-z .'/-]+?)\s*(?:\n|Visible)/));
  put('identity_marks', grab(/Visible identification marks\s+([A-Za-z0-9 .'-]+?)\s*(?:\n|Current)/));
  put('nationality_id', grab(/Current Nationality\s+([A-Z][A-Za-z ]+?)\s*(?:\n|Nationality by)/));
  put('nationality_by', grab(/Naturalization\s+(BY BIRTH|NATURALIZATION)/i));
  const changed = grab(/Previous\/other Name if any\s+(.+?)\s*(?:\n|Gender)/);
  if (changed && !/not applicable/i.test(changed)) { flags.changedName = true; values['prev_given_name'] = changed; }

  // ---------- B. Passport ----------
  put('passport_no', grab(/Passport No\.?\s+([A-Za-z0-9]+)/));
  put('passport_issue_date', toDate(grab(/Passport No[\s\S]*?Date of Issue\s*\(?[^)]*\)?\s+([0-9A-Za-z-]+)/)));
  put('passport_issue_place', grab(/Place of Issue\s+([A-Za-z .'-]+?)\s+Date of Expiry/));
  put('passport_expiry_date', toDate(grab(/Date of Expiry\s*\(?[^)]*\)?\s+([0-9A-Za-z-]+)/)));

  // লাইনে "(if yes ...)" থাকে, তাই lazy নয় — greedy দিয়ে লাইনের শেষ YES/NO (আসল উত্তর) নিই
  const other = grab(/Any other Passport\/Identity Certificate held.*\b(YES|NO)\b/i);
  if (other) {
    flags.otherPassport = other.toUpperCase();
    if (flags.otherPassport === 'YES') {
      put('other_ppt_country_issue', grab(/Country of Issue\s+([A-Za-z .'-]+?)\s+Place of Issue/));
      put('other_ppt_issue_place', grab(/Country of Issue[\s\S]*?Place of Issue\s+([A-Za-z .'-]+?)\s*(?:\n|Passport\/IC)/));
      put('other_ppt_no', grab(/Passport\/IC No\.?\s+([A-Za-z0-9]+)/));
      put('other_ppt_issue_date', toDate(grab(/Passport\/IC No[\s\S]*?Date of issue\s*\(?[^)]*\)?\s+([0-9A-Za-z-]+)/i)));
      put('other_ppt_nat', grab(/Nationality\/Status\s+([A-Za-z .'-]+?)\s*(?:\n|C\.)/));
    }
  }

  // ---------- C. Contact ----------
  put('pres_phone', grab(/Phone No\s+([0-9+]+)/));
  let mob = grab(/Mobile\s*\/?Cell No\s+([0-9+]+)/);
  if (mob) {
    mob = mob.replace(/^\+?880/, ''); // ISD আলাদা
    values['mobile'] = mob;
    values['isd_code1'] = '880';
  }
  put('email_id', grab(/Email address\s+([^\s]+@[^\s]+)/));
  if (values['email_id']) values['email_re_id'] = values['email_id'];
  values['pres_country'] = 'BANGLADESH';

  // multi-line ঠিকানা: newline ধরে রাখতে raw substring নিই (clean নয়)
  const rawBlock = (startRe, endRe) => {
    const s = T.search(startRe); if (s < 0) return '';
    const from = T.slice(s).replace(startRe, '');
    const e = from.search(endRe);
    return e < 0 ? from : from.slice(0, e);
  };
  // ঠিকানা লাইনগুলো → {a1,a2,state,pin}; ডান-কলামের label বাদ দিয়ে
  const parseAddr = (block) => {
    let lines = block.split('\n')
      .map((l) => l.replace(/Phone No\s+[0-9+]+/, '').replace(/Mobile\s*\/?Cell No\s+[0-9+]+/, '').replace(/Email address\s+\S+@\S+/, ''))
      .map((l) => l.replace(/^\s*(Present|Permanent|Address)\s*/, ''))
      .map(clean).filter(Boolean);
    let state = '', pin = '';
    // শেষ লাইনে "STATE, BANGLADESH 7470" বা শুধু "JASHORE"
    const last = lines[lines.length - 1] || '';
    const m = last.match(/^([A-Z].*?),?\s*(?:BANGLADESH)?\s*(\d{4,7})?$/);
    if (last && lines.length > 1) {
      const cc = last.match(/([A-Z][A-Za-z ]*?),\s*BANGLADESH\s*(\d{4,7})?/);
      if (cc) { state = clean(cc[1]); pin = cc[2] || ''; lines = lines.slice(0, -1); }
      else if (/^[A-Z][A-Za-z ]+$/.test(last)) { state = last; lines = lines.slice(0, -1); }
    }
    const half = Math.ceil(lines.length / 2) || 1;
    const a1 = lines.slice(0, half).join(' ');
    const a2 = lines.slice(half).join(' ');
    return { a1, a2, state, pin };
  };

  const pres = parseAddr(rawBlock(/C\. Applicant's Contact Details/, /Permanent/));
  if (pres.a1) values['pres_add1'] = pres.a1;
  if (pres.a2) values['pres_add2'] = pres.a2;
  if (pres.state) values['pres_add3'] = pres.state;
  if (pres.pin) values['pincode'] = pres.pin;

  const perm = parseAddr(rawBlock(/Permanent/, /D\. Family/));
  if (perm.a1) values['perm_address1'] = perm.a1;
  if (perm.a2) values['perm_address2'] = perm.a2;
  if (perm.state) values['perm_address3'] = perm.state;

  // ---------- D. Family ----------
  const famRow = (label, prefix) => {
    // "Father's NAME... NAT PREVNAT\n PLACE\n COUNTRY"
    const re = new RegExp(label + "\\s+([\\s\\S]*?)\\n\\s*([A-Za-z .'-]+)\\n\\s*([A-Za-z .'-]+?)\\s*(?:\\n|Were|Spouse|Mother's|D\\.|$)");
    const m = T.match(re);
    if (!m) return;
    const head = clean(m[1]).split(/\s+/);
    // শেষ দুই টোকেন = nationality, prevNationality
    if (head.length >= 3) {
      values[prefix + '_previous_nationality'] = head.pop();
      values[prefix + '_nationality'] = head.pop();
      values[prefix + '_name'] = head.join(' ');
    } else {
      values[prefix + '_name'] = clean(m[1]);
    }
    values[prefix + '_place_of_birth'] = clean(m[2]);
    values[prefix + '_country_of_birth'] = clean(m[3]);
  };
  // field id গুলো: father → fthrname; mother → mother_name; spouse → spouse_name
  famRow("Father's", 'father');
  if (values['father_name']) { values['fthrname'] = values['father_name']; delete values['father_name']; }
  // father id-গুলো ঠিক করি
  renameFamily(values, 'father', { name: 'fthrname', nationality: 'father_nationality', previous_nationality: 'father_previous_nationality', place_of_birth: 'father_place_of_birth', country_of_birth: 'father_country_of_birth' });
  famRow("Mother's", 'mother');
  renameFamily(values, 'mother', { name: 'mother_name', nationality: 'mother_nationality', previous_nationality: 'mother_previous_nationality', place_of_birth: 'mother_place_of_birth', country_of_birth: 'mother_country_of_birth' });
  famRow('Spouse', 'spouse');
  renameFamily(values, 'spouse', { name: 'spouse_name', nationality: 'spouse_nationality', previous_nationality: 'spouse_previous_nationality', place_of_birth: 'spouse_place_of_birth', country_of_birth: 'spouse_country_of_birth' });

  const gp = grab(/Pakistan held area\s*:?\s*(YES|NO)/i);
  if (gp) flags.grandparent = gp.toUpperCase();

  // ---------- E. Visa ----------
  put('visa_entry_id', grab(/No of Entries\s+([A-Za-z]+)/));
  put('duration', grab(/Period of Visa\s*\(?\s*Month\)?\s+(\d+)/));
  put('jouryney_id', toDate(grab(/Expected Date of Journey\s+([0-9A-Za-z-]+)/)));
  put('entrypoint', grab(/Port Of Arrival\s+([A-Za-z /]+?)\s+Port of Exit/));
  put('exitpointprc', grab(/Port of Exit\s+([A-Za-z /]+?)\s*(?:\n|Required|Application)/));
  put('visa_serreq_id_112', grab(/Places to be Visited\s+([^\n]+)/));
  put('visa_serreq_id_334', grab(/""\s+([^\n]+)/) || 'NA');

  // ---------- F. Previous Visit ----------
  const visited = grab(/Have You Ever visited India\s*\??\s*(YES|NO)/i);
  if (visited) {
    flags.visitedIndia = visited.toUpperCase();
    if (flags.visitedIndia === 'YES') {
      // raw block (newline রাখা) → 'India' label বাদ → ৩৫ অক্ষরের ৩ লাইনে ভাগ
      const blkRaw = rawBlock(/Address where You stayed in/, /Cities in India Visited/);
      const full = clean(blkRaw).replace(/^India\s+/i, '');
      const ln = packInto(full, 35, 3);
      if (ln[0]) values['prv_visit_add1'] = ln[0];
      if (ln[1]) values['prv_visit_add2'] = ln[1];
      if (ln[2]) values['prv_visit_add3'] = ln[2];
      put('visited_city', grab(/Cities in India Visited\s+([^\n]+)/));
      put('old_visa_type_id', grab(/Type of Visa\s+([A-Za-z ]+?)\s+Visa Number/));
      put('old_visa_no', grab(/Visa Number\s+([A-Za-z0-9]+)/));
      put('oldvisaissueplace', grab(/Visa Issued Place\s+([A-Za-z .'-]+?)\s+Date of Issue/));
      put('oldvisaissuedate', toDate(grab(/Visa Issued Place[\s\S]*?Date of Issue\s+([0-9A-Za-z-]+)/)));
    }
  }
  put('country_visited', grab(/Countries visited in last 10 years\s+([^\n]+)/));
  const refused = grab(/refused an Indian Visa.*\b(YES|NO)\b/i);
  if (refused) flags.refused = refused.toUpperCase();

  // ---------- G. Profession ----------
  // সাইটের occupation ড্রপডাউনের বৈধ মান — না মিললে OTHERS + specify (occupationOther)
  const OCC = ['AIR FORCE', 'BUSINESS PERSON', 'CAMERAMAN', 'CHARITY/SOCIAL WORKER', 'CHARTERED ACCOUNTANT', 'COLLEGE/UNIVERSITY TEACHER', 'DIPLOMAT', 'DOCTOR', 'ENGINEER', 'FILM PRODUCER', 'GOVERNMENT SERVICE', 'HOUSE WIFE', 'JOURNALIST', 'LABOUR', 'LAWYER', 'MEDIA', 'MILITARY', 'MISSIONARY', 'NAVY', 'NEWS BROADCASTER', 'OFFICIAL', 'OTHERS', 'POLICE', 'PRESS', 'PRIVATE SERVICE', 'PUBLISHER', 'REPORTER', 'RESEARCHER', 'RETIRED', 'SEA MAN', 'SELF EMPLOYED/ FREELANCER', 'STUDENT', 'TRADER', 'TV PRODUCER', 'UN-EMPLOYED', 'UN OFFICIAL', 'WORKER', 'WRITER'];
  const occ = grab(/Present Occupation\s+([A-Za-z0-9 /'&-]+?)\s+Designation\/Rank/);
  if (occ) {
    if (OCC.includes(occ.toUpperCase())) values['occupation'] = occ.toUpperCase();
    else { values['occupation'] = 'OTHERS'; values['occupationOther'] = occ; }
  }
  // Designation শুধু একই লাইনে থাকলে (ফাঁকা হলে খালিই থাকবে)
  put('empdesignation', grab(/Designation\/Rank[ \t]+([A-Za-z0-9 ./'-]+)/));
  put('empname', grab(/Employer name\/business\s+([^\n]+)/));
  // Employer Address + Phone — layout ভিন্ন হতে পারে, তাই block থেকে ভাগ করি
  const profBlock = rawBlock(/Employer Address/, /Past occupation/);
  profBlock.split('\n').map((l) => l.replace(/Phone Number/i, '')).map(clean).filter(Boolean).forEach((l) => {
    if (/^[0-9+][0-9+\s-]{5,}$/.test(l)) { if (!values['empphone']) values['empphone'] = l.replace(/\s/g, ''); }
    else if (!values['empaddress']) values['empaddress'] = l;
  });
  const mil = grab(/Armed forces\/\s*Police[^\n]*?\b(YES|NO)\b/i);
  if (mil) flags.military = mil.toUpperCase();

  // ---------- H. Place of Stay / Hotel (best-effort, প্রথম row) ----------
  const hotel = grab(/Place\/Hotel Name[\s\S]*?\n\s*1\s+([^\n]+)/);
  if (hotel) {
    // "SRIDHAM MAYAPUR MAYAPUR-741313 NADIA WEST BENGAL. 919593400990,"
    const phoneM = hotel.match(/([0-9]{6,})\s*,?\s*$/);
    if (phoneM) values['pos_phone1'] = phoneM[1];
    let rest = hotel.replace(/([0-9]{6,})\s*,?\s*$/, '').trim().replace(/\.\s*$/, '');
    const stM = rest.match(/([A-Z][A-Z ]+)$/);
    if (stM) {
      const words = clean(stM[1]).split(/\s+/);
      // দিক-শব্দ থাকলে শেষ ২ শব্দ = state (WEST BENGAL), তার আগের শব্দ = district
      if (words.length >= 3 && /^(WEST|EAST|NORTH|SOUTH)$/.test(words[words.length - 2])) {
        values['pos_state_id1'] = words.slice(-2).join(' ');
        values['pos_dist_id1'] = words[words.length - 3];
        rest = rest.slice(0, stM.index).trim() + ' ' + words.slice(0, -3).join(' ');
      } else {
        values['pos_state_id1'] = words.slice(-1)[0];
        if (words.length >= 2) values['pos_dist_id1'] = words[words.length - 2];
        rest = rest.slice(0, stM.index).trim() + ' ' + words.slice(0, -2).join(' ');
      }
    }
    values['place_of_stay1'] = clean(rest); // Place + Address মিলিয়ে — edit করে ভাগ করা যায়
  }

  // ---------- I. References (দুই কলাম: India | Bangladesh, Tab দিয়ে আলাদা) ----------
  parseReferences(TAB, values);

  // ---------- Present == Permanent হলে "same address" checkbox ----------
  const norm = (s) => (s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (values['pres_add1'] && norm(values['pres_add1']) === norm(values['perm_address1']) &&
      norm(values['pres_add2']) === norm(values['perm_address2'])) {
    flags.sameAddress = true;
  }

  // ---------- Registration (Mission) ডিফল্ট + Purpose কোড ----------
  values['countryname_id'] = values['countryname_id'] || 'BGD';
  values['nationality_id'] = values['nationality_id'] || 'BGD';
  values['missioncode_id'] = values['missioncode_id'] || 'BGDD';
  const vtype = grab(/Type Of Visa Required\s+([A-Z0-9 ()-]+?)\s+No of Entries/);
  const pmap = { TOURIST: '544', MEDICAL: '545', BUSINESS: '537', STUDENT: '540', TRANSIT: '233', JOURNALIST: '228' };
  for (const k in pmap) if (vtype && vtype.includes(k)) { values['visaPurposeDropdown'] = pmap[k]; break; }

  const name = clean((values['givenName'] || '') + ' ' + (values['surname'] || '')) || 'New Profile';
  return { values, flags, name };
}

// ভারতের রাজ্য (site stateofsponsor_ind option) — দীর্ঘতমটা আগে মেলাতে length-এ sort
const STATES = ['ANDAMAN AND NICOBAR ISLANDS', 'ANDHRA PRADESH', 'ARUNACHAL PRADESH', 'ASSAM', 'BIHAR', 'CHANDIGARH', 'CHHATTISGARH', 'DADRA NAGAR HAVELI AND DAMAN AND DIU', 'DADRA NAGAR HAVELI', 'DELHI', 'GOA', 'GUJARAT', 'HARYANA', 'HIMACHAL PRADESH', 'JAMMU AND KASHMIR', 'JHARKHAND', 'KARNATAKA', 'KERALA', 'LADAKH', 'LAKSHADWEEP', 'MADHYA PRADESH', 'MAHARASHTRA', 'MANIPUR', 'MEGHALAYA', 'MIZORAM', 'NAGALAND', 'ORISSA', 'PONDICHERRY', 'PUNJAB', 'RAJASTHAN', 'SIKKIM', 'TAMIL NADU', 'TELANGANA', 'TRIPURA', 'UTTARAKHAND', 'UTTAR PRADESH', 'WEST BENGAL'].sort((a, b) => b.length - a.length);
// পশ্চিমবঙ্গের জেলা (BD→India reference প্রায় সবসময় WB) — দীর্ঘতমটা আগে
const WB_DIST = ['ALIPURDUAR', 'BANKURA', 'BIRBHUM', 'DARJILING', 'EAST BURDWAN', 'EAST MIDNAPORE', 'HAWRAH', 'HOOGHLY', 'JALPAIGURI', 'JHARGRAM', 'KALIMPONG', 'KOCH BIHAR', 'KOLKATA', 'MALDA', 'MURSHIDABAD', 'NADIA', 'NORTH 24 PARGANAS', 'NORTH DINAJPUR', 'PURBABARDHAMAN', 'PURULIYA', 'SOUTH 24 PARGANAS', 'SOUTH DINAJPUR', 'WEST BURDWAN', 'WEST MIDNAPORE'].sort((a, b) => b.length - a.length);

const rclean = (s) => (s || '').replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '').trim();

function assignRef(segs, values, ids) {
  if (!segs.length) return;
  values[ids.name] = rclean(segs[0]);
  let phone = '';
  if (/^[0-9+][0-9+\s-]{6,}$/.test(segs[segs.length - 1])) phone = segs.pop().replace(/[^0-9+]/g, '');
  if (phone) values[ids.phone] = phone;
  let addr = rclean(segs.slice(1).join(' '));
  if (ids.state && addr) {
    const st = STATES.find((s) => new RegExp('\\b' + s.replace(/[-/]/g, '\\$&') + '\\b').test(addr.toUpperCase()));
    if (st) { values[ids.state] = st; addr = rclean(addr.replace(new RegExp(st, 'i'), '')); }
    const dt = WB_DIST.find((d) => addr.toUpperCase().includes(d));
    if (dt) { values[ids.dist] = dt; addr = rclean(addr.replace(new RegExp(dt, 'i'), '')); }
  }
  const parts = addr.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length) {
    const half = Math.ceil(parts.length / 2);
    values[ids.a1] = parts.slice(0, half).join(', ');
    if (parts.length > half) values[ids.a2] = parts.slice(half).join(', ');
  }
}

// References ব্লক: প্রতি লাইন Tab দিয়ে [label, India, Bangladesh] — কলাম বেছে নিই
function parseReferences(T, values) {
  const m = T.match(/I\. Details of Two Reference([\s\S]*?)(?:\n\s*I\. DOCUMENTS|\n\s*K\. DECLARATION|$)/);
  if (!m) return;
  const indSegs = [], bdSegs = [];
  for (const raw of m[1].split('\n')) {
    const parts = raw.split('\t');
    // কমা রেখে দিই (ঠিকানার অংশ যেন না মেশে), শুধু whitespace trim
    const ind = (parts[1] || '').replace(/\s+/g, ' ').trim();
    const bd = (parts[2] || '').replace(/\s+/g, ' ').trim();
    if (ind && !/^In India$/i.test(ind)) indSegs.push(ind);
    if (bd && !/^In BANGLADESH$/i.test(bd)) bdSegs.push(bd);
  }
  assignRef(indSegs, values, { name: 'nameofsponsor_ind', a1: 'add1ofsponsor_ind', a2: 'add2ofsponsor_ind', phone: 'phoneofsponsor_ind', state: 'stateofsponsor_ind', dist: 'districtofsponsor_ind' });
  assignRef(bdSegs, values, { name: 'nameofsponsor_msn', a1: 'add1ofsponsor_msn', a2: 'add2ofsponsor_msn', phone: 'phoneofsponsor_msn' });
}

function renameFamily(values, prefix, map) {
  for (const [suf, id] of Object.entries(map)) {
    const k = prefix + '_' + suf;
    if (k !== id && values[k] !== undefined) { values[id] = values[k]; delete values[k]; }
  }
}
