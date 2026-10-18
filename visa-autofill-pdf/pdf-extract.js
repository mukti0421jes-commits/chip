/* ===================================================================
   Visa Autofill (PDF) — pdf-extract.js
   Indian Visa application প্রিন্ট-PDF এর লেখা থেকে ফর্ম-ফিল্ডে ম্যাপ করে।
   পরিষ্কার label-ওলা ঘরগুলো নির্ভুল; multi-column (ঠিকানা/reference/hotel)
   ঘরগুলো best-effort — save করার আগে edit করে নেওয়া যায়।
   =================================================================== */

const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

// সাইটের ঠিকানা ঘরগুলোর সর্বোচ্চ দৈর্ঘ্য — এর বেশি হলে পরের ঘরে গড়িয়ে দিই
const ADDR_MAX = 35;

// নাম + ঠিকানা মেশানো এক লাইন → {name, addr}
// নামের শেষে HOTEL/GUEST HOUSE/LODGE ইত্যাদি কীওয়ার্ড পর্যন্ত = নাম;
// নাহলে প্রথম সংখ্যাওয়ালা টোকেন থেকে ঠিকানা শুরু; নাহলে প্রথম ২ শব্দ নাম।
const HOTEL_KW = /^(HOTEL|LODGE|INN|RESIDENCY|RESIDENCE|GUEST|HOUSE|BHAWAN|BHAVAN|DHAM|ASHRAM|VILLA|PALACE|TOWER|PLAZA|INTERNATIONAL)$/i;
function splitNameAddr(s) {
  const w = String(s || '').replace(/[.,]+$/, '').split(/\s+/).filter(Boolean);
  if (!w.length) return { name: '', addr: '' };
  let cut = -1;
  for (let i = 0; i < w.length; i++) if (HOTEL_KW.test(w[i]) && !(w[i].toUpperCase() === 'INTERNATIONAL' && i === 0)) cut = i;
  if (cut < 0) { for (let i = 1; i < w.length; i++) if (/\d/.test(w[i])) { cut = i - 1; break; } }
  if (cut < 0) cut = Math.min(1, w.length - 1);
  return { name: w.slice(0, cut + 1).join(' '), addr: w.slice(cut + 1).join(' ') };
}

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
      // ডান-কলামের label (Phone No / Mobile / Email) — সংখ্যা থাকুক বা না থাকুক, বাদ
      .map((l) => l.replace(/Phone No\b.*$/i, '').replace(/Mobile\s*\/?\s*Cell No\b.*$/i, '').replace(/Email address\b.*$/i, ''))
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
    // প্রথম ঘরে প্রথম ২টি শব্দ (যেমন "NARIKELBARIA, BAGHERPARA,"),
    // পরের ঘরে বাকিটুকু (district/state আগেই আলাদা করা হয়েছে)
    const words = lines.join(' ').split(/\s+/).filter(Boolean);
    return { a1: words.slice(0, 2).join(' '), a2: words.slice(2).join(' '), state, pin };
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
  flags.saarc = flags.saarc || 'NO';   // SAARC ভিজিট — ডিফল্ট No (এডিটরে বদলানো যাবে)

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
      // raw block → 'India' label বাদ → নাম আলাদা করে add1, বাকিটা ঠিকানা হিসেবে add2/add3 (৩৫ অক্ষর)
      const blkRaw = rawBlock(/Address where You stayed in/, /Cities in India Visited/);
      const full = clean(blkRaw).replace(/^India\s+/i, '');
      const na = splitNameAddr(full);
      if (na.name) values['prv_visit_add1'] = na.name;
      const rest = packInto(na.addr, 35, 2);
      if (rest[0]) values['prv_visit_add2'] = rest[0];
      if (rest[1]) values['prv_visit_add3'] = rest[1];
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
  // "Profession/Occupation Details : of Father/Mother/Spouse/Self" → occ_flag (F/M/S)
  const occOf = grab(/Profession\/Occupation Details\s*:?\s*of\s+([A-Za-z]+)/i).toUpperCase();
  if (occOf) {
    const OMAP = { FATHER: 'F', MOTHER: 'M', SPOUSE: 'S', HUSBAND: 'S', WIFE: 'S', SELF: 'SELF', APPLICANT: 'SELF' };
    values['occ_flag'] = OMAP[occOf] || occOf;
  }
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

  // ---------- H. Place of Stay / Hotel (প্রথম row) — নির্দিষ্ট কাঠামোয় ভাগ ----------
  // পুরো row একটা লাইন: "1 <হোটেল নাম> <ঠিকানা> <District> <State>. <Phone>,"
  // guard: State আলাদা করি (dropdown), District WB-লজিকে, Phone শেষে, নাম=প্রথম ২ শব্দ, বাকিটা ঠিকানা
  const hotel = grab(/Place\/Hotel Name[\s\S]*?\n\s*1\s+([^\n]+)/);
  if (hotel) {
    let s = clean(hotel);
    // Phone — শেষে ৬+ সংখ্যা (কমা/ডট বাদ)
    const phoneM = s.match(/([0-9]{6,})[\s.,]*$/);
    if (phoneM) { values['pos_phone1'] = phoneM[1]; s = clean(s.slice(0, phoneM.index)); }
    s = clean(s.replace(/[.,]+\s*$/, ''));
    // State — সাইটের STATES তালিকা থেকে (দীর্ঘতমটা আগে)
    const st = STATES.find((x) => new RegExp('\\b' + x.replace(/[-/]/g, '\\$&') + '\\b').test(s.toUpperCase()));
    if (st) { values['pos_state_id1'] = st; s = clean(s.replace(new RegExp(st + '\\.?', 'i'), '')); }
    // District — reference-এর মতোই WB তালিকা থেকে (WB district পেলে state ধরে নিই WEST BENGAL)
    const dt = WB_DIST.find((d) => s.toUpperCase().includes(d));
    if (dt) { values['pos_dist_id1'] = dt; s = clean(s.replace(new RegExp(dt, 'i'), '')); }
    if (dt && !values['pos_state_id1']) values['pos_state_id1'] = 'WEST BENGAL';
    // বাকি অংশ = হোটেল নাম + ঠিকানা → একই স্মার্ট স্প্লিট
    const hs = splitNameAddr(clean(s));
    values['place_of_stay1'] = hs.name;
    if (hs.addr) values['pos_address1'] = hs.addr;
  }

  // ---------- I. References (দুই কলাম: India | Bangladesh, Tab দিয়ে আলাদা) ----------
  parseReferences(TAB, values);

  // ---------- Present == Permanent হলে "same address" checkbox ----------
  const norm = (s) => (s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (values['pres_add1'] && norm(values['pres_add1']) === norm(values['perm_address1']) &&
      norm(values['pres_add2']) === norm(values['perm_address2'])) {
    flags.sameAddress = true;
  }

  // ---------- Registration (Mission) — Application Id-র শুরুতে mission কোড ----------
  values['countryname_id'] = values['countryname_id'] || 'BGD';
  values['nationality_id'] = values['nationality_id'] || 'BGD';
  // Application Id যেমন "BGDRV1E2E826" → প্রথম ৪ অক্ষর "BGDR" = Rajshahi mission
  const appId = grab(/Application Id\s*:?\s*(BGD[A-Z][A-Z0-9]+)/i);
  if (appId) values['missioncode_id'] = appId.slice(0, 4).toUpperCase();
  if (!values['missioncode_id']) {
    // ফলব্যাক: হেডারের শহরের নাম থেকে
    const hdr = grab(/(?:HIGH|ASSISTANT HIGH) COMMISSION OF INDIA\s+([A-Z]+)/i).toUpperCase();
    const CITY = { DHAKA: 'BGDD', CHITTAGONG: 'BGDC', CHATTOGRAM: 'BGDC', RAJSHAHI: 'BGDR', KHULNA: 'BGDK', SYLHET: 'BGDS', RANGPUR: 'BGDG', BARISAL: 'BGDB', MYMENSINGH: 'BGDM' };
    values['missioncode_id'] = CITY[hdr] || 'BGDD';
  }
  // Visa type: আগে explicit "Type Of Visa Required"; না থাকলে Purpose লেখা থেকে অনুমান;
  // সবশেষে "Required Detail of" (এটা কখনো medical section-এর residual হতে পারে, তাই শেষে)
  let vtype = grab(/Type Of Visa Required\s+([A-Z][A-Z /()-]*?VISA)\s+No of Entries/i);
  if (!vtype) {
    const purp = grab(/Purpose of Visit\s*:?\s*([^\n]+)/i).toUpperCase();
    if (/TOURIS|SIGHTSEEING|FRIENDS OR RELATIVES|RECREATION/.test(purp)) vtype = 'TOURIST VISA';
    else if (/MEDICAL TREATMENT|MEDICAL/.test(purp)) vtype = 'MEDICAL VISA';
    else if (/ATTENDANT|MEDICAL ATTENDANT/.test(purp)) vtype = 'MEDICAL ATTENDANT VISA';
    else if (/BUSINESS/.test(purp)) vtype = 'BUSINESS VISA';
    else if (/STUDENT|STUDY/.test(purp)) vtype = 'STUDENT VISA';
    else if (/TRANSIT/.test(purp)) vtype = 'TRANSIT VISA';
    else if (/CONFERENCE/.test(purp)) vtype = 'CONFERENCE VISA';
    else if (/EMPLOYMENT/.test(purp)) vtype = 'EMPLOYMENT VISA';
    else if (/DOUBLE ENTRY|APPLY FOR|MISCELLANEOUS/.test(purp)) vtype = 'MISCELLANEOUS VISA';
  }
  if (!vtype) vtype = grab(/Required Detail of\s+([A-Z][A-Z /()-]*?VISA)/i);
  if (vtype) values['visaTypeText'] = clean(vtype);   // সাইটের dropdown-এর লেখা মিলিয়ে সেট হবে
  // জানা কয়েকটি টাইপ → সরাসরি কোড (দ্রুত), বাকিগুলো text-মিলে হবে
  const pmap = { TOURIST: '544', MEDICAL: '545', BUSINESS: '537', STUDENT: '540', TRANSIT: '233', JOURNALIST: '228' };
  for (const k in pmap) if (vtype && vtype.toUpperCase().includes(k)) { values['visaPurposeDropdown'] = pmap[k]; break; }

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
  // ঠিকানা ঘরের ক্ষমতা (৩৫) অনুযায়ী ২ ঘরে ভাগ — সব এক ঘরে ঢুকে না যায়
  if (addr) {
    const packed = packInto(addr, ADDR_MAX, 2);
    if (packed[0]) values[ids.a1] = packed[0];
    if (packed[1]) values[ids.a2] = packed[1];
  }
}

