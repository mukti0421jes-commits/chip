package flow

import "testing"

// IsOTPWindow must detect the OTP-window auto-stop (so the handler clears the cache),
// and must NOT match other stop/expiry errors.
func TestIsOTPWindow(t *testing.T) {
	if !IsOTPWindow(errOTPWindow) {
		t.Fatal("errOTPWindow must be detected")
	}
	if IsOTPWindow(errSessionExpired) {
		t.Fatal("session-expired must NOT be an OTP-window")
	}
	if IsOTPWindow(errTooManyAttempts) {
		t.Fatal("too-many-attempts must NOT be an OTP-window")
	}
	if IsOTPWindow(nil) {
		t.Fatal("nil must NOT be an OTP-window")
	}
}

// After the OTP window, ForgetSignin must close the sign-in window so LiveSignin no
// longer reports a reusable session — i.e. the next Start will sign in fresh.
func TestForgetSigninAfterOTPWindowForcesFreshSignin(t *testing.T) {
	const phone = "01999000111"
	RememberSignin(phone, "tok-xyz", "req-123")
	if _, _, _, ok := LiveSignin(phone); !ok {
		t.Fatal("precondition: a fresh signin window should be live")
	}
	// what fullauto.go does on OTP-window expiry:
	ForgetSignin(phone)
	if _, _, _, ok := LiveSignin(phone); ok {
		t.Fatal("after ForgetSignin the window must be closed → next attempt signs in fresh")
	}
}
