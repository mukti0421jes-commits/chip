/* ===================================================================
   Ivac Macros — content script
   Indian Visa Online (indianvisa-bangladesh.nic.in) ফর্ম অটো-ফিল
   =================================================================== */

(function () {
  'use strict';

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ---------- ছোট UI badge, বোঝার জন্য এক্সটেনশন কাজ করছে কিনা ----------
  function showBadge(text, color = '#e67e22') {
    let b = document.getElementById('ivac-macros-badge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'ivac-macros-badge';
      b.style.cssText = `
        position: fixed; top: 10px; right: 10px; z-index: 999999;
        background: ${color}; color: white; padding: 8px 14px;
        border-radius: 6px; font-family: Arial, sans-serif; font-size: 13px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);`;
      document.body.appendChild(b);
    }
    b.style.background = color;
    b.textContent = text;
  }

  // ---------- ফিল্ড সেট করার হেল্পার (change/input ইভেন্ট ফায়ার করে) ----------
  function setText(id, value) {
    const el = document.getElementById(id);
    if (!el || value === undefined || value === null) return false;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function setSelect(id, value) {
    const el = document.getElementById(id);
    if (!el || value === undefined || value === null) return false;
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function setAutoConfirm(enabled) {
    document.dispatchEvent(new CustomEvent('ivac-macros-autoconfirm', { detail: { enabled } }));
  }

  function setChecked(id, shouldCheck) {
    const el = document.getElementById(id);
    if (!el) return false;
    if (el.checked !== shouldCheck) el.click();
    return true;
  }

  // state select পরিবর্তনের পর AJAX দিয়ে district আসতে সময় লাগে,
  // তাই option না পাওয়া পর্যন্ত অপেক্ষা করে তারপর সেট করে
  async function waitAndSetSelect(id, value, timeoutMs = 6000) {
    if (!value) return false;
    await sleep(400); // AJAX কল শুরু হওয়ার জন্য একটু সময় দেওয়া
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = document.getElementById(id);
      if (el && el.options.length > 1) {
        const hasOption = Array.from(el.options).some(o => o.value === value);
        if (hasOption) {
          const ok = setSelect(id, value);
          console.log(`[Ivac Macros] ${id} সেট হলো:`, value, ok);
          return ok;
        }
      }
      await sleep(200);
    }
    console.warn(`[Ivac Macros] ${id}-এ "${value}" অপশন ${timeoutMs}ms পরও পাওয়া যায়নি`);
    // সময় শেষ হলেও শেষবার চেষ্টা করে দেখা
    return setSelect(id, value);
  }

  // ---------- পেজ ১: Registration (Country/Mission/Nationality/CAPTCHA) ----------
  async function fillRegistration(d) {
    setSelect('countryname_id', d.country);
    await sleep(500);
    setSelect('missioncode_id', d.mission);
    await sleep(500);
    setSelect('nationality_id', d.nationality);
    await sleep(300);

    setText('dob_id', d.dob);
    setText('email_id', d.email);
    setText('email_re_id', d.email);
    setText('jouryney_id', d.arrivalDate);

    // purpose dropdown (chosen.js) - hidden select-এ সরাসরি সেট
    setSelect('visaPurposeDropdown', d.purposeValue);

    const captchaEl = document.getElementById('captcha');
    if (captchaEl) captchaEl.focus();

    showBadge('✔ ফিল হয়েছে — এবার CAPTCHA টাইপ করে Continue চাপুন', '#27ae60');
  }

  // ---------- পেজ ২: Applicant Details ----------
  async function fillBasicDetails(d) {
    setText('surname', d.surname);
    setText('givenName', d.givenName);

    // নাম পরিবর্তন হয়েছে কিনা (থাকলে চেকবক্স টিক দিয়ে পূর্ব নাম বসানো)
    if (d.changedName) {
      setChecked('changedSurnameCheck', true);
      await sleep(300);
      setText('prev_surname', d.prevSurname);
      setText('prev_given_name', d.prevGivenName);
    }

    setSelect('gender', d.gender);
    setText('birth_place', d.birthPlace);
    setSelect('country_birth', d.birthCountry);
    setText('nic_number', d.nicNumber);
    setSelect('religion', d.religion);
    setText('identity_marks', d.identityMarks);
    setSelect('education', d.education);
    setSelect('nationality_by', d.nationalityBy);
    // Naturalization হলে পূর্ব জাতীয়তা দেখায়
    if (d.nationalityBy === 'NATURALIZATION' && d.prevNationality) {
      await sleep(200);
      setSelect('prev_nationality', d.prevNationality);
    }

    setText('passport_no', d.passportNo);
    setText('passport_issue_place', d.passportIssuePlace);
    setText('passport_issue_date', d.passportIssueDate);
    setText('passport_expiry_date', d.passportExpiryDate);

    if (d.hasOtherPassport) {
      setChecked('other_ppt_1', true);
      await sleep(300);
      const op = d.otherPassport || {};
      setSelect('other_ppt_country_issue', op.countryIssue);
      setText('other_ppt_no', op.passportNumber || op.no || op.number);
      setText('other_ppt_issue_date', op.issueDate);
      setText('other_ppt_issue_place', op.issuePlace);
      setSelect('other_ppt_nat', op.nationality);
    } else {
      setChecked('other_ppt_2', true);
    }

    showBadge('✔ Applicant Details ফিল হয়েছে — চেক করে Save and Continue চাপুন', '#27ae60');
  }

  // ---------- পেজ ৩: Family Details ----------
  async function fillFamilyDetails(d) {
    setText('pres_add1', d.presentAddress1);
    setText('pres_add2', d.presentAddress2);
    setSelect('pres_country', 'BGD');
    await sleep(300);
    setText('pres_add3', d.presentState);
    setText('pincode', d.pincode);
    setText('pres_phone', d.presentPhone);

    setSelect('isd_code1', d.isdCode || '880');
    setText('mobile', d.mobile);

    if (d.sameAddress) {
      setChecked('sameAddress_id', true);
    } else {
      setText('perm_address1', d.presentAddress1);
      setText('perm_address2', d.presentAddress2);
      setText('perm_address3', d.presentState);
    }

    setText('fthrname', d.fatherName);
    setSelect('father_nationality', d.fatherNationality);
    if (d.fatherPrevNationality) setSelect('father_previous_nationality', d.fatherPrevNationality);
    setText('father_place_of_birth', d.fatherBirthPlace);
    setSelect('father_country_of_birth', d.fatherBirthCountry);

    setText('mother_name', d.motherName);
    setSelect('mother_nationality', d.motherNationality);
    if (d.motherPrevNationality) setSelect('mother_previous_nationality', d.motherPrevNationality);
    setText('mother_place_of_birth', d.motherBirthPlace);
    setSelect('mother_country_of_birth', d.motherBirthCountry);

    setSelect('marital_status', d.maritalStatus);
    await sleep(300);

    // বিবাহিত (marital_status "0") হলে Spouse details দেখায়
    if (d.maritalStatus === '0' && d.spouse) {
      const sp = d.spouse;
      setText('spouse_name', sp.name);
      setSelect('spouse_nationality', sp.nationality);
      if (sp.prevNationality) setSelect('spouse_previous_nationality', sp.prevNationality);
      setText('spouse_place_of_birth', sp.birthPlace);
      setSelect('spouse_country_of_birth', sp.birthCountry);
    }

    setChecked(d.grandparentPakistan ? 'grandparent_flag1' : 'grandparent_flag2', true);
    if (d.grandparentPakistan && d.grandparentDetails) {
      await sleep(200);
      setText('grandparent_details', d.grandparentDetails);
    }

    setSelect('occupation', d.occupation);
    await sleep(300);
    setSelect('occ_flag', d.occupationOf);
    setText('empname', d.employerName);
    setText('empdesignation', d.employerDesignation);
    setText('empaddress', d.employerAddress);
    setText('empphone', d.employerPhone);

    // অতীত পেশা (থাকলে)
    if (d.previousOccupation) setSelect('previous_occupation', d.previousOccupation);

    setChecked(d.militaryOrg ? 'prev_org1' : 'prev_org2', true);
    if (d.militaryOrg && d.militaryDetails) {
      await sleep(200);
      const m = d.militaryDetails;
      setText('previous_organization', m.organization);
      setText('previous_designation', m.designation);
      setText('previous_rank', m.rank);
      setText('previous_posting', m.posting);
    }

    showBadge('✔ Family Details ফিল হয়েছে — চেক করে Save and Continue চাপুন', '#27ae60');
  }

  // ---------- পেজ ৪: Visa Details ----------
  async function fillVisaDetails(d) {
    setText('visa_serreq_id_112', d.placesToVisit);
    setText('visa_serreq_id_334', d.placesToVisit2 || 'NA');

    setText('duration', d.duration);
    setSelect('visa_entry_id', d.entries);
    setText('jouryney_id', d.arrivalDate);
    setSelect('entrypoint', d.entryPoint);
    setSelect('exitpointprc', d.exitPoint);

    if (d.visitedIndiaBefore) {
      setChecked('old_visa_flag1', true);
      await sleep(300);
      const pv = d.prevVisit || {};
      setText('prv_visit_add1', pv.add1);
      setText('prv_visit_add2', pv.add2);
      setText('prv_visit_add3', pv.add3);
      setText('visited_city', pv.cities);
      setText('old_visa_no', pv.visaNo);
      setSelect('old_visa_type_id', pv.visaType || '3');
      setText('oldvisaissueplace', pv.issuePlace);
      setText('oldvisaissuedate', pv.issueDate);
    } else {
      setChecked('old_visa_flag2', true);
    }

    if (d.refusedBefore) {
      setChecked('refuse_flag1', true);
      await sleep(200);
      setText('refuse_details', d.refuseDetails);
    } else {
      setChecked('refuse_flag2', true);
    }

    setChecked(d.saarcVisited ? 'saarc_flag1' : 'saarc_flag2', true);

    setText('country_visited', d.countriesVisited);

    const ri = d.referenceIndia || {};
    setText('nameofsponsor_ind', ri.name);
    setText('add1ofsponsor_ind', ri.add1);
    setText('add2ofsponsor_ind', ri.add2);
    setSelect('stateofsponsor_ind', ri.state);
    await waitAndSetSelect('districtofsponsor_ind', ri.district);
    setText('phoneofsponsor_ind', ri.phone);

    const rb = d.referenceBangladesh || {};
    setText('nameofsponsor_msn', rb.name);
    setText('add1ofsponsor_msn', rb.add1);
    setText('add2ofsponsor_msn', rb.add2);
    setText('phoneofsponsor_msn', rb.phone);

    showBadge('✔ Visa Details ফিল হয়েছে — চেক করে Save and Continue চাপুন', '#27ae60');
  }

  // ---------- পেজ ৫: Additional Questions ----------
  async function fillAdditionalQuestions(d) {
    const qs = d.questions || [false, false, false, false, false, false];
    for (let i = 1; i <= 6; i++) {
      const yes = qs[i - 1];
      setChecked(yes ? `question_yes_${i}` : `question_no_${i}`, true);
    }
    setChecked('verifyQuestions', true);
    showBadge('✔ প্রশ্নগুলো ফিল হয়েছে — চেক করে Save and Continue চাপুন', '#27ae60');
  }

  // ---------- পেজ: Photo Upload / Document Upload (ফাইল অটো বসানো যায় না) ----------
  function notifyManualFile(kind) {
    showBadge(`⚠ ${kind}: ফাইল সিলেক্ট ব্রাউজার সিকিউরিটির কারণে ম্যানুয়ালি করতে হবে`, '#c0392b');
  }

  // ---------- পেজ: Visit Details (Hotel/Stay) ----------
  async function fillHotelDetails(d) {
    const h = d.hotel || {};
    setText('place_of_stay1', h.name);
    setText('pos_address1', h.address);
    setSelect('pos_state_id1', h.state);
    await waitAndSetSelect('pos_dist_id1', h.district);
    setText('pos_phone1', h.phone);
    showBadge('✔ Hotel/Stay তথ্য ফিল হয়েছে — চেক করে Continue চাপুন', '#27ae60');
  }

  // পেজ পাথ অনুযায়ী সঠিক fill ফাংশন বেছে নেওয়া
  function pickFillFn(path) {
    if (path.endsWith('/Registration')) return fillRegistration;
    if (path.endsWith('/BasicDetails')) return fillBasicDetails;
    if (path.endsWith('/FamilyDetails')) return fillFamilyDetails;
    if (path.endsWith('/VisaDetails')) return fillVisaDetails;
    if (path.endsWith('/AdditionalQuestions')) return fillAdditionalQuestions;
    if (path.endsWith('/BangladeshDetails')) return fillHotelDetails;
    return null;
  }

  // ---------- মূল রাউটার: পেজ চিনে সঠিক ফাংশন কল করা ----------
  async function run() {
    chrome.storage.local.get(['ivacData', 'ivacEnabled', 'ivacAutoContinue'], async (res) => {
      if (res.ivacEnabled === false) return; // এক্সটেনশন বন্ধ থাকলে কিছু করবে না
      const data = res.ivacData;
      if (!data) {
        showBadge('⚠ কোনো ডেটা সেভ করা নেই — এক্সটেনশনের আইকনে ক্লিক করে ডেটা সেভ করুন', '#c0392b');
        return;
      }
      const autoContinue = res.ivacAutoContinue === true;

      const path = window.location.pathname;

      // এই পেজগুলোতে CAPTCHA/ফাইল আপলোড/চূড়ান্ত-রিভিউ থাকে,
      // তাই এখানে কখনোই অটো-ক্লিক করা হয় না
      if (path.endsWith('/Registration')) { await fillRegistration(data); return; }
      if (path.endsWith('/PhotoUpload')) { notifyManualFile('Photo Upload'); return; }
      if (path.endsWith('/DocumentUpload')) { notifyManualFile('Document Upload'); return; }
      if (path.endsWith('/ConfirmDetails') || path.toLowerCase().includes('confirm')) {
        showBadge('👀 সব তথ্য ভালোভাবে যাচাই করে তারপর Confirm করুন', '#e67e22');
        return;
      }

      const fillFn = pickFillFn(path);
      if (!fillFn) return; // অচেনা পেজ, কিছু করার নেই

      setAutoConfirm(true);
      try {
        await fillFn(data);

        // ⚠️ যদি "Temporary Application ID" দিয়ে আগের সেভ করা ফর্ম resume করা হয়,
        // তাহলে সাইট নিজে থেকেই AJAX দিয়ে পুরনো ডেটা এনে ফিল্ড রিসেট করে দিতে পারে
        // (আমাদের ফিল করার কিছুক্ষণ পর)। সেটা ঠেকাতে একই ভ্যালু আবার একবার বসানো হচ্ছে।
        await sleep(1200);
        await fillFn(data);

        if (autoContinue) {
          await sleep(500);
          const btn = document.getElementById('continue');
          if (btn) {
            showBadge('➡ অটো-Continue চাপা হচ্ছে...', '#2980b9');
            await sleep(400);
            btn.click();
          } else {
            showBadge('✔ ফিল হয়েছে, কিন্তু Continue বাটন খুঁজে পাওয়া যায়নি', '#e67e22');
          }
        }
      } catch (err) {
        showBadge('✘ এরর হয়েছে, কনসোল দেখুন (F12)', '#c0392b');
        console.error('Ivac Macros error:', err);
      } finally {
        // ফিল শেষে অটো-কনফার্ম বন্ধ করে দেওয়া হচ্ছে, যাতে আসল সাবমিট/Confirm
        // বাটনের কোনো গুরুত্বপূর্ণ সতর্কতা ডায়ালগ চাপা না পড়ে
        setAutoConfirm(false);
      }
    });
  }

  // পেজ সম্পূর্ণ লোড হওয়ার একটু পর চালানো (ড্রপডাউন ইত্যাদি রেডি হওয়ার জন্য)
  if (document.readyState === 'complete') {
    setTimeout(run, 400);
  } else {
    window.addEventListener('load', () => setTimeout(run, 400));
  }
})();
