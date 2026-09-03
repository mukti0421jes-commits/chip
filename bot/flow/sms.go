package flow

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

// SMS OTP auto-fetch — byte-exact from RJ SLOT v10.5 (fetchSmsOnce / smsPollTick).
const (
	SMSServer       = "https://duttauzzal.shop/sms.php"
	SMSFirstDelay   = 4000 * time.Millisecond // SMS_FIRST_DELAY_MS
	SMSPollInterval = 2000 * time.Millisecond // SMS_POLL_INTERVAL_MS
	SMSMaxAttempts  = 40                       // SMS_MAX_ATTEMPTS
)

var otpDigits = regexp.MustCompile(`^\d{4,8}$`)

// SMSURL builds the poll URL: sms.php?action=get_latest_otp&mobile_no=<digits-only phone>.
func SMSURL(phone string) string {
	clean := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, phone)
	return SMSServer + "?action=get_latest_otp&mobile_no=" + clean
}

// ExtractOTP mirrors extractOtpFromResponse: parse JSON, require status=="success"
// and a non-empty otp matching /^\d{4,8}$/. Returns "" when no valid OTP.
func ExtractOTP(rawText string) string {
	if rawText == "" {
		return ""
	}
	var d struct {
		Status string          `json:"status"`
		OTP    json.RawMessage `json:"otp"`
	}
	if err := json.Unmarshal([]byte(rawText), &d); err != nil {
		return ""
	}
	if d.Status != "success" || len(d.OTP) == 0 {
		return ""
	}
	// otp may be a JSON string ("1234") or a number (1234) — String(d.otp) in JS.
	s := strings.Trim(strings.TrimSpace(string(d.OTP)), `"`)
	if otpDigits.MatchString(s) {
		return s
	}
	return ""
}
