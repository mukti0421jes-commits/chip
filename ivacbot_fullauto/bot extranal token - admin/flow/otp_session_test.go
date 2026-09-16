package flow

import (
	"testing"
	"time"
)

func TestSigninGateBlocksSecondSignin(t *testing.T) {
	phone := "01700000001"
	ForgetSignin(phone)
	if _, _, _, ok := LiveSignin(phone); ok {
		t.Fatal("no signin recorded yet, but the gate says a session is live")
	}
	RememberSignin(phone, "tok-abc", "req-123")
	tok, rid, left, ok := LiveSignin(phone)
	if !ok || tok != "tok-abc" || rid != "req-123" {
		t.Fatalf("gate lost the session: ok=%v tok=%q rid=%q", ok, tok, rid)
	}
	if left <= 0 || left > SigninSessionTTL {
		t.Fatalf("bad remaining window: %v", left)
	}
	ForgetSignin(phone)
	if _, _, _, ok := LiveSignin(phone); ok {
		t.Fatal("ForgetSignin did not close the window")
	}
}

func TestSigninGateExpires(t *testing.T) {
	phone := "01700000002"
	signinMu.Lock()
	signinGate[phone] = &signinSession{accessToken: "t", requestID: "r", at: time.Now().Add(-SigninSessionTTL - time.Second)}
	signinMu.Unlock()
	if _, _, _, ok := LiveSignin(phone); ok {
		t.Fatal("an expired window must not block a new signin")
	}
}

func TestUsedOTPIsNeverReused(t *testing.T) {
	phone := "01700000003"
	MarkOTPUsed(phone, "123456")
	if !OTPUsed(phone, "123456") {
		t.Fatal("a consumed OTP was not remembered")
	}
	if OTPUsed(phone, "654321") {
		t.Fatal("an unrelated OTP was reported as used")
	}
	ForgetUsedOTP(phone, "123456")
	if OTPUsed(phone, "123456") {
		t.Fatal("ForgetUsedOTP did not clear the mark")
	}
}

// TestRunnerRejectsStaleOTP is the 15-minute-logout bug: the previous session's
// OTP is still on sms.php, and the flow must wait for the new one instead of
// verifying with it. A manually typed code still wins.
func TestRunnerRejectsStaleOTP(t *testing.T) {
	r := NewRunner(NewConfig(), Mode{}, func(string) {}, func(time.Duration) {})
	r.Phone = "01700000004"
	ForgetSignin(r.Phone)

	r.RejectOTP("111111") // the old session's OTP, read off sms.php before signin
	if r.SetOTP("111111") {
		t.Fatal("the previous session's OTP was accepted")
	}
	if r.otp() != "" {
		t.Fatalf("stale OTP leaked into the run: %q", r.otp())
	}
	if !r.SetOTP("222222") {
		t.Fatal("the new OTP was rejected")
	}
	if r.otp() != "222222" {
		t.Fatalf("new OTP not stored: %q", r.otp())
	}

	r.ClearOTP()
	if r.otp() != "" {
		t.Fatal("ClearOTP left an OTP behind")
	}

	// a typed code overrides the guard
	r.SetOTPManual("111111")
	if r.otp() != "111111" {
		t.Fatalf("manual OTP was blocked: %q", r.otp())
	}
}

// TestSetOTPDropsAlreadyHeldStaleCode covers RejectOTP arriving after the code was
// already loaded (e.g. it was carried over from the previous run).
func TestSetOTPDropsAlreadyHeldStaleCode(t *testing.T) {
	r := NewRunner(NewConfig(), Mode{}, func(string) {}, func(time.Duration) {})
	r.Phone = "01700000005"
	if !r.SetOTP("333333") {
		t.Fatal("first OTP rejected")
	}
	r.RejectOTP("333333")
	if r.otp() != "" {
		t.Fatalf("a code marked stale is still held: %q", r.otp())
	}
}

// fakeSMS serves a scripted sequence of sms.php responses.
type fakeSMS struct {
	bodies []string
	n      int
}

func (f *fakeSMS) Get(string) (string, error) {
	i := f.n
	if i >= len(f.bodies) {
		i = len(f.bodies) - 1
	}
	f.n++
	return f.bodies[i], nil
}

func otpJSON(otp string) string { return `{"status":"success","otp":"` + otp + `"}` }

// TestFetcherWaitsForNewOTP is the end-to-end shape of the reported bug: sms.php
// still holds the previous session's OTP when the new sign-in starts, and the
// fetcher must skip it and only take the OTP that arrives afterwards.
func TestFetcherWaitsForNewOTP(t *testing.T) {
	r := NewRunner(NewConfig(), Mode{}, func(string) {}, func(time.Duration) {}) // no real sleeping
	r.Phone = "01700000006"
	r.Fetcher = &fakeSMS{bodies: []string{
		otpJSON("555555"), // baseline read: the OLD code
		otpJSON("555555"), // still the old one
		otpJSON("555555"),
		otpJSON("777777"), // the new SMS finally lands
	}}

	PrimeOTPBaseline(r, r.Phone)
	if !r.IsStaleOTP("555555") {
		t.Fatal("the OTP already on sms.php was not marked stale")
	}

	StartSMSFetcher(r, r.Phone)
	if got := r.otp(); got != "777777" {
		t.Fatalf("fetcher took the wrong OTP: got %q want 777777", got)
	}
}
