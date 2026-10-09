package main

import (
	"net/http"
	"strconv"
	"sync"
	"time"

	"ivac-bot/flow"
)

// ── Adapters wiring the bot's real H2 client + captcha into the flow module ──

// proxyRotateThreshold: how many CONSECUTIVE proxy faults on the current proxy before
// the instance rotates to the next one. A success (any normal server reply) resets the
// streak, so a healthy proxy is carried on; only a repeatedly-failing one is swapped.
const proxyRotateThreshold = 3

// h2ClientFor builds the utls/HTTP-2 client for a proxy (empty = direct), with the
// standard 45s cap so a dead endpoint never hangs forever.
func h2ClientFor(proxyURL string) *http.Client {
	c := newH2Client(proxyURL)
	if c.Timeout == 0 {
		c.Timeout = 45 * time.Second
	}
	return c
}

// flowDoer implements flow.Doer using the bot's utls/HTTP-2 client (newH2Client).
// onHTTP (optional) is fired after every API call with the URL + HTTP status, so
// the dashboard can show live per-step ENDPOINT + STATUS (200/403/503/…).
//
// CONDITIONAL PROXY ROTATION: the current proxy is kept as long as it works. A
// "proxy fault" (transport error/timeout, or an IP-block/overload status like
// 403/429/502/504/52x) increments a streak; after `threshold` consecutive faults the
// doer rotates to the next enabled proxy (round-robin) and rebuilds the client. Any
// normal server reply (200/400/401/404/… — the proxy reached IVAC) resets the streak,
// so a good proxy is never rotated for an app-level error.
type flowDoer struct {
	mu        sync.Mutex
	hd        *flow.HTTPDoer
	onHTTP    func(url string, status int)
	log       func(string)
	curProxy  string
	errStreak int
	threshold int
}

func newFlowDoer(proxyURL string, onHTTP func(string, int), logFn func(string)) *flowDoer {
	return &flowDoer{
		hd:        &flow.HTTPDoer{Client: h2ClientFor(proxyURL)},
		onHTTP:    onHTTP,
		log:       logFn,
		curProxy:  proxyURL,
		threshold: proxyRotateThreshold,
	}
}

func (d *flowDoer) Do(req flow.Request) (flow.Response, error) {
	d.mu.Lock()
	hd := d.hd
	d.mu.Unlock()

	resp, err := hd.Do(req)
	if d.onHTTP != nil {
		st := 0
		if err == nil {
			st = resp.Status
		}
		d.onHTTP(req.URL, st)
	}
	d.noteResult(resp.Status, err)
	return resp, err
}

