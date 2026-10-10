package main

import "testing"

// altProvider must pick the right fallback: relay→a keyed API; API→relay.
func TestAltProviderPicksOtherKind(t *testing.T) {
	// relay primary, a capsolver key present → fall back to capsolver
	c := captchaConfig{Provider: "relay", Keys: map[string]string{"capsolver": "K"}, RelayURL: "http://127.0.0.1:8787"}
	if got := captchaMgr.altProvider(c); got != "capsolver" {
		t.Fatalf("relay→ fallback = %q, want capsolver", got)
	}
	// relay primary, nothing else configured → no fallback
	c3 := captchaConfig{Provider: "relay", Keys: map[string]string{}}
	if got := captchaMgr.altProvider(c3); got != "" {
		t.Fatalf("relay→ (nothing) fallback = %q, want empty", got)
	}
	// API primary, relay url present → fall back to relay
	c4 := captchaConfig{Provider: "capsolver", Keys: map[string]string{"capsolver": "K"}, RelayURL: "http://127.0.0.1:8787"}
	if got := captchaMgr.altProvider(c4); got != "relay" {
		t.Fatalf("api→ fallback = %q, want relay", got)
	}
	// API primary, NO relay url → no fallback
	c5 := captchaConfig{Provider: "capsolver", Keys: map[string]string{"capsolver": "K"}}
	if got := captchaMgr.altProvider(c5); got != "" {
		t.Fatalf("api→ (no relay) fallback = %q, want empty", got)
	}
}
