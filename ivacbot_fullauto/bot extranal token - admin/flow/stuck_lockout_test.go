package flow

import (
	"testing"
	"time"
)

// isTooManyAttempts must fire on the server lockout wording (any common phrasing)
// and must NOT fire on an ordinary rejection.
func TestIsTooManyAttempts(t *testing.T) {
	hits := []string{
		`{"message":"Too many attempts, please try again later"}`,
		`{"message":"TOO MANY REQUESTS"}`,
		`too many tries`,
		`Too many login attempts`,
	}
	for _, b := range hits {
		if !isTooManyAttempts(b) {
			t.Fatalf("expected lockout detected for %q", b)
		}
	}
	misses := []string{
		`{"message":"Captcha verification failed"}`,
		`{"message":"Invalid credentials"}`,
		``,
		`please try again`,
	}
	for _, b := range misses {
		if isTooManyAttempts(b) {
			t.Fatalf("did NOT expect lockout for %q", b)
		}
	}
}

// RunStepSmart must return immediately on a HardStop result — no retry, even in
// Single (retry-forever) mode — so a "too many attempts" lockout auto-stops.
func TestRunStepSmartHardStopNoRetry(t *testing.T) {
	r := NewRunner(&Config{}, Mode{Single: true, Delay: time.Second}, func(string) {}, func(time.Duration) {})
	calls := 0
	res := r.RunStepSmart(StSignin, func(*Runner) StepResult {
		calls++
		return StepResult{HardStop: true, Status: 429}
	})
	if res.Win {
		t.Fatal("HardStop result must not be Win")
	}
	if !res.HardStop {
		t.Fatal("HardStop flag must propagate out of RunStepSmart")
	}
	if calls != 1 {
		t.Fatalf("expected exactly 1 attempt (no retry), got %d", calls)
	}
}

// errTooManyAttempts must read as a STOP (handler marks STOPPED, not FAILED) and
// must NOT be mistaken for a session-expiry (which would trigger auto-relogin).
func TestTooManyAttemptsIsStopNotRelogin(t *testing.T) {
	if IsSessionExpired(errTooManyAttempts) {
		t.Fatal("too-many-attempts must NOT be treated as session-expiry (no relogin)")
	}
	if !containsStop(errTooManyAttempts.Error()) {
		t.Fatalf("too-many-attempts message must contain 'stop' so handler marks STOPPED: %q", errTooManyAttempts.Error())
	}
}

// containsStop mirrors the handler's `strings.Contains(err.Error(), "stop")` check.
func containsStop(s string) bool {
	for i := 0; i+4 <= len(s); i++ {
		if s[i:i+4] == "stop" {
			return true
		}
	}
	return false
}
