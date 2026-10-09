package flow

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

// StepResult mirrors RJ SLOT's { win, cancelled, data } step return.
type StepResult struct {
	Win       bool
	Cancelled bool
	Data      interface{}
	Status    int  // HTTP status of the attempt (0 = network/other). 429 → 20s wait.
	CipherFail bool // the SERVER rejected the request for a cipher/captcha-verification
	// reason (encryption of `c` is wrong) — NOT a missing captcha token or a network
	// error. Set only from the server response (isCipherFail). Drives the #1 PAUSE:
	// RunStepSmart stops retrying and waits for a fresh ivacflow cipher+endpoint push.
	RetryAfter time.Duration // server-scheduled wait parsed from a 429 body ("try after
	// X minute Y seconds"). When >0 the retry waits EXACTLY this, not the fixed delay.
	HardStop bool // an UNRECOVERABLE, do-not-retry condition (e.g. sign-in "too many
	// attempts" server lockout). RunStepSmart returns immediately WITHOUT retrying, and
	// the caller auto-stops the instance (manual restart only).
}

// StepFunc runs one attempt of a step. It should return Win=true on success and
// respect stop (checking Stopped()) to bail out promptly.
type StepFunc func(r *Runner) StepResult

// StepName identifies a pipeline step.
type StepName string

const (
	StSignin   StepName = "signin"
	StVerify   StepName = "verify"
	StUpload   StepName = "upload"
	StBook     StepName = "book"
	StReserve  StepName = "reserve"
	StInitiate StepName = "initiate"
)

// StepOrder mirrors RJ SLOT STEP_ORDER = ['signin','verify','book','reserve','initiate'].
var StepOrder = []StepName{StSignin, StVerify, StBook, StReserve, StInitiate}

// Mode controls how a step is driven, mirroring RJ SLOT's Single / Auto toggles.
type Mode struct {
	Single bool          // retry a failed step until success (RJ SLOT "Single")
	Auto   bool          // after a step wins, chain to the next (RJ SLOT "Auto")
	Delay  time.Duration // default per-step retry delay (getStepDelaySec)
	// StepDelays overrides Delay per step (RJ SLOT's Sign/Verify/Resrv/Book/Init
	// boxes). When a step has no entry, Delay is used.
	StepDelays map[StepName]time.Duration
}

// delayFor returns the retry delay for a step: its own configured value, else the
// mode default, else the RJ SLOT built-in (Reserve = 21s to avoid concurrent
// reserve → 429; everything else 4s).
func (r *Runner) delayFor(name StepName) time.Duration {
	// LIVE: if a runtime delay provider is set (reads the dashboard's retry-delay
	// controller fresh each call), it wins — so changing a value mid-run makes the
	// NEXT retry use the new value. Returns seconds; <0 means "not set, fall back".
	if r.LiveDelaySec != nil {
		if sec := r.LiveDelaySec(name); sec >= 0 {
			return time.Duration(sec) * time.Second
		}
	}
	if r.Mode.StepDelays != nil {
		if d, ok := r.Mode.StepDelays[name]; ok && d > 0 {
			return d
		}
	}
	if r.Mode.Delay > 0 {
		if name == StReserve && r.Mode.Delay < 21*time.Second {
			return 21 * time.Second // reserve needs the longer gap
		}
		return r.Mode.Delay
	}
	if name == StReserve {
		return 21 * time.Second
	}
	return 4 * time.Second
}

