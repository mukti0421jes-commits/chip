// Form Autofill Recorder - content script
// Records values of form fields as the user fills them, keyed per page.
// On "play", restores the recorded values into the same fields.

(() => {
  const STORAGE_PREFIX = "ffr:"; // form-fill-record
  let recording = false;
  let banner = null;

  // ---------- helpers ----------

  function pageKey() {
    // Key recordings by origin + pathname so query strings / hashes don't
    // split the same form into different recordings.
    return STORAGE_PREFIX + location.origin + location.pathname;
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

  async function saveField(el) {
    if (!isRecordable(el)) return;
    const key = pageKey();
    const data = (await chrome.storage.local.get(key))[key] || {};
    const entry = fieldEntry(el);
    data[entry.selector] = entry;
    await chrome.storage.local.set({ [key]: data });
  }

  function onInput(e) {
    if (!recording) return;
    saveField(e.target);
  }

  function captureAllFields() {
    // Snapshot everything currently filled, so fields typed before pressing
    // Record (or autofilled by the browser) are captured too.
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

  async function play() {
    const key = pageKey();
    const data = (await chrome.storage.local.get(key))[key];
    if (!data || Object.keys(data).length === 0) {
      return { filled: 0, total: 0 };
    }
    let filled = 0;
    const entries = Object.values(data);
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
        setNativeValue(el, entry.value);
        filled++;
      } else {
        el.focus();
        setNativeValue(el, entry.value);
        filled++;
      }
    }
    flashBanner(`✅ ${filled}/${entries.length} টি ফিল্ড পূরণ হয়েছে`);
    return { filled, total: entries.length };
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

  // ---------- state persistence across page loads ----------
  // Recording mode survives navigation (so all 3 pages can be recorded in
  // one session) via a session flag.

  const REC_FLAG = "ffr:recording";

  async function startRecording() {
    recording = true;
    await chrome.storage.session.set({ [REC_FLAG]: true });
    showRecordingBanner();
    captureAllFields();
  }

  async function stopRecording() {
    recording = false;
    await chrome.storage.session.remove(REC_FLAG);
    hideRecordingBanner();
  }

  chrome.storage.session.get(REC_FLAG).then((r) => {
    if (r[REC_FLAG]) {
      recording = true;
      showRecordingBanner();
    }
  });

  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onInput, true);

  // ---------- messages from popup ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.cmd) {
        case "start":
          await startRecording();
          sendResponse({ ok: true });
          break;
        case "stop":
          await stopRecording();
          sendResponse({ ok: true });
          break;
        case "play": {
          const res = await play();
          sendResponse({ ok: true, ...res });
          break;
        }
        case "status": {
          const key = pageKey();
          const data = (await chrome.storage.local.get(key))[key] || {};
          sendResponse({
            ok: true,
            recording,
            savedCount: Object.keys(data).length,
          });
          break;
        }
        case "clear": {
          await chrome.storage.local.remove(pageKey());
          sendResponse({ ok: true });
          break;
        }
      }
    })();
    return true; // async response
  });
})();
