package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/dop251/goja"
)

// The cipher.js script is loaded LIVE from your path (cipher-server). No file
// is embedded — when your extractor outputs a new cipher.js, the watcher
// auto-detects and activates it. Go only calls encryptToken(rawToken, purpose).
//
// DUAL MODE: the user picks Encrypted or Raw from the dashboard. That choice is
// PERSISTED (cipher_mode.json) and the watcher/auto-load NEVER overrides it.

const cipherModeFile = "cipher_mode.json"

// Same path RJ SLOT uses to auto-load the cipher.
var cipherServerURLs = []string{
	"http://localhost:8799/cipher",
	"http://127.0.0.1:8799/cipher",
}

type cipherManager struct {
	mu     sync.Mutex
	vm     *goja.Runtime
	encFn  goja.Callable
	userOn bool   // user master switch (persisted): true=Encrypted, false=Raw
	source string // "path" | "manual" | "off"
	script string // currently-loaded cipher source (shown in dashboard)
}

var cipherMgr = &cipherManager{source: "off", userOn: true}

// ---- persisted user choice ----
func (cm *cipherManager) saveMode() {
	b, _ := json.Marshal(map[string]bool{"userOn": cm.userOn})
	os.WriteFile(cipherModeFile, b, 0644)
}
func (cm *cipherManager) loadMode() {
	b, err := os.ReadFile(cipherModeFile)
	if err != nil {
		return
	}
	var m map[string]bool
	if json.Unmarshal(b, &m) == nil {
		if v, ok := m["userOn"]; ok {
			cm.userOn = v
		}
	}
}

// CipherActive reports whether encryption will actually be applied right now.
func CipherActive() bool {
	cipherMgr.mu.Lock()
	defer cipherMgr.mu.Unlock()
	return cipherMgr.userOn && cipherMgr.encFn != nil
}

// InitCipher loads the persisted mode, then loads the cipher from your path.
func InitCipher() {
	cipherMgr.mu.Lock()
	cipherMgr.loadMode()
	on := cipherMgr.userOn
	cipherMgr.mu.Unlock()
	fmt.Printf("🔧 [Cipher] Mode = %s (your saved choice)\n", map[bool]string{true: "ENCRYPTED", false: "RAW"}[on])

	if js := fetchCipherFromPath(); js != "" {
		if err := cipherMgr.load(js); err == nil {
			cipherMgr.mu.Lock()
			cipherMgr.source = "path"
			cipherMgr.mu.Unlock()
			fmt.Printf("🔑 [Cipher] Loaded from path (encryption %s)\n", map[bool]string{true: "ON", false: "OFF-by-choice"}[on])
			return
		}
		fmt.Println("⚠️ [Cipher] Path script parse error — tokens RAW until fixed")
		return
	}
	fmt.Println("⏳ [Cipher] No cipher on path yet — watcher will auto-load it when available")
}

