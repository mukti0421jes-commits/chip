package flow

import "time"

// Scan discovers + downloads the site bundle (via r.Fetcher), then fills the
// Config with the live encryption config, endpoint literals and slot id — the
// A_E step. Hardcoded fallbacks stay in place for anything not resolved.
func (r *Runner) Scan() {
	if r.Fetcher == nil {
		r.log("⚠ No fetcher — using hardcoded endpoint fallback")
		return
	}
	// RJ SLOT A_E parity: keep looking for the live bundle every 2s (server may be
	// 403 / index not ready) up to ~30 tries, logging each attempt's status, then
	// fall back to hardcoded endpoints so the pipeline can still proceed.
	var combined string
	const maxTries = 8
	for attempt := 1; attempt <= maxTries && !r.Stopped(); attempt++ {
		urls := FindBundleURLs(r.Fetcher, AppointmentOrigin)
		if len(urls) > 0 {
			if c, _ := DownloadBundles(r.Fetcher, urls); c != "" {
				combined = c
				r.log("🔍 Bundle found (try " + itoa(attempt) + ", " + itoa(len(urls)) + " chunk) — scanning…")
				break
			}
		}
		// diagnostic on the first miss: show what the origin actually returned.
		if attempt == 1 {
			body, err := r.Fetcher.Get(AppointmentOrigin + "/")
			if err != nil {
				r.log("🔎 A_E fetch error: " + err.Error())
			} else {
				snip := body
				if len(snip) > 120 {
					snip = snip[:120]
				}
				r.log("🔎 A_E origin returned " + itoa(len(body)) + " bytes: " + snip)
			}
		}
		r.log("⏳ A_E: bundle not ready (try " + itoa(attempt) + "/" + itoa(maxTries) + ") — retry in 2s")
		r.interruptibleSleep(2 * time.Second)
	}
	if combined == "" {
		r.log("⚠ Bundle unreachable — using CURRENT built-in endpoints + cipher fallback (signin will still work)")
		r.applyForcedIDs()
		return
	}
	r.Config.ApplyEndpointScan(ScanEndpoints(combined)) // ~0.3s
	if cs, err := ScanCipher(combined); err == nil {    // ~1.3s (goja)
		r.Config.ApplyCipherScan(cs)
	} else {
		r.log("⚠ cipher scan failed: " + err.Error() + " — using fallback")
	}
	// VERIFY: print the cipher config the flow will actually use per purpose, so a
	// mismatched Reserve vs Signin cipher (the cause of a constant reserve "Captcha
	// verification failed") is visible. Key is shown as len+prefix only.
	r.log("🔐 cipher signin:   " + describeCipher(r.Config.Signin))
	r.log("🔐 cipher reserve:  " + describeCipher(r.Config.Reserve))
	r.log("🔐 cipher initiate: " + describeCipher(r.Config.Initiate))
	// dg-epay UUID is a ~37s goja deobfuscation — run it in the BACKGROUND (once
	// per bundle) so the pipeline flows immediately; the Initiate step waits for
	// it. This keeps the server + captcha pool responsive and Stop working.
	r.dgJob = StartDgEpayResolve(combined)
	r.log("💳 dg-epay resolving in background (won't block signin/upload)…")
	r.applyForcedIDs()
	r.log("🔍 Scan done: signin=" + r.Config.SigninURL() + " slot=" + r.Config.SlotID)
}

// applyForcedIDs lets the dashboard's manual Slot ID / dg-epay ID override the
// scanned values, and reports whatever the flow will actually use back to the UI.
func (r *Runner) applyForcedIDs() {
	if r.Config.ForcedSlotID != "" {
		r.Config.SlotID = r.Config.ForcedSlotID
		r.log("📌 Slot ID forced (manual): " + r.Config.SlotID)
	}
	if r.Config.ForcedDgepayID != "" {
		r.Config.DgepayID = r.Config.ForcedDgepayID
		r.log("📌 dg-epay ID forced (manual): " + r.Config.DgepayID)
	}
	if r.OnScanIDs != nil {
		r.OnScanIDs(r.Config.SlotID, r.Config.DgepayID)
	}
}

