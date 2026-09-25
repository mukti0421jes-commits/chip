package main

import (
	"os"
	"sync"
)

// ==================== LAST-GOOD CONFIG (smart-skip scan) ====================
//
// After a successful Full Auto, flow serializes the resolved config (cipher +
// endpoints + slot + dg-epay + bundle name) and hands it here to persist. On the
// next run, flow reads it back (via Config.LastGoodJSON) and, if the live bundle
// name still matches, reuses it — skipping the heavy download + goja scan.

const lastGoodFile = "last_good_config.json"

var (
	lastGoodMu  sync.RWMutex
	lastGoodRaw []byte
)

// LoadLastGoodConfig restores the last-good snapshot at startup.
func LoadLastGoodConfig() {
	raw, err := os.ReadFile(lastGoodFile)
	if err != nil || len(raw) == 0 {
		return
	}
	lastGoodMu.Lock()
	lastGoodRaw = raw
	lastGoodMu.Unlock()
	fmtPrintln("💾 last-good config loaded (smart-skip enabled for same bundle)")
}

// currentLastGood returns the stored snapshot bytes (nil if none), for the flow
// adapter to hand to each run's Config.
func currentLastGood() []byte {
	lastGoodMu.RLock()
	defer lastGoodMu.RUnlock()
	if len(lastGoodRaw) == 0 {
		return nil
	}
	cp := make([]byte, len(lastGoodRaw))
	copy(cp, lastGoodRaw)
	return cp
}

// saveLastGood persists a fresh snapshot (called from the flow OnScanResolved hook
// after a successful run). Best-effort: a write failure is logged, never fatal.
func saveLastGood(snap []byte) {
	if len(snap) == 0 {
		return
	}
	lastGoodMu.Lock()
	lastGoodRaw = snap
	lastGoodMu.Unlock()
	if err := os.WriteFile(lastGoodFile, snap, 0644); err != nil {
		fmtPrintln("⚠ last-good config save failed: " + err.Error())
	}
}
