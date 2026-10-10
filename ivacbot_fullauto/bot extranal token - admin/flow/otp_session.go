package flow

import (
	"sync"
	"time"
)

// ── Sign-in (OTP) session window ─────────────────────────────────────────────
//
// IVAC SENDS THE OTP as part of a successful sign-in, and that login session
// stays alive for ~15 minutes. Signing in again inside that window re-sends the
// OTP, invalidates the one already delivered, and quickly trips HTTP 429
// "Too many attempts". So once a sign-in succeeds for a phone, every later
// sign-in attempt for the SAME phone is skipped until the window closes — the
// live accessToken/requestId is reused instead.

// SigninSessionTTL is how long one successful sign-in (and the OTP it sent)
// stays valid. No new sign-in is attempted for that phone until it elapses.
const SigninSessionTTL = 15 * time.Minute

type signinSession struct {
	accessToken string
	requestID   string
	at          time.Time
}

var (
	signinMu   sync.Mutex
	signinGate = map[string]*signinSession{}
)

// RememberSignin opens the OTP window for phone after a successful sign-in.
func RememberSignin(phone, accessToken, requestID string) {
	if phone == "" {
		return
	}
	signinMu.Lock()
	signinGate[phone] = &signinSession{accessToken: accessToken, requestID: requestID, at: time.Now()}
	signinMu.Unlock()
}

// LiveSignin reports the still-open OTP window for phone: the session's
// accessToken/requestId and how much of the 15 minutes is left. ok is false once
// the window has closed (then a fresh sign-in is allowed).
func LiveSignin(phone string) (accessToken, requestID string, left time.Duration, ok bool) {
	if phone == "" {
		return "", "", 0, false
	}
	signinMu.Lock()
	defer signinMu.Unlock()
	s := signinGate[phone]
	if s == nil {
		return "", "", 0, false
	}
	left = SigninSessionTTL - time.Since(s.at)
	if left <= 0 {
		delete(signinGate, phone)
		return "", "", 0, false
	}
	// A session with no requestId is useless to verify — treat it as no session.
	if s.requestID == "" && s.accessToken == "" {
		delete(signinGate, phone)
		return "", "", 0, false
	}
	return s.accessToken, s.requestID, left, true
}

// ForgetSignin closes phone's OTP window, so the next attempt signs in again
// immediately (used when the server rejects the session as dead).
func ForgetSignin(phone string) {
	signinMu.Lock()
	delete(signinGate, phone)
	signinMu.Unlock()
}

// ── Consumed-OTP memory ──────────────────────────────────────────────────────
//
// An OTP is single-use. The old flow kept the last OTP sitting in the dashboard
// input and in the runner, so after a 15-minute logout the next login verified
// with the PREVIOUS code before the new SMS had even reached sms.php. Every OTP
// that has been used (or that was already sitting on sms.php when a new sign-in
// started) is remembered here and never verified again.

const usedOTPTTL = 2 * time.Hour

var (
	usedOTPMu sync.Mutex
	usedOTPs  = map[string]map[string]time.Time{} // phone → otp → when it was consumed
)

// MarkOTPUsed records that otp has been consumed for phone.
func MarkOTPUsed(phone, otp string) {
	if phone == "" || otp == "" {
		return
	}
	usedOTPMu.Lock()
	defer usedOTPMu.Unlock()
	m := usedOTPs[phone]
	if m == nil {
		m = map[string]time.Time{}
		usedOTPs[phone] = m
	}
	m[otp] = time.Now()
	for k, t := range m { // cheap TTL sweep
		if time.Since(t) > usedOTPTTL {
			delete(m, k)
		}
	}
}

// OTPUsed reports whether otp has already been consumed for phone.
func OTPUsed(phone, otp string) bool {
	if phone == "" || otp == "" {
		return false
	}
	usedOTPMu.Lock()
	defer usedOTPMu.Unlock()
	t, ok := usedOTPs[phone][otp]
	if !ok {
		return false
	}
	if time.Since(t) > usedOTPTTL {
		delete(usedOTPs[phone], otp)
		return false
	}
	return true
}

// ForgetUsedOTP un-marks an OTP (a manually typed code always wins — the user is
// looking at the SMS, so their code is the truth).
func ForgetUsedOTP(phone, otp string) {
	if phone == "" || otp == "" {
		return
	}
	usedOTPMu.Lock()
	if m := usedOTPs[phone]; m != nil {
		delete(m, otp)
	}
	usedOTPMu.Unlock()
}
