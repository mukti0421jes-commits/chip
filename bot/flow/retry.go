package flow

import (
	"sync"
	"sync/atomic"
	"time"
)

// StepResult mirrors RJ SLOT's { win, cancelled, data } step return.
type StepResult struct {
	Win       bool
	Cancelled bool
	Data      interface{}
	Status    int // HTTP status of the attempt (0 = network/other). 429 → 20s wait.
}

// StepFunc runs one attempt of a step. It should return Win=true on success and
// respect stop (checking Stopped()) to bail out promptly.
type StepFunc func(r *Runner) StepResult

// StepName identifies a pipeline step.
type StepName string

const (
	StSignin   StepName = "signin"
	StVerify   StepName = "verify"
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
	ReservationID    string
	PaymentURL      string

	otpVal string // OTP fetched by the SMS/email fetcher

	dgJob *dgJob // background dg-epay resolution (awaited before Initiate)

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

	// LiveDelaySec (optional) returns the CURRENT retry delay in seconds for a step,
	// read fresh from the dashboard controller on every retry, so a value the user
	// changes mid-run takes effect on the next retry. Return <0 to fall back to Mode.
	LiveDelaySec func(StepName) int

	stop  atomic.Bool
	log   func(string)
	sleep func(time.Duration)
	mu    sync.Mutex
}

// SetOTP stores an OTP fetched by the SMS/email fetcher (thread-safe).
func (r *Runner) SetOTP(otp string) {
	r.mu.Lock()
	r.otpVal = otp
	r.mu.Unlock()
	if r.OnOTP != nil {
		r.OnOTP(otp)
	}
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
	return &Runner{Config: cfg, Mode: mode, log: logFn, sleep: sleepFn}
}

// Stop signals every running/queued step to bail (RJ SLOT "Stop All").
func (r *Runner) Stop() { r.stop.Store(true) }

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
		if !r.Mode.Single {
			r.log("✗ " + string(name) + " failed — retry OFF")
			return res
		}
		// Retry gap = the step's configured delay (dashboard retry-delay controller,
		// via Mode.StepDelays), so the UI value actually drives the wait. 429 is a
		// rate-limit — log it, but still honor the configured delay.
		d := r.delayFor(name)
		if res.Status == 429 {
			r.log("↻ " + string(name) + " retry — HTTP 429, waiting " + d.String())
		} else {
			r.log("↻ " + string(name) + " retry — waiting " + d.String())
		}
		r.interruptibleSleep(d)
	}
	return StepResult{Cancelled: true}
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