// noteResult updates the proxy-fault streak and rotates when it reaches the threshold.
func (d *flowDoer) noteResult(status int, err error) {
	// P_rotate master toggle: when OFF, never rotate — each instance keeps its assigned
	// proxy regardless of errors (streak not even tracked, so turning it ON later starts
	// clean). Checked outside the lock; it's a cheap RLock read.
	if !proxyRotateEnabled() {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if !isProxyFault(status, err) {
		d.errStreak = 0 // proxy reached the server → it's healthy, carry on
		return
	}
	d.errStreak++
	if d.errStreak < d.threshold {
		return
	}
	// threshold reached → rotate to the next enabled proxy (if any other exists)
	next := nextEnabledProxyURL(d.curProxy)
	d.errStreak = 0
	if next == "" || next == d.curProxy {
		if d.log != nil {
			d.log("⚠ proxy rotate skip — onno kono enabled proxy nei (eki proxy diye cholbe)")
		}
		return
	}
	old := d.curProxy
	d.curProxy = next
	d.hd = &flow.HTTPDoer{Client: h2ClientFor(next)}
	if d.log != nil {
		d.log("🔄 proxy rotate (" + strconv.Itoa(d.threshold) + " ta error por): " + maskProxy(old) + " → " + maskProxy(next))
	}
}

// isProxyFault reports whether a request result points at the PROXY/IP (not the app).
// Transport errors (connection refused, TLS, timeout) and IP-block / overload statuses
// count; normal app replies (200/400/401/404/409/500/503…) do NOT — those mean the
// proxy reached IVAC fine, so the proxy is healthy and the streak resets.
func isProxyFault(status int, err error) bool {
	if err != nil {
		return true
	}
	switch status {
	case 403, 407, 408, 429, 502, 504, 520, 521, 522, 523, 524, 525:
		return true
	}
	return false
}

// nextEnabledProxyURL returns the enabled proxy that follows `current` in round-robin
// order, or "" when there is no OTHER enabled proxy to rotate to.
func nextEnabledProxyURL(current string) string {
	var urls []string
	for _, p := range getEnabledProxies() {
		if p.Enabled {
			urls = append(urls, getProxyURL(p))
		}
	}
	if len(urls) == 0 {
		return ""
	}
	if len(urls) == 1 {
		if urls[0] == current {
			return "" // only one proxy → nothing else to rotate to
		}
		return urls[0]
	}
	for i, u := range urls {
		if u == current {
			return urls[(i+1)%len(urls)]
		}
	}
	return urls[0] // current not in the enabled list → start at the first
}

// flowTokens implements flow.TokenProvider using the bot's captcha queue. It
// returns the RAW Turnstile token — the flow encrypts it per purpose itself
// (signin/reserve) or sends it raw (initiate/upload), byte-faithful to RJ SLOT.
type flowTokens struct{ purpose string }

func (t flowTokens) GetCaptchaToken() (string, error) {
	// AUTO FAILOVER: get a raw token from the active source (relay or API — the
	// dashboard toggle), and if that source can't hand one out (relay empty/unreachable,
	// or the API errors), fall back to the OTHER kind automatically for this one pull.
	// pullRawFailover also consumes the pre-warmed API queue first when API is active.
	return captchaMgr.pullRawFailover(t.purpose)
}

// flowFetcher implements flow.Fetcher (plain GET) for the SMS OTP poll + bundle
// download, over the same H2 client.
type flowFetcher struct{ hf *flow.HTTPFetcher }

func newFlowFetcher(proxyURL string) flowFetcher {
	c := newH2Client(proxyURL)
	if c.Timeout == 0 {
		c.Timeout = 20 * time.Second // bundle/SMS GET must not hang forever
	}
	return flowFetcher{hf: &flow.HTTPFetcher{Client: c}}
}

func (f flowFetcher) Get(url string) (string, error) { return f.hf.Get(url) }

// FullAutoInput carries everything one Full Auto run needs (from a File Manager entry).
type FullAutoInput struct {
	Phone      string
	OTPPhone   string
	Password   string
	Mission    string
	IvacCenter string
	Files         []flow.PDFFile
	ProxyURL      string
	Single        bool
	Auto          bool
	// CacheOnly (Play All) skips the live bundle scan and runs straight from the
	// last-good store (cached cipher + endpoints). Full Auto All leaves it false.
	CacheOnly     bool
	DelaySec      int
	// StepDelays are the per-step retry delays (seconds) from the dashboard's
	// retry-delay controller — keys: signin/verify/book/reserve/initiate. When set,
	// they drive each step's retry gap (incl. reserve's rate-limit/date-sweep wait).
	StepDelays    map[string]int
	// LiveDelaySec (optional) returns the CURRENT per-step retry delay (seconds),
	// read live from the dashboard each retry so a mid-run change takes effect on the
	// next retry. Keys: signin/verify/book/reserve/initiate. Return <0 to fall back.
	LiveDelaySec  func(step string) int
	AppointmentID string // pre-known id → get-booking-config smart-skip (re-login)
	// ReserveStartOffset staggers the reserve date-sweep across instances (round-robin):
	// instance N starts its sweep at a different date so N instances don't all hit
	// date #1 at once. Typically the instance id; 0 = start at the first date.
	ReserveStartOffset int
	// CipherResumeStagger spreads the signin RESUME across instances after a shared
	// ivacflow cipher push (so 30 paused instances don't all fire signin at once →
	// HTTP 429). Typically instanceIndex × a small unit. 0 = resume immediately.
	CipherResumeStagger time.Duration
	// ReloginMode: this run is a RE-LOGIN after a session expiry. Only then does a
	// signin 429 honor the server's "try after X min Y sec" schedule.
	ReloginMode bool
	Log         func(string)

	// resume state (stop → start): a still-live session skips signin/OTP/verify.
	PreAccessToken   string
	PreRequestID     string
	PreVerified      bool
	PreReservationID string

	// persistence hooks — fired the moment a value is resolved.
	OnAppointment func(id, date string)
	OnReservation func(id string)
	OnScanIDs     func(slotID, dgepayID string)
	OnSignedIn    func(accessToken, requestID string)
	OnVerified    func()
	OnHTTP        func(url string, status int) // live endpoint + HTTP status per call
	OnOTP         func(otp string)             // OTP fetched → show in table
	// OnScanComplete fires when the A_E bundle scan has resolved every detail the
	// pipeline needs. The dashboard plays the loud "UPDATE SUCCESSFULLY"
	// announcement on ok=true, right before sign-in starts.
	OnScanComplete func(ok bool, detail string)

	// RegisterStop receives the runner's Stop func so the caller can cancel the
	// whole pipeline (Stop button) from outside.
	RegisterStop func(stop func())
	// RegisterSetOTP receives the runner's SetOTP func so the dashboard can inject a
	// MANUALLY-typed OTP into a running flow — a fallback when the auto SMS fetch is
	// slow/times out. The next Verify retry uses whichever OTP arrives first.
	RegisterSetOTP func(set func(otp string))
	// RegisterClearOTP receives the runner's ClearOTP func so the dashboard's Clean
	// Cache button can wipe the OTP held by a RUNNING flow too (not just the one
	// shown in the table).
	RegisterClearOTP func(clear func())
	// RegisterRejectOTP receives the runner's RejectOTP func. Clearing an OTP from
	// the dashboard must ALSO blacklist it, or the SMS poller simply picks the same
	// stale code straight back up from sms.php.
	RegisterRejectOTP func(reject func(otp string))
}

// RunFullAutoForEntry runs the RJ SLOT Full Auto pipeline for one entry, using
// the bot's real H2 client + captcha queue. It performs: A_E scan → signin →
// OTP+verify → upload → book → reserve → initiate. Returns the payment URL.
func RunFullAutoForEntry(in FullAutoInput) (string, error) {
	cfg := flow.NewConfig() // dynamic headers (nav/runtime) filled by scan/runtime; VRequestMeta defaults to "windos.s"

	// Apply the UI-controlled encrypt-token toggles (dashboard checkboxes). Either
	// the env var (NewConfig) OR the dashboard setting turns a purpose ON.
	configMu.RLock()
	cfg.EncryptUpload = cfg.EncryptUpload || globalConfig.EncryptUpload
	cfg.EncryptInitiate = cfg.EncryptInitiate || globalConfig.EncryptInitiate
	configMu.RUnlock()

	// Hand the latest pushed endpoint-cache to this run; Scan applies it only when
	// its bundleName matches the live bundle.
	cfg.EndpointCacheJSON = currentEndpointCache()
	// Hand the last-good snapshot so Scan can smart-skip when the bundle is unchanged.
	cfg.LastGoodJSON = currentLastGood()

	mode := flow.Mode{Single: in.Single, Auto: in.Auto, Delay: time.Duration(in.DelaySec) * time.Second}
	// wire the dashboard's per-step retry delays into the flow so the UI controller
	// actually drives each step's retry gap (signin/verify/book/reserve/initiate).
	if len(in.StepDelays) > 0 {
		keyMap := map[string]flow.StepName{
			"signin": flow.StSignin, "verify": flow.StVerify, "upload": flow.StUpload,
			"book": flow.StBook, "reserve": flow.StReserve, "initiate": flow.StInitiate,
		}
		mode.StepDelays = map[flow.StepName]time.Duration{}
		for k, sec := range in.StepDelays {
			if sn, ok := keyMap[k]; ok && sec > 0 {
				mode.StepDelays[sn] = time.Duration(sec) * time.Second
			}
		}
	}
	r := flow.NewRunner(cfg, mode, in.Log, nil)
	r.Doer = newFlowDoer(in.ProxyURL, in.OnHTTP, in.Log)
	r.OnOTP = in.OnOTP
	r.Fetcher = newFlowFetcher(in.ProxyURL)
	// The live bundle scan always goes DIRECT (no proxy), independent of this
	// instance's routing mode: the bundle is public IVAC JS that needs no proxy, and a
	// dead/absent proxy must never stall the scan. Instances that have no proxy already
	// use direct for everything; this makes the SCAN direct for proxied instances too.
	r.ScanFetcher = newFlowFetcher("")
	// Dashboard-controlled: how many times the live scan is attempted before falling
	// back to the store (endpoint-cache/last-good) and then the built-in config.
	configMu.RLock()
	r.LiveScanTries = globalConfig.LiveScanTries
	configMu.RUnlock()
	r.CacheOnly = in.CacheOnly // Play All: skip live scan, run from last-good store
	r.Tokens = flowTokens{purpose: "Signin"}
	// Reserve draws from the SAME shared token pool now (unifyPurpose collapses every
	// purpose to one pool), so signin/reserve/upload/initiate all take from one place.
	r.ReserveTokens = flowTokens{purpose: "Reserve"}
	r.Phone = in.Phone
	r.OTPPhone = in.OTPPhone
	r.Password = in.Password
	r.AppointmentID = in.AppointmentID // enables get-booking-config smart-skip
	r.ReserveStartOffset = in.ReserveStartOffset   // round-robin reserve date-sweep start
	r.CipherResumeStagger = in.CipherResumeStagger // spread signin resume across instances
	r.ReloginMode = in.ReloginMode                 // relogin run: honor 429 schedule on signin
	// resume: preload a still-live session so signin/OTP/verify/reserve are skipped
	r.AccessToken = in.PreAccessToken
	r.RequestID = in.PreRequestID
	r.Verified = in.PreVerified
	r.ReservationID = in.PreReservationID
	r.OnAppointment = in.OnAppointment
	r.OnReservation = in.OnReservation
	r.OnScanIDs = in.OnScanIDs
	r.OnScanResolved = saveLastGood // persist last-good snapshot for smart-skip
	r.OnSignedIn = in.OnSignedIn
	r.OnVerified = in.OnVerified
	r.OnScanComplete = func(ok bool, detail string) {
		publishScanSources(cfg.Source) // dashboard: where each value came from
		if in.OnScanComplete != nil {
			in.OnScanComplete(ok, detail)
		}
	}
	// #1 cipher-fail fallback: when signin/reserve is rejected for a cipher/captcha
	// reason, re-apply the NEWEST ivacflow push (autoflow_FINAL: correct cipher
	// skip/len/key/algo + endpoints) to this run's config so the next retry uses it.
	// Returns false when ivacflow has not pushed yet → the retry loop waits & asks
	// again on the next round (exactly the "wait for ivacflow, then resume" behavior).
	r.OnCipherFail = func() bool {
		importMu.RLock()
		imp := ivacflowCfg
		importMu.RUnlock()
		if imp == nil {
			return false
		}
		return cfg.ApplyIvacflowForce(imp)
	}
	// #1 PAUSE version gate: lets a paused signin tell a NEW correct-cipher push apart
	// from the same (already-tried) one, so it resumes only on a strictly newer push.
	r.IvacflowVersion = func() uint64 {
		_, ver := ivacflowSnapshot()
		return ver
	}
	// live retry delays: map "signin/verify/book/reserve/initiate" → StepName.
	if in.LiveDelaySec != nil {
		nameOf := map[flow.StepName]string{
			flow.StSignin: "signin", flow.StVerify: "verify", flow.StUpload: "upload",
			flow.StBook: "book", flow.StReserve: "reserve", flow.StInitiate: "initiate",
		}
		r.LiveDelaySec = func(sn flow.StepName) int {
			if k, ok := nameOf[sn]; ok {
				return in.LiveDelaySec(k)
			}
			return -1
		}
	}
	// captured-config safety net, best source first: used ONLY where the live scan
	// resolves nothing (ivacflow, then the RJ SLOT recorder capture)
	cfg.Fallbacks = getFallbackConfigs()
	// let a mid-scan ivacflow push be re-read instantly (push → stop loop → auto-flow)
	r.RefreshFallbacks = getFallbackConfigs
	// manual dashboard overrides win over the live scan
	cfg.ForcedSlotID, cfg.ForcedDgepayID = getOverrideIDs()
	if in.RegisterStop != nil {
		in.RegisterStop(r.Stop) // let the Stop button cancel this run
	}
	if in.RegisterSetOTP != nil {
		// SetOTPManual: a typed code always wins over the stale-OTP guard.
		in.RegisterSetOTP(r.SetOTPManual)
	}
	if in.RegisterClearOTP != nil {
		in.RegisterClearOTP(r.ClearOTP)
	}
	if in.RegisterRejectOTP != nil {
		in.RegisterRejectOTP(r.RejectOTP)
	}

	err := flow.RunFullAuto(r, in.Files, in.Mission, in.IvacCenter)
	publishScanSources(cfg.Source) // refresh: dg-epay resolves late, after the scan
	if err != nil {
		return "", err
	}
	return r.PaymentURL, nil
}