// References ব্লক: প্রতি লাইন Tab দিয়ে [label, India, Bangladesh] — কলাম বেছে নিই
function parseReferences(T, values) {
  const m = T.match(/I\. Details of Two Reference([\s\S]*?)(?:\n\s*I\. DOCUMENTS|\n\s*K\. DECLARATION|$)/);
  if (!m) return;
  // পেজের হেডার/ওয়াটারমার্ক লাইন (ডান কলামে পড়ে) — reference নয়, বাদ
  const noise = (s) => /^(Application Id|Web Registration|Page\b|BGDD?V|BGDRV)/i.test(s) || /Application Id\s*:/i.test(s);
  const indSegs = [], bdSegs = [];
  for (const raw of m[1].split('\n')) {
    const parts = raw.split('\t');
    // কমা রেখে দিই (ঠিকানার অংশ যেন না মেশে), শুধু whitespace trim
    const ind = (parts[1] || '').replace(/\s+/g, ' ').trim();
    const bd = (parts[2] || '').replace(/\s+/g, ' ').trim();
    if (ind && !/^In India$/i.test(ind) && !noise(ind)) indSegs.push(ind);
    if (bd && !/^In BANGLADESH$/i.test(bd) && !noise(bd)) bdSegs.push(bd);
  }
  assignRef(indSegs, values, { name: 'nameofsponsor_ind', a1: 'add1ofsponsor_ind', a2: 'add2ofsponsor_ind', phone: 'phoneofsponsor_ind', state: 'stateofsponsor_ind', dist: 'districtofsponsor_ind' });
  assignRef(bdSegs, values, { name: 'nameofsponsor_msn', a1: 'add1ofsponsor_msn', a2: 'add2ofsponsor_msn', phone: 'phoneofsponsor_msn' });
}

