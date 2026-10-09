// IVAC Session Login — on-page account badge.
//
// Shows a big, bold "LOGGED IN AS <name>" badge in the corner of
// appointment.ivacbd.com so you always know WHICH account this browser is on.
// It stays while the IVAC session (localStorage "auth-storage") is present and
// disappears the moment you log out.

(function () {
  const ID = "__ivac_acct_badge";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function readAuth() {
    try { return JSON.parse(localStorage.getItem("auth-storage") || "null"); }
    catch (_) { return null; }
  }

  let badge = null;

  function ensureBadge() {
    if (badge && document.documentElement.contains(badge)) return badge;
    badge = document.createElement("div");
    badge.id = ID;
    badge.style.cssText = [
      "position:fixed", "top:12px", "right:12px", "z-index:2147483647",
      "background:#0d1525", "color:#fff", "border:2px solid #2dd4bf",
      "border-radius:12px", "padding:9px 14px",
      "font-family:system-ui,-apple-system,'Segoe UI',sans-serif",
      "box-shadow:0 6px 24px rgba(0,0,0,.45)", "pointer-events:none",
      "max-width:280px",
    ].join(";");
    document.documentElement.appendChild(badge);
    return badge;
  }

  function render(acc) {
    const b = ensureBadge();
    b.innerHTML =
      '<div style="font-size:10px;letter-spacing:1px;color:#94a3b8;font-weight:700;">LOGGED IN AS</div>' +
      '<div style="font-size:21px;font-weight:800;color:#5eead4;line-height:1.15;">' +
        esc(acc.name || acc.phone || "IVAC") + "</div>" +
      (acc.phone ? '<div style="font-size:12px;color:#cbd5e1;">' + esc(acc.phone) + "</div>" : "") +
      (acc.ip ? '<div style="font-size:11px;color:#7dd3fc;">🌐 ' + esc(acc.ip) + "</div>" : "");
  }

  function remove() {
    const el = document.getElementById(ID);
    if (el) el.remove();
    badge = null;
  }

  const nameCache = {}; // phone → name (so we ask the bot only once per phone)

  function lookupName(phone, ip) {
    if (!phone || nameCache[phone] !== undefined) return;
    nameCache[phone] = ""; // mark as asked
    try {
      chrome.runtime.sendMessage({ type: "lookupName", phone }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.name) {
          nameCache[phone] = resp.name;
          const auth = readAuth(); // still logged in as the same phone?
          if (auth && auth.state && auth.state.phone === phone) {
            render({ name: resp.name, phone, ip });
          }
        }
      });
    } catch (_) {}
  }

  function tick() {
    const auth = readAuth();
    if (!auth || !auth.state || !auth.state.token) { remove(); return; } // logged out
    const phone = (auth.state && auth.state.phone) || "";
    try {
      chrome.storage.local.get("activeAccount", (v) => {
        const acc = (v && v.activeAccount) || {};
        const sameAcct = acc.phone && phone && acc.phone === phone;
        const ip = sameAcct ? acc.ip : "";
        // name priority: what Auto mode stored → what the bot lookup returned → (number)
        let name = sameAcct ? acc.name : "";
        if (!name && nameCache[phone]) name = nameCache[phone];
        render({ name, phone, ip });
        if (!name) lookupName(phone, ip); // resolve the number → Client name
      });
    } catch (_) {
      render({ phone });
    }
  }

  tick();
  setInterval(tick, 1500);
})();
