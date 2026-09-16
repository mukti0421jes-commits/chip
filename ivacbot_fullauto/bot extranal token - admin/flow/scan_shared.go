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
func getSharedScan(f Fetcher, origin string, stopped func() bool, sleep func(time.Duration), log func(string)) *sharedScanResult {
	sharedScanMu.Lock()
	if sharedScanCur != nil && time.Since(sharedScanAt) < sharedScanTTL {
		j := sharedScanCur
		sharedScanMu.Unlock()
		<-j.done
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

	// FIRST caller does the actual download + parse (RJ SLOT A_E retry loop).
	const maxTries = 8
	var combined string
	for attempt := 1; attempt <= maxTries && !stopped(); attempt++ {
		urls := FindBundleURLs(f, origin)
		if len(urls) > 0 {
			if c, _ := DownloadBundles(f, urls); c != "" {
				combined = c
				log("🔍 Bundle found (try " + itoa(attempt) + ", " + itoa(len(urls)) + " chunk) — scanning…")
				break
			}
		}
		if attempt == 1 {
			body, err := f.Get(origin + "/")
			if err != nil {
				log("🔎 A_E fetch error: " + err.Error())
			} else {
				snip := body
				if len(snip) > 120 {
					snip = snip[:120]
				}
				log("🔎 A_E origin returned " + itoa(len(body)) + " bytes: " + snip)
			}
		}
		log("⏳ A_E: bundle not ready (try " + itoa(attempt) + "/" + itoa(maxTries) + ") — retry in 2s")
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
			r.log("💳 dg-epay id ready (live scan): " + r.dgJob.id)
			if r.OnScanIDs != nil {
				r.OnScanIDs(r.Config.SlotID, r.Config.DgepayID) // auto-fill dashboard input
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
