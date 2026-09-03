package flow

import (
	"hash/fnv"
	"strconv"
	"sync"
	"time"
)

// dg-epay resolution is a ~37s goja deobfuscation. Running it inline on every
// Full Auto pegs a CPU core, starving the HTTP server and captcha pool. Instead
// we resolve it in the BACKGROUND — exactly once per bundle across the whole
// process — and let the pipeline wait for it only at the Initiate step (which is
// last, so the OTP/upload/book/reserve time usually covers it).

type dgJob struct {
	once sync.Once
	done chan struct{}
	id   string
}

var (
	dgJobsMu sync.Mutex
	dgJobs   = map[uint64]*dgJob{}
)

func bundleKey(b string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(strconv.Itoa(len(b))))
	h.Write([]byte(b))
	return h.Sum64()
}

// StartDgEpayResolve kicks (once per bundle) a single background dg-epay
// resolution and returns a job whose done channel closes when the id is ready.
func StartDgEpayResolve(combined string) *dgJob {
	key := bundleKey(combined)
	dgJobsMu.Lock()
	j, ok := dgJobs[key]
	if !ok {
		j = &dgJob{done: make(chan struct{})}
		dgJobs[key] = j
	}
	dgJobsMu.Unlock()
	j.once.Do(func() {
		go func() {
			j.id = ScanDgEpay(combined) // ScanDgEpay has its own content cache
			close(j.done)
		}()
	})
	return j
}

// ensureDgEpay waits (interruptibly, capped) for the background dg-epay job to
// finish and applies the id to the runner's Config. Safe to call when no job was
// started (keeps the existing fallback/manual id).
func (r *Runner) ensureDgEpay() {
	// Manual override wins — no need to wait for the background scan.
	if r.Config.ForcedDgepayID != "" {
		r.Config.DgepayID = r.Config.ForcedDgepayID
		r.log("📌 dg-epay id (manual): " + r.Config.DgepayID)
		return
	}
	if r.dgJob == nil {
		return
	}
	apply := func() {
		if r.dgJob.id != "" {
			r.Config.DgepayID = r.dgJob.id
			r.log("💳 dg-epay id ready (live scan): " + r.dgJob.id)
			if r.OnScanIDs != nil {
				r.OnScanIDs(r.Config.SlotID, r.Config.DgepayID) // auto-fill dashboard input
			}
		} else {
			r.log("⚠ dg-epay not resolved — using fallback/manual id")
		}
	}
	select {
	case <-r.dgJob.done:
		apply()
		return
	default:
	}
	r.log("⏳ Waiting for dg-epay id (background deobfuscation)…")
	const maxWait = 90 * time.Second
	deadline := time.Now().Add(maxWait)
	for time.Now().Before(deadline) && !r.Stopped() {
		select {
		case <-r.dgJob.done:
			apply()
			return
		case <-time.After(500 * time.Millisecond):
		}
	}
	if !r.Stopped() {
		r.log("⚠ dg-epay wait timed out — using fallback/manual id")
	}
}
