# ivacbot_fullauto — update notes

Four changes, all inside `bot extranal token - admin/`.

## 1. Sign-in respects the 15-minute OTP session

A successful sign-in already sends the OTP and opens a ~15-minute session on
IVAC's side. Signing in again inside that window re-sends the OTP, invalidates
the code the user is holding and quickly trips HTTP 429.

`flow/otp_session.go` adds a per-phone sign-in gate (`SigninSessionTTL = 15m`):

* `StepSignin` checks `LiveSignin(phone)` first. While the window is open it
  reuses the stored `accessToken`/`requestId`, logs how much time is left, and
  returns success **without sending a sign-in request** — so the retry loop
  never re-sends an OTP.
* On a real sign-in success, `RememberSignin` opens the window.
* `ForgetSignin` closes it when a session is known dead.

Clean Cache deliberately does **not** clear this window: it mirrors a session
that is still alive on IVAC's side, so forgetting it would cause exactly the
re-sign-in + 429 this change prevents. It expires on its own after 15 minutes.

## 2. Clean Cache clears the OTP and every instance's logs

`handleCleanCache` (`fullauto_handler.go`) now also:

* clears `Data.OTP`, `Data.ManualOTP`, `Data.ManualOTPTime`, `Data.Logs` and
  `Data.NetworkLogs` for **every** instance (`clearAllInstanceLogsAndOTP`);
* wipes the OTP held by every **running** flow (`clearRunningFlowOTPs`, wired
  through the new `RegisterClearOTP` hook → `Runner.ClearOTP`).

The instances themselves are untouched — only their cached state is dropped.
The dashboard's `cleanCache()` also empties any on-screen OTP input and the log
modal's cache, so nothing stale is left in the UI.

## 3. Loud "UPDATE SUCCESSFULLY" when the bundle scan has every detail

`Runner.OnScanComplete(ok, detail)` fires at the end of `Scan()`. `ok` is true
when the live bundle resolved the endpoints, the cipher config and the slot id.

* `fullauto_handler.go` records it (`announceScanComplete`) and serves it at
  `GET /api/scanEvent`.
* The dashboard polls that every 2s and, on a new sequence number, plays a loud
  3-tone chime and speaks **"UPDATE SUCCESSFULLY"** (Web Speech API), plus a
  toast. The first click on the page unlocks the AudioContext, as browsers
  require.
* Sign-in starts immediately after the scan, as before — the announcement sits
  right in front of it.

An incomplete scan (bundle unreachable → built-in fallback) is logged but makes
no sound.

## 4. The previous OTP is never reused

This was the reported failure: after the 15-minute logout, the old OTP was still
in the input **and** still being served by `sms.php`, so the bot verified with it
before the new SMS arrived.

* `PrimeOTPBaseline` (`flow/sms_fetcher.go`) reads whatever `sms.php` holds
  *before* a new sign-in and marks that code stale.
* `RunFullAuto` calls `ClearOTP()` + `PrimeOTPBaseline()` only when it is about
  to do a **real** sign-in (not when reusing a live session, whose OTP is valid).
* `StartSMSFetcher` skips a stale code, logs that it is still the old one, and
  keeps polling up to `SMSWaitForNewMax` (5 min) for the new SMS.
* `StepVerify` refuses to send a stale OTP at all, and on success marks the code
  consumed (`MarkOTPUsed`) so no later run can reuse it. Used codes are
  remembered per phone for 2 hours, across runs.
* A **manually typed** OTP always wins (`SetOTPManual`) — the user is reading it
  off their phone.

## Tests

`flow/otp_session_test.go` covers the sign-in gate (blocks, expires, reopens),
the consumed-OTP memory, the runner's stale-OTP rejection, and an end-to-end
fetcher run where `sms.php` serves the old code three times before the new one.

```
go build ./... && go vet ./... && go test ./...
```

---

# Round 2 — captured-config import, and one sound per scan

## 5. "UPDATE SUCCESSFULLY" now plays once, not once per instance