// Runner holds live flow state: the scanned Config, a stop flag, a logger, and a
// sleep hook (so tests run without real waits). It is the Go equivalent of the
// userscript's global sessionState + stopFlag + logStatus.
type Runner struct {
	Config *Config
	Mode   Mode

	// dependencies
	Doer    Doer          // HTTP sender (H2 client in the bot; mock in tests)
	Tokens  TokenProvider // captcha token source (Signin-purpose)
	// ReserveTokens is the RESERVE-purpose captcha source. Signin and Reserve tokens
	// come from DIFFERENT Turnstile widgets and are NOT interchangeable — submitting
	// a Signin token to reserve fails with "Captcha verification failed". When nil,
	// StepReserve falls back to Tokens (old behavior).
	ReserveTokens TokenProvider
	Fetcher       Fetcher // plain GET (SMS OTP poll, bundle download)
	// ScanFetcher, when set, is used ONLY for the bundle discovery + download during
	// Scan(), instead of Fetcher. It is wired to a DIRECT (no-proxy) client so the
	// live cipher/endpoint scan works on every instance regardless of that instance's
	// routing mode: the bundle is public IVAC JS, needs no proxy, and a dead proxy
	// must never stall the scan (the scan retries until success). When nil, Scan falls
	// back to Fetcher (old behavior). SMS polling and all API calls still use the
	// instance's own proxy-aware clients.
	ScanFetcher   Fetcher

	// inputs
	Phone    string
	OTPPhone string // number the OTP SMS lands on (defaults to Phone if empty)
	Password string

	// session state filled as steps win
	AccessToken     string
	RequestID       string
	Verified        bool   // OTP verified in this session (resume: skip signin+verify)
	AppointmentID    string
	AppointmentDate  string   // reserve date (from Book / picker), YYYY-MM-DD
	AppointmentDates []string // all available open dates from get-booking-config (normalized, sorted)
	PickLatestDate   bool     // RJ SLOT date-target-toggle: true = Latest (last), false = Earliest (first)
	// ReserveStartOffset staggers the reserve date-sweep across instances (round-robin):
	// instance N begins its sweep at dates[(offset)%len] and wraps around, so 10
	// instances don't all hammer date #1 at once. Default 0 = start at the first date
	// (unchanged single-instance behavior). Set per-instance by the handler.
	ReserveStartOffset int
	ReservationID    string
	PaymentURL      string

	// appointmentSetupDone: the POST /appointment that sets up the upload context has
	// succeeded once this session. The upload sub-flow is retried as a whole (e.g.
	// after an over-view hiccup); re-POSTing /appointment on each retry risks resetting
	// the server-side appointment so over-view would see it empty → 400. RJ SLOT creates
	// it exactly once, so we guard it the same way — uploaded applicants persist on the
	// server across the retries.
	appointmentSetupDone bool

	otpVal string // OTP fetched by the SMS/email fetcher
	// otpStale holds every OTP this run must never verify with: the code that was
	// already sitting on sms.php when this sign-in started (the PREVIOUS session's
	// OTP) plus every code already consumed for this phone. Without it the flow
	// verifies with the old OTP before the new SMS arrives.
	otpStale map[string]bool

	// fatalUpload, when set by uploadOne (e.g. appointment expired >30 days), makes
	// the upload sub-flow stop retrying and surface this exact error.
	fatalUpload error

	dgJob *dgJob // background dg-epay resolution (awaited before Initiate)

	// LiveScanTries caps how many times the live bundle scan is attempted before it
	// gives up and falls back (store → built-in). It is the dashboard-controlled count
	// ("Full Auto → live scan try কতবার"). 0 means unlimited (retry until success or
	// Stop), preserving the old behavior when the dashboard leaves it unset.
	LiveScanTries int

	// ReloginMode marks a run that is RE-LOGGING IN after a session expired (auto-off →
	// wait → relogin). ONLY in this mode does a signin 429 honor the server's own "try
	// after X min Y sec" schedule (RunStepSmart). Normal signin/reserve retries ignore
	// it and keep the configured delay. Default false.
	ReloginMode bool

	// authPhase turns true once sign-in + OTP verify have succeeded. Only THEN is a
	// 401 treated as an expired access token (session death) — a 401 during sign-in is
	// a credential/cipher issue, not an expiry. sessionDead latches when Do sees that
	// 401, so the token-using steps bail instead of retrying with a dead token, and
	// RunFullAuto returns errSessionExpired for the handler's relogin loop.
	authPhase   bool
	sessionDead bool

	// scanAborted is set by Scan() when Full Auto's LIVE-ONLY scan fails (no fallback):
	// RunFullAuto checks it right after Scan() and stops before signin, so the instance
	// never runs on store/built-in config. Play All (CacheOnly) never sets this.
	scanAborted bool

	// CacheOnly (Play All) makes Scan() skip the live bundle download entirely and
	// run straight from the last-good store (cached cipher + endpoints), then the
	// pushed endpoint-cache, then the built-in fallback. Nothing hits the network for
	// the scan. Default false = normal Full Auto (live scan first).
	CacheOnly bool

	// scannedBundle is the live bundle basename this run resolved against (full scan
	// or reused snapshot). Used to persist a fresh last-good snapshot on success.
	scannedBundle string
	// OnScanResolved fires with a serialized last-good snapshot after a successful
	// run, so the caller can persist it (last_good_config.json) for smart-skip.
	OnScanResolved func(snapshot []byte)

	// RefreshFallbacks re-reads the latest fallback captures (ivacflow + recorder) so
	// a mid-scan ivacflow push can be applied immediately. Set by the adapter.
	RefreshFallbacks func() []*Imported

	// optional hooks — fired the moment a value is resolved, so the caller can
	// persist it (e.g. appointmentId → instance field, survives re-login).
	OnAppointment func(id, date string)
	OnReservation func(id string)
	// OnScanIDs fires after the A_E scan with the resolved slot + dg-epay ids, so
	// the dashboard inputs can auto-fill with what was detected.
	OnScanIDs func(slotID, dgepayID string)
	// resume hooks — persist the live session so stop → start continues in place.
	OnSignedIn func(accessToken, requestID string)
	OnVerified func()
	OnOTP      func(otp string) // OTP fetched → show it live in the dashboard
	// OnScanComplete fires once the A_E bundle scan has resolved every detail the
	// flow needs (endpoints, cipher, slot id). ok=false means the bundle was
	// unreachable and built-in fallbacks are in use. The dashboard uses it to play
	// the "UPDATE SUCCESSFULLY" announcement right before sign-in starts.
	OnScanComplete func(ok bool, detail string)

	// OnCipherFail is fired when signin/reserve is rejected with a cipher-related
	// error (HTTP 400 or "captcha verification failed"). The caller re-applies the
	// NEWEST ivacflow push (cipher skip/len/key/algo + endpoints) to this run's
	// Config and returns true if a fresh config was applied — the next retry then
	// uses ivacflow's correct cipher/endpoints. Returns false when ivacflow has not
	// pushed yet, in which case the retry loop simply waits and asks again. Nil = no
	// ivacflow fallback wired (behaves exactly as before).
	OnCipherFail func() bool
	// IvacflowVersion returns a counter that increments on every ivacflow push. The
	// #1 PAUSE uses it to tell a NEW correct-cipher push apart from the same one it
	// already tried: while paused it applies OnCipherFail only when this number has
	// moved past lastCipherVer. Nil = no version gating (best-effort apply-and-resume).
	IvacflowVersion func() uint64
	// lastCipherVer is the ivacflow version this runner last applied via the cipher
	// fix, so a pause waits for a strictly newer push instead of re-applying the same.
	lastCipherVer uint64
	// CipherResumeStagger spreads the signin RESUME across instances after a shared
	// ivacflow push: when 30 paused instances all see the same new cipher at once,
	// resuming together would fire 30 signins in the same instant → HTTP 429. Each
	// instance waits its own (index-based) stagger before resuming, so the herd is
	// spread out. 0 = resume immediately (single instance / not set).
	CipherResumeStagger time.Duration

	// LiveDelaySec (optional) returns the CURRENT retry delay in seconds for a step,
	// read fresh from the dashboard controller on every retry, so a value the user
	// changes mid-run takes effect on the next retry. Return <0 to fall back to Mode.
	LiveDelaySec func(StepName) int

	stop       atomic.Bool
	stopCtx    context.Context    // cancelled when Stop is called → aborts in-flight HTTP
	stopCancel context.CancelFunc // set in NewRunner
	log        func(string)
	sleep      func(time.Duration)
	mu         sync.Mutex
}

