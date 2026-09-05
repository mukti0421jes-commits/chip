package main

import (
	"time"

	"ivac-bot/flow"
)

// ── Adapters wiring the bot's real H2 client + captcha into the flow module ──

// flowDoer implements flow.Doer using the bot's utls/HTTP-2 client (newH2Client).
// onHTTP (optional) is fired after every API call with the URL + HTTP status, so
// the dashboard can show live per-step ENDPOINT + STATUS (200/403/503/…).
type flowDoer struct {
	hd     *flow.HTTPDoer
	onHTTP func(url string, status int)
}

func newFlowDoer(proxyURL string, onHTTP func(string, int)) flowDoer {
	c := newH2Client(proxyURL)
	if c.Timeout == 0 {
		c.Timeout = 45 * time.Second // never hang forever on a dead endpoint
	}
	return flowDoer{hd: &flow.HTTPDoer{Client: c}, onHTTP: onHTTP}
}

func (d flowDoer) Do(req flow.Request) (flow.Response, error) {
	resp, err := d.hd.Do(req)
	if d.onHTTP != nil {
		st := 0
		if err == nil {
			st = resp.Status
		}
		d.onHTTP(req.URL, st)
	}
	return resp, err
}

// flowTokens implements flow.TokenProvider using the bot's captcha queue. It
// returns the RAW Turnstile token — the flow encrypts it per purpose itself
// (signin/reserve) or sends it raw (initiate/upload), byte-faithful to RJ SLOT.
type flowTokens struct{ purpose string }

func (t flowTokens) GetCaptchaToken() (string, error) {
	// RELAY: use a token STRAIGHT from the relay (GET /pull) — no local queue. The
	// relay is already a fresh, single-use, 120s FIFO; pulling on-demand keeps the
	// token as fresh as possible (no second hold, no staleness).
	if captchaMgr.providerIsRelay() {
		return captchaMgr.solveRaw(t.purpose) // relay: solveRelay → GET /pull
	}
	// API providers: CONSUME a pre-solved token (single-use) from the local queue —
	// never reuse the same one, or the next call fails "Captcha verification failed".
	// TakeRaw also triggers an instant refill.
	if tok, ok := captchaMgr.TakeRaw(t.purpose); ok && tok != "" {
		return tok, nil
	}
	return captchaMgr.solveRaw(t.purpose)
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
	Log                func(string)

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

	// RegisterStop receives the runner's Stop func so the caller can cancel the
	// whole pipeline (Stop button) from outside.
	RegisterStop func(stop func())
}

// RunFullAutoForEntry runs the RJ SLOT Full Auto pipeline for one entry, using
// the bot's real H2 client + captcha queue. It performs: A_E scan → signin →
// OTP+verify → upload → book → reserve → initiate. Returns the payment URL.
func RunFullAutoForEntry(in FullAutoInput) (string, error) {
	cfg := flow.NewConfig() // dynamic headers (nav/runtime) filled by scan/runtime; VRequestMeta defaults to "windos.s"

	mode := flow.Mode{Single: in.Single, Auto: in.Auto, Delay: time.Duration(in.DelaySec) * time.Second}
	// wire the dashboard's per-step retry delays into the flow so the UI controller
	// actually drives each step's retry gap (signin/verify/book/reserve/initiate).
	if len(in.StepDelays) > 0 {
		keyMap := map[string]flow.StepName{
			"signin": flow.StSignin, "verify": flow.StVerify, "book": flow.StBook,
			"reserve": flow.StReserve, "initiate": flow.StInitiate,
		}
		mode.StepDelays = map[flow.StepName]time.Duration{}
		for k, sec := range in.StepDelays {
			if sn, ok := keyMap[k]; ok && sec > 0 {
				mode.StepDelays[sn] = time.Duration(sec) * time.Second
			}
		}
	}
	r := flow.NewRunner(cfg, mode, in.Log, nil)
	r.Doer = newFlowDoer(in.ProxyURL, in.OnHTTP)
	r.OnOTP = in.OnOTP
	r.Fetcher = newFlowFetcher(in.ProxyURL)
	r.Tokens = flowTokens{purpose: "Signin"}
	r.ReserveTokens = flowTokens{purpose: "Reserve"} // reserve needs Reserve-widget tokens, not Signin
	r.Phone = in.Phone
	r.OTPPhone = in.OTPPhone
	r.Password = in.Password
	r.AppointmentID = in.AppointmentID // enables get-booking-config smart-skip
	r.ReserveStartOffset = in.ReserveStartOffset // round-robin reserve date-sweep start
	// resume: preload a still-live session so signin/OTP/verify/reserve are skipped
	r.AccessToken = in.PreAccessToken
	r.RequestID = in.PreRequestID
	r.Verified = in.PreVerified
	r.ReservationID = in.PreReservationID
	r.OnAppointment = in.OnAppointment
	r.OnReservation = in.OnReservation
	r.OnScanIDs = in.OnScanIDs
	r.OnSignedIn = in.OnSignedIn
	r.OnVerified = in.OnVerified
	// live retry delays: map "signin/verify/book/reserve/initiate" → StepName.
	if in.LiveDelaySec != nil {
		nameOf := map[flow.StepName]string{
			flow.StSignin: "signin", flow.StVerify: "verify", flow.StBook: "book",
			flow.StReserve: "reserve", flow.StInitiate: "initiate",
		}
		r.LiveDelaySec = func(sn flow.StepName) int {
			if k, ok := nameOf[sn]; ok {
				return in.LiveDelaySec(k)
			}
			return -1
		}
	}
	// manual dashboard overrides win over the live scan
	cfg.ForcedSlotID, cfg.ForcedDgepayID = getOverrideIDs()
	if in.RegisterStop != nil {
		in.RegisterStop(r.Stop) // let the Stop button cancel this run
	}

	if err := flow.RunFullAuto(r, in.Files, in.Mission, in.IvacCenter); err != nil {
		return "", err
	}
	return r.PaymentURL, nil
}
