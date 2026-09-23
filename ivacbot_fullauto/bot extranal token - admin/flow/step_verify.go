package flow

import "encoding/json"

type verifyResponse struct {
	SuccessFlag bool   `json:"successFlag"`
	Message     string `json:"message"`
	Data        struct {
		Verified bool `json:"verified"`
	} `json:"data"`
}

// isVerified mirrors RJ SLOT isVerifiedResponse.
func isVerified(body verifyResponse) bool {
	return body.SuccessFlag || body.Message == "Success" || body.Data.Verified
}

// StepVerify runs one OTP-verify attempt (RJ SLOT stepVerify). It requires the
// OTP already fetched into r (the SMS fetcher / caller sets r via SetOTP), plus a
// live session (AccessToken + RequestID from signin).
func StepVerify(r *Runner) StepResult {
	otp := r.otp()
	if otp == "" {
		r.log("⏳ Waiting for OTP…")
		return StepResult{}
	}
	// Never verify with a code that has already been used, or that was sitting on
	// sms.php from the previous session — wait for the new SMS instead.
	if r.IsStaleOTP(otp) {
		r.ClearOTP()
		r.log("⛔ Purono OTP (" + otp + ") diye verify kora hobe na — notun OTP er jonno wait korchi")
		return StepResult{}
	}
	if r.RequestID == "" {
		r.log("❌ No session (requestId missing from signin)")
		return StepResult{}
	}
	req, err := BuildVerify(VerifyParams{
		RequestID:   r.RequestID,
		Phone:       r.Phone,
		Code:        otp,
		AccessToken: r.AccessToken,
	})
	if err != nil {
		return StepResult{}
	}
	req.URL = r.Config.VerifyURL()

	resp, err := r.Do(req)
	if err != nil {
		if r.Stopped() {
			return StepResult{Cancelled: true}
		}
		r.log("✗ verify: " + err.Error())
		return StepResult{}
	}
	var body verifyResponse
	_ = json.Unmarshal(resp.Body, &body)
	if isVerified(body) {
		// Burn the code: it is single-use, so no later run may verify with it again.
		MarkOTPUsed(r.Phone, otp)
		r.RejectOTP(otp)
		r.log("✅ OTP Verified")
		return StepResult{Win: true, Data: body}
	}
	return StepResult{Status: resp.Status}
}