// Do sends a request through the runner's Doer with the runner's stop context
// attached, so pressing Stop cancels an in-flight HTTP call immediately instead
// of letting it run to its timeout. Every step uses this instead of r.Doer.Do.
func (r *Runner) Do(req Request) (Response, error) {
	if r.stopCtx != nil {
		req.Ctx = r.stopCtx
	}
	resp, err := r.Doer.Do(req)
	// After auth, a 401 means the access token expired mid-flow → latch sessionDead so
	// the token-using steps stop retrying a dead token and the run relogs in.
	if err == nil && resp.Status == 401 {
		r.mu.Lock()
		auth := r.authPhase
		if auth {
			r.sessionDead = true
		}
		r.mu.Unlock()
	}
	return resp, err
}

// SessionDead reports whether a post-auth 401 latched (the access token expired).
func (r *Runner) SessionDead() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sessionDead
}

// beginAuthPhase marks that sign-in + verify are done, so 401s now mean expiry.
func (r *Runner) beginAuthPhase() {
	r.mu.Lock()
	r.authPhase = true
	r.mu.Unlock()
}

// SetOTP stores an OTP fetched by the SMS/email fetcher (thread-safe). A stale
// code — the previous session's OTP, still sitting on sms.php, or one already
// consumed — is REJECTED: the flow keeps waiting for the new SMS instead of
// verifying with it. Returns false when the OTP was rejected.
func (r *Runner) SetOTP(otp string) bool {
	if otp == "" {
		return false
	}
	if r.IsStaleOTP(otp) {
		r.log("⛔ purono OTP " + otp + " ignore kora holo (ei code ta age use hoyeche) — notun OTP er jonno wait korchi")
		return false
	}
	r.mu.Lock()
	r.otpVal = otp
	r.mu.Unlock()
	if r.OnOTP != nil {
		r.OnOTP(otp)
	}
	return true
}

