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
			// Decode the live dg-epay uuid straight out of the bundle's obfuscated
			// fragments (fast, generic). Fall back to the old goja extractor only if
			// the fast path finds nothing.
			id := ScanDgEpayUUID(combined)
			if id == "" {
				id = ScanDgEpay(combined)
			}
			j.id = id
			close(j.done)
		}()
	})
	return j
}

// ── Shared endpoint+cipher scan (single-flight, process-wide) ─────────────────
// Like dg-epay, the plain scan (bundle download + endpoint regex + cipher goja) is
// IDENTICAL for every instance running against the same live bundle. Doing it per
// instance means N downloads of the same file + N goja cipher runs. So we run it
// ONCE per TTL window and let every instance share that live result. It stays live:
// when IVAC redeploys the bundle text differs and (after the TTL) it re-scans.

type sharedScanResult struct {
	done     chan struct{}
	bundle   string // the bundle URL this scan actually downloaded
	combined string
	ep       EndpointScan
	cipher   CipherScan
	cipherOK bool
}

var (
	sharedScanMu  sync.Mutex
	sharedScanCur *sharedScanResult
	sharedScanAt  time.Time
)

const sharedScanTTL = 5 * time.Minute

// ClearScanCache drops the shared scan result so the next Scan re-downloads and
// re-parses the live bundle (used by the dashboard Clean Cache button).
func ClearScanCache() {
	sharedScanMu.Lock()
	sharedScanCur = nil
	sharedScanMu.Unlock()
}

// getSharedScan returns a process-wide endpoint+cipher scan, downloading + parsing
// the live bundle at most once per TTL. The FIRST caller does the work (retrying
// while the bundle isn't ready); callers arriving while it runs wait on the same
// job; callers within the TTL after it finished get the cached result instantly.
// Returns nil if the bundle stayed unreachable (caller falls back to built-ins).
// waitScanDone blocks until the shared scan finishes, but returns false early if
// Stop is pressed — so an instance the user stopped never hangs behind a scan that
// is still retrying (e.g. an unreachable bundle behind a dead proxy). This is why
// "Stop All" now takes effect immediately even mid-scan.
func waitScanDone(done <-chan struct{}, stopped func() bool) bool {
	t := time.NewTicker(150 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-done:
			return true
		case <-t.C:
			if stopped() {
				return false
			}
		}
	}
}

func getSharedScan(f Fetcher, origin string, stopped func() bool, sleep func(time.Duration), log func(string)) *sharedScanResult {
	sharedScanMu.Lock()
	if sharedScanCur != nil && time.Since(sharedScanAt) < sharedScanTTL {
		j := sharedScanCur
		sharedScanMu.Unlock()
		if !waitScanDone(j.done, stopped) {
			return nil // user stopped while waiting for the shared scan
		}
		if j.combined == "" {
			return nil
		}
		log("♻ scan: reusing shared live-scan result (same bundle)")
		return j
	}
	j := &sharedScanResult{done: make(chan struct{})}
	sharedScanCur = j
	sharedScanAt = time.Now()
	sharedScanMu.Unlock()

	// FIRST caller does the actual download + parse. RETRY UNTIL SUCCESS: keep
	// trying the live bundle every 2s until it is found or the user presses Stop.
	// Each attempt runs in a goroutine, and the wait is a Stop-aware select, so
	// pressing Stop aborts within ~150ms instead of blocking on the HTTP timeout.
	type fetchOut struct {
		combined, bundle, probe, probeErr string
	}
	var combined string
	for attempt := 1; !stopped(); attempt++ {
		doProbe := attempt == 1
		resCh := make(chan fetchOut, 1) // buffered: an abandoned attempt never blocks
		go func() {
			var out fetchOut
			if urls := FindBundleURLs(f, origin); len(urls) > 0 {
				if c, _ := DownloadBundles(f, urls); c != "" {
					out.combined, out.bundle = c, urls[0]
				}
			}
			if out.combined == "" && doProbe {
				if body, err := f.Get(origin + "/"); err != nil {
					out.probeErr = err.Error()
				} else {
					if len(body) > 120 {
						body = body[:120]
					}
					out.probe = body
				}
			}
			resCh <- out
		}()
		var res fetchOut
		got := false
		wait := time.NewTicker(150 * time.Millisecond)
	waitLoop:
		for {
			select {
			case res = <-resCh:
				got = true
				break waitLoop
			case <-wait.C:
				if stopped() {
					break waitLoop
				}
			}
		}
		wait.Stop()
		if stopped() {
			break
		}
		if got && res.combined != "" {
			combined = res.combined
			j.bundle = res.bundle
			log("🔍 Bundle found (try " + itoa(attempt) + ") — scanning…")
			break
		}
		if got && doProbe {
			if res.probeErr != "" {
				log("🔎 A_E fetch error: " + res.probeErr)
			} else {
				log("🔎 A_E origin returned: " + res.probe)
			}
		}
		log("⏳ A_E: bundle not ready (try " + itoa(attempt) + ") — retry in 2s (until success)")
		sleep(2 * time.Second)
	}
	j.combined = combined
	if combined != "" {
		j.ep = ScanEndpoints(combined) // ~0.3s
		if cs, err := ScanCipher(combined); err == nil {
			j.cipher = cs
			j.cipherOK = true
		} else {
			log("⚠ cipher scan failed: " + err.Error() + " — using fallback")
		}
	}
	close(j.done)

	if combined == "" {
		// don't cache a failure for the whole TTL — clear so the next call retries live.
		sharedScanMu.Lock()
		if sharedScanCur == j {
			sharedScanCur = nil
		}
		sharedScanMu.Unlock()
		return nil
	}
	return j
}

// ensureDgEpay waits (interruptibly, capped) for the background dg-epay job to
// finish and applies the id to the runner's Config. Safe to call when no job was
// started (keeps the existing fallback/manual id).
func (r *Runner) ensureDgEpay() {
	// Manual legacy override wins — force the dg-epay uuid path, skip the scan.
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
			r.Config.noteSource("dgepayId", SrcScan)
			r.log("💳 dg-epay id ready (live scan): " + r.dgJob.id)
			if r.OnScanIDs != nil {
				r.OnScanIDs(r.Config.SlotID, r.Config.DgepayID) // auto-fill dashboard input
			}
		} else if imp, origin := r.Config.ImportedDgepayID(); imp != "" {
			// the bundle never carries this uuid in the clear, so a recorded real
			// request is the only other place it can come from
			r.Config.DgepayID = imp
			r.Config.noteSource("dgepayId", origin)
			r.log("📥 " + origin + ": dg-epay id → " + imp + " (bundle resolve korte pareni)")
			if r.OnScanIDs != nil {
				r.OnScanIDs(r.Config.SlotID, r.Config.DgepayID)
			}
		} else {
			r.log("⚠ dg-epay id not resolved — using fallback/manual id (" + r.Config.DgepayID + ")")
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
