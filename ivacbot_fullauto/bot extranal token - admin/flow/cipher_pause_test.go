package flow

import (
	"sync/atomic"
	"testing"
	"time"
)

// A cipher/verification failure must PAUSE the signin loop (no hammering) and resume
// only when a STRICTLY NEWER ivacflow push arrives — then the step is retried and wins.
func TestCipherPauseResumesOnNewerPush(t *testing.T) {
	var version uint64 // 0 = nothing pushed yet
	var applied atomic.Bool
	r := NewRunner(&Config{}, Mode{Single: true}, nil, func(time.Duration) { time.Sleep(time.Millisecond) })
	r.IvacflowVersion = func() uint64 { return atomic.LoadUint64(&version) }
	r.OnCipherFail = func() bool {
		if atomic.LoadUint64(&version) == 0 {
			return false // no push to apply yet
		}
		applied.Store(true)
		return true
	}
	var attempts int32
	step := func(rr *Runner) StepResult {
		n := atomic.AddInt32(&attempts, 1)
		if n == 1 {
			return StepResult{Status: 400, CipherFail: true} // first try: wrong cipher
		}
		if applied.Load() {
			return StepResult{Win: true} // resumed with the correct cipher → success
		}
		return StepResult{Status: 400, CipherFail: true}
	}
	// simulate ivacflow_FINAL pushing the correct cipher a moment later
	go func() { time.Sleep(10 * time.Millisecond); atomic.StoreUint64(&version, 1) }()

	res := r.RunStepSmart(StSignin, step)
	if !res.Win {
		t.Fatalf("expected resume+win after newer push, got %+v", res)
	}
	if !applied.Load() {
		t.Fatal("cipher fix was never applied")
	}
	if atomic.LoadInt32(&attempts) < 2 {
		t.Fatalf("step should have been retried after resume, attempts=%d", attempts)
	}
}

// A NON-cipher failure (e.g. a 500, or a missing captcha token where CipherFail is
// never set) must NOT pause and must NOT touch the ivacflow fallback.
func TestNonCipherFailNoPause(t *testing.T) {
	r := NewRunner(&Config{}, Mode{Single: false}, nil, func(time.Duration) {})
	r.IvacflowVersion = func() uint64 { return 0 }
	r.OnCipherFail = func() bool { t.Fatal("OnCipherFail must not be called for a non-cipher failure"); return false }
	res := r.RunStepSmart(StSignin, func(rr *Runner) StepResult {
		return StepResult{Status: 500, CipherFail: false}
	})
	if res.Win || res.Cancelled {
		t.Fatalf("expected immediate non-win return (retry off), got %+v", res)
	}
}

// Stop pressed while paused must return Cancelled promptly (no forever-wait).
func TestCipherPauseStopReturnsCancelled(t *testing.T) {
	r := NewRunner(&Config{}, Mode{Single: true}, nil, func(time.Duration) { time.Sleep(time.Millisecond) })
	r.IvacflowVersion = func() uint64 { return 0 } // no push ever
	r.OnCipherFail = func() bool { return false }
	go func() { time.Sleep(15 * time.Millisecond); r.Stop() }()
	res := r.RunStepSmart(StSignin, func(rr *Runner) StepResult {
		return StepResult{Status: 400, CipherFail: true}
	})
	if !res.Cancelled {
		t.Fatalf("expected Cancelled after Stop while paused, got %+v", res)
	}
}

// Resume must be delayed by this instance's CipherResumeStagger (herd-spread), and a
// Stop during that stagger must still return Cancelled.
func TestCipherResumeStaggered(t *testing.T) {
	var version uint64
	r := NewRunner(&Config{}, Mode{Single: true}, nil, func(d time.Duration) { time.Sleep(d) })
	r.CipherResumeStagger = 120 * time.Millisecond
	r.IvacflowVersion = func() uint64 { return atomic.LoadUint64(&version) }
	r.OnCipherFail = func() bool { return atomic.LoadUint64(&version) > 0 }
	step := func(rr *Runner) StepResult {
		if atomic.LoadUint64(&version) > 0 {
			return StepResult{Win: true}
		}
		return StepResult{Status: 400, CipherFail: true}
	}
	// first attempt fails (v0); push arrives shortly, then resume must wait the stagger
	go func() { time.Sleep(10 * time.Millisecond); atomic.StoreUint64(&version, 1) }()
	start := time.Now()
	res := r.RunStepSmart(StSignin, step)
	elapsed := time.Since(start)
	if !res.Win {
		t.Fatalf("expected win, got %+v", res)
	}
	if elapsed < 120*time.Millisecond {
		t.Fatalf("resume should have waited the stagger (~120ms after push), took %v", elapsed)
	}
}

// The same already-tried push must NOT resume the loop: only a strictly newer version
// does. This proves it won't re-apply the same wrong cipher in a tight loop.
func TestCipherPauseIgnoresSameVersion(t *testing.T) {
	var version uint64 = 5
	calls := 0
	r := NewRunner(&Config{}, Mode{Single: true}, nil, func(time.Duration) { time.Sleep(time.Millisecond) })
	r.IvacflowVersion = func() uint64 { return atomic.LoadUint64(&version) }
	r.OnCipherFail = func() bool { calls++; return true }
	step := func(rr *Runner) StepResult {
		// wins only once v6 is out; before that every attempt is a cipher failure, so
		// the loop must PAUSE on v5 and not re-apply v5 in a spin — it waits for v6.
		if atomic.LoadUint64(&version) >= 6 {
			return StepResult{Win: true}
		}
		return StepResult{Status: 400, CipherFail: true}
	}
	go func() { time.Sleep(12 * time.Millisecond); atomic.StoreUint64(&version, 6) }()
	res := r.RunStepSmart(StSignin, step)
	if !res.Win {
		t.Fatalf("expected win after v6, got %+v", res)
	}
	if calls != 2 { // exactly once for v5, once for v6 — never re-applied v5 in a spin
		t.Fatalf("OnCipherFail should apply once per new version (v5,v6) = 2, got %d", calls)
	}
}
