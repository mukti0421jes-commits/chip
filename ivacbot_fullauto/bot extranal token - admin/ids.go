package main

import (
	"encoding/json"
	"net/http"
	"os"
	"sync"
)

// manualIDs are the dashboard-editable Slot ID / dg-epay ID overrides plus the
// last values the live scan detected (shown back in the inputs, auto-filled).
//   - Override* : user-typed → these WIN over the live scan for every instance.
//   - Detected* : last live-scan result → shown in the input when nothing forced.
type manualIDsState struct {
	OverrideSlotID   string `json:"overrideSlotId"`
	OverrideDgepayID string `json:"overrideDgepayId"`
	DetectedSlotID   string `json:"detectedSlotId"`
	DetectedDgepayID string `json:"detectedDgepayId"`
}

const manualIDsFile = "manual_ids.json"

var (
	manualIDsMu sync.RWMutex
	manualIDs   manualIDsState
)

func loadManualIDs() {
	if b, err := os.ReadFile(manualIDsFile); err == nil {
		manualIDsMu.Lock()
		json.Unmarshal(b, &manualIDs)
		manualIDsMu.Unlock()
	}
}

func saveManualIDs() {
	manualIDsMu.RLock()
	b, _ := json.MarshalIndent(manualIDs, "", "  ")
	manualIDsMu.RUnlock()
	os.WriteFile(manualIDsFile, b, 0644)
}

// getOverrideIDs returns the user-forced Slot/dg-epay ids (empty when unset).
func getOverrideIDs() (slot, dgepay string) {
	manualIDsMu.RLock()
	defer manualIDsMu.RUnlock()
	return manualIDs.OverrideSlotID, manualIDs.OverrideDgepayID
}

// setDetectedIDs records what the live scan resolved, so the UI can show it.
func setDetectedIDs(slot, dgepay string) {
	manualIDsMu.Lock()
	changed := false
	if slot != "" && manualIDs.DetectedSlotID != slot {
		manualIDs.DetectedSlotID = slot
		changed = true
	}
	if dgepay != "" && manualIDs.DetectedDgepayID != dgepay {
		manualIDs.DetectedDgepayID = dgepay
		changed = true
	}
	manualIDsMu.Unlock()
	if changed {
		saveManualIDs()
	}
}

// handleManualIDs is GET (read override+detected) / POST (save overrides).
func handleManualIDs(w http.ResponseWriter, r *http.Request) {
	if r.Method == "POST" {
		var in manualIDsState
		json.NewDecoder(r.Body).Decode(&in)
		manualIDsMu.Lock()
		manualIDs.OverrideSlotID = in.OverrideSlotID
		manualIDs.OverrideDgepayID = in.OverrideDgepayID
		manualIDsMu.Unlock()
		saveManualIDs()
	}
	manualIDsMu.RLock()
	out := manualIDs
	manualIDsMu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}
