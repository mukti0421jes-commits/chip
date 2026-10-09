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
	// ── PLAY ALL (CacheOnly): no live scan at all. Run straight from the store
	// (last-good snapshot cipher+endpoints, then pushed endpoint-cache); if the
	// store is empty, the built-in fallback. Nothing is downloaded.
	if r.CacheOnly {
		r.log("▶ Play All — live scan bypass, last-good CACHE theke cholche")
		if r.applyStoreFallback() {
			r.applyForcedIDs()
			r.log("🔐 cipher signin:   " + describeCipher(r.Config.Signin))
			r.log("🔐 cipher reserve:  " + describeCipher(r.Config.Reserve))
			r.log("🔍 Scan (cache) done: signin=" + r.Config.SigninURL() + " slot=" + r.Config.SlotID)
			if r.OnScanComplete != nil {
				r.OnScanComplete(true, "Play All — last-good cache e kaj hocche")
			}
			if !r.Stopped() {
				r.log("▶ Cache ready — signin shuru hocche…")
			}
			return
		}
		r.log("⚠ Play All — cache (last-good/endpoint-cache) faka → built-in fallback e cholche")
		r.Config.ApplyImportGaps(EndpointScan{Families: map[string]string{}}, false, r.log)
		r.applyForcedIDs()
		if r.OnScanComplete != nil {
			r.OnScanComplete(false, "Play All — cache faka, built-in fallback")
		}
		return
	}
	// NOTE: Full Auto All ALWAYS live-scans the bundle — no last-good "smart skip"
	// here. Reusing the last-good snapshot (skip the download) is now exclusively the
	// Play All job (CacheOnly, handled above). So Full Auto always pulls the CURRENT
	// bundle and decodes cipher/endpoints fresh, while Play All runs from the store.
	//
	// SHARED live scan: the bundle download + endpoint regex + cipher goja are
	// identical for every instance on the same live bundle, so run them ONCE per TTL
	// window and share the result across all instances (the first instance scans
	// live, the rest reuse it instantly). It stays live — a redeployed bundle differs
	// and, after the TTL, re-scans. The RJ SLOT A_E retry loop lives inside.
	sc, pushInterrupted := getSharedScan(sf, AppointmentOrigin, r.LiveScanTries, r.Stopped, r.interruptibleSleep, r.log)
	if sc == nil {
		// EXCEPTION to live-only: an ivacflow push (cipher+endpoints) arrived mid-scan.
		// Stop the loop and start the pipeline NOW from that pushed config — exactly
		// the "push lands → auto-flow starts instantly" behavior.
		if pushInterrupted {
			if r.RefreshFallbacks != nil {
				r.Config.Fallbacks = r.RefreshFallbacks() // pick up the just-pushed ivacflow snapshot
			}
			r.Config.ApplyImportGaps(EndpointScan{Families: map[string]string{}}, false, r.log)
			r.applyForcedIDs()
			r.log("🔐 cipher signin:   " + describeCipher(r.Config.Signin))
			r.log("🔍 Scan (ivacflow push) done: signin=" + r.Config.SigninURL() + " slot=" + r.Config.SlotID)
			if r.OnScanComplete != nil {
				r.OnScanComplete(true, "ivacflow push (cipher+endpoints) — instant auto-flow")
			}
			if !r.Stopped() {
				r.log("▶ Scan complete (ivacflow push) — signin shuru hocche…")
			}
			return
		}
		// Full Auto is LIVE-ONLY: the live bundle could not be scanned within the set
		// try-count (server off / unreachable). NO fallback — do NOT touch the store
		// (last-good / endpoint-cache) or the built-in config. The instance aborts; the
		// cache path is Play All. RunFullAuto sees scanAborted and stops before signin.
		if !r.Stopped() {
			r.log("🛑 Full Auto: live scan bundle pelo na (set count sesh) — kono fallback nei, instance stop. Cache theke chalate PLAY ALL din.")
		}
		r.scanAborted = true
		if r.OnScanComplete != nil {
			r.OnScanComplete(false, "Full Auto: live scan failed — no fallback (aborted)")
		}
		return
	}
	combined := sc.combined
	r.Config.ApplyEndpointScan(sc.ep)
	// Option A (preferred): extract_fetch.js v15 output from THIS live bundle — the
	// full deobfuscated endpoints + slot id + dg-epay uuid, produced in-process this
	// run. It overrides the fast regex scan. No autocheck push needed.
	if len(sc.extractCache) > 0 {
		if r.Config.ApplyEndpointCache(sc.extractCache, sc.bundle, r.log) {
			r.log("🧩 extract_fetch (live bundle) endpoints applied — signin theke initiate porjonto path ready")
		}
	}
	// Also overlay any PUSHED endpoint-cache (autocheck folder), for THIS exact
	// bundle — a safety net when node/extract_fetch was unavailable above. On a
	// bundle mismatch (or no push) it is skipped and the values above stand.
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

