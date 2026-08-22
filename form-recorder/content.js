// Form Autofill Recorder - content script
// Records values of form fields as the user fills them, keyed per page.
// On "play", restores the recorded values into the same fields.

(() => {
  const STORAGE_PREFIX = "ffr:"; // form-fill-record
  const REC_FLAG = "ffr:recording"; // global recording-mode flag
  let recording = false;
  let banner = null;
  // In-memory copy of this page's recorded fields. All mutations happen
  // here, then the whole object is written to storage — avoids the
  // read-modify-write races of per-field get/set.
  let pageData = {};
  let saveTimer = null;

  // ---------- helpers ----------

  function pageKey() {
    // Key recordings by origin + pathname so query strings / hashes don't
    // split the same form into different recordings.
    return STORAGE_PREFIX + location.origin + location.pathname;
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({ [pageKey()]: pageData });
    }, 200);
  }

  // Build a stable selector for a field. Prefer id, then name, then a
  // structural CSS path as a last resort.
  function fieldSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) {
      const tag = el.tagName.toLowerCase();
      return `${tag}[name="${CSS.escape(el.name)}"]`;
    }
    // structural path
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === node.tagName
        );
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function isRecordable(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "select" || tag === "textarea") return true;
    if (tag !== "input") return false;
    const type = (el.type || "text").toLowerCase();
    // Never record passwords or file inputs.
    return !["password", "file", "submit", "button", "reset", "image", "hidden"].includes(type);
  }

  function fieldEntry(el) {
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? (el.type || "text").toLowerCase() : tag;
    const entry = { selector: fieldSelector(el), type };
    if (type === "checkbox" || type === "radio") {
      entry.checked = el.checked;
      // radio groups share name; selector must include value to hit right one
      if (type === "radio" && el.name) {
        entry.selector = `input[type="radio"][name="${CSS.escape(el.name)}"][value="${CSS.escape(el.value)}"]`;
      }
    } else {
      entry.value = el.value;
    }
    return entry;
  }

  // ---------- recording ----------

  function saveField(el) {
    if (!isRecordable(el)) return;
    const entry = fieldEntry(el);
    pageData[entry.selector] = entry;
    persist();
  }

  function onInput(e) {
    if (!recording) return;
    saveField(e.target);
  }

  function captureAllFields() {
    // Snapshot everything currently filled, so fields typed before pressing
    // Record (or filled by the site itself) are captured too.
    document.querySelectorAll("input, select, textarea").forEach((el) => {
      if (!isRecordable(el)) return;
      const type = (el.type || "").toLowerCase();
      const hasValue =
        type === "checkbox" || type === "radio" ? el.checked : el.value !== "";
      if (hasValue) saveField(el);
    });
  }

  // ---------- playback ----------

  function setNativeValue(el, value) {
    // React/Vue-friendly value setting: use the native setter, then fire events.
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // খোলা jQuery-UI datepicker বন্ধ করা: focus সরানো + বাইরে mousedown (outside-click) + hide
  function closeDatepickers() {
    try {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      document.querySelectorAll("input.hasDatepicker").forEach((el) => el.blur && el.blur());
      document.body && document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      document.querySelectorAll("#ui-datepicker-div").forEach((d) => { d.style.display = "none"; });
    } catch (_) { /* ignore */ }
  }

  // <select> এর জন্য: option value মিললে value দিয়ে, নাহলে দৃশ্যমান লেখা দিয়ে মেলায়।
  // মিলিয়ে সেট করতে পারলে true; option এখনো না এলে (dependent dropdown) false।
  function setSelectSmart(el, value) {
    if (value == null || value === "") return false;
    const v = String(value);
    const opts = Array.from(el.options);
    let opt =
      opts.find((o) => o.value === v) ||
      opts.find((o) => o.value.toUpperCase() === v.toUpperCase()) ||
      opts.find((o) => (o.textContent || "").trim().toUpperCase() === v.toUpperCase());
    if (!opt) return false;
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value === opt.value;
  }

  // While auto-filling, mark the document so injected.js (running in the
  // page's world) auto-answers alert/confirm dialogs with OK.
  let autoModeTimer = null;
  function autoModeOn(ms) {
    document.documentElement.setAttribute("data-ffr-auto", "1");
    clearTimeout(autoModeTimer);
    autoModeTimer = setTimeout(() => {
      document.documentElement.removeAttribute("data-ffr-auto");
    }, ms);
  }

  async function play() {
    autoModeOn(10000);
    const key = pageKey();
    const data = (await chrome.storage.local.get(key))[key];
    if (!data || Object.keys(data).length === 0) {
      return { filled: 0, total: 0 };
    }
    let filled = 0;
    const entries = Object.values(data);
    const selectEntries = []; // সব <select> — শেষে স্থিরতার জন্য নজরে রাখব
    for (const entry of entries) {
      let el = null;
      try {
        el = document.querySelector(entry.selector);
      } catch (_) {
        /* bad selector, skip */
      }
      if (!el) continue;
      if (entry.type === "checkbox" || entry.type === "radio") {
        if (el.checked !== entry.checked) el.click();
        filled++;
      } else if (entry.type === "select") {
        setSelectSmart(el, entry.value);
        selectEntries.push(entry); // পরে monitor করব
      } else {
        // date ঘরে focus করলে datepicker খুলে যায় — তাই focus ছাড়াই মান বসাই
        setNativeValue(el, entry.value);
        if (el.classList && el.classList.contains("hasDatepicker") && el.blur) el.blur();
        filled++;
      }
    }

    // সব <select> নজরে রাখি: State→District এর মতো dependent dropdown-এর option
    // দেরিতে আসে, আবার State-এর AJAX আগে-বসানো District কে পরে খালি/বদলে দিতে পারে।
    // তাই মান রেকর্ড-করা মানের সাথে না মিললে আবার বসাই; সব ঠিকমতো কয়েক সেকেন্ড
    // স্থির থাকলে তবেই থামি।
    for (let attempt = 0; attempt < 16; attempt++) {
      await sleep(500);

      // কোনো select এখনো না মিললে ও option না এলে — সম্ভাব্য parent (State) এর change
      // আবার fire করি (fetchDistrict AJAX-এর জন্য)। spam এড়াতে প্রতি ৪ বারে একবার।
      if (attempt % 4 === 0) {
        const stuck = selectEntries.some((e) => {
          try { const el = document.querySelector(e.selector); return el && el.value.toUpperCase() !== String(e.value).toUpperCase() && el.options.length <= 1; } catch (_) { return false; }
        });
        if (stuck) {
          document.querySelectorAll('select').forEach((s) => {
            if (s.value && s.options.length > 1) s.dispatchEvent(new Event('change', { bubbles: true }));
          });
          await sleep(300);
        }
      }

      let allStable = true;
      for (const entry of selectEntries) {
        let el = null;
        try { el = document.querySelector(entry.selector); } catch (_) { /* skip */ }
        if (!el) continue;
        const cur = (el.value || '').toUpperCase();
        const want = String(entry.value).toUpperCase();
        if (cur === want) { entry._ok = (entry._ok || 0) + 1; if (entry._ok < 4) allStable = false; } // ~2s স্থির
        else {
          entry._miss = (entry._miss || 0) + 1;
          if (entry._miss <= 10) { setSelectSmart(el, entry.value); allStable = false; } // ১০ বার চেষ্টা, তারপর ছেড়ে দিই (আর ব্লক করে না)
        }
      }
      if (allStable) break;
    }
    for (const entry of selectEntries) {
      try { const el = document.querySelector(entry.selector); if (el && (el.value || '').toUpperCase() === String(entry.value).toUpperCase()) filled++; } catch (_) { /* skip */ }
    }

    // খোলা jQuery-UI datepicker জোর করে বন্ধ করি: focus সরাই + বাইরে click + hide
    closeDatepickers();

    applyForcedRules();
    flashBanner(`✅ ${filled}/${entries.length} টি ফিল্ড পূরণ হয়েছে`);
    return { filled, total: entries.length };
  }

  // ---------- forced rules ----------
  // Questions that must always get a fixed answer regardless of what was
  // recorded, e.g. the "Pakistan nationals / Pakistan held area" radio on
  // the Indian visa form must always be "No".

  const FORCED_RULES = [{ question: /pakistan/i, answer: /^no?$/i }];

  function applyForcedRules() {
    const groups = {};
    document.querySelectorAll('input[type="radio"]').forEach((r) => {
      const key = r.name || fieldSelector(r);
      (groups[key] = groups[key] || []).push(r);
    });
    for (const radios of Object.values(groups)) {
      const context = radios[0].closest("tr, li, p, div");
      const text = context ? context.textContent : "";
      for (const rule of FORCED_RULES) {
        if (!rule.question.test(text)) continue;
        const target = radios.find((r) => {
          if (rule.answer.test(r.value)) return true;
          const label =
            (r.labels && r.labels[0] && r.labels[0].textContent) ||
            (r.nextSibling && r.nextSibling.textContent) ||
            "";
          return rule.answer.test(label.trim());
        });
        if (target && !target.checked) target.click();
      }
    }
  }

  // ---------- autopilot ----------
  // One "Play (Auto)" press fills the page, forces the fixed answers,
  // clicks "Save and Continue", and repeats on each following page until a
  // page with no recording is reached.

  const AUTO_FLAG = "ffr:autopilot";
  const AUTO_TRIES = "ffr:autotries:"; // per-page attempt counter

  function findContinueButton() {
    const candidates = document.querySelectorAll(
      'input[type="submit"], input[type="button"], button, a'
    );
    for (const el of candidates) {
      const label = (el.value || el.textContent || "").trim();
      if (/save\s*(and|&)?\s*continue/i.test(label)) return el;
      if (/^continue$/i.test(label)) return el;
    }
    return null;
  }

  async function stopAutopilot() {
    await chrome.storage.local.remove(AUTO_FLAG);
  }

  async function autopilotStep() {
    // Loop guard: if validation keeps us on the same page, don't retry
    // forever.
    const triesKey = AUTO_TRIES + pageKey();
    const tries = (await chrome.storage.local.get(triesKey))[triesKey] || 0;
    if (tries >= 2) {
      await stopAutopilot();
      flashBanner("⚠️ এই page-এ আটকে গেছে — Autopilot বন্ধ হলো। বাকিটা হাতে দেখুন।");
      return;
    }
    await chrome.storage.local.set({ [triesKey]: tries + 1 });

    const res = await play();
    if (res.total === 0) {
      await stopAutopilot();
      flashBanner("🏁 Autopilot শেষ — এই page-এর কোনো recording নেই।");
      return;
    }
    // Give the page's own scripts (cascading dropdowns etc.) a moment.
    setTimeout(() => {
      const btn = findContinueButton();
      if (btn) {
        flashBanner("▶▶ Save and Continue চাপা হচ্ছে…");
        btn.click();
      } else {
        stopAutopilot();
        flashBanner("⚠️ 'Save and Continue' বাটন পাওয়া যায়নি — Autopilot বন্ধ হলো।");
      }
    }, 1500);
  }

  async function startAutopilot() {
    // Reset per-page attempt counters from any previous run.
    const all = await chrome.storage.local.get(null);
    const stale = Object.keys(all).filter((k) => k.startsWith(AUTO_TRIES));
    if (stale.length) await chrome.storage.local.remove(stale);
    await chrome.storage.local.set({ [AUTO_FLAG]: true });
    autopilotStep();
  }

  // ---------- UI banner ----------

  function showRecordingBanner() {
    if (banner) return;
    banner = document.createElement("div");
    banner.textContent = "⏺ Recording form entries…";
    Object.assign(banner.style, {
      position: "fixed",
      top: "8px",
      right: "8px",
      zIndex: 2147483647,
      background: "#d32f2f",
      color: "#fff",
      padding: "6px 12px",
      borderRadius: "6px",
      font: "13px/1.4 sans-serif",
      boxShadow: "0 2px 8px rgba(0,0,0,.3)",
    });
    document.documentElement.appendChild(banner);
  }

  function hideRecordingBanner() {
    if (banner) {
      banner.remove();
      banner = null;
    }
  }

  function flashBanner(text) {
    const b = document.createElement("div");
    b.textContent = text;
    Object.assign(b.style, {
      position: "fixed",
      top: "8px",
      right: "8px",
      zIndex: 2147483647,
      background: "#2e7d32",
      color: "#fff",
      padding: "6px 12px",
      borderRadius: "6px",
      font: "13px/1.4 sans-serif",
      boxShadow: "0 2px 8px rgba(0,0,0,.3)",
    });
    document.documentElement.appendChild(b);
    setTimeout(() => b.remove(), 2500);
  }

  // ---------- state ----------
  // The recording flag lives in chrome.storage.local (content scripts can't
  // use chrome.storage.session without extra setup), so recording mode
  // survives navigation and all pages of a multi-step form can be recorded
  // in one session.

  function startRecording() {
    recording = true;
    showRecordingBanner();
    captureAllFields();
    chrome.storage.local.set({ [REC_FLAG]: true });
  }

  function stopRecording() {
    recording = false;
    hideRecordingBanner();
    chrome.storage.local.remove(REC_FLAG);
  }

  // ---------- init ----------

  chrome.storage.local.get([REC_FLAG, AUTO_FLAG, pageKey()]).then((r) => {
    pageData = r[pageKey()] || {};
    if (r[REC_FLAG]) {
      recording = true;
      showRecordingBanner();
      // Capture fields the site pre-filled on this page load.
      captureAllFields();
    }
    if (r[AUTO_FLAG] && window === window.top) {
      // Autopilot in progress: continue on this page after it settles.
      setTimeout(autopilotStep, 1500);
    }
  });

  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onInput, true);

  // ---------- messages from popup ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.cmd) {
          case "start":
            startRecording();
            sendResponse({ ok: true });
            break;
          case "stop":
            stopRecording();
            await stopAutopilot();
            sendResponse({ ok: true });
            break;
          case "play": {
            const res = await play();
            sendResponse({ ok: true, ...res });
            break;
          }
          case "playAll":
            await startAutopilot();
            sendResponse({ ok: true });
            break;
          case "stopAuto":
            await stopAutopilot();
            flashBanner("⏹ Autopilot বন্ধ করা হয়েছে");
            sendResponse({ ok: true });
            break;
          case "status":
            sendResponse({
              ok: true,
              recording,
              savedCount: Object.keys(pageData).length,
            });
            break;
          case "clear": {
            pageData = {};
            clearTimeout(saveTimer);
            await chrome.storage.local.remove(pageKey());
            sendResponse({ ok: true });
            break;
          }
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // async response
  });
})();
