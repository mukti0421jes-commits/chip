package main

import "testing"

// firstKeyedAPI returns the first API (in preference order) that has a key.
func TestFirstKeyedAPI(t *testing.T) {
	m := &captchaManager{}
	m.cfg.Keys = map[string]string{}
	if got := m.firstKeyedAPI(); got != "" {
		t.Fatalf("no keys → want empty, got %q", got)
	}
	m.cfg.Keys = map[string]string{"capmonster": "K"}
	if got := m.firstKeyedAPI(); got != "capmonster" {
		t.Fatalf("one key → want capmonster, got %q", got)
	}
	// preference order: capsolver wins over capmonster when both present
	m.cfg.Keys = map[string]string{"capmonster": "K", "capsolver": "K2"}
	if got := m.firstKeyedAPI(); got != "capsolver" {
		t.Fatalf("preference → want capsolver, got %q", got)
	}
	// blank/whitespace key is ignored
	m.cfg.Keys = map[string]string{"capsolver": "   ", "2captcha": "K"}
	if got := m.firstKeyedAPI(); got != "2captcha" {
		t.Fatalf("blank key ignored → want 2captcha, got %q", got)
	}
}

// promoteAPIPrimary: relay + an API key → API becomes primary (relay = fallback).
func TestPromoteAPIPrimaryFromRelay(t *testing.T) {
	m := &captchaManager{}
	m.cfg.Provider = "relay"
	m.cfg.Keys = map[string]string{"capsolver": "K"}
	if got := m.promoteAPIPrimary(); got != "capsolver" {
		t.Fatalf("promote → want capsolver, got %q", got)
	}
	if m.cfg.Provider != "capsolver" {
		t.Fatalf("provider should now be capsolver, got %q", m.cfg.Provider)
	}
	// altProvider must now give the relay as the fallback
	m.cfg.RelayURL = "http://127.0.0.1:8787"
	if alt := m.altProvider(m.cfg); alt != "relay" {
		t.Fatalf("API primary → fallback must be relay, got %q", alt)
	}
}

// promoteAPIPrimary: relay with NO API key → stays relay (nothing to promote to).
func TestPromoteAPIPrimaryNoKeyStaysRelay(t *testing.T) {
	m := &captchaManager{}
	m.cfg.Provider = "relay"
	m.cfg.Keys = map[string]string{}
	if got := m.promoteAPIPrimary(); got != "" {
		t.Fatalf("no key → want no promotion, got %q", got)
	}
	if m.cfg.Provider != "relay" {
		t.Fatalf("provider should stay relay, got %q", m.cfg.Provider)
	}
}

// promoteAPIPrimary: an EXPLICIT API choice is never overridden.
func TestPromoteAPIPrimaryKeepsExplicitAPI(t *testing.T) {
	m := &captchaManager{}
	m.cfg.Provider = "capmonster"
	m.cfg.Keys = map[string]string{"capsolver": "K", "capmonster": "K2"}
	if got := m.promoteAPIPrimary(); got != "" {
		t.Fatalf("explicit API → want no change, got %q", got)
	}
	if m.cfg.Provider != "capmonster" {
		t.Fatalf("explicit capmonster must be kept, got %q", m.cfg.Provider)
	}
}
