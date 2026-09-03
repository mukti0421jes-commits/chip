package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// ==================== CONSTANTS ====================
const (
	API_BASE             = "https://api.ivacbd.com"
	API_LOGIN_URL        = "https://api.ivacbd.com/iams/api/v1/auth/sign-in-v2"
	API_VERIFY_OTP_URL   = "https://api.ivacbd.com/iams/api/v1/otp/verifySigninOtp"
	API_RESERVE_SLOT_URL = "https://api.ivacbd.com/iams/api/v1/slots/reserveSlot"
	API_PAYMENT_URL      = "https://api.ivacbd.com/iams/api/v1/payment/dg-epay/initiate"
	API_BOOKING_CONFIG   = "https://api.ivacbd.com/iams/api/v1/appointment/get-booking-config"
	API_SLOT_STATUS_URL  = "https://api.ivacbd.com/iams/api/v1/file/file-confirmation-and-slot-status"

	CAPTCHA_LOGIN_URL   = "https://thirdeyesms.shop/captcha-external/rumon-login-captcha.php"
	CAPTCHA_RESERVE_URL = "https://thirdeyesms.shop/captcha-external/rumon-reserve-captcha.php"
	CAPTCHA_SECRET      = "rumon98u8x8f31y3"

	WEBSITE_URL = "https://appointment.ivacbd.com"

	CONFIG_FILE       = "config.json"
	INSTANCES_FILE    = "instances.json"
	PROXY_CONFIG_FILE = "proxies.json"
	OTP_API_URL       = "https://duttauzzal.shop/sms.php"
	HOSTS_FILE        = "C:\\Windows\\System32\\drivers\\etc\\hosts"
	HOSTS_DOMAIN      = "api.ivacbd.com"

	REQUEST_MODE_PARALLEL = "parallel"
	REQUEST_MODE_SINGLE   = "single"

	ROUTING_MODE_PROXY_HOST = "proxy_host"
	ROUTING_MODE_PROXY_ONLY = "proxy_only"
	ROUTING_MODE_HOST_ONLY  = "host_only"
	ROUTING_MODE_DIRECT     = "direct"

	TOKEN_EXPIRY_SECONDS = 80
)

var browserHeaders = map[string]string{
	"accept":             "application/json, text/plain, */*",
	"accept-language":    "en-US,en;q=0.9",
	"cache-control":      "no-cache, no-store, must-revalidate",
	"pragma":             "no-cache",
	"priority":           "u=1, i",
	"sec-ch-ua":          `"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"`,
	"sec-ch-ua-mobile":   "?0",
	"sec-ch-ua-platform": `"Windows"`,
	"sec-fetch-dest":     "empty",
	"sec-fetch-mode":     "cors",
	"sec-fetch-site":     "same-site",
	"referrer":           "https://appointment.ivacbd.com/",
	"origin":             "https://appointment.ivacbd.com",
	"content-type":       "application/json",
	"user-agent":         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
}

// ==================== TOKEN MANAGEMENT ====================

type TokenType string

const (
	TokenTypeLogin   TokenType = "login"
	TokenTypeReserve TokenType = "reserve"
)

type TokenStatus string

const (
	TokenStatusValid   TokenStatus = "valid"
	TokenStatusInvalid TokenStatus = "invalid"
	TokenStatusExpired TokenStatus = "expired"
	TokenStatusUsed    TokenStatus = "used"
	TokenStatusPending TokenStatus = "pending"
)

type CaptchaToken struct {
	Token      string      `json:"token"`
	Type       TokenType   `json:"type"`
	Status     TokenStatus `json:"status"`
	CreatedAt  time.Time   `json:"createdAt"`
	LastUsedAt time.Time   `json:"lastUsedAt"`
	UseCount   int         `json:"useCount"`
	InstanceID int         `json:"instanceId"`
	ExpiresAt  time.Time   `json:"expiresAt"`
	Source     string      `json:"source"`
}

type TokenManager struct {
	mu              sync.RWMutex
	tokens          map[string]*CaptchaToken
	instanceTokens  map[int][]string
	usedTokens      map[string]bool
	invalidTokens   map[string]bool
	tokenExpiry     time.Duration
	cleanupInterval time.Duration
	stopChan        chan struct{}
}

// ==================== CONFIGURATION ====================

type NetworkRequest struct {
	Endpoint      string    `json:"endpoint"`
	Method        string    `json:"method"`
	StatusCode    int       `json:"statusCode"`
	StatusText    string    `json:"statusText"`
	ClientIP      string    `json:"clientIp"`
	ProxyIP       string    `json:"proxyIp"`
	HostIP        string    `json:"hostIp"`
	Timestamp     time.Time `json:"timestamp"`
	Duration      string    `json:"duration"`
	RequestID     string    `json:"requestId,omitempty"`
	RespBody      string    `json:"respBody,omitempty"`
	TokenUsed     string    `json:"tokenUsed"`
	TokenStatus   string    `json:"tokenStatus"`
	TokenSource   string    `json:"tokenSource"`
	InstanceID    int       `json:"instanceId"`
	ProxyRotated  bool      `json:"proxyRotated"`
	ProxyCount    int       `json:"proxyCount"`
}

type ParallelRetryItem struct {
	Enabled      bool   `json:"enabled"`
	Hits         []int  `json:"hits"`
	DelayMs      int    `json:"delayMs"`
	ReuseCaptcha bool   `json:"reuseCaptcha"`
}

type ParallelRetryConfig struct {
	Signin  ParallelRetryItem `json:"signin"`
	Verify  ParallelRetryItem `json:"verify"`
	Reserve ParallelRetryItem `json:"reserve"`
	Booking ParallelRetryItem `json:"booking"`
	Payment ParallelRetryItem `json:"payment"`
}

type SingleHitRetryItem struct {
	Enabled      bool `json:"enabled"`
	Hits         int  `json:"hits"`
	DelayMs      int  `json:"delayMs"`
	ReuseCaptcha bool `json:"reuseCaptcha"`
}

type SingleHitRetryConfig struct {
	Signin  SingleHitRetryItem `json:"signin"`
	Verify  SingleHitRetryItem `json:"verify"`
	Reserve SingleHitRetryItem `json:"reserve"`
	Booking SingleHitRetryItem `json:"booking"`
	Payment SingleHitRetryItem `json:"payment"`
}

type ParallelConfig struct {
	SigninHits   int `json:"signinHits"`
	SigninMs     int `json:"signinMs"`
	VerifyHits   int `json:"verifyHits"`
	VerifyMs     int `json:"verifyMs"`
	ReserveHits  int `json:"reserveHits"`
	ReserveMs    int `json:"reserveMs"`
	BookingHits  int `json:"bookingHits"`
	BookingMs    int `json:"bookingMs"`
	InitiateHits int `json:"initiateHits"`
	InitiateMs   int `json:"initiateMs"`
}

type DeviceInfo struct {
	DeviceID string `json:"deviceId"`
}

type SlotMonitorConfig struct {
	Enabled bool `json:"enabled"`
}

type SingleHitConfig struct {
	Enabled bool `json:"enabled"`
	DelayMs int  `json:"delayMs"`
}

type Config struct {
	HostIPs              []string            `json:"hostIPs"`
	ActiveHostIP         string              `json:"activeHostIP"`
	LoginMode            string              `json:"loginMode"`
	AutoOTP              bool                `json:"autoOtp"`
	OTPRetryDelay        int                 `json:"otpRetryDelay"`
	SlotMonitor          SlotMonitorConfig   `json:"slotMonitor"`
	SlotCheckInterval    int                 `json:"slotCheckInterval"`
	Parallel             ParallelConfig      `json:"parallel"`
	ParallelRetry        ParallelRetryConfig `json:"parallelRetry"`
	RequestMode          string              `json:"requestMode"`
	RoutingMode          string              `json:"routingMode"`
	SingleHit            SingleHitConfig     `json:"singleHit"`
	SingleHitRetry       SingleHitRetryConfig `json:"singleHitRetry"`
	TokenExpiry          int                 `json:"tokenExpiry"`
	SingleRetryEnabled   bool                `json:"singleRetryEnabled"`
	ParallelRetryEnabled bool                `json:"parallelRetryEnabled"`

	// ── Frontend-controlled step retry (RJ SLOT JS parity) ──
	// FlowSingle ON  → a failed step retries after its per-step delay.
	// FlowSingle OFF → a failed step stops the flow (no retry).
	// FlowAuto   ON  → after a step succeeds, automatically continue to the next.
	// FlowAuto   OFF → stop after the current step succeeds (wait, no auto-advance).
	FlowSingle    bool           `json:"flowSingle"`
	FlowAuto      bool           `json:"flowAuto"`
	StepDelaySec  map[string]int `json:"stepDelaySec"` // signin/verify/reserve/book/initiate (seconds) — Single retry delay
	AutoDelaySec  int            `json:"autoDelaySec"` // delay between steps when Auto chains (the "0" field)
}

type RoutingModeInfo struct {
	Mode        string `json:"mode"`
	DisplayName string `json:"displayName"`
	Description string `json:"description"`
	UsesProxy   bool   `json:"usesProxy"`
	UsesHost    bool   `json:"usesHost"`
}

type InstanceData struct {
	ID               int              `json:"id"`
	Owner            string           `json:"owner"`     // RJ Slot Hub: which portal user owns this
	PortalEntryID    string           `json:"portalEntryId"`
	PayMode          string           `json:"payMode"`   // admin | self
	ClientName       string           `json:"clientName"`
	LoginPhone       string           `json:"loginPhone"`
	Password         string           `json:"password"`
	OTPPhone         string           `json:"otpPhone"`
	Type             string           `json:"type"`
	HighCom          string           `json:"highCom"`
	VisaType         string           `json:"visaType"`
	Name             string           `json:"name"`
	Status           string           `json:"status"`
	Step             string           `json:"step"`
	OTP              string           `json:"otp"`
	ReservationID    string           `json:"reservationId"`
	AppointmentDate  string           `json:"appointmentDate"`
	PaymentURL       string           `json:"paymentUrl"`
	AppointmentID    string           `json:"appointmentId"`
	StartTime        time.Time        `json:"startTime"`
	Duration         string           `json:"duration"`
	Logs             []string         `json:"logs"`
	NetworkLogs      []NetworkRequest `json:"networkLogs"`
	CurrentHostIP    string           `json:"currentHostIP"`
	AssignedHostIP   string           `json:"assignedHostIP"`
	RetryCount       int              `json:"retryCount"`
	DeviceInfo       *DeviceInfo      `json:"deviceInfo"`
	ManualOTP        string           `json:"manualOtp"`
	ManualOTPTime    time.Time        `json:"manualOtpTime"`
	HasAppointmentID bool             `json:"hasAppointmentId"`
	PausedStep       string           `json:"pausedStep"`
	TokenStatus      string           `json:"tokenStatus"`
	TokenSource      string           `json:"tokenSource"`
	ProxyRotated     bool             `json:"proxyRotated"`
	LastProxyRotate  time.Time        `json:"lastProxyRotate"`
	CurrentProxy     string           `json:"currentProxy"`
}

type Instance struct {
	Data   InstanceData
	mu     sync.Mutex
	cancel context.CancelFunc
	client *IVACClient
}

type ProxyConfig struct {
	ID            string    `json:"id"`
	Type          string    `json:"type"`
	Host          string    `json:"host"`
	Port          int       `json:"port"`
	User          string    `json:"user"`
	Password      string    `json:"password"`
	Enabled       bool      `json:"enabled"`
	CreatedAt     time.Time `json:"createdAt"`
	LastTest      time.Time `json:"lastTest"`
	TestPass      bool      `json:"testPass"`
	ResponseMs    int       `json:"responseMs"`
	RotationCount int       `json:"rotationCount"`
}

type wsClient struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

type parallelResult struct {
	Success  bool
	Response *APIResponse
	Error    error
	Index    int
}

type DeviceGenerator struct {
	mu          sync.Mutex
	usedDevices map[string]bool
}

type EndpointSuccessTracker struct {
	mu         sync.RWMutex
	successMap map[string]bool
	cancelMap  map[string]context.CancelFunc
	muMap      map[string]*sync.Mutex
}

type HostStats struct {
	IP           string        `json:"ip"`
	SuccessCount int           `json:"successCount"`
	FailedCount  int           `json:"failedCount"`
	LastUsed     time.Time     `json:"lastUsed"`
	ResponseTime time.Duration `json:"responseTime"`
	IsHealthy    bool          `json:"isHealthy"`
	SuccessRate  float64       `json:"successRate"`
}

type HostRouter struct {
	mu             sync.RWMutex
	hostIPs        []string
	stats          map[string]*HostStats
	bestHostIP     string
	minSuccessRate float64
	roundRobinIdx  int
}

type APIResponse struct {
	SuccessFlag bool                   `json:"successFlag"`
	Message     string                 `json:"message"`
	Data        map[string]interface{} `json:"data"`
	Status      string                 `json:"status"`
	StatusCode  int                    `json:"statusCode"`
	RequestID   string                 `json:"requestId"`
	RespBody    string                 `json:"respBody,omitempty"`
}

type Session struct {
	Token      string
	RequestID  string
	LoginPhone string
	OTPPhone   string
	UserID     string
}

type IVACClient struct {
	session          *Session
	proxies          []string
	config           *Config
	logCb            func(string)
	stepCb           func(string, string, string, string, string)
	networkCb        func(NetworkRequest)
	instanceID       int
	currentProxy     string
	currentHostIP    string
	pooledClient     *http.Client
	deviceInfo       *DeviceInfo
	hasAppointmentID bool
	lastEndpoint     string
	ctx              context.Context
	cancel           context.CancelFunc
	successTracker   *EndpointSuccessTracker
	tokenManager     *TokenManager
	currentToken     string
	currentTokenType TokenType
	tokenSource      string
	tokenRefreshMu   sync.Mutex
	proxyRotationMu  sync.Mutex
}

// ==================== SLOT STATUS CACHE ====================

type SlotStatusCache struct {
	mu            sync.RWMutex
	lastStatus    bool
	lastCheck     time.Time
	expiry        time.Duration
	statusHistory []bool
	maxHistory    int
}

// ==================== GLOBAL VARIABLES ====================

var (
	instances    = make(map[int]*Instance)
	instanceID   int32 = 1
	instancesMu  sync.RWMutex
	globalConfig Config
	configMu     sync.RWMutex
	allRunning   = false
	allPaused    = false
	allRunningMu sync.RWMutex
	allPausedMu  sync.RWMutex

	globalProxies []ProxyConfig
	proxiesMu     sync.RWMutex

	slotMonitorRunning  = false
	slotMonitorMu       sync.RWMutex
	slotMonitorStopChan chan bool

	upgrader    = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	wsClients   = make(map[*websocket.Conn]*wsClient)
	wsClientsMu sync.RWMutex

	globalConfigReloadChan = make(chan bool, 1)

	globalDeviceGenerator *DeviceGenerator
	deviceGenOnce         sync.Once

	globalHostRouter *HostRouter
	hostRouterOnce   sync.Once

	globalSlotStatusCache *SlotStatusCache
	slotCacheOnce         sync.Once

	globalTokenManager *TokenManager
	tokenManagerOnce   sync.Once
)

// ==================== TOKEN MANAGER IMPLEMENTATION ====================

func GetTokenManager() *TokenManager {
	tokenManagerOnce.Do(func() {
		configMu.RLock()
		expiry := globalConfig.TokenExpiry
		configMu.RUnlock()
		if expiry <= 0 {
			expiry = TOKEN_EXPIRY_SECONDS
		}
		globalTokenManager = NewTokenManager(time.Duration(expiry) * time.Second)
	})
	return globalTokenManager
}

func NewTokenManager(tokenExpiry time.Duration) *TokenManager {
	tm := &TokenManager{
		tokens:          make(map[string]*CaptchaToken),
		instanceTokens:  make(map[int][]string),
		usedTokens:      make(map[string]bool),
		invalidTokens:   make(map[string]bool),
		tokenExpiry:     tokenExpiry,
		cleanupInterval: 30 * time.Second,
		stopChan:        make(chan struct{}),
	}
	go tm.cleanupLoop()
	return tm
}

func (tm *TokenManager) cleanupLoop() {
	ticker := time.NewTicker(tm.cleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-tm.stopChan:
			return
		case <-ticker.C:
			tm.cleanupExpiredTokens()
		}
	}
}

func (tm *TokenManager) cleanupExpiredTokens() {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	now := time.Now()
	var toDelete []string

	for token, tokenData := range tm.tokens {
		if tokenData.Status == TokenStatusUsed ||
			tokenData.Status == TokenStatusInvalid ||
			tokenData.Status == TokenStatusExpired ||
			now.After(tokenData.ExpiresAt) {
			toDelete = append(toDelete, token)
		}
	}

	for _, token := range toDelete {
		tm.removeTokenInternal(token)
	}
}

func (tm *TokenManager) removeTokenInternal(token string) {
	if tokenData, exists := tm.tokens[token]; exists {
		instanceID := tokenData.InstanceID
		if tokens, exists := tm.instanceTokens[instanceID]; exists {
			var newTokens []string
			for _, t := range tokens {
				if t != token {
					newTokens = append(newTokens, t)
				}
			}
			if len(newTokens) == 0 {
				delete(tm.instanceTokens, instanceID)
			} else {
				tm.instanceTokens[instanceID] = newTokens
			}
		}
	}

	delete(tm.tokens, token)
	delete(tm.usedTokens, token)
	delete(tm.invalidTokens, token)
}

func (tm *TokenManager) GetToken(instanceID int, tokenType TokenType) string {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	tokens, exists := tm.instanceTokens[instanceID]
	if !exists {
		return ""
	}

	for _, token := range tokens {
		tokenData, ok := tm.tokens[token]
		if !ok {
			continue
		}

		if tokenData.Type == tokenType &&
			tokenData.Status == TokenStatusValid &&
			time.Now().Before(tokenData.ExpiresAt) &&
			!tm.usedTokens[token] &&
			!tm.invalidTokens[token] {
			return token
		}
	}

	return ""
}

func (tm *TokenManager) MarkTokenAsUsed(token string) {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	if tokenData, exists := tm.tokens[token]; exists {
		tokenData.Status = TokenStatusUsed
		tokenData.LastUsedAt = time.Now()
		tokenData.UseCount++
		tm.usedTokens[token] = true

		instanceID := tokenData.InstanceID
		if tokens, exists := tm.instanceTokens[instanceID]; exists {
			var newTokens []string
			for _, t := range tokens {
				if t != token {
					newTokens = append(newTokens, t)
				}
			}
			if len(newTokens) == 0 {
				delete(tm.instanceTokens, instanceID)
			} else {
				tm.instanceTokens[instanceID] = newTokens
			}
		}
	}
}

func (tm *TokenManager) MarkTokenAsInvalid(token string) {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	if tokenData, exists := tm.tokens[token]; exists {
		tokenData.Status = TokenStatusInvalid
		tm.invalidTokens[token] = true

		instanceID := tokenData.InstanceID
		if tokens, exists := tm.instanceTokens[instanceID]; exists {
			var newTokens []string
			for _, t := range tokens {
				if t != token {
					newTokens = append(newTokens, t)
				}
			}
			if len(newTokens) == 0 {
				delete(tm.instanceTokens, instanceID)
			} else {
				tm.instanceTokens[instanceID] = newTokens
			}
		}
	}
}

func (tm *TokenManager) IsTokenInvalid(token string) bool {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	return tm.invalidTokens[token]
}

func (tm *TokenManager) IsTokenUsed(token string) bool {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	return tm.usedTokens[token]
}

func (tm *TokenManager) GetTokenStatus(token string) TokenStatus {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	if tokenData, exists := tm.tokens[token]; exists {
		return tokenData.Status
	}
	return TokenStatusInvalid
}

func (tm *TokenManager) GenerateAndStoreToken(instanceID int, tokenType TokenType, token string) (*CaptchaToken, error) {
	if token == "" {
		return nil, fmt.Errorf("empty token received")
	}

	tm.mu.Lock()
	defer tm.mu.Unlock()

	if existing, exists := tm.tokens[token]; exists {
		if existing.Status == TokenStatusInvalid || existing.Status == TokenStatusUsed {
			return nil, fmt.Errorf("token already invalid/used")
		}
		existing.Source = "cached"
		return existing, nil
	}

	tokenData := &CaptchaToken{
		Token:      token,
		Type:       tokenType,
		Status:     TokenStatusValid,
		CreatedAt:  time.Now(),
		LastUsedAt: time.Now(),
		UseCount:   0,
		InstanceID: instanceID,
		ExpiresAt:  time.Now().Add(tm.tokenExpiry),
		Source:     "new",
	}

	tm.tokens[token] = tokenData
	tm.instanceTokens[instanceID] = append(tm.instanceTokens[instanceID], token)

	return tokenData, nil
}

func (tm *TokenManager) GetTokensForInstance(instanceID int) []*CaptchaToken {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	tokens, exists := tm.instanceTokens[instanceID]
	if !exists {
		return []*CaptchaToken{}
	}

	var result []*CaptchaToken
	for _, token := range tokens {
		if tokenData, ok := tm.tokens[token]; ok {
			result = append(result, tokenData)
		}
	}
	return result
}

func (tm *TokenManager) GetValidTokenCount(instanceID int, tokenType TokenType) int {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	tokens, exists := tm.instanceTokens[instanceID]
	if !exists {
		return 0
	}

	count := 0
	for _, token := range tokens {
		tokenData, ok := tm.tokens[token]
		if !ok {
			continue
		}
		if tokenData.Type == tokenType &&
			tokenData.Status == TokenStatusValid &&
			time.Now().Before(tokenData.ExpiresAt) &&
			!tm.usedTokens[token] &&
			!tm.invalidTokens[token] {
			count++
		}
	}
	return count
}

func (tm *TokenManager) ClearInstanceTokens(instanceID int) {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	if tokens, exists := tm.instanceTokens[instanceID]; exists {
		for _, token := range tokens {
			delete(tm.tokens, token)
			delete(tm.usedTokens, token)
			delete(tm.invalidTokens, token)
		}
		delete(tm.instanceTokens, instanceID)
	}
}

func (tm *TokenManager) Stop() {
	close(tm.stopChan)
}

// ==================== TOKEN VALIDATION FUNCTIONS ====================

func (c *IVACClient) validateTokenBeforeRequest(token string, tokenType TokenType) (string, error) {
	tm := GetTokenManager()

	if token == "" {
		c.log("🔍 No token provided, fetching new token...")
		return c.fetchNewToken(tokenType)
	}

	tokenData, exists := tm.tokens[token]
	if !exists {
		c.log("🔍 Token not found in database, fetching new token...")
		return c.fetchNewToken(tokenType)
	}

	if tokenData.Status == TokenStatusInvalid {
		c.log("🔍 Token is marked as invalid, fetching new token...")
		tm.MarkTokenAsInvalid(token)
		return c.fetchNewToken(tokenType)
	}

	if tokenData.Status == TokenStatusUsed {
		c.log("🔍 Token is already used, fetching new token...")
		return c.fetchNewToken(tokenType)
	}

	if tokenData.Status == TokenStatusExpired {
		c.log("🔍 Token has expired, fetching new token...")
		tm.MarkTokenAsInvalid(token)
		return c.fetchNewToken(tokenType)
	}

	if time.Now().After(tokenData.ExpiresAt) {
		c.log("🔍 Token expired (time check), fetching new token...")
		tm.MarkTokenAsInvalid(token)
		return c.fetchNewToken(tokenType)
	}

	if tokenData.InstanceID != c.instanceID {
		c.log(fmt.Sprintf("🔍 Token belongs to instance %d, not %d. Fetching new token...",
			tokenData.InstanceID, c.instanceID))
		return c.fetchNewToken(tokenType)
	}

	c.tokenSource = "database"
	c.log(fmt.Sprintf("✅ Token is valid (instance: %d, type: %s, expires in: %s)",
		c.instanceID, tokenType, time.Until(tokenData.ExpiresAt).String()))

	return token, nil
}

// ==================== FRESH TOKEN FUNCTIONS ====================

func (c *IVACClient) fetchNewToken(tokenType TokenType) (string, error) {
	c.tokenRefreshMu.Lock()
	defer c.tokenRefreshMu.Unlock()

	c.log(fmt.Sprintf("🔄 Fetching new %s token for instance %d...", tokenType, c.instanceID))

	var token string
	var err error

	if tokenType == TokenTypeLogin {
		token, err = getLoginCaptchaToken()
	} else {
		token, err = getReserveCaptchaToken()
	}

	if err != nil {
		return "", fmt.Errorf("failed to fetch %s token: %v", tokenType, err)
	}

	if token == "" {
		return "", fmt.Errorf("empty %s token received", tokenType)
	}

	tm := GetTokenManager()
	_, err = tm.GenerateAndStoreToken(c.instanceID, tokenType, token)
	if err != nil {
		return "", fmt.Errorf("failed to store token: %v", err)
	}

	c.tokenSource = "new"
	c.log(fmt.Sprintf("✅ New %s token generated for instance %d: %s...",
		tokenType, c.instanceID, token[:min(8, len(token))]))

	return token, nil
}

func (c *IVACClient) getInstanceToken(tokenType TokenType) (string, error) {
	tm := GetTokenManager()

	token := tm.GetToken(c.instanceID, tokenType)
	if token != "" {
		validated, err := c.validateTokenBeforeRequest(token, tokenType)
		if err == nil && validated != "" {
			c.tokenSource = "cached"
			c.log(fmt.Sprintf("🔄 Using existing %s token for instance %d: %s...",
				tokenType, c.instanceID, token[:min(8, len(token))]))
			return validated, nil
		}
	}

	c.log(fmt.Sprintf("🔄 No valid %s token found for instance %d, fetching new...",
		tokenType, c.instanceID))
	
	token, err := c.fetchNewToken(tokenType)
	if err != nil {
		c.log(fmt.Sprintf("⚠️ Failed to fetch new %s token: %v", tokenType, err))
		
		c.log(fmt.Sprintf("⏳ Will retry fetching %s token after 3 seconds...", tokenType))
		time.Sleep(3 * time.Second)
		
		token, err = c.fetchNewToken(tokenType)
		if err != nil {
			return "", fmt.Errorf("failed to fetch %s token after retry: %v", tokenType, err)
		}
	}
	
	return token, nil
}

func (c *IVACClient) validateDatabaseToken(requestToken string, tokenType TokenType) (bool, string, error) {
	tm := GetTokenManager()

	tokenData, exists := tm.tokens[requestToken]
	if !exists {
		return false, "Token not found in database", nil
	}

	if tokenData.InstanceID != c.instanceID {
		return false, fmt.Sprintf("Token belongs to instance %d, not %d",
			tokenData.InstanceID, c.instanceID), nil
	}

	if tokenData.Type != tokenType {
		return false, fmt.Sprintf("Token type mismatch: expected %s, got %s",
			tokenType, tokenData.Type), nil
	}

	if tokenData.Status == TokenStatusInvalid {
		return false, "Token is marked as invalid", nil
	}

	if tokenData.Status == TokenStatusUsed {
		return false, "Token is already used", nil
	}

	if tokenData.Status == TokenStatusExpired {
		return false, "Token has expired", nil
	}

	if time.Now().After(tokenData.ExpiresAt) {
		return false, "Token has expired (time check)", nil
	}

	return true, "Token is valid", nil
}

// ==================== HELPER FUNCTIONS ====================

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func GetDeviceGenerator() *DeviceGenerator {
	deviceGenOnce.Do(func() {
		globalDeviceGenerator = &DeviceGenerator{
			usedDevices: make(map[string]bool),
		}
	})
	return globalDeviceGenerator
}

func generateDeviceID() string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	result := make([]byte, 20)
	for i := range result {
		result[i] = chars[rand.Intn(len(chars))]
	}
	return string(result)
}

func (dg *DeviceGenerator) GenerateDeviceInfo(instanceID int) *DeviceInfo {
	dg.mu.Lock()
	defer dg.mu.Unlock()
	var deviceID string
	for {
		deviceID = generateDeviceID()
		if !dg.usedDevices[deviceID] {
			break
		}
	}
	dg.usedDevices[deviceID] = true
	return &DeviceInfo{
		DeviceID: deviceID,
	}
}

func NewEndpointSuccessTracker() *EndpointSuccessTracker {
	return &EndpointSuccessTracker{
		successMap: make(map[string]bool),
		cancelMap:  make(map[string]context.CancelFunc),
		muMap:      make(map[string]*sync.Mutex),
	}
}

func (t *EndpointSuccessTracker) IsSuccess(endpoint string) bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.successMap[endpoint]
}

func (t *EndpointSuccessTracker) MarkSuccess(endpoint string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.successMap[endpoint] = true
	if cancel, exists := t.cancelMap[endpoint]; exists && cancel != nil {
		cancel()
		delete(t.cancelMap, endpoint)
	}
}

func (t *EndpointSuccessTracker) RegisterCancel(endpoint string, cancel context.CancelFunc) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.successMap[endpoint] {
		if cancel != nil {
			cancel()
		}
		return
	}
	if oldCancel, exists := t.cancelMap[endpoint]; exists && oldCancel != nil {
		oldCancel()
	}
	t.cancelMap[endpoint] = cancel
}

func (t *EndpointSuccessTracker) Reset(endpoint string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.successMap, endpoint)
	if cancel, exists := t.cancelMap[endpoint]; exists && cancel != nil {
		cancel()
	}
	delete(t.cancelMap, endpoint)
}

func (t *EndpointSuccessTracker) GetMutex(endpoint string) *sync.Mutex {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, exists := t.muMap[endpoint]; !exists {
		t.muMap[endpoint] = &sync.Mutex{}
	}
	return t.muMap[endpoint]
}

// ==================== SLOT STATUS CACHE ====================

func GetSlotStatusCache() *SlotStatusCache {
	slotCacheOnce.Do(func() {
		globalSlotStatusCache = NewSlotStatusCache(30*time.Second, 10)
	})
	return globalSlotStatusCache
}

func NewSlotStatusCache(expiry time.Duration, maxHistory int) *SlotStatusCache {
	return &SlotStatusCache{
		lastStatus:    false,
		lastCheck:     time.Time{},
		expiry:        expiry,
		statusHistory: make([]bool, 0),
		maxHistory:    maxHistory,
	}
}

func (c *SlotStatusCache) GetStatus() (bool, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if time.Since(c.lastCheck) < c.expiry {
		return c.lastStatus, true
	}

	return false, false
}

func (c *SlotStatusCache) SetStatus(status bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.lastStatus = status
	c.lastCheck = time.Now()

	c.statusHistory = append(c.statusHistory, status)
	if len(c.statusHistory) > c.maxHistory {
		c.statusHistory = c.statusHistory[1:]
	}
}

func (c *SlotStatusCache) GetHistory() []bool {
	c.mu.RLock()
	defer c.mu.RUnlock()

	history := make([]bool, len(c.statusHistory))
	copy(history, c.statusHistory)
	return history
}

func (c *SlotStatusCache) GetChangeCount() int {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if len(c.statusHistory) < 2 {
		return 0
	}

	changes := 0
	for i := 1; i < len(c.statusHistory); i++ {
		if c.statusHistory[i] != c.statusHistory[i-1] {
			changes++
		}
	}
	return changes
}

// ==================== ROUTING MODE ====================

func GetRoutingModeInfo(mode string) RoutingModeInfo {
	switch mode {
	case ROUTING_MODE_PROXY_HOST:
		return RoutingModeInfo{
			Mode:        ROUTING_MODE_PROXY_HOST,
			DisplayName: "🌐 PROXY + HOST",
			Description: "Instance → Proxy → Host IP → API",
			UsesProxy:   true,
			UsesHost:    true,
		}
	case ROUTING_MODE_PROXY_ONLY:
		return RoutingModeInfo{
			Mode:        ROUTING_MODE_PROXY_ONLY,
			DisplayName: "🔒 PROXY ONLY",
			Description: "Instance → Proxy → Direct API",
			UsesProxy:   true,
			UsesHost:    false,
		}
	case ROUTING_MODE_HOST_ONLY:
		return RoutingModeInfo{
			Mode:        ROUTING_MODE_HOST_ONLY,
			DisplayName: "🖥️ HOST ONLY",
			Description: "Instance → Host IP → API",
			UsesProxy:   false,
			UsesHost:    true,
		}
	case ROUTING_MODE_DIRECT:
		return RoutingModeInfo{
			Mode:        ROUTING_MODE_DIRECT,
			DisplayName: "⚡ DIRECT",
			Description: "Instance → Direct API",
			UsesProxy:   false,
			UsesHost:    false,
		}
	default:
		return RoutingModeInfo{
			Mode:        ROUTING_MODE_DIRECT,
			DisplayName: "⚡ DIRECT",
			Description: "Instance → Direct API",
			UsesProxy:   false,
			UsesHost:    false,
		}
	}
}

func GetAvailableRoutingModes() []RoutingModeInfo {
	configMu.RLock()
	defer configMu.RUnlock()
	hasProxy := len(getEnabledProxies()) > 0
	hasHost := len(globalConfig.HostIPs) > 0
	var modes []RoutingModeInfo
	if hasProxy && hasHost {
		modes = append(modes, GetRoutingModeInfo(ROUTING_MODE_PROXY_HOST))
	}
	if hasProxy {
		modes = append(modes, GetRoutingModeInfo(ROUTING_MODE_PROXY_ONLY))
	}
	if hasHost {
		modes = append(modes, GetRoutingModeInfo(ROUTING_MODE_HOST_ONLY))
	}
	modes = append(modes, GetRoutingModeInfo(ROUTING_MODE_DIRECT))
	return modes
}

func GetCurrentRoutingMode() string {
	configMu.RLock()
	defer configMu.RUnlock()
	mode := globalConfig.RoutingMode
	if mode == "" {
		mode = ROUTING_MODE_DIRECT
	}
	return mode
}

func SetRoutingMode(mode string) error {
	configMu.Lock()
	defer configMu.Unlock()
	validModes := []string{ROUTING_MODE_PROXY_HOST, ROUTING_MODE_PROXY_ONLY, ROUTING_MODE_HOST_ONLY, ROUTING_MODE_DIRECT}
	isValid := false
	for _, vm := range validModes {
		if vm == mode {
			isValid = true
			break
		}
	}
	if !isValid {
		return fmt.Errorf("invalid routing mode: %s", mode)
	}
	globalConfig.RoutingMode = mode
	return nil
}

func GetRoutingModeStatus() map[string]interface{} {
	configMu.RLock()
	defer configMu.RUnlock()
	hasProxy := len(getEnabledProxies()) > 0
	hasHost := len(globalConfig.HostIPs) > 0
	currentMode := globalConfig.RoutingMode
	if currentMode == "" {
		currentMode = ROUTING_MODE_DIRECT
	}
	return map[string]interface{}{
		"currentMode":    currentMode,
		"hasProxy":       hasProxy,
		"hasHost":        hasHost,
		"proxyCount":     len(getEnabledProxies()),
		"hostCount":      len(globalConfig.HostIPs),
		"modeInfo":       GetRoutingModeInfo(currentMode),
		"availableModes": GetAvailableRoutingModes(),
	}
}

// ==================== CONFIG FUNCTIONS ====================

func loadConfig() error {
	configMu.Lock()
	defer configMu.Unlock()
	globalConfig = Config{
		HostIPs:              []string{},
		LoginMode:            "auto",
		AutoOTP:              true,
		OTPRetryDelay:        5000,
		SlotMonitor:          SlotMonitorConfig{Enabled: false},
		SlotCheckInterval:    15,
		RequestMode:          REQUEST_MODE_SINGLE,
		RoutingMode:          ROUTING_MODE_DIRECT,
		SingleHit:            SingleHitConfig{Enabled: false, DelayMs: 1000},
		TokenExpiry:          TOKEN_EXPIRY_SECONDS,
		SingleRetryEnabled:   false,
		ParallelRetryEnabled: false,
		FlowSingle:           true,
		FlowAuto:             true,
		StepDelaySec: map[string]int{
			"signin": 4, "verify": 4, "reserve": 21, "book": 4, "initiate": 4,
		},
		SingleHitRetry: SingleHitRetryConfig{
			Signin:  SingleHitRetryItem{Enabled: false, Hits: 2, DelayMs: 100, ReuseCaptcha: true},
			Verify:  SingleHitRetryItem{Enabled: false, Hits: 2, DelayMs: 100, ReuseCaptcha: false},
			Reserve: SingleHitRetryItem{Enabled: false, Hits: 2, DelayMs: 100, ReuseCaptcha: true},
			Booking: SingleHitRetryItem{Enabled: false, Hits: 2, DelayMs: 100, ReuseCaptcha: false},
			Payment: SingleHitRetryItem{Enabled: false, Hits: 2, DelayMs: 100, ReuseCaptcha: false},
		},
		Parallel: ParallelConfig{
			SigninHits: 15, SigninMs: 300,
			VerifyHits: 25, VerifyMs: 500,
			ReserveHits: 10, ReserveMs: 1000,
			BookingHits: 10, BookingMs: 500,
			InitiateHits: 2, InitiateMs: 100,
		},
		ParallelRetry: ParallelRetryConfig{
			Signin:  ParallelRetryItem{Enabled: false, Hits: []int{3, 2, 5, 4}, DelayMs: 100, ReuseCaptcha: true},
			Verify:  ParallelRetryItem{Enabled: false, Hits: []int{3, 2, 5, 4}, DelayMs: 100, ReuseCaptcha: false},
			Reserve: ParallelRetryItem{Enabled: false, Hits: []int{3, 2, 5, 4}, DelayMs: 100, ReuseCaptcha: true},
			Booking: ParallelRetryItem{Enabled: false, Hits: []int{3, 2, 5, 4}, DelayMs: 100, ReuseCaptcha: false},
			Payment: ParallelRetryItem{Enabled: false, Hits: []int{3, 2, 5, 4}, DelayMs: 100, ReuseCaptcha: false},
		},
	}
	data, err := os.ReadFile(CONFIG_FILE)
	if err != nil {
		return saveConfigFile()
	}
	if uerr := json.Unmarshal(data, &globalConfig); uerr != nil {
		return uerr
	}
	// Backfill new flow-control fields for configs saved before this feature.
	if globalConfig.StepDelaySec == nil {
		globalConfig.StepDelaySec = map[string]int{
			"signin": 4, "verify": 4, "reserve": 21, "book": 4, "initiate": 4,
		}
		globalConfig.FlowSingle = true
		globalConfig.FlowAuto = true
	}
	return nil
}

func saveConfigFile() error {
	data, _ := json.MarshalIndent(globalConfig, "", "  ")
	return os.WriteFile(CONFIG_FILE, data, 0644)
}

func saveConfig() {
	configMu.RLock()
	defer configMu.RUnlock()
	saveConfigFile()
}

// ==================== PROXY FUNCTIONS ====================

func loadProxies() error {
	proxiesMu.Lock()
	defer proxiesMu.Unlock()
	data, err := os.ReadFile(PROXY_CONFIG_FILE)
	if err != nil {
		globalProxies = []ProxyConfig{}
		return saveProxiesFile()
	}
	return json.Unmarshal(data, &globalProxies)
}

func saveProxiesFile() error {
	data, _ := json.MarshalIndent(globalProxies, "", "  ")
	return os.WriteFile(PROXY_CONFIG_FILE, data, 0644)
}

func addProxy(proxy ProxyConfig) {
	proxiesMu.Lock()
	defer proxiesMu.Unlock()
	proxy.ID = fmt.Sprintf("%d", time.Now().UnixNano())
	proxy.CreatedAt = time.Now()
	proxy.RotationCount = 0
	globalProxies = append(globalProxies, proxy)
	saveProxiesFile()
}

func updateProxy(id string, proxy ProxyConfig) {
	proxiesMu.Lock()
	defer proxiesMu.Unlock()
	for i, p := range globalProxies {
		if p.ID == id {
			proxy.ID = id
			proxy.CreatedAt = p.CreatedAt
			proxy.RotationCount = p.RotationCount
			globalProxies[i] = proxy
			break
		}
	}
	saveProxiesFile()
}

func deleteProxy(id string) {
	proxiesMu.Lock()
	defer proxiesMu.Unlock()
	for i, p := range globalProxies {
		if p.ID == id {
			globalProxies = append(globalProxies[:i], globalProxies[i+1:]...)
			break
		}
	}
	saveProxiesFile()
}

func getEnabledProxies() []ProxyConfig {
	proxiesMu.RLock()
	defer proxiesMu.RUnlock()
	var enabled []ProxyConfig
	for _, p := range globalProxies {
		if p.Enabled {
			enabled = append(enabled, p)
		}
	}
	return enabled
}

func getProxyURL(proxy ProxyConfig) string {
	if !proxy.Enabled {
		return ""
	}
	auth := ""
	if proxy.User != "" && proxy.Password != "" {
		auth = fmt.Sprintf("%s:%s@", proxy.User, proxy.Password)
	}
	return fmt.Sprintf("%s://%s%s:%d", proxy.Type, auth, proxy.Host, proxy.Port)
}

// parseProxyLineGo parses one bulk line into a ProxyConfig. Accepted formats:
//   host:port
//   host:port:user:pass
//   scheme://host:port
//   scheme://user:pass@host:port
//   scheme://host:port:user:pass
// scheme = http|https|socks4|socks5 (default http). Returns ok=false if invalid.
func parseProxyLineGo(line string) (ProxyConfig, bool) {
	s := strings.TrimSpace(line)
	if s == "" {
		return ProxyConfig{}, false
	}
	scheme := "http"
	if i := strings.Index(s, "://"); i >= 0 {
		sc := strings.ToLower(s[:i])
		switch sc {
		case "http", "https", "socks4", "socks5":
			scheme = sc
		}
		s = s[i+3:]
	}
	user, pass := "", ""
	// user:pass@host:port
	if at := strings.LastIndex(s, "@"); at >= 0 {
		cred := s[:at]
		s = s[at+1:]
		if c := strings.Index(cred, ":"); c >= 0 {
			user, pass = cred[:c], cred[c+1:]
		} else {
			user = cred
		}
	}
	parts := strings.Split(s, ":")
	if len(parts) != 2 && len(parts) != 4 {
		return ProxyConfig{}, false
	}
	host := strings.TrimSpace(parts[0])
	port, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if host == "" || err != nil || port < 1 || port > 65535 {
		return ProxyConfig{}, false
	}
	if len(parts) == 4 { // host:port:user:pass
		user, pass = strings.TrimSpace(parts[2]), strings.TrimSpace(parts[3])
	}
	return ProxyConfig{
		Type: scheme, Host: host, Port: port, User: user, Password: pass,
		Enabled: true, CreatedAt: time.Now(),
	}, true
}

func detectProxyType(host string, port int) string {
	testURL := fmt.Sprintf("http://%s:%d", host, port)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(testURL)
	if err == nil && resp != nil {
		resp.Body.Close()
		return "http"
	}
	testURL = fmt.Sprintf("https://%s:%d", host, port)
	resp, err = client.Get(testURL)
	if err == nil && resp != nil {
		resp.Body.Close()
		return "https"
	}
	return "http"
}

func testProxy(proxy *ProxyConfig) bool {
	proxyURL := getProxyURL(*proxy)
	if proxyURL == "" {
		return false
	}
	start := time.Now()
	transport := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	if parsedURL, err := url.Parse(proxyURL); err == nil {
		transport.Proxy = http.ProxyURL(parsedURL)
	}
	client := &http.Client{Timeout: 10 * time.Second, Transport: transport}
	resp, err := client.Get("https://api.ipify.org?format=json")
	if err != nil {
		proxy.TestPass = false
		proxy.ResponseMs = int(time.Since(start).Milliseconds())
		return false
	}
	defer resp.Body.Close()
	proxy.TestPass = resp.StatusCode == 200
	proxy.ResponseMs = int(time.Since(start).Milliseconds())
	proxy.LastTest = time.Now()
	return proxy.TestPass
}

func testAllProxies() {
	// Snapshot under a quick read lock so the proxy list stays readable while we
	// run the (slow) network tests WITHOUT holding the lock.
	proxiesMu.RLock()
	snapshot := make([]ProxyConfig, len(globalProxies))
	copy(snapshot, globalProxies)
	proxiesMu.RUnlock()

	for i := range snapshot {
		testProxy(&snapshot[i]) // network calls — no lock held
	}

	// Write results back briefly.
	proxiesMu.Lock()
	for _, t := range snapshot {
		for j := range globalProxies {
			if globalProxies[j].ID == t.ID {
				globalProxies[j].TestPass = t.TestPass
				globalProxies[j].ResponseMs = t.ResponseMs
				globalProxies[j].LastTest = t.LastTest
				break
			}
		}
	}
	saveProxiesFile()
	proxiesMu.Unlock()
}

// ==================== PROXY ROTATION FUNCTIONS ====================

func (c *IVACClient) getNextProxy() string {
	proxies := getEnabledProxies()
	if len(proxies) == 0 {
		return ""
	}

	var workingProxies []ProxyConfig
	for _, p := range proxies {
		if p.TestPass {
			workingProxies = append(workingProxies, p)
		}
	}

	if len(workingProxies) > 0 {
		proxy := workingProxies[rand.Intn(len(workingProxies))]
		return getProxyURL(proxy)
	}

	proxy := proxies[rand.Intn(len(proxies))]
	return getProxyURL(proxy)
}

func (c *IVACClient) rotateProxyOnError(endpointName string) {
	c.proxyRotationMu.Lock()
	defer c.proxyRotationMu.Unlock()

	routingMode := GetCurrentRoutingMode()
	modeInfo := GetRoutingModeInfo(routingMode)

	if modeInfo.UsesProxy {
		c.log(fmt.Sprintf("🔄 Rotating proxy for %s due to error...", endpointName))

		oldProxy := c.currentProxy
		c.currentProxy = c.getNextProxy()

		if c.currentProxy != "" && c.currentProxy != oldProxy {
			c.log(fmt.Sprintf("🔄 Proxy rotated: %s → %s", oldProxy, c.currentProxy))

			proxiesMu.Lock()
			for i := range globalProxies {
				proxyURL := getProxyURL(globalProxies[i])
				if proxyURL == c.currentProxy {
					globalProxies[i].RotationCount++
					break
				}
			}
			proxiesMu.Unlock()
			saveProxiesFile()

			instancesMu.RLock()
			inst, ok := instances[c.instanceID]
			instancesMu.RUnlock()
			if ok {
				inst.mu.Lock()
				inst.Data.ProxyRotated = true
				inst.Data.LastProxyRotate = time.Now()
				inst.Data.CurrentProxy = c.currentProxy
				inst.mu.Unlock()
			}
		} else {
			c.log("⚠️ No new proxy available for rotation")
		}
	}
}

func (c *IVACClient) shouldRotateProxy(statusCode int, respBody string) bool {
	errorCodes := []int{400, 401, 403, 404, 429, 500, 502, 503, 504, 520, 530}
	for _, code := range errorCodes {
		if statusCode == code {
			return true
		}
	}

	errorKeywords := []string{"captcha", "verification", "expired", "invalid", "token", "rate limit", "too many requests"}
	lowerBody := strings.ToLower(respBody)
	for _, keyword := range errorKeywords {
		if strings.Contains(lowerBody, keyword) {
			return true
		}
	}

	return false
}

// ==================== HOST ROUTER ====================

func GetHostRouter() *HostRouter {
	hostRouterOnce.Do(func() {
		configMu.RLock()
		hostIPs := make([]string, len(globalConfig.HostIPs))
		copy(hostIPs, globalConfig.HostIPs)
		configMu.RUnlock()
		globalHostRouter = &HostRouter{
			hostIPs:        hostIPs,
			stats:          make(map[string]*HostStats),
			bestHostIP:     "",
			minSuccessRate: 0.7,
			roundRobinIdx:  0,
		}
		for _, ip := range hostIPs {
			globalHostRouter.stats[ip] = &HostStats{
				IP:           ip,
				SuccessCount: 0,
				FailedCount:  0,
				IsHealthy:    true,
				SuccessRate:  0,
			}
		}
	})
	return globalHostRouter
}

func (hr *HostRouter) UpdateHostIPs(ips []string) {
	hr.mu.Lock()
	defer hr.mu.Unlock()
	hr.hostIPs = ips
	for _, ip := range ips {
		if _, exists := hr.stats[ip]; !exists {
			hr.stats[ip] = &HostStats{
				IP:           ip,
				SuccessCount: 0,
				FailedCount:  0,
				IsHealthy:    true,
				SuccessRate:  0,
			}
		}
	}
	for ip := range hr.stats {
		found := false
		for _, hip := range ips {
			if hip == ip {
				found = true
				break
			}
		}
		if !found && ip != hr.bestHostIP {
			delete(hr.stats, ip)
		}
	}
	if hr.bestHostIP != "" {
		found := false
		for _, hip := range ips {
			if hip == hr.bestHostIP {
				found = true
				break
			}
		}
		if !found {
			hr.bestHostIP = ""
		}
	}
}

func (hr *HostRouter) GetInstanceHostIP(instanceID int) string {
	hr.mu.Lock()
	defer hr.mu.Unlock()
	if len(hr.hostIPs) == 0 {
		return ""
	}
	idx := instanceID % len(hr.hostIPs)
	return hr.hostIPs[idx]
}

func (hr *HostRouter) GetRandomHostIP() string {
	hr.mu.RLock()
	defer hr.mu.RUnlock()
	if len(hr.hostIPs) == 0 {
		return ""
	}
	if hr.bestHostIP != "" {
		return hr.bestHostIP
	}
	idx := rand.Intn(len(hr.hostIPs))
	return hr.hostIPs[idx]
}

func (hr *HostRouter) GetRandomDifferentHostIP(currentIP string) string {
	hr.mu.RLock()
	defer hr.mu.RUnlock()
	if len(hr.hostIPs) == 0 {
		return ""
	}
	if len(hr.hostIPs) == 1 {
		return hr.hostIPs[0]
	}
	var availableIPs []string
	for _, ip := range hr.hostIPs {
		if ip != currentIP {
			availableIPs = append(availableIPs, ip)
		}
	}
	if len(availableIPs) == 0 {
		availableIPs = hr.hostIPs
	}
	idx := rand.Intn(len(availableIPs))
	return availableIPs[idx]
}

func (hr *HostRouter) GetBestHostIP() string {
	hr.mu.RLock()
	defer hr.mu.RUnlock()
	return hr.bestHostIP
}

func (hr *HostRouter) RecordResult(ip string, success bool, responseTime time.Duration) {
	hr.mu.Lock()
	defer hr.mu.Unlock()
	stats, exists := hr.stats[ip]
	if !exists {
		stats = &HostStats{IP: ip, SuccessCount: 0, FailedCount: 0, IsHealthy: true}
		hr.stats[ip] = stats
	}
	stats.LastUsed = time.Now()
	if success {
		stats.SuccessCount++
		stats.ResponseTime = responseTime
	} else {
		stats.FailedCount++
	}
	total := stats.SuccessCount + stats.FailedCount
	if total > 0 {
		stats.SuccessRate = float64(stats.SuccessCount) / float64(total)
		if total > 5 {
			stats.IsHealthy = stats.SuccessRate >= hr.minSuccessRate
		}
	}
	hr.evaluateBestHost()
}

func (hr *HostRouter) evaluateBestHost() {
	if len(hr.hostIPs) == 0 {
		return
	}
	var bestIP string
	var bestScore float64
	for ip, stats := range hr.stats {
		total := stats.SuccessCount + stats.FailedCount
		if total < 3 {
			continue
		}
		successRate := float64(stats.SuccessCount) / float64(total)
		score := successRate
		if stats.ResponseTime < time.Second {
			score += 0.1
		}
		if score > bestScore && successRate >= hr.minSuccessRate {
			bestScore = score
			bestIP = ip
		}
	}
	if bestIP != "" && bestIP != hr.bestHostIP {
		hr.bestHostIP = bestIP
	}
}

func (hr *HostRouter) ResetBestHost() {
	hr.mu.Lock()
	defer hr.mu.Unlock()
	hr.bestHostIP = ""
}

func (hr *HostRouter) GetAllHostStats() []HostStats {
	hr.mu.RLock()
	defer hr.mu.RUnlock()
	stats := make([]HostStats, 0, len(hr.stats))
	for _, s := range hr.stats {
		stats = append(stats, *s)
	}
	return stats
}

// ==================== HOSTS FILE FUNCTIONS ====================

func writeHostsEntry(ip string) error {
	if runtime.GOOS != "windows" {
		return fmt.Errorf("hosts file modification is only supported on Windows")
	}
	data, err := os.ReadFile(HOSTS_FILE)
	if err != nil {
		return fmt.Errorf("cannot read hosts file (Run as Administrator!): %v", err)
	}
	lines := strings.Split(string(data), "\n")
	var newLines []string
	found := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") || trimmed == "" {
			newLines = append(newLines, line)
			continue
		}
		if strings.Contains(trimmed, HOSTS_DOMAIN) {
			newLines = append(newLines, ip+" "+HOSTS_DOMAIN)
			found = true
		} else {
			newLines = append(newLines, line)
		}
	}
	if !found {
		newLines = append(newLines, "", ip+" "+HOSTS_DOMAIN)
	}
	if err := os.WriteFile(HOSTS_FILE, []byte(strings.Join(newLines, "\n")), 0644); err != nil {
		return fmt.Errorf("failed to write hosts file (Run as Administrator): %v", err)
	}
	exec.Command("cmd", "/C", "ipconfig", "/flushdns").Run()
	return nil
}

func removeHostsEntry() error {
	if runtime.GOOS != "windows" {
		return nil
	}
	data, err := os.ReadFile(HOSTS_FILE)
	if err != nil {
		return err
	}
	lines := strings.Split(string(data), "\n")
	var newLines []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.Contains(trimmed, HOSTS_DOMAIN) && !strings.HasPrefix(trimmed, "#") {
			continue
		}
		newLines = append(newLines, line)
	}
	if err := os.WriteFile(HOSTS_FILE, []byte(strings.Join(newLines, "\n")), 0644); err != nil {
		return err
	}
	exec.Command("cmd", "/C", "ipconfig", "/flushdns").Run()
	return nil
}

// ==================== HTTP CLIENT ====================

func getHTTPClient(proxyURL string) *http.Client {
	// Strict HTTP/2-only (no HTTP/1.1 fallback). See http2only.go.
	return newH2Client(proxyURL)
}

// ==================== ROUTING CLIENT ====================

func (c *IVACClient) getRoutingClient(proxyURL string) *http.Client {
	// Strict HTTP/2-only. Proxy is used only when the routing mode requires it.
	routingMode := GetCurrentRoutingMode()
	modeInfo := GetRoutingModeInfo(routingMode)
	if modeInfo.UsesProxy && proxyURL != "" && proxyURL != "none" {
		return newH2Client(proxyURL)
	}
	return newH2Client("")
}

func (c *IVACClient) buildRoutingURL(apiURL string) string {
	routingMode := GetCurrentRoutingMode()
	if routingMode == ROUTING_MODE_DIRECT || routingMode == ROUTING_MODE_PROXY_ONLY {
		return apiURL
	}
	if (routingMode == ROUTING_MODE_HOST_ONLY || routingMode == ROUTING_MODE_PROXY_HOST) && c.currentHostIP != "" {
		parsedURL, err := url.Parse(apiURL)
		if err == nil {
			scheme := "https"
			if parsedURL.Scheme == "http" {
				scheme = "http"
			}
			newURL := fmt.Sprintf("%s://%s%s", scheme, c.currentHostIP, parsedURL.Path)
			if parsedURL.RawQuery != "" {
				newURL = newURL + "?" + parsedURL.RawQuery
			}
			return newURL
		}
	}
	return apiURL
}

func (c *IVACClient) getRouteDescription() string {
	routingMode := GetCurrentRoutingMode()
	modeInfo := GetRoutingModeInfo(routingMode)
	hasProxy := len(getEnabledProxies()) > 0
	hasHost := c.currentHostIP != ""
	routeParts := []string{"Instance"}
	if modeInfo.UsesProxy && hasProxy {
		routeParts = append(routeParts, "Proxy")
	}
	if modeInfo.UsesHost && hasHost {
		routeParts = append(routeParts, c.currentHostIP)
	}
	if routingMode == ROUTING_MODE_DIRECT || (!modeInfo.UsesProxy && !modeInfo.UsesHost) {
		routeParts = append(routeParts, "Direct API")
	} else {
		routeParts = append(routeParts, "API")
	}
	return strings.Join(routeParts, " → ")
}

func (c *IVACClient) logRoutingInfo(endpoint string) {
	routingMode := GetCurrentRoutingMode()
	modeInfo := GetRoutingModeInfo(routingMode)
	routeDesc := c.getRouteDescription()
	c.log(fmt.Sprintf("🔄 [%s] Mode: %s | Path: %s",
		endpoint,
		modeInfo.DisplayName,
		routeDesc,
	))
}

func (c *IVACClient) rotateRoutingResources() {
	routingMode := GetCurrentRoutingMode()
	modeInfo := GetRoutingModeInfo(routingMode)
	if modeInfo.UsesHost {
		hostRouter := GetHostRouter()
		newHostIP := hostRouter.GetRandomDifferentHostIP(c.currentHostIP)
		if newHostIP != "" && newHostIP != c.currentHostIP {
			c.currentHostIP = newHostIP
			c.log(fmt.Sprintf("🔄 Rotated Host IP to: %s", c.currentHostIP))
		}
	}
	if modeInfo.UsesProxy {
		c.rotateProxyOnError("resource_rotation")
	}
}

// ==================== EXTERNAL CAPTCHA FUNCTIONS ====================

// getLoginCaptchaToken now routes through the captcha QUEUE + the provider you
// selected in the dashboard (rumon / CapSolver / CapMonster / 2Captcha / ...).
// It returns a ready token instantly from the queue, else solves one.
func getLoginCaptchaToken() (string, error) {
	if raw, ok := captchaMgr.NextRaw("Signin"); ok {
		return raw, nil
	}
	return captchaMgr.solveRaw("Signin")
}

func getReserveCaptchaToken() (string, error) {
	if raw, ok := captchaMgr.NextRaw("Reserve"); ok {
		return raw, nil
	}
	return captchaMgr.solveRaw("Reserve")
}

// ==================== OTP FUNCTIONS ====================

// otpHTTPClient is a shared keep-alive client for OTP polling. Like the RJ SLOT
// userscript it does a single lightweight GET (NO PowerShell spawn) so the SMS
// host stays happy even when polled every 2s.
var otpHTTPClient = &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
		MaxIdleConns:        20,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     90 * time.Second,
		ForceAttemptHTTP2:   true,
	},
}

func getOTPUsingCurl(phone string) (string, error) {
	cleanPhone := regexp.MustCompile(`[^0-9]`).ReplaceAllString(phone, "")
	u := fmt.Sprintf("%s?action=get_latest_otp&mobile_no=%s", OTP_API_URL, cleanPhone)
	req, _ := http.NewRequest("GET", u, nil)
	// Browser-like headers so the SMS host/WAF does not treat us as a bot
	// (default Go UA "Go-http-client" is commonly blocked → "unreachable").
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Referer", "https://duttauzzal.shop/")
	resp, err := otpHTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var smsResp struct {
		Status string `json:"status"`
		OTP    string `json:"otp"`
	}
	if err := json.Unmarshal(body, &smsResp); err == nil {
		if smsResp.Status == "success" && smsResp.OTP != "" {
			return smsResp.OTP, nil
		}
	}
	matches := regexp.MustCompile(`\d{5,6}`).FindAllString(string(body), -1)
	if len(matches) > 0 {
		return matches[len(matches)-1], nil
	}
	return "", fmt.Errorf("no OTP found")
}

// ==================== INSTANCE FUNCTIONS ====================

func addInstance(clientName, loginPhone, password, otpPhone, typ, highCom, visaType, loginMode string) int {
	id := int(atomic.AddInt32(&instanceID, 1) - 1)
	displayType := typ
	if highCom != "" && visaType != "" && typ == "" {
		displayType = highCom + " - " + visaType
	}
	hostRouter := GetHostRouter()
	assignedHostIP := hostRouter.GetInstanceHostIP(id)
	deviceGen := GetDeviceGenerator()
	deviceInfo := deviceGen.GenerateDeviceInfo(id)
	instancesMu.Lock()
	instances[id] = &Instance{
		Data: InstanceData{
			ID: id, ClientName: clientName, LoginPhone: loginPhone, Password: password,
			OTPPhone: otpPhone, Type: displayType, HighCom: highCom, VisaType: visaType,
			Name: loginPhone, Status: "STOPPED", Step: "READY",
			Logs: make([]string, 0), NetworkLogs: make([]NetworkRequest, 0),
			AssignedHostIP: assignedHostIP, CurrentHostIP: assignedHostIP,
			RetryCount: 0, DeviceInfo: deviceInfo, AppointmentID: "",
			HasAppointmentID: false, PausedStep: "", TokenStatus: "-", TokenSource: "-",
			ProxyRotated: false, CurrentProxy: "",
		},
	}
	instancesMu.Unlock()
	saveInstancesToFile()
	return id
}

func addLog(id int, msg string) {
	instancesMu.RLock()
	inst, ok := instances[id]
	instancesMu.RUnlock()
	if ok {
		inst.mu.Lock()
		inst.Data.Logs = append(inst.Data.Logs, fmt.Sprintf("[%s] %s", time.Now().Format("15:04:05"), msg))
		if len(inst.Data.Logs) > 500 {
			inst.Data.Logs = inst.Data.Logs[len(inst.Data.Logs)-500:]
		}
		inst.mu.Unlock()
	}
}

func addNetworkLog(id int, req NetworkRequest) {
	instancesMu.RLock()
	inst, ok := instances[id]
	instancesMu.RUnlock()
	if ok {
		inst.mu.Lock()
		inst.Data.NetworkLogs = append([]NetworkRequest{req}, inst.Data.NetworkLogs...)
		if len(inst.Data.NetworkLogs) > 50 {
			inst.Data.NetworkLogs = inst.Data.NetworkLogs[:50]
		}
		inst.mu.Unlock()
	}
}

func saveInstancesToFile() {
	instancesMu.RLock()
	var list []InstanceData
	for _, inst := range instances {
		inst.mu.Lock()
		list = append(list, inst.Data)
		inst.mu.Unlock()
	}
	instancesMu.RUnlock()
	data, _ := json.MarshalIndent(list, "", "  ")
	os.WriteFile(INSTANCES_FILE, data, 0644)
}

func loadInstances() error {
	data, err := os.ReadFile(INSTANCES_FILE)
	if err != nil {
		return nil
	}
	var list []InstanceData
	if err := json.Unmarshal(data, &list); err != nil {
		return err
	}
	instancesMu.Lock()
	defer instancesMu.Unlock()
	for _, d := range list {
		if d.NetworkLogs == nil {
			d.NetworkLogs = []NetworkRequest{}
		}
		if d.Logs == nil {
			d.Logs = []string{}
		}
		if d.TokenStatus == "" {
			d.TokenStatus = "-"
		}
		if d.TokenSource == "" {
			d.TokenSource = "-"
		}
		if d.CurrentProxy == "" {
			d.CurrentProxy = "-"
		}
		instances[d.ID] = &Instance{Data: d}
		if int32(d.ID) >= instanceID {
			instanceID = int32(d.ID) + 1
		}
	}
	return nil
}

// ==================== TOKEN MANAGEMENT FOR IVACClient ====================

func (c *IVACClient) GetLoginToken() (string, error) {
	return c.getInstanceToken(TokenTypeLogin)
}

func (c *IVACClient) GetReserveToken() (string, error) {
	return c.getInstanceToken(TokenTypeReserve)
}

// ==================== DYNAMIC CONFIG GETTERS ====================

func (c *IVACClient) getCurrentSingleHitConfig() SingleHitConfig {
	configMu.RLock()
	defer configMu.RUnlock()
	return globalConfig.SingleHit
}

// ── Frontend-controlled flow retry (RJ SLOT JS parity) ──

func flowSingleEnabled() bool {
	configMu.RLock()
	defer configMu.RUnlock()
	return globalConfig.FlowSingle
}

func flowAutoEnabled() bool {
	configMu.RLock()
	defer configMu.RUnlock()
	return globalConfig.FlowAuto
}

func autoDelaySec() int {
	configMu.RLock()
	defer configMu.RUnlock()
	if globalConfig.AutoDelaySec > 0 {
		return globalConfig.AutoDelaySec
	}
	return 0
}

// autoAdvance applies the inter-step Auto delay before chaining to the next
// step. Returns false if the context was cancelled while waiting.
func (c *IVACClient) autoAdvance(nextStep string) bool {
	d := autoDelaySec()
	if d <= 0 {
		return true
	}
	c.log(fmt.Sprintf("▶ Auto → %s in %ds", nextStep, d))
	select {
	case <-c.ctx.Done():
		return false
	case <-time.After(time.Duration(d) * time.Second):
		return true
	}
}

func stepDelaySec(stepName string) int {
	configMu.RLock()
	defer configMu.RUnlock()
	if globalConfig.StepDelaySec != nil {
		if v, ok := globalConfig.StepDelaySec[stepName]; ok && v >= 0 {
			return v
		}
	}
	return 4
}

// runStep wraps a single-shot step attempt with the JS-style retry rule:
//   Single ON  → on failure, wait the step's per-step delay then retry.
//   Single OFF → on failure, return the error immediately (stop).
// The loop is always cancellable via the client context.
func (c *IVACClient) runStep(stepName string, attempt func() error) error {
	for {
		select {
		case <-c.ctx.Done():
			return errors.New("context cancelled")
		default:
		}

		err := attempt()
		if err == nil {
			return nil // step won
		}

		if !flowSingleEnabled() {
			c.log(fmt.Sprintf("✗ %s failed — Single retry OFF, stopping: %v", stepName, err))
			return err
		}

		delay := stepDelaySec(stepName)
		c.log(fmt.Sprintf("↻ %s failed — retry in %ds (%v)", stepName, delay, err))
		select {
		case <-c.ctx.Done():
			return errors.New("context cancelled")
		case <-time.After(time.Duration(delay) * time.Second):
		}
	}
}

func (c *IVACClient) getCurrentSingleRetryConfig() SingleHitRetryConfig {
	configMu.RLock()
	defer configMu.RUnlock()
	return globalConfig.SingleHitRetry
}

func (c *IVACClient) getCurrentParallelConfig() ParallelConfig {
	configMu.RLock()
	defer configMu.RUnlock()
	return globalConfig.Parallel
}

func (c *IVACClient) getCurrentParallelRetryConfig() ParallelRetryConfig {
	configMu.RLock()
	defer configMu.RUnlock()
	return globalConfig.ParallelRetry
}

func (c *IVACClient) getCurrentRequestMode() string {
	configMu.RLock()
	defer configMu.RUnlock()
	if globalConfig.RequestMode == "" {
		return REQUEST_MODE_SINGLE
	}
	return globalConfig.RequestMode
}

func (c *IVACClient) isSingleRetryEnabled() bool {
	configMu.RLock()
	defer configMu.RUnlock()
	return globalConfig.SingleRetryEnabled
}

func (c *IVACClient) isParallelRetryEnabled() bool {
	configMu.RLock()
	defer configMu.RUnlock()
	return globalConfig.ParallelRetryEnabled
}

// ==================== RATE LIMIT HANDLING ====================

func getRateLimitWaitTime(apiResp *APIResponse, endpointName string) int {
	defaultWaitTimes := map[string]int{
		"Login API":        20,
		"Verify OTP API":   20,
		"Reserve Slot API": 20,
		"Get Booking API":  5,
		"Payment API":      3,
		"Slot Status API":  15,
	}

	defaultWait := 20
	if val, ok := defaultWaitTimes[endpointName]; ok {
		defaultWait = val
	}

	if apiResp == nil || apiResp.RespBody == "" {
		return defaultWait
	}

	var result map[string]interface{}
	if err := json.Unmarshal([]byte(apiResp.RespBody), &result); err != nil {
		return defaultWait
	}

	if data, ok := result["data"].(map[string]interface{}); ok {
		if waitTime, ok := data["waitTime"].(float64); ok && waitTime > 0 {
			return int(waitTime)
		}
		if waitTime, ok := data["wait_seconds"].(float64); ok && waitTime > 0 {
			return int(waitTime)
		}
		if waitTime, ok := data["retry_after"].(float64); ok && waitTime > 0 {
			return int(waitTime)
		}
		if waitTime, ok := data["seconds"].(float64); ok && waitTime > 0 {
			return int(waitTime)
		}
	}

	if waitTime, ok := result["waitTime"].(float64); ok && waitTime > 0 {
		return int(waitTime)
	}
	if waitTime, ok := result["wait_seconds"].(float64); ok && waitTime > 0 {
		return int(waitTime)
	}
	if waitTime, ok := result["retry_after"].(float64); ok && waitTime > 0 {
		return int(waitTime)
	}
	if waitTime, ok := result["seconds"].(float64); ok && waitTime > 0 {
		return int(waitTime)
	}

	if msg, ok := result["message"].(string); ok {
		patterns := []string{
			`wait (\d+) seconds?`,
			`wait (\d+) second`,
			`retry after (\d+) seconds?`,
			`retry in (\d+) seconds?`,
			`try again in (\d+) seconds?`,
			`please wait (\d+) seconds?`,
			`(\d+) seconds? wait`,
		}
		for _, pattern := range patterns {
			re := regexp.MustCompile(pattern)
			matches := re.FindStringSubmatch(msg)
			if len(matches) > 1 {
				var waitTime int
				fmt.Sscanf(matches[1], "%d", &waitTime)
				if waitTime > 0 {
					return waitTime
				}
			}
		}

		re := regexp.MustCompile(`(\d+)\s*(?:seconds?|sec|s)`)
		matches := re.FindStringSubmatch(msg)
		if len(matches) > 1 {
			var waitTime int
			fmt.Sscanf(matches[1], "%d", &waitTime)
			if waitTime > 0 {
				return waitTime
			}
		}
	}

	return defaultWait
}

// ==================== FIXED REQUEST FUNCTIONS ====================

func setRequestHeaders(req *http.Request, deviceInfo *DeviceInfo, token string) {
	for k, v := range browserHeaders {
		req.Header.Set(k, v)
	}
	if deviceInfo != nil && deviceInfo.DeviceID != "" {
		req.Header.Set("x-device-id", deviceInfo.DeviceID)
	}
	if token != "" {
		req.Header.Set("authorization", "Bearer "+token)
	}
}

// ==================== FIXED SINGLE RETRY WITH ROUTING (RETRY UNTIL SUCCESS) ====================

func (c *IVACClient) executeSingleRetryWithRouting(apiUrl string, body interface{}, token string, endpointName string, captchaToken string, isReserveSlot bool) (*APIResponse, error) {
	tm := GetTokenManager()
	tokenType := TokenTypeLogin
	if isReserveSlot {
		tokenType = TokenTypeReserve
	}

	_ = c.getCurrentSingleHitConfig()
	singleHitRetry := c.getCurrentSingleRetryConfig()
	singleRetryEnabled := c.isSingleRetryEnabled()

	var retryItem SingleHitRetryItem
	switch endpointName {
	case "Login API":
		retryItem = singleHitRetry.Signin
	case "Verify OTP API":
		retryItem = singleHitRetry.Verify
	case "Reserve Slot API":
		retryItem = singleHitRetry.Reserve
	case "Get Booking API":
		retryItem = singleHitRetry.Booking
	case "Payment API":
		retryItem = singleHitRetry.Payment
	default:
		retryItem = SingleHitRetryItem{Enabled: false, Hits: 1, DelayMs: 0, ReuseCaptcha: false}
	}

	// SINGLE mode is now strictly single-shot: exactly ONE request per call.
	// All step retry is owned by the frontend Single/Auto layer (runStep).
	// The old SingleHitRetry hits-loop is intentionally disabled.
	_ = singleRetryEnabled
	totalHits := 1

	currentCaptchaToken := captchaToken
	needFreshToken := false
	proxyRotationCount := 0
	maxProxyRotations := 10

	for {
		if needFreshToken || currentCaptchaToken == "" {
			c.log(fmt.Sprintf("🔄 Getting fresh %s token for instance %d...", tokenType, c.instanceID))

			var err error
			currentCaptchaToken, err = c.fetchNewToken(tokenType)
			if err != nil {
				c.log(fmt.Sprintf("❌ Failed to get fresh %s token: %v", tokenType, err))
				time.Sleep(3 * time.Second)
				continue
			}

			if currentCaptchaToken == "" {
				c.log(fmt.Sprintf("❌ Empty fresh %s token received", tokenType))
				time.Sleep(3 * time.Second)
				continue
			}

			c.log(fmt.Sprintf("✅ Fresh %s token obtained: %s...",
				tokenType, currentCaptchaToken[:min(8, len(currentCaptchaToken))]))

			needFreshToken = false
		}

		if currentCaptchaToken != "" && (endpointName == "Login API" || endpointName == "Reserve Slot API") {
			validated, err := c.validateTokenBeforeRequest(currentCaptchaToken, tokenType)
			if err != nil {
				c.log(fmt.Sprintf("❌ Token validation failed: %v", err))
				tm.MarkTokenAsInvalid(currentCaptchaToken); InvalidateCaptcha(endpointName)
				needFreshToken = true
				time.Sleep(2 * time.Second)
				continue
			}
			if validated != currentCaptchaToken {
				c.log("🔄 Token was replaced during validation")
				currentCaptchaToken = validated
			}
			c.tokenSource = c.currentToken
		}

		if currentCaptchaToken != "" && (endpointName == "Login API" || endpointName == "Reserve Slot API") {
			isValid, message, err := c.validateDatabaseToken(currentCaptchaToken, tokenType)
			if err != nil || !isValid {
				c.log(fmt.Sprintf("❌ Database token validation failed: %s", message))
				tm.MarkTokenAsInvalid(currentCaptchaToken); InvalidateCaptcha(endpointName)
				needFreshToken = true
				time.Sleep(2 * time.Second)
				continue
			}

			c.log(fmt.Sprintf("✅ Token validated: %s (instance: %d, type: %s, source: %s, reuse: %v)",
				currentCaptchaToken[:min(8, len(currentCaptchaToken))],
				c.instanceID, tokenType, c.tokenSource, retryItem.ReuseCaptcha))
		}

		select {
		case <-c.ctx.Done():
			return nil, errors.New("context cancelled")
		default:
		}

		batchCtx, batchCancel := context.WithCancel(c.ctx)
		defer batchCancel()

		type pendingRequest struct {
			index    int
			response *APIResponse
			err      error
			done     bool
			success  bool
		}

		pendingRequests := make(map[int]*pendingRequest)
		var mu sync.Mutex
		var wg sync.WaitGroup

		successChan := make(chan *APIResponse, 1)

		var succeeded bool
		var successMu sync.Mutex

		hitsToSend := totalHits

		c.log(fmt.Sprintf("📤 [%s] Sending %d request(s) (initial: 1, retry: %d)",
			endpointName, hitsToSend, hitsToSend-1))

		for i := 0; i < hitsToSend; i++ {
			requestDelay := i * retryItem.DelayMs

			wg.Add(1)
			go func(idx int, delay int) {
				defer wg.Done()

				if delay > 0 {
					select {
					case <-batchCtx.Done():
						return
					case <-time.After(time.Duration(delay) * time.Millisecond):
					}
				}

				successMu.Lock()
				if succeeded {
					successMu.Unlock()
					return
				}
				successMu.Unlock()

				select {
				case <-batchCtx.Done():
					return
				default:
				}

				requestURL := c.buildRoutingURL(apiUrl)
				routingMode := GetCurrentRoutingMode()
				modeInfo := GetRoutingModeInfo(routingMode)

				var proxyURL string
				if modeInfo.UsesProxy {
					if c.currentProxy == "" {
						c.currentProxy = c.getNextProxy()
					}
					proxyURL = c.currentProxy
				}
				client := c.getRoutingClient(proxyURL)

				var reqBody io.Reader
				requestBody := body

				if requestBody == nil {
					requestBody = make(map[string]interface{})
				}

				if bodyMap, ok := requestBody.(map[string]interface{}); ok {
					if currentCaptchaToken != "" && (endpointName == "Login API" || endpointName == "Reserve Slot API") {
						bodyMap["c"] = CaptchaC(endpointName, currentCaptchaToken)
					}
					requestBody = bodyMap
				}

				if requestBody != nil {
					jBytes, _ := json.Marshal(requestBody)
					reqBody = bytes.NewBuffer(jBytes)
				}

				req, err := http.NewRequest("POST", requestURL, reqBody)
				if err != nil {
					mu.Lock()
					pendingRequests[idx] = &pendingRequest{
						index: idx,
						err:   err,
						done:  true,
					}
					mu.Unlock()
					return
				}

				req.Host = "api.ivacbd.com"
				setRequestHeaders(req, c.deviceInfo, token)
				if endpointName == "Payment API" {
					req.Header.Set("x-token", InitiateXToken())
				}

				tokenDisplay := "none"
				if currentCaptchaToken != "" {
					tokenDisplay = currentCaptchaToken[:min(8, len(currentCaptchaToken))] + "..."
				}

				c.log(fmt.Sprintf("📤 [%s] Request #%d | Mode: %s | Token: %s (source: %s)",
					endpointName,
					idx+1,
					c.getRouteDescription(),
					tokenDisplay,
					c.tokenSource,
				))

				startTime := time.Now()
				resp, err := client.Do(req)
				if err != nil {
					mu.Lock()
					pendingRequests[idx] = &pendingRequest{
						index: idx,
						err:   err,
						done:  true,
					}
					mu.Unlock()
					return
				}

				duration := time.Since(startTime)
				b, _ := io.ReadAll(resp.Body)
				resp.Body.Close()

				var apiResp APIResponse
				json.Unmarshal(b, &apiResp)
				apiResp.StatusCode = resp.StatusCode
				apiResp.RespBody = string(b)

				tokenStatus := string(TokenStatusValid)
				if currentCaptchaToken != "" {
					if tm.IsTokenUsed(currentCaptchaToken) {
						tokenStatus = "used"
					} else if tm.IsTokenInvalid(currentCaptchaToken) {
						tokenStatus = "invalid"
					}
				}

				responseLog := fmt.Sprintf("📡 [%s] Response #%d: Status %d | %s",
					endpointName, idx+1, resp.StatusCode, apiResp.Message)
				if len(string(b)) > 200 {
					responseLog += fmt.Sprintf(" | Body: %s...", string(b)[:200])
				} else {
					responseLog += fmt.Sprintf(" | Body: %s", string(b))
				}
				c.log(responseLog)

				proxyIP := "-"
				if proxyURL != "" {
					if parsed, err := url.Parse(proxyURL); err == nil {
						proxyIP = parsed.Hostname()
					}
				}

				networkReq := NetworkRequest{
					Endpoint:      endpointName,
					Method:        "POST",
					StatusCode:    resp.StatusCode,
					StatusText:    resp.Status,
					Timestamp:     time.Now(),
					Duration:      duration.String(),
					ProxyIP:       proxyIP,
					TokenUsed:     tokenDisplay,
					TokenStatus:   tokenStatus,
					TokenSource:   c.tokenSource,
					InstanceID:    c.instanceID,
					RespBody:      string(b),
					ProxyRotated:  c.instanceID > 0 && instances[c.instanceID] != nil && instances[c.instanceID].Data.ProxyRotated,
					ProxyCount:    func() int { proxiesMu.RLock(); defer proxiesMu.RUnlock(); return len(globalProxies) }(),
				}
				if c.networkCb != nil {
					c.networkCb(networkReq)
				}

				success := false
				if isReserveSlot {
					if apiResp.Data != nil {
						if status, ok := apiResp.Data["status"].(string); ok && (status == "OK_NEW" || status == "RESERVED") {
							if id, ok := apiResp.Data["reservationId"].(string); ok && id != "" {
								success = true
							}
						}
						if id, ok := apiResp.Data["reservationId"].(string); ok && id != "" {
							success = true
						}
					}
				} else {
					success = (resp.StatusCode >= 200 && resp.StatusCode < 300) || apiResp.SuccessFlag
				}

				mu.Lock()
				pendingRequests[idx] = &pendingRequest{
					index:    idx,
					response: &apiResp,
					err:      nil,
					done:     true,
					success:  success,
				}
				mu.Unlock()

				if success {
					c.log(fmt.Sprintf("✅ [%s] Request #%d succeeded! Cancelling other pending requests...",
						endpointName, idx+1))

					successMu.Lock()
					if !succeeded {
						succeeded = true
						successMu.Unlock()
						batchCancel()
						select {
						case successChan <- &apiResp:
						default:
						}
					} else {
						successMu.Unlock()
					}
				}
			}(i, requestDelay)
		}

		done := make(chan bool)
		go func() {
			wg.Wait()
			close(done)
		}()

		var successResponse *APIResponse

		select {
		case successResponse = <-successChan:
			if currentCaptchaToken != "" && !retryItem.ReuseCaptcha {
				tm.MarkTokenAsUsed(currentCaptchaToken)
				c.log(fmt.Sprintf("✅ Token marked as used for instance %d (successful submission)", c.instanceID))
			}
			return successResponse, nil

		case <-done:
			mu.Lock()
			for _, pr := range pendingRequests {
				if pr != nil && pr.done && pr.success {
					successResponse = pr.response
					mu.Unlock()
					if currentCaptchaToken != "" && !retryItem.ReuseCaptcha {
						tm.MarkTokenAsUsed(currentCaptchaToken)
						c.log(fmt.Sprintf("✅ Token marked as used for instance %d (successful submission)", c.instanceID))
					}
					return successResponse, nil
				}
			}
			mu.Unlock()

			var lastError *APIResponse
			var rateLimited bool
			var tokenErrorCount int

			mu.Lock()
			for _, pr := range pendingRequests {
				if pr == nil || !pr.done {
					continue
				}
				if pr.response != nil {
					lastError = pr.response
					if pr.response.StatusCode == 429 {
						rateLimited = true
						tokenErrorCount++
					} else if pr.response.StatusCode == 400 || pr.response.StatusCode == 503 {
						tokenErrorCount++
					}
				}
				if pr.err != nil && strings.Contains(pr.err.Error(), "rate limited") {
					rateLimited = true
				}
			}
			mu.Unlock()

			if rateLimited {
				waitTime := 20
				if lastError != nil && lastError.RespBody != "" {
					waitTime = getRateLimitWaitTime(lastError, endpointName)
				}
				c.log(fmt.Sprintf("⏳ Rate limited (429) for %s, waiting %d seconds before retry...", endpointName, waitTime))

				select {
				case <-c.ctx.Done():
					return nil, errors.New("context cancelled")
				case <-time.After(time.Duration(waitTime) * time.Second):
					c.log(fmt.Sprintf("✅ Rate limit wait completed for %s", endpointName))
				}

				if currentCaptchaToken != "" {
					tm.MarkTokenAsInvalid(currentCaptchaToken); InvalidateCaptcha(endpointName)
					c.log(fmt.Sprintf("❌ Token %s marked as INVALID for instance %d (rate limited)",
						currentCaptchaToken[:min(8, len(currentCaptchaToken))], c.instanceID))
				}
				c.rotateProxyOnError(endpointName)
				needFreshToken = true
				continue
			}

			if tokenErrorCount > 0 && (endpointName == "Login API" || endpointName == "Reserve Slot API") {
				c.log(fmt.Sprintf("🔄 Token errors detected (%d of requests failed), getting fresh token for %s",
					tokenErrorCount, endpointName))
				if currentCaptchaToken != "" {
					tm.MarkTokenAsInvalid(currentCaptchaToken); InvalidateCaptcha(endpointName)
				}
				c.rotateProxyOnError(endpointName)
				needFreshToken = true
				time.Sleep(3 * time.Second)
				continue
			}

			if lastError != nil && c.shouldRotateProxy(lastError.StatusCode, lastError.RespBody) {
				c.log(fmt.Sprintf("🔄 Error detected (status: %d), rotating proxy for %s",
					lastError.StatusCode, endpointName))
				c.rotateProxyOnError(endpointName)
				proxyRotationCount++

				if proxyRotationCount >= maxProxyRotations {
					c.log(fmt.Sprintf("⚠️ Max proxy rotations (%d) reached for %s, resetting...", maxProxyRotations, endpointName))
					proxyRotationCount = 0
				}

				if lastError.StatusCode == 400 || lastError.StatusCode == 429 || lastError.StatusCode == 503 {
					if currentCaptchaToken != "" {
						tm.MarkTokenAsInvalid(currentCaptchaToken); InvalidateCaptcha(endpointName)
					}
					needFreshToken = true
					time.Sleep(2 * time.Second)
					continue
				}
				time.Sleep(1 * time.Second)
				continue
			}

			errorMsg := ""
			if lastError != nil {
				errorMsg = lastError.Message
			}
			c.log(fmt.Sprintf("⚠️ [%s] All %d requests failed: %s, retrying...",
				endpointName, len(pendingRequests), errorMsg))
			time.Sleep(1 * time.Second)
			c.rotateRoutingResources()

			if lastError != nil && (lastError.StatusCode == 400 || lastError.StatusCode == 403) {
				c.log(fmt.Sprintf("🔄 Token may be expired, getting fresh token for %s", endpointName))
				if currentCaptchaToken != "" {
					tm.MarkTokenAsInvalid(currentCaptchaToken); InvalidateCaptcha(endpointName)
				}
				needFreshToken = true
				time.Sleep(2 * time.Second)
				continue
			}
		}
	}
}

// ==================== FIXED PARALLEL RETRY WITH ROUTING ====================

func (c *IVACClient) executeParallelRetryWithRouting(apiUrl string, body interface{}, token string, endpointName string, retryItem ParallelRetryItem, captchaToken string, isReserveSlot bool) (*APIResponse, error) {
	parallelRetryEnabled := c.isParallelRetryEnabled()

	if !parallelRetryEnabled || !retryItem.Enabled || len(retryItem.Hits) == 0 {
		c.log(fmt.Sprintf("ℹ️ Parallel retry disabled or not configured, using single mode for %s", endpointName))
		return c.executeSingleRetryWithRouting(apiUrl, body, token, endpointName, captchaToken, isReserveSlot)
	}

	currentCaptchaToken := captchaToken
	tm := GetTokenManager()
	tokenType := TokenTypeLogin
	if isReserveSlot {
		tokenType = TokenTypeReserve
	}

	routingMode := GetCurrentRoutingMode()
	modeInfo := GetRoutingModeInfo(routingMode)

	needFreshToken := false

	for {
		if needFreshToken || currentCaptchaToken == "" {
			c.log(fmt.Sprintf("🔄 Getting fresh %s token for instance %d...",
				tokenType, c.instanceID))

			var err error
			currentCaptchaToken, err = c.fetchNewToken(tokenType)
			if err != nil {
				c.log(fmt.Sprintf("❌ Failed to get fresh %s token: %v", tokenType, err))
				time.Sleep(3 * time.Second)
				continue
			}

			if currentCaptchaToken == "" {
				c.log(fmt.Sprintf("❌ Empty fresh %s token received", tokenType))
				time.Sleep(3 * time.Second)
				continue
			}

			c.log(fmt.Sprintf("✅ Fresh %s token obtained: %s...",
				tokenType, currentCaptchaToken[:min(8, len(currentCaptchaToken))]))

			needFreshToken = false
		}

		if currentCaptchaToken != "" && (endpointName == "Login API" || endpointName == "Reserve Slot API") {
			validated, err := c.validateTokenBeforeRequest(currentCaptchaToken, tokenType)
			if err != nil {
				c.log(fmt.Sprintf("❌ Token validation failed: %v", err))
				tm.MarkTokenAsInvalid(currentCaptchaToken); InvalidateCaptcha(endpointName)
				needFreshToken = true
				time.Sleep(2 * time.Second)
				continue
			}
			if validated != currentCaptchaToken {
				c.log("🔄 Token was replaced during validation")
				currentCaptchaToken = validated
			}
			c.tokenSource = c.currentToken
		}

		if currentCaptchaToken != "" && (endpointName == "Login API" || endpointName == "Reserve Slot API") {
			isValid, message, err := c.validateDatabaseToken(currentCaptchaToken, tokenType)
			if err != nil || !isValid {
				c.log(fmt.Sprintf("❌ Database token validation failed: %s", message))
				tm.MarkTokenAsInvalid(currentCaptchaToken); InvalidateCaptcha(endpointName)
				needFreshToken = true
				time.Sleep(2 * time.Second)
				continue
			}

			c.log(fmt.Sprintf("✅ Token validated: %s (instance: %d, type: %s, source: %s, reuse: %v)",
				currentCaptchaToken[:min(8, len(currentCaptchaToken))],
				c.instanceID, tokenType, c.tokenSource, retryItem.ReuseCaptcha))
		}

		select {
		case <-c.ctx.Done():
			return nil, errors.New("context cancelled")
		default:
		}

		ctx, cancel := context.WithCancel(c.ctx)
		results := make(chan parallelResult, 100)
		var wg sync.WaitGroup
		hitCounter := 0

		totalHits := 0
		for _, hitCount := range retryItem.Hits {
			totalHits += hitCount
		}

		c.log(fmt.Sprintf("⚡ [%s] Starting parallel retry with %d total requests, pattern: %v",
			endpointName, totalHits, retryItem.Hits))

		for _, hitCount := range retryItem.Hits {
			for j := 0; j < hitCount; j++ {
				wg.Add(1)
				go func(idx int, captchaToken string) {
					defer wg.Done()
					select {
					case <-ctx.Done():
						return
					default:
					}

					delay := (idx * retryItem.DelayMs)
					if delay > 0 {
						time.Sleep(time.Duration(delay) * time.Millisecond)
					}

					var proxyURL string
					if modeInfo.UsesProxy {
						if c.currentProxy == "" {
							c.currentProxy = c.getNextProxy()
						}
						proxyURL = c.currentProxy
					}
					if modeInfo.UsesHost && c.currentHostIP != "" {
						hostRouter := GetHostRouter()
						newHostIP := hostRouter.GetRandomDifferentHostIP(c.currentHostIP)
						if newHostIP != "" && newHostIP != c.currentHostIP {
							c.currentHostIP = newHostIP
						}
					}

					requestURL := c.buildRoutingURL(apiUrl)
					client := c.getRoutingClient(proxyURL)

					var reqBody io.Reader
					requestBody := body

					if requestBody == nil {
						requestBody = make(map[string]interface{})
					}
					if bodyMap, ok := requestBody.(map[string]interface{}); ok {
						if captchaToken != "" && (endpointName == "Login API" || endpointName == "Reserve Slot API") {
							bodyMap["c"] = CaptchaC(endpointName, captchaToken)
						}
						requestBody = bodyMap
					}

					if requestBody != nil {
						jBytes, _ := json.Marshal(requestBody)
						reqBody = bytes.NewBuffer(jBytes)
					}

					req, err := http.NewRequest("POST", requestURL, reqBody)
					if err != nil {
						results <- parallelResult{Success: false, Error: err, Index: idx}
						return
					}

					req.Host = "api.ivacbd.com"
					setRequestHeaders(req, c.deviceInfo, token)
					if endpointName == "Payment API" {
						req.Header.Set("x-token", InitiateXToken())
					}

					startTime := time.Now()
					resp, err := client.Do(req)
					if err != nil {
						results <- parallelResult{Success: false, Error: err, Index: idx}
						return
					}

					duration := time.Since(startTime)
					defer resp.Body.Close()
					b, _ := io.ReadAll(resp.Body)

					var apiResp APIResponse
					json.Unmarshal(b, &apiResp)
					apiResp.StatusCode = resp.StatusCode
					apiResp.RespBody = string(b)

					responseLog := fmt.Sprintf("📡 [%s] Parallel Response: Status %d | %s", endpointName, resp.StatusCode, apiResp.Message)
					if len(string(b)) > 200 {
						responseLog += fmt.Sprintf(" | Body: %s...", string(b)[:200])
					} else {
						responseLog += fmt.Sprintf(" | Body: %s", string(b))
					}
					c.log(responseLog)

					success := false
					if isReserveSlot {
						if apiResp.Data != nil {
							if status, ok := apiResp.Data["status"].(string); ok && (status == "OK_NEW" || status == "RESERVED") {
								if id, ok := apiResp.Data["reservationId"].(string); ok && id != "" {
									success = true
								}
							}
							if id, ok := apiResp.Data["reservationId"].(string); ok && id != "" {
								success = true
							}
						}
					} else {
						success = (resp.StatusCode >= 200 && resp.StatusCode < 300) || apiResp.SuccessFlag
					}

					if resp.StatusCode == 429 {
						waitTime := getRateLimitWaitTime(&apiResp, endpointName)
						c.log(fmt.Sprintf("⏳ Rate limited (429) in parallel for %s, waiting %d seconds...", endpointName, waitTime))

						select {
						case <-ctx.Done():
							results <- parallelResult{Success: false, Error: errors.New("context cancelled"), Index: idx}
							return
						case <-time.After(time.Duration(waitTime) * time.Second):
							c.log(fmt.Sprintf("✅ Rate limit wait completed for %s in parallel", endpointName))
						}

						if captchaToken != "" {
							tm.MarkTokenAsInvalid(captchaToken); InvalidateCaptcha(endpointName)
							c.log(fmt.Sprintf("❌ Token %s marked as INVALID for instance %d (rate limited)",
								captchaToken[:min(8, len(captchaToken))], c.instanceID))
						}
						if modeInfo.UsesProxy {
							c.rotateProxyOnError(endpointName)
						}
						results <- parallelResult{Success: false, Error: errors.New("rate limited"), Index: idx}
						return
					}

					if success && captchaToken != "" && !retryItem.ReuseCaptcha {
						tm.MarkTokenAsUsed(captchaToken)
					}

					if !success && c.shouldRotateProxy(resp.StatusCode, string(b)) && modeInfo.UsesProxy {
						c.rotateProxyOnError(endpointName)
					}

					tokenStatus := string(TokenStatusValid)
					if captchaToken != "" {
						if tm.IsTokenUsed(captchaToken) {
							tokenStatus = "used"
						} else if tm.IsTokenInvalid(captchaToken) {
							tokenStatus = "invalid"
						}
					}

					tokenDisplay := "none"
					if captchaToken != "" {
						tokenDisplay = captchaToken[:min(8, len(captchaToken))] + "..."
					}

					proxyIP := "-"
					if proxyURL != "" {
						if parsed, err := url.Parse(proxyURL); err == nil {
							proxyIP = parsed.Hostname()
						}
					}

					networkReq := NetworkRequest{
						Endpoint:      endpointName,
						Method:        "POST",
						StatusCode:    resp.StatusCode,
						StatusText:    resp.Status,
						Timestamp:     time.Now(),
						Duration:      duration.String(),
						ProxyIP:       proxyIP,
						TokenUsed:     tokenDisplay,
						TokenStatus:   tokenStatus,
						TokenSource:   c.tokenSource,
						InstanceID:    c.instanceID,
						RespBody:      string(b),
						ProxyRotated:  c.instanceID > 0 && instances[c.instanceID] != nil && instances[c.instanceID].Data.ProxyRotated,
						ProxyCount:    func() int { proxiesMu.RLock(); defer proxiesMu.RUnlock(); return len(globalProxies) }(),
					}
					if c.networkCb != nil {
						c.networkCb(networkReq)
					}

					results <- parallelResult{
						Success:  success,
						Response: &apiResp,
						Error:    nil,
						Index:    idx,
					}
				}(hitCounter, currentCaptchaToken)
				hitCounter++
			}
		}

		go func() {
			wg.Wait()
			close(results)
		}()

		var lastResponse *APIResponse
		var successCount int
		var failedCount int
		var tokenErrorCount int
		var rateLimited bool

		for res := range results {
			if res.Success {
				successCount++
				if successCount == 1 {
					cancel()
					c.log(fmt.Sprintf("✅ [%s] Parallel success! Route: %s (reuse: %v, hits: %d/%d success)",
						endpointName, c.getRouteDescription(), retryItem.ReuseCaptcha, successCount, totalHits))
					return res.Response, nil
				}
			} else {
				failedCount++
				if res.Response != nil {
					statusCode := res.Response.StatusCode
					if statusCode == 429 {
						rateLimited = true
						tokenErrorCount++
					} else if statusCode == 400 || statusCode == 503 {
						tokenErrorCount++
					}
				}
				if res.Error != nil && strings.Contains(res.Error.Error(), "rate limited") {
					rateLimited = true
				}
			}
			if res.Response != nil {
				lastResponse = res.Response
			}
		}
		cancel()

		if rateLimited {
			waitTime := 20
			if lastResponse != nil && lastResponse.RespBody != "" {
				waitTime = getRateLimitWaitTime(lastResponse, endpointName)
			}
			c.log(fmt.Sprintf("⏳ Rate limited in parallel for %s, waiting %d seconds before retry...", endpointName, waitTime))

			select {
			case <-c.ctx.Done():
				return nil, errors.New("context cancelled")
			case <-time.After(time.Duration(waitTime) * time.Second):
				c.log(fmt.Sprintf("✅ Rate limit wait completed for %s", endpointName))
			}

			needFreshToken = true
			continue
		}

		if tokenErrorCount > 0 && (endpointName == "Login API" || endpointName == "Reserve Slot API") {
			c.log(fmt.Sprintf("🔄 Token errors detected (%d of %d failed requests), getting fresh token for %s",
				tokenErrorCount, failedCount, endpointName))
			needFreshToken = true
			time.Sleep(3 * time.Second)
			continue
		}

		if lastResponse != nil && lastResponse.StatusCode == 400 &&
			(strings.Contains(strings.ToLower(lastResponse.Message), "captcha") ||
				strings.Contains(strings.ToLower(lastResponse.Message), "verification") ||
				strings.Contains(strings.ToLower(lastResponse.Message), "expired") ||
				strings.Contains(strings.ToLower(lastResponse.Message), "invalid")) {
			needFreshToken = true
			c.log(fmt.Sprintf("🔄 Token error in response message, getting new token for %s", endpointName))
			time.Sleep(3 * time.Second)
			continue
		}

		c.log(fmt.Sprintf("⚠️ [%s] Parallel all failed (%d success, %d failed), retrying...",
			endpointName, successCount, failedCount))
		time.Sleep(2 * time.Second)
		c.rotateRoutingResources()
	}
}

// ==================== FIXED MAIN REQUEST EXECUTOR ====================

func (c *IVACClient) executeRequestWithRouting(apiUrl string, body interface{}, token string, endpointName string, captchaToken string, isReserveSlot bool) (*APIResponse, error) {
	requestMode := c.getCurrentRequestMode()
	isParallelMode := requestMode == REQUEST_MODE_PARALLEL

	if !isParallelMode {
		c.log(fmt.Sprintf("📌 [%s] Using SINGLE mode", endpointName))
		return c.executeSingleRetryWithRouting(apiUrl, body, token, endpointName, captchaToken, isReserveSlot)
	}

	parallelRetryConfig := c.getCurrentParallelRetryConfig()
	var retryItem ParallelRetryItem
	switch endpointName {
	case "Login API":
		retryItem = parallelRetryConfig.Signin
	case "Verify OTP API":
		retryItem = parallelRetryConfig.Verify
	case "Reserve Slot API":
		retryItem = parallelRetryConfig.Reserve
	case "Get Booking API":
		retryItem = parallelRetryConfig.Booking
	case "Payment API":
		retryItem = parallelRetryConfig.Payment
	default:
		retryItem = ParallelRetryItem{Enabled: false}
	}

	parallelRetryEnabled := c.isParallelRetryEnabled()
	if parallelRetryEnabled && retryItem.Enabled && len(retryItem.Hits) > 0 {
		c.log(fmt.Sprintf("⚡ [%s] Using PARALLEL RETRY mode", endpointName))
		return c.executeParallelRetryWithRouting(apiUrl, body, token, endpointName, retryItem, captchaToken, isReserveSlot)
	}

	parallelConfig := c.getCurrentParallelConfig()
	var hits int
	var delayMs int
	switch endpointName {
	case "Login API":
		hits = parallelConfig.SigninHits
		delayMs = parallelConfig.SigninMs
	case "Verify OTP API":
		hits = parallelConfig.VerifyHits
		delayMs = parallelConfig.VerifyMs
	case "Reserve Slot API":
		hits = parallelConfig.ReserveHits
		delayMs = parallelConfig.ReserveMs
	case "Get Booking API":
		hits = parallelConfig.BookingHits
		delayMs = parallelConfig.BookingMs
	case "Payment API":
		hits = parallelConfig.InitiateHits
		delayMs = parallelConfig.InitiateMs
	default:
		hits = 1
		delayMs = 0
	}

	if hits > 1 {
		c.log(fmt.Sprintf("⚡ [%s] Using TRADITIONAL PARALLEL mode (%d hits, %dms delay)",
			endpointName, hits, delayMs))

		traditionalRetryItem := ParallelRetryItem{
			Enabled:      true,
			Hits:         []int{hits},
			DelayMs:      delayMs,
			ReuseCaptcha: true,
		}
		return c.executeParallelRetryWithRouting(apiUrl, body, token, endpointName, traditionalRetryItem, captchaToken, isReserveSlot)
	}

	c.log(fmt.Sprintf("📌 [%s] Using SINGLE mode (parallel not configured)", endpointName))
	return c.executeSingleRetryWithRouting(apiUrl, body, token, endpointName, captchaToken, isReserveSlot)
}

// ==================== CORE FLOW FUNCTIONS ====================

func NewIVACClient(cfg *Config, proxies []string, instanceID int, deviceInfo *DeviceInfo, hasAppointmentID bool, logCb func(string), stepCb func(string, string, string, string, string), networkCb func(NetworkRequest)) *IVACClient {
	ctx, cancel := context.WithCancel(context.Background())
	return &IVACClient{
		session:          &Session{},
		proxies:          proxies,
		config:           cfg,
		logCb:            logCb,
		stepCb:           stepCb,
		networkCb:        networkCb,
		instanceID:       instanceID,
		pooledClient:     getHTTPClient(""),
		deviceInfo:       deviceInfo,
		hasAppointmentID: hasAppointmentID,
		ctx:              ctx,
		cancel:           cancel,
		successTracker:   NewEndpointSuccessTracker(),
		tokenManager:     GetTokenManager(),
		currentToken:     "",
		currentTokenType: TokenTypeLogin,
		tokenSource:      "",
		currentProxy:     "",
	}
}

func (c *IVACClient) log(msg string) {
	if c.logCb != nil {
		c.logCb(msg)
	}
}

func (c *IVACClient) setStep(step, otp, rid, appointmentDate, payUrl string) {
	if c.stepCb != nil {
		c.stepCb(step, otp, rid, appointmentDate, payUrl)
	}
}

// ==================== LOGIN FUNCTION ====================

func (c *IVACClient) Login(loginPhone, password string) error {
	c.log(fmt.Sprintf("🔐 Logging in: %s", loginPhone))
	c.setStep("LOGGING_IN", "", "", "", "")
	return c.runStep("signin", func() error { return c.loginOnce(loginPhone, password) })
}

// loginOnce performs ONE login attempt. Retry timing/decision is owned by
// runStep (frontend Single toggle + per-step delay).
func (c *IVACClient) loginOnce(loginPhone, password string) error {
	token, err := c.getInstanceToken(TokenTypeLogin)
	if err != nil {
		// Legacy rumon token unavailable — fall back to the captcha QUEUE.
		if captchaMgr.queueLen("Signin") > 0 {
			c.log("ℹ️ Legacy token failed — using pre-solved token from queue")
			token = ""
		} else {
			return fmt.Errorf("no login token yet (queue empty, legacy: %v)", err)
		}
	}

	c.log(fmt.Sprintf("✅ Using login token (length: %d, source: %s)", len(token), c.tokenSource))

	req := map[string]interface{}{
		"phone":    loginPhone,
		"password": password,
		"c":        token,
	}

	resp, err2 := c.executeRequestWithRouting(API_LOGIN_URL, req, "", "Login API", token, false)
	if err2 != nil {
		c.rotateRoutingResources()
		return fmt.Errorf("login request failed: %v", err2)
	}

	if resp.SuccessFlag && resp.StatusCode == 200 && resp.Data != nil {
		if accessToken, ok := resp.Data["accessToken"].(string); ok && accessToken != "" {
			c.session.Token = accessToken
			c.session.LoginPhone = loginPhone
			if reqId, ok := resp.Data["requestId"].(string); ok {
				c.session.RequestID = reqId
			} else if resp.RequestID != "" {
				c.session.RequestID = resp.RequestID
			}
			if userId, ok := resp.Data["userId"].(string); ok {
				c.session.UserID = userId
			}
			c.log("✅ Login successful!")
			c.setStep("LOGGED_IN", "", "", "", "")
			return nil
		}
	}

	if resp.StatusCode == 429 {
		tm := GetTokenManager()
		tm.MarkTokenAsInvalid(token)
		c.rotateProxyOnError("Login API")
		return fmt.Errorf("rate limited (429) for Login API")
	}

	if resp.StatusCode == 400 || resp.StatusCode == 503 {
		tm := GetTokenManager()
		tm.MarkTokenAsInvalid(token)
		c.rotateProxyOnError("Login API")
		return fmt.Errorf("token error (status %d)", resp.StatusCode)
	}

	c.rotateRoutingResources()
	return fmt.Errorf("login failed: %s", resp.Message)
}

// ==================== OTP FUNCTIONS ====================

func (c *IVACClient) GetOTPWithManual(phone string, instanceID int) (string, error) {
	c.log(fmt.Sprintf("📱 Waiting for OTP for: %s", phone))
	c.log("💡 You can type OTP manually in the dashboard input field")
	c.setStep("WAITING_OTP", "", "", "", "")
	broadcastUpdate(map[string]interface{}{
		"type":       "waiting_otp",
		"instanceId": instanceID,
		"phone":      phone,
	})

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	// RJ SLOT pattern: first poll after 4s, then every 2s (light on the SMS host).
	autoTicker := time.NewTicker(2 * time.Second)
	defer autoTicker.Stop()
	autoStart := time.Now().Add(4 * time.Second) // hold the first auto-poll for 4s

	for {
		select {
		case <-c.ctx.Done():
			return "", errors.New("context cancelled")
		case <-ticker.C:
			instancesMu.RLock()
			inst, ok := instances[instanceID]
			instancesMu.RUnlock()
			if ok {
				inst.mu.Lock()
				manualOTP := inst.Data.ManualOTP
				if manualOTP != "" && len(manualOTP) == 6 {
					inst.Data.ManualOTP = ""
					inst.mu.Unlock()
					c.log(fmt.Sprintf("✅ Manual OTP received: %s", manualOTP))
					c.setStep("OTP_RECEIVED", manualOTP, "", "", "")
					return manualOTP, nil
				}
				inst.mu.Unlock()
			}
		case <-autoTicker.C:
			if c.config.AutoOTP && time.Now().After(autoStart) {
				otp, err := getOTPUsingCurl(phone)
				if err == nil && otp != "" && len(otp) == 6 {
					c.log(fmt.Sprintf("✅ Auto OTP received: %s", otp))
					c.setStep("OTP_RECEIVED", otp, "", "", "")
					return otp, nil
				}
			}
		}
	}
}

// ==================== VERIFY OTP FUNCTION ====================

func (c *IVACClient) VerifyOTP(phone, otpCode string) error {
	c.log("🔐 Verifying OTP...")
	c.setStep("VERIFYING_OTP", otpCode, "", "", "")

	req := map[string]interface{}{
		"requestId":  c.session.RequestID,
		"phone":      phone,
		"code":       otpCode,
		"otpChannel": "PHONE",
	}

	return c.runStep("verify", func() error {
		resp, err := c.executeRequestWithRouting(API_VERIFY_OTP_URL, req, c.session.Token, "Verify OTP API", "", false)
		if err != nil {
			return fmt.Errorf("verify OTP request failed: %v", err)
		}

		if resp.SuccessFlag && resp.StatusCode == 200 && resp.Data != nil {
			if verified, ok := resp.Data["verified"].(bool); ok && verified {
				c.log("✅ OTP verified!")
				c.setStep("OTP_VERIFIED", otpCode, "", "", "")
				return nil
			}
			if verificationStatus, ok := resp.Data["verificationStatus"].(string); ok && verificationStatus == "OTP verified" {
				c.log("✅ OTP verified!")
				c.setStep("OTP_VERIFIED", otpCode, "", "", "")
				return nil
			}
		}

		if resp.StatusCode == 429 {
			c.rotateProxyOnError("Verify OTP API")
			return fmt.Errorf("rate limited (429) for Verify OTP")
		}

		if strings.Contains(strings.ToLower(resp.Message), "invalid") {
			newOTP, oerr := c.GetOTPWithManual(phone, c.instanceID)
			if oerr == nil && newOTP != "" && newOTP != otpCode {
				otpCode = newOTP
				req["code"] = newOTP
				c.setStep("VERIFYING_OTP", newOTP, "", "", "")
			}
			return fmt.Errorf("OTP invalid: %s", resp.Message)
		}

		return fmt.Errorf("OTP verification failed: %s", resp.Message)
	})
}

// ==================== CHECK SLOT STATUS FUNCTION ====================

func (c *IVACClient) CheckSlotStatusWithRouting() (bool, error) {
	c.log("🔍 Checking slot status with routing...")

	routingMode := GetCurrentRoutingMode()
	modeInfo := GetRoutingModeInfo(routingMode)

	apiURL := API_SLOT_STATUS_URL
	requestURL := c.buildRoutingURL(apiURL)

	var proxyURL string
	if modeInfo.UsesProxy {
		if c.currentProxy == "" {
			c.currentProxy = c.getNextProxy()
		}
		proxyURL = c.currentProxy
	}

	client := c.getRoutingClient(proxyURL)

	req, err := http.NewRequestWithContext(c.ctx, "GET", requestURL, nil)
	if err != nil {
		return false, fmt.Errorf("failed to create request: %v", err)
	}

	req.Host = "api.ivacbd.com"
	setRequestHeaders(req, c.deviceInfo, c.session.Token)

	c.log(fmt.Sprintf("📤 Slot Status Check | Route: %s", c.getRouteDescription()))

	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		c.log(fmt.Sprintf("❌ Slot status check failed: %v", err))
		if modeInfo.UsesProxy {
			c.rotateProxyOnError("Slot Status API")
		}
		return false, err
	}
	defer resp.Body.Close()

	duration := time.Since(start)

	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, fmt.Errorf("failed to read response: %v", err)
	}

	var result APIResponse
	if err := json.Unmarshal(b, &result); err != nil {
		return false, fmt.Errorf("failed to parse response: %v", err)
	}
	result.StatusCode = resp.StatusCode

	responseLog := fmt.Sprintf("📡 Slot Status Response: Status %d | %s", resp.StatusCode, result.Message)
	if len(string(b)) > 200 {
		responseLog += fmt.Sprintf(" | Body: %s...", string(b)[:200])
	} else {
		responseLog += fmt.Sprintf(" | Body: %s", string(b))
	}
	c.log(responseLog)

	hasHost := modeInfo.UsesHost && c.currentHostIP != ""
	if hasHost && c.currentHostIP != "" {
		hostRouter := GetHostRouter()
		hostRouter.RecordResult(c.currentHostIP, resp.StatusCode >= 200 && resp.StatusCode < 300, duration)
	}

	if resp.StatusCode == 429 {
		waitTime := getRateLimitWaitTime(&result, "Slot Status API")
		c.log(fmt.Sprintf("⏳ Rate limited (429) for Slot Status, waiting %d seconds...", waitTime))
		select {
		case <-c.ctx.Done():
			return false, fmt.Errorf("context cancelled")
		case <-time.After(time.Duration(waitTime) * time.Second):
			c.log("✅ Rate limit wait completed for Slot Status")
		}
		if modeInfo.UsesProxy {
			c.rotateProxyOnError("Slot Status API")
		}
		return false, fmt.Errorf("rate limited, waited %d seconds", waitTime)
	}

	if resp.StatusCode == 401 {
		c.log("❌ Slot status: Unauthorized - token expired")
		return false, fmt.Errorf("unauthorized: token expired (401)")
	}

	if resp.StatusCode == 200 && result.SuccessFlag && result.Data != nil {
		if slotOpen, ok := result.Data["slotOpen"].(bool); ok {
			c.log(fmt.Sprintf("📊 Slot status: %v", slotOpen))
			return slotOpen, nil
		}
		if available, ok := result.Data["available"].(bool); ok {
			c.log(fmt.Sprintf("📊 Slot available: %v", available))
			return available, nil
		}
		slotKeys := []string{"isOpen", "open", "status", "slotAvailable", "fileUploadConfirmed"}
		for _, key := range slotKeys {
			if val, ok := result.Data[key].(bool); ok {
				c.log(fmt.Sprintf("📊 Slot status (%s): %v", key, val))
				return val, nil
			}
		}
		c.log(fmt.Sprintf("📊 Slot data: %v", result.Data))
	}

	c.log(fmt.Sprintf("⚠️ Slot status: unexpected response (code: %d)", resp.StatusCode))
	return false, nil
}

// ==================== MONITOR SLOT AND RESERVE FUNCTION ====================

func (c *IVACClient) MonitorSlotAndReserve() (string, string, error) {
	c.log("🔍 Starting enhanced slot monitoring...")
	c.setStep("MONITORING_SLOTS", "", "", "", "")

	if !c.config.SlotMonitor.Enabled {
		c.log("ℹ️ Slot monitor disabled, reserving directly...")
		return c.reserveSlotWithRetry()
	}

	cache := GetSlotStatusCache()
	checkInterval := c.config.SlotCheckInterval
	if checkInterval == 0 {
		checkInterval = 15
	}

	maxAttempts := 100
	attemptCount := 0

	for {
		select {
		case <-c.ctx.Done():
			c.log("⏹️ Slot monitoring cancelled")
			return "", "", context.Canceled
		default:
		}

		attemptCount++

		if status, found := cache.GetStatus(); found {
			if status {
				c.log("✅ Slot is OPEN (cached)! Proceeding to reserve...")
				time.Sleep(1 * time.Second)
				return c.reserveSlotWithRetry()
			}
			c.log(fmt.Sprintf("🔒 Slot is CLOSED (cached), waiting %d seconds...", checkInterval))
			time.Sleep(time.Duration(checkInterval) * time.Second)
			continue
		}

		c.log(fmt.Sprintf("🔄 Slot check #%d", attemptCount))

		slotAvailable, err := c.CheckSlotStatusWithRouting()
		if err != nil {
			if strings.Contains(err.Error(), "rate_limited") || strings.Contains(err.Error(), "429") {
				c.log(fmt.Sprintf("⏳ Rate limited, waiting 35 seconds..."))
				time.Sleep(35 * time.Second)
				continue
			}
			if strings.Contains(err.Error(), "401") || strings.Contains(err.Error(), "unauthorized") {
				c.log("❌ Token expired")
				return "", "", fmt.Errorf("token expired: %v", err)
			}
			c.log(fmt.Sprintf("⚠️ Slot check error: %v", err))
			time.Sleep(time.Duration(checkInterval) * time.Second)
			continue
		}

		cache.SetStatus(slotAvailable)

		if changes := cache.GetChangeCount(); changes > 0 {
			c.log(fmt.Sprintf("📊 Slot status changed %d times", changes))
		}

		if slotAvailable {
			c.log("✅ Slot is OPEN! Proceeding to reserve...")
			time.Sleep(2 * time.Second)
			return c.reserveSlotWithRetry()
		}

		c.log(fmt.Sprintf("🔒 Slot is CLOSED, waiting %d seconds...", checkInterval))
		time.Sleep(time.Duration(checkInterval) * time.Second)

		if attemptCount >= maxAttempts {
			return "", "", fmt.Errorf("slot not available after %d attempts", maxAttempts)
		}
	}
}

// ==================== RESERVE SLOT FUNCTION ====================

func (c *IVACClient) reserveSlotWithRetry() (string, string, error) {
	c.log("📌 Reserving slot with external captcha...")
	c.setStep("RESERVING_SLOT", "", "", "", "")
	var reservationID, appointmentDate string

	err := c.runStep("reserve", func() error {
		rid, date, rerr := c.reserveSlotOnce()
		if rerr != nil {
			return rerr
		}
		reservationID, appointmentDate = rid, date
		return nil
	})
	if err != nil {
		return "", "", err
	}
	return reservationID, appointmentDate, nil
}

// reserveSlotOnce performs ONE reserve attempt. Retry is owned by runStep.
func (c *IVACClient) reserveSlotOnce() (string, string, error) {
	token, err := c.getInstanceToken(TokenTypeReserve)
	if err != nil {
		// Legacy rumon token unavailable — fall back to the captcha QUEUE.
		if captchaMgr.queueLen("Reserve") > 0 {
			c.log("ℹ️ Legacy token failed — using pre-solved token from queue")
			token = ""
		} else {
			return "", "", fmt.Errorf("no reserve token yet (queue empty, legacy: %v)", err)
		}
	}

	c.log(fmt.Sprintf("✅ Using reserve token (length: %d, source: %s)", len(token), c.tokenSource))

	req := map[string]interface{}{"c": token}
	resp, err2 := c.executeRequestWithRouting(API_RESERVE_SLOT_URL, req, c.session.Token, "Reserve Slot API", token, true)
	if err2 != nil {
		return "", "", fmt.Errorf("reserve request failed: %v", err2)
	}

	if resp.StatusCode == 429 {
		tm := GetTokenManager()
		tm.MarkTokenAsInvalid(token)
		c.rotateProxyOnError("Reserve Slot API")
		return "", "", fmt.Errorf("rate limited (429) for Reserve Slot")
	}

	if resp.StatusCode == 400 || resp.StatusCode == 503 {
		tm := GetTokenManager()
		tm.MarkTokenAsInvalid(token)
		c.rotateProxyOnError("Reserve Slot API")
		return "", "", fmt.Errorf("token error (status %d)", resp.StatusCode)
	}

	if resp.Data != nil {
		extract := func() (string, string, bool) {
			id, ok := resp.Data["reservationId"].(string)
			if !ok || id == "" {
				return "", "", false
			}
			date, _ := resp.Data["appointmentDate"].(string)
			c.log(fmt.Sprintf("✅ Got Reservation ID: %s", id))
			if date != "" {
				c.log(fmt.Sprintf("✅ Got Appointment Date: %s", date))
			}
			if ttl, ok := resp.Data["reserveTtlSeconds"].(float64); ok {
				c.log(fmt.Sprintf("   Time to complete payment: %d seconds (%d minutes)", int(ttl), int(ttl)/60))
			}
			c.log(fmt.Sprintf("✅ Slot reserved successfully! ID: %s, Date: %s", id, date))
			c.setStep("SLOT_RESERVED", "", id, date, "")
			return id, date, true
		}
		if status, ok := resp.Data["status"].(string); ok && (status == "OK_NEW" || status == "RESERVED") {
			if id, date, ok := extract(); ok {
				return id, date, nil
			}
		}
		if id, date, ok := extract(); ok {
			return id, date, nil
		}
	}

	return "", "", fmt.Errorf("reserve failed: %s", resp.Message)
}

// ==================== GET BOOKING CONFIG FUNCTION ====================

func (c *IVACClient) GetBookingConfig() (string, error) {
	c.log("📋 Getting booking configuration...")
	c.setStep("BOOKING_CONFIG_LOADING", "", "", "", "")

	var appointmentID string
	err := c.runStep("book", func() error {
		resp, err := c.executeRequestWithRouting(API_BOOKING_CONFIG, nil, c.session.Token, "Get Booking API", "", false)
		if err != nil {
			return fmt.Errorf("get booking config request failed: %v", err)
		}

		if resp.StatusCode == 429 {
			c.rotateProxyOnError("Get Booking API")
			return fmt.Errorf("rate limited (429) for Get Booking")
		}

		if resp.SuccessFlag && resp.Data != nil {
			if id, ok := resp.Data["appointmentId"].(string); ok && id != "" {
				c.log(fmt.Sprintf("✅ Booking config loaded - Appointment ID: %s", id))
				if date, ok := resp.Data["appointmentDate"].(string); ok {
					c.log(fmt.Sprintf("📅 Appointment Date: %s", date))
				}
				if slot, ok := resp.Data["appointmentSlot"].(string); ok {
					c.log(fmt.Sprintf("🕐 Appointment Slot: %s", slot))
				}
				if amount, ok := resp.Data["totalAmount"].(float64); ok {
					c.log(fmt.Sprintf("💰 Total Amount: %.2f", amount))
				}
				c.setStep("BOOKING_CONFIG_LOADED", "", "", "", "")
				appointmentID = id
				return nil
			}
		}

		return fmt.Errorf("get booking config failed: %s", resp.Message)
	})
	if err != nil {
		return "", err
	}
	return appointmentID, nil
}

// ==================== INITIATE PAYMENT FUNCTION ====================

func (c *IVACClient) InitiatePayment(appointmentId string) (string, error) {
	c.log(fmt.Sprintf("💳 Initiating payment with dg-epay using Appointment ID: %s", appointmentId))
	c.setStep("INITIATING_PAYMENT", "", "", "", "")

	reqBody := map[string]interface{}{"appointmentId": appointmentId}
	if appointmentId == "" {
		reqBody = nil
	}

	var resultURL string
	err := c.runStep("initiate", func() error {
		resp, err := c.executeRequestWithRouting(API_PAYMENT_URL, reqBody, c.session.Token, "Payment API", "", false)
		if err != nil {
			return fmt.Errorf("payment initiation request failed: %v", err)
		}

		if resp.StatusCode == 429 {
			c.rotateProxyOnError("Payment API")
			return fmt.Errorf("rate limited (429) for Payment")
		}

		if resp.SuccessFlag && resp.Data != nil {
			var paymentURL string
			if webviewURL, ok := resp.Data["webview_url"].(string); ok && webviewURL != "" {
				paymentURL = webviewURL
				c.log("✅ Payment URL generated via dg-epay!")
			}
			if gatewayURL, ok := resp.Data["GatewayPageURL"].(string); ok && gatewayURL != "" {
				paymentURL = gatewayURL
				c.log("✅ Payment URL generated!")
			}
			if payURL, ok := resp.Data["paymentUrl"].(string); ok && payURL != "" {
				paymentURL = payURL
				c.log("✅ Payment URL generated!")
			}
			if paymentURL != "" {
				c.setStep("PAYMENT_READY", "", "", "", paymentURL)
				broadcastUpdate(map[string]interface{}{
					"type":       "payment_url",
					"instanceId": c.instanceID,
					"paymentUrl": paymentURL,
				})
				resultURL = paymentURL
				return nil
			}
		}

		return fmt.Errorf("payment initiation failed: %s", resp.Message)
	})
	if err != nil {
		return "", err
	}
	return resultURL, nil
}

// ==================== RUN FULL FLOW FUNCTION ====================

func (c *IVACClient) RunFullFlow(loginPhone, password, otpPhone string, savedAppointmentID string, doneCb func(string, string)) {
	start := time.Now()
	c.log("🚀 Starting flow...")

	hasAppointmentID := savedAppointmentID != ""
	if hasAppointmentID {
		c.log(fmt.Sprintf("📌 Using saved Appointment ID: %s", savedAppointmentID))
	} else {
		c.log("📌 No saved Appointment ID found")
	}

	if err := c.Login(loginPhone, password); err != nil {
		c.setStep("FAILED", "", "", "", "")
		doneCb("FAILED", err.Error())
		return
	}

	otp, err := c.GetOTPWithManual(otpPhone, c.instanceID)
	if err != nil {
		c.setStep("FAILED", "", "", "", "")
		doneCb("FAILED", "OTP failed")
		return
	}

	if err := c.VerifyOTP(otpPhone, otp); err != nil {
		c.setStep("FAILED", "", "", "", "")
		doneCb("FAILED", "Verify failed")
		return
	}

	// Auto OFF → stop after authentication, do not auto-advance to reserve.
	if !flowAutoEnabled() {
		c.log("⏸ Auto OFF — verified, waiting (no auto-advance to Reserve)")
		c.setStep("OTP_VERIFIED", otp, "", "", "")
		doneCb("PAUSED", "Verified — Auto OFF, waiting before Reserve")
		return
	}
	if !c.autoAdvance("Reserve") {
		c.setStep("STOPPED", "", "", "", "")
		doneCb("STOPPED", "cancelled")
		return
	}

	reservationID, appointmentDate, err := c.MonitorSlotAndReserve()
	if err != nil {
		c.log(fmt.Sprintf("❌ Slot reservation failed: %v", err))
		c.setStep("FAILED", "", "", "", "")
		doneCb("FAILED", err.Error())
		return
	}

	c.log(fmt.Sprintf("✅ Reservation successful! ID: %s, Date: %s", reservationID, appointmentDate))

	// Auto OFF → stop after reserve, do not auto-advance to Book/Initiate.
	if !flowAutoEnabled() {
		c.log("⏸ Auto OFF — reserved, waiting (no auto-advance to Book)")
		c.setStep("SLOT_RESERVED", "", reservationID, appointmentDate, "")
		doneCb("PAUSED", fmt.Sprintf("Reserved! ID: %s — Auto OFF, waiting before Book", reservationID))
		return
	}
	if !c.autoAdvance("Book") {
		c.setStep("STOPPED", "", reservationID, appointmentDate, "")
		doneCb("STOPPED", "cancelled")
		return
	}

	var finalAppointmentID string
	if hasAppointmentID {
		finalAppointmentID = savedAppointmentID
		c.log(fmt.Sprintf("📌 Using saved Appointment ID: %s", finalAppointmentID))
	} else {
		c.log("📌 No saved Appointment ID, fetching booking config...")
		finalAppointmentID, err = c.GetBookingConfig()
		if err != nil {
			c.log(fmt.Sprintf("⚠️ Failed to get booking config: %v, but slot is reserved!", err))
			c.setStep("SLOT_RESERVED", "", reservationID, appointmentDate, "")
			doneCb("SLOT_RESERVED", fmt.Sprintf("Slot reserved! ID: %s, Date: %s (Payment config failed)", reservationID, appointmentDate))
			return
		}
		c.log(fmt.Sprintf("✅ Got Appointment ID: %s", finalAppointmentID))
	}

	// Auto OFF → stop after booking, do not auto-advance to Initiate.
	if !flowAutoEnabled() {
		c.log("⏸ Auto OFF — booked, waiting (no auto-advance to Initiate)")
		c.setStep("BOOKING_CONFIG_LOADED", "", reservationID, appointmentDate, "")
		doneCb("PAUSED", fmt.Sprintf("Booked! Appointment ID: %s — Auto OFF, waiting before Initiate", finalAppointmentID))
		return
	}
	if !c.autoAdvance("Initiate") {
		c.setStep("STOPPED", "", reservationID, appointmentDate, "")
		doneCb("STOPPED", "cancelled")
		return
	}

	payUrl, err := c.InitiatePayment(finalAppointmentID)
	if err != nil {
		c.log(fmt.Sprintf("⚠️ Payment initiation failed: %v, but slot is reserved!", err))
		c.setStep("SLOT_RESERVED", "", reservationID, appointmentDate, "")
		doneCb("SLOT_RESERVED", fmt.Sprintf("Slot reserved! ID: %s, Date: %s (Payment failed)", reservationID, appointmentDate))
		return
	}

	c.log(fmt.Sprintf("✨ Completed in %s", time.Since(start)))
	c.log(fmt.Sprintf("🎉 Final - Reservation ID: %s, Payment URL: %s", reservationID, payUrl))
	c.setStep("COMPLETED", "", reservationID, appointmentDate, payUrl)
	doneCb("COMPLETED", "Success")
}

func (c *IVACClient) Cleanup() {
	if c.cancel != nil {
		c.cancel()
	}
	tm := GetTokenManager()
	tm.ClearInstanceTokens(c.instanceID)
	c.log(fmt.Sprintf("🧹 Cleaned up instance %d resources and tokens", c.instanceID))
}

func (c *IVACClient) getInstance() (*Instance, bool) {
	instancesMu.RLock()
	defer instancesMu.RUnlock()
	inst, ok := instances[c.instanceID]
	return inst, ok
}

func runInstanceFlow(ctx context.Context, inst *Instance, id int) {
	configMu.RLock()
	cfg := globalConfig
	configMu.RUnlock()

	stepCb := func(step, otp, rid, appointmentDate, payUrl string) {
		inst.mu.Lock()
		if inst.Data.Status != "STOPPED" && inst.Data.Status != "PAUSED" {
			inst.Data.Step = step
		}
		if otp != "" {
			inst.Data.OTP = otp
		}
		if rid != "" {
			inst.Data.ReservationID = rid
			addLog(id, fmt.Sprintf("📌 Updated Reservation ID: %s", rid))
		}
		if appointmentDate != "" {
			inst.Data.AppointmentDate = appointmentDate
		}
		if payUrl != "" {
			inst.Data.PaymentURL = payUrl
			broadcastUpdate(map[string]interface{}{
				"type": "payment_url", "instanceId": id, "paymentUrl": payUrl, "step": step,
			})
		}
		inst.mu.Unlock()
	}

	networkCb := func(req NetworkRequest) {
		addNetworkLog(id, req)
		inst.mu.Lock()
		inst.Data.TokenStatus = req.TokenStatus
		inst.Data.TokenSource = req.TokenSource
		inst.Data.ProxyRotated = req.ProxyRotated
		inst.mu.Unlock()
	}

	inst.mu.Lock()
	deviceInfo := inst.Data.DeviceInfo
	savedAppointmentID := inst.Data.AppointmentID
	hasAppointmentID := savedAppointmentID != ""
	pausedStep := inst.Data.PausedStep
	inst.mu.Unlock()

	client := NewIVACClient(&cfg, nil, id, deviceInfo, hasAppointmentID,
		func(msg string) { addLog(id, msg) }, stepCb, networkCb)

	inst.mu.Lock()
	client.currentHostIP = inst.Data.CurrentHostIP
	client.currentProxy = inst.Data.CurrentProxy
	inst.client = client
	inst.mu.Unlock()

	if pausedStep != "" {
		inst.mu.Lock()
		inst.Data.PausedStep = ""
		inst.mu.Unlock()
		addLog(id, fmt.Sprintf("▶️ Resuming from saved state"))
	}

	done := make(chan bool)
	go func() {
		client.RunFullFlow(inst.Data.LoginPhone, inst.Data.Password, inst.Data.OTPPhone, savedAppointmentID, func(status, message string) {
			inst.mu.Lock()
			if inst.Data.Status != "STOPPED" && inst.Data.Status != "PAUSED" {
				inst.Data.Status = status
			}
			if status == "COMPLETED" {
				inst.Data.Duration = time.Since(inst.Data.StartTime).String()
			}
			inst.mu.Unlock()
			done <- true
		})
	}()

	select {
	case <-done:
		client.Cleanup()
		saveInstancesToFile()
	case <-ctx.Done():
		inst.mu.Lock()
		if inst.Data.Status != "STOPPED" && inst.Data.Status != "PAUSED" {
			inst.Data.Status = "STOPPED"
			inst.Data.Step = "STOPPED"
		}
		inst.mu.Unlock()
		saveInstancesToFile()
		client.Cleanup()
	}
}

// ==================== WEBSOCKET FUNCTIONS ====================

func websocketHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &wsClient{conn: conn, mu: sync.Mutex{}}
	wsClientsMu.Lock()
	wsClients[conn] = client
	wsClientsMu.Unlock()

	defer func() {
		wsClientsMu.Lock()
		delete(wsClients, conn)
		wsClientsMu.Unlock()
	}()

	client.mu.Lock()
	conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"connected","timestamp":"`+time.Now().Format(time.RFC3339)+`"}`))
	client.mu.Unlock()

	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	go func() {
		for range ticker.C {
			wsClientsMu.RLock()
			_, exists := wsClients[conn]
			wsClientsMu.RUnlock()
			if !exists {
				return
			}
			client.mu.Lock()
			conn.WriteMessage(websocket.PingMessage, nil)
			client.mu.Unlock()
		}
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}
		client.mu.Lock()
		conn.WriteMessage(websocket.TextMessage, msg)
		client.mu.Unlock()
	}
}

func broadcastUpdate(update interface{}) {
	wsClientsMu.RLock()
	clients := make([]*wsClient, 0, len(wsClients))
	for _, client := range wsClients {
		clients = append(clients, client)
	}
	wsClientsMu.RUnlock()

	if len(clients) == 0 {
		return
	}

	data, _ := json.Marshal(update)
	for _, client := range clients {
		go func(c *wsClient) {
			c.mu.Lock()
			defer c.mu.Unlock()
			if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				wsClientsMu.Lock()
				delete(wsClients, c.conn)
				wsClientsMu.Unlock()
				c.conn.Close()
			}
		}(client)
	}
}

// ==================== SLOT MONITOR ====================

func startSlotMonitor() {
	slotMonitorMu.Lock()
	if slotMonitorRunning {
		slotMonitorMu.Unlock()
		return
	}
	slotMonitorRunning = true
	slotMonitorStopChan = make(chan bool)
	slotMonitorMu.Unlock()

	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-slotMonitorStopChan:
				slotMonitorMu.Lock()
				slotMonitorRunning = false
				slotMonitorMu.Unlock()
				return
			case <-ticker.C:
				configMu.RLock()
				enabled := globalConfig.SlotMonitor.Enabled
				configMu.RUnlock()
				if !enabled {
					return
				}

				client := getHTTPClient("")
				req, _ := http.NewRequest("GET", API_SLOT_STATUS_URL, nil)
				for k, v := range browserHeaders {
					req.Header.Set(k, v)
				}
				resp, err := client.Do(req)
				if err != nil {
					return
				}
				defer resp.Body.Close()

				if resp.StatusCode == 200 {
					b, _ := io.ReadAll(resp.Body)
					var result map[string]interface{}
					json.Unmarshal(b, &result)

					slotAvailable := false
					if data, ok := result["data"].(map[string]interface{}); ok {
						if slotOpen, ok := data["slotOpen"].(bool); ok {
							slotAvailable = slotOpen
						} else if available, ok := data["available"].(bool); ok {
							slotAvailable = available
						}
					}

					broadcastUpdate(map[string]interface{}{
						"type": "slot_status", "available": slotAvailable, "data": result, "timestamp": time.Now(),
					})
				}
			}
		}
	}()
}

func stopSlotMonitor() {
	slotMonitorMu.Lock()
	defer slotMonitorMu.Unlock()
	if slotMonitorRunning && slotMonitorStopChan != nil {
		close(slotMonitorStopChan)
		slotMonitorRunning = false
	}
}

// ==================== TOKEN API HANDLERS ====================

func handleTokenStatus(w http.ResponseWriter, r *http.Request) {
	tm := GetTokenManager()
	instanceIDStr := r.URL.Query().Get("instanceId")
	var instanceID int
	if instanceIDStr != "" {
		fmt.Sscanf(instanceIDStr, "%d", &instanceID)
	}

	var result map[string]interface{}

	if instanceID == 0 {
		tm.mu.RLock()
		defer tm.mu.RUnlock()

		loginCount := 0
		reserveCount := 0
		usedCount := 0
		invalidCount := 0
		expiredCount := 0

		for _, tokenData := range tm.tokens {
			switch tokenData.Type {
			case TokenTypeLogin:
				loginCount++
			case TokenTypeReserve:
				reserveCount++
			}

			switch tokenData.Status {
			case TokenStatusUsed:
				usedCount++
			case TokenStatusInvalid:
				invalidCount++
			case TokenStatusExpired:
				expiredCount++
			}
		}

		result = map[string]interface{}{
			"totalTokens":   len(tm.tokens),
			"loginTokens":   loginCount,
			"reserveTokens": reserveCount,
			"usedTokens":    usedCount,
			"invalidTokens": invalidCount,
			"expiredTokens": expiredCount,
			"instanceCount": len(tm.instanceTokens),
			"status":        "ok",
		}
	} else {
		tokens := tm.GetTokensForInstance(instanceID)
		tokenList := make([]map[string]interface{}, len(tokens))
		for i, tokenData := range tokens {
			tokenList[i] = map[string]interface{}{
				"token":      func() string { if len(tokenData.Token) > 8 { return tokenData.Token[:8] + "..." } else { return tokenData.Token } }(),
				"type":       tokenData.Type,
				"status":     tokenData.Status,
				"createdAt":  tokenData.CreatedAt,
				"lastUsedAt": tokenData.LastUsedAt,
				"useCount":   tokenData.UseCount,
				"expiresAt":  tokenData.ExpiresAt,
				"expiresIn":  time.Until(tokenData.ExpiresAt).String(),
				"source":     tokenData.Source,
			}
		}

		loginValid := tm.GetValidTokenCount(instanceID, TokenTypeLogin)
		reserveValid := tm.GetValidTokenCount(instanceID, TokenTypeReserve)

		result = map[string]interface{}{
			"instanceId":    instanceID,
			"tokens":        tokenList,
			"loginTokens":   loginValid,
			"reserveTokens": reserveValid,
			"totalTokens":   len(tokens),
			"status":        "ok",
		}
	}

	json.NewEncoder(w).Encode(result)
}

func handleClearInstanceTokens(w http.ResponseWriter, r *http.Request) {
	var req struct {
		InstanceID int `json:"instanceId"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	tm := GetTokenManager()
	if req.InstanceID > 0 {
		tm.ClearInstanceTokens(req.InstanceID)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":     "ok",
			"message":    fmt.Sprintf("Cleared tokens for instance %d", req.InstanceID),
			"instanceId": req.InstanceID,
		})
	} else {
		tm.mu.Lock()
		defer tm.mu.Unlock()
		tm.tokens = make(map[string]*CaptchaToken)
		tm.instanceTokens = make(map[int][]string)
		tm.usedTokens = make(map[string]bool)
		tm.invalidTokens = make(map[string]bool)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "ok",
			"message": "Cleared all tokens",
		})
	}
}

func handleTokenValidation(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		w.WriteHeader(405)
		return
	}

	instanceIDStr := r.URL.Query().Get("instanceId")
	token := r.URL.Query().Get("token")

	if instanceIDStr == "" || token == "" {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "error",
			"message": "instanceId and token parameters are required",
		})
		return
	}

	var instanceID int
	fmt.Sscanf(instanceIDStr, "%d", &instanceID)

	tm := GetTokenManager()

	tokenData, exists := tm.tokens[token]
	if !exists {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "error",
			"message": "Token not found in database",
			"exists":  false,
		})
		return
	}

	belongsToInstance := tokenData.InstanceID == instanceID

	status := string(tokenData.Status)
	isValid := tokenData.Status == TokenStatusValid &&
		time.Now().Before(tokenData.ExpiresAt)

	isUsed := tm.IsTokenUsed(token)
	isInvalid := tm.IsTokenInvalid(token)

	response := map[string]interface{}{
		"exists":              true,
		"token":               token[:min(8, len(token))] + "...",
		"fullToken":           token,
		"instanceId":          tokenData.InstanceID,
		"requestInstanceId":   instanceID,
		"belongsToInstance":   belongsToInstance,
		"type":                tokenData.Type,
		"status":              status,
		"isValid":             isValid,
		"isUsed":              isUsed,
		"isInvalid":           isInvalid,
		"createdAt":           tokenData.CreatedAt,
		"expiresAt":           tokenData.ExpiresAt,
		"expiresIn":           time.Until(tokenData.ExpiresAt).String(),
		"useCount":            tokenData.UseCount,
		"lastUsedAt":          tokenData.LastUsedAt,
		"source":              tokenData.Source,
		"validationMessage": func() string {
			if !belongsToInstance {
				return fmt.Sprintf("Token belongs to instance %d, not %d",
					tokenData.InstanceID, instanceID)
			}
			if !isValid {
				return "Token is invalid or expired"
			}
			if isUsed {
				return "Token has already been used"
			}
			if isInvalid {
				return "Token is marked as invalid"
			}
			return "Token is valid"
		}(),
	}

	json.NewEncoder(w).Encode(response)
}

// ==================== SINGLE HIT RETRY HANDLER ====================

func handleSingleHitRetryConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		configMu.RLock()
		defer configMu.RUnlock()
		json.NewEncoder(w).Encode(globalConfig.SingleHitRetry)
	} else if r.Method == "POST" {
		var req SingleHitRetryConfig
		json.NewDecoder(r.Body).Decode(&req)

		configMu.Lock()
		globalConfig.SingleHitRetry = req
		configMu.Unlock()
		saveConfig()

		json.NewEncoder(w).Encode(map[string]string{"status": "saved"})
	}
}

func handleSingleRetryMode(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		configMu.RLock()
		enabled := globalConfig.SingleRetryEnabled
		configMu.RUnlock()
		json.NewEncoder(w).Encode(map[string]bool{"enabled": enabled})
	} else if r.Method == "POST" {
		var req struct {
			Enabled bool `json:"enabled"`
		}
		json.NewDecoder(r.Body).Decode(&req)

		configMu.Lock()
		globalConfig.SingleRetryEnabled = req.Enabled
		configMu.Unlock()
		saveConfig()

		json.NewEncoder(w).Encode(map[string]bool{"enabled": req.Enabled})
	}
}

// ==================== HTTP HANDLERS ====================

func getInstances(w http.ResponseWriter, r *http.Request) {
	instancesMu.RLock()
	defer instancesMu.RUnlock()

	configMu.RLock()
	slotMonitorEnabled := globalConfig.SlotMonitor.Enabled
	configMu.RUnlock()

	var running, failed, completed int
	list := make([]map[string]interface{}, 0)

	for _, inst := range instances {
		inst.mu.Lock()
		s := inst.Data.Status
		if s == "RUNNING" {
			running++
		} else if s == "FAILED" {
			failed++
		} else if s == "COMPLETED" {
			completed++
		}

		lastLog := ""
		if len(inst.Data.Logs) > 0 {
			lastLog = inst.Data.Logs[len(inst.Data.Logs)-1]
			if lr := []rune(lastLog); len(lr) > 60 {
				lastLog = string(lr[:60]) + "..."
			}
		}

		var latestNetwork *NetworkRequest
		if len(inst.Data.NetworkLogs) > 0 {
			latestNetwork = &inst.Data.NetworkLogs[0]
		}

		deviceIDShort := ""
		if inst.Data.DeviceInfo != nil && inst.Data.DeviceInfo.DeviceID != "" {
			deviceIDShort = inst.Data.DeviceInfo.DeviceID[:min(8, len(inst.Data.DeviceInfo.DeviceID))]
		}

		instanceMap := map[string]interface{}{
			"id":              inst.Data.ID,
			"clientName":      inst.Data.ClientName,
			"loginPhone":      inst.Data.LoginPhone,
			"password":        inst.Data.Password,
			"otpPhone":        inst.Data.OTPPhone,
			"type":            inst.Data.Type,
			"highCom":         inst.Data.HighCom,
			"visaType":        inst.Data.VisaType,
			"name":            inst.Data.Name,
			"status":          s,
			"step":            inst.Data.Step,
			"otp":             inst.Data.OTP,
			"reservationId":   inst.Data.ReservationID,
			"appointmentDate": inst.Data.AppointmentDate,
			"paymentUrl":      inst.Data.PaymentURL,
			"appointmentId":   inst.Data.AppointmentID,
			"lastLog":         lastLog,
			"duration":        inst.Data.Duration,
			"assignedHostIP":  inst.Data.AssignedHostIP,
			"currentHostIP":   inst.Data.CurrentHostIP,
			"currentProxy":    inst.Data.CurrentProxy,
			"retryCount":      inst.Data.RetryCount,
			"deviceId":        deviceIDShort,
			"tokenStatus":     inst.Data.TokenStatus,
			"tokenSource":     inst.Data.TokenSource,
			"proxyRotated":    inst.Data.ProxyRotated,
			"endpoint": func() string {
				if latestNetwork != nil {
					return latestNetwork.Endpoint
				}
				return "-"
			}(),
			"statusCode": func() int {
				if latestNetwork != nil {
					return latestNetwork.StatusCode
				}
				return 0
			}(),
			"statusText": func() string {
				if latestNetwork != nil {
					return latestNetwork.StatusText
				}
				return "-"
			}(),
			"clientIp": func() string {
				if latestNetwork != nil {
					return latestNetwork.ClientIP
				}
				return "-"
			}(),
			"proxyIp": func() string {
				if latestNetwork != nil {
					return latestNetwork.ProxyIP
				}
				return "-"
			}(),
			"requestId": func() string {
				if latestNetwork != nil {
					return latestNetwork.RequestID
				}
				return ""
			}(),
			"tokenUsed": func() string {
				if latestNetwork != nil && latestNetwork.TokenUsed != "" {
					return latestNetwork.TokenUsed
				}
				return ""
			}(),
		}
		list = append(list, instanceMap)
		inst.mu.Unlock()
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"total":              len(instances),
		"running":            running,
		"failed":             failed,
		"completed":          completed,
		"instances":          list,
		"slotMonitorEnabled": slotMonitorEnabled,
	})
}

func startInstanceHandler(w http.ResponseWriter, r *http.Request) {
	var id int
	fmt.Sscanf(r.URL.Query().Get("id"), "%d", &id)

	instancesMu.RLock()
	inst, ok := instances[id]
	instancesMu.RUnlock()
	if !ok {
		w.WriteHeader(404)
		json.NewEncoder(w).Encode(map[string]string{"status": "not found"})
		return
	}

	inst.mu.Lock()
	if inst.Data.Status == "RUNNING" {
		inst.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]string{"status": "already running"})
		return
	}

	inst.Data.Status = "RUNNING"
	inst.Data.StartTime = time.Now()
	inst.Data.Step = "STARTING"
	inst.Data.OTP = ""
	inst.Data.ReservationID = ""
	inst.Data.AppointmentDate = ""
	inst.Data.PaymentURL = ""
	inst.Data.NetworkLogs = make([]NetworkRequest, 0)
	inst.Data.RetryCount = 0
	inst.Data.ManualOTP = ""
	inst.Data.PausedStep = ""
	inst.Data.TokenStatus = "-"
	inst.Data.TokenSource = "-"
	inst.Data.ProxyRotated = false
	inst.Data.CurrentProxy = ""
	inst.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	inst.mu.Lock()
	inst.cancel = cancel
	inst.mu.Unlock()

	go runInstanceFlow(ctx, inst, id)
	json.NewEncoder(w).Encode(map[string]string{"status": "started"})
}

func stopInstanceHandler(w http.ResponseWriter, r *http.Request) {
	var id int
	fmt.Sscanf(r.URL.Query().Get("id"), "%d", &id)

	instancesMu.RLock()
	inst, ok := instances[id]
	instancesMu.RUnlock()
	if !ok {
		w.WriteHeader(404)
		return
	}

	go func() {
		stopFullAuto(id) // cancel any running Full Auto (RJ SLOT flow) for this instance
		inst.mu.Lock()
		if inst.cancel != nil {
			inst.cancel()
		}
		inst.Data.Status = "STOPPED"
		inst.Data.Step = "STOPPED"
		inst.Data.PausedStep = ""
		inst.mu.Unlock()
		saveInstancesToFile()
	}()

	json.NewEncoder(w).Encode(map[string]string{"status": "stopped"})
}

func deleteInstanceHandler(w http.ResponseWriter, r *http.Request) {
	var id int
	fmt.Sscanf(r.URL.Query().Get("id"), "%d", &id)

	go func() {
		instancesMu.Lock()
		if inst, ok := instances[id]; ok {
			inst.mu.Lock()
			if inst.cancel != nil {
				inst.cancel()
			}
			inst.mu.Unlock()
			delete(instances, id)
		}
		instancesMu.Unlock()
		saveInstancesToFile()
	}()

	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

func addInstanceHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}

	var req struct {
		ClientName string `json:"clientName"`
		LoginPhone string `json:"loginPhone"`
		Password   string `json:"password"`
		OTPPhone   string `json:"otpPhone"`
		Type       string `json:"type"`
		HighCom    string `json:"highCom"`
		VisaType   string `json:"visaType"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	highCom := req.HighCom
	visaType := req.VisaType
	if highCom == "" {
		highCom = "DHAKA"
	}
	if visaType == "" {
		visaType = "MEDICAL"
	}

	configMu.RLock()
	loginMode := globalConfig.LoginMode
	configMu.RUnlock()

	id := addInstance(req.ClientName, req.LoginPhone, req.Password, req.OTPPhone, req.Type, highCom, visaType, loginMode)
	json.NewEncoder(w).Encode(map[string]int{"id": id})
}

func updateInstanceHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}

	var req struct {
		ID         int    `json:"id"`
		ClientName string `json:"clientName"`
		LoginPhone string `json:"loginPhone"`
		Password   string `json:"password"`
		OTPPhone   string `json:"otpPhone"`
		Type       string `json:"type"`
		HighCom    string `json:"highCom"`
		VisaType   string `json:"visaType"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	instancesMu.RLock()
	inst, ok := instances[req.ID]
	instancesMu.RUnlock()
	if !ok {
		w.WriteHeader(404)
		json.NewEncoder(w).Encode(map[string]string{"status": "not found"})
		return
	}

	inst.mu.Lock()
	inst.Data.ClientName = req.ClientName
	inst.Data.LoginPhone = req.LoginPhone
	inst.Data.Password = req.Password
	inst.Data.OTPPhone = req.OTPPhone
	inst.Data.Name = req.LoginPhone
	if req.HighCom != "" && req.VisaType != "" {
		inst.Data.Type = req.HighCom + " - " + req.VisaType
		inst.Data.HighCom = req.HighCom
		inst.Data.VisaType = req.VisaType
	} else if req.Type != "" {
		inst.Data.Type = req.Type
	}
	inst.mu.Unlock()

	saveInstancesToFile()
	json.NewEncoder(w).Encode(map[string]string{"status": "updated"})
}

func toggleAllHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Action string `json:"action"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	switch req.Action {
	case "start":
		go func() {
			instancesMu.RLock()
			all := make([]*Instance, 0, len(instances))
			for _, inst := range instances {
				all = append(all, inst)
			}
			instancesMu.RUnlock()

			for _, inst := range all {
				inst.mu.Lock()
				if inst.Data.Status != "RUNNING" && inst.Data.Status != "COMPLETED" && inst.Data.Status != "PAUSED" {
					inst.Data.Status = "RUNNING"
					inst.Data.StartTime = time.Now()
					inst.Data.Step = "STARTING"
					inst.Data.OTP = ""
					inst.Data.ReservationID = ""
					inst.Data.AppointmentDate = ""
					inst.Data.PaymentURL = ""
					inst.Data.NetworkLogs = make([]NetworkRequest, 0)
					inst.Data.RetryCount = 0
					inst.Data.ManualOTP = ""
					inst.Data.PausedStep = ""
					inst.Data.TokenStatus = "-"
					inst.Data.TokenSource = "-"
					inst.Data.ProxyRotated = false
					inst.Data.CurrentProxy = ""
					inst.mu.Unlock()

					ctx, cancel := context.WithCancel(context.Background())
					inst.mu.Lock()
					inst.cancel = cancel
					inst.mu.Unlock()
					go runInstanceFlow(ctx, inst, inst.Data.ID)
				} else {
					inst.mu.Unlock()
				}
			}
			saveInstancesToFile()
		}()
		json.NewEncoder(w).Encode(map[string]string{"status": "started all"})

	case "stop":
		go func() {
			instancesMu.RLock()
			all := make([]*Instance, 0, len(instances))
			for _, inst := range instances {
				all = append(all, inst)
			}
			instancesMu.RUnlock()

			for _, inst := range all {
				inst.mu.Lock()
				if inst.cancel != nil {
					inst.cancel()
				}
				inst.Data.Status = "STOPPED"
				inst.Data.Step = "STOPPED"
				inst.Data.PausedStep = ""
				inst.mu.Unlock()
			}
			saveInstancesToFile()
		}()
		json.NewEncoder(w).Encode(map[string]string{"status": "stopped all"})

	case "pause":
		go func() {
			instancesMu.RLock()
			all := make([]*Instance, 0, len(instances))
			for _, inst := range instances {
				all = append(all, inst)
			}
			instancesMu.RUnlock()

			for _, inst := range all {
				inst.mu.Lock()
				if inst.cancel != nil && inst.Data.Status == "RUNNING" {
					inst.cancel()
					inst.Data.Status = "PAUSED"
					inst.Data.Step = "PAUSED"
					inst.Data.PausedStep = inst.Data.Step
				}
				inst.mu.Unlock()
			}
			saveInstancesToFile()
		}()
		json.NewEncoder(w).Encode(map[string]string{"status": "paused all"})

	case "resume":
		go func() {
			instancesMu.RLock()
			all := make([]*Instance, 0, len(instances))
			for _, inst := range instances {
				all = append(all, inst)
			}
			instancesMu.RUnlock()

			for _, inst := range all {
				inst.mu.Lock()
				if inst.Data.Status == "PAUSED" {
					inst.Data.Status = "RUNNING"
					inst.Data.StartTime = time.Now()
					inst.Data.Step = "RESUMING"
					inst.Data.ManualOTP = ""
					inst.mu.Unlock()

					ctx, cancel := context.WithCancel(context.Background())
					inst.mu.Lock()
					inst.cancel = cancel
					inst.mu.Unlock()
					go runInstanceFlow(ctx, inst, inst.Data.ID)
				} else {
					inst.mu.Unlock()
				}
			}
			saveInstancesToFile()
		}()
		json.NewEncoder(w).Encode(map[string]string{"status": "resumed all"})
	}
}

func handleConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		configMu.RLock()
		defer configMu.RUnlock()
		json.NewEncoder(w).Encode(globalConfig)
	} else if r.Method == "POST" {
		var nc Config
		json.NewDecoder(r.Body).Decode(&nc)
		configMu.Lock()
		// Preserve flow-control fields if the caller didn't include them
		// (older dashboard config saves don't carry these).
		if nc.StepDelaySec == nil {
			nc.StepDelaySec = globalConfig.StepDelaySec
			nc.FlowSingle = globalConfig.FlowSingle
			nc.FlowAuto = globalConfig.FlowAuto
		}
		globalConfig = nc
		configMu.Unlock()
		saveConfig()

		if len(nc.HostIPs) > 0 {
			GetHostRouter().UpdateHostIPs(nc.HostIPs)
		}

		if nc.SlotMonitor.Enabled {
			startSlotMonitor()
		} else {
			stopSlotMonitor()
		}

		json.NewEncoder(w).Encode(map[string]string{"status": "saved"})
	}
}

// handleFlowControl exposes the RJ-SLOT-style Single/Auto + per-step delay
// controls so the dashboard can drive retry behaviour without touching the
// rest of the config.
func handleFlowControl(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		configMu.RLock()
		defer configMu.RUnlock()
		json.NewEncoder(w).Encode(map[string]interface{}{
			"flowSingle":   globalConfig.FlowSingle,
			"flowAuto":     globalConfig.FlowAuto,
			"stepDelaySec": globalConfig.StepDelaySec,
			"autoDelaySec": globalConfig.AutoDelaySec,
		})
		return
	}
	if r.Method == "POST" {
		var req struct {
			FlowSingle   *bool          `json:"flowSingle"`
			FlowAuto     *bool          `json:"flowAuto"`
			StepDelaySec map[string]int `json:"stepDelaySec"`
			AutoDelaySec *int           `json:"autoDelaySec"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		configMu.Lock()
		if globalConfig.StepDelaySec == nil {
			globalConfig.StepDelaySec = map[string]int{}
		}
		if req.FlowSingle != nil {
			globalConfig.FlowSingle = *req.FlowSingle
		}
		if req.FlowAuto != nil {
			globalConfig.FlowAuto = *req.FlowAuto
		}
		if req.AutoDelaySec != nil && *req.AutoDelaySec >= 0 {
			globalConfig.AutoDelaySec = *req.AutoDelaySec
		}
		for k, v := range req.StepDelaySec {
			if v >= 0 {
				globalConfig.StepDelaySec[k] = v
			}
		}
		configMu.Unlock()
		saveConfig()
		json.NewEncoder(w).Encode(map[string]string{"status": "saved"})
		return
	}
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
}

func handleParallelConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		configMu.RLock()
		defer configMu.RUnlock()
		json.NewEncoder(w).Encode(map[string]interface{}{
			"traditional":   globalConfig.Parallel,
			"parallelRetry": globalConfig.ParallelRetry,
		})
	} else if r.Method == "POST" {
		var req struct {
			Traditional   ParallelConfig       `json:"traditional"`
			ParallelRetry ParallelRetryConfig `json:"parallelRetry"`
		}
		json.NewDecoder(r.Body).Decode(&req)

		configMu.Lock()
		if req.Traditional.SigninHits > 0 {
			globalConfig.Parallel = req.Traditional
		}
		globalConfig.ParallelRetry = req.ParallelRetry
		configMu.Unlock()
		saveConfig()

		json.NewEncoder(w).Encode(map[string]string{"status": "saved"})
	}
}

func handleSingleHitConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		configMu.RLock()
		defer configMu.RUnlock()
		json.NewEncoder(w).Encode(globalConfig.SingleHit)
	} else if r.Method == "POST" {
		var req SingleHitConfig
		json.NewDecoder(r.Body).Decode(&req)

		configMu.Lock()
		globalConfig.SingleHit = req
		configMu.Unlock()
		saveConfig()

		json.NewEncoder(w).Encode(map[string]string{"status": "saved"})
	}
}

func handleSlotMonitor(w http.ResponseWriter, r *http.Request) {
	if r.Method == "POST" {
		var req struct {
			Enabled bool `json:"enabled"`
		}
		json.NewDecoder(r.Body).Decode(&req)

		configMu.Lock()
		globalConfig.SlotMonitor.Enabled = req.Enabled
		configMu.Unlock()
		saveConfig()

		if req.Enabled {
			startSlotMonitor()
		} else {
			stopSlotMonitor()
		}

		json.NewEncoder(w).Encode(map[string]interface{}{"status": "ok", "enabled": req.Enabled})
	} else {
		configMu.RLock()
		enabled := globalConfig.SlotMonitor.Enabled
		configMu.RUnlock()
		json.NewEncoder(w).Encode(map[string]bool{"enabled": enabled})
	}
}

func handleSlotStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		w.WriteHeader(405)
		json.NewEncoder(w).Encode(map[string]string{"error": "Method not allowed"})
		return
	}

	configMu.RLock()
	cfg := globalConfig
	configMu.RUnlock()

	deviceInfo := &DeviceInfo{DeviceID: "demo-device"}
	client := NewIVACClient(&cfg, nil, 0, deviceInfo, false,
		func(msg string) { fmt.Println("[SLOT]", msg) },
		func(step, otp, rid, date, pay string) {},
		func(req NetworkRequest) {},
	)

	instancesMu.RLock()
	for _, inst := range instances {
		inst.mu.Lock()
		if inst.client != nil && inst.client.session != nil && inst.client.session.Token != "" {
			client.session.Token = inst.client.session.Token
			inst.mu.Unlock()
			break
		}
		inst.mu.Unlock()
	}
	instancesMu.RUnlock()

	status, err := client.CheckSlotStatusWithRouting()
	if err != nil {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   err.Error(),
			"status":  false,
		})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":   true,
		"status":    status,
		"timestamp": time.Now().Format(time.RFC3339),
	})
}

func handleSlotStatusDetailed(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		w.WriteHeader(405)
		return
	}

	configMu.RLock()
	cfg := globalConfig
	configMu.RUnlock()

	deviceInfo := &DeviceInfo{DeviceID: "demo-device"}
	client := NewIVACClient(&cfg, nil, 0, deviceInfo, false, nil, nil, nil)

	instancesMu.RLock()
	for _, inst := range instances {
		inst.mu.Lock()
		if inst.client != nil && inst.client.session != nil && inst.client.session.Token != "" {
			client.session.Token = inst.client.session.Token
			inst.mu.Unlock()
			break
		}
		inst.mu.Unlock()
	}
	instancesMu.RUnlock()

	result, err := client.GetSlotStatusDetailed()
	if err != nil {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   err.Error(),
		})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    result,
	})
}

func (c *IVACClient) GetSlotStatusDetailed() (map[string]interface{}, error) {
	c.log("🔍 Getting detailed slot status...")

	apiURL := API_SLOT_STATUS_URL
	routingMode := GetCurrentRoutingMode()
	modeInfo := GetRoutingModeInfo(routingMode)

	requestURL := c.buildRoutingURL(apiURL)

	var proxyURL string
	if modeInfo.UsesProxy {
		if c.currentProxy == "" {
			c.currentProxy = c.getNextProxy()
		}
		proxyURL = c.currentProxy
	}

	client := c.getRoutingClient(proxyURL)

	req, err := http.NewRequestWithContext(c.ctx, "GET", requestURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %v", err)
	}

	req.Host = "api.ivacbd.com"
	setRequestHeaders(req, c.deviceInfo, c.session.Token)

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %v", err)
	}
	defer resp.Body.Close()

	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %v", err)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(b, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %v", err)
	}

	result["statusCode"] = resp.StatusCode

	return result, nil
}

func handleGetLogs(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	var id int
	fmt.Sscanf(idStr, "%d", &id)

	instancesMu.RLock()
	inst, ok := instances[id]
	instancesMu.RUnlock()
	if !ok {
		w.WriteHeader(404)
		json.NewEncoder(w).Encode(map[string]string{"error": "instance not found"})
		return
	}

	inst.mu.Lock()
	defer inst.mu.Unlock()
	json.NewEncoder(w).Encode(map[string]interface{}{
		"logs":        inst.Data.Logs,
		"networkLogs": inst.Data.NetworkLogs,
	})
}

func handleClearLogs(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	var id int
	fmt.Sscanf(idStr, "%d", &id)

	instancesMu.RLock()
	inst, ok := instances[id]
	instancesMu.RUnlock()
	if !ok {
		w.WriteHeader(404)
		json.NewEncoder(w).Encode(map[string]string{"error": "instance not found"})
		return
	}

	inst.mu.Lock()
	inst.Data.Logs = make([]string, 0)
	inst.Data.NetworkLogs = make([]NetworkRequest, 0)
	inst.mu.Unlock()

	json.NewEncoder(w).Encode(map[string]string{"status": "cleared"})
}

func handleProxies(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		proxiesMu.RLock()
		defer proxiesMu.RUnlock()

		proxyList := make([]map[string]interface{}, len(globalProxies))
		for i, p := range globalProxies {
			proxyList[i] = map[string]interface{}{
				"id":            p.ID,
				"type":          p.Type,
				"host":          p.Host,
				"port":          p.Port,
				"user":          p.User,
				"password":      p.Password,
				"enabled":       p.Enabled,
				"testPass":      p.TestPass,
				"responseMs":    p.ResponseMs,
				"lastTest":      p.LastTest,
				"rotationCount": p.RotationCount,
			}
		}

		json.NewEncoder(w).Encode(map[string]interface{}{
			"proxies": proxyList,
			"count":   len(globalProxies),
			"enabled": len(getEnabledProxies()),
		})
	} else if r.Method == "POST" {
		var req struct {
			Action string `json:"action"`
			Text   string `json:"text"` // for bulkAdd: many proxies, one per line
			Proxy  struct {
				ID       string `json:"id"`
				Type     string `json:"type"`
				Host     string `json:"host"`
				Port     int    `json:"port"`
				User     string `json:"user"`
				Password string `json:"password"`
				Enabled  bool   `json:"enabled"`
			} `json:"proxy"`
		}
		json.NewDecoder(r.Body).Decode(&req)

		switch req.Action {
		case "bulkAdd":
			lines := strings.Split(req.Text, "\n")
			added, skipped, invalid := 0, 0, 0
			for _, line := range lines {
				p, ok := parseProxyLineGo(line)
				if !ok {
					if strings.TrimSpace(line) != "" {
						invalid++
					}
					continue
				}
				proxiesMu.RLock()
				dup := false
				for _, ex := range globalProxies {
					if ex.Type == p.Type && ex.Host == p.Host && ex.Port == p.Port {
						dup = true
						break
					}
				}
				proxiesMu.RUnlock()
				if dup {
					skipped++
					continue
				}
				addProxy(p)
				added++
			}
			go testAllProxies()
			json.NewEncoder(w).Encode(map[string]interface{}{"status": "bulk", "added": added, "skipped": skipped, "invalid": invalid})
		case "add":
			proxyType := req.Proxy.Type
			if proxyType == "" || proxyType == "auto" {
				proxyType = detectProxyType(req.Proxy.Host, req.Proxy.Port)
			}
			newProxy := ProxyConfig{
				Type:          proxyType,
				Host:          req.Proxy.Host,
				Port:          req.Proxy.Port,
				User:          req.Proxy.User,
				Password:      req.Proxy.Password,
				Enabled:       req.Proxy.Enabled,
				CreatedAt:     time.Now(),
				RotationCount: 0,
			}
			addProxy(newProxy)

			proxiesMu.Lock()
			for i := range globalProxies {
				if globalProxies[i].ID == newProxy.ID {
					testProxy(&globalProxies[i])
					break
				}
			}
			proxiesMu.Unlock()

			json.NewEncoder(w).Encode(map[string]interface{}{"status": "added", "id": newProxy.ID})

		case "update":
			proxyType := req.Proxy.Type
			if proxyType == "" || proxyType == "auto" {
				proxyType = detectProxyType(req.Proxy.Host, req.Proxy.Port)
			}
			updatedProxy := ProxyConfig{
				Type:     proxyType,
				Host:     req.Proxy.Host,
				Port:     req.Proxy.Port,
				User:     req.Proxy.User,
				Password: req.Proxy.Password,
				Enabled:  req.Proxy.Enabled,
			}
			updateProxy(req.Proxy.ID, updatedProxy)

			proxiesMu.Lock()
			for i := range globalProxies {
				if globalProxies[i].ID == req.Proxy.ID {
					testProxy(&globalProxies[i])
					break
				}
			}
			proxiesMu.Unlock()

			json.NewEncoder(w).Encode(map[string]interface{}{"status": "updated"})

		case "delete":
			deleteProxy(req.Proxy.ID)
			json.NewEncoder(w).Encode(map[string]interface{}{"status": "deleted"})

		case "testAll":
			go testAllProxies()
			json.NewEncoder(w).Encode(map[string]interface{}{"status": "testing"})
		}
	}
}

func handleHostIPs(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		configMu.RLock()
		defer configMu.RUnlock()
		json.NewEncoder(w).Encode(map[string]interface{}{
			"hostIPs":  globalConfig.HostIPs,
			"activeIP": globalConfig.ActiveHostIP,
			"bestHost": GetHostRouter().GetBestHostIP(),
			"stats":    GetHostRouter().GetAllHostStats(),
		})
	} else if r.Method == "POST" {
		var req struct {
			RawText string `json:"rawText"`
		}
		json.NewDecoder(r.Body).Decode(&req)

		lines := strings.Split(req.RawText, "\n")
		var ips []string
		for _, line := range lines {
			ip := strings.TrimSpace(line)
			if ip != "" && strings.Contains(ip, ".") {
				ips = append(ips, ip)
			}
		}

		configMu.Lock()
		globalConfig.HostIPs = ips
		configMu.Unlock()
		saveConfig()

		GetHostRouter().UpdateHostIPs(ips)
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "saved", "count": len(ips)})
	}
}

func handleApplyHost(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IP string `json:"ip"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	if req.IP == "" {
		err := removeHostsEntry()
		if err != nil {
			json.NewEncoder(w).Encode(map[string]interface{}{"status": "error", "message": err.Error()})
			return
		}
		configMu.Lock()
		globalConfig.ActiveHostIP = ""
		configMu.Unlock()
		saveConfig()
		GetHostRouter().ResetBestHost()
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "ok"})
		return
	}

	err := writeHostsEntry(req.IP)
	if err != nil {
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "error", "message": err.Error()})
		return
	}

	configMu.Lock()
	globalConfig.ActiveHostIP = req.IP
	configMu.Unlock()
	saveConfig()

	json.NewEncoder(w).Encode(map[string]interface{}{"status": "ok"})
}

func handleHostStats(w http.ResponseWriter, r *http.Request) {
	stats := GetHostRouter().GetAllHostStats()
	bestHost := GetHostRouter().GetBestHostIP()
	json.NewEncoder(w).Encode(map[string]interface{}{"stats": stats, "bestHost": bestHost})
}

func handleResetHost(w http.ResponseWriter, r *http.Request) {
	GetHostRouter().ResetBestHost()
	json.NewEncoder(w).Encode(map[string]interface{}{"status": "ok"})
}

func handleRequestMode(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		configMu.RLock()
		mode := globalConfig.RequestMode
		if mode == "" {
			mode = REQUEST_MODE_SINGLE
		}
		configMu.RUnlock()
		json.NewEncoder(w).Encode(map[string]string{"mode": mode})
	} else if r.Method == "POST" {
		var req struct {
			Mode string `json:"mode"`
		}
		json.NewDecoder(r.Body).Decode(&req)

		configMu.Lock()
		if req.Mode == REQUEST_MODE_PARALLEL || req.Mode == REQUEST_MODE_SINGLE {
			globalConfig.RequestMode = req.Mode
		} else {
			globalConfig.RequestMode = REQUEST_MODE_SINGLE
		}
		configMu.Unlock()
		saveConfig()

		json.NewEncoder(w).Encode(map[string]string{"status": "saved", "mode": globalConfig.RequestMode})
	}
}

func handleParallelRetryMode(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		configMu.RLock()
		enabled := globalConfig.ParallelRetryEnabled
		configMu.RUnlock()
		json.NewEncoder(w).Encode(map[string]bool{"enabled": enabled})
	} else if r.Method == "POST" {
		var req struct {
			Enabled bool `json:"enabled"`
		}
		json.NewDecoder(r.Body).Decode(&req)

		configMu.Lock()
		globalConfig.ParallelRetryEnabled = req.Enabled
		configMu.Unlock()
		saveConfig()

		json.NewEncoder(w).Encode(map[string]bool{"enabled": req.Enabled})
	}
}

func handleRoutingMode(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		status := GetRoutingModeStatus()
		json.NewEncoder(w).Encode(status)
	} else if r.Method == "POST" {
		var req struct {
			Mode string `json:"mode"`
		}
		json.NewDecoder(r.Body).Decode(&req)

		err := SetRoutingMode(req.Mode)
		if err != nil {
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"status":  "error",
				"message": err.Error(),
			})
			return
		}

		saveConfig()
		modeInfo := GetRoutingModeInfo(req.Mode)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":      "saved",
			"mode":        req.Mode,
			"displayName": modeInfo.DisplayName,
			"description": modeInfo.Description,
		})
	}
}

func handleRoutingStatus(w http.ResponseWriter, r *http.Request) {
	status := GetRoutingModeStatus()
	configMu.RLock()
	hasProxy := len(getEnabledProxies()) > 0
	hasHost := len(globalConfig.HostIPs) > 0
	configMu.RUnlock()

	status["proxyCount"] = len(getEnabledProxies())
	status["hasProxy"] = hasProxy
	status["hasHost"] = hasHost

	instancesMu.RLock()
	var sampleHostIP string
	for _, inst := range instances {
		inst.mu.Lock()
		if inst.Data.CurrentHostIP != "" {
			sampleHostIP = inst.Data.CurrentHostIP
			inst.mu.Unlock()
			break
		}
		inst.mu.Unlock()
	}
	instancesMu.RUnlock()
	status["sampleHostIP"] = sampleHostIP

	json.NewEncoder(w).Encode(status)
}

func testParallelHandler(w http.ResponseWriter, r *http.Request) {
	configMu.RLock()
	pc := globalConfig.Parallel
	configMu.RUnlock()

	client := getHTTPClient("")
	results := make([]map[string]interface{}, 0)

	for i := 0; i < pc.SigninHits && i < 5; i++ {
		if i > 0 && pc.SigninMs > 0 {
			time.Sleep(time.Duration(i*pc.SigninMs) * time.Millisecond)
		}

		req, _ := http.NewRequest("GET", API_BASE+"/health", nil)
		req.Header.Set("Accept", "application/json")

		start := time.Now()
		resp, err := client.Do(req)
		duration := time.Since(start)

		result := map[string]interface{}{"hit": i + 1, "duration": duration.String(), "error": nil}
		if err != nil {
			result["error"] = err.Error()
			result["status"] = 0
		} else {
			result["status"] = resp.StatusCode
			resp.Body.Close()
		}
		results = append(results, result)
	}

	json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "config": pc, "results": results})
}

func testParallelRetryHandler(w http.ResponseWriter, r *http.Request) {
	configMu.RLock()
	pr := globalConfig.ParallelRetry
	configMu.RUnlock()

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Parallel retry test endpoint",
		"config":  pr,
	})
}

func handleSelectedInstances(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}

	var req struct {
		InstanceIDs []int  `json:"instanceIds"`
		Action      string `json:"action"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	go func() {
		for _, id := range req.InstanceIDs {
			instancesMu.RLock()
			inst, ok := instances[id]
			instancesMu.RUnlock()
			if !ok {
				continue
			}

			switch req.Action {
			case "start":
				inst.mu.Lock()
				if inst.Data.Status != "RUNNING" && inst.Data.Status != "COMPLETED" {
					inst.Data.Status = "RUNNING"
					inst.Data.StartTime = time.Now()
					inst.Data.Step = "STARTING"
					inst.Data.OTP = ""
					inst.Data.ReservationID = ""
					inst.Data.AppointmentDate = ""
					inst.Data.PaymentURL = ""
					inst.Data.NetworkLogs = make([]NetworkRequest, 0)
					inst.Data.RetryCount = 0
					inst.Data.ManualOTP = ""
					inst.Data.PausedStep = ""
					inst.Data.TokenStatus = "-"
					inst.Data.TokenSource = "-"
					inst.Data.ProxyRotated = false
					inst.Data.CurrentProxy = ""
					inst.mu.Unlock()

					ctx, cancel := context.WithCancel(context.Background())
					inst.mu.Lock()
					inst.cancel = cancel
					inst.mu.Unlock()
					go runInstanceFlow(ctx, inst, id)
				} else {
					inst.mu.Unlock()
				}

			case "stop":
				inst.mu.Lock()
				if inst.cancel != nil {
					inst.cancel()
				}
				inst.Data.Status = "STOPPED"
				inst.Data.Step = "STOPPED"
				inst.Data.PausedStep = ""
				inst.mu.Unlock()

			case "pause":
				inst.mu.Lock()
				if inst.cancel != nil && inst.Data.Status == "RUNNING" {
					inst.cancel()
					inst.Data.Status = "PAUSED"
					inst.Data.Step = "PAUSED"
					inst.Data.PausedStep = inst.Data.Step
				}
				inst.mu.Unlock()

			case "resume":
				inst.mu.Lock()
				if inst.Data.Status == "PAUSED" {
					inst.Data.Status = "RUNNING"
					inst.Data.StartTime = time.Now()
					inst.Data.Step = "RESUMING"
					inst.Data.ManualOTP = ""
					inst.Data.TokenStatus = "-"
					inst.Data.TokenSource = "-"
					inst.mu.Unlock()

					ctx, cancel := context.WithCancel(context.Background())
					inst.mu.Lock()
					inst.cancel = cancel
					inst.mu.Unlock()
					go runInstanceFlow(ctx, inst, id)
				} else {
					inst.mu.Unlock()
				}

			case "delete":
				inst.mu.Lock()
				if inst.cancel != nil {
					inst.cancel()
				}
				inst.mu.Unlock()
				instancesMu.Lock()
				delete(instances, id)
				instancesMu.Unlock()
			}

			time.Sleep(50 * time.Millisecond)
		}
		saveInstancesToFile()
	}()

	json.NewEncoder(w).Encode(map[string]string{"status": "processing"})
}

func handleManualOTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}

	var req struct {
		InstanceID int    `json:"instanceId"`
		OTP        string `json:"otp"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	if req.OTP == "" {
		json.NewEncoder(w).Encode(map[string]string{"status": "error", "message": "OTP is required"})
		return
	}
	if len(req.OTP) != 6 {
		json.NewEncoder(w).Encode(map[string]string{"status": "error", "message": "OTP must be 6 digits"})
		return
	}

	instancesMu.RLock()
	inst, ok := instances[req.InstanceID]
	instancesMu.RUnlock()
	if !ok {
		json.NewEncoder(w).Encode(map[string]string{"status": "error", "message": "Instance not found"})
		return
	}

	inst.mu.Lock()
	inst.Data.ManualOTP = req.OTP
	inst.Data.ManualOTPTime = time.Now()
	inst.mu.Unlock()

	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "message": "Manual OTP received"})
}

func handleSaveAppointmentID(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}

	var req struct {
		InstanceID    int    `json:"instanceId"`
		AppointmentID string `json:"appointmentId"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	instancesMu.RLock()
	inst, ok := instances[req.InstanceID]
	instancesMu.RUnlock()
	if !ok {
		json.NewEncoder(w).Encode(map[string]string{"status": "error", "message": "Instance not found"})
		return
	}

	inst.mu.Lock()
	inst.Data.AppointmentID = req.AppointmentID
	inst.Data.HasAppointmentID = req.AppointmentID != ""
	inst.mu.Unlock()

	saveInstancesToFile()
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "message": "Appointment ID saved"})
}

// ==================== DASHBOARD HTML ====================

// adminOnly guards an endpoint so only a logged-in admin session may call it.
// Regular users (and anyone without a valid session) get 403. This protects the
// admin API from being hit directly by URL, independent of the dashboard UI.
func adminOnly(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := portalSessionUser(r)
		if !ok || u.Role != "admin" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":"admin only — please log in as admin"}`))
			return
		}
		h(w, r)
	}
}

func serveDashboard(w http.ResponseWriter, r *http.Request) {
	// SECURITY: the admin dashboard (/) is admin-only. A logged-in admin gets it;
	// a logged-in non-admin user is sent to their own /portal; anyone without a
	// valid session is sent to the login page. (Previously ANYONE hitting / was
	// auto-granted an admin session — that let any reachable user become admin.)
	u, ok := portalSessionUser(r)
	if !ok {
		http.Redirect(w, r, "/login", http.StatusFound) // not logged in → login page
		return
	}
	if u.Role != "admin" {
		http.Redirect(w, r, "/portal", http.StatusFound) // regular user → their portal only
		return
	}
	w.Header().Set("Content-Type", "text/html")
	w.Write([]byte(getDashboardHTML()))
}

// ensureAdminSession sets an ivs_session cookie bound to the built-in admin user
// when the request has none (or a stale one), so /portal and /admin/users work
// for the directly-entering admin.
func ensureAdminSession(w http.ResponseWriter, r *http.Request) {
	if _, ok := portalSessionUser(r); ok {
		return
	}
	// find the admin user
	pMu.Lock()
	var adminName string
	for _, u := range pUsers {
		if u.Role == "admin" {
			adminName = u.Username
			break
		}
	}
	pMu.Unlock()
	if adminName == "" {
		return
	}
	tok := portalHash(adminName + portalID())
	pSessMu.Lock()
	pSessions[tok] = adminName
	pSessMu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "ivs_session", Value: tok, Path: "/", HttpOnly: true, MaxAge: 86400 * 7})
}

func getDashboardHTML() string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
    <title>IVAC Payment Bot - Token Management System</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0e17; min-height: 100vh; color: #e2e8f0; }
        
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #131b2e; border-radius: 3px; }
        ::-webkit-scrollbar-thumb { background: #2dd4bf; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #14b8a6; }

        .sidebar { 
            position: fixed; left: 0; top: 0; width: 260px; height: 100vh; 
            background: linear-gradient(180deg, #0d1525 0%, #0a0e17 100%); 
            color: #fff; z-index: 100; transition: all 0.3s ease; overflow-y: auto;
            border-right: 1px solid rgba(45, 212, 191, 0.1);
        }
        .sidebar-header { padding: 24px 20px; border-bottom: 1px solid rgba(45, 212, 191, 0.1); margin-bottom: 20px; }
        .sidebar-header h2 { 
            font-size: 20px; font-weight: 700; 
            background: linear-gradient(135deg, #2dd4bf, #38bdf8); 
            -webkit-background-clip: text; -webkit-text-fill-color: transparent; 
            background-clip: text; 
        }
        .sidebar-header p { font-size: 10px; color: #64748b; margin-top: 8px; line-height: 1.6; }
        .sidebar-nav { padding: 0 12px; }
        .nav-item { 
            display: flex; align-items: center; gap: 12px; padding: 12px 16px; 
            margin-bottom: 4px; border-radius: 10px; cursor: pointer; 
            transition: all 0.2s; color: #94a3b8; 
        }
        .nav-item:hover { background: rgba(45, 212, 191, 0.08); color: #fff; }
        .nav-item.active { 
            background: linear-gradient(135deg, rgba(45, 212, 191, 0.15), rgba(56, 189, 248, 0.1)); 
            color: #2dd4bf; 
            border: 1px solid rgba(45, 212, 191, 0.2);
        }
        .nav-icon { font-size: 18px; width: 24px; }
        .nav-label { font-weight: 500; font-size: 13px; }

        .main-content { margin-left: 260px; padding: 24px 32px; min-height: 100vh; background: #0a0e17; }

        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
        .stat-card { 
            background: rgba(19, 27, 46, 0.8); 
            backdrop-filter: blur(10px);
            border-radius: 16px; padding: 20px; 
            border: 1px solid rgba(45, 212, 191, 0.08);
            transition: all 0.3s ease; cursor: pointer;
        }
        .stat-card:hover { 
            transform: translateY(-3px); 
            border-color: rgba(45, 212, 191, 0.2);
            box-shadow: 0 8px 32px rgba(45, 212, 191, 0.05);
        }
        .stat-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .stat-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; }
        .stat-icon { font-size: 24px; opacity: 0.6; }
        .stat-number { font-size: 32px; font-weight: 700; color: #e2e8f0; }
        .stat-total .stat-number { color: #38bdf8; }
        .stat-running .stat-number { color: #2dd4bf; }
        .stat-failed .stat-number { color: #f87171; }
        .stat-completed .stat-number { color: #818cf8; }

        .slot-monitor-bar { 
            background: rgba(19, 27, 46, 0.8);
            backdrop-filter: blur(10px);
            border-radius: 16px; padding: 14px 24px; margin-bottom: 24px; 
            display: flex; align-items: center; justify-content: space-between; 
            border: 1px solid rgba(45, 212, 191, 0.08); flex-wrap: wrap; gap: 12px;
        }
        .slot-status { display: flex; align-items: center; gap: 12px; }
        .slot-label { font-weight: 600; color: #94a3b8; font-size: 13px; }
        .slot-value { 
            font-weight: 700; font-size: 14px; padding: 4px 14px; border-radius: 20px; 
        }
        .slot-value.on { background: rgba(45, 212, 191, 0.15); color: #2dd4bf; }
        .slot-value.off { background: rgba(248, 113, 113, 0.15); color: #f87171; }

        .switch { position: relative; display: inline-block; width: 48px; height: 26px; }
        .switch input { opacity: 0; width: 0; height: 0; }
        .slider { 
            position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; 
            background-color: #1e293b; transition: 0.2s; border-radius: 26px;
            border: 1px solid rgba(45, 212, 191, 0.1);
        }
        .slider:before { 
            position: absolute; content: ""; height: 20px; width: 20px; left: 2px; bottom: 2px; 
            background-color: #475569; transition: 0.2s; border-radius: 50%; 
        }
        input:checked + .slider { background-color: rgba(45, 212, 191, 0.2); border-color: #2dd4bf; }
        input:checked + .slider:before { transform: translateX(22px); background-color: #2dd4bf; }

        .btn { 
            padding: 8px 18px; border: none; border-radius: 8px; 
            font-weight: 600; font-size: 12px; cursor: pointer; 
            transition: all 0.2s ease; 
        }
        .btn-sm { padding: 5px 12px; font-size: 11px; }
        .btn-primary { background: linear-gradient(135deg, #2dd4bf, #14b8a6); color: #0a0e17; }
        .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(45, 212, 191, 0.25); }
        .btn-success { background: linear-gradient(135deg, #2dd4bf, #0d9488); color: #0a0e17; }
        .btn-success:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(45, 212, 191, 0.2); }
        .btn-danger { background: linear-gradient(135deg, #f87171, #ef4444); color: #fff; }
        .btn-danger:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(248, 113, 113, 0.2); }
        .btn-warning { background: linear-gradient(135deg, #fbbf24, #f59e0b); color: #0a0e17; }
        .btn-warning:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(251, 191, 36, 0.2); }
        .btn-info { background: linear-gradient(135deg, #818cf8, #6366f1); color: #fff; }
        .btn-info:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(129, 140, 248, 0.2); }
        .btn-outline { 
            background: transparent; border: 1px solid rgba(148, 163, 184, 0.2); 
            color: #94a3b8; 
        }
        .btn-outline:hover { background: rgba(45, 212, 191, 0.05); border-color: #2dd4bf; color: #e2e8f0; }

        .mode-switch-container { 
            display: flex; align-items: center; gap: 4px; 
            background: rgba(19, 27, 46, 0.6); padding: 4px; border-radius: 30px;
            border: 1px solid rgba(45, 212, 191, 0.05);
        }
        .mode-btn { 
            padding: 6px 18px; border: none; border-radius: 30px; cursor: pointer; 
            font-weight: 700; font-size: 12px; transition: all 0.2s; 
        }
        .mode-btn.active { 
            background: linear-gradient(135deg, #2dd4bf, #14b8a6); 
            color: #0a0e17; 
            box-shadow: 0 2px 12px rgba(45, 212, 191, 0.2);
        }
        .mode-btn.inactive { background: transparent; color: #64748b; }
        .mode-btn.inactive:hover { background: rgba(45, 212, 191, 0.05); }

        .retry-toggle-group { 
            display: flex; align-items: center; gap: 16px; flex-wrap: wrap; 
            background: rgba(19, 27, 46, 0.4); padding: 6px 16px; border-radius: 30px;
            border: 1px solid rgba(45, 212, 191, 0.05);
        }
        .retry-toggle-item { display: flex; align-items: center; gap: 8px; }
        .retry-toggle-item label { font-weight: 600; color: #94a3b8; font-size: 12px; }
        .retry-toggle-item .switch { width: 40px; height: 22px; }
        .retry-toggle-item .slider:before { height: 16px; width: 16px; }
        .retry-toggle-item input:checked + .slider:before { transform: translateX(18px); }

        .action-buttons { display: flex; gap: 8px; flex-wrap: wrap; }

        .table-container { 
            background: rgba(19, 27, 46, 0.6);
            backdrop-filter: blur(10px);
            border-radius: 16px; overflow-x: auto; 
            border: 1px solid rgba(45, 212, 191, 0.05);
        }
        table { width: 100%; border-collapse: collapse; }
        .instances-table { min-width: 1600px; }
        .config-table { min-width: 800px; }
        .single-retry-table { min-width: 600px; }
        
        th { 
            background: rgba(13, 21, 37, 0.8); 
            color: #94a3b8; 
            padding: 12px 14px; text-align: left; 
            font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; 
            border-bottom: 1px solid rgba(45, 212, 191, 0.05); 
            position: sticky; top: 0; z-index: 10; 
        }
        td { 
            padding: 10px 14px; border-bottom: 1px solid rgba(45, 212, 191, 0.03); 
            font-size: 13px; vertical-align: middle; 
        }
        tr:hover td { background: rgba(45, 212, 191, 0.03); }

        .step-badge { 
            padding: 4px 12px; border-radius: 20px; font-size: 10px; font-weight: 700; 
            display: inline-block; white-space: nowrap; 
        }
        .step-ready { background: rgba(148, 163, 184, 0.15); color: #94a3b8; }
        .step-starting, .step-logging_in, .step-verifying_otp, .step-reserving_slot,
        .step-initiating_payment, .step-monitoring_slots, .step-booking_config_loading {
            background: rgba(56, 189, 248, 0.12); color: #38bdf8; animation: pulse 1.5s infinite;
        }
        .step-logged_in, .step-otp_verified, .step-booking_config_loaded {
            background: rgba(45, 212, 191, 0.12); color: #2dd4bf;
        }
        .step-waiting_otp { background: rgba(129, 140, 248, 0.12); color: #818cf8; animation: pulse 1.5s infinite; }
        .step-otp_received { background: rgba(45, 212, 191, 0.12); color: #2dd4bf; }
        .step-slot_reserved { background: rgba(251, 191, 36, 0.12); color: #fbbf24; }
        .step-payment_ready { background: rgba(251, 191, 36, 0.15); color: #fbbf24; }
        .step-completed { background: rgba(129, 140, 248, 0.12); color: #818cf8; }
        .step-failed { background: rgba(248, 113, 113, 0.12); color: #f87171; }
        .step-stopped { background: rgba(148, 163, 184, 0.1); color: #64748b; }
        .step-paused { background: rgba(251, 191, 36, 0.1); color: #fbbf24; }
        .step-resuming { background: rgba(45, 212, 191, 0.1); color: #2dd4bf; }

        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

        .status-badge { 
            padding: 2px 10px; border-radius: 12px; font-size: 10px; font-weight: 700; display: inline-block; 
        }
        .status-200, .status-201 { background: rgba(45, 212, 191, 0.12); color: #2dd4bf; }
        .status-400, .status-401, .status-403, .status-404, .status-500 { 
            background: rgba(248, 113, 113, 0.12); color: #f87171; 
        }

        input, select, textarea { 
            background: rgba(19, 27, 46, 0.6); 
            border: 1px solid rgba(45, 212, 191, 0.1); 
            border-radius: 8px; padding: 10px 14px; 
            color: #e2e8f0; font-size: 13px; 
            transition: all 0.2s;
        }
        input:focus, select:focus, textarea:focus { 
            outline: none; border-color: #2dd4bf; 
            box-shadow: 0 0 0 3px rgba(45, 212, 191, 0.05);
        }
        input::placeholder { color: #475569; }

        .add-form { 
            background: rgba(19, 27, 46, 0.6);
            backdrop-filter: blur(10px);
            border-radius: 16px; padding: 16px 20px; margin-bottom: 16px; 
            display: flex; gap: 12px; flex-wrap: wrap; align-items: center; 
            border: 1px solid rgba(45, 212, 191, 0.05);
        }
        .add-form input, .add-form select { flex: 1; min-width: 120px; }

        .bulk-actions { 
            background: rgba(13, 21, 37, 0.6); 
            border-radius: 12px; padding: 10px 20px; margin-bottom: 16px; 
            display: flex; gap: 10px; flex-wrap: wrap; align-items: center; 
            border: 1px solid rgba(45, 212, 191, 0.03);
        }
        .bulk-actions span { color: #94a3b8; font-size: 13px; font-weight: 600; }

        .config-panel { 
            background: rgba(19, 27, 46, 0.6);
            backdrop-filter: blur(10px);
            border-radius: 16px; padding: 24px; margin-bottom: 20px; 
            border: 1px solid rgba(45, 212, 191, 0.05);
        }
        .config-panel h3 { color: #e2e8f0; margin-bottom: 16px; font-size: 17px; font-weight: 600; }
        .config-group { margin-bottom: 14px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
        .config-group label { width: 180px; color: #94a3b8; font-weight: 500; font-size: 13px; }
        .config-group input, .config-group select { flex: 1; max-width: 280px; }

        .checkbox-col { width: 30px; text-align: center; }
        .checkbox-col input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: #2dd4bf; }
        input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: #2dd4bf; }

        .encryption-badge, .service-badge { 
            padding: 3px 10px; border-radius: 20px; font-size: 9px; font-weight: 600; display: inline-block; margin: 2px; 
        }
        .encryption-badge { background: rgba(129, 140, 248, 0.12); color: #818cf8; }
        .service-badge { background: rgba(56, 189, 248, 0.08); color: #38bdf8; }
        .always-enabled-badge { background: rgba(45, 212, 191, 0.15); color: #2dd4bf; padding: 2px 10px; border-radius: 12px; font-size: 10px; font-weight: 700; }
        .enabled-by-default-badge { background: rgba(56, 189, 248, 0.12); color: #38bdf8; padding: 2px 10px; border-radius: 12px; font-size: 10px; font-weight: 700; }
        .proxy-rotated-badge { background: rgba(251, 191, 36, 0.12); color: #fbbf24; padding: 2px 8px; border-radius: 12px; font-size: 9px; font-weight: 600; border: 1px solid rgba(251, 191, 36, 0.1); }

        .toast { 
            position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; border-radius: 12px; 
            background: rgba(19, 27, 46, 0.95); color: #e2e8f0; font-weight: 500; 
            z-index: 1100; display: none; animation: slideInRight 0.3s ease; 
            border: 1px solid rgba(45, 212, 191, 0.1);
            backdrop-filter: blur(10px);
        }
        @keyframes slideInRight { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        .toast-success { border-color: #2dd4bf; color: #2dd4bf; }
        .toast-error { border-color: #f87171; color: #f87171; }
        .toast-info { border-color: #38bdf8; color: #38bdf8; }

        .modal { 
            display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
            background: rgba(0,0,0,0.7); backdrop-filter: blur(8px); 
            z-index: 1000; align-items: center; justify-content: center; 
        }
        .modal-content { 
            background: rgba(19, 27, 46, 0.95); 
            border-radius: 20px; padding: 28px; width: 90%; max-width: 800px; max-height: 85vh; 
            overflow-y: auto; border: 1px solid rgba(45, 212, 191, 0.1);
            backdrop-filter: blur(10px);
        }
        .modal-content h3 { color: #e2e8f0; margin-bottom: 20px; }
        .modal-content input, .modal-content select, .modal-content textarea { 
            width: 100%; padding: 10px 14px; margin-bottom: 12px; 
            background: rgba(13, 21, 37, 0.6); border: 1px solid rgba(45, 212, 191, 0.08); 
            border-radius: 10px; color: #e2e8f0; font-size: 14px; 
        }
        .modal-content input:focus { border-color: #2dd4bf; }
        .modal-buttons { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }

        .log-content { 
            background: rgba(10, 14, 23, 0.8); 
            border-radius: 12px; padding: 16px; max-height: 400px; overflow-y: auto; 
            font-family: 'Courier New', monospace; font-size: 12px; 
            border: 1px solid rgba(45, 212, 191, 0.05);
        }
        .log-line { 
            padding: 4px 8px; border-bottom: 1px solid rgba(45, 212, 191, 0.03); 
            color: #94a3b8; word-break: break-all; white-space: pre-wrap; 
        }
        .log-line.log-error { color: #f87171; }
        .log-line.log-success { color: #2dd4bf; }
        .log-line.log-info { color: #38bdf8; }
        .log-line.log-warning { color: #fbbf24; }

        .network-logs { 
            background: rgba(10, 14, 23, 0.8); 
            border-radius: 12px; padding: 12px; margin-top: 16px; max-height: 200px; overflow-y: auto; 
            border: 1px solid rgba(45, 212, 191, 0.05);
        }
        .net-log-row { 
            display: flex; gap: 12px; padding: 4px 8px; border-bottom: 1px solid rgba(45, 212, 191, 0.03); 
            font-size: 11px; font-family: monospace; flex-wrap: wrap; 
        }
        .net-endpoint { font-weight: 600; color: #38bdf8; min-width: 100px; }
        .net-status-ok { color: #2dd4bf; min-width: 45px; }
        .net-status-err { color: #f87171; min-width: 45px; }
        .net-ip { color: #818cf8; min-width: 120px; }
        .net-proxy { color: #a78bfa; min-width: 120px; }
        .net-dur { color: #64748b; min-width: 80px; }
        .net-body { color: #94a3b8; flex: 1; word-break: break-all; }
        .net-token { color: #fbbf24; min-width: 60px; font-size: 10px; }

        .log-filter-bar { 
            display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; 
        }
        .log-filter-btn { 
            padding: 4px 12px; border: 1px solid rgba(45, 212, 191, 0.08); 
            border-radius: 6px; background: rgba(13, 21, 37, 0.4); color: #94a3b8; 
            cursor: pointer; font-size: 11px; transition: all 0.2s; 
        }
        .log-filter-btn:hover { background: rgba(45, 212, 191, 0.05); }
        .log-filter-btn.active { background: rgba(45, 212, 191, 0.12); color: #2dd4bf; border-color: #2dd4bf; }

        .token-badge { 
            padding: 2px 10px; border-radius: 12px; font-size: 10px; font-family: monospace; display: inline-block; 
        }
        .token-valid { background: rgba(45, 212, 191, 0.12); color: #2dd4bf; }
        .token-used { background: rgba(45, 212, 191, 0.08); color: #2dd4bf; }
        .token-invalid { background: rgba(248, 113, 113, 0.12); color: #f87171; }
        .token-expired { background: rgba(148, 163, 184, 0.08); color: #64748b; }
        .token-pending { background: rgba(56, 189, 248, 0.08); color: #38bdf8; }
        .token-source-badge { 
            background: rgba(19, 27, 46, 0.4); color: #94a3b8; padding: 2px 6px; 
            border-radius: 4px; font-family: monospace; font-size: 9px; 
        }

        .otp-display { 
            background: rgba(45, 212, 191, 0.08); color: #2dd4bf; 
            padding: 4px 10px; border-radius: 8px; font-family: monospace; font-weight: 700; font-size: 14px; 
        }
        .waiting-otp-badge { 
            background: rgba(129, 140, 248, 0.12); color: #818cf8; 
            padding: 4px 8px; border-radius: 16px; font-size: 10px; font-weight: bold; animation: pulse 1.5s infinite; 
        }
        .manual-otp-container { display: flex; gap: 5px; align-items: center; min-width: 160px; }
        .manual-otp-input { 
            width: 80px; padding: 6px 8px; 
            background: rgba(13, 21, 37, 0.6); border: 1px solid rgba(45, 212, 191, 0.08); 
            border-radius: 6px; font-family: monospace; font-size: 14px; font-weight: bold; 
            text-align: center; letter-spacing: 3px; color: #e2e8f0; 
        }
        .manual-otp-input:focus { border-color: #2dd4bf; }

        .client-name { font-weight: 600; color: #38bdf8; }
        .device-id-badge { 
            background: rgba(19, 27, 46, 0.6); color: #94a3b8; 
            padding: 2px 6px; border-radius: 6px; font-family: monospace; font-size: 10px; 
        }
        .client-ip { background: rgba(56, 189, 248, 0.08); color: #38bdf8; padding: 2px 8px; border-radius: 12px; font-family: monospace; font-size: 11px; }
        .proxy-ip { background: rgba(129, 140, 248, 0.08); color: #818cf8; padding: 2px 8px; border-radius: 12px; font-family: monospace; font-size: 11px; }
        .endpoint-name { font-weight: 600; color: #38bdf8; font-size: 11px; }
        .request-id { background: rgba(19, 27, 46, 0.4); color: #64748b; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 10px; }

        .btn-pay { 
            background: linear-gradient(135deg, #fbbf24, #f59e0b); 
            color: #0a0e17; font-weight: 700; padding: 4px 12px; font-size: 11px; 
            border-radius: 6px; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; 
        }
        .payment-url { font-size: 10px; color: #64748b; word-break: break-all; }
        .payment-cell { display: flex; flex-direction: column; gap: 5px; }

        .password-cell { font-family: 'Monaco', 'Courier New', monospace; font-size: 12px; font-weight: 600; color: #94a3b8; }
        .password-toggle { cursor: pointer; margin-left: 6px; font-size: 12px; opacity: 0.6; display: inline-block; }
        .password-toggle:hover { opacity: 1; }

        .appointment-container { display: flex; gap: 5px; align-items: center; min-width: 200px; }
        .appointment-input { 
            width: 120px; padding: 6px 8px; 
            background: rgba(13, 21, 37, 0.6); border: 1px solid rgba(45, 212, 191, 0.08); 
            border-radius: 6px; font-family: monospace; font-size: 12px; color: #e2e8f0; 
        }

        .rate-limit-info { 
            background: rgba(251, 191, 36, 0.05); 
            padding: 12px 16px; border-radius: 10px; 
            border-left: 3px solid #fbbf24; 
            font-size: 13px; color: #94a3b8; 
        }
        .rate-limit-info strong { color: #fbbf24; }
        .wait-time-badge { background: rgba(56, 189, 248, 0.08); color: #38bdf8; padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: 600; }

        .routing-status-bar { 
            background: rgba(45, 212, 191, 0.03); 
            padding: 12px 16px; border-radius: 10px; 
            border-left: 3px solid #2dd4bf; margin-top: 8px; 
        }
        .routing-status-bar .route-path { font-weight: 600; color: #2dd4bf; }
        .resource-badge { 
            display: inline-block; padding: 2px 12px; border-radius: 12px; 
            font-size: 11px; font-weight: 600; margin: 2px; 
        }
        .resource-badge.available { background: rgba(45, 212, 191, 0.12); color: #2dd4bf; }
        .resource-badge.unavailable { background: rgba(248, 113, 113, 0.08); color: #f87171; }

        .host-stats-table th { color: #38bdf8; }
        .host-healthy { color: #2dd4bf; }
        .host-unhealthy { color: #f87171; }

        .parallel-section { margin-bottom: 32px; }
        .parallel-section h4 { color: #e2e8f0; font-size: 16px; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid rgba(45, 212, 191, 0.05); }

        .hits-input { font-family: monospace; font-size: 12px; }
        .retry-hint { font-size: 11px; color: #64748b; margin-left: 4px; }

        .menu-toggle { 
            display: none; position: fixed; top: 20px; left: 20px; z-index: 101; 
            background: rgba(19, 27, 46, 0.9); color: #e2e8f0; border: 1px solid rgba(45, 212, 191, 0.1); 
            padding: 12px 16px; border-radius: 10px; cursor: pointer; font-size: 18px; 
            backdrop-filter: blur(10px);
        }

        .token-detail-card { 
            background: rgba(19, 27, 46, 0.4); border-radius: 12px; padding: 16px; margin-bottom: 12px; 
            border: 1px solid rgba(45, 212, 191, 0.05); 
        }
        .token-detail-card .label { font-weight: 600; color: #64748b; font-size: 11px; }
        .token-detail-card .value { font-weight: 700; color: #e2e8f0; font-size: 16px; }

        .proxy-status-ok { color: #2dd4bf; font-weight: bold; }
        .proxy-status-fail { color: #f87171; font-weight: bold; }
        .proxy-enabled { color: #2dd4bf; }
        .proxy-disabled { color: #f87171; }

        .status-indicator { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
        .status-indicator.green { background: #2dd4bf; }
        .status-indicator.red { background: #f87171; }
        .status-indicator.yellow { background: #fbbf24; }

        .mode-indicator { font-size: 11px; padding: 3px 12px; border-radius: 20px; font-weight: 600; }
        .mode-indicator.single { background: rgba(56, 189, 248, 0.08); color: #38bdf8; }
        .mode-indicator.parallel { background: rgba(45, 212, 191, 0.08); color: #2dd4bf; }
        .mode-indicator.retry-enabled { background: rgba(251, 191, 36, 0.08); color: #fbbf24; }

        .tab-content { display: none; animation: fadeIn 0.3s ease; }
        .tab-content.active { display: block; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        @media (max-width: 1024px) { 
            .menu-toggle { display: block; } 
            .sidebar { transform: translateX(-100%); } 
            .sidebar.open { transform: translateX(0); } 
            .main-content { margin-left: 0; padding: 16px; } 
            .stats-grid { grid-template-columns: repeat(2, 1fr); } 
        }
        @media (max-width: 600px) {
            .stats-grid { grid-template-columns: 1fr; }
            .slot-monitor-bar { flex-direction: column; align-items: stretch; }
            .retry-toggle-group { justify-content: center; }
        }
    </style>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
    <style>
    /* ===== MAFIASPOT — INDIGO / CYAN THEME (visual only — no logic/IDs changed) ===== */
    :root{
        --gold:#22d3ee; --gold2:#8b5cf6; --goldlite:#a5f3fc; --golddeep:#7c6cf0;
        --blk:#080b16; --blk2:#0b1020; --card:#0d1424; --card2:#0b1120;
        --line:rgba(34,211,238,.16); --text:#ece4cf; --mut:#8b93a7;
        --gradGold:linear-gradient(135deg,#a5f3fc,#22d3ee 45%,#7c6cf0);
    }
    body{
        background:radial-gradient(1300px 700px at 85% -15%,rgba(34,211,238,.10),transparent 55%),
                   radial-gradient(1000px 600px at -10% 115%,rgba(124,108,240,.08),transparent 55%),
                   linear-gradient(180deg,#080b16,#0a0f1e 60%,#060912)!important;
        color:var(--text)!important;font-family:'Inter',-apple-system,'Segoe UI',sans-serif!important;
        -webkit-font-smoothing:antialiased;letter-spacing:.1px;
    }
    code,.token-badge,.device-id-badge,.request-id,.net-log-row,.log-content,.cd-time,.ck-time,.password-cell,.manual-otp-input,.appointment-input{font-family:'JetBrains Mono',Consolas,monospace!important}
    ::-webkit-scrollbar{width:10px;height:10px}
    ::-webkit-scrollbar-thumb{background:linear-gradient(180deg,var(--gold),var(--golddeep));border-radius:10px;border:2px solid #060912}

    /* ---- Sidebar ---- */
    .sidebar{background:linear-gradient(180deg,#0d1424,#070c18)!important;border-right:1px solid var(--line)!important;box-shadow:2px 0 40px rgba(0,0,0,.6)!important}
    .sidebar-header{padding:24px 20px!important;border-bottom:1px solid var(--line)!important}
    .sidebar-header h2{font-size:20px!important;font-weight:800!important;letter-spacing:1px!important;background:var(--gradGold)!important;-webkit-background-clip:text!important;background-clip:text!important;-webkit-text-fill-color:transparent!important}
    .nav-item{position:relative;border-radius:12px!important;padding:12px 14px!important;margin-bottom:5px!important;font-weight:600!important;color:#8b93a7!important;transition:all .18s ease!important}
    .nav-item:hover{background:rgba(34,211,238,.08)!important;color:var(--goldlite)!important}
    .nav-item.active{background:linear-gradient(135deg,rgba(34,211,238,.16),rgba(124,108,240,.10))!important;color:var(--goldlite)!important;border:1px solid rgba(34,211,238,.30)!important;box-shadow:0 6px 22px rgba(34,211,238,.14)!important}
    .nav-item.active::before{content:"";position:absolute;left:-12px;top:18%;bottom:18%;width:4px;border-radius:4px;background:var(--gradGold)}
    .nav-item{padding:13px 15px!important}
    .nav-label{font-size:15.5px!important;font-weight:600!important;letter-spacing:.3px!important}
    .nav-icon{font-size:20px!important;width:26px!important;filter:saturate(.4) sepia(.4)}

    /* ---- Stat cards ---- */
    .stats-grid{gap:18px!important}
    .stat-card{position:relative;overflow:hidden;background:linear-gradient(160deg,#101a2e,#0d1424)!important;border:1px solid var(--line)!important;border-radius:18px!important;padding:22px!important;box-shadow:0 12px 36px rgba(0,0,0,.5)!important;transition:transform .22s ease,box-shadow .22s ease!important}
    .stat-card::before{content:"";position:absolute;top:0;left:0;right:0;height:4px;background:var(--gradGold)}
    .stat-card:hover{transform:translateY(-5px)!important;box-shadow:0 20px 50px rgba(34,211,238,.16),0 12px 36px rgba(0,0,0,.6)!important}
    .stat-number{font-size:38px!important;font-weight:800!important;letter-spacing:.5px;background:var(--gradGold)!important;-webkit-background-clip:text!important;background-clip:text!important;-webkit-text-fill-color:transparent!important}
    .stat-title{letter-spacing:1px!important;text-transform:uppercase;font-size:11px!important;color:var(--mut)!important}
    .stat-icon{font-size:26px!important;opacity:.85}

    /* ---- Panels / containers ---- */
    .config-panel,.table-container,.add-form,.bulk-actions,.token-detail-card{
        background:linear-gradient(160deg,#0e1626,#0b1020)!important;border:1px solid var(--line)!important;
        border-radius:16px!important;box-shadow:0 10px 34px rgba(0,0,0,.45)!important;backdrop-filter:blur(8px)!important;
    }
    .config-panel{padding:24px!important}
    .config-panel h3{font-size:17px!important;font-weight:700!important;display:flex;align-items:center;gap:10px;color:var(--goldlite)!important}
    .config-panel h3::before{content:"";width:8px;height:22px;border-radius:4px;background:var(--gradGold)}

    /* ---- Top control bar ---- */
    .slot-monitor-bar{background:linear-gradient(120deg,#0e1626,#0b1020)!important;border:1px solid var(--line)!important;border-radius:16px!important;box-shadow:0 10px 30px rgba(0,0,0,.45)!important;padding:14px 20px!important}
    .slot-label{color:#9fb0cf!important}

    /* ---- Buttons ---- */
    .btn{border-radius:11px!important;font-weight:700!important;letter-spacing:.4px!important;border:1px solid transparent!important;transition:transform .14s ease,box-shadow .2s ease,filter .2s ease!important}
    .btn:hover{transform:translateY(-2px)!important;filter:brightness(1.08)!important}
    .btn:active{transform:translateY(0) scale(.97)!important}
    .btn-primary,.btn-success{background:var(--gradGold)!important;color:#06121a!important;box-shadow:0 8px 22px rgba(34,211,238,.30)!important;border:1px solid rgba(165,243,252,.5)!important}
    .btn-info{background:linear-gradient(135deg,#8b5cf6,#6d28d9)!important;color:#06121a!important;box-shadow:0 8px 22px rgba(124,108,240,.28)!important}
    .btn-warning{background:linear-gradient(135deg,#a78bfa,#6d28d9)!important;color:#06121a!important;box-shadow:0 8px 22px rgba(139,92,246,.24)!important}
    .btn-danger{background:linear-gradient(135deg,#c0392b,#7f1d1d)!important;color:#fff!important;box-shadow:0 8px 22px rgba(192,57,43,.28)!important;border:1px solid rgba(34,211,238,.25)!important}
    .btn-outline{background:transparent!important;border:1px solid rgba(34,211,238,.30)!important;color:#9fb0cf!important}
    .btn-outline:hover{border-color:var(--gold)!important;color:var(--goldlite)!important;background:rgba(34,211,238,.06)!important}

    /* ---- Inputs ---- */
    input,select,textarea{border-radius:11px!important;background:#0a1020!important;border:1px solid rgba(34,211,238,.18)!important;color:var(--text)!important;padding:10px 13px!important;transition:border-color .18s,box-shadow .18s!important}
    input:focus,select:focus,textarea:focus{border-color:var(--gold)!important;box-shadow:0 0 0 3px rgba(34,211,238,.16)!important;outline:none!important}
    input::placeholder,textarea::placeholder{color:#5b6b86!important}
    select option{background:#0b1120!important;color:var(--text)!important}

    /* ---- Tables ---- */
    th{background:#0a1020!important;letter-spacing:.7px!important;font-weight:700!important;color:var(--gold)!important;text-transform:uppercase;font-size:11px!important;border-bottom:1px solid var(--line)!important;padding:13px 14px!important}
    td{border-bottom:1px solid rgba(34,211,238,.07)!important;padding:12px 14px!important}
    tr:hover td{background:rgba(34,211,238,.05)!important}

    /* ---- Badges / pills ---- */
    .step-badge,.status-badge,.token-badge,.encryption-badge,.service-badge,.always-enabled-badge,.enabled-by-default-badge,.mode-indicator,.resource-badge,.proxy-rotated-badge,.wait-time-badge,.client-ip,.proxy-ip{border-radius:999px!important;font-weight:700!important;letter-spacing:.3px!important}
    .encryption-badge,.always-enabled-badge{background:rgba(34,211,238,.14)!important;color:var(--gold)!important;border:1px solid rgba(34,211,238,.25)!important}

    /* ---- Mode / retry / toggles ---- */
    .mode-switch-container,.retry-toggle-group{border-radius:999px!important;border:1px solid var(--line)!important;background:rgba(16,13,8,.8)!important}
    .mode-btn{border-radius:999px!important;font-weight:700!important}
    .mode-btn.active{background:var(--gradGold)!important;color:#06121a!important;box-shadow:0 6px 18px rgba(34,211,238,.28)!important}
    .slider{border-radius:999px!important;border:1px solid rgba(34,211,238,.22)!important;background:#101a2e!important}
    input:checked + .slider{background:var(--gradGold)!important;border-color:var(--gold)!important}

    /* ---- Modal / toast ---- */
    .modal-content{border-radius:20px!important;background:linear-gradient(160deg,#101a2e,#0d1424)!important;border:1px solid var(--line)!important;box-shadow:0 36px 90px rgba(0,0,0,.75)!important}
    .toast{border-radius:13px!important;backdrop-filter:blur(16px)!important;box-shadow:0 16px 40px rgba(0,0,0,.6)!important;font-weight:600!important}

    .main-content{padding:26px 34px!important}
    </style>
</head>
<body>
<button class="menu-toggle" onclick="toggleSidebar()">☰</button>

<!-- ==================== SIDEBAR ==================== -->
<div class="sidebar" id="sidebar">
    <div class="sidebar-header">
        <h2>🏥 IVAC Payment Bot</h2>
        <p>
            <span class="encryption-badge">🔐 TOKEN MANAGEMENT</span>
            <span class="encryption-badge">⏱️ 80s EXPIRY</span>
            <span class="service-badge">💳 dg-epay</span>
            <span class="service-badge">⚡ SINGLE + PARALLEL</span>
            <span class="service-badge">🔄 ROUTING</span>
            <span class="service-badge">🔍 SLOT MONITOR</span>
            <span class="service-badge">📝 MANUAL OTP</span>
            <span class="service-badge">🌐 PROXY + HOST</span>
            <span class="service-badge">🔑 PER-INSTANCE TOKENS</span>
            <span class="service-badge" style="background:rgba(45,212,191,0.12);color:#2dd4bf;">✅ SINGLE HIT ALWAYS ON</span>
            <span class="service-badge" style="background:rgba(56,189,248,0.08);color:#38bdf8;">🔵 RETRY ENABLED</span>
            <span class="service-badge" style="background:rgba(251,191,36,0.08);color:#fbbf24;">⏳ 429 SMART WAIT</span>
            <span class="service-badge" style="background:rgba(129,140,248,0.08);color:#818cf8;">🔄 PROXY AUTO-ROTATION</span>
            <span class="service-badge" style="background:rgba(45,212,191,0.08);color:#2dd4bf;">♾️ RETRY UNTIL SUCCESS</span>
        </p>
    </div>
    <div class="sidebar-nav">
        <div class="nav-item active" data-tab="instances"><span class="nav-icon">📋</span><span class="nav-label">Instances</span></div>
        <div class="nav-item" data-tab="config"><span class="nav-icon">⚙️</span><span class="nav-label">Configuration</span></div>
        <div class="nav-item" data-tab="parallel"><span class="nav-icon">⚡</span><span class="nav-label">Parallel Config</span></div>
        <div class="nav-item" data-tab="proxies"><span class="nav-icon">🌐</span><span class="nav-label">Proxies</span></div>
        <div class="nav-item" data-tab="hosts"><span class="nav-icon">🖥️</span><span class="nav-label">Hosts</span></div>
        <div class="nav-item" data-tab="tokens"><span class="nav-icon">🔑</span><span class="nav-label">Token Management</span></div>
        <div class="nav-item" onclick="window.open('/admin/users','_blank')"><span class="nav-icon">👤</span><span class="nav-label">User Config</span></div>
        <div class="nav-item" onclick="window.open('/portal','_blank')"><span class="nav-icon">📁</span><span class="nav-label">File Manager</span></div>
    </div>
</div>

<!-- ==================== MAIN CONTENT ==================== -->
<div class="main-content">
    <div id="toast" class="toast"></div>
    
    <!-- STATS -->
    <div class="stats-grid">
        <div class="stat-card stat-total"><div class="stat-header"><span class="stat-title">Total Instances</span><span class="stat-icon">📊</span></div><div class="stat-number" id="totalCount">0</div></div>
        <div class="stat-card stat-running"><div class="stat-header"><span class="stat-title">Running</span><span class="stat-icon">▶️</span></div><div class="stat-number" id="runningCount">0</div></div>
        <div class="stat-card stat-failed"><div class="stat-header"><span class="stat-title">Failed</span><span class="stat-icon">❌</span></div><div class="stat-number" id="failedCount">0</div></div>
        <div class="stat-card stat-completed"><div class="stat-header"><span class="stat-title">Completed</span><span class="stat-icon">✅</span></div><div class="stat-number" id="completedCount">0</div></div>
    </div>
    
    <!-- SLOT MONITOR BAR -->
    <div class="slot-monitor-bar">
        <div class="slot-status"><span class="slot-label">🔍 Slot Monitor:</span><span class="slot-value off" id="slotMonitorStatus">OFF</span></div>
        <label class="switch"><input type="checkbox" id="slotMonitorSwitch" onchange="toggleSlotMonitor(this.checked)"><span class="slider"></span></label>
        <div class="slot-status" style="margin-left:14px;"><span class="slot-label" title="CapSolver (API) + Encryption ON">C_token</span><label class="switch" style="margin-left:6px;"><input type="checkbox" id="cTokenSwitch" onchange="setTokenMode('capsolver')"><span class="slider"></span></label></div>
        <div class="slot-status" style="margin-left:10px;"><span class="slot-label" title="Token Relay (local farm, port 8787)">R_token</span><label class="switch" style="margin-left:6px;"><input type="checkbox" id="eTokenSwitch" onchange="setTokenMode('relay')"><span class="slider"></span></label></div>

        <!-- FLOW RETRY CONTROL (RJ SLOT parity: Single / per-step delays / Auto) -->
        <div class="slot-status" style="margin-left:14px;gap:6px;flex-wrap:wrap;align-items:flex-end;" title="Single: retry a failed step after its delay. Auto: continue to next step after a step succeeds; the AUTO box is the delay between steps.">
            <button id="flowSingleBtn" class="mode-btn inactive" onclick="toggleFlow('single')" style="padding:4px 10px;align-self:center;">Single</button>
            <label style="display:flex;flex-direction:column;align-items:center;font-size:10px;color:#22d3ee !important;font-weight:700;gap:2px;">Sign<input type="number" id="flowDelaySignin"   min="0" max="999" value="4"  title="Signin retry delay (s)"   style="width:46px !important;text-align:center !important;color:#67e8f9 !important;background:#0d1424 !important;border:1px solid #7c6cf0 !important;border-radius:6px !important;padding:4px 2px !important;font-weight:800 !important;font-size:14px !important;" onchange="saveFlowDelays()"></label>
            <label style="display:flex;flex-direction:column;align-items:center;font-size:10px;color:#22d3ee !important;font-weight:700;gap:2px;">Verify<input type="number" id="flowDelayVerify"   min="0" max="999" value="4"  title="Verify retry delay (s)"   style="width:46px !important;text-align:center !important;color:#67e8f9 !important;background:#0d1424 !important;border:1px solid #7c6cf0 !important;border-radius:6px !important;padding:4px 2px !important;font-weight:800 !important;font-size:14px !important;" onchange="saveFlowDelays()"></label>
            <label style="display:flex;flex-direction:column;align-items:center;font-size:10px;color:#22d3ee !important;font-weight:700;gap:2px;">Resrv<input type="number" id="flowDelayReserve"  min="0" max="999" value="21" title="Reserve retry delay (s)"  style="width:46px !important;text-align:center !important;color:#67e8f9 !important;background:#0d1424 !important;border:1px solid #7c6cf0 !important;border-radius:6px !important;padding:4px 2px !important;font-weight:800 !important;font-size:14px !important;" onchange="saveFlowDelays()"></label>
            <label style="display:flex;flex-direction:column;align-items:center;font-size:10px;color:#22d3ee !important;font-weight:700;gap:2px;">Book<input type="number" id="flowDelayBook"     min="0" max="999" value="4"  title="Book retry delay (s)"     style="width:46px !important;text-align:center !important;color:#67e8f9 !important;background:#0d1424 !important;border:1px solid #7c6cf0 !important;border-radius:6px !important;padding:4px 2px !important;font-weight:800 !important;font-size:14px !important;" onchange="saveFlowDelays()"></label>
            <label style="display:flex;flex-direction:column;align-items:center;font-size:10px;color:#22d3ee !important;font-weight:700;gap:2px;">Init<input type="number" id="flowDelayInitiate" min="0" max="999" value="4"  title="Initiate retry delay (s)" style="width:46px !important;text-align:center !important;color:#67e8f9 !important;background:#0d1424 !important;border:1px solid #7c6cf0 !important;border-radius:6px !important;padding:4px 2px !important;font-weight:800 !important;font-size:14px !important;" onchange="saveFlowDelays()"></label>
            <label style="display:flex;flex-direction:column;align-items:center;font-size:10px;color:#34d399 !important;font-weight:700;gap:2px;">Auto-s<input type="number" id="flowAutoDelay" min="0" max="999" value="0" title="Auto delay between steps (s)" style="width:46px !important;text-align:center !important;color:#34d399 !important;background:#08160f !important;border:1px solid #2f9e74 !important;border-radius:6px !important;padding:4px 2px !important;font-weight:800 !important;font-size:14px !important;" onchange="saveFlowDelays()"></label>
            <button id="flowAutoBtn" class="mode-btn active" onclick="toggleFlow('auto')" style="padding:4px 10px;align-self:center;">Auto</button>
        </div>

        <div style="display: flex; align-items: center; gap: 16px; margin-left: auto; flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: 10px;">
                <span style="font-weight: 600; color: #94a3b8; font-size: 12px;">Request Mode:</span>
                <div class="mode-switch-container">
                    <button id="singleModeBtn" class="mode-btn active" onclick="toggleRequestMode('single')">⚡ Single</button>
                    <button id="parallelModeBtn" class="mode-btn inactive" onclick="toggleRequestMode('parallel')">⚡ Parallel</button>
                </div>
            </div>
        </div>
        
        <div class="retry-toggle-group">
            <div class="retry-toggle-item">
                <label>Parallel Retry:</label>
                <label class="switch">
                    <input type="checkbox" id="parallelRetryToggle" onchange="toggleParallelRetryMode(this.checked)">
                    <span class="slider"></span>
                </label>
            </div>
        </div>
        
        <div class="action-buttons">
            <button class="btn btn-primary btn-sm" onclick="testParallel()">⚡ Test Parallel</button>
            <button class="btn btn-success btn-sm" onclick="testParallelRetry()">🔄 Test Retry</button>
            <button class="btn btn-info btn-sm" onclick="checkSlotStatus()">🔍 Check Slots</button>
        </div>
    </div>
    
    <!-- TAB: INSTANCES -->
    <div id="tab-instances" class="tab-content active">
        <div class="add-form">
            <span style="color:#8b93a7;font-size:13px;font-weight:600;">📁 Entries & files are added from <b style="color:#22d3ee;">File Manager</b>. Control instances here:</span>
            <span style="display:inline-flex;align-items:center;gap:6px;">
                <label style="color:#8b93a7;font-size:11px;font-weight:700;">Slot ID</label>
                <input id="manualSlotId" placeholder="auto (live scan)" title="Manual Slot ID — overrides live scan for all instances" style="width:230px;font-family:monospace;font-size:11px;padding:6px 8px;">
                <label style="color:#8b93a7;font-size:11px;font-weight:700;">dg-epay ID</label>
                <input id="manualDgepayId" placeholder="auto (live scan)" title="Manual dg-epay ID — overrides live scan for all instances" style="width:230px;font-family:monospace;font-size:11px;padding:6px 8px;">
                <button class="btn btn-outline btn-sm" onclick="saveManualIds()" title="Save overrides">💾</button>
                <span id="manualIdsHint" style="color:#64748b;font-size:10px;"></span>
            </span>
            <button class="btn btn-primary" onclick="fullAutoAll()" style="font-weight:800;">⚡ Full Auto All</button>
            <button class="btn btn-outline" onclick="cleanCache()" title="Clear resume sessions, captcha queues & dg-epay scan cache">🧹 Clean Cache</button>
            <button class="btn btn-outline" onclick="changeAdminPassword()" title="Change the admin login password">🔑 Password</button>
            <button class="btn btn-success" id="toggleAllBtn" onclick="toggleAll()">▶️ Start All</button>
            <button class="btn btn-warning" id="pauseAllBtn" onclick="togglePause()">⏸️ Pause All</button>
            <button class="btn btn-outline" onclick="refresh()">🔄 Refresh</button>
        </div>
        
        <div class="bulk-actions">
            <span>📌 Bulk Actions:</span>
            <button class="btn btn-success btn-sm" onclick="bulkAction('start')">▶️ Start</button>
            <button class="btn btn-danger btn-sm" onclick="bulkAction('stop')">⏹️ Stop</button>
            <button class="btn btn-warning btn-sm" onclick="bulkAction('pause')">⏸️ Pause</button>
            <button class="btn btn-info btn-sm" onclick="bulkAction('resume')">▶️ Resume</button>
            <button class="btn btn-danger btn-sm" onclick="bulkAction('delete')">🗑️ Delete</button>
            <label style="margin-left:auto;display:flex;align-items:center;gap:6px;color:#94a3b8;font-size:13px;">
                <input type="checkbox" id="selectAllCheckbox" onchange="toggleSelectAll()"> Select All
            </label>
        </div>
        
        <div class="table-container">
            <table class="instances-table"><thead>
                <th class="checkbox-col"><input type="checkbox" id="selectAllHeader" onchange="toggleSelectAll()"></th>
                <th>ID</th><th>Client</th><th>Phone</th><th>Password</th><th>Type</th><th>Step</th><th>OTP</th>
                <th>Device ID</th><th>Appointment ID</th><th>RID</th><th>Endpoint</th><th>Status</th>
                <th>Host IP</th><th>Proxy IP</th><th>Payment Url</th><th>Last Log</th><th>Action</th>
            </thead><tbody id="tableBody"></tbody>
            </table>
        </div>
    </div>
    
    <!-- TAB: CONFIGURATION -->
    <div id="tab-config" class="tab-content">
        <div class="config-panel"><h3>🔑 External Captcha Configuration</h3>
            <div style="background:rgba(45,212,191,0.03);padding:12px 16px;border-radius:10px;margin-bottom:16px;border-left:3px solid #2dd4bf;">
                <strong style="color:#2dd4bf;">💡 External Captcha APIs:</strong><br>
                <span style="color:#94a3b8;font-size:13px;">Login: <code style="color:#38bdf8;">https://thirdeyesms.shop/captcha-external/rumon-login-captcha.php</code></span><br>
                <span style="color:#94a3b8;font-size:13px;">Reserve: <code style="color:#38bdf8;">https://thirdeyesms.shop/captcha-external/rumon-reserve-captcha.php</code></span>
            </div>
        </div>
        
        <div class="config-panel"><h3>🧾 Invoice Download <span class="always-enabled-badge">🟢 RJ SLOT</span></h3>
            <div style="background:rgba(45,212,191,0.03);padding:12px 16px;border-radius:10px;margin-bottom:14px;border-left:3px solid #2dd4bf;">
                <span style="color:#94a3b8;font-size:13px;">Reserve hole <strong style="color:#67e8f9;">Reservation ID</strong> auto kore Tran ID box-e bose. Submit dile invoice ready hooয়া porjonto auto-retry kore, ready hole browser-e PDF download hoy.</span>
            </div>
            <div class="config-group" style="gap:10px;flex-wrap:wrap;">
                <label>Tran ID (txrId):</label>
                <input type="text" id="invoiceTrxId" placeholder="Reservation ID auto-loads here" autocomplete="off" style="flex:1;min-width:220px;font-family:monospace;">
            </div>
            <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
                <button class="btn btn-primary" id="invoiceSubmitBtn" onclick="toggleInvoiceDownload()">📥 Submit</button>
                <button class="btn btn-outline" onclick="document.getElementById('invoiceTrxId').value=''">🗑️ Clear</button>
                <span id="invoiceStatusLine" style="color:#94a3b8;font-size:13px;"></span>
            </div>
        </div>

        <div class="config-panel"><h3>⚙️ Advanced Settings</h3>
            <div class="config-group"><label>Auto OTP:</label><select id="autoOtp"><option value="true">ON</option><option value="false">OFF</option></select></div>
            <div class="config-group"><label>OTP Retry Delay (ms):</label><input type="number" id="otpRetryDelay" value="5000"></div>
            <div class="config-group"><label>Login Mode:</label><select id="loginMode"><option value="auto">Auto</option><option value="manual">Manual</option></select></div>
            <div class="config-group"><label>Slot Check Interval (sec):</label><input type="number" id="slotCheckInterval" value="15"></div>
            <div class="config-group"><label>Token Expiry (seconds):</label><input type="number" id="tokenExpiry" value="80"></div>
        </div>
        
        <div class="config-panel"><h3>↻ Step Retry (Single / Auto) <span class="always-enabled-badge">🟢 TOP BAR</span></h3>
            <div style="background:rgba(45,212,191,0.03);padding:12px 16px;border-radius:10px;border-left:3px solid #2dd4bf;">
                <strong style="color:#2dd4bf;">💡 RJ SLOT style:</strong>
                <span style="color:#94a3b8;">Retry ekhon top bar-er <strong style="color:#67e8f9;">Single / [delays] / Auto</strong> control diye hoy.</span>
                <ul style="margin-top:6px;padding-left:20px;color:#94a3b8;font-size:13px;">
                    <li><strong style="color:#67e8f9;">Single ON</strong> → step fail হলে oi step-er delay (s) por retry.</li>
                    <li><strong style="color:#67e8f9;">Single OFF</strong> → fail হলে stop.</li>
                    <li><strong style="color:#34d399;">Auto</strong> → step success হলে porer step e jay; Auto box = step-er majkhane delay (s).</li>
                </ul>
                <span style="color:#64748b;font-size:12px;">Purono "Single Hit Retry" config baad — eki retry duto jaygai thakle conflict hoto.</span>
            </div>
        </div>

        <div class="config-panel"><h3>🔄 Routing Mode Configuration</h3>
            <div style="background:rgba(129,140,248,0.03);padding:12px 16px;border-radius:10px;margin-bottom:16px;border-left:3px solid #818cf8;">
                <strong style="color:#818cf8;">💡 Routing Mode:</strong> <span style="color:#94a3b8;">Select how requests should be routed.</span>
                <br><span style="color:#94a3b8;font-size:13px;">🔄 Proxy Auto-Rotation works with ALL routing modes that use proxies.</span>
            </div>
            <div class="config-group">
                <label>Current Mode:</label>
                <select id="routingMode" style="flex:1;max-width:300px;padding:8px 12px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:8px;color:#e2e8f0;">
                    <option value="proxy_host">🌐 PROXY + HOST</option>
                    <option value="proxy_only">🔒 PROXY ONLY</option>
                    <option value="host_only">🖥️ HOST ONLY</option>
                    <option value="direct">⚡ DIRECT</option>
                </select>
            </div>
            <div class="routing-status-bar">
                <div><strong style="color:#94a3b8;">📊 Current Route:</strong> <span class="route-path" id="routePathDisplay">Instance → Direct API</span></div>
                <div style="margin-top:4px;"><strong style="color:#94a3b8;">🔗 Available Resources:</strong> <span id="availableResources" style="color:#94a3b8;">Checking...</span></div>
                <div style="margin-top:6px;display:flex;gap:12px;flex-wrap:wrap;">
                    <span id="proxyStatusBadge" class="resource-badge unavailable">🔍 Checking Proxy...</span>
                    <span id="hostStatusBadge" class="resource-badge unavailable">🔍 Checking Host...</span>
                </div>
                <div style="margin-top:6px;font-size:11px;color:#64748b;">
                    <strong style="color:#64748b;">🔄 Proxy Auto-Rotation:</strong> Enabled on errors (400, 429, 503, 504, 520, 530)
                </div>
            </div>
            <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;">
                <button class="btn btn-primary" onclick="saveRoutingMode()">💾 Apply Routing Mode</button>
                <button class="btn btn-info" onclick="refreshRoutingStatus()">🔄 Refresh Status</button>
            </div>
            <div style="margin-top:12px;font-size:12px;color:#64748b;">
                <strong style="color:#64748b;">📌 Routing Paths:</strong>
                <ul style="margin-top:6px;padding-left:20px;color:#94a3b8;">
                    <li><strong style="color:#38bdf8;">PROXY + HOST:</strong> Instance → Proxy → Host IP → API</li>
                    <li><strong style="color:#818cf8;">PROXY ONLY:</strong> Instance → Proxy → Direct API</li>
                    <li><strong style="color:#fbbf24;">HOST ONLY:</strong> Instance → Host IP → API</li>
                    <li><strong style="color:#94a3b8;">DIRECT:</strong> Instance → Direct API</li>
                </ul>
            </div>
        </div>
        
        <div class="config-panel">
            <button class="btn btn-primary" onclick="saveConfig()">💾 Save Config</button>
            <button class="btn btn-outline" onclick="loadConfig()">🔄 Reload</button>
        </div>
    </div>
    
    <!-- TAB: PARALLEL -->
    <div id="tab-parallel" class="tab-content">
        <div class="parallel-section"><h4>⚡ TRADITIONAL PARALLEL</h4><div class="table-container"><table class="config-table"><thead>
            <th>API Endpoint</th><th>Parallel Hits</th><th>Delay Between Hits (ms)</th><th>429 Default Wait</th>
        </thead><tbody>
             <tr><td style="color:#e2e8f0;">🔐 Signin</td><td><input type="number" id="parallelSigninHits" value="15" style="width:100px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;"></td><td><input type="number" id="parallelSigninMs" value="300" style="width:100px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;"></td><td style="font-size:12px;color:#64748b;">20s</td></tr>
             <tr><td style="color:#e2e8f0;">📱 Verify OTP</td><td><input type="number" id="parallelVerifyHits" value="25" style="width:100px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;"></td><td><input type="number" id="parallelVerifyMs" value="500" style="width:100px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;"></td><td style="font-size:12px;color:#64748b;">20s</td></tr>
             <tr><td style="color:#e2e8f0;">📌 Reserve Slot</td><td><input type="number" id="parallelReserveHits" value="10" style="width:100px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;"></td><td><input type="number" id="parallelReserveMs" value="1000" style="width:100px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;"></td><td style="font-size:12px;color:#64748b;">20s</td></tr>
             <tr><td style="color:#e2e8f0;">📋 Booking Config</td><td><input type="number" id="parallelBookingHits" value="10" style="width:100px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;"></td><td><input type="number" id="parallelBookingMs" value="500" style="width:100px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;"></td><td style="font-size:12px;color:#64748b;">5s</td></tr>
             <tr><td style="color:#e2e8f0;">💳 Initiate Payment</td><td><input type="number" id="parallelInitiateHits" value="2" style="width:100px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;"></td><td><input type="number" id="parallelInitiateMs" value="100" style="width:100px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;"></td><td style="font-size:12px;color:#64748b;">3s</td></tr>
        </tbody></table></div><button class="btn btn-primary" onclick="saveTraditionalParallelConfig()" style="margin-top:16px">💾 Save</button></div>
        
        <div class="parallel-section"><h4>🔄 PARALLEL RETRY <span class="enabled-by-default-badge">🔵 ENABLED BY DEFAULT</span></h4>
            <div style="background:rgba(56,189,248,0.03);padding:12px 16px;border-radius:10px;margin-bottom:16px;border-left:3px solid #38bdf8;">
                <strong style="color:#38bdf8;">💡 Parallel Retry:</strong> <span style="color:#94a3b8;">Each endpoint retry is <strong style="color:#38bdf8;">ENABLED BY DEFAULT</strong>.</span>
                <br><span style="color:#94a3b8;font-size:13px;">🔑 Signin and Reserve always reuse captcha tokens.</span>
                <br><span style="color:#94a3b8;font-size:13px;">⏳ 429 Rate Limiting: Extracts wait time from response body.</span>
                <br><span style="color:#94a3b8;font-size:13px;">🔄 Proxy Auto-Rotation on errors.</span>
                <br><span style="color:#94a3b8;font-size:13px;">♾️ Retry Until Success.</span>
            </div>
            <div class="table-container"><table class="config-table"><thead>
                <th>API Endpoint</th><th>Enabled</th>
                <th>Hit Pattern</th><th>Delay (ms)</th><th>Reuse Captcha</th><th>429 Default Wait</th>
            </thead><tbody>
                 <tr><td style="color:#e2e8f0;">🔐 Signin</td><td><input type="checkbox" id="parallelRetrySigninEnabled" checked></td><td><input type="text" id="parallelRetrySigninHits" placeholder="3,2,5,4" class="hits-input" style="width:150px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;" value="3,2,5,4"></td><td><input type="number" id="parallelRetrySigninDelay" value="100" style="width:100px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;"></td><td><input type="checkbox" id="parallelRetrySigninReuse" checked disabled><span style="font-size:11px;color:#64748b;margin-left:4px;">(always on)</span></td><td style="font-size:12px;color:#64748b;">20s</td></tr>
                 <tr><td style="color:#e2e8f0;">📱 Verify OTP</td><td><input type="checkbox" id="parallelRetryVerifyEnabled" checked></td><td><input type="text" id="parallelRetryVerifyHits" placeholder="3,2,5,4" class="hits-input" style="width:150px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;" value="3,2,5,4"></td><td><input type="number" id="parallelRetryVerifyDelay" value="100" style="width:100px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;"></td><td><span style="font-size:11px;color:#64748b;">N/A</span></td><td style="font-size:12px;color:#64748b;">20s</td></tr>
                 <tr><td style="color:#e2e8f0;">📌 Reserve</td><td><input type="checkbox" id="parallelRetryReserveEnabled" checked></td><td><input type="text" id="parallelRetryReserveHits" placeholder="3,2,5,4" class="hits-input" style="width:150px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;" value="3,2,5,4"></td><td><input type="number" id="parallelRetryReserveDelay" value="100" style="width:100px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;"></td><td><input type="checkbox" id="parallelRetryReserveReuse" checked disabled><span style="font-size:11px;color:#64748b;margin-left:4px;">(always on)</span></td><td style="font-size:12px;color:#64748b;">20s</td></tr>
                 <tr><td style="color:#e2e8f0;">📋 Booking</td><td><input type="checkbox" id="parallelRetryBookingEnabled" checked></td><td><input type="text" id="parallelRetryBookingHits" placeholder="3,2,5,4" class="hits-input" style="width:150px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;" value="3,2,5,4"></td><td><input type="number" id="parallelRetryBookingDelay" value="100" style="width:100px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;"></td><td><span style="font-size:11px;color:#64748b;">N/A</span></td><td style="font-size:12px;color:#64748b;">5s</td></tr>
                 <tr><td style="color:#e2e8f0;">💳 Payment</td><td><input type="checkbox" id="parallelRetryPaymentEnabled" checked></td><td><input type="text" id="parallelRetryPaymentHits" placeholder="3,2,5,4" class="hits-input" style="width:150px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;" value="3,2,5,4"></td><td><input type="number" id="parallelRetryPaymentDelay" value="100" style="width:100px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;padding:6px 10px;color:#e2e8f0;"></td><td><span style="font-size:11px;color:#64748b;">N/A</span></td><td style="font-size:12px;color:#64748b;">3s</td></tr>
            </tbody></table></div><button class="btn btn-primary" onclick="saveParallelRetryConfig()" style="margin-top:16px">💾 Save</button></div>
    </div>
    
    <!-- TAB: PROXIES -->
    <div id="tab-proxies" class="tab-content">
        <div class="config-panel"><h3>🌍 Proxy Management</h3><div style="margin-bottom:16px"><button class="btn btn-primary" onclick="openAddProxyModal()">➕ Add Proxy (single)</button><button class="btn btn-info" onclick="testAllProxies()">🔍 Test All</button><span style="margin-left:12px;color:#94a3b8;font-size:13px;">Total: <span id="proxyTotalCount" style="color:#e2e8f0;font-weight:600;">0</span> | Enabled: <span id="proxyEnabledCount" style="color:#2dd4bf;font-weight:600;">0</span></span></div>
        <div style="background:rgba(129,140,248,0.04);border:1px dashed rgba(129,140,248,.3);border-radius:10px;padding:12px 14px;margin-bottom:16px;">
            <div style="color:#a5b4fc;font-weight:700;font-size:13px;margin-bottom:6px;">📥 Bulk Add (একসাথে অনেক proxy — প্রতি লাইনে একটা)</div>
            <div style="color:#94a3b8;font-size:11px;margin-bottom:8px;">Format: <code>host:port</code> | <code>host:port:user:pass</code> | <code>socks5://user:pass@host:port</code></div>
            <textarea id="proxyBulkText" rows="6" style="width:100%;font-family:monospace;font-size:12px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:8px;color:#e2e8f0;padding:10px;" placeholder="1.2.3.4:8080&#10;5.6.7.8:3128:user:pass&#10;socks5://user:pass@9.9.9.9:1080"></textarea>
            <div style="margin-top:8px;"><button class="btn btn-success btn-sm" onclick="bulkAddProxies()">➕ Bulk Add</button><button class="btn btn-outline btn-sm" onclick="document.getElementById('proxyBulkText').value=''">🗑️ Clear</button></div>
        </div>
        <div id="proxyTableContainer"></div></div>
    </div>
    
    <!-- TAB: HOSTS -->
    <div id="tab-hosts" class="tab-content">
        <div class="config-panel"><h3>🖥️ Host IP Configuration</h3><textarea id="hostIPsText" rows="4" style="width:100%;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:10px;padding:12px;color:#e2e8f0;font-size:13px;" placeholder="Enter IP addresses one per line"></textarea><div style="margin-top:15px;display:flex;gap:10px;flex-wrap:wrap"><button class="btn btn-primary" onclick="saveHostIPs()">💾 Save</button><button class="btn btn-info" onclick="loadHostStats()">📊 Stats</button><button class="btn btn-warning" onclick="applyHostIP()">🌐 Apply Best</button><button class="btn btn-danger" onclick="removeHostEntry()">❌ Remove</button><button class="btn btn-outline" onclick="resetBestHost()">🔄 Reset</button></div><div id="hostStats" style="margin-top:20px"></div></div>
    </div>
    
    <!-- TAB: TOKENS -->
    <div id="tab-tokens" class="tab-content">
        <div class="config-panel">
            <h3>🔐 Token Encryption (Cipher) <span id="cipherStatusBadge" class="always-enabled-badge">checking...</span></h3>
            <div style="background:rgba(45,212,191,0.03);padding:12px 16px;border-radius:10px;margin-bottom:12px;border-left:3px solid #2dd4bf;">
                <div style="color:#94a3b8;font-size:13px;">Auto-load path: <code id="cipherPaths" style="color:#38bdf8;"></code></div>
                <div style="color:#94a3b8;font-size:12px;margin-top:4px;">Path theke cipher.js auto-load + watcher auto-detect (RJ SLOT style).</div>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
                <label style="display:flex;align-items:center;gap:6px;color:#e2e8f0;"><input type="checkbox" id="cipherEnabled" onchange="toggleCipher(this.checked)"> Enable Encryption</label>
                <button class="btn btn-info btn-sm" onclick="reloadCipher()">🔄 Reload from Path</button>
                <button class="btn btn-primary btn-sm" onclick="saveCipher()">💾 Save Script</button>
                <button class="btn btn-danger btn-sm" onclick="clearCipher()">🗑️ Clear</button>
            </div>
            <textarea id="cipherScript" rows="7" style="width:100%;font-family:monospace;font-size:11px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:8px;color:#c4b5fd;padding:10px;" placeholder="cipher.js script..."></textarea>
        </div>
        <div class="config-panel">
            <h3>🧩 Captcha Solver + Queue <span id="captchaQueueBadge" class="enabled-by-default-badge">signin 0 | reserve 0</span></h3>
            <div style="background:rgba(129,140,248,0.03);padding:12px 16px;border-radius:10px;margin-bottom:12px;border-left:3px solid #818cf8;color:#94a3b8;font-size:12px;">
                Queue keeps Signin & Reserve tokens pre-solved + pre-encrypted (4-min lifetime, reuse, invalid -> new). rumon + CapMonster/CapSolver/2Captcha/YesCaptcha.
            </div>
            <div class="config-group"><label>Provider:</label>
                <select id="captchaProvider" onchange="onCaptchaProviderChange()">
                    <option value="relay">Token Relay (local farm)</option>
                    <option value="capmonster">CapMonster</option>
                    <option value="capsolver">CapSolver</option>
                    <option value="2captcha">2Captcha</option>
                    <option value="yescaptcha">YesCaptcha</option>
                </select>
            </div>
            <div class="config-group"><label>Relay URL:</label><input type="text" id="captchaRelayUrl" placeholder="http://127.0.0.1:8787" style="flex:1;max-width:360px;"></div>
            <div class="config-group"><label>API Key:</label><input type="text" id="captchaKey" placeholder="provider API key" style="flex:1;max-width:360px;"></div>
            <div class="config-group"><label>Queue size (each):</label><input type="number" id="captchaQueueSize" value="3" min="1" max="10" style="max-width:120px;"></div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;">
                <button class="btn btn-primary btn-sm" onclick="saveCaptchaConfig()">💾 Save</button>
                <button class="btn btn-info btn-sm" onclick="testCaptcha()">🧪 Test Solve</button>
                <button class="btn btn-outline btn-sm" onclick="loadCaptchaQueue()">🔄 Refresh Queue</button>
            </div>
            <div id="captchaQueueInfo" style="margin-top:10px;color:#2dd4bf;font-weight:600;">Ready — Signin: 0 | Reserve: 0</div>
        </div>

        <div class="config-panel">
            <h3>🔑 Token Management System</h3>
            
            <div style="background:rgba(45,212,191,0.03);padding:12px 16px;border-radius:10px;margin-bottom:16px;border-left:3px solid #2dd4bf;">
                <strong style="color:#2dd4bf;">💡 Token Management Features:</strong>
                <ul style="margin-top:6px;padding-left:20px;color:#94a3b8;font-size:13px;">
                    <li>Per-instance token isolation</li>
                    <li>Token validation before each request</li>
                    <li>Token reuse until expired</li>
                    <li>Token expiry: 80 seconds</li>
                    <li>Automatic cleanup of expired/used/invalid tokens</li>
                    <li>⏳ 429 Smart Wait</li>
                    <li>🔄 Proxy Auto-Rotation</li>
                    <li>♾️ Retry Until Success</li>
                </ul>
            </div>
            
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">
                <button class="btn btn-info" onclick="loadTokenStatus()">📊 View All Tokens</button>
                <button class="btn btn-danger" onclick="clearAllTokens()">🗑️ Clear All Tokens</button>
                <input type="number" id="clearInstanceId" placeholder="Instance ID" style="width:120px;padding:8px 12px;background:rgba(13,21,37,0.6);border:1px solid rgba(45,212,191,0.08);border-radius:6px;color:#e2e8f0;">
                <button class="btn btn-warning" onclick="clearInstanceTokens()">🗑️ Clear Instance</button>
                <button class="btn btn-primary" onclick="loadInstanceTokenStatus()">🔍 Check Instance</button>
                <button class="btn btn-success" onclick="validateAllInstanceTokens()">✅ Validate All</button>
            </div>
            
            <div id="tokenStatusContainer" style="margin-top:16px;"></div>
        </div>
        
        <div class="config-panel">
            <h3>📊 Token Validation Status</h3>
            <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
                <div class="token-detail-card" style="flex:1;min-width:150px;">
                    <div class="label">Total Tokens</div>
                    <div class="value" id="totalTokenCount">0</div>
                </div>
                <div class="token-detail-card" style="flex:1;min-width:150px;border-color:rgba(45,212,191,0.15);">
                    <div class="label" style="color:#2dd4bf;">✅ Valid</div>
                    <div class="value" id="validTokenCount" style="color:#2dd4bf;">0</div>
                </div>
                <div class="token-detail-card" style="flex:1;min-width:150px;border-color:rgba(248,113,113,0.15);">
                    <div class="label" style="color:#f87171;">❌ Invalid</div>
                    <div class="value" id="invalidTokenCount" style="color:#f87171;">0</div>
                </div>
                <div class="token-detail-card" style="flex:1;min-width:150px;border-color:rgba(251,191,36,0.15);">
                    <div class="label" style="color:#fbbf24;">⏳ Used</div>
                    <div class="value" id="usedTokenCount" style="color:#fbbf24;">0</div>
                </div>
            </div>
            <div id="tokenValidationContainer"></div>
        </div>
    </div>
</div>

<!-- ==================== MODALS ==================== -->
<div id="logModal" class="modal"><div class="modal-content"><h3>📋 Instance Logs - #<span id="logIdSpan"></span> (<span id="logNameSpan"></span>)</h3><div class="log-filter-bar"><button class="log-filter-btn active" onclick="filterLogs('all', this)">All</button><button class="log-filter-btn" onclick="filterLogs('api', this)">API</button><button class="log-filter-btn" onclick="filterLogs('otp', this)">OTP</button><button class="log-filter-btn" onclick="filterLogs('captcha', this)">Captcha</button><button class="log-filter-btn" onclick="filterLogs('step', this)">Step</button><button class="log-filter-btn" onclick="filterLogs('error', this)">Error</button><button class="log-filter-btn" onclick="filterLogs('success', this)">Success</button><button class="log-filter-btn" onclick="filterLogs('token', this)">Token</button><button class="log-filter-btn" onclick="filterLogs('rate', this)">Rate Limit</button><button class="log-filter-btn" onclick="filterLogs('proxy', this)">Proxy</button></div><div class="modal-buttons" style="margin-bottom:12px"><button class="btn btn-info" onclick="copyAllLogs()">📋 Copy All</button><button class="btn btn-warning" onclick="clearLogs()">🗑️ Clear</button></div><div id="logContent" class="log-content"></div><h4 style="margin-top:16px;color:#38bdf8;">📡 Network Requests</h4><div id="networkLogContent" class="network-logs"></div><div class="modal-buttons" style="margin-top:16px"><button class="btn btn-primary" onclick="closeLogModal()">Close</button></div></div></div>

<div id="editModal" class="modal"><div class="modal-content"><h3>✏️ Edit Instance</h3><input type="hidden" id="editId"><input type="text" id="editClientName" placeholder="Client Name"><input type="text" id="editLoginPhone" placeholder="Login Phone"><input type="password" id="editPassword" placeholder="Password"><input type="text" id="editOtpPhone" placeholder="OTP Phone"><select id="editHighCom"><option>DHAKA</option><option>CHITAGONG</option><option>KHULNA</option><option>JASHORE</option><option>RAJSHAHI</option><option>SYLHET</option></select><select id="editVisaType"><option>MEDICAL</option><option>ENTRY</option><option>DOUBLE ENTRY</option><option>STUDENT</option><option>BUSINESS</option><option>TOURIST</option></select><div class="modal-buttons"><button class="btn btn-primary" onclick="saveEdit()">💾 Save</button><button class="btn btn-danger" onclick="closeEditModal()">❌ Cancel</button></div></div></div>

<div id="proxyModal" class="modal"><div class="modal-content"><h3 id="proxyModalTitle">Add Proxy</h3><input type="hidden" id="proxyEditId"><select id="proxyType"><option value="auto">Auto Detect</option><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks4">SOCKS4</option><option value="socks5">SOCKS5</option></select><input type="text" id="proxyHost" placeholder="Host / IP"><input type="number" id="proxyPort" placeholder="Port"><input type="text" id="proxyUser" placeholder="Username"><input type="password" id="proxyPassword" placeholder="Password"><label style="margin:10px 0;color:#94a3b8;display:flex;align-items:center;gap:8px;"><input type="checkbox" id="proxyEnabled" checked> Enable</label><div class="modal-buttons"><button class="btn btn-primary" onclick="saveProxy()">💾 Save</button><button class="btn btn-danger" onclick="closeProxyModal()">❌ Cancel</button></div></div></div>

<script>
// ==================== ORIGINAL JAVASCRIPT - ALL FUNCTIONS PRESERVED ====================
var selectedInstances = new Set();
var allRunning = false;
var allPaused = false;
var passwordVisible = {};
var ws = null;
var currentLogFilter = 'all';
var cachedLogData = { logs: [], networkLogs: [] };
var instancesDataCache = [];
var refreshInterval = null;
var singleRetryEnabled = false;
var parallelRetryEnabled = false;
var currentRequestMode = 'single';

function showToast(msg, type) { 
    var t = document.getElementById('toast'); 
    t.textContent = msg; 
    t.className = 'toast toast-' + type; 
    t.style.display = 'block'; 
    setTimeout(function() { t.style.display = 'none'; }, 3000); 
}

function toggleSidebar() { 
    document.getElementById('sidebar').classList.toggle('open'); 
}

function showTab(tabName) { 
    document.querySelectorAll('.tab-content').forEach(function(t) { t.classList.remove('active'); }); 
    document.querySelectorAll('.nav-item').forEach(function(b) { b.classList.remove('active'); }); 
    document.getElementById('tab-' + tabName).classList.add('active'); 
    document.querySelector('.nav-item[data-tab="' + tabName + '"]').classList.add('active'); 
    if (tabName === 'config') { loadConfig(); loadRoutingStatus(); loadSingleHitConfig(); loadSingleHitRetryConfig(); } 
    if (tabName === 'parallel') { loadTraditionalParallelConfig(); loadParallelRetryConfig(); } 
    if (tabName === 'proxies') loadProxies(); 
    if (tabName === 'hosts') { loadHostIPs(); loadHostStats(); } 
    if (tabName === 'tokens') { loadTokenStatus(); updateTokenStatistics(); loadCipherStatus(); loadCaptchaConfig(); loadCaptchaQueue(); }
}

document.querySelectorAll('.nav-item').forEach(function(item) {
    item.addEventListener('click', function() { var t=this.getAttribute('data-tab'); if(t) showTab(t); });
});

function togglePassword(id) { 
    passwordVisible[id] = !passwordVisible[id]; 
    var cell = document.getElementById('password_cell_' + id); 
    var password = cell.getAttribute('data-password'); 
    cell.innerHTML = passwordVisible[id] ? password : '••••••••'; 
    cell.innerHTML += ' <span class="password-toggle" onclick="event.stopPropagation();togglePassword(' + id + ')">' + (passwordVisible[id] ? '🙈' : '👁️') + '</span>'; 
}

function getStepBadge(step) { 
    var cls = 'step-' + (step || 'ready').toLowerCase().replace(/ /g, '_'); 
    var labels = { 
        'READY': 'Ready', 'STARTING': 'Starting', 'LOGGING_IN': 'Login', 'LOGGED_IN': 'Logged', 
        'WAITING_OTP': 'Waiting OTP', 'OTP_RECEIVED': 'OTP', 'VERIFYING_OTP': 'Verify', 
        'OTP_VERIFIED': 'Verified', 'BOOKING_CONFIG_LOADING': 'Loading Config', 
        'BOOKING_CONFIG_LOADED': 'Config Loaded', 'MONITORING_SLOTS': 'Monitoring', 
        'RESERVING_SLOT': 'Reserve', 'SLOT_RESERVED': 'Reserved', 'INITIATING_PAYMENT': 'Payment', 
        'PAYMENT_READY': 'Pay', 'COMPLETED': 'Done', 'FAILED': 'Failed', 'STOPPED': 'Stopped', 
        'PAUSED': 'Paused', 'RESUMING': 'Resuming' 
    }; 
    return '<span class="step-badge ' + cls + '">' + (labels[step] || step || 'Ready') + '</span>'; 
}

function getStatusBadge(code) { 
    if (code >= 200 && code < 300) return '<span class="status-badge status-' + code + '">✓ ' + code + '</span>'; 
    if (code >= 400) return '<span class="status-badge status-' + code + '">✗ ' + code + '</span>'; 
    return '<span class="status-badge">-</span>'; 
}

function submitManualOTP(instanceId, otp) { 
    if (!otp || otp.length !== 6) return; 
    showToast('Submitting OTP for #' + instanceId + '...', 'info'); 
    fetch('/api/manualOTP', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ instanceId: instanceId, otp: otp }) 
    }).then(function(r) { return r.json(); }).then(function(res) { 
        if (res.status === 'ok') { 
            showToast('✅ OTP submitted for #' + instanceId, 'success'); 
            refresh(); 
        } else { 
            showToast('❌ Failed: ' + res.message, 'error'); 
        } 
    }); 
}

function saveAppointmentID(instanceId) { 
    var inp = document.getElementById('appointment_input_' + instanceId); 
    var appointmentId = inp.value.trim(); 
    fetch('/api/saveAppointmentId', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ instanceId: instanceId, appointmentId: appointmentId }) 
    }).then(function(r) { return r.json(); }).then(function(res) { 
        if (res.status === 'ok') { 
            showToast('Appointment ID saved for #' + instanceId, 'success'); 
            refresh(); 
        } else { 
            showToast('Failed to save', 'error'); 
        } 
    }); 
}

function showLogs(id) { 
    var inst = instancesDataCache.find(function(i) { return i.id === id; }); 
    if (!inst) return; 
    document.getElementById('logIdSpan').innerText = id; 
    document.getElementById('logNameSpan').innerText = inst.clientName || inst.loginPhone || ''; 
    document.getElementById('logModal').style.display = 'flex'; 
    currentLogFilter = 'all'; 
    document.querySelectorAll('.log-filter-btn').forEach(function(b) { b.classList.remove('active'); }); 
    document.querySelector('.log-filter-btn').classList.add('active'); 
    fetchLogs(id); 
}

function closeLogModal() { 
    document.getElementById('logModal').style.display = 'none'; 
}

function fetchLogs(id) { 
    fetch('/api/logs?id=' + id).then(function(r) { return r.json(); }).then(function(d) { 
        cachedLogData = d; 
        renderLogs(); 
        renderNetworkLogs(d.networkLogs || []); 
    }); 
}

function filterLogs(filter, btn) { 
    currentLogFilter = filter; 
    document.querySelectorAll('.log-filter-btn').forEach(function(b) { b.classList.remove('active'); }); 
    if (btn) btn.classList.add('active'); 
    renderLogs(); 
}

function renderLogs() { 
    var logs = cachedLogData.logs || []; 
    var filtered = logs; 
    if (currentLogFilter !== 'all') { 
        filtered = logs.filter(function(l) { 
            var lf = currentLogFilter; 
            if (lf === 'api') return l.includes('📡') || l.includes('HTTP') || l.includes('API') || l.includes('PARALLEL'); 
            if (lf === 'otp') return l.includes('📱') || l.includes('OTP'); 
            if (lf === 'captcha') return l.includes('🔑') || l.includes('captcha') || l.includes('token'); 
            if (lf === 'step') return l.includes('🔄') || l.includes('🚀') || l.includes('✨'); 
            if (lf === 'error') return l.includes('❌') || l.includes('FAILED') || l.includes('Error'); 
            if (lf === 'success') return l.includes('✅') || l.includes('COMPLETED'); 
            if (lf === 'token') return l.includes('token') || l.includes('Token') || l.includes('TOKEN'); 
            if (lf === 'rate') return l.includes('429') || l.includes('Rate limit') || l.includes('rate limited') || l.includes('⏳ Rate'); 
            if (lf === 'proxy') return l.includes('proxy') || l.includes('Proxy') || l.includes('PROXY') || l.includes('🔄 Rotating proxy'); 
            return true; 
        }); 
    } 
    var c = document.getElementById('logContent'); 
    c.innerHTML = ''; 
    filtered.forEach(function(l) { 
        var cls = 'log-line'; 
        if (l.includes('❌') || l.includes('FAILED')) cls += ' log-error'; 
        else if (l.includes('✅') || l.includes('COMPLETED')) cls += ' log-success'; 
        else if (l.includes('📡')) cls += ' log-info'; 
        else if (l.includes('⚠️') || l.includes('429')) cls += ' log-warning'; 
        else if (l.includes('🔄 Rotating proxy')) cls += ' log-warning'; 
        var div = document.createElement('div'); 
        div.className = cls; 
        div.textContent = l; 
        c.appendChild(div); 
    }); 
    c.scrollTop = c.scrollHeight; 
}

function renderNetworkLogs(netLogs) { 
    var c = document.getElementById('networkLogContent'); 
    c.innerHTML = ''; 
    if (!netLogs || netLogs.length === 0) { 
        c.innerHTML = '<div style="color:#64748b;padding:8px;">No network requests</div>'; 
        return; 
    } 
    netLogs.forEach(function(n) { 
        var sc = (n.statusCode >= 200 && n.statusCode < 300) ? 'net-status-ok' : 'net-status-err'; 
        var body = n.respBody || n.statusText || '-'; 
        if (body.length > 80) body = body.substring(0, 80) + '...'; 
        var tokenDisplay = n.tokenUsed || '-'; 
        if (tokenDisplay.length > 12) tokenDisplay = tokenDisplay.substring(0, 12) + '...'; 
        var waitTime = ''; 
        if (n.statusCode === 429) { 
            var waitMatch = body.match(/wait[^0-9]*(\d+)/i) || body.match(/retry[^0-9]*(\d+)/i) || body.match(/(\d+)\s*seconds/i); 
            if (waitMatch) waitTime = ' ⏳ Wait: ' + waitMatch[1] + 's'; 
        } 
        var proxyRotated = n.proxyRotated ? ' 🔄' : ''; 
        c.innerHTML += '<div class="net-log-row"><span class="net-endpoint">' + n.endpoint + '</span><span class="' + sc + '">' + n.statusCode + '</span><span>' + n.method + '</span><span class="net-ip">🌐 ' + (n.clientIp || '-') + '</span><span class="net-proxy">🔒 ' + (n.proxyIp || '-') + proxyRotated + '</span><span class="net-token">🔑 ' + tokenDisplay + '</span><span class="net-dur">' + n.duration + '</span><span class="net-body" title="' + (n.respBody || '').replace(/"/g, '&quot;') + '">' + body + waitTime + '</span></div>'; 
    }); 
}

function copyAllLogs() { 
    if (cachedLogData.logs) { 
        navigator.clipboard.writeText(cachedLogData.logs.join('\n')).then(function() { 
            showToast('Logs copied!', 'success'); 
        }); 
    } 
}

function clearLogs() { 
    var id = document.getElementById('logIdSpan').innerText; 
    if (!id) return; 
    if (!confirm('Clear logs for #' + id + '?')) return; 
    fetch('/api/clearLogs?id=' + id, { method: 'POST' }).then(function(r) { return r.json(); }).then(function(res) { 
        if (res.status === 'cleared') { 
            cachedLogData = { logs: [], networkLogs: [] }; 
            renderLogs(); 
            renderNetworkLogs([]); 
            showToast('Logs cleared!', 'success'); 
            refresh(); 
        } 
    }); 
}

function refresh() { 
    fetch('/api/instances').then(function(r) { return r.json(); }).then(function(data) { 
        document.getElementById('totalCount').innerText = data.total; 
        document.getElementById('runningCount').innerText = data.running; 
        document.getElementById('failedCount').innerText = data.failed; 
        document.getElementById('completedCount').innerText = data.completed; 
        
        var sortedInstances = data.instances.sort(function(a, b) {
            return a.id - b.id;
        });
        
        instancesDataCache = sortedInstances;
        autoFillInvoiceTrxId(sortedInstances);
        var tbody = document.getElementById('tableBody');
        tbody.innerHTML = ''; 
        
        sortedInstances.forEach(function(inst) { 
            var row = tbody.insertRow(); 
            row.className = 'instance-row'; 
            row.id = 'instance-row-' + inst.id;
            
            var cb = document.createElement('input'); 
            cb.type = 'checkbox'; 
            cb.className = 'instance-checkbox'; 
            cb.value = inst.id; 
            cb.checked = selectedInstances.has(inst.id); 
            cb.onchange = (function(id) { 
                return function(e) { 
                    if(e.target.checked) selectedInstances.add(id); 
                    else selectedInstances.delete(id); 
                }; 
            })(inst.id); 
            row.insertCell(0).appendChild(cb); 
            row.insertCell(1).innerHTML = '<b style="color:#38bdf8;">#' + inst.id + '</b>'; 
            row.insertCell(2).innerHTML = '<span class="client-name">' + (inst.clientName || '-') + '</span>'; 
            row.insertCell(3).innerHTML = inst.loginPhone + '<br><small style="color:#64748b;">' + (inst.otpPhone || '') + '</small>'; 
            
            var passwordCell = row.insertCell(4); 
            passwordCell.className = 'password-cell'; 
            passwordCell.id = 'password_cell_' + inst.id; 
            passwordCell.setAttribute('data-password', inst.password || ''); 
            passwordCell.innerHTML = '•••••••• <span class="password-toggle" onclick="event.stopPropagation();togglePassword(' + inst.id + ')">👁️</span>'; 
            
            row.insertCell(5).innerHTML = inst.type || (inst.highCom + ' - ' + inst.visaType); 
            row.insertCell(6).innerHTML = getStepBadge(inst.step); 
            
            if (inst.step === 'WAITING_OTP') { 
                row.insertCell(7).innerHTML = '<div class="manual-otp-container"><input type="text" class="manual-otp-input" id="otp_input_' + inst.id + '" placeholder="OTP" maxlength="6" inputmode="numeric"><span class="waiting-otp-badge">⏳ Waiting</span></div>'; 
                setTimeout(function() { 
                    var inp = document.getElementById('otp_input_' + inst.id); 
                    if (inp) { 
                        inp.focus(); 
                        inp.oninput = function(e) { 
                            var val = e.target.value.replace(/[^0-9]/g, ''); 
                            if (val.length === 6) submitManualOTP(inst.id, val); 
                        }; 
                    } 
                }, 100); 
            } else if (inst.otp) { 
                row.insertCell(7).innerHTML = '<span class="otp-display">' + inst.otp + '</span>'; 
            } else { 
                row.insertCell(7).innerHTML = '-'; 
            } 
            
            row.insertCell(8).innerHTML = '<span class="device-id-badge">' + (inst.deviceId || '-') + '</span>'; 
            row.insertCell(9).innerHTML = '<div class="appointment-container"><input type="text" class="appointment-input" id="appointment_input_' + inst.id + '" placeholder="Appointment ID" value="' + (inst.appointmentId || '') + '"><button class="btn btn-primary btn-sm" onclick="saveAppointmentID(' + inst.id + ')">💾 Save</button></div>'; 
            row.insertCell(10).innerHTML = '<small style="color:#64748b;">' + (inst.reservationId ? inst.reservationId.substring(0, 8) + '...' : '-') + '<br>' + (inst.appointmentDate || '') + '</small>'; 
            row.insertCell(11).innerHTML = '<span class="endpoint-name">' + (inst.endpoint || '-') + '</span>' + (inst.requestId ? '<br><span class="request-id">' + inst.requestId.substring(0, 12) + '...</span>' : ''); 
            row.insertCell(12).innerHTML = inst.statusCode ? getStatusBadge(inst.statusCode) : '-'; 
            row.insertCell(13).innerHTML = inst.clientIp && inst.clientIp != '-' ? '<span class="client-ip">🌐 ' + inst.clientIp + '</span>' : (inst.currentHostIP || '-'); 
            
            var proxyDisplay = '-';
            if (inst.proxyIp && inst.proxyIp != '-') {
                proxyDisplay = '<span class="proxy-ip">🔒 ' + inst.proxyIp + '</span>';
                if (inst.proxyRotated) {
                    proxyDisplay += ' <span class="proxy-rotated-badge">🔄 Rotated</span>';
                }
            } else if (inst.currentProxy && inst.currentProxy != '-') {
                proxyDisplay = '<span class="proxy-ip">🔒 ' + inst.currentProxy + '</span>';
                if (inst.proxyRotated) {
                    proxyDisplay += ' <span class="proxy-rotated-badge">🔄 Rotated</span>';
                }
            }
            row.insertCell(14).innerHTML = proxyDisplay;
            
            if (inst.paymentUrl && (inst.step === 'PAYMENT_READY' || inst.step === 'COMPLETED')) { 
                row.insertCell(15).innerHTML = '<div class="payment-cell"><span class="payment-url">' + inst.paymentUrl.substring(0, 40) + '...</span><div><a href="' + inst.paymentUrl + '" target="_blank" class="btn-pay">💳 Pay</a><button class="btn btn-outline btn-sm" onclick="copyToClipboard(\'' + inst.paymentUrl + '\')">📋 Copy</button><button class="btn btn-success btn-sm" onclick="window.open(\'' + inst.paymentUrl + '\', \'_blank\')">🔗 Open</button></div></div>'; 
            } else { 
                row.insertCell(15).innerHTML = '-'; 
            } 
            
            row.insertCell(16).innerHTML = '<span style="color:#64748b;font-size:11px;">' + (inst.lastLog || '-') + '</span>'; 
            
            var actionHtml = ''; 
            if (inst.status !== 'RUNNING' && inst.step !== 'COMPLETED' && inst.status !== 'PAUSED') 
                actionHtml += '<button class="btn btn-success btn-sm" onclick="startInstance(' + inst.id + ')">▶️</button> '; 
            if (inst.status !== 'RUNNING')
                actionHtml += '<button class="btn btn-primary btn-sm" title="RJ SLOT Full Auto" onclick="fullAutoInstance(' + inst.id + ')" style="font-weight:800;">⚡ Full Auto</button> ';
            if (inst.status === 'RUNNING')
                actionHtml += '<button class="btn btn-danger btn-sm" onclick="stopInstance(' + inst.id + ')">⏹️</button> ';
            if (inst.status === 'PAUSED') 
                actionHtml += '<button class="btn btn-info btn-sm" onclick="resumeInstance(' + inst.id + ')">▶️</button> '; 
            actionHtml += '<button class="btn btn-outline btn-sm" onclick="showLogs(' + inst.id + ')">📋</button> <button class="btn btn-outline btn-sm" onclick="openEditModal(' + JSON.stringify(inst).replace(/'/g, "\\'") + ')">✏️</button> <button class="btn btn-outline btn-sm" onclick="deleteInstance(' + inst.id + ')">🗑️</button>'; 
            row.insertCell(17).innerHTML = actionHtml; 
        }); 
        
        if (data.slotMonitorEnabled !== undefined) { 
            var sw = document.getElementById('slotMonitorSwitch'); 
            if (sw) { 
                sw.checked = data.slotMonitorEnabled; 
                var statusSpan = document.getElementById('slotMonitorStatus'); 
                statusSpan.innerText = data.slotMonitorEnabled ? 'ON' : 'OFF'; 
                statusSpan.className = 'slot-value ' + (data.slotMonitorEnabled ? 'on' : 'off'); 
            } 
        } 
    }); 
}

function startInstance(id) {
    fetch('/api/start?id=' + id, { method: 'POST' }).then(function() {
        showToast('Started #' + id, 'success');
        refresh();
    });
}

function loadManualIds(){
    fetch('/api/manualIds').then(function(r){return r.json();}).then(function(d){
        var s=document.getElementById('manualSlotId'), g=document.getElementById('manualDgepayId'), h=document.getElementById('manualIdsHint');
        if(s && document.activeElement!==s) s.value = d.overrideSlotId || d.detectedSlotId || '';
        if(g && document.activeElement!==g) g.value = d.overrideDgepayId || d.detectedDgepayId || '';
        if(h){ var parts=[]; if(d.detectedSlotId) parts.push('slot ✓'); if(d.detectedDgepayId) parts.push('dg-epay ✓'); h.textContent = parts.length? ('detected: '+parts.join(' ')) : ''; }
    }).catch(function(){});
}
function saveManualIds(){
    var s=document.getElementById('manualSlotId').value.trim(), g=document.getElementById('manualDgepayId').value.trim();
    fetch('/api/manualIds',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({overrideSlotId:s,overrideDgepayId:g})}).then(function(r){return r.json();}).then(function(){ showToast('Slot/dg-epay ID saved'+(s||g?' (manual override)':' (cleared — auto)'),'success'); });
}

function changeAdminPassword(){
    var op=prompt('Current (old) admin password din:');
    if(op===null) return;
    var np=prompt('New admin password (kompokkhe 6 chars, hard rakhun):');
    if(np===null) return;
    np=np.trim();
    if(np.length<6){ alert('Password kompokkhe 6 characters hote hobe'); return; }
    var c=prompt('Confirm notun password:');
    if(c===null) return;
    if(c.trim()!==np){ alert('Password match holo na'); return; }
    fetch('/api/portal/users',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({Username:'admin',OldPassword:op,Password:np})})
      .then(function(r){return r.json();}).then(function(d){
        if(d.ok){ showToast('🔑 Admin password change holo — porer login e notun password lagbe','success'); }
        else { alert(d.error||'Failed'); }
      }).catch(function(){ alert('Password change failed'); });
}

function cleanCache(){
    if(!confirm('Clean cache?\n\nEta clear korbe:\n• Resume sessions (stop→start)\n• Pre-solved captcha queues\n• dg-epay scan cache\n\nCholti kono run e effect korbe na — porer run fresh scan/token debe.')) return;
    fetch('/api/cleanCache',{method:'POST'}).then(function(r){return r.json();}).then(function(res){
        showToast('🧹 Cache cleared: '+(res.cleared||[]).join(', '),'success');
    }).catch(function(){ showToast('Clean cache failed','error'); });
}

function fullAutoAll() {
    var list = (instancesDataCache || []).filter(function(i){ return i.status !== 'RUNNING'; });
    if (!list.length) { showToast('No idle instances to run', 'warning'); return; }
    if (!confirm('Run RJ SLOT Full Auto for ALL ' + list.length + ' instance(s)?')) return;
    var n = 0;
    list.forEach(function(inst, idx) {
        setTimeout(function() {
            fetch('/api/fullAuto?id=' + inst.id, { method: 'POST' }).then(function(r){ return r.json(); }).then(function(){ n++; });
        }, idx * 800); // stagger 0.8s so signin/scan don't all fire at once
    });
    showToast('⚡ Full Auto started for ' + list.length + ' instance(s)', 'success');
    setTimeout(refresh, 1500);
}

function fullAutoInstance(id) {
    if (!confirm('Run RJ SLOT Full Auto for instance #' + id + '?\n(scan → signin → OTP → verify → upload → book → reserve → initiate)')) return;
    fetch('/api/fullAuto?id=' + id, { method: 'POST' }).then(function(r){ return r.json(); }).then(function(d) {
        showToast('⚡ Full Auto #' + id + ' — ' + (d.files||0) + ' file(s), mission ' + (d.mission||'?'), 'success');
        refresh();
    }).catch(function(){ showToast('Full Auto failed to start', 'error'); });
}

function stopInstance(id) { 
    fetch('/api/stop?id=' + id, { method: 'POST' }).then(function() { 
        showToast('Stopped #' + id, 'success'); 
        refresh(); 
    }); 
}

function resumeInstance(id) { 
    fetch('/api/start?id=' + id, { method: 'POST' }).then(function() { 
        showToast('Resumed #' + id, 'success'); 
        refresh(); 
    }); 
}

function deleteInstance(id) { 
    if (confirm('Delete #' + id + '?')) { 
        fetch('/api/delete?id=' + id, { method: 'DELETE' }).then(function() { 
            selectedInstances.delete(id); 
            refresh(); 
            showToast('Deleted #' + id, 'success'); 
        }); 
    } 
}

function addInstance() { 
    var data = { 
        clientName: document.getElementById('clientName').value, 
        loginPhone: document.getElementById('loginPhone').value, 
        password: document.getElementById('password').value, 
        otpPhone: document.getElementById('otpPhone').value, 
        highCom: document.getElementById('highCom').value, 
        visaType: document.getElementById('visaType').value 
    }; 
    if (!data.loginPhone || !data.password || !data.otpPhone) { 
        showToast('Fill required fields!', 'error'); 
        return; 
    } 
    fetch('/api/add', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(data) 
    }).then(function(r) { return r.json(); }).then(function(res) { 
        showToast('Added #' + res.id, 'success'); 
        document.getElementById('clientName').value = ''; 
        document.getElementById('loginPhone').value = ''; 
        document.getElementById('password').value = ''; 
        document.getElementById('otpPhone').value = ''; 
        refresh(); 
    }); 
}

function toggleSelectAll() { 
    var isChecked = document.getElementById('selectAllCheckbox').checked; 
    document.querySelectorAll('.instance-checkbox').forEach(function(cb) { 
        cb.checked = isChecked; 
        if(isChecked) selectedInstances.add(parseInt(cb.value)); 
        else selectedInstances.delete(parseInt(cb.value)); 
    }); 
}

function bulkAction(action) { 
    if(selectedInstances.size === 0) { 
        showToast('No instances selected!', 'error'); 
        return; 
    } 
    var ids = Array.from(selectedInstances); 
    fetch('/api/selectedInstances', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ instanceIds: ids, action: action }) 
    }).then(function() { 
        showToast(action + ' completed for ' + ids.length + ' instances', 'success'); 
        refresh(); 
    }); 
}

function toggleAll() { 
    var action = allRunning ? 'stop' : 'start'; 
    fetch('/api/toggleAll', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ action: action }) 
    }).then(function() { 
        allRunning = !allRunning; 
        document.getElementById('toggleAllBtn').innerHTML = allRunning ? '⏹️ Stop All' : '▶️ Start All'; 
        showToast(allRunning ? 'All started' : 'All stopped', 'success'); 
        refresh(); 
    }); 
}

function togglePause() { 
    var action = allPaused ? 'resume' : 'pause'; 
    fetch('/api/toggleAll', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ action: action }) 
    }).then(function() { 
        allPaused = !allPaused; 
        document.getElementById('pauseAllBtn').innerHTML = allPaused ? '▶️ Resume All' : '⏸️ Pause All'; 
        showToast(allPaused ? 'All paused' : 'All resumed', 'success'); 
        refresh(); 
    }); 
}

function loadConfig() { 
    fetch('/api/config').then(function(r) { return r.json(); }).then(function(c) { 
        document.getElementById('otpRetryDelay').value = c.otpRetryDelay || 5000; 
        document.getElementById('autoOtp').value = String(c.autoOtp !== false); 
        document.getElementById('loginMode').value = c.loginMode || 'auto'; 
        document.getElementById('slotCheckInterval').value = c.slotCheckInterval || 15; 
        document.getElementById('routingMode').value = c.routingMode || 'direct'; 
        document.getElementById('tokenExpiry').value = c.tokenExpiry || 80; 
    }); 
}

function saveConfig() { 
    var config = { 
        otpRetryDelay: parseInt(document.getElementById('otpRetryDelay').value), 
        autoOtp: document.getElementById('autoOtp').value === 'true', 
        loginMode: document.getElementById('loginMode').value, 
        slotCheckInterval: parseInt(document.getElementById('slotCheckInterval').value), 
        routingMode: document.getElementById('routingMode').value, 
        tokenExpiry: parseInt(document.getElementById('tokenExpiry').value) || 80 
    }; 
    fetch('/api/config', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(config) 
    }).then(function() { showToast('Config saved!', 'success'); }); 
}

function checkSlotStatus() {
    showToast('Checking slot status...', 'info');
    fetch('/api/slotStatus')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.success) {
                var statusText = data.status ? '✅ OPEN' : '🔒 CLOSED';
                var statusClass = data.status ? 'success' : 'info';
                showToast('Slot status: ' + statusText, statusClass);
            } else {
                showToast('Error: ' + (data.error || 'Unknown'), 'error');
            }
        })
        .catch(function(err) {
            showToast('Failed to check slot: ' + err.message, 'error');
        });
}

function loadSingleHitConfig() {
    if(!document.getElementById('singleHitDelay')) return; // panel removed (retry moved to top bar)
    fetch('/api/singleHitConfig')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            document.getElementById('singleHitDelay').value = data.delayMs || 1000;
            updateSingleHitStatusDisplay();
        })
        .catch(function(err) {
            console.error('Failed to load single hit config:', err);
        });
}

function saveSingleHitConfig() {
    if(!document.getElementById('singleHitDelay')) return;
    var config = {
        enabled: true,
        delayMs: parseInt(document.getElementById('singleHitDelay').value) || 1000
    };
    
    fetch('/api/singleHitConfig', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
        if (res.status === 'saved') {
            showToast('✅ Single Hit config saved!', 'success');
            updateSingleHitStatusDisplay();
        } else {
            showToast('❌ Failed to save: ' + (res.message || 'Unknown error'), 'error');
        }
    })
    .catch(function(err) {
        showToast('❌ Error saving: ' + err.message, 'error');
    });
}

function updateSingleHitStatusDisplay() {
    if(!document.getElementById('singleHitDelay')) return;
    var delay = parseInt(document.getElementById('singleHitDelay').value) || 1000;
    var delayText = delay + 'ms' + (delay > 0 ? ' (' + (delay/1000).toFixed(1) + 's)' : ' (No delay)');
    document.getElementById('singleHitStatusDisplay').innerHTML = 
        '<span style="color:#2dd4bf;">✅ Always Enabled</span> | Delay: <strong style="color:#e2e8f0;">' + delayText + '</strong>';
}

function loadSingleHitRetryConfig() {
    if(!document.getElementById('singleRetrySigninHits')) return; // panel removed
    fetch('/api/singleHitRetryConfig')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            document.getElementById('singleRetrySigninEnabled').checked = true;
            document.getElementById('singleRetrySigninHits').value = data.signin?.hits || 2;
            document.getElementById('singleRetrySigninDelay').value = data.signin?.delayMs || 100;
            
            document.getElementById('singleRetryVerifyEnabled').checked = true;
            document.getElementById('singleRetryVerifyHits').value = data.verify?.hits || 2;
            document.getElementById('singleRetryVerifyDelay').value = data.verify?.delayMs || 100;
            
            document.getElementById('singleRetryReserveEnabled').checked = true;
            document.getElementById('singleRetryReserveHits').value = data.reserve?.hits || 2;
            document.getElementById('singleRetryReserveDelay').value = data.reserve?.delayMs || 100;
            
            document.getElementById('singleRetryBookingEnabled').checked = true;
            document.getElementById('singleRetryBookingHits').value = data.booking?.hits || 2;
            document.getElementById('singleRetryBookingDelay').value = data.booking?.delayMs || 100;
            
            document.getElementById('singleRetryPaymentEnabled').checked = true;
            document.getElementById('singleRetryPaymentHits').value = data.payment?.hits || 2;
            document.getElementById('singleRetryPaymentDelay').value = data.payment?.delayMs || 100;
        })
        .catch(function(err) {
            console.error('Failed to load single hit retry config:', err);
        });
}

function saveSingleHitRetryConfig() {
    if(!document.getElementById('singleRetrySigninHits')) return;
    var config = {
        signin: {
            enabled: document.getElementById('singleRetrySigninEnabled').checked,
            hits: parseInt(document.getElementById('singleRetrySigninHits').value) || 2,
            delayMs: parseInt(document.getElementById('singleRetrySigninDelay').value) || 100,
            reuseCaptcha: true
        },
        verify: {
            enabled: document.getElementById('singleRetryVerifyEnabled').checked,
            hits: parseInt(document.getElementById('singleRetryVerifyHits').value) || 2,
            delayMs: parseInt(document.getElementById('singleRetryVerifyDelay').value) || 100,
            reuseCaptcha: false
        },
        reserve: {
            enabled: document.getElementById('singleRetryReserveEnabled').checked,
            hits: parseInt(document.getElementById('singleRetryReserveHits').value) || 2,
            delayMs: parseInt(document.getElementById('singleRetryReserveDelay').value) || 100,
            reuseCaptcha: true
        },
        booking: {
            enabled: document.getElementById('singleRetryBookingEnabled').checked,
            hits: parseInt(document.getElementById('singleRetryBookingHits').value) || 2,
            delayMs: parseInt(document.getElementById('singleRetryBookingDelay').value) || 100,
            reuseCaptcha: false
        },
        payment: {
            enabled: document.getElementById('singleRetryPaymentEnabled').checked,
            hits: parseInt(document.getElementById('singleRetryPaymentHits').value) || 2,
            delayMs: parseInt(document.getElementById('singleRetryPaymentDelay').value) || 100,
            reuseCaptcha: false
        }
    };
    
    fetch('/api/singleHitRetryConfig', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
        if (res.status === 'saved') {
            showToast('✅ Single Hit Retry config saved!', 'success');
        } else {
            showToast('❌ Failed to save: ' + (res.message || 'Unknown error'), 'error');
        }
    })
    .catch(function(err) {
        showToast('❌ Error saving: ' + err.message, 'error');
    });
}

function toggleSingleRetryMode(enabled) {
    singleRetryEnabled = enabled;
    var statusText = enabled ? 'enabled' : 'disabled';
    showToast('Single Retry ' + statusText.toUpperCase(), enabled ? 'success' : 'info');
    
    fetch('/api/singleRetryMode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabled })
    }).catch(function(err) { console.error('Failed to save single retry mode:', err); });
}

function loadSingleRetryMode() {
    if(!document.getElementById('singleRetryToggle')) return; // toggle removed (retry on top bar)
    fetch('/api/singleRetryMode').then(function(r) { return r.json(); }).then(function(data) {
        singleRetryEnabled = data.enabled || false;
        document.getElementById('singleRetryToggle').checked = singleRetryEnabled;
    }).catch(function(err) { console.error('Failed to load single retry mode:', err); });
}

function toggleRequestMode(mode) {
    currentRequestMode = mode;
    var singleBtn = document.getElementById('singleModeBtn');
    var parallelBtn = document.getElementById('parallelModeBtn');
    
    if (mode === 'single') {
        singleBtn.className = 'mode-btn active';
        parallelBtn.className = 'mode-btn inactive';
        showToast('📌 Single Hit Mode Activated', 'info');
    } else {
        singleBtn.className = 'mode-btn inactive';
        parallelBtn.className = 'mode-btn active';
        showToast('⚡ Parallel Mode Activated', 'info');
    }
    
    fetch('/api/requestMode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: mode })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
        if (res.status === 'saved') {
            console.log('Request mode saved:', res.mode);
        }
    })
    .catch(function(err) { console.error('Failed to save mode:', err); });
}

function loadRequestMode() {
    fetch('/api/requestMode').then(function(r) { return r.json(); }).then(function(data) {
        if (data.mode === 'parallel') {
            currentRequestMode = 'parallel';
            document.getElementById('singleModeBtn').className = 'mode-btn inactive';
            document.getElementById('parallelModeBtn').className = 'mode-btn active';
        } else {
            currentRequestMode = 'single';
            document.getElementById('singleModeBtn').className = 'mode-btn active';
            document.getElementById('parallelModeBtn').className = 'mode-btn inactive';
        }
    }).catch(function(err) { console.error('Failed to load mode:', err); });
}

function toggleParallelRetryMode(enabled) {
    parallelRetryEnabled = enabled;
    var statusText = enabled ? 'enabled' : 'disabled';
    showToast('Parallel Retry ' + statusText.toUpperCase(), enabled ? 'success' : 'info');
    
    fetch('/api/parallelRetryMode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabled })
    }).catch(function(err) { console.error('Failed to save parallel retry mode:', err); });
}

function loadParallelRetryMode() {
    fetch('/api/parallelRetryMode').then(function(r) { return r.json(); }).then(function(data) {
        parallelRetryEnabled = data.enabled || false;
        document.getElementById('parallelRetryToggle').checked = parallelRetryEnabled;
    }).catch(function(err) { console.error('Failed to load parallel retry mode:', err); });
}

function loadTraditionalParallelConfig() { 
    fetch('/api/parallelConfig').then(function(r) { return r.json(); }).then(function(d) { 
        var c = d.traditional || {}; 
        document.getElementById('parallelSigninHits').value = c.signinHits || 15; 
        document.getElementById('parallelSigninMs').value = c.signinMs || 300; 
        document.getElementById('parallelVerifyHits').value = c.verifyHits || 25; 
        document.getElementById('parallelVerifyMs').value = c.verifyMs || 500; 
        document.getElementById('parallelReserveHits').value = c.reserveHits || 10; 
        document.getElementById('parallelReserveMs').value = c.reserveMs || 1000; 
        document.getElementById('parallelBookingHits').value = c.bookingHits || 10; 
        document.getElementById('parallelBookingMs').value = c.bookingMs || 500; 
        document.getElementById('parallelInitiateHits').value = c.initiateHits || 2; 
        document.getElementById('parallelInitiateMs').value = c.initiateMs || 100; 
    }); 
}

function saveTraditionalParallelConfig() { 
    var traditional = { 
        signinHits: parseInt(document.getElementById('parallelSigninHits').value) || 15, 
        signinMs: parseInt(document.getElementById('parallelSigninMs').value) || 300, 
        verifyHits: parseInt(document.getElementById('parallelVerifyHits').value) || 25, 
        verifyMs: parseInt(document.getElementById('parallelVerifyMs').value) || 500, 
        reserveHits: parseInt(document.getElementById('parallelReserveHits').value) || 10, 
        reserveMs: parseInt(document.getElementById('parallelReserveMs').value) || 1000, 
        bookingHits: parseInt(document.getElementById('parallelBookingHits').value) || 10, 
        bookingMs: parseInt(document.getElementById('parallelBookingMs').value) || 500, 
        initiateHits: parseInt(document.getElementById('parallelInitiateHits').value) || 2, 
        initiateMs: parseInt(document.getElementById('parallelInitiateMs').value) || 100 
    }; 
    fetch('/api/parallelConfig', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ traditional: traditional }) 
    }).then(function() { showToast('Traditional parallel config saved!', 'success'); }); 
}

function loadParallelRetryConfig() { 
    fetch('/api/parallelConfig').then(function(r) { return r.json(); }).then(function(d) { 
        var pr = d.parallelRetry || {}; 
        document.getElementById('parallelRetrySigninEnabled').checked = true;
        document.getElementById('parallelRetrySigninHits').value = (pr.signin?.hits || [3,2,5,4]).join(','); 
        document.getElementById('parallelRetrySigninDelay').value = pr.signin?.delayMs || 100; 
        
        document.getElementById('parallelRetryVerifyEnabled').checked = true;
        document.getElementById('parallelRetryVerifyHits').value = (pr.verify?.hits || [3,2,5,4]).join(','); 
        document.getElementById('parallelRetryVerifyDelay').value = pr.verify?.delayMs || 100; 
        
        document.getElementById('parallelRetryReserveEnabled').checked = true;
        document.getElementById('parallelRetryReserveHits').value = (pr.reserve?.hits || [3,2,5,4]).join(','); 
        document.getElementById('parallelRetryReserveDelay').value = pr.reserve?.delayMs || 100; 
        
        document.getElementById('parallelRetryBookingEnabled').checked = true;
        document.getElementById('parallelRetryBookingHits').value = (pr.booking?.hits || [3,2,5,4]).join(','); 
        document.getElementById('parallelRetryBookingDelay').value = pr.booking?.delayMs || 100; 
        
        document.getElementById('parallelRetryPaymentEnabled').checked = true;
        document.getElementById('parallelRetryPaymentHits').value = (pr.payment?.hits || [3,2,5,4]).join(','); 
        document.getElementById('parallelRetryPaymentDelay').value = pr.payment?.delayMs || 100; 
    }); 
}

function parseHits(str) { 
    return str.split(',').map(Number).filter(function(n) { return !isNaN(n) && n > 0; }); 
}

function saveParallelRetryConfig() { 
    var pr = { 
        signin: { 
            enabled: document.getElementById('parallelRetrySigninEnabled').checked, 
            hits: parseHits(document.getElementById('parallelRetrySigninHits').value), 
            delayMs: parseInt(document.getElementById('parallelRetrySigninDelay').value) || 100,
            reuseCaptcha: true
        }, 
        verify: { 
            enabled: document.getElementById('parallelRetryVerifyEnabled').checked, 
            hits: parseHits(document.getElementById('parallelRetryVerifyHits').value), 
            delayMs: parseInt(document.getElementById('parallelRetryVerifyDelay').value) || 100,
            reuseCaptcha: false
        }, 
        reserve: { 
            enabled: document.getElementById('parallelRetryReserveEnabled').checked, 
            hits: parseHits(document.getElementById('parallelRetryReserveHits').value), 
            delayMs: parseInt(document.getElementById('parallelRetryReserveDelay').value) || 100,
            reuseCaptcha: true
        }, 
        booking: { 
            enabled: document.getElementById('parallelRetryBookingEnabled').checked, 
            hits: parseHits(document.getElementById('parallelRetryBookingHits').value), 
            delayMs: parseInt(document.getElementById('parallelRetryBookingDelay').value) || 100,
            reuseCaptcha: false
        }, 
        payment: { 
            enabled: document.getElementById('parallelRetryPaymentEnabled').checked, 
            hits: parseHits(document.getElementById('parallelRetryPaymentHits').value), 
            delayMs: parseInt(document.getElementById('parallelRetryPaymentDelay').value) || 100,
            reuseCaptcha: false
        } 
    }; 
    if (pr.signin.hits.length === 0) pr.signin.hits = [3,2,5,4]; 
    if (pr.verify.hits.length === 0) pr.verify.hits = [3,2,5,4]; 
    if (pr.reserve.hits.length === 0) pr.reserve.hits = [3,2,5,4]; 
    if (pr.booking.hits.length === 0) pr.booking.hits = [3,2,5,4]; 
    if (pr.payment.hits.length === 0) pr.payment.hits = [3,2,5,4]; 
    fetch('/api/parallelConfig', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ parallelRetry: pr }) 
    }).then(function() { showToast('Parallel retry config saved!', 'success'); }); 
}

function testParallel() { 
    showToast('Testing traditional parallel...', 'info'); 
    fetch('/api/testParallel').then(function(r) { return r.json(); }).then(function(d) { 
        if(d.success) showToast('Parallel test completed!', 'success'); 
        else showToast('Test failed', 'error'); 
    }); 
}

function testParallelRetry() { 
    showToast('Testing parallel retry...', 'info'); 
    fetch('/api/testParallelRetry').then(function(r) { return r.json(); }).then(function(d) { 
        showToast('Parallel retry config loaded', 'success'); 
    }); 
}

function toggleSlotMonitor(en) { 
    fetch('/api/slotMonitor', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ enabled: en }) 
    }).then(function() { 
        showToast('Slot Monitor ' + (en ? 'ON' : 'OFF'), 'success'); 
        refresh(); 
    }); 
}

function loadProxies() { 
    fetch('/api/proxies').then(function(r) { return r.json(); }).then(function(d) { 
        document.getElementById('proxyTotalCount').innerText = d.count || 0; 
        document.getElementById('proxyEnabledCount').innerText = d.enabled || 0; 
        var html = '<div class="table-container"><table class="config-table"><thead>\
<th>Status</th><th>Enabled</th><th>Type</th><th>Host:Port</th><th>Auth</th><th>Response</th><th>Last Test</th><th>🔄 Rotations</th><th>Actions</th>\
</thead><tbody>'; 
        (d.proxies || []).forEach(function(p) { 
            var rotationDisplay = p.rotationCount || 0;
            var rotationBadge = rotationDisplay > 0 ? '<span class="proxy-rotated-badge">' + rotationDisplay + 'x</span>' : '-';
            html += '<tr><td>' + (p.testPass ? '<span class="proxy-status-ok">✓ Working</span>' : '<span class="proxy-status-fail">✗ Failed</span>') + 
                '</td><td>' + (p.enabled ? '<span class="proxy-enabled">Enabled</span>' : '<span class="proxy-disabled">Disabled</span>') + 
                '</td><td>' + p.type.toUpperCase() + '</td><td style="color:#e2e8f0;">' + p.host + ':' + p.port + '</td><td style="color:#94a3b8;">' + (p.user ? p.user : '-') + 
                '</td><td style="color:#94a3b8;">' + (p.responseMs ? p.responseMs + 'ms' : '-') + '</td><td style="color:#64748b;">' + (p.lastTest ? new Date(p.lastTest).toLocaleTimeString() : '-') + 
                '</td><td>' + rotationBadge + 
                '</td><td><button class="btn btn-outline btn-sm" onclick="editProxy(\'' + p.id + '\')">✏️</button> <button class="btn btn-danger btn-sm" onclick="deleteProxy(\'' + p.id + '\')">🗑️</button></td></tr>'; 
        }); 
        html += '</tbody></table></div>'; 
        document.getElementById('proxyTableContainer').innerHTML = html; 
    }); 
}

function openAddProxyModal() { 
    document.getElementById('proxyModalTitle').innerText = 'Add Proxy'; 
    document.getElementById('proxyEditId').value = ''; 
    document.getElementById('proxyType').value = 'auto'; 
    document.getElementById('proxyHost').value = ''; 
    document.getElementById('proxyPort').value = ''; 
    document.getElementById('proxyUser').value = ''; 
    document.getElementById('proxyPassword').value = ''; 
    document.getElementById('proxyEnabled').checked = true; 
    document.getElementById('proxyModal').style.display = 'flex'; 
}

function editProxy(id) { 
    fetch('/api/proxies').then(function(r) { return r.json(); }).then(function(d) { 
        var proxy = d.proxies.find(function(p) { return p.id === id; }); 
        if (proxy) { 
            document.getElementById('proxyModalTitle').innerText = 'Edit Proxy'; 
            document.getElementById('proxyEditId').value = proxy.id; 
            document.getElementById('proxyType').value = proxy.type; 
            document.getElementById('proxyHost').value = proxy.host; 
            document.getElementById('proxyPort').value = proxy.port; 
            document.getElementById('proxyUser').value = proxy.user || ''; 
            document.getElementById('proxyPassword').value = proxy.password || ''; 
            document.getElementById('proxyEnabled').checked = proxy.enabled; 
            document.getElementById('proxyModal').style.display = 'flex'; 
        } 
    }); 
}

function closeProxyModal() { 
    document.getElementById('proxyModal').style.display = 'none'; 
}

function saveProxy() { 
    var id = document.getElementById('proxyEditId').value; 
    var proxy = { 
        id: id, 
        type: document.getElementById('proxyType').value, 
        host: document.getElementById('proxyHost').value, 
        port: parseInt(document.getElementById('proxyPort').value), 
        user: document.getElementById('proxyUser').value, 
        password: document.getElementById('proxyPassword').value, 
        enabled: document.getElementById('proxyEnabled').checked 
    }; 
    if (!proxy.host || !proxy.port) { showToast('Host and Port are required!', 'error'); return; } 
    var action = id ? 'update' : 'add'; 
    fetch('/api/proxies', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ action: action, proxy: proxy }) 
    }).then(function(r) { return r.json(); }).then(function(res) { 
        if (res.status === 'added' || res.status === 'updated') { 
            showToast('Proxy ' + res.status + '!', 'success'); 
            closeProxyModal(); 
            loadProxies(); 
        } 
    }); 
}

function deleteProxy(id) { 
    if (confirm('Delete this proxy?')) { 
        fetch('/api/proxies', { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ action: 'delete', proxy: { id: id } }) 
        }).then(function() { 
            showToast('Proxy deleted!', 'success'); 
            loadProxies(); 
        }); 
    } 
}

function testAllProxies() {
    showToast('Testing all proxies...', 'info');
    fetch('/api/proxies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'testAll' })
    }).then(function() {
        setTimeout(function() {
            loadProxies();
            showToast('Proxy testing completed!', 'success');
        }, 5000);
    });
}
function bulkAddProxies() {
    var text = document.getElementById('proxyBulkText').value;
    if (!text.trim()) { showToast('Paste some proxies first', 'error'); return; }
    showToast('Bulk adding...', 'info');
    fetch('/api/proxies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulkAdd', text: text })
    }).then(function(r){return r.json();}).then(function(res){
        showToast('Bulk: +' + res.added + ' added, ' + res.skipped + ' dup, ' + res.invalid + ' invalid', res.added>0?'success':'info');
        if (res.added>0) document.getElementById('proxyBulkText').value='';
        loadProxies();
    }).catch(function(err){ showToast('Bulk add error: ' + err.message, 'error'); });
}

function loadHostIPs() { 
    fetch('/api/hostIPs').then(function(r) { return r.json(); }).then(function(d) { 
        document.getElementById('hostIPsText').value = (d.hostIPs || []).join('\n'); 
    }); 
}

function saveHostIPs() { 
    var rawText = document.getElementById('hostIPsText').value; 
    fetch('/api/hostIPs', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ rawText: rawText }) 
    }).then(function() { 
        showToast('Host IPs saved!', 'success'); 
        loadHostIPs(); 
    }); 
}

function loadHostStats() { 
    fetch('/api/hostStats').then(function(r) { return r.json(); }).then(function(d) { 
        var html = '<div class="table-container"><table class="host-stats-table"><thead><tr><th>IP Address</th><th>Success</th><th>Failed</th><th>Rate</th><th>Last Used</th><th>Health</th></tr></thead><tbody>'; 
        d.stats.forEach(function(s) { 
            var healthClass = s.isHealthy ? 'host-healthy' : 'host-unhealthy'; 
            html += '<tr><td><b style="color:#e2e8f0;">' + s.ip + '</b></td><td style="color:#2dd4bf;">' + s.successCount + '</td><td style="color:#f87171;">' + s.failedCount + '</td><td style="color:#e2e8f0;">' + (s.successRate * 100).toFixed(1) + '%</td><td style="color:#64748b;">' + new Date(s.lastUsed).toLocaleTimeString() + '</td><td class="' + healthClass + '">' + (s.isHealthy ? '✓ Healthy' : '✗ Unhealthy') + '</td></tr>'; 
        }); 
        html += '</tbody></table></div>'; 
        document.getElementById('hostStats').innerHTML = html; 
        if (d.bestHost && d.bestHost !== '-') showToast('Best host: ' + d.bestHost, 'info'); 
    }); 
}

function applyHostIP() { 
    fetch('/api/hostStats').then(function(r) { return r.json(); }).then(function(d) { 
        if (d.bestHost && d.bestHost !== '-') { 
            fetch('/api/applyHost', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ ip: d.bestHost }) 
            }).then(function(r) { return r.json(); }).then(function(res) { 
                if (res.status === 'ok') showToast('Best host applied!', 'success'); 
                else showToast('Error: ' + res.message, 'error'); 
            }); 
        } else { 
            showToast('No best host available', 'error'); 
        } 
    }); 
}

function removeHostEntry() { 
    fetch('/api/applyHost', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ ip: '' }) 
    }).then(function(r) { return r.json(); }).then(function(res) { 
        if (res.status === 'ok') showToast('Host entry removed!', 'success'); 
        else showToast('Error: ' + res.message, 'error'); 
    }); 
}

function resetBestHost() { 
    fetch('/api/resetHost', { method: 'POST' }).then(function() { 
        showToast('Best host reset!', 'success'); 
        loadHostStats(); 
    }); 
}

function openEditModal(inst) { 
    document.getElementById('editId').value = inst.id; 
    document.getElementById('editClientName').value = inst.clientName || ''; 
    document.getElementById('editLoginPhone').value = inst.loginPhone; 
    document.getElementById('editPassword').value = inst.password || ''; 
    document.getElementById('editOtpPhone').value = inst.otpPhone; 
    document.getElementById('editHighCom').value = inst.highCom || 'DHAKA'; 
    document.getElementById('editVisaType').value = inst.visaType || 'MEDICAL'; 
    document.getElementById('editModal').style.display = 'flex'; 
}

function saveEdit() { 
    var data = { 
        id: parseInt(document.getElementById('editId').value), 
        clientName: document.getElementById('editClientName').value, 
        loginPhone: document.getElementById('editLoginPhone').value, 
        password: document.getElementById('editPassword').value, 
        otpPhone: document.getElementById('editOtpPhone').value, 
        highCom: document.getElementById('editHighCom').value, 
        visaType: document.getElementById('editVisaType').value 
    }; 
    fetch('/api/update', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(data) 
    }).then(function(r) { return r.json(); }).then(function(res) { 
        if (res.status === 'updated') { 
            showToast('Instance #' + data.id + ' updated!', 'success'); 
            closeEditModal(); 
            refresh(); 
        } 
    }); 
}

function closeEditModal() { 
    document.getElementById('editModal').style.display = 'none'; 
}

function loadTokenStatus() {
    var instanceId = document.getElementById('clearInstanceId').value;
    var url = '/api/tokenStatus';
    if (instanceId) {
        url += '?instanceId=' + instanceId;
    }
    
    fetch(url).then(function(r) { return r.json(); }).then(function(data) {
        var container = document.getElementById('tokenStatusContainer');
        var html = '<div class="table-container"><table class="config-table"><thead>';
        
        if (data.instanceId) {
            html += '<tr><th>Instance</th><th>Token</th><th>Type</th><th>Status</th><th>Source</th><th>Created</th><th>Expires</th><th>Expires In</th><th>Use Count</th></tr></thead><tbody>';
            html += '<tr><td colspan="9" style="background:rgba(13,21,37,0.4);font-weight:600;color:#38bdf8;">Instance #' + data.instanceId + ' - Login: ' + data.loginTokens + ' | Reserve: ' + data.reserveTokens + ' | Total: ' + data.totalTokens + '</td></tr>';
            
            if (data.tokens && data.tokens.length > 0) {
                data.tokens.forEach(function(t) {
                    var statusClass = 'token-pending';
                    if (t.status === 'valid') statusClass = 'token-valid';
                    else if (t.status === 'used') statusClass = 'token-used';
                    else if (t.status === 'invalid') statusClass = 'token-invalid';
                    else if (t.status === 'expired') statusClass = 'token-expired';
                    
                    var sourceColor = 'rgba(19,27,46,0.4)';
                    if (t.source === 'database') sourceColor = 'rgba(45,212,191,0.08)';
                    else if (t.source === 'cached') sourceColor = 'rgba(56,189,248,0.08)';
                    else if (t.source === 'new') sourceColor = 'rgba(251,191,36,0.08)';
                    
                    html += '<tr><td style="color:#38bdf8;">#' + data.instanceId + '</td><td><span class="token-badge ' + statusClass + '">' + t.token + '</span></td><td><b style="color:#e2e8f0;">' + t.type + '</b></td><td><span class="token-badge ' + statusClass + '">' + t.status + '</span></td><td><span class="token-source-badge" style="background:' + sourceColor + ';">' + (t.source || 'unknown') + '</span></td><td style="color:#94a3b8;">' + new Date(t.createdAt).toLocaleTimeString() + '</td><td style="color:#94a3b8;">' + new Date(t.expiresAt).toLocaleTimeString() + '</td><td style="color:#e2e8f0;">' + t.expiresIn + '</td><td style="color:#94a3b8;">' + t.useCount + '</td></tr>';
                });
            } else {
                html += '<tr><td colspan="9" style="text-align:center;color:#64748b;">No tokens found for this instance</td></tr>';
            }
        } else {
            html += '<tr><th>Total</th><th>Login</th><th>Reserve</th><th>Used</th><th>Invalid</th><th>Expired</th><th>Instances</th></tr></thead><tbody>';
            html += '<tr><td><b style="color:#e2e8f0;">' + data.totalTokens + '</b></td><td style="color:#38bdf8;">' + data.loginTokens + '</td><td style="color:#818cf8;">' + data.reserveTokens + '</td><td style="color:#fbbf24;">' + data.usedTokens + '</td><td style="color:#f87171;">' + data.invalidTokens + '</td><td style="color:#64748b;">' + data.expiredTokens + '</td><td style="color:#e2e8f0;">' + data.instanceCount + '</td></tr>';
        }
        
        html += '</tbody></table></div>';
        container.innerHTML = html;
        updateTokenStatistics();
        showToast('Token status loaded!', 'success');
    }).catch(function(err) {
        showToast('Failed to load token status: ' + err.message, 'error');
    });
}

function loadInstanceTokenStatus() {
    var instanceId = document.getElementById('clearInstanceId').value;
    if (!instanceId) {
        showToast('Please enter an Instance ID', 'error');
        return;
    }
    loadTokenStatus();
}

function clearInstanceTokens() {
    var instanceId = document.getElementById('clearInstanceId').value;
    if (!instanceId) {
        showToast('Please enter an Instance ID', 'error');
        return;
    }
    
    if (!confirm('Clear tokens for instance #' + instanceId + '?')) return;
    
    fetch('/api/clearTokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId: parseInt(instanceId) })
    }).then(function(r) { return r.json(); }).then(function(res) {
        if (res.status === 'ok') {
            showToast(res.message, 'success');
            loadTokenStatus();
            refresh();
        } else {
            showToast('Failed: ' + res.message, 'error');
        }
    });
}

function clearAllTokens() {
    if (!confirm('Clear ALL tokens for all instances?')) return;
    
    fetch('/api/clearTokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId: 0 })
    }).then(function(r) { return r.json(); }).then(function(res) {
        if (res.status === 'ok') {
            showToast(res.message, 'success');
            loadTokenStatus();
            refresh();
        } else {
            showToast('Failed: ' + res.message, 'error');
        }
    });
}

function updateTokenStatistics() {
    fetch('/api/tokenStatus').then(function(r) { return r.json(); }).then(function(data) {
        document.getElementById('totalTokenCount').innerText = data.totalTokens || 0;
        var validCount = (data.totalTokens || 0) - (data.usedTokens || 0) - (data.invalidTokens || 0) - (data.expiredTokens || 0);
        document.getElementById('validTokenCount').innerText = validCount > 0 ? validCount : 0;
        document.getElementById('invalidTokenCount').innerText = data.invalidTokens || 0;
        document.getElementById('usedTokenCount').innerText = data.usedTokens || 0;
    }).catch(function(err) {
        console.error('Failed to update token statistics:', err);
    });
}

function validateAllInstanceTokens() {
    showToast('Validating all instance tokens...', 'info');
    var instances = instancesDataCache || [];
    var validated = 0;
    var invalid = 0;
    
    instances.forEach(function(inst) {
        if (inst.tokenUsed) {
            fetch('/api/tokenValidation?instanceId=' + inst.id + '&token=' + encodeURIComponent(inst.tokenUsed))
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    validated++;
                    if (!data.isValid || !data.belongsToInstance) {
                        invalid++;
                    }
                    if (validated + invalid === instances.filter(function(i) { return i.tokenUsed; }).length) {
                        showToast('Validation complete! ' + (validated - invalid) + ' valid, ' + invalid + ' invalid', invalid > 0 ? 'warning' : 'success');
                    }
                })
                .catch(function() {
                    invalid++;
                });
        }
    });
    
    if (instances.filter(function(i) { return i.tokenUsed; }).length === 0) {
        showToast('No tokens to validate', 'info');
    }
}

function loadRoutingStatus() {
    fetch('/api/routingStatus')
        .then(function(r) { return r.json(); })
        .then(function(data) {
            var select = document.getElementById('routingMode');
            select.value = data.currentMode || 'direct';
            
            document.getElementById('routePathDisplay').innerText = data.modeInfo?.description || 'Instance → Direct API';
            
            var resources = [];
            if (data.hasProxy) resources.push('🌐 Proxy (' + data.proxyCount + ')');
            if (data.hasHost) resources.push('🖥️ Host (' + data.hostCount + ')');
            if (resources.length === 0) resources.push('⚡ None (Direct Mode)');
            document.getElementById('availableResources').innerText = resources.join(' | ');
            
            var proxyBadge = document.getElementById('proxyStatusBadge');
            if (data.hasProxy) {
                proxyBadge.className = 'resource-badge available';
                proxyBadge.innerText = '✅ Proxy Available (' + data.proxyCount + ')';
            } else {
                proxyBadge.className = 'resource-badge unavailable';
                proxyBadge.innerText = '❌ No Proxy Available';
            }
            
            var hostBadge = document.getElementById('hostStatusBadge');
            if (data.hasHost) {
                hostBadge.className = 'resource-badge available';
                hostBadge.innerText = '✅ Host Available (' + data.hostCount + ')';
            } else {
                hostBadge.className = 'resource-badge unavailable';
                hostBadge.innerText = '❌ No Host Available';
            }
            
            var modeInfo = data.modeInfo || {};
            showToast('📌 Mode: ' + (modeInfo.displayName || 'DIRECT') + ' | ' + (modeInfo.description || ''), 'info');
        })
        .catch(function(err) {
            console.error('Failed to load routing status:', err);
        });
}

function saveRoutingMode() {
    var mode = document.getElementById('routingMode').value;
    
    fetch('/api/routingMode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: mode })
    })
    .then(function(r) { return r.json(); })
    .then(function(res) {
        if (res.status === 'saved') {
            showToast('✅ Routing mode saved: ' + res.displayName, 'success');
            loadRoutingStatus();
            refresh();
        } else {
            showToast('❌ Failed to save: ' + (res.message || 'Unknown error'), 'error');
        }
    })
    .catch(function(err) {
        showToast('❌ Error saving routing mode: ' + err.message, 'error');
    });
}

function refreshRoutingStatus() {
    loadRoutingStatus();
    showToast('🔄 Routing status refreshed', 'info');
}

function copyToClipboard(text) { 
    navigator.clipboard.writeText(text).then(function() { showToast('Copied!', 'success'); }); 
}

function connectWebSocket() { 
    ws = new WebSocket('ws://' + location.host + '/ws'); 
    ws.onopen = function() { console.log('WebSocket connected'); }; 
    ws.onmessage = function(e) { 
        try { 
            var d = JSON.parse(e.data); 
            if (d.type === 'payment_url') showToast('💰 Payment URL for #' + d.instanceId, 'success'); 
            if (d.type === 'slot_status') showToast('📅 Slot ' + (d.available ? 'OPEN!' : 'CLOSED'), d.available ? 'success' : 'info'); 
            refresh(); 
        } catch(e) {} 
    }; 
    ws.onclose = function() { setTimeout(connectWebSocket, 5000); }; 
}

function startAutoRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
    refreshInterval = setInterval(function() {
        refresh();
        loadManualIds();
    }, 5000);
    console.log('🔄 Auto-refresh started (5s interval)');
}

connectWebSocket();
loadManualIds();
loadRequestMode();
loadSingleRetryMode();
loadParallelRetryMode();
refresh();
startAutoRefresh();
loadRoutingStatus();
loadSingleHitConfig();
loadSingleHitRetryConfig();
loadTraditionalParallelConfig();
loadParallelRetryConfig();
updateTokenStatistics();

setInterval(function() { 
    var m = document.getElementById('logModal'); 
    if (m && m.style.display === 'flex') { 
        var id = document.getElementById('logIdSpan').innerText; 
        if (id) fetchLogs(id); 
    } 
}, 30000);

setInterval(function() {
    updateTokenStatistics();
}, 10000);

// ===== Cipher panel =====
function loadCipherStatus(){ fetch('/api/cipherStatus').then(function(r){return r.json();}).then(renderCipher).catch(function(){}); }
function renderCipher(d){
    var b=document.getElementById('cipherStatusBadge'); if(!b) return;
    if(!d.userOn){ b.textContent='RAW (by choice)'; b.className='enabled-by-default-badge'; }
    else if(d.loaded){ b.textContent='ENCRYPTED ('+d.source+')'; b.className='always-enabled-badge'; }
    else { b.textContent='ENCRYPTED (no cipher loaded)'; b.className='enabled-by-default-badge'; }
    var ce=document.getElementById('cipherEnabled'); if(ce) ce.checked=d.userOn;
    var cp=document.getElementById('cipherPaths'); if(cp) cp.textContent=(d.paths||[]).join('  ,  ');
    var cs=document.getElementById('cipherScript'); if(cs) cs.value=d.script||'';
}
function reloadCipher(){ showToast('Reloading cipher...','info'); fetch('/api/cipherReload',{method:'POST'}).then(function(r){return r.json();}).then(function(d){renderCipher(d);showToast('Cipher: '+d.source,'success');}); }
function toggleCipher(en){ fetch('/api/cipherToggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:en})}).then(function(r){return r.json();}).then(renderCipher); }
function saveCipher(){ var s=document.getElementById('cipherScript').value; fetch('/api/cipherSave',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({script:s})}).then(function(r){return r.json();}).then(function(d){ if(d.error){showToast('Parse error: '+d.error,'error');} else {renderCipher(d);showToast('Cipher saved & active','success');} }); }
function clearCipher(){ if(!confirm('Clear cipher? Tokens will be sent RAW until reloaded.')) return; fetch('/api/cipherClear',{method:'POST'}).then(function(r){return r.json();}).then(function(d){ renderCipher(d); showToast('Cipher cleared (encryption OFF)','info'); }); }

// ===== Captcha panel =====
var captchaCfgCache = {keys:{}};
function loadCaptchaConfig(){ fetch('/api/captchaConfig').then(function(r){return r.json();}).then(function(c){ captchaCfgCache=c; var p=document.getElementById('captchaProvider'); if(p) p.value=c.provider||'rumon'; var qs=document.getElementById('captchaQueueSize'); if(qs) qs.value=c.queueSize||3; var k=document.getElementById('captchaKey'); if(k) k.value=(c.keys&&c.keys[c.provider])||''; var ru=document.getElementById('captchaRelayUrl'); if(ru) ru.value=c.relayUrl||'http://127.0.0.1:8787'; }).catch(function(){}); }
function onCaptchaProviderChange(){ var prov=document.getElementById('captchaProvider').value; var k=document.getElementById('captchaKey'); if(k) k.value=(captchaCfgCache.keys&&captchaCfgCache.keys[prov])||''; }
function saveCaptchaConfig(){ var prov=document.getElementById('captchaProvider').value; var key=document.getElementById('captchaKey').value; var size=parseInt(document.getElementById('captchaQueueSize').value)||3; var ruEl=document.getElementById('captchaRelayUrl'); var relayUrl=ruEl?ruEl.value:''; var keys={}; keys[prov]=key; fetch('/api/captchaConfig',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:prov,keys:keys,queueSize:size,relayUrl:relayUrl})}).then(function(r){return r.json();}).then(function(c){ captchaCfgCache=c; showToast('Captcha config saved ('+prov+')','success'); loadCaptchaQueue(); }); }
function testCaptcha(){ showToast('Testing solve...','info'); fetch('/api/captchaTest?purpose=Signin').then(function(r){return r.json();}).then(function(d){ if(d.ok){ showToast('Solve OK ('+d.provider+'), token len '+(d.rawToken?d.rawToken.length:0),'success'); } else { showToast('Solve FAIL: '+d.error,'error'); } }); }
function loadCaptchaQueue(){ fetch('/api/captchaQueue').then(function(r){return r.json();}).then(function(q){ var info=document.getElementById('captchaQueueInfo'); if(info) info.textContent='Ready — Signin: '+q.signin+' | Reserve: '+q.reserve+'  (provider: '+q.provider+')'; var b=document.getElementById('captchaQueueBadge'); if(b) b.textContent='signin '+q.signin+' | reserve '+q.reserve; }).catch(function(){}); }
setInterval(loadCaptchaQueue, 3000);
loadCipherStatus(); loadCaptchaConfig(); loadCaptchaQueue();
// ===== C_token / E_token quick provider+mode toggles (top bar) =====
function setTokenMode(which){
    var c=document.getElementById('cTokenSwitch'), e=document.getElementById('eTokenSwitch');
    if(which==='capsolver'){ if(c) c.checked=true; if(e) e.checked=false; }
    else { if(e) e.checked=true; if(c) c.checked=false; }
    var provider=(which==='capsolver')?'capsolver':'relay';
    var encOn=(which==='capsolver');
    fetch('/api/captchaConfig',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:provider})}).then(function(r){return r.json();}).then(function(cfg){
        if(typeof captchaCfgCache!=='undefined') captchaCfgCache=cfg;
        var dd=document.getElementById('captchaProvider'); if(dd){ dd.value=provider; if(typeof onCaptchaProviderChange==='function') onCaptchaProviderChange(); }
        if(typeof loadCaptchaQueue==='function') loadCaptchaQueue();
    });
    fetch('/api/cipherToggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:encOn})}).then(function(r){return r.json();}).then(function(d){
        if(typeof renderCipher==='function') renderCipher(d);
        // C_token ON: if no cipher script is loaded yet, auto Reload from path (load + active)
        if(which==='capsolver' && !d.loaded){
            fetch('/api/cipherReload',{method:'POST'}).then(function(r){return r.json();}).then(function(d2){
                if(typeof renderCipher==='function') renderCipher(d2);
                showToast(d2.loaded?('Cipher auto-loaded from path ('+d2.source+')'):'⚠ Cipher path not reachable — start cipher-server',d2.loaded?'success':'error');
            });
        }
    });
    showToast(which==='capsolver'?'C_token: CapSolver + Encryption ON':'R_token: Token Relay (local farm)','success');
}
function syncTokenModeToggles(){
    fetch('/api/captchaConfig').then(function(r){return r.json();}).then(function(c){
        var prov=c.provider||'relay';
        var cs=document.getElementById('cTokenSwitch'), es=document.getElementById('eTokenSwitch');
        if(cs) cs.checked=(prov==='capsolver');
        if(es) es.checked=(prov==='relay');
    }).catch(function(){});
}
syncTokenModeToggles();

// ===== Flow retry control (Single / per-step delay / Auto) =====
var flowState = { flowSingle:true, flowAuto:true };
function renderFlow(){
    var s=document.getElementById('flowSingleBtn'), a=document.getElementById('flowAutoBtn');
    if(s){ s.className='mode-btn '+(flowState.flowSingle?'active':'inactive'); }
    if(a){ a.className='mode-btn '+(flowState.flowAuto?'active':'inactive'); }
}
function loadFlowControl(){
    fetch('/api/flowControl').then(function(r){return r.json();}).then(function(d){
        flowState.flowSingle=!!d.flowSingle; flowState.flowAuto=!!d.flowAuto;
        var sd=d.stepDelaySec||{};
        var map={signin:'flowDelaySignin',verify:'flowDelayVerify',reserve:'flowDelayReserve',book:'flowDelayBook',initiate:'flowDelayInitiate'};
        Object.keys(map).forEach(function(k){ var el=document.getElementById(map[k]); if(el && sd[k]!=null) el.value=sd[k]; });
        var ad=document.getElementById('flowAutoDelay'); if(ad && d.autoDelaySec!=null) ad.value=d.autoDelaySec;
        renderFlow();
    }).catch(function(){});
}
function toggleFlow(which){
    if(which==='single') flowState.flowSingle=!flowState.flowSingle;
    else flowState.flowAuto=!flowState.flowAuto;
    renderFlow();
    fetch('/api/flowControl',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({flowSingle:flowState.flowSingle,flowAuto:flowState.flowAuto})})
        .then(function(r){return r.json();}).then(function(){ showToast('Flow: Single '+(flowState.flowSingle?'ON':'OFF')+' • Auto '+(flowState.flowAuto?'ON':'OFF'),'success'); }).catch(function(){});
}
function saveFlowDelays(){
    var sd={
        signin:  parseInt(document.getElementById('flowDelaySignin').value)||0,
        verify:  parseInt(document.getElementById('flowDelayVerify').value)||0,
        reserve: parseInt(document.getElementById('flowDelayReserve').value)||0,
        book:    parseInt(document.getElementById('flowDelayBook').value)||0,
        initiate:parseInt(document.getElementById('flowDelayInitiate').value)||0
    };
    var autoD=parseInt(document.getElementById('flowAutoDelay').value)||0;
    fetch('/api/flowControl',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stepDelaySec:sd,autoDelaySec:autoD})})
        .then(function(r){return r.json();}).then(function(){ showToast('Step delays saved','success'); }).catch(function(){});
}
loadFlowControl();

// ===== Invoice download (RJ SLOT parity) =====
var invoiceTrxLastInstance = null;   // which instance's RID we auto-filled
var invoiceActive = false;           // polling loop running?
function autoFillInvoiceTrxId(list){
    var box = document.getElementById('invoiceTrxId'); if(!box) return;
    if(invoiceActive) return;                 // don't fight the user mid-download
    if(box.value && box.value.trim()) return; // user/auto already set; don't overwrite
    if(!list) return;
    // pick the most recent instance that has a reservationId
    var found = null;
    list.forEach(function(inst){ if(inst.reservationId){ found = inst; } });
    if(found){ box.value = found.reservationId; invoiceTrxLastInstance = found.id; }
}
function setInvoiceStatus(msg, color){
    var el = document.getElementById('invoiceStatusLine'); if(!el) return;
    el.textContent = msg || ''; el.style.color = color || '#94a3b8';
}
function toggleInvoiceDownload(){
    var btn = document.getElementById('invoiceSubmitBtn');
    if(invoiceActive){ invoiceActive = false; if(btn){ btn.textContent='📥 Submit'; btn.className='btn btn-primary'; } setInvoiceStatus('⏹ Stopped','#fbbf24'); return; }
    var trx = (document.getElementById('invoiceTrxId').value||'').trim();
    if(!trx){ setInvoiceStatus('❌ Enter / reserve a Tran ID first','#fca5a5'); return; }
    invoiceActive = true;
    if(btn){ btn.textContent='■ STOP'; btn.className='btn btn-danger'; }
    setInvoiceStatus('🧾 Invoice loading… auto-retry until ready','#34d399');
    (function loop(attempt){
        if(!invoiceActive) return;
        var inst = invoiceTrxLastInstance!=null ? ('&instanceId='+invoiceTrxLastInstance) : '';
        fetch('/api/invoice?trxId='+encodeURIComponent(trx)+inst).then(function(r){
            var ct = r.headers.get('content-type')||'';
            if(ct.indexOf('application/pdf')>=0){
                return r.blob().then(function(b){
                    invoiceActive=false; if(btn){ btn.textContent='📥 Submit'; btn.className='btn btn-primary'; }
                    var u=URL.createObjectURL(b); var a=document.createElement('a'); a.href=u; a.download='invoice-'+trx+'.pdf';
                    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(u);
                    setInvoiceStatus('✅ Invoice downloaded!','#34d399');
                });
            }
            return r.json().then(function(j){
                if(!invoiceActive) return;
                setInvoiceStatus('⏳ Not ready ('+(j.status||'?')+(j.msg?' • '+j.msg.slice(0,40):'')+') • attempt '+attempt,'#fbbf24');
                setTimeout(function(){ loop(attempt+1); }, 2000);
            });
        }).catch(function(e){
            if(!invoiceActive) return;
            setInvoiceStatus('⚠ '+e.message+' • retrying • attempt '+attempt,'#fca5a5');
            setTimeout(function(){ loop(attempt+1); }, 2000);
        });
    })(1);
}

</script>
</body>
</html>`
}

// ==================== MAIN FUNCTION ====================

func main() {
	rand.Seed(time.Now().UnixNano())

	GetTokenManager()

	loadConfig()
	loadInstances()
	loadProxies()
	GetHostRouter()

	configMu.RLock()
	if globalConfig.SlotMonitor.Enabled {
		startSlotMonitor()
	}
	configMu.RUnlock()

	RegisterUserPortal()
	http.HandleFunc("/", serveDashboard)
	http.HandleFunc("/ws", adminOnly(websocketHandler))
	http.HandleFunc("/api/instances", adminOnly(getInstances))
	http.HandleFunc("/api/start", adminOnly(startInstanceHandler))
	http.HandleFunc("/api/stop", adminOnly(stopInstanceHandler))
	http.HandleFunc("/api/delete", adminOnly(deleteInstanceHandler))
	http.HandleFunc("/api/add", adminOnly(addInstanceHandler))
	http.HandleFunc("/api/update", adminOnly(updateInstanceHandler))
	http.HandleFunc("/api/toggleAll", adminOnly(toggleAllHandler))
	http.HandleFunc("/api/config", adminOnly(handleConfig))
	http.HandleFunc("/api/flowControl", adminOnly(handleFlowControl))
	http.HandleFunc("/api/invoice", adminOnly(handleInvoiceDownload))
	http.HandleFunc("/api/parallelConfig", adminOnly(handleParallelConfig))
	http.HandleFunc("/api/singleHitConfig", adminOnly(handleSingleHitConfig))
	http.HandleFunc("/api/singleHitRetryConfig", adminOnly(handleSingleHitRetryConfig))
	http.HandleFunc("/api/singleRetryMode", adminOnly(handleSingleRetryMode))
	http.HandleFunc("/api/slotMonitor", adminOnly(handleSlotMonitor))
	http.HandleFunc("/api/slotStatus", adminOnly(handleSlotStatus))
	http.HandleFunc("/api/slotStatusDetailed", adminOnly(handleSlotStatusDetailed))
	http.HandleFunc("/api/logs", adminOnly(handleGetLogs))
	http.HandleFunc("/api/clearLogs", adminOnly(handleClearLogs))
	http.HandleFunc("/api/proxies", adminOnly(handleProxies))
	http.HandleFunc("/api/hostIPs", adminOnly(handleHostIPs))
	http.HandleFunc("/api/applyHost", adminOnly(handleApplyHost))
	http.HandleFunc("/api/hostStats", adminOnly(handleHostStats))
	http.HandleFunc("/api/resetHost", adminOnly(handleResetHost))
	http.HandleFunc("/api/requestMode", adminOnly(handleRequestMode))
	http.HandleFunc("/api/parallelRetryMode", adminOnly(handleParallelRetryMode))
	http.HandleFunc("/api/testParallel", adminOnly(testParallelHandler))
	http.HandleFunc("/api/testParallelRetry", adminOnly(testParallelRetryHandler))
	http.HandleFunc("/api/selectedInstances", adminOnly(handleSelectedInstances))
	http.HandleFunc("/api/manualOTP", adminOnly(handleManualOTP))
	http.HandleFunc("/api/saveAppointmentId", adminOnly(handleSaveAppointmentID))
	http.HandleFunc("/api/routingMode", adminOnly(handleRoutingMode))
	http.HandleFunc("/api/routingStatus", adminOnly(handleRoutingStatus))
	http.HandleFunc("/api/tokenStatus", adminOnly(handleTokenStatus))
	http.HandleFunc("/api/clearTokens", adminOnly(handleClearInstanceTokens))
	http.HandleFunc("/api/tokenValidation", adminOnly(handleTokenValidation))
	http.HandleFunc("/api/fullAuto", adminOnly(handleFullAuto))
	http.HandleFunc("/api/manualIds", adminOnly(handleManualIDs))
	http.HandleFunc("/api/cleanCache", adminOnly(handleCleanCache))

	fmt.Println("")
	fmt.Println("╔══════════════════════════════════════════════════════════════════════════════════════╗")
	fmt.Println("║                    IVAC PAYMENT BOT - TOKEN MANAGEMENT SYSTEM                        ║")
	fmt.Println("╠══════════════════════════════════════════════════════════════════════════════════════╣")
	fmt.Println("║  🔐 LOGIN CAPTCHA: Per-instance token management                                    ║")
	fmt.Println("║  🔐 RESERVE CAPTCHA: Per-instance token management                                   ║")
	fmt.Println("║  ⏱️  TOKEN EXPIRY: 1 minute 20 seconds (80 seconds)                                ║")
	fmt.Println("║  🔄 TOKEN REUSE: Tokens reused until invalid or expired                             ║")
	fmt.Println("║  ❌ TOKEN INVALIDATION: 400/429/503 → INVALID → Fresh Token                        ║")
	fmt.Println("║  🔄 FRESH TOKEN: Auto-fetch new token on 400/429/503 errors                         ║")
	fmt.Println("║  ✅ USED TOKENS: 200 OK → Mark as used                                             ║")
	fmt.Println("║  🗑️  TOKEN CLEANUP: Automatic cleanup of expired/invalid/used tokens                ║")
	fmt.Println("║  🔄 SINGLE MODE: 1st request sent, retries with delay, cancel on success           ║")
	fmt.Println("║  ⚡ PARALLEL MODE: Multiple requests at once, first success wins                    ║")
	fmt.Println("║  🔍 ENHANCED SLOT MONITOR: With caching, retry support                              ║")
	fmt.Println("║  💳 dg-epay PAYMENT GATEWAY INTEGRATION                                             ║")
	fmt.Println("║  🌍 PROXY MANAGEMENT: Multi-proxy support                                            ║")
	fmt.Println("║  🖥️ HOST IP ROUTING: Route requests to specific backend server IPs                  ║")
	fmt.Println("║  📝 MANUAL OTP: Type 6-digit OTP → Auto-submit!                                     ║")
	fmt.Println("║  🔑 TOKEN VALIDATION: Request token vs Database token validation                     ║")
	fmt.Println("║  📊 TOKEN STATUS: Real-time token status in dashboard                               ║")
	fmt.Println("║  🔄 SINGLE RETRY: Global toggle for single hit retry                                ║")
	fmt.Println("║  🔄 PARALLEL RETRY: Global toggle for parallel retry                                ║")
	fmt.Println("║  🔑 SIGNIN/RESERVE: Always reuse captcha tokens                                     ║")
	fmt.Println("║  📱 VERIFY/BOOKING/PAYMENT: No captcha tokens needed                                ║")
	fmt.Println("║  ⏳ 429 SMART WAIT: Extracts wait time from response body or uses endpoint defaults  ║")
	fmt.Println("║  🔄 PROXY AUTO-ROTATION: Auto-rotates on 400, 429, 503, 504, 520, 530 errors       ║")
	fmt.Println("║  📌 SINGLE RETRY: If retry enabled, sends additional requests with delay            ║")
	fmt.Println("║  📌 SUCCESS HANDLING: Any success cancels all pending requests                      ║")
	fmt.Println("║  📌 RETRY UNTIL SUCCESS: Continues retrying until success or context cancelled      ║")
	fmt.Println("╠══════════════════════════════════════════════════════════════════════════════════════╣")
	fmt.Println("║  🌐 Dashboard: http://localhost:8080                                                  ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════════════════════════════╝")
	fmt.Println("")
	fmt.Println("📌 Opening dashboard in your browser...")
	fmt.Println("")

	// ===== integrated modules: cipher + captcha queue =====
	InitCipher()
	RegisterCipherRoutes()
	go StartCipherWatcher(5)
	captchaMgr.loadConfig()
	loadManualIDs()
	RegisterCaptchaRoutes()
	go StartCaptchaQueue()

	exec.Command("cmd", "/C", "start", "http://localhost:8080").Run()
	http.ListenAndServe(":8080", nil)
}