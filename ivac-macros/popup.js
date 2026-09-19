const dataBox = document.getElementById('dataBox');
const saveBtn = document.getElementById('saveBtn');
const loadSampleBtn = document.getElementById('loadSampleBtn');
const enableToggle = document.getElementById('enableToggle');
const autoContinueToggle = document.getElementById('autoContinueToggle');
const statusEl = document.getElementById('status');

const SAMPLE_DATA = {
  country: "BGD",
  mission: "BGDD",
  nationality: "BGD",
  dob: "31/12/2012",
  email: "example@gmail.com",
  arrivalDate: "30/09/2026",
  purposeValue: "544",

  surname: "BISWAS",
  givenName: "PROSHAN",
  gender: "M",
  birthPlace: "JASHORE",
  birthCountry: "BGD",
  nicNumber: "2012411097XXXXXXX",
  religion: "HINDU",
  identityMarks: "NILL",
  education: "BELOW MATRICULATION",
  nationalityBy: "BY BIRTH",
  passportNo: "A08981765",
  passportIssuePlace: "DHAKA",
  passportIssueDate: "14/10/2024",
  passportExpiryDate: "13/10/2029",
  hasOtherPassport: false,
  otherPassport: { countryIssue: "BGD", passportNumber: "", issueDate: "", issuePlace: "", nationality: "BGD" },

  presentAddress1: "SREERAMPUR, BAGHERPARA,",
  presentAddress2: "NARIKELBARIA - 7470,",
  presentState: "JASHORE",
  pincode: "7470",
  presentPhone: "01710876165",
  isdCode: "880",
  mobile: "1710876165",
  sameAddress: true,

  fatherName: "DALIM KUMAR BISWAS",
  fatherNationality: "BGD",
  fatherBirthPlace: "JASHORE",
  fatherBirthCountry: "BGD",
  motherName: "SWEETY BISWAS",
  motherNationality: "BGD",
  motherBirthPlace: "NARAIL",
  motherBirthCountry: "BGD",
  maritalStatus: "1",
  grandparentPakistan: false,

  occupation: "STUDENT",
  occupationOf: "F",
  employerName: "SREERAMPUR SECONDARY SCHOOL",
  employerDesignation: "STUDENT",
  employerAddress: "SREERAMPUR, BAGHERPARA,NARIKELBARIA -",
  employerPhone: "01711363719",
  previousOccupation: "",
  militaryOrg: false,
  militaryDetails: { organization: "", designation: "", rank: "", posting: "" },

  // নাম পরিবর্তন হলে: changedName=true দিন
  changedName: false,
  prevSurname: "",
  prevGivenName: "",
  prevNationality: "",
  fatherPrevNationality: "",
  motherPrevNationality: "",
  grandparentDetails: "",

  // বিবাহিত (maritalStatus "0") হলে spouse পূরণ হবে
  spouse: { name: "", nationality: "BGD", prevNationality: "", birthPlace: "", birthCountry: "BGD" },

  placesToVisit: "KISHOR BISWAS RESIDENCE",
  placesToVisit2: "NA",
  duration: "12",
  entries: "1",
  entryPoint: "BY AIR",
  exitPoint: "BY AIR",
  visitedIndiaBefore: false,
  prevVisit: { add1: "", add2: "", add3: "", cities: "", visaNo: "", visaType: "3", issuePlace: "", issueDate: "" },
  refusedBefore: false,
  refuseDetails: "",
  saarcVisited: false,
  countriesVisited: "INDIA",

  referenceIndia: { name: "", add1: "", add2: "", state: "WEST BENGAL", district: "NADIA", phone: "" },
  referenceBangladesh: { name: "", add1: "", add2: "", phone: "" },

  questions: [false, false, false, false, false, false],

  hotel: { name: "KISHOR BISWAS RESIDENCE", address: "VILL RAGHABALLAV KATI", state: "WEST BENGAL", district: "NADIA", phone: "91959356197" }
};

function showStatus(msg, ok = true) {
  statusEl.textContent = msg;
  statusEl.className = ok ? 'ok' : 'err';
  setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

// লোড হওয়ার সময় আগের সেভ করা ডেটা এবং টগল স্টেট দেখাও
chrome.storage.local.get(['ivacData', 'ivacEnabled', 'ivacAutoContinue'], (res) => {
  if (res.ivacData) {
    dataBox.value = JSON.stringify(res.ivacData, null, 2);
  } else {
    dataBox.value = JSON.stringify(SAMPLE_DATA, null, 2);
  }
  enableToggle.checked = res.ivacEnabled !== false; // ডিফল্ট: চালু
  autoContinueToggle.checked = res.ivacAutoContinue === true; // ডিফল্ট: বন্ধ
});

saveBtn.addEventListener('click', () => {
  try {
    const parsed = JSON.parse(dataBox.value);
    chrome.storage.local.set({ ivacData: parsed }, () => {
      showStatus('✔ সেভ হয়েছে। এখন ফর্ম পেজ রিলোড করুন।', true);
    });
  } catch (e) {
    showStatus('✘ JSON ফরম্যাট ভুল: ' + e.message, false);
  }
});

loadSampleBtn.addEventListener('click', () => {
  dataBox.value = JSON.stringify(SAMPLE_DATA, null, 2);
});

enableToggle.addEventListener('change', () => {
  chrome.storage.local.set({ ivacEnabled: enableToggle.checked }, () => {
    showStatus(enableToggle.checked ? 'অটো-ফিল চালু করা হলো' : 'অটো-ফিল বন্ধ করা হলো', true);
  });
});

autoContinueToggle.addEventListener('change', () => {
  chrome.storage.local.set({ ivacAutoContinue: autoContinueToggle.checked }, () => {
    showStatus(autoContinueToggle.checked ? 'অটো-Continue চালু করা হলো' : 'অটো-Continue বন্ধ করা হলো', true);
  });
});
