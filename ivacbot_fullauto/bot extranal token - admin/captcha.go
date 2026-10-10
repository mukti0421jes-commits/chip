package main

// Captcha solver + pre-warmed QUEUE.
//
// Providers: Token Relay (local farm) + CapMonster / CapSolver / 2Captcha /
// YesCaptcha (Cloudflare Turnstile). The active provider is chosen from the
// dashboard dropdown, with auto-failover between the relay and a keyed API.
//
// The queue keeps a few tokens ready for Signin AND Reserve SEPARATELY, each
// already cipher-encrypted (via the loaded cipher.js) — so when an API call
// needs a token it is instant, no solving delay.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// captchaConfigFile is the on-disk config path. A var (not const) so tests can point it
// at a temp file and never touch a real operator config.
var captchaConfigFile = "captcha_config.json"

// Default Cloudflare Turnstile params for IVAC (same as the userscript).
const (
	defaultSiteKey    = "0x4AAAAAACghKkJHL1t7UkuZ"
	defaultWebsiteURL = "https://appointment.ivacbd.com"
)

type captchaConfig struct {
	Provider   string            `json:"provider"` // relay|capmonster|capsolver|2captcha|yescaptcha
	Keys       map[string]string `json:"keys"`     // provider -> apiKey
	SiteKey    string            `json:"siteKey"`
	WebsiteURL string            `json:"websiteUrl"`
	RelayURL   string            `json:"relayUrl"`  // token-relay base, e.g. http://127.0.0.1:8787
	QueueSize  int               `json:"queueSize"` // ready tokens kept ready at all times (pool target)
	// SolveConcurrency caps how many API solves run AT ONCE while filling the pool. The
	// pool is filled in batches of this size (not one-by-one, not all-at-once): e.g. with
	// QueueSize=200 and SolveConcurrency=20, the pool fills 20 solves at a time until it
	// holds 200. Default 20. Keeps the fill fast without blasting the solver API.
	SolveConcurrency int `json:"solveConcurrency"`
	// Enabled is the MASTER captcha switch (dashboard "Captcha START / STOP"). While the
	// bot runs 24/7 under systemd, the API solver would otherwise pre-warm the queue
	// non-stop and burn API balance even with NO instance running. So captcha solving is
	// OFF by default and solves NOTHING (no pre-warm, no on-demand) until the operator
	// presses START. Pressing STOP clears the queue and stops all solving again.
	Enabled bool `json:"enabled"`
}

type apiProvider struct{ createURL, resultURL, taskType string }

var apiProviders = map[string]apiProvider{
	"capmonster": {"https://api.capmonster.cloud/createTask", "https://api.capmonster.cloud/getTaskResult", "TurnstileTaskProxyless"},
	"capsolver":  {"https://api.capsolver.com/createTask", "https://api.capsolver.com/getTaskResult", "AntiTurnstileTaskProxyLess"},
	"2captcha":   {"https://api.2captcha.com/createTask", "https://api.2captcha.com/getTaskResult", "TurnstileTaskProxyless"},
	"yescaptcha": {"https://api.yescaptcha.com/createTask", "https://api.yescaptcha.com/getTaskResult", "TurnstileTaskProxyless"},
}

type readyTok struct {
	raw string
	enc string
	at  time.Time
}

type captchaManager struct {
	mu      sync.Mutex
	cfg     captchaConfig
	signin  []readyTok
	reserve []readyTok
	ttl     time.Duration
	httpCli *http.Client
	lastFailoverLog time.Time // throttles the AUTO-switch log line
	inFlight int32 // API solves currently running (so the pool fills in PARALLEL, not one-by-one)
}

var captchaMgr = &captchaManager{
	// Token lifetime = 3 MINUTES. An API-solved token is held in the pool for this long;
	// once older it is DECLARED EXPIRED and auto-removed on the next prune (every pool
	// read / the worker loop), and the gap-filler solves a fresh one to replace it. Relay
	// tokens are NOT queued — pulled straight from the relay at use time.
	ttl:     3 * time.Minute,
	httpCli: &http.Client{Timeout: 30 * time.Second},
}

// ==================== CONFIG ====================

