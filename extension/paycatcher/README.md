# RJ IVAC Payment Callback Catcher (Chrome Extension)

Captures the dg-epay **callback URL with `tran_id` + the encrypted `data` blob** straight from the
browser's network layer — the same place DevTools "Copy as fetch" reads from — which a bookmarklet /
userscript cannot reach. On capture it re-fires the callback (GET, with your cookies) every second
until **302 / 2xx = success**, then navigates the tab to finish. Everything is local; no external server.

## Install (Load unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** → select this `paycatcher` folder
4. Pin the extension (puzzle icon → pin) so you can see its popup + badge

## Use

1. Do the IVAC payment as normal (dg-epay).
2. The moment the callback fires, the extension catches it — badge shows **●** (orange), then **✓** (green) on success.
3. Click the extension icon to see: `tran_id`, the full callback URL (with `data`), and status.
   - **Copy fetch** — copies a ready `fetch(...)` snippet.
   - **▶ Fire now** — manually re-fire.
   - **Reset** — clear and wait for the next payment.

## Notes

- Works even if the callback is a pure server-side 302 (webRequest sees redirects regardless).
- Scope is limited to `api.ivacbd.com`, `appointment.ivacbd.com`, `*.dgepay.net`.
- If Chrome suspends the worker mid-retry, an alarm resumes the fire loop.
