// IVAC Session Login — popup logic.
//
// Two modes:
//   Auto  — fetch the bot's /api/sessionList, then /api/sessionSnippet?id=X,
//           and inject the returned auth-storage blob into the active IVAC tab.
//   Paste — take a blob the user pasted (copied from the dashboard "Copy
//           Session" button) and inject it.
//
// Injection is done with chrome.scripting.executeScript into the active tab,
// which must be on appointment.ivacbd.com. Nothing is sent anywhere except the
// bot (Auto mode) — the blob is written straight into the page's localStorage.

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

// Remember which account this browser was logged into, so the on-page badge
// (content.js) can show the name until logout.
function setActiveAccount(acc) {
  try { chrome.storage.local.set({ activeAccount: acc || {} }); } catch (_) {}
}

function setStatus(msg, kind) {
  statusEl.textContent = msg || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["botUrl", "extKey"], (v) => {
      resolve({
        botUrl: (v.botUrl || "http://localhost:8080").replace(/\/+$/, ""),
        extKey: v.extKey || "",
      });
    });
  });
}

// ---- tab switching ----
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".pane").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $("pane-" + t.dataset.pane).classList.add("active");
    setStatus("");
    if (t.dataset.pane === "auto") loadList();
  });
});

// ---- inject a blob into the active IVAC tab ----
async function injectBlob(blob) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    setStatus("No active tab.", "err");
    return;
  }
  if (!/^https:\/\/appointment\.ivacbd\.com/.test(tab.url || "")) {
    setStatus("প্রথমে appointment.ivacbd.com খুলুন, তারপর আবার চেষ্টা করুন।", "err");
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [blob],
      func: (b) => {
        localStorage.setItem("auth-storage", b);
        location.reload();
      },
    });
    setStatus("✅ Logged in — page reloading…", "ok");
  } catch (e) {
    setStatus("Inject failed: " + e.message, "err");
  }
}

// ---- AUTO mode ----
async function loadList() {
  const listEl = $("list");
  listEl.innerHTML = '<div class="empty">Loading…</div>';
  const { botUrl, extKey } = await getSettings();
  if (!extKey) {
    listEl.innerHTML = '<div class="empty">⚙️ Settings-এ key দিন (Auto mode-এর জন্য)।</div>';
    return;
  }
  try {
    const res = await fetch(botUrl + "/api/sessionList", {
      headers: { "X-Ext-Key": extKey },
    });
    if (res.status === 403) {
      listEl.innerHTML = '<div class="empty">❌ Key ভুল। Settings দেখুন।</div>';
      return;
    }
    if (!res.ok) {
      listEl.innerHTML = '<div class="empty">Bot সাড়া দিচ্ছে না (' + res.status + ").</div>";
      return;
    }
    const data = await res.json();
    const rows = (data && data.instances) || [];
    if (!rows.length) {
      listEl.innerHTML = '<div class="empty">কোনো logged-in instance নেই।</div>';
      return;
    }
    listEl.innerHTML = "";
    rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "row";
      const mins = Math.max(0, Math.floor((r.expiresIn || 0) / 60));
      const secs = Math.max(0, (r.expiresIn || 0) % 60);
      const meta = document.createElement("div");
      meta.className = "meta";
      const nm = document.createElement("div");
      nm.className = "name";
      nm.textContent = "#" + r.id + " · " + (r.name || "");
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = (r.phone || "") + " · ⏳ " + mins + "m " + secs + "s";
      meta.appendChild(nm);
      meta.appendChild(sub);
      if (r.ip) {
        const ipc = document.createElement("span");
        ipc.className = "ipchip";
        ipc.textContent = "🌐 " + r.ip;
        meta.appendChild(ipc);
      }
      const btn = document.createElement("button");
      btn.className = "login";
      btn.textContent = "Login";
      if ((r.expiresIn || 0) <= 0) {
        btn.disabled = true;
        btn.textContent = "Expired";
      }
      btn.addEventListener("click", () => loginById(r.id, botUrl, extKey));
      row.appendChild(meta);
      row.appendChild(btn);
      listEl.appendChild(row);
    });
  } catch (e) {
    listEl.innerHTML = '<div class="empty">Bot-এ পৌঁছানো গেল না। Settings-এ URL দেখুন।</div>';
  }
}