// SetOTPManual stores an OTP the user typed in the dashboard. A typed code always
// wins over the staleness guard — the user is reading it off their phone.
func (r *Runner) SetOTPManual(otp string) {
	if otp == "" {
		return
	}
	r.mu.Lock()
	if r.otpStale != nil {
		delete(r.otpStale, otp)
	}
	r.otpVal = otp
	r.mu.Unlock()
	ForgetUsedOTP(r.Phone, otp)
	r.log("⌨ Manual OTP set: " + otp)
	if r.OnOTP != nil {
		r.OnOTP(otp)
	}
}

// ClearOTP drops the OTP currently held by the run (and clears the dashboard's
// OTP cell), so a new login never starts out holding the old session's code.
func (r *Runner) ClearOTP() {
	r.mu.Lock()
	had := r.otpVal
	r.otpVal = ""
	r.mu.Unlock()
	if had != "" && r.OnOTP != nil {
		r.OnOTP("")
	}
}

// RejectOTP marks an OTP as unusable for this run.
func (r *Runner) RejectOTP(otp string) {
	if otp == "" {
		return
	}
	r.mu.Lock()
	if r.otpStale == nil {
		r.otpStale = map[string]bool{}
	}
	r.otpStale[otp] = true
	if r.otpVal == otp {
		r.otpVal = "" // it was already loaded — drop it
	}
	r.mu.Unlock()
}

// IsStaleOTP reports whether otp must not be used to verify.
func (r *Runner) IsStaleOTP(otp string) bool {
	r.mu.Lock()
	stale := r.otpStale[otp]
	r.mu.Unlock()
	return stale || OTPUsed(r.Phone, otp)
}

func (r *Runner) otp() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.otpVal
}

