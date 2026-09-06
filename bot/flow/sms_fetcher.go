package flow

// StartSMSFetcher polls sms.php for the OTP, mirroring RJ SLOT startSmsFetcher +
// smsPollTick: wait SMSFirstDelay, then poll every SMSPollInterval up to
// SMSMaxAttempts. The first valid, not-yet-seen OTP is stored via r.SetOTP.
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
	for a := 0; a < SMSMaxAttempts && !r.Stopped() && r.otp() == ""; a++ {
		body, err := r.Fetcher.Get(url)
		if err == nil {
			if otp := ExtractOTP(body); otp != "" && !seen[otp] {
				seen[otp] = true
				r.SetOTP(otp)
				r.log("📩 OTP received: " + otp)
				return
			}
		}
		r.interruptibleSleep(SMSPollInterval) // Stop cancels the poll wait immediately
	}
}
