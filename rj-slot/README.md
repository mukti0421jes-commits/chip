# RJ SLOT — IVAC automation userscript

Latest working build committed here for safekeeping (scratchpad is ephemeral).

## Files
- `ivac-rj-slot-v10.5.8.user.js` — raw Tampermonkey userscript (install this directly).
- `main.obf.b64` — license build (obfuscated + base64). Deploy to `public_html/rj/main.obf.b64`.
- `gmail-otp.php` — Gmail IMAP OTP reader. Deploy to `public_html/` (root, next to `email.php`). Requires PHP `imap` extension. Converts IVAC word-format OTP (e.g. "Zero-One-…") to digits.
- `extract_fetch_v13.js` — reference Node extractor (payment paths / dg-epay UUID + slot-id), Strategy A–K.
- `rjExtractFetchV13.js` — browser port of extract_fetch v13 (embedded in the userscript as `rjExtractFetchV13`).

## What v10.5.8 does dynamically (no hardcode)
- **dg-epay UUID + reserve slot-id**: scanned from the live bundle via the extract_fetch v13 port
  (handles nested multi-array RC4 obfuscation and non-hex/typo UUIDs, e.g. `…3s28…`, `…830bs`).
- **Endpoints** (v3-sign-in, verify-otp-v3, over-view-v421, upload_file_v321, …): matched by
  `RJ_EP_FAMILIES` regex stems and rewritten to the current bundle literal.
- **Runtime capture**: every fetch/XHR is intercepted; on a successful (2xx) call the dg-epay UUID,
  slot-id, endpoint versions, and fixed security headers are captured into `RJ_DYN` (localStorage)
  and the input boxes. Lenient regexes accept non-hex UUIDs. Value priority: input box > RJ_DYN > hardcode.
- **Email OTP auto-fetch**: catch-all (`email.php`) and per-profile Gmail (`gmail-otp.php`, App Password
  stored in the profile "Gmail App Password" box).
- **File-upload retry-until-success** with a per-step UI delay row (signin 4 / verify 5 / upload 5 /
  reserve 21 / book 2 / initiate 4).
- **Dynamic mission/center** per profile.

## KNOWN ISSUE (pending) — signin captcha cipher on the newest bundle
The newest bundle (`mudp3pax-…`) changed the captcha-token encryption cipher:
`v10 / startAt 8 / length 21` → `v9 / startAt 2 / length 29`, with a new ~29-char secret.

The in-script cipher resolver (`resolveBundleConfigs`) mis-selects the secret field on this bundle: it
picks the Turnstile **sitekey** (`0x4AAAAAAC…`, 24 chars) instead of the real 29-char secret, because
the real secret field (a deeply nested CW→pW / wW→vW multi-array RC4 concat inside a lazy module) fails
both the static and execution decoders. Result: signin → HTTP 400 "captcha verification failed", so the
auto flow stops at step 1.

Fix path (same approach that solved dg-epay): port a working `extract_ciphers.js`, or extend the v13
VM-eval machinery to decode the cipher-secret expression and select the field by the declared `length`.
