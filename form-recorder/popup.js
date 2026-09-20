const statusEl = document.getElementById("status");
const btnRecord = document.getElementById("record");
const btnStop = document.getElementById("stop");
const btnPlay = document.getElementById("play");
const btnClear = document.getElementById("clear");

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(cmd) {
  const tab = await activeTab();
  try {
    return await chrome.tabs.sendMessage(tab.id, { cmd });
  } catch (e) {
    statusEl.textContent =
      "এই page-এ কাজ করছে না। Page reload করে আবার চেষ্টা করুন।";
    return null;
  }
}

function render(st) {
  if (!st) return;
  btnRecord.disabled = st.recording;
  btnStop.disabled = !st.recording;
  const parts = [];
  if (st.recording) parts.push("⏺ Recording চলছে…");
  parts.push(`এই page-এ ${st.savedCount} টি ফিল্ড save করা আছে`);
  statusEl.textContent = parts.join(" | ");
}

async function refresh() {
  render(await send("status"));
}

btnRecord.addEventListener("click", async () => {
  await send("start");
  refresh();
});

btnStop.addEventListener("click", async () => {
  await send("stop");
  refresh();
});

btnPlay.addEventListener("click", async () => {
  const res = await send("play");
  if (res) {
    statusEl.textContent =
      res.total === 0
        ? "এই page-এর কোনো recording নেই। আগে Record করুন।"
        : `✅ ${res.filled}/${res.total} টি ফিল্ড পূরণ হয়েছে`;
  }
});

document.getElementById("playall").addEventListener("click", async () => {
  const res = await send("playAll");
  if (res) {
    statusEl.textContent =
      "▶▶ Autopilot চলছে — নিজে নিজে fill করে Save and Continue চাপবে…";
  }
});

document.getElementById("stopauto").addEventListener("click", async () => {
  await send("stopAuto");
  statusEl.textContent = "Autopilot বন্ধ করা হয়েছে।";
});

btnClear.addEventListener("click", async () => {
  await send("clear");
  refresh();
});

// Clean All: wipe every page's saved record in one click. Works directly on
// storage (no content script needed), so it clears records for all sites at
// once. Keeps the recording/autopilot state flags untouched.
document.getElementById("cleanall").addEventListener("click", async () => {
  const STATE = ["ffr:recording", "ffr:autopilot"];
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(
    (k) => k.startsWith("ffr:") && !STATE.includes(k) && !k.startsWith("ffr:autotries:")
  );
  if (keys.length === 0) {
    statusEl.textContent = "মোছার মতো কোনো record নেই।";
    return;
  }
  if (!confirm(`সব page মিলিয়ে ${keys.length} টি page-এর record মুছে ফেলা হবে। নিশ্চিত?`)) return;
  await chrome.storage.local.remove(keys);
  statusEl.textContent = `🧹 ${keys.length} টি page-এর record মুছে ফেলা হয়েছে।`;
});

// এক ক্লিকে সব খোলা ট্যাবের বর্তমানে-ভরা ঘরগুলো record করে (প্রতি ট্যাব তার নিজের page-key তে)
document.getElementById("recordall").addEventListener("click", async () => {
  statusEl.textContent = "⏳ সব ট্যাব record হচ্ছে...";
  const tabs = await chrome.tabs.query({});
  let okTabs = 0, totalFields = 0;
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) return;
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { cmd: "snapshotAll" });
        if (res && res.ok && res.count > 0) { okTabs++; totalFields += res.count; }
      } catch (_) { /* এই ট্যাবে content script নেই — বাদ */ }
    })
  );
  statusEl.textContent = okTabs
    ? `⏺⏺ ${okTabs} টি ট্যাব record হয়েছে (মোট ${totalFields} টি ফিল্ড)।`
    : "কোনো ট্যাবে ভরা ফর্ম পাওয়া যায়নি।";
});

refresh();