Full Auto All starts every instance against ONE shared bundle scan, so each
instance reported the same result and `announceScanComplete` bumped the sequence
number every time — the dashboard played the announcement once per instance.

`announceScanComplete` now ignores a repeat of the same result within
`scanAnnounceCooldown` (2 min). A genuinely different scan result, or the same
result after the cooldown, still announces. An incomplete scan still makes no
sound at all.

## 6. Import an RJ SLOT capture to fill what the scan cannot resolve

Two values are assembled by the site at runtime and therefore never appear as
plaintext in the bundle: the reserve **slot id** and the **dg-epay uuid**. The
bundle scan can only guess at them (and regularly fails). They do appear, in the
clear, in the URL of a real request — which the RJ SLOT userscript records and
exports as an `rj_dyn_sync` JSON.

`flow/imported.go` parses that export. `import_handler.go` stores it and serves
the dashboard.

### Precedence — the live scan always wins

    1. manual override (dashboard boxes)
    2. live bundle scan            ← the normal path, unchanged
    3. import                      ← only where the scan resolved nothing
    4. built-in fallback

`Config.ApplyImportGaps` fills **per value**, not as a blob: if the scan
resolved 10 endpoints and the cipher but missed the slot id, only the slot id is
filled. When the scan resolves everything, the import is not consulted at all —
a normal day behaves exactly as before.

### Ground truth: recorded URLs, not the export's id fields

`rj_dyn_captured.slotId` / `payId` are the userscript's own **hardcoded**
fallbacks, and in a real export they were stale. The parser deliberately ignores
both and extracts the two ids from the URL of a recorded successful request:

    /slots/([0-9a-zA-Z-]{36})/reserve-slot
    /payment/([0-9a-zA-Z-]{36})/dg-epay/initiate

Alphanumeric, not hex: IVAC's live ids are not strictly hex
(`…-368583e830bs`, `…-3s28-…`), and a hex-only pattern drops them silently.

The rule: a value that really worked against the server is true; a value
hardcoded in someone's source is not.

### Endpoints, headers, cipher