func (m *captchaManager) loadConfig() {
	m.cfg = captchaConfig{
		Provider:   "relay",
		Keys:       map[string]string{},
		SiteKey:    defaultSiteKey,
		WebsiteURL: defaultWebsiteURL,
		RelayURL:   "http://127.0.0.1:8787",
		QueueSize:  10,
	}
	if b, err := os.ReadFile(captchaConfigFile); err == nil {
		json.Unmarshal(b, &m.cfg)
	}
	if m.cfg.Keys == nil {
		m.cfg.Keys = map[string]string{}
	}
	if m.cfg.QueueSize <= 0 {
		m.cfg.QueueSize = 10
	}
	if m.cfg.SolveConcurrency <= 0 {
		m.cfg.SolveConcurrency = 20 // fill the pool 20-at-a-time by default
	}
	// Any retired/unknown provider (e.g. an old "rumon" config) → token relay.
	if m.cfg.Provider == "" || (m.cfg.Provider != "relay" && apiProviders[m.cfg.Provider].createURL == "") {
		m.cfg.Provider = "relay"
	}
	if m.cfg.RelayURL == "" {
		m.cfg.RelayURL = "http://127.0.0.1:8787"
	}
	// PRIMARY = API solver, FALLBACK = farm relay. When a keyed API provider exists,
	// make it the primary source so API-solved tokens pre-warm the queue (fast, reliable)
	// and the farm relay serves ONLY as the automatic fallback (altProvider: API→relay).
	if api := m.promoteAPIPrimary(); api != "" {
		fmt.Printf("🔑 [Captcha] PRIMARY = %s (API solve); relay = fallback\n", api)
	}
}

// firstKeyedAPI returns the first API provider (fixed preference order, matching
// altProvider) that has a non-empty key, or "" when none is configured.
func (m *captchaManager) firstKeyedAPI() string {
	for _, name := range []string{"capsolver", "capmonster", "2captcha", "yescaptcha"} {
		if strings.TrimSpace(m.cfg.Keys[name]) != "" {
			return name
		}
	}
	return ""
}

// promoteAPIPrimary makes a keyed API solver the PRIMARY source (relay becomes the
// fallback) when the configured provider is the relay (or unset) AND at least one API
// key is set. An EXPLICIT API selection is left unchanged, and relay-only (no API key)
// stays on the relay. Returns the provider it promoted to, or "" if nothing changed.
func (m *captchaManager) promoteAPIPrimary() string {
	if m.cfg.Provider != "relay" {
		return "" // an explicit API choice — keep it
	}
	if api := m.firstKeyedAPI(); api != "" {
		m.cfg.Provider = api
		return api
	}
	return "" // no API key — relay stays primary
}

// providerIsRelay reports whether the active provider is the local token relay.
// Relay tokens are used DIRECTLY (GET /pull at use time) — never pre-queued — so
// they are always as fresh as the relay's own 120s window, with no second hold.
func (m *captchaManager) providerIsRelay() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cfg.Provider == "relay"
}

func (m *captchaManager) saveConfig() {
	b, _ := json.MarshalIndent(m.cfg, "", "  ")
	os.WriteFile(captchaConfigFile, b, 0644)
}

// isEnabled reports whether the MASTER captcha switch is ON. When OFF, NOTHING solves
// (no queue pre-warm, no on-demand solve) — so an always-running bot never burns API
// balance until the operator presses START.
func (m *captchaManager) isEnabled() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cfg.Enabled
}

// setEnabled flips the master switch, persists it, and on STOP clears both queues so no
// pre-solved tokens linger (and no further solving happens until START).
func (m *captchaManager) setEnabled(on bool) {
	m.mu.Lock()
	m.cfg.Enabled = on
	m.mu.Unlock()
	m.saveConfig()
	if !on {
		m.ClearQueues()
	}
}

// ==================== SOLVERS ====================

// unifyPurpose collapses EVERY captcha purpose into ONE shared raw-token pool.
// IVAC issues a single Turnstile token that works for signin AND reserve (and is
// sent raw for upload/initiate), so the API-solved queue is kept as ONE pool and
// every step draws from it — no separate signin/reserve pools. (The relay path
// already served one shared queue.) Encryption is still applied PER STEP by the
// flow, so a shared raw token is encrypted correctly for signin vs reserve.
func unifyPurpose(string) string { return "Signin" }

