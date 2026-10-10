package flow

import (
	"errors"
	"testing"
	"time"
)

// Full Auto is LIVE-ONLY: when the live bundle can't be scanned, it must ABORT and
// must NOT fall back to the store (endpoint-cache / last-good), even when a valid
// store exists. Play All is the only cache path.
func TestFullAutoNoStoreFallback(t *testing.T) {
	ClearScanCache()
	// a store that WOULD apply (valid endpoint-cache for its own bundle) — proving it
	// is deliberately ignored by Full Auto.
	cache := []byte(`{"endpoints":[{"method":"POST","path":"/slots/139fd5d2-27c9-4728-a103-278583e830bd/reserve_slot","normPath":"/slots/:uuid/reserve_slot"}],"uuids":{"SLOT_UUID":"139fd5d2-27c9-4728-a103-278583e830bd","DGEPAY_UUID":"27228961-2327-3s28-861a-465sb28327b3"},"bundleName":"mum.js"}`)
	cfg := NewConfig()
	cfg.EndpointCacheJSON = cache
	cfg.SlotID = "" // built-in default is non-empty; clear so we can see if store fills it

	r := NewRunner(cfg, Mode{Single: true, Auto: true}, func(string) {}, func(time.Duration) {})
	r.CacheOnly = false // Full Auto
	r.LiveScanTries = 1  // give up fast (server off)
	r.Fetcher = FetchFunc(func(string) (string, error) { return "", errors.New("server off") })

	r.Scan()

	if !r.scanAborted {
		t.Fatal("Full Auto should abort when live scan fails")
	}
	// The store's endpoint-cache carries this slot uuid; if the store had been applied
	// (the old fallback), SlotID would now hold it. It must stay empty on Full Auto.
	if cfg.SlotID == "139fd5d2-27c9-4728-a103-278583e830bd" {
		t.Fatalf("store must NOT be applied on Full Auto, but SlotID got filled from store: %q", cfg.SlotID)
	}
}

// Play All (CacheOnly) MUST use the store — the opposite of Full Auto.
func TestPlayAllUsesStore(t *testing.T) {
	ClearScanCache()
	cache := []byte(`{"endpoints":[{"method":"POST","path":"/slots/139fd5d2-27c9-4728-a103-278583e830bd/reserve_slot","normPath":"/slots/:uuid/reserve_slot"}],"uuids":{"SLOT_UUID":"139fd5d2-27c9-4728-a103-278583e830bd","DGEPAY_UUID":"27228961-2327-3s28-861a-465sb28327b3"},"bundleName":"mum.js"}`)
	cfg := NewConfig()
	cfg.EndpointCacheJSON = cache
	r := NewRunner(cfg, Mode{Single: true, Auto: true}, func(string) {}, func(time.Duration) {})
	r.CacheOnly = true // Play All
	r.Fetcher = FetchFunc(func(string) (string, error) { return "", errors.New("server off") })

	r.Scan()

	if r.scanAborted {
		t.Fatal("Play All must not abort — it runs from store")
	}
	if cfg.SlotID != "139fd5d2-27c9-4728-a103-278583e830bd" {
		t.Fatalf("Play All should apply store slot uuid, got %q", cfg.SlotID)
	}
}
