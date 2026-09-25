package flow

import "time"

// Scan discovers + downloads the site bundle (via r.Fetcher), then fills the
// Config with the live encryption config, endpoint literals and slot id — the
// A_E step. Hardcoded fallbacks stay in place for anything not resolved.
func (r *Runner) Scan() {
	// The bundle scan always prefers the DIRECT scan fetcher (proxy-free) when one is
	// wired, so a dead/absent proxy on this instance never stalls the live scan. It
	// falls back to the normal Fetcher when no scan fetcher was set.
	sf := r.ScanFetcher
	if sf == nil {
		sf = r.Fetcher
	}
	if sf == nil {
		r.log("⚠ No fetcher — using hardcoded endpoint fallback")
		return
	}
	// ── SMART SKIP: same bundle as last successful run → reuse it, skip the heavy
	// download + goja cipher/dg-epay work. We only fetch the (light) bundle URL list
	// to read the live bundle NAME; if it matches the last-good snapshot, reuse.
	if lg := parseLastGood(r.Config.LastGoodJSON); lg.hasCipher() {
		if urls := FindBundleURLs(sf, AppointmentOrigin); len(urls) > 0 && bundleNameMatches(lg.BundleName, urls) {
			lg.applyTo(r.Config) // cipher + endpoints + slot + dg-epay + api base
			// A freshly pushed endpoint-cache for THIS same bundle still overrides
			// (keeps endpoints current if the operator re-pushed); mismatch is skipped.
			r.Config.ApplyEndpointCache(r.Config.EndpointCacheJSON, urls[0], r.log)
			r.Config.LiveBundleURL = urls[0]
			r.scannedBundle = lg.BundleName
			r.applyForcedIDs()
			r.log("♻ Same bundle (" + lg.BundleName + ") — cipher/dg-epay scan skipped (fast start)")
			r.log("🔐 cipher signin:   " + describeCipher(r.Config.Signin))
			r.log("🔐 cipher reserve:  " + describeCipher(r.Config.Reserve))
			r.log("🔐 cipher initiate: " + describeCipher(r.Config.Initiate))
			r.log("🔍 Scan (fast) done: signin=" + r.Config.SigninURL() + " slot=" + r.Config.SlotID)
			if r.OnScanComplete != nil {
				r.OnScanComplete(true, "fast: reused last-good config for bundle "+lg.BundleName)
			}
			if !r.Stopped() {
				r.log("▶ Scan complete (fast) — signin shuru hocche…")
			}
			return
		}
	}
	// SHARED live scan: the bundle download + endpoint regex + cipher goja are
	// identical for every instance on the same live bundle, so run them ONCE per TTL
	// window and share the result across all instances (the first instance scans
	// live, the rest reuse it instantly). It stays live — a redeployed bundle differs
	// and, after the TTL, re-scans. The RJ SLOT A_E retry loop lives inside.
	sc := getSharedScan(sf, AppointmentOrigin, r.Stopped, r.interruptibleSleep, r.log)
	if sc == nil {
		r.log("⚠ Bundle unreachable — using CURRENT built-in endpoints + cipher fallback (signin will still work)")
		// nothing was scanned → every value is a gap the import may be able to fill
		r.Config.ApplyImportGaps(EndpointScan{Families: map[string]string{}}, false, r.log)
		r.applyForcedIDs()
		if r.OnScanComplete != nil {
			r.OnScanComplete(false, "bundle unreachable — built-in fallback in use")
		}
		return
	}
	combined := sc.combined
	r.Config.ApplyEndpointScan(sc.ep)
	// Overlay the pushed endpoint-cache (extract_fetch.js v15 output from the
	// autocheck folder) when it was built for THIS exact live bundle — its
	// deobfuscated endpoints/slot/dg-epay override the fast regex scan. On a bundle
	// mismatch (or no push) it is skipped and the regex scan stands.
	r.Config.ApplyEndpointCache(r.Config.EndpointCacheJSON, sc.bundle, r.log)
	if sc.cipherOK {
		r.Config.ApplyCipherScan(sc.cipher)
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
	// fill ONLY what this scan could not resolve — the scan always wins
	r.Config.LiveBundleURL = sc.bundle
	if sc.cipherOK {
		r.scannedBundle = baseName(sc.bundle) // enables the last-good snapshot on success
	}
	r.Config.ApplyImportGaps(sc.ep, sc.cipherOK, r.log)
	r.applyForcedIDs()
	r.log("🔍 Scan done: signin=" + r.Config.SigninURL() + " slot=" + r.Config.SlotID)

	// Announce the scan result. Every detail the sign-in needs is resolved when the
	// endpoints were rewritten from the live bundle, the cipher config was decoded
	// and a slot id is in hand. The dashboard turns ok=true into the loud
	// "UPDATE SUCCESSFULLY" announcement, and sign-in starts immediately after.
	if r.OnScanComplete != nil {
		full := sc.cipherOK && r.Config.SlotID != "" && len(sc.ep.Families) > 0
		detail := "endpoints=" + itoa(len(sc.ep.Families)) + " cipher=" + boolWord(sc.cipherOK) +
			" slot=" + r.Config.SlotID
		r.OnScanComplete(full, detail)
	}
	if !r.Stopped() {
		r.log("▶ Scan complete — signin shuru hocche…")
	}
}

// boolWord renders a bool for the scan summary line.
func boolWord(b bool) string {
	if b {
		return "ok"
	}
	return "fallback"
}

// applyForcedIDs lets the dashboard's manual Slot ID / dg-epay ID override the
// scanned values, and reports whatever the flow will actually use back to the UI.
func (r *Runner) applyForcedIDs() {
	if r.Config.ForcedSlotID != "" {
		r.Config.SlotID = r.Config.ForcedSlotID
		r.Config.noteSource("slotId", SrcManual)
		r.log("📌 Slot ID forced (manual): " + r.Config.SlotID)
	}
	if r.Config.ForcedDgepayID != "" {
		r.Config.DgepayID = r.Config.ForcedDgepayID
		r.Config.noteSource("dgepayId", SrcManual)
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
		// FRESH LOGIN vs LIVE OTP WINDOW. When no sign-in window is open, this run
		// will really sign in and a NEW OTP will be sent — so drop whatever OTP is
		// still being held from the previous session and remember the code sms.php is
		// serving right now, which belongs to that old session. Without this the flow
		// verifies with the previous OTP before the new SMS ever lands (the bug seen
		// after the 15-minute logout).
		otpPhonePre := r.OTPPhone
		if otpPhonePre == "" {
			otpPhonePre = r.Phone
		}
		if _, _, left, gated := LiveSignin(r.Phone); gated {
			r.log("🔒 OTP session ekhono cholche (" + left.Round(time.Second).String() +
				" baki) — notun signin hobe na, ei session-er OTP diyei verify hobe")
		} else {
			r.ClearOTP()
			PrimeOTPBaseline(r, otpPhonePre)
		}
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
			if err == errAppointmentExpired {
				return err // >30 days old — a NEW appointment is required; retrying is futile
			}
			if err == errAppointmentNotFound {
				return err // stuck/gone appointment — retrying only causes 429; stop now
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

	// Persist the working config so a same-bundle run next time can smart-skip the
	// heavy scan. Only saved after a real success, so the snapshot is proven-good.
	if r.OnScanResolved != nil && r.scannedBundle != "" {
		if snap := serializeLastGood(r.Config, r.scannedBundle); snap != nil {
			r.OnScanResolved(snap)
			r.log("💾 last-good config saved (bundle " + r.scannedBundle + ") — next same-bundle run will fast-start")
		}
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
