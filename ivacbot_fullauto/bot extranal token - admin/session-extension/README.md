# IVAC Session Login — Chrome Extension

Log in to IVAC (`appointment.ivacbd.com`) in any browser using a session that the
bot already holds — **no phone, password or OTP**. A session is valid for about
**15 minutes** (the IVAC access-token lifetime).

Two modes:

- **🔗 Auto** — the extension asks the bot for its logged-in instances and shows
  a list; click a name and you are logged in. Needs the bot address + key.
- **📋 Paste** — paste a session copied from the dashboard's **🔑** button; click
  Login. Needs nothing from the bot (works even across the internet).

## IP pinning (Auto mode)

An IVAC session is bound to the IP it was created on, so re-using it from a
different IP drops it. In **Auto mode** the extension fixes this automatically:

1. On login it reads the instance's proxy from the bot and **routes this whole
   browser through that same IP** (`chrome.proxy`), supplying the proxy's
   username/password for you.
2. A banner shows the required IP and **blinks red** until the browser is
   actually on it, then turns **green** — so you know the session is stable.
3. **✕ Disconnect** clears the proxy again.

Only one extension can control the browser proxy at a time, so disable any other
proxy extension while using Auto mode. Proxy credentials are kept in memory
(`chrome.storage.session`) and cleared when the browser closes.

---

## Install (Load unpacked)

1. Open **chrome://extensions**
2. Turn on **Developer mode** (top-right)
3. **Load unpacked** → select this `session-extension` folder
4. Pin the extension (puzzle icon → pin)

## One-time setup (only for Auto mode)

1. Start the bot once. It creates a key file `session_ext_key.txt` next to the
   bot and prints `🔑 browser-extension key written to session_ext_key.txt`.
2. Open the extension → **⚙️ Settings**:
   - **Bot URL**: `http://localhost:8080` (or your bot's LAN address)
   - **Extension key**: paste the contents of `session_ext_key.txt`
   - **Save**
3. If your bot is **not** on `localhost`/`127.0.0.1`, add its address to
   `host_permissions` in `manifest.json` and reload the extension.

> Keep `session_ext_key.txt` private. Anyone with it can pull sessions from the
> bot, so only use Auto mode on your own machine / LAN.

## How to use

### Auto mode
1. Open **https://appointment.ivacbd.com** in the tab.
2. Click the extension → **🔗 Auto** → click **Login** next to an instance.
3. The page reloads logged in.

### Paste mode
1. In the bot dashboard, click **🔑** on an instance row → the session is copied.
2. Open **https://appointment.ivacbd.com**.
3. Click the extension → **📋 Paste** → paste (Ctrl+V) → **Login**.

---

## How it works (safe, read-only)

The bot exposes two **read-only** endpoints (they never start/stop/change
anything):

- `GET /api/sessionList` — instances that currently hold a live token
- `GET /api/sessionSnippet?id=<id>` — that instance's `auth-storage` blob

Both require either an admin dashboard cookie (used by the 🔑 button) or the
extension key (header `X-Ext-Key`). The extension writes the returned blob into
the page's `localStorage["auth-storage"]` and reloads — exactly what the SPA
expects after a normal login.
