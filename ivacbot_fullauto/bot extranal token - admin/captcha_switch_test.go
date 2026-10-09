package main

import (
	"path/filepath"
	"testing"
	"time"
)

// Tokens older than the 3-minute lifetime are declared expired and removed by prune;
// fresh ones are kept. This is the backend "auto-remove expired" the dashboard reflects.
func TestTokenLifetime3MinPrune(t *testing.T) {
	m := &captchaManager{ttl: 3 * time.Minute}
	now := time.Now()
	in := []readyTok{
		{raw: "fresh", at: now.Add(-1 * time.Minute)},    // 1 min old → keep
		{raw: "expired", at: now.Add(-4 * time.Minute)},   // 4 min old → remove
		{raw: "edge-ok", at: now.Add(-2 * time.Minute)},   // 2 min old → keep
	}
	out := m.prune(in)
	if len(out) != 2 {
		t.Fatalf("prune should keep 2 fresh tokens, got %d", len(out))
	}
	for _, tk := range out {
		if tk.raw == "expired" {
			t.Fatal("expired (4-min-old) token must be removed")
		}
	}
}

// useTempCaptchaConfig points the config path at a throwaway file for the test, so
// setEnabled's save never touches a real operator captcha_config.json.
func useTempCaptchaConfig(t *testing.T) {
	t.Helper()
	orig := captchaConfigFile
	captchaConfigFile = filepath.Join(t.TempDir(), "captcha_config.json")
	t.Cleanup(func() { captchaConfigFile = orig })
}

// solveConcurrency defaults to 20 (fill 20-at-a-time) and honors an explicit value;
// queueSize accepts any large pool (no upper cap).
func TestSolveConcurrencyAndPoolSize(t *testing.T) {
	m := &captchaManager{}
	if c := m.solveConcurrency(); c != 20 {
		t.Fatalf("default solveConcurrency must be 20, got %d", c)
	}
	m.cfg.SolveConcurrency = 50
	if c := m.solveConcurrency(); c != 50 {
		t.Fatalf("explicit solveConcurrency must be honored, got %d", c)
	}
	m.cfg.QueueSize = 500 // no upper cap
	if s := m.queueSize(); s != 500 {
		t.Fatalf("pool size must accept any value, got %d", s)
	}
}

// The master switch defaults OFF, and while OFF pullRawFailover must solve NOTHING
// (returns an error) — so an always-running bot never burns API balance until START.
func TestCaptchaMasterSwitchGatesSolving(t *testing.T) {
	useTempCaptchaConfig(t)
	m := &captchaManager{}
	m.cfg.Provider = "capsolver"
	m.cfg.Keys = map[string]string{"capsolver": "K"}
	m.cfg.RelayURL = "http://127.0.0.1:8787"

	// default OFF → no solve attempt at all
	if m.isEnabled() {
		t.Fatal("captcha must default to OFF")
	}
	if _, err := m.pullRawFailover("Signin"); err == nil {
		t.Fatal("while OFF, pullRawFailover must return an error (solve nothing)")
	}

	// STOP clears the queue
	m.signin = []readyTok{{raw: "x"}}
	m.setEnabled(false)
	if len(m.signin) != 0 {
		t.Fatal("STOP must clear the pre-solved queue")
	}
}

// setEnabled(true) flips the switch ON (so solving is then allowed to proceed).
func TestCaptchaSetEnabledOn(t *testing.T) {
	useTempCaptchaConfig(t)
	m := &captchaManager{}
	m.setEnabled(true)
	if !m.isEnabled() {
		t.Fatal("setEnabled(true) must turn the switch ON")
	}
	m.setEnabled(false)
	if m.isEnabled() {
		t.Fatal("setEnabled(false) must turn the switch OFF")
	}
}
