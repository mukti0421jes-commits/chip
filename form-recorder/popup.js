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

refresh();
