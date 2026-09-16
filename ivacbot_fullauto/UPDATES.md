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