// NewRunner builds a Runner. logFn/sleepFn may be nil (defaults used).
func NewRunner(cfg *Config, mode Mode, logFn func(string), sleepFn func(time.Duration)) *Runner {
	if logFn == nil {
		logFn = func(string) {}
	}
	if sleepFn == nil {
		sleepFn = time.Sleep
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Runner{Config: cfg, Mode: mode, log: logFn, sleep: sleepFn, stopCtx: ctx, stopCancel: cancel}
}

// Stop signals every running/queued step to bail (RJ SLOT "Stop All"). It both
// sets the stop flag (checked by every loop/sleep) AND cancels the stop context
// (aborts any in-flight HTTP call), so Stop takes effect immediately everywhere.
func (r *Runner) Stop() {
	r.stop.Store(true)
	if r.stopCancel != nil {
		r.stopCancel()
	}
}

// Stopped reports whether Stop was called.
func (r *Runner) Stopped() bool { return r.stop.Load() }

// Logf logs through the runner's logger.
func (r *Runner) Logf(msg string) { r.log(msg) }

// RunStepSmart runs one step with RJ SLOT's runStepSmart semantics:
//   - run an attempt;
//   - win  → return success;
//   - stop → return cancelled;
//   - retry OFF (not Single) → return the failure immediately;
//   - retry ON  → wait the step delay, then try again, forever until win/stop.
func (r *Runner) RunStepSmart(name StepName, fn StepFunc) StepResult {
	for !r.Stopped() {
		res := fn(r)
		if res.Win {
			r.log("✓ " + string(name))
			return res
		}
		if r.Stopped() {
			return StepResult{Cancelled: true}
		}
		// UNRECOVERABLE lockout (e.g. sign-in "too many attempts") → never retry; return
		// so the caller can auto-stop the instance. Retrying would only extend the lockout.
		if res.HardStop {
			return res
		}
		// Access token died mid-flow (post-auth 401) → stop retrying a dead token; let
		// RunFullAuto see it and trigger the relogin.
		if r.SessionDead() {
			return res
		}
		// #1 PAUSE/RESUME: the SERVER rejected this for a cipher/verification reason —
		// the encryption (`c`) is wrong. Do NOT keep hammering with the wrong cipher.
		// Pause and wait until ivacflow_FINAL pushes a NEWER correct cipher+endpoints,
		// then resume THIS step (for signin that is exactly "restart from signin").
		// Engages only when the ivacflow fallback is wired (Full Auto); else falls
		// through to the normal retry. A missing captcha token / network error never
		// sets CipherFail, so those keep their normal behavior.
		if res.CipherFail && r.OnCipherFail != nil {
			if r.pauseForCipherFix(name) {
				continue // fresh cipher applied → retry immediately (no extra delay)
			}
			return StepResult{Cancelled: true} // Stop pressed while paused
		}
		if !r.Mode.Single {
			r.log("✗ " + string(name) + " failed — retry OFF")
			return res
		}
		// Retry gap: when RELOGIN mode is on (a session-expiry re-login) AND the server
		// sent a 429 with its own "try after X min Y sec" schedule, WAIT EXACTLY THAT so
		// the re-login lands when the server allows it. This applies ONLY to the
		// relogin path — normal signin/verify/reserve retries keep the configured delay.
		d := r.delayFor(name)
		if r.ReloginMode && res.RetryAfter > 0 {
			d = res.RetryAfter
			r.log("⏳ " + string(name) + " (relogin): server 429 — '" + d.String() + "' por retry (schedule mene, agei noy)")
		} else if res.Status == 429 {
			r.log("↻ " + string(name) + " retry — HTTP 429, waiting " + d.String())
		} else {
			r.log("↻ " + string(name) + " retry — waiting " + d.String())
		}
		r.interruptibleSleep(d)
	}
	return StepResult{Cancelled: true}
}

// RunStepSmartUntil is RunStepSmart with a hard DEADLINE: it retries the step until
// it wins or Stop is pressed, but gives up once time passes `deadline`, returning the
// last (non-win) result. Used for the OTP verify step so a run that never receives an
// OTP (auto or manual) stops after OTPVerifyLifetime instead of looping forever.
// res.Win reports success; when it returns not-won and not-cancelled, the deadline
// was hit (r.timedOut is left for the caller to distinguish via Stopped()).
func (r *Runner) RunStepSmartUntil(name StepName, fn StepFunc, deadline time.Time) StepResult {
	for !r.Stopped() {
		res := fn(r)
		if res.Win {
			r.log("✓ " + string(name))
			return res
		}
		if r.Stopped() {
			return StepResult{Cancelled: true}
		}
		if !r.Mode.Single {
			r.log("✗ " + string(name) + " failed — retry OFF")
			return res
		}
		if !time.Now().Before(deadline) {
			// window over — give up (caller treats a non-win, non-cancelled result as
			// the deadline having elapsed).
			return res
		}
		d := r.delayFor(name)
		// never sleep past the deadline, so the give-up is punctual.
		if left := time.Until(deadline); left < d {
			d = left
		}
		if d <= 0 {
			return res
		}
		r.interruptibleSleep(d)
	}
	return StepResult{Cancelled: true}
}

// pauseForCipherFix implements the #1 PAUSE: on a cipher/verification failure it
// first tries to apply an ivacflow config NEWER than the one already tried (resume
// at once if there is one); otherwise it PAUSES — no more attempts on this step —
// and polls until a newer ivacflow_FINAL push arrives, then applies it and resumes.
// Returns true to resume the step, false if Stop was pressed while paused.
func (r *Runner) pauseForCipherFix(name StepName) bool {
	if r.tryCipherFix(name) {
		return r.staggerResume(name)
	}
	r.log("⏸ " + string(name) + ": encryption vul (captcha verification failed) — loop PAUSE. " +
		"Bhul cipher diye ar cheshta hobe na; ivacflow_FINAL theke SOTHIK cipher+endpoint push asha porjonto wait korchi…")
	for !r.Stopped() {
		r.interruptibleSleep(2 * time.Second)
		if r.Stopped() {
			return false
		}
		if r.tryCipherFix(name) {
			return r.staggerResume(name)
		}
	}
	return false
}

// staggerResume delays this instance's resume by its own CipherResumeStagger so that
// many instances waking on the SAME ivacflow push don't all fire signin in the same
// instant (→ HTTP 429). Interruptible: Stop during the stagger returns false.
func (r *Runner) staggerResume(name StepName) bool {
	if r.CipherResumeStagger > 0 && !r.Stopped() {
		r.log("⏱ " + string(name) + ": resume stagger " + r.CipherResumeStagger.String() +
			" — ek shathe onek instance signin na kore chhoriye jacche")
		r.interruptibleSleep(r.CipherResumeStagger)
	}
	return !r.Stopped()
}

// tryCipherFix applies the newest ivacflow push, but only when it is STRICTLY newer
// than the one this runner last applied in the pause (so it does not re-apply the
// same wrong cipher in a tight loop). Returns true when a fresh config was applied.
// With no version hook wired it falls back to a best-effort single apply.
func (r *Runner) tryCipherFix(name StepName) bool {
	if r.OnCipherFail == nil {
		return false
	}
	if r.IvacflowVersion != nil {
		ver := r.IvacflowVersion()
		if ver == r.lastCipherVer {
			return false // same push already tried → keep waiting for a newer one
		}
		if r.OnCipherFail() {
			r.lastCipherVer = ver
			r.log("▶ " + string(name) + ": notun ivacflow cipher+endpoint (v" + itoa(int(ver)) +
				") apply kora holo — " + string(name) + " theke abar auto flow chalu")
			return true
		}
		return false
	}
	// no version gating available — best-effort apply-and-resume (legacy behavior)
	if r.OnCipherFail() {
		r.log("▶ " + string(name) + ": ivacflow cipher+endpoint apply kora holo — abar cheshta")
		return true
	}
	return false
}

// interruptibleSleep waits for d, but returns early if Stop is called. It sleeps
// in ≤1s slices (matching RJ SLOT's per-second stop check in runStepSmart).
func (r *Runner) interruptibleSleep(d time.Duration) {
	const slice = time.Second
	for d > 0 && !r.Stopped() {
		step := slice
		if d < step {
			step = d
		}
		r.sleep(step)
		d -= step
	}
}

// RunPipeline runs steps from startStep onward, mirroring startPipelineFrom:
// in Auto mode it continues to the last step; otherwise it runs only startStep.
// It stops at the first step that does not win. Returns the last step's result.
func (r *Runner) RunPipeline(startStep StepName, factory map[StepName]StepFunc) StepResult {
	startIdx := indexOfStep(startStep)
	if startIdx < 0 {
		return StepResult{}
	}
	endIdx := startIdx
	if r.Mode.Auto {
		endIdx = len(StepOrder) - 1
	}
	var last StepResult
	for i := startIdx; i <= endIdx && !r.Stopped(); i++ {
		step := StepOrder[i]
		fn := factory[step]
		if fn == nil {
			continue
		}
		last = r.RunStepSmart(step, fn)
		if !last.Win {
			if !r.Stopped() {
				r.log("⏹ Stopped at " + string(step))
			}
			break
		}
	}
	return last
}

func indexOfStep(s StepName) int {
	for i, x := range StepOrder {
		if x == s {
			return i
		}
	}
	return -1
}