// solveRaw solves ONE captcha and returns the raw Turnstile token. Purpose is
// unified — one pool for signin/reserve/upload/initiate.
func (m *captchaManager) solveRaw(purpose string) (string, error) {
	purpose = unifyPurpose(purpose)
	m.mu.Lock()
	cfg := m.cfg
	m.mu.Unlock()

	if cfg.Provider == "relay" {
		return m.solveRelay(cfg)
	}
	p, ok := apiProviders[cfg.Provider]
	if !ok {
		return "", fmt.Errorf("unknown provider %q", cfg.Provider)
	}
	key := cfg.Keys[cfg.Provider]
	if key == "" {
		return "", fmt.Errorf("no API key for %s", cfg.Provider)
	}
	return m.solveAPI(cfg, p, key)
}

// solveRelay pulls ONE fresh, single-use Turnstile token from the local token
// relay (token-relay.js, GET /pull). One shared queue serves signin + reserve;
// the flow encrypts the raw token per purpose itself.
func (m *captchaManager) solveRelay(cfg captchaConfig) (string, error) {
	base := cfg.RelayURL
	if base == "" {
		base = "http://127.0.0.1:8787"
	}
	base = strings.TrimRight(base, "/")
	req, _ := http.NewRequest("GET", base+"/pull", nil)
	resp, err := m.httpCli.Do(req)
	if err != nil {
		return "", fmt.Errorf("relay unreachable (%s) — token-relay chalu ache to?", err.Error())
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var r struct {
		Token string `json:"token"`
		Fresh int    `json:"fresh"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return "", fmt.Errorf("relay bad json: %s", string(b))
	}
	if r.Token == "" {
		return "", fmt.Errorf("relay queue khali — farm browser token push korche to? (fresh=%d)", r.Fresh)
	}
	return r.Token, nil
}

// ── AUTO FAILOVER: relay ⇄ API ───────────────────────────────────────────────
//
// The dashboard picks a provider (the "toggle"). This makes it AUTOMATIC: if the
// active source can't hand out a token (relay empty/unreachable, or the API errors),
// the bot instantly falls back to the OTHER kind for that one pull — relay→API, or
// API→relay — WITHOUT permanently changing the saved provider. The moment the primary
// recovers, it is used again. Failover only fires when the other source is configured
// (an API key present for relay→API; a relayUrl present for API→relay).

// solveRawVia solves ONE raw token using a SPECIFIC provider name (not necessarily the
// configured one), so the failover can force the alternate source.
func (m *captchaManager) solveRawVia(cfg captchaConfig, provider, purpose string) (string, error) {
	purpose = unifyPurpose(purpose)
	switch {
	case provider == "relay":
		return m.solveRelay(cfg)
	default:
		p, ok := apiProviders[provider]
		if !ok {
			return "", fmt.Errorf("unknown provider %s", provider)
		}
		key := cfg.Keys[provider]
		if key == "" {
			return "", fmt.Errorf("%s: no api key set", provider)
		}
		return m.solveAPI(cfg, p, key)
	}
}

// altProvider returns the source to fall back to when the primary fails, or "" when
// no fallback is configured. relay→a keyed API; API→relay.
func (m *captchaManager) altProvider(cfg captchaConfig) string {
	if cfg.Provider == "relay" {
		for _, name := range []string{"capsolver", "capmonster", "2captcha", "yescaptcha"} {
			if strings.TrimSpace(cfg.Keys[name]) != "" {
				return name
			}
		}
		return ""
	}
	if strings.TrimSpace(cfg.RelayURL) != "" {
		return "relay"
	}
	return ""
}

// noteFailover logs a source switch, throttled so 30 instances don't spam the console.
func (m *captchaManager) noteFailover(from, to string, why error) {
	m.mu.Lock()
	spam := time.Since(m.lastFailoverLog) < 8*time.Second
	if !spam {
		m.lastFailoverLog = time.Now()
	}
	m.mu.Unlock()
	if !spam {
		fmt.Printf("🔀 [Captcha] %s theke token pawa gelo na (%v) → AUTO switch → %s theke nilo\n", from, why, to)
	}
}

// pullRawFailover gets a raw token from the active provider, and on any failure falls
// back to the alternate source automatically. This is the single entry the flow uses.
func (m *captchaManager) pullRawFailover(purpose string) (string, error) {
	m.mu.Lock()
	cfg := m.cfg
	m.mu.Unlock()
	// MASTER SWITCH: solve nothing until the operator presses START. This protects the
	// API balance on an always-running bot (and the flow simply waits for a token).
	if !cfg.Enabled {
		return "", fmt.Errorf("captcha bondho — dashboard theke 'Captcha START' (T_start) chepe chalu korun")
	}
	primary := cfg.Provider

	// Fast path for API providers: consume a pre-warmed queue token first (instant).
	if primary != "relay" {
		if q, ok := m.TakeRaw(purpose); ok && q != "" {
			return q, nil
		}
	}
	tok, err := m.solveRawVia(cfg, primary, purpose)
	if err == nil && tok != "" {
		return tok, nil
	}
	// primary failed → auto failover to the other kind
	alt := m.altProvider(cfg)
	if alt == "" {
		return "", err // nothing configured to fall back to
	}
	tok2, err2 := m.solveRawVia(cfg, alt, purpose)
	if err2 == nil && tok2 != "" {
		m.noteFailover(primary, alt, err)
		return tok2, nil
	}
	return "", fmt.Errorf("captcha dono source fail — %s: %v ; %s: %v", primary, err, alt, err2)
}

func (m *captchaManager) solveAPI(cfg captchaConfig, p apiProvider, key string) (string, error) {
	createBody, _ := json.Marshal(map[string]interface{}{
		"clientKey": key,
		"task": map[string]interface{}{
			"type":       p.taskType,
			"websiteURL": cfg.WebsiteURL,
			"websiteKey": cfg.SiteKey,
		},
	})
	var cr struct {
		ErrorID          int             `json:"errorId"`
		ErrorCode        string          `json:"errorCode"`
		ErrorDescription string          `json:"errorDescription"`
		TaskID           json.RawMessage `json:"taskId"` // string (CapSolver) OR int (2Captcha)
	}
	if err := m.postJSON(p.createURL, createBody, &cr); err != nil {
		return "", err
	}
	if cr.ErrorID != 0 {
		return "", fmt.Errorf("%s create: %s %s", cfg.Provider, cr.ErrorCode, cr.ErrorDescription)
	}
	taskID := string(cr.TaskID)
	if taskID == "" || taskID == "null" || taskID == "0" || taskID == `""` {
		return "", fmt.Errorf("%s: no taskId", cfg.Provider)
	}
	time.Sleep(2 * time.Second)
	for attempt := 0; attempt < 60; attempt++ {
		time.Sleep(1 * time.Second)
		// re-send taskId in its ORIGINAL type (raw) so string/int providers both work
		resBody := []byte(fmt.Sprintf(`{"clientKey":%q,"taskId":%s}`, key, taskID))
		var rr struct {
			ErrorID          int    `json:"errorId"`
			ErrorCode        string `json:"errorCode"`
			ErrorDescription string `json:"errorDescription"`
			Status           string `json:"status"`
			Solution         struct {
				Token          string `json:"token"`
				GRecaptchaResp string `json:"gRecaptchaResponse"`
			} `json:"solution"`
		}
		if err := m.postJSON(p.resultURL, resBody, &rr); err != nil {
			continue
		}
		if rr.ErrorID != 0 {
			return "", fmt.Errorf("%s poll: %s %s", cfg.Provider, rr.ErrorCode, rr.ErrorDescription)
		}
		if rr.Status == "ready" {
			if rr.Solution.Token != "" {
				return rr.Solution.Token, nil
			}
			if rr.Solution.GRecaptchaResp != "" {
				return rr.Solution.GRecaptchaResp, nil
			}
			return "", fmt.Errorf("%s: empty solution", cfg.Provider)
		}
	}
	return "", fmt.Errorf("%s: solve timeout", cfg.Provider)
}

func (m *captchaManager) postJSON(url string, body []byte, out interface{}) error {
	req, _ := http.NewRequest("POST", url, bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.httpCli.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return json.Unmarshal(b, out)
}

// ==================== QUEUE ====================

func (m *captchaManager) prune(list []readyTok) []readyTok {
	now := time.Now()
	out := list[:0]
	for _, t := range list {
		if now.Sub(t.at) < m.ttl {
			out = append(out, t)
		}
	}
	return out
}

// NextReadyC returns a ready token for the purpose WITHOUT removing it — the
// same token is REUSED until invalidated or its 3-minute lifetime expires.
// It returns the ENCRYPTED form when encryption mode is active, else the RAW
// token (dual mode — respects the user's dashboard choice). ok=false if none.
func (m *captchaManager) NextReadyC(purpose string) (string, bool) {
	purpose = unifyPurpose(purpose)
	useEnc := CipherActive()
	m.mu.Lock()
	defer m.mu.Unlock()
	pick := func(t readyTok) string {
		if useEnc {
			return t.enc
		}
		return t.raw
	}
	if purpose == "Reserve" {
		m.reserve = m.prune(m.reserve)
		if len(m.reserve) == 0 {
			return "", false
		}
		return pick(m.reserve[0]), true // peek = reuse
	}
	m.signin = m.prune(m.signin)
	if len(m.signin) == 0 {
		return "", false
	}
	return pick(m.signin[0]), true // peek = reuse
}

// NextRaw peeks a RAW (unencrypted) token from the queue for the purpose.
// Used by the legacy token path so it shares the queue + selected provider.
func (m *captchaManager) NextRaw(purpose string) (string, bool) {
	purpose = unifyPurpose(purpose)
	m.mu.Lock()
	defer m.mu.Unlock()
	if purpose == "Reserve" {
		m.reserve = m.prune(m.reserve)
		if len(m.reserve) == 0 {
			return "", false
		}
		return m.reserve[0].raw, true
	}
	m.signin = m.prune(m.signin)
	if len(m.signin) == 0 {
		return "", false
	}
	return m.signin[0].raw, true
}

// TakeRaw CONSUMES (pops) the front RAW token for the purpose — a Turnstile token
// is SINGLE-USE, so it must be removed once handed out (peeking/reusing the same
// token makes the 2nd+ API call fail with "Captcha verification failed"). After a
// pop it kicks an INSTANT background refill so the queue is topped straight back up.
func (m *captchaManager) TakeRaw(purpose string) (string, bool) {
	purpose = unifyPurpose(purpose)
	m.mu.Lock()
	var tok string
	ok := false
	if purpose == "Reserve" {
		m.reserve = m.prune(m.reserve)
		if len(m.reserve) > 0 {
			tok = m.reserve[0].raw
			m.reserve = m.reserve[1:] // consume — single-use
			ok = true
		}
	} else {
		m.signin = m.prune(m.signin)
		if len(m.signin) > 0 {
			tok = m.signin[0].raw
			m.signin = m.signin[1:] // consume — single-use
			ok = true
		}
	}
	m.mu.Unlock()
	if ok {
		go m.refillOne(purpose) // instant refill of the slot we just emptied
	}
	return tok, ok
}

// queueSize returns the configured pool size (locked read), min 1.
func (m *captchaManager) queueSize() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cfg.QueueSize <= 0 {
		return 10
	}
	return m.cfg.QueueSize
}

// solveConcurrency returns how many solves may run AT ONCE while filling the pool
// (locked read), min 1. Default 20.
func (m *captchaManager) solveConcurrency() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cfg.SolveConcurrency <= 0 {
		return 20
	}
	return m.cfg.SolveConcurrency
}

// launchFill starts ONE solve in the background and tracks it in inFlight, so the
// worker and the on-consume refill can fill the pool CONCURRENTLY (many solves at once)
// instead of one-at-a-time — the API warm-up then takes ~one solve-time, not N×.
func (m *captchaManager) launchFill(purpose string) {
	atomic.AddInt32(&m.inFlight, 1)
	go func() {
		defer atomic.AddInt32(&m.inFlight, -1)
		m.fillOne(purpose)
	}()
}

// refillOne tops the queue back up by one if (pool + in-flight solves) is still below
// QueueSize — called the moment a token is consumed, in addition to the periodic worker.
// Counting in-flight solves prevents launching duplicate solves for the same slot.
func (m *captchaManager) refillOne(purpose string) {
	purpose = unifyPurpose(purpose)
	infl := int(atomic.LoadInt32(&m.inFlight))
	if m.queueLen(purpose)+infl < m.queueSize() && infl < m.solveConcurrency() {
		m.launchFill(purpose)
	}
}

// InvalidateC drops the front token of a purpose (call when the API rejects it
// per the rules: 400/429/503/captcha errors). The filler then makes a fresh one.
func (m *captchaManager) InvalidateC(purpose string) {
	purpose = unifyPurpose(purpose)
	m.mu.Lock()
	defer m.mu.Unlock()
	if purpose == "Reserve" {
		if len(m.reserve) > 0 {
			m.reserve = m.reserve[1:]
		}
	} else {
		if len(m.signin) > 0 {
			m.signin = m.signin[1:]
		}
	}
}

// InvalidateCaptcha is the wiring helper: call on a failed Login/Reserve response
// so the bad token is dropped and a fresh one is solved into the queue.
func InvalidateCaptcha(endpointName string) {
	switch endpointName {
	case "Login API":
		captchaMgr.InvalidateC("Signin")
	case "Reserve Slot API":
		captchaMgr.InvalidateC("Reserve")
	}
}

// ClearQueues empties both pre-solved token queues (Clean Cache button).
func (m *captchaManager) ClearQueues() {
	m.mu.Lock()
	m.signin = nil
	m.reserve = nil
	m.mu.Unlock()
}

func (m *captchaManager) queueLen(purpose string) int {
	purpose = unifyPurpose(purpose)
	m.mu.Lock()
	defer m.mu.Unlock()
	if purpose == "Reserve" {
		m.reserve = m.prune(m.reserve)
		return len(m.reserve)
	}
	m.signin = m.prune(m.signin)
	return len(m.signin)
}

func (m *captchaManager) fillOne(purpose string) {
	purpose = unifyPurpose(purpose)
	raw, err := m.solveRaw(purpose)
	if err != nil || raw == "" {
		fmt.Printf("⚠️ [Captcha] %s solve failed: %v\n", purpose, err) // surface the real reason
		time.Sleep(3 * time.Second)                                    // back off on error
		return
	}
	enc := cipherMgr.EncryptToken(raw, purpose) // pre-encrypt for THIS purpose
	m.mu.Lock()
	tok := readyTok{raw: raw, enc: enc, at: time.Now()}
	if purpose == "Reserve" {
		m.reserve = append(m.reserve, tok)
	} else {
		m.signin = append(m.signin, tok)
	}
	m.mu.Unlock()
	// ONE shared pool now — signin/reserve/upload/initiate all draw from it. Show a
	// single count (not signin=.. reserve=.. which looked like two separate pools).
	fmt.Printf("🎫 [Captcha] token ready (pool=%d — signin/reserve/upload/initiate shared)\n",
		m.queueLen("Signin"))
}

// StartCaptchaQueue runs background fillers that keep Signin & Reserve queues
// topped up. Call once from main(): captchaMgr.loadConfig(); go StartCaptchaQueue().
func StartCaptchaQueue() {
	captchaMgr.mu.Lock()
	prov := captchaMgr.cfg.Provider
	hasKey := captchaMgr.cfg.Keys[prov] != "" || prov == "relay"
	captchaMgr.mu.Unlock()
	fmt.Printf("🚀 [Captcha] Queue worker started (provider=%s, keyPresent=%v) — IDLE until 'Captcha START'\n", prov, hasKey)
	for {
		// MASTER SWITCH: while OFF, the worker solves NOTHING (no pre-warm) so an
		// always-running bot never burns API balance. It wakes up the instant START is
		// pressed (setEnabled true) and begins topping the pool up.
		if !captchaMgr.isEnabled() {
			time.Sleep(1 * time.Second)
			continue
		}
		// RELAY: do NOT pre-queue. Relay tokens are pulled straight from the relay at
		// use time (the relay IS the queue, with its own 120s window) — pre-storing
		// them here would add a second hold and risk staleness. Only API-solved
		// providers keep a local pre-warmed queue.
		if captchaMgr.providerIsRelay() {
			time.Sleep(1 * time.Second)
			continue
		}
		size := captchaMgr.queueSize()
		conc := captchaMgr.solveConcurrency()
		// ONE shared pool now (unifyPurpose). Fill it in PARALLEL, but never more than
		// `conc` solves AT ONCE (batches of conc): launch while the pool+in-flight is below
		// target AND fewer than conc solves are already running. As each batch finishes, the
		// next launches, until the pool holds `size`. Fast, but never blasts the solver API.
		for {
			infl := int(atomic.LoadInt32(&captchaMgr.inFlight))
			if captchaMgr.queueLen("Signin")+infl >= size || infl >= conc {
				break
			}
			captchaMgr.launchFill("Signin")
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// CaptchaC returns the ready-to-send "c" value for an endpoint.
// It prefers a pre-solved + pre-encrypted token from the queue (instant);
// if the queue is empty it encrypts the fallback raw token the bot already has.
func CaptchaC(endpointName, fallbackRaw string) string {
	purpose := "Signin"
	if endpointName == "Reserve Slot API" {
		purpose = "Reserve"
	} else if endpointName != "Login API" {
		return fallbackRaw // non-captcha endpoint
	}
	if c, ok := captchaMgr.NextReadyC(purpose); ok {
		return c
	}
	return cipherMgr.EncryptToken(fallbackRaw, purpose)
}

// InitiateXToken returns a RAW Cloudflare Turnstile token for the
// dg-epay/initiate "x-token" header. The browser sends a freshly solved raw
// Turnstile token here (format "1.xxx.yyy"), NOT the encrypted `c`. We pull one
// from the captcha queue (Signin pool), falling back to a fresh solve.
func InitiateXToken() string {
	if !captchaMgr.isEnabled() {
		return "" // master switch OFF — solve nothing
	}
	if raw, ok := captchaMgr.NextRaw("Signin"); ok && raw != "" {
		return raw
	}
	if raw, err := captchaMgr.solveRaw("Signin"); err == nil {
		return raw
	}
	return ""
}

// ==================== DASHBOARD API ====================

func handleCaptchaConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == "POST" {
		var in captchaConfig
		json.NewDecoder(r.Body).Decode(&in)
		captchaMgr.mu.Lock()
		if in.Provider != "" {
			captchaMgr.cfg.Provider = in.Provider
		}
		if in.Keys != nil {
			for k, v := range in.Keys {
				captchaMgr.cfg.Keys[k] = v
			}
		}
		if in.SiteKey != "" {
			captchaMgr.cfg.SiteKey = in.SiteKey
		}
		if in.WebsiteURL != "" {
			captchaMgr.cfg.WebsiteURL = in.WebsiteURL
		}
		if in.QueueSize > 0 {
			captchaMgr.cfg.QueueSize = in.QueueSize
		}
		if in.SolveConcurrency > 0 {
			captchaMgr.cfg.SolveConcurrency = in.SolveConcurrency
		}
		if in.RelayURL != "" {
			captchaMgr.cfg.RelayURL = in.RelayURL
		}
		cfg := captchaMgr.cfg
		captchaMgr.mu.Unlock()
		captchaMgr.saveConfig()
		_ = cfg
	}
	captchaMgr.mu.Lock()
	cfg := captchaMgr.cfg
	captchaMgr.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(cfg)
}

func handleCaptchaQueue(w http.ResponseWriter, r *http.Request) {
	captchaMgr.mu.Lock()
	provider := captchaMgr.cfg.Provider
	size := captchaMgr.cfg.QueueSize
	relayURL := captchaMgr.cfg.RelayURL
	enabled := captchaMgr.cfg.Enabled
	captchaMgr.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	// ONE shared pool now. "pool" is the real count; signin/reserve are kept equal to
	// it for any older UI, but the dashboard shows the single pool.
	pool := captchaMgr.queueLen("Signin")
	out := map[string]interface{}{
		"provider": provider,
		"size":     size,
		"pool":     pool,
		"signin":   pool,
		"reserve":  pool,
		"enabled":  enabled, // master switch state (Captcha START/STOP)
	}
	// When the FARM RELAY is the source, fetch its live stats so the dashboard shows
	// how many farm BROWSERS are pushing, the fresh-token count, and push/pull totals
	// — the operator's capacity gauge (is the farm keeping up with the instances?).
	if provider == "relay" && strings.TrimSpace(relayURL) != "" {
		if rs, ok := fetchRelayStats(relayURL); ok {
			out["relayOK"] = true
			out["relayFresh"] = rs.Fresh
			out["relayBrowsers"] = len(rs.PerSource)
			out["relayPushed"] = rs.TotalPushed
			out["relayPulled"] = rs.TotalPulled
			out["relayExpired"] = rs.TotalExpired
		} else {
			out["relayOK"] = false // relay unreachable → farm/relay not running?
		}
	}
	json.NewEncoder(w).Encode(out)
}

// relayStats mirrors the token-relay /stats response.
type relayStats struct {
	PerSource    map[string]interface{} `json:"perSource"`
	TotalPushed  int                    `json:"totalPushed"`
	TotalPulled  int                    `json:"totalPulled"`
	TotalExpired int                    `json:"totalExpired"`
	Fresh        int                    `json:"fresh"`
}

// fetchRelayStats GETs the farm relay's /stats (short timeout). ok=false when the
// relay is unreachable, so the dashboard can flag a stopped relay/farm.
func fetchRelayStats(relayURL string) (relayStats, bool) {
	var rs relayStats
	base := strings.TrimRight(strings.TrimSpace(relayURL), "/")
	cli := &http.Client{Timeout: 2 * time.Second}
	resp, err := cli.Get(base + "/stats")
	if err != nil {
		return rs, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return rs, false
	}
	if json.NewDecoder(resp.Body).Decode(&rs) != nil {
		return rs, false
	}
	return rs, true
}

// handleCaptchaTest solves ONE captcha right now and returns the token or the
// exact error — use this to debug why the queue is empty.
func handleCaptchaTest(w http.ResponseWriter, r *http.Request) {
	purpose := r.URL.Query().Get("purpose")
	if purpose != "Reserve" {
		purpose = "Signin"
	}
	captchaMgr.mu.Lock()
	prov := captchaMgr.cfg.Provider
	keyLen := len(captchaMgr.cfg.Keys[prov])
	captchaMgr.mu.Unlock()
	raw, err := captchaMgr.solveRaw(purpose)
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false, "provider": prov, "keyLen": keyLen, "error": err.Error(),
		})
		return
	}
	enc := cipherMgr.EncryptToken(raw, purpose)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok": true, "provider": prov, "keyLen": keyLen,
		"rawToken": raw, "encrypted": enc,
	})
}

// handleCaptchaToggle flips the MASTER captcha switch. POST {"enabled":true|false};
// a GET (or any non-POST) just returns the current state. STOP clears the queue so no
// pre-solved tokens linger. This is the dashboard "Captcha START / STOP" (T_start).
func handleCaptchaToggle(w http.ResponseWriter, r *http.Request) {
	if r.Method == "POST" {
		var in struct {
			Enabled bool `json:"enabled"`
		}
		json.NewDecoder(r.Body).Decode(&in)
		captchaMgr.setEnabled(in.Enabled)
		if in.Enabled {
			fmt.Println("▶️ [Captcha] START — queue pre-warm + solving ON")
		} else {
			fmt.Println("⏹️ [Captcha] STOP — solving OFF, queue cleared (API balance safe)")
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"enabled": captchaMgr.isEnabled()})
}

// RegisterCaptchaRoutes wires the captcha dashboard endpoints. Call once in main().
func RegisterCaptchaRoutes() {
	http.HandleFunc("/api/captchaConfig", handleCaptchaConfig)
	http.HandleFunc("/api/captchaQueue", handleCaptchaQueue)
	http.HandleFunc("/api/captchaTest", handleCaptchaTest)
	http.HandleFunc("/api/captchaToggle", handleCaptchaToggle)
}