* endpoints — `fam` (the userscript's own scan, re-run every page load) is
  primary; `epMap` and recorded URLs fill anything it missed
* headers — fixed headers only; `authorization`, `x-token`, `cookie`,
  `x-device-id` and friends are never imported
* cipher — from `rj_enc`, decoded leniently (numbers may arrive as strings)

### Dashboard

* **📥 Import Capture** — paste the JSON, **Preview** shows exactly what would
  change (old → new per field, plus warnings for anything missing), then Apply
* a status strip shows where each live value came from:
  `slot id 139fd4d2… ✅ scan`, `dg-epay 23228961… 📥 import`,
  `cipher ⚠️ built-in` — so a gap is visible **before** a run, not after it fails
* the capture persists in `captured_config.json` and survives a restart
* **🗑️ Clear Import** drops it

Endpoints: `GET/POST /api/importCaptured`, `POST /api/clearImport`,
`GET /api/configSources`.

## Tests

`flow/imported_test.go` — recorded URLs beat the hardcoded fields, non-hex ids
survive, endpoints/headers/cipher parse (including numbers-as-strings), secrets
are never imported, trailing junk is tolerated, foreign JSON is rejected, gaps
are filled without ever overwriting a scan-resolved value, and no import means
no change.

`announce_test.go` — ten instances produce one announcement; a changed result
still announces; the cooldown lapsing announces again; an incomplete scan never
sounds.

---

# Round 3 — ivacflow pushes straight into the bot

ivacflow is a separate Node + Playwright tool: it downloads the live bundle,
hosts it locally, and walks signin→initiate headlessly with **mock** data. Because
it RUNS the code instead of pattern-matching it, it resolves the two values the
bot's own text scan cannot — the reserve slot id and the dg-epay uuid, both of
which the site assembles at runtime and therefore never spells out in the bundle.

It now POSTs its snapshot to the bot the moment an extraction finishes. No file
to copy, no button to press.

## The ladder

    1. manual override (dashboard boxes)
    2. live bundle scan        ← unchanged; still the normal path
    3. ivacflow snapshot       ← new
    4. RJ SLOT recorder capture
    5. built-in fallback

Rungs 3–5 only ever fill what rung 2 left unresolved, so a day when the scan
works behaves exactly as before. `Config.Fallbacks` holds 3 and 4 in order;
each capture gets a turn at whatever is still open.

## Freshness is decided by the bundle, not the clock

A snapshot carries the `bundleName` it was extracted from, and the scan now
records the bundle URL it actually downloaded. If they disagree, IVAC redeployed
since the extraction and the snapshot is stale by definition — it is skipped
with a log line, whatever its timestamp claims.

## Push authentication

The endpoint rewrites the API config every instance runs against, so it is not
open. Two gates, both required:

* **loopback only** — the request must originate on this machine;
* **shared token** — the bot writes `ivacflow_token.txt` (0600) on first start;
  ivacflow reads it and sends `x-ivacflow-token`.

A push that fails either gate changes nothing.

## Template drift detection

ivacflow also reports the body FIELD NAMES it observed per step.
`compareTemplate` checks those against what the bot's builders actually send and
reports the differences. It already found a real one:

    PAYMENT INITIATE: ivacflow dekheche [reservationId amount], bot pathay [appointmentId]

Nothing is changed automatically — the two captures disagree (the RJ SLOT
recording said `appointmentId`), so this is reported for a human to settle
against a real successful request.

## Also in this round

* the Import panel accepts **either** format — an ivacflow snapshot has no `_t`
  but does have a `config` object, so they are told apart without asking
* headers (`x-sec-navigation-state`, `x-sec-runtime-state`, `x-v-request-meta`)
  now really do come from a capture. They previously could not: the code only
  filled them when empty, and `NewConfig()` always pre-seeds them. The bundle
  scan never produces headers, so there is no scan value to defend.
* a capture that merely CONFIRMS a value is now recorded as its source, instead
  of the dashboard reporting a confirmed value as "built-in"

Endpoints: `POST /api/ivacflowPush`, `GET /api/ivacflowStatus`,
`POST /api/clearIvacflow`.

## ivacflow side

`ivacflow-patch/` holds the two changed files. `dashboard-server.js` gains
`pushToBot()` plus three call sites (after a walk, and after either bundle-load
path). `config.json` gains `botUrl` / `botTokenFile`; clear `botUrl` to disable
pushing. Node's built-in `http` only — no new dependency. If the bot is down or
the token is missing, ivacflow logs a line and carries on.

## Tests

`flow/ivacflow_test.go` — endpoint-name mapping and prefix stripping, non-hex
ids, placeholder headers never imported, format detection, bundle-match
freshness, ivacflow outranking the recorder, the recorder still filling what
ivacflow lacks, a stale-bundle capture being skipped entirely, headers
outranking the built-in.

`ivacflow_push_test.go` — a push with no token, a wrong token and a non-loopback
address are all refused and change nothing; a valid push is stored and
persisted; a walk that captured nothing is rejected; template drift is reported.

---

# Round 4 — clear an OTP and type a fresh one

The SMS poller sometimes picks the PREVIOUS session's code off sms.php and the
instance tries to verify with it. Once an OTP was held, the dashboard showed it
as plain text — the input was gone, so there was no way to drop it and type the
code actually on the phone.

The OTP cell now shows a **✖** button next to the code. Clicking it:

* clears `Data.OTP`, `Data.ManualOTP` and the OTP the RUNNING flow holds, and
* **blacklists that code** on the run (`Runner.RejectOTP` via the new
  `RegisterRejectOTP` hook), then
* sets `WaitingOTP` so the input reappears, with the cursor placed in it.

The blacklist is the part that matters. Clearing the box alone is useless: the
SMS poller reads the same stale code back off sms.php a second later and puts it
straight back. A typed code still overrides everything (`SetOTPManual`).

Endpoint: `POST /api/clearOTP?id=<instanceId>`.

Tests: `ivacflow_push_test.go` — clearing blacklists the code, wipes both OTP
fields, clears the running flow and reopens the input; an unknown instance 404s.
