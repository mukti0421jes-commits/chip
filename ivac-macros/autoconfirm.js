/* ===================================================================
   Ivac Macros — autoconfirm.js (MAIN world)
   পেজের নিজস্ব JavaScript confirm()/alert() ডায়ালগ (যেমন গ্র্যান্ডপ্যারেন্ট
   পাকিস্তান প্রশ্নের নোটিশ) অটো-ফিল করার সময় নিজে থেকে "OK" চাপার জন্য।
   =================================================================== */

(function () {
  'use strict';

  let autoConfirmEnabled = false;

  const originalConfirm = window.confirm.bind(window);
  const originalAlert = window.alert.bind(window);

  window.confirm = function (message) {
    if (autoConfirmEnabled) {
      console.log('[Ivac Macros] confirm() অটো-accept করা হলো:', message);
      return true; // সবসময় "OK" ধরে নেওয়া হচ্ছে
    }
    return originalConfirm(message);
  };

  window.alert = function (message) {
    if (autoConfirmEnabled) {
      console.log('[Ivac Macros] alert() অটো-dismiss করা হলো:', message);
      return; // কিছু না দেখিয়ে এগিয়ে যাওয়া
    }
    return originalAlert(message);
  };

  // isolated world (content.js) থেকে পাঠানো ইভেন্ট শুনে ফ্ল্যাগ অন/অফ করা
  document.addEventListener('ivac-macros-autoconfirm', function (e) {
    autoConfirmEnabled = !!(e.detail && e.detail.enabled);
  });
})();