func fetchCipherFromPath() string {
	client := &http.Client{Timeout: 6 * time.Second}
	for _, u := range cipherServerURLs {
		resp, err := client.Get(u)
		if err != nil {
			continue
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 && len(b) > 0 {
			return string(b)
		}
	}
	return ""
}

// load compiles a cipher script. It sets encFn/script but NEVER changes the
// user's Encrypted/Raw choice.
func (cm *cipherManager) load(script string) error {
	vm := goja.New()
	if _, err := vm.RunString(script); err != nil {
		return err
	}
	fn, ok := goja.AssertFunction(vm.Get("encryptToken"))
	if !ok {
		return fmt.Errorf("encryptToken not found in cipher script")
	}
	cm.mu.Lock()
	cm.vm = vm
	cm.encFn = fn
	cm.script = script
	cm.mu.Unlock()
	return nil
}

// EncryptToken encrypts a captcha token for "Signin" or "Reserve".
// Returns the RAW token if the user chose Raw mode, no cipher is loaded, or on error.
func (cm *cipherManager) EncryptToken(token, purpose string) string {
	if token == "" {
		return token
	}
	cm.mu.Lock()
	defer cm.mu.Unlock()
	if !cm.userOn || cm.encFn == nil {
		return token // Raw mode (by choice) or no cipher loaded
	}
	res, err := cm.encFn(goja.Undefined(), cm.vm.ToValue(token), cm.vm.ToValue(purpose))
	if err != nil {
		return token
	}
	if out := res.String(); out != "" {
		return out
	}
	return token
}

// applyCipher is the single wiring point used when building request bodies.
func applyCipher(endpointName, token string) string {
	switch endpointName {
	case "Login API":
		return cipherMgr.EncryptToken(token, "Signin")
	case "Reserve Slot API":
		return cipherMgr.EncryptToken(token, "Reserve")
	default:
		return token
	}
}

// CipherStatus reports the active state (for the smoke check).
func CipherStatus() (enabled bool, source string) {
	cipherMgr.mu.Lock()
	defer cipherMgr.mu.Unlock()
	return cipherMgr.userOn && cipherMgr.encFn != nil, cipherMgr.source
}

// ==================== DASHBOARD API ====================

func cipherStatusJSON(w http.ResponseWriter) {
	cipherMgr.mu.Lock()
	active := cipherMgr.userOn && cipherMgr.encFn != nil
	resp := map[string]interface{}{
		"enabled": active,                                                    // encryption actually applied?
		"userOn":  cipherMgr.userOn,                                          // your dual-mode choice
		"mode":    map[bool]string{true: "encrypted", false: "raw"}[cipherMgr.userOn],
		"loaded":  cipherMgr.encFn != nil,                                    // is a cipher script present?
		"source":  cipherMgr.source,
		"script":  cipherMgr.script,
		"paths":   cipherServerURLs,
	}
	cipherMgr.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func handleCipherStatus(w http.ResponseWriter, r *http.Request) { cipherStatusJSON(w) }

func handleCipherReload(w http.ResponseWriter, r *http.Request) {
	InitCipher()
	cipherStatusJSON(w)
}

// handleCipherToggle is the DUAL selector: enabled=true -> Encrypted, false -> Raw.
// The choice is persisted and survives restart + watcher reloads.
func handleCipherToggle(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled bool `json:"enabled"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	cipherMgr.mu.Lock()
	cipherMgr.userOn = req.Enabled
	cipherMgr.saveMode()
	cipherMgr.mu.Unlock()
	cipherStatusJSON(w)
}

func handleCipherSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Script string `json:"script"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if err := cipherMgr.load(req.Script); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	cipherMgr.mu.Lock()
	cipherMgr.source = "manual"
	cipherMgr.mu.Unlock()
	cipherStatusJSON(w)
}

// handleCipherClear removes the loaded cipher script (does NOT change your
// Encrypted/Raw choice). Tokens go RAW until a cipher is loaded again.
func handleCipherClear(w http.ResponseWriter, r *http.Request) {
	cipherMgr.mu.Lock()
	cipherMgr.encFn = nil
	cipherMgr.vm = nil
	cipherMgr.script = ""
	cipherMgr.source = "off"
	cipherMgr.mu.Unlock()
	cipherStatusJSON(w)
}

// StartCipherWatcher auto-detects a new cipher on the path and loads it — but it
// NEVER changes your Encrypted/Raw choice.
func StartCipherWatcher(intervalSec int) {
	if intervalSec <= 0 {
		intervalSec = 5
	}
	ticker := time.NewTicker(time.Duration(intervalSec) * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		js := fetchCipherFromPath()
		if js == "" {
			continue
		}
		cipherMgr.mu.Lock()
		same := js == cipherMgr.script
		cipherMgr.mu.Unlock()
		if same {
			continue
		}
		if err := cipherMgr.load(js); err == nil {
			cipherMgr.mu.Lock()
			cipherMgr.source = "path"
			cipherMgr.mu.Unlock()
			fmt.Println("🔁 [Cipher] New cipher detected on path — loaded (mode unchanged)")
		}
	}
}

// RegisterCipherRoutes wires the cipher dashboard endpoints. Call once in main().
func RegisterCipherRoutes() {
	http.HandleFunc("/api/cipherStatus", handleCipherStatus)
	http.HandleFunc("/api/cipherReload", handleCipherReload)
	http.HandleFunc("/api/cipherToggle", handleCipherToggle)
	http.HandleFunc("/api/cipherSave", handleCipherSave)
	http.HandleFunc("/api/cipherClear", handleCipherClear)
}