// RunFullAuto is the Go equivalent of RJ SLOT runFullAuto — the one-click
// pipeline. It runs, in order and byte-faithfully:
//
//	A_E scan → Signin → OTP+Verify → (Upload: appointment → files → overview →
//	confirm center) → Book (get appointmentId) → Reserve → Initiate (payment URL)
//
// Each step uses the retry engine (Single/Auto). Files/mission/center come from
// the File Manager entry. Returns the first hard failure, or nil on payment URL.
func RunFullAuto(r *Runner, files []PDFFile, mission, ivacCenter string) error {
	// A_E — live scan fills Config (endpoints v26, slot id, cipher).
	r.Scan()

	// RESUME: if a live, verified session was preloaded (stop → start within the
	// token window), skip signin + OTP + verify entirely and continue from where
	// it stopped. Otherwise run signin → OTP → verify normally.
	if r.AccessToken != "" && r.Verified {
		r.log("⏭ Resume: session reused — skipping signin/OTP/verify")
	} else {
		// Signin (retry until success).
		if res := r.RunStepSmart(StSignin, StepSignin); !res.Win {
			return failOrStop(r, "signin")
		}
		// OTP auto-fetch (sms.php) in the background + Verify (waits for the OTP).
		otpPhone := r.OTPPhone
		if otpPhone == "" {
			otpPhone = r.Phone
		}
		r.log("📱 OTP auto-fetch shuru (duttauzzal.shop, number " + otpPhone + ")…")
		go StartSMSFetcher(r, otpPhone)
		if res := r.RunStepSmart(StVerify, StepVerify); !res.Win {
			return failOrStop(r, "verify")
		}
		r.Verified = true
		if r.OnVerified != nil {
			r.OnVerified()
		}
	}

	// Upload sub-flow: appointment → (skip/upload) → overview+match → confirm center.
	// Retry the WHOLE sub-flow until success (Single mode) — the same live session
	// is reused and the pre-check overview skips already-uploaded files, so no
	// re-login is needed. An overview MISMATCH is a data problem (wrong PDFs) that
	// retrying can't fix, so that one stops immediately.
	if len(files) > 0 {
		for attempt := 1; !r.Stopped(); attempt++ {
			err := RunUpload(r, files, mission, ivacCenter)
			if err == nil {
				break
			}
			if err == errOverviewMismatch {
				return err // wrong files — retrying won't help
			}
			if !r.Mode.Single { // retry OFF → fail after one attempt
				return err
			}
			// overview API failing usually means the upload WINDOW IS CLOSED — wait
			// longer (30s) so we don't re-upload every few seconds until it opens.
			d := r.Mode.Delay
			if err == errOverview {
				d = 30 * time.Second
				r.log("↻ upload retry #" + itoa(attempt) + " — over-view failed (window bondho?), waiting 30s")
			} else {
				r.log("↻ upload retry (attempt " + itoa(attempt) + " failed: " + err.Error() + ")")
			}
			r.interruptibleSleep(d)
		}
		if r.Stopped() {
			return errStopped
		}
	}

	// Book (get-booking-config) → appointmentId + reserve date. SMART SKIP: if the
	// instance already carries an appointmentId (from an earlier run / re-login),
	// skip this call entirely — exactly like RJ SLOT.
	if r.AppointmentID != "" {
		r.log("⏭ get-booking-config smart-skip (appointmentId already known: " + r.AppointmentID + ")")
	} else if res := r.RunStepSmart(StBook, StepBook); !res.Win {
		return failOrStop(r, "book")
	}

	// Reserve (slot) → reservationId. RESUME: skip if already reserved.
	if r.ReservationID != "" {
		r.log("⏭ Resume: reserve smart-skip (reservationId already known: " + r.ReservationID + ")")
	} else {
		// RJ SLOT parity: sync the fresh list of OPEN dates from get-booking-config
		// (the ↻ "load dates" call) right BEFORE reserve, and pick a valid one — a
		// stale/closed date makes reserve fail with HTTP 400.
		LoadReserveDates(r)
		// Try the dates in order (first → second → third…), reserving on the first
		// one whose slot is still open — RJ SLOT date-sweep behavior.
		if res := ReserveCycle(r); !res.Win {
			return failOrStop(r, "reserve")
		}
	}

	// Initiate (dg-epay) → payment URL. Wait for the background dg-epay id first.
	r.ensureDgEpay()
	if res := r.RunStepSmart(StInitiate, StepInitiate); !res.Win {
		return failOrStop(r, "initiate")
	}

	r.log("🎉 FULL AUTO finished — payment URL: " + r.PaymentURL)
	return nil
}

// describeCipher renders a cipher config for the verify log: skip/len/version and
// the key's length + first 6 chars (never the whole key), or "nil (no config)".
func describeCipher(p *PurposeCipher) string {
	if p == nil {
		return "nil (no config — will fail!)"
	}
	kp := p.Key
	if len(kp) > 6 {
		kp = kp[:6]
	}
	return "v" + itoa(p.Version) + " skip=" + itoa(p.Skip) + " len=" + itoa(p.Length) +
		" key[" + itoa(len(p.Key)) + "]=" + kp + "…"
}

func failOrStop(r *Runner, step string) error {
	if r.Stopped() {
		r.log("⏹ stopped at " + step)
		return errStopped
	}
	r.log("⏹ stopped at " + step + " (failed)")
	return &stepError{step}
}

type stepError struct{ step string }

func (e *stepError) Error() string { return "full-auto failed at " + e.step }