async function loginById(id, botUrl, extKey) {
  setStatus("Fetching session…");
  try {
    const res = await fetch(botUrl + "/api/sessionSnippet?id=" + encodeURIComponent(id), {
      headers: { "X-Ext-Key": extKey },
    });
    if (!res.ok) {
      setStatus("Could not fetch session (" + res.status + ").", "err");
      return;
    }
    const data = await res.json();
    if (!data.authStorage) {
      setStatus("No session blob returned.", "err");
      return;
    }
    // Pin this browser to the instance's IP FIRST (so the reloaded page loads
    // through it), then inject the session. The session is bound to that IP.
    if (data.proxy && data.proxy.host) {
      setStatus("Connecting to " + (data.proxy.label || data.proxy.host) + " …");
      const r = await chrome.runtime.sendMessage({ type: "connectProxy", proxy: data.proxy });
      if (!r || !r.ok) {
        setStatus("Proxy connect failed: " + ((r && r.error) || "unknown") +
          " — disable any other proxy extension, then retry.", "err");
        return;
      }
      startIpWatch(data.proxy);
    } else {
      stopIpWatch();
      setStatus("⚠ এই instance-এ proxy নেই — direct connection-এ login হচ্ছে।", "err");
    }
    setActiveAccount({
      name: data.name || "",
      phone: data.phone || "",
      ip: (data.proxy && data.proxy.label) || "",
    });
    await injectBlob(data.authStorage);
  } catch (e) {
    setStatus("Error: " + e.message, "err");
  }
}

// ---- Pinned-IP banner: blink red until the browser egress IP == target ----
let _ipTimer = null;

function stopIpWatch() {
  if (_ipTimer) { clearInterval(_ipTimer); _ipTimer = null; }
  $("ipBanner").classList.add("hidden");
}

function startIpWatch(proxy) {
  const target = proxy.host;
  const banner = $("ipBanner");
  banner.classList.remove("hidden");
  $("ipTarget").textContent = proxy.label || target;
  $("ipDisconnect").classList.remove("hidden");
  banner.classList.remove("ok");
  banner.classList.add("wrong");
  $("ipNow").textContent = "এখন: যাচাই হচ্ছে…";

  const check = async () => {
    let now = "";
    try {
      const r = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
      now = (await r.json()).ip || "";
    } catch (_) { now = ""; }
    if (now && now === target) {
      banner.classList.remove("wrong");
      banner.classList.add("ok");
      $("ipNow").textContent = "✅ এখন: " + now + " — মিলে গেছে, session stable";
      setStatus("✅ IP মিলেছে — logged in.", "ok");
    } else {
      banner.classList.remove("ok");
      banner.classList.add("wrong");
      $("ipNow").textContent = now ? ("⚠ এখন: " + now + " — এখনো মেলেনি") : "⚠ IP যাচাই করা যাচ্ছে না";
    }
  };
  check();
  if (_ipTimer) clearInterval(_ipTimer);
  _ipTimer = setInterval(check, 3000);
}

$("ipDisconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "disconnectProxy" });
  stopIpWatch();
  setStatus("Proxy disconnected.", "ok");
});

// ---- PASTE mode ----
$("pasteLogin").addEventListener("click", async () => {
  let raw = $("pasteBox").value.trim();
  if (!raw) {
    setStatus("প্রথমে session paste করুন।", "err");
    return;
  }
  // Accept either the raw auth-storage JSON, or a full snippet the dashboard
  // copied (localStorage.setItem('auth-storage', "...."); location.reload();).
  const blob = extractBlob(raw);
  if (!blob) {
    setStatus("এটা valid session নয়। আবার copy করুন।", "err");
    return;
  }
  // Paste mode has no instance name — show the phone from the blob on the badge.
  let phone = "";
  try { phone = (JSON.parse(blob).state || {}).phone || ""; } catch (_) {}
  setActiveAccount({ name: "", phone: phone, ip: "" });
  await injectBlob(blob);
});

// extractBlob pulls the auth-storage value out of whatever was pasted.
function extractBlob(raw) {
  // Case 1: a full snippet. Grab the first quoted argument to setItem.
  const m = raw.match(/setItem\(\s*['"]auth-storage['"]\s*,\s*('|")([\s\S]*?)\1\s*\)/);
  if (m) {
    try {
      // m[2] is a JS/JSON string literal body; re-wrap and parse to unescape.
      const q = m[1];
      return JSON.parse(q === "'" ? '"' + m[2].replace(/"/g, '\\"') + '"' : q + m[2] + q);
    } catch (_) {
      /* fall through */
    }
  }
  // Case 2: raw JSON blob (starts with { and parses, has state.token).
  try {
    const obj = JSON.parse(raw);
    if (obj && obj.state && obj.state.token) return raw;
  } catch (_) {
    /* not json */
  }
  return null;
}

// ---- settings ----
async function initSettings() {
  const s = await getSettings();
  $("botUrl").value = s.botUrl;
  $("extKey").value = s.extKey;
}
$("saveSettings").addEventListener("click", () => {
  const botUrl = $("botUrl").value.trim() || "http://localhost:8080";
  const extKey = $("extKey").value.trim();
  chrome.storage.local.set({ botUrl, extKey }, () => {
    setStatus("💾 Settings saved.", "ok");
    loadList();
  });
});
$("refresh").addEventListener("click", loadList);

// ---- boot ----
initSettings().then(loadList);
