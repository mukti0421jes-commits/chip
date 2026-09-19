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

  // MAIN-world কাজ: chosen (Purpose) dropdown আপডেট + datepicker বন্ধ —
  // পেজের নিজের jQuery দিয়ে (content script isolated world থেকে যা করা যায় না)
  document.addEventListener('vafill-main', function (e) {
    var d = (e && e.detail) || {};
    var $ = window.jQuery || window.$;
    try {
      if ($) {
        // Purpose (chosen) — কোড থাকলে সরাসরি; নাহলে dropdown-এর লেখা মিলিয়ে কোড বের করি
        var code = d.purpose || '';
        if (!code && d.purposeText) {
          var want = String(d.purposeText).toUpperCase().replace(/\s+/g, ' ').trim();
          var opts = document.querySelectorAll('#visaPurposeDropdown option');
          var best = '';
          for (var i = 0; i < opts.length; i++) {
            var t = (opts[i].textContent || '').toUpperCase().replace(/\s+/g, ' ').trim();
            if (!opts[i].value) continue;
            if (t === want) { best = opts[i].value; break; }                       // হুবহু মিল
            if (!best && (t.indexOf(want) >= 0 || want.indexOf(t) >= 0)) best = opts[i].value; // আংশিক মিল
          }
          code = best;
        }
        if (code) {
          $('#visaPurposeDropdown').val(code).trigger('chosen:updated');
          $('#visaPurposeDropdown').trigger('change');
          if (typeof window.visit_purpose === 'function') { try { window.visit_purpose(code); } catch (_) {} }
        }
        // options AJAX-এ এলে chosen যাতে সেগুলো দেখায় / খোলে
        $('.chosen-select').trigger('chosen:updated');
        // খোলা datepicker বন্ধ
        try { $('.hasDatepicker').datepicker('hide'); } catch (_) {}
        $('#ui-datepicker-div').hide();
      }
    } catch (_) {}
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  });
})();
