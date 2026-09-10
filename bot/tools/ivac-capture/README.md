# ivac-capture

Grabs the **current** IVAC endpoints, payloads, headers and cipher output by
running the real site in a browser and recording the actual API requests — so
you never have to decode the obfuscated bundle by hand. Whenever IVAC redeploys
and something changes (endpoint version, reserve slot id, dg-epay uuid, cipher),
run this once and read the values.

## Why this is reliable

The browser itself runs the real app, so every request it sends is already
fully decoded — the obfuscation is irrelevant. This tool only *records* those
requests; it decodes/guesses nothing.

## Setup (on your own machine — needs Node.js)

```bash
cd tools/ivac-capture
npm install            # installs playwright + chromium (~1 min, first time only)
```

## Use

```bash
npm run capture
```

1. A Chromium window opens on `appointment.ivacbd.com`.
2. **You** log in, enter the OTP, pass the Turnstile captcha, and click through
   as far as you can — ideally up to the payment step (so the dg-epay initiate
   call fires).
3. Close the window (or press Ctrl+C in the terminal).

Two files are written in this folder:

- **`values.json`** — the values the bot needs, pulled from the real requests:
  ```json
  {
    "apiBase": "https://api.ivacbd.com/iams/api/v1",
    "endpoints": { "signin": "/auth/v3-sign-in", "uploadFile": "/file/upload_file_v321", ... },
    "slotId": "139fd4d2-...",
    "dgepayUuid": "23228961-...",
    "initiatePath": "/payment/23228961-.../dg-epay/initiate",
    "cipher": { "signin_c": "...", "reserve_c": "..." },
    "headers": { "xToken_signin": "...", "xSecNavigationState": "...", ... }
  }
  ```
- **`capture.json`** — the full raw log of every API call (method, URL, headers,
  body, response) for deep inspection.

## Plugging values into the bot

- **dg-epay uuid / slot id changed** → paste `dgepayUuid` / (slot id) into the
  dashboard's manual override fields. (The bot also auto-decodes these from the
  bundle now, so this is a backup.)
- **endpoint versions changed** → the bot's live scan already picks these up; the
  `endpoints` block here just lets you confirm them.
- **cipher changed** → compare against the bot's scanned cipher; `signin_c` /
  `reserve_c` are the browser's real encrypted outputs for cross-checking.

## Notes

- Headed by default so you can do the login/OTP/captcha yourself. `HEADLESS=1
  npm run capture` runs without a window (capture only — no help with login).
- This tool never leaves your machine; it talks only to IVAC.
