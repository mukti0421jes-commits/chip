package main

// Captcha solver + pre-warmed QUEUE.
//
// Providers: rumon (your existing external server) + CapMonster / CapSolver /
// 2Captcha / YesCaptcha (Cloudflare Turnstile). The active provider is chosen
// from the dashboard dropdown.
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
	"time"
)

const captchaConfigFile = "captcha_config.json"

// Default Cloudflare Turnstile params for IVAC (same as the userscript).
const (
	defaultSiteKey    = "0x4AAAAAACghKkJHL1t7UkuZ"
	defaultWebsiteURL = "https://appointment.ivacbd.com"
)

type captchaConfig struct {
	Provider        string            `json:"provider"` // rumon|capmonster|capsolver|2captcha|yescaptcha
	Keys            map[string]string `json:"keys"`     // provider -> apiKey
	SiteKey         string            `json:"siteKey"`
	WebsiteURL      string            `json:"websiteUrl"`
	RumonSecret     string            `json:"rumonSecret"`
	RumonLoginURL   string            `json:"rumonLoginUrl"`
	RumonReserveURL string            `json:"rumonReserveUrl"`
	RelayURL        string            `json:"relayUrl"` // token-relay base, e.g. http://127.0.0.1:8787
	QueueSize       int               `json:"queueSize"` // ready tokens kept per purpose
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
}

var captchaMgr = &captchaManager{
	// API-solved tokens are pushed to the queue the instant they are solved (fresh),
	// so they get the full 120s hold. Relay tokens are NOT queued — they are pulled
	// straight from the relay at use time (see flowTokens.GetCaptchaToken).
	ttl:     120 * time.Second,
	httpCli: &http.Client{Timeout: 30 * time.Second},
}

// ==================== CONFIG ====================

func (m *captchaManager) loadConfig() {
	m.cfg = captchaConfig{
		Provider:        "relay",
		Keys:            map[string]string{},
		SiteKey:         defaultSiteKey,
		WebsiteURL:      defaultWebsiteURL,
		RumonSecret:     "rumon98u8x8f31y3",
		RumonLoginURL:   "https://thirdeyesms.shop/captcha-external/rumon-login-captcha.php",
		RumonReserveURL: "https://thirdeyesms.shop/captcha-external/rumon-reserve-captcha.php",
		RelayURL:        "http://127.0.0.1:8787",
		QueueSize:       10,
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
	// rumon is retired — fall back to the token relay.
	if m.cfg.Provider == "rumon" || m.cfg.Provider == "" {
		m.cfg.Provider = "relay"
	}
	if m.cfg.RelayURL == "" {
		m.cfg.RelayURL = "http://127.0.0.1:8787"
	}
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

// ==================== SOLVERS ====================

// solveRaw solves ONE captcha for the purpose ("Signin"/"Reserve") with the
// currently-selected provider and returns the raw Turnstile token.
func (m *captchaManager) solveRaw(purpose string) (string, error) {
	m.mu.Lock()
	cfg := m.cfg
	m.mu.Unlock()

	if cfg.Provider == "rumon" {
		return m.solveRumon(cfg, purpose)
	}
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

func (m *captchaManager) solveRumon(cfg captchaConfig, purpose string) (string, error) {
	url := cfg.RumonLoginURL
	if purpose == "Reserve" {
		url = cfg.RumonReserveURL
	}
	body, _ := json.Marshal(map[string]string{"secret": cfg.RumonSecret, "action": "get"})
	req, _ := http.NewRequest("POST", url, bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.httpCli.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var r map[string]interface{}
	if err := json.Unmarshal(b, &r); err != nil {
		return "", fmt.Errorf("rumon bad json: %s", string(b))
	}
	if t, ok := r["token"].(string); ok && t != "" {
		return t, nil
	}
	return "", fmt.Errorf("rumon no token: %s", string(b))
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
// same token is REUSED until invalidated or its 4-minute lifetime expires.
// It returns the ENCRYPTED form when encryption mode is active, else the RAW
// token (dual mode — respects the user's dashboard choice). ok=false if none.
func (m *captchaManager) NextReadyC(purpose string) (string, bool) {
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

// refillOne tops the queue back up by one if it is below QueueSize (called the
// moment a token is consumed, in addition to the periodic worker).
func (m *captchaManager) refillOne(purpose string) {
	if m.queueLen(purpose) < m.cfg.QueueSize {
		m.fillOne(purpose)
	}
}

// InvalidateC drops the front token of a purpose (call when the API rejects it
// per the rules: 400/429/503/captcha errors). The filler then makes a fresh one.
func (m *captchaManager) InvalidateC(purpose string) {
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
	fmt.Printf("🎫 [Captcha] %s token ready (queue: signin=%d reserve=%d)\n",
		purpose, m.queueLen("Signin"), m.queueLen("Reserve"))
}

// StartCaptchaQueue runs background fillers that keep Signin & Reserve queues
// topped up. Call once from main(): captchaMgr.loadConfig(); go StartCaptchaQueue().
func StartCaptchaQueue() {
	captchaMgr.mu.Lock()
	prov := captchaMgr.cfg.Provider
	hasKey := captchaMgr.cfg.Keys[prov] != "" || prov == "rumon" || prov == "relay"
	captchaMgr.mu.Unlock()
	fmt.Printf("🚀 [Captcha] Queue worker started (provider=%s, keyPresent=%v)\n", prov, hasKey)
	for {
		// RELAY: do NOT pre-queue. Relay tokens are pulled straight from the relay at
		// use time (the relay IS the queue, with its own 120s window) — pre-storing
		// them here would add a second hold and risk staleness. Only API-solved
		// providers keep a local pre-warmed queue.
		if captchaMgr.providerIsRelay() {
			time.Sleep(1 * time.Second)
			continue
		}
		size := captchaMgr.cfg.QueueSize
		for _, purpose := range []string{"Signin", "Reserve"} {
			if captchaMgr.queueLen(purpose) < size {
				captchaMgr.fillOne(purpose)
			}
		}
		time.Sleep(500 * time.Millisecond)
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
	captchaMgr.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"provider": provider,
		"size":     size,
		"signin":   captchaMgr.queueLen("Signin"),
		"reserve":  captchaMgr.queueLen("Reserve"),
	})
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

// RegisterCaptchaRoutes wires the captcha dashboard endpoints. Call once in main().
func RegisterCaptchaRoutes() {
	http.HandleFunc("/api/captchaConfig", handleCaptchaConfig)
	http.HandleFunc("/api/captchaQueue", handleCaptchaQueue)
	http.HandleFunc("/api/captchaTest", handleCaptchaTest)
}