// একটি reference-এর কয়েকটি লাইন (নাম / ঠিকানা / ... / ফোন) → {name, addr, state, dist, phone}
// State/District ঠিকানা থেকে নিজে খুঁজে আলাদা করে; WB district পেলে state ধরে নেয় WEST BENGAL
export function parseRefBlock(lines) {
  const ls = (Array.isArray(lines) ? lines : String(lines).split('\n')).map((x) => rclean(x)).filter(Boolean);
  if (!ls.length) return null;
  const name = ls[0];
  let phone = '';
  if (ls.length > 1 && /^[0-9+][0-9+\s-]{6,}$/.test(ls[ls.length - 1])) {
    phone = ls.pop().replace(/[^0-9+]/g, '');
  }
  let addr = rclean(ls.slice(1).join(', '));
  let state = '', dist = '';
  if (addr) {
    const st = STATES.find((s) => new RegExp('\\b' + s.replace(/[-/]/g, '\\$&') + '\\b').test(addr.toUpperCase()));
    if (st) { state = st; addr = rclean(addr.replace(new RegExp(st, 'i'), '')); }
    const dt = WB_DIST.find((d) => addr.toUpperCase().includes(d));
    if (dt) { dist = dt; addr = rclean(addr.replace(new RegExp(dt, 'i'), '')); }
    if (dist && !state) state = 'WEST BENGAL';
  }
  addr = rclean(addr.replace(/,\s*,+/g, ','));
  return { name, addr, state, dist, phone };
}

function renameFamily(values, prefix, map) {
  for (const [suf, id] of Object.entries(map)) {
    const k = prefix + '_' + suf;
    if (k !== id && values[k] !== undefined) { values[id] = values[k]; delete values[k]; }
  }
}
