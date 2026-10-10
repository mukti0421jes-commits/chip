package flow

import "time"

// SMSWaitForNewMax bounds how long the fetcher keeps waiting when sms.php is
// still serving the PREVIOUS session's OTP. The new SMS normally lands within a
// minute; this is the give-up point (after it, a manually typed OTP still works).
const SMSWaitForNewMax = 5 * time.Minute

// PrimeOTPBaseline reads whatever OTP sms.php is holding RIGHT NOW — before a new
// sign-in sends a new one — and marks it stale. That code belongs to the previous
// session, so the flow must never verify with it; it waits for the next SMS.
//
// This is what stops the 15-minute-logout bug: after the session expires and the
// bot logs in again, the old OTP is still on the server (and in the dashboard
// input), and the old flow verified with it before the new SMS arrived.
func PrimeOTPBaseline(r *Runner, phone string) {
	if r.Fetcher == nil || phone == "" {
		return
	}
	body, err := r.Fetcher.Get(SMSURL(phone))
	if err != nil {
		return
	}
	if old := ExtractOTP(body); old != "" {
		r.RejectOTP(old)
		r.log("🔁 sms.php e ekhono purono OTP (" + old + ") ache — eta skip kore notun OTP er jonno wait korbo")
	}
}

// StartSMSFetcher polls sms.php for the OTP, mirroring RJ SLOT startSmsFetcher +
// smsPollTick: wait SMSFirstDelay, then poll every SMSPollInterval. The first
// valid OTP that is NOT stale (not the previous session's code, not one already
// consumed) is stored via r.SetOTP.
//
// It keeps polling past SMSMaxAttempts while the only thing sms.php returns is a
// stale code, up to SMSWaitForNewMax — waiting for the new SMS is the whole point.
//
// It runs synchronously; the orchestrator launches it in a goroutine so the
// verify step (which waits for the OTP) can proceed in parallel.
func StartSMSFetcher(r *Runner, phone string) {
	if r.Fetcher == nil {
		return
	}
	url := SMSURL(phone)
	seen := map[string]bool{}
	r.interruptibleSleep(SMSFirstDelay)

	// AUTO OTP fetch: poll the php SMS server at most SMSAutoMaxAttempts (10) times for
	// THIS instance. Each try is logged (success / server-or-proxy error / no OTP yet /
	// still-stale code) so a silent failure is never invisible. The first fresh, non-
	// stale OTP is stored and stops the loop. If all tries are spent without one, the
	// auto-fetch stops here and the flow falls back to a manually typed OTP (the verify
	// step keeps waiting until OTPVerifyLifetime elapses).
	for a := 1; a <= SMSAutoMaxAttempts && !r.Stopped() && r.otp() == ""; a++ {
		tag := "(try " + itoa(a) + "/" + itoa(SMSAutoMaxAttempts) + ")"
		body, err := r.Fetcher.Get(url)
		switch {
		case err != nil:
			r.log("⚠ Auto OTP fetch " + tag + " — server/proxy error: " + err.Error())
		default:
			otp := ExtractOTP(body)
			switch {
			case otp == "":
				r.log("⏳ Auto OTP fetch " + tag + " — OTP ekhono php server e ashe ni")
			case r.IsStaleOTP(otp):
				// The server is still serving the OLD code — do NOT verify with it.
				r.log("⏳ Auto OTP fetch " + tag + " — purono OTP (" + otp + ") dicche, notun OTP wait korchi")
			case !seen[otp]:
				seen[otp] = true
				if r.SetOTP(otp) {
					r.log("📩 Auto OTP paowa gelo " + tag + ": " + otp)
					return
				}
			}
		}
		if a < SMSAutoMaxAttempts {
			r.interruptibleSleep(SMSPollInterval) // Stop cancels the poll wait immediately
		}
	}
	if !r.Stopped() && r.otp() == "" {
		r.log("⌛ Auto OTP fetch bondho — " + itoa(SMSAutoMaxAttempts) +
			" bar try kore notun OTP paowa jayni. Dashboard theke manual OTP din (OTP window " +
			OTPVerifyLifetime.String() + ").")
	}
}