// applyStoreFallback fills the Config from the STORE when the live scan gave up.
// Order (best → weakest):
//  1. last-good snapshot (last_good_config.json) — the richest: it carries the
//     cipher AND endpoints/slot/dg-epay/paths from the last SUCCESSFUL run.
//  2. pushed endpoint-cache (endpoint_cache.json) — endpoints + slot + dg-epay
//     (no cipher; the built-in cipher fallback stays in place).
// It applies these UNCONDITIONALLY (no live bundle to match against — that is the
// whole point of a fallback), by matching each store blob against its OWN bundle.
// Returns true when it applied something, false when the store is empty.
func (r *Runner) applyStoreFallback() bool {
	applied := false
	if lg := parseLastGood(r.Config.LastGoodJSON); lg.hasCipher() {
		lg.applyTo(r.Config)
		r.log("♻ store: last-good snapshot applied (bundle " + lg.BundleName + ")")
		r.log("🔐 cipher signin:   " + describeCipher(r.Config.Signin))
		r.log("🔐 cipher reserve:  " + describeCipher(r.Config.Reserve))
		r.log("🔐 cipher initiate: " + describeCipher(r.Config.Initiate))
		applied = true
	}
	// Overlay the pushed endpoint-cache too (its endpoints are the freshest the
	// operator captured). Match it against its OWN bundle so the gate always passes.
	if raw := r.Config.EndpointCacheJSON; len(raw) > 0 {
		if r.Config.ApplyEndpointCache(raw, EndpointCacheBundleName(raw), r.log) {
			applied = true
		}
	}
	return applied
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
	// Full Auto is LIVE-ONLY: if the live scan failed (no fallback), stop here — never
	// run signin on store/built-in config. Play All is the cache path.
	if r.scanAborted {
		if r.Stopped() {
			return errStopped
		}
		return errScanFailed
	}

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
			// Baseline the OLD OTP in the BACKGROUND: reading sms.php goes through the
			// instance proxy and can take up to the fetcher timeout, so doing it inline
			// used to delay sign-in by many seconds. It only needs to finish before the
			// SMS fetcher (which starts after signin + SMSFirstDelay) reads a code, so a
			// goroutine is safe and sign-in fires immediately.
			go PrimeOTPBaseline(r, otpPhonePre)
		}
		// Signin (retry until success).
		if res := r.RunStepSmart(StSignin, StepSignin); !res.Win {
			// "Too many attempts" server lockout (first login OR relogin) → auto-stop this
			// instance; do not retry/relogin. errTooManyAttempts carries "stop" so the
			// handler marks it STOPPED (not FAILED) and the relogin loop does not re-run it.
			if res.HardStop {
				return errTooManyAttempts
			}
			return failOrStop(r, "signin")
		}
		// OTP auto-fetch (sms.php) in the background + Verify. The OTP verify window
		// opens now (sign-in just sent the OTP): the auto-fetch tries a bounded number
		// of times, then a manual OTP can be typed — but only until OTPVerifyLifetime
		// elapses, after which the instance auto-stops instead of waiting forever.
		otpPhone := r.OTPPhone
		if otpPhone == "" {
			otpPhone = r.Phone
		}
		otpDeadline := time.Now().Add(OTPVerifyLifetime)
		r.log("📱 OTP auto-fetch shuru (duttauzzal.shop, number " + otpPhone + ") — OTP window " +
			OTPVerifyLifetime.String())
		go StartSMSFetcher(r, otpPhone)
		if res := r.RunStepSmartUntil(StVerify, StepVerify, otpDeadline); !res.Win {
			if r.Stopped() {
				return failOrStop(r, "verify")
			}
			// window elapsed without any OTP → auto-stop this instance (not a hard
			// failure). It was never verified, so starting it again begins from sign-in.
			r.log("⌛ OTP verify window (" + OTPVerifyLifetime.String() +
				") shesh — OTP paowa jayni. Instance auto-stop. Pore abar chalu korle signin theke shuru hobe.")
			// The sign-in window (SigninSessionTTL = 15m) outlives the OTP window (5m), so
			// without this a restart would reuse the live sign-in and jump straight back to
			// OTP-fetch (for an OTP that will never come). Drop it so the NEXT Start does a
			// REAL sign-in and sends a fresh OTP.
			ForgetSignin(r.Phone)
			return errOTPWindow
		}
		r.Verified = true
		if r.OnVerified != nil {
			r.OnVerified()
		}
	}
	// Auth is done (fresh login OR resumed session): from here a 401 means the access
	// token EXPIRED mid-flow, so let Do latch sessionDead and the steps bail for relogin.
	r.beginAuthPhase()

	// Upload sub-flow: appointment → (skip/upload) → overview+match → confirm center.
	// Retry the WHOLE sub-flow until success (Single mode) — the same live session
	// is reused and the pre-check overview skips already-uploaded files, so no
	// re-login is needed. An overview MISMATCH is a data problem (wrong PDFs) that
	// retrying can't fix, so that one stops immediately.
	if len(files) > 0 {
		for attempt := 1; !r.Stopped(); attempt++ {
			err := RunUpload(r, files, mission, ivacCenter)
			if r.SessionDead() {
				return errSessionExpired // token died mid-upload → relogin
			}
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
		if r.SessionDead() {
			return errSessionExpired
		}
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
			if r.SessionDead() {
				return errSessionExpired
			}
			return failOrStop(r, "reserve")
		}
	}

	// Initiate (dg-epay) → payment URL. Wait for the background dg-epay id first.
	r.ensureDgEpay()
	if res := r.RunStepSmart(StInitiate, StepInitiate); !res.Win {
		if r.SessionDead() {
			return errSessionExpired // 401 before payment URL → relogin (initiate NOT done)
		}
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
