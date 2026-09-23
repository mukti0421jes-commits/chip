package flow

import (
	"errors"
	"strings"
)

// RunPhaseA is the start of RJ SLOT Full Auto (the A_E block the user described):
//
//	A_E click → bundle live-scan (encryption + endpoint + slot + dg-epay)
//	         → Signin (retry with delay until success)
//	         → OTP auto-fetch from sms.php + auto-input
//	         → auto-Verify
//
// bundle is the fetched site JS. When it is empty the scan is skipped and the
// hardcoded fallbacks in Config are used (RJ SLOT keeps hardcode as fallback).
func RunPhaseA(r *Runner, bundle string) error {
	// 1) LIVE SCAN — fill Config from the bundle (endpoint literals, slot id, cipher).
	if strings.TrimSpace(bundle) != "" {
		r.Config.ApplyEndpointScan(ScanEndpoints(bundle))
		if cs, err := ScanCipher(bundle); err == nil {
			r.Config.ApplyCipherScan(cs)
		}
		r.log("🔍 Scan: signin=" + r.Config.SigninURL() + " slot=" + r.Config.SlotID)
	} else {
		r.log("⚠ No bundle — using hardcoded endpoint fallback")
	}

	// 2) SIGNIN — retry with delay until success (RJ SLOT runStepSmart Single).
	if res := r.RunStepSmart(StSignin, StepSignin); !res.Win {
		if r.Stopped() {
			return errors.New("stopped at signin")
		}
		return errors.New("signin failed")
	}

	// 3) OTP AUTO-FETCH — start the SMS poller; it fills r.otp when the OTP arrives.
	go StartSMSFetcher(r, r.Phone)

	// 4) VERIFY — retries (waiting for the OTP the poller supplies) until verified.
	if res := r.RunStepSmart(StVerify, StepVerify); !res.Win {
		if r.Stopped() {
			return errors.New("stopped at verify")
		}
		return errors.New("verify failed")
	}
	r.log("✅ Phase A complete (signed in + verified)")
	return nil
}
