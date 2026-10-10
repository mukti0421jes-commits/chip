package flow

import (
	"testing"
	"time"
)

type mockDoer401 struct{ status int }

func (m mockDoer401) Do(req Request) (Response, error) { return Response{Status: m.status}, nil }

// A 401 latches sessionDead ONLY after auth (post signin+verify). A 401 during
// sign-in must NOT be treated as an expiry.
func TestSessionDeadLatchesOnlyAfterAuth(t *testing.T) {
	r := NewRunner(&Config{}, Mode{}, nil, func(time.Duration) {})
	r.Doer = mockDoer401{status: 401}

	r.Do(Request{}) // before auth
	if r.SessionDead() {
		t.Fatal("401 must NOT latch session-dead before auth (it's a signin issue)")
	}
	r.beginAuthPhase()
	r.Do(Request{}) // after auth
	if !r.SessionDead() {
		t.Fatal("401 after auth must latch session-dead (token expired)")
	}
}

// RunStepSmart must stop retrying the moment the token dies (no hammering a dead token).
func TestRunStepSmartBailsOnSessionDead(t *testing.T) {
	r := NewRunner(&Config{}, Mode{Single: true}, nil, func(time.Duration) {})
	r.Doer = mockDoer401{status: 401}
	r.beginAuthPhase()
	calls := 0
	fn := func(rr *Runner) StepResult {
		calls++
		rr.Do(Request{}) // latches sessionDead via the 401
		return StepResult{Status: 401}
	}
	res := r.RunStepSmart(StBook, fn)
	if res.Win {
		t.Fatal("should not win")
	}
	if calls != 1 {
		t.Fatalf("must bail after ONE attempt on session-death, got %d calls", calls)
	}
}

// A 200 after auth must NOT latch session-dead.
func TestOKDoesNotLatchSessionDead(t *testing.T) {
	r := NewRunner(&Config{}, Mode{}, nil, func(time.Duration) {})
	r.Doer = mockDoer401{status: 200}
	r.beginAuthPhase()
	r.Do(Request{})
	if r.SessionDead() {
		t.Fatal("200 must not latch session-dead")
	}
}

func TestIsSessionExpired(t *testing.T) {
	if !IsSessionExpired(errSessionExpired) {
		t.Fatal("errSessionExpired must be detected")
	}
	if IsSessionExpired(errStopped) {
		t.Fatal("a non-session error must not be detected")
	}
	if IsSessionExpired(nil) {
		t.Fatal("nil must not be detected")
	}
}
