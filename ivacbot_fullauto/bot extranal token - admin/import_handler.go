package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"ivac-bot/flow"
)

// ==================== CAPTURED-CONFIG IMPORT ====================
//
// The RJ SLOT userscript records the real requests a browser makes and exports
// them as an "rj_dyn_sync" JSON. Pasting that here lets the bot fill the two
// values a bundle scan can almost never resolve — the reserve slot id and the
// dg-epay uuid — plus any endpoint/cipher/header the scan missed.
//
// It is a SAFETY NET, never an override: flow.Config.ApplyImportGaps uses an
// imported value ONLY where the live scan resolved nothing. On a day when the
// scan works, the import is not consulted at all.

const capturedConfigFile = "captured_config.json"

var (
	importMu      sync.RWMutex
	importedCfg   *flow.Imported
	importedSaved time.Time // when the active capture was imported
)

// getImportedConfig returns the active imported config (nil when none).
func getImportedConfig() *flow.Imported {
	importMu.RLock()
	defer importMu.RUnlock()
	return importedCfg
}

// LoadCapturedConfig restores a previously imported config from disk. Called
// once at startup; a missing or unreadable file simply means "no import yet".
func LoadCapturedConfig() {
	raw, err := os.ReadFile(capturedConfigFile)
	if err != nil || len(raw) == 0 {
		return
	}
	imp, err := flow.ParseImport(raw)
	if err != nil {
		fmtPrintln("⚠ captured_config.json parse failed: " + err.Error())
		return
	}
	importMu.Lock()
	importedCfg = imp
	if st, serr := os.Stat(capturedConfigFile); serr == nil {
		importedSaved = st.ModTime()
	}
	importMu.Unlock()
	fmtPrintln("📥 Captured config loaded: " + imp.Summary())
}

// fmtPrintln keeps the startup logging in one place (console only).
func fmtPrintln(s string) { fmt.Println(s) }

// importPreview is what the dashboard shows BEFORE applying, so a stale export
// can never silently replace a good value.
type importPreview struct {
	OK       bool              `json:"ok"`
	Error    string            `json:"error,omitempty"`
	Summary  string            `json:"summary,omitempty"`
	At       string            `json:"at,omitempty"`
	Changes  []importChange    `json:"changes,omitempty"`
	Warnings []string          `json:"warnings,omitempty"`
	Records  map[string]string `json:"records,omitempty"` // family -> recorded URL
}

type importChange struct {
	Field string `json:"field"`
	From  string `json:"from"`
	To    string `json:"to"`
	Same  bool   `json:"same"`
}

// buildPreview compares an import against the CURRENT built-in/active config so
// the user sees exactly what would change.
func buildPreview(imp *flow.Imported) importPreview {
	cur := flow.NewConfig()
	p := importPreview{OK: true, Summary: imp.Summary(), Records: map[string]string{}}
	if !imp.At.IsZero() {
		p.At = imp.At.Format("2006-01-02 15:04")
		if time.Since(imp.At) > 30*24*time.Hour {
			p.Warnings = append(p.Warnings, "এই export ৩০ দিনের বেশি পুরোনো — মানগুলো বাসি হতে পারে")
		}
	}
	add := func(field, from, to string) {
		if to == "" {
			return
		}
		p.Changes = append(p.Changes, importChange{Field: field, From: from, To: to, Same: from == to})
	}
	add("slot id", cur.SlotID, imp.SlotID)
	add("dg-epay id", cur.DgepayID, imp.DgepayID)
	if imp.Signin != nil {
		add("cipher (signin)", describeCipherShort(cur.Signin), describeCipherShort(imp.Signin))
	}
	for code, lit := range imp.Families {
		add("endpoint "+code, cur.Endpoints[code], lit)
	}
	for fam, rec := range imp.Records {
		p.Records[fam] = rec.URL
	}
	if imp.SlotID == "" {
		p.Warnings = append(p.Warnings,
			"slot id নেই — RJ SLOT স্ক্রিপ্টে একবার হাতে reserve করে আবার Export করুন")
	}
	if imp.DgepayID == "" {
		p.Warnings = append(p.Warnings,
			"dg-epay id নেই — একবার হাতে payment initiate করে আবার Export করুন")
	}
	if imp.Signin == nil {
		p.Warnings = append(p.Warnings,
			"cipher config নেই — স্ক্রিপ্টের export-এ rj_enc যোগ করা আছে কিনা দেখুন")
	}
	return p
}

// describeCipherShort renders a cipher for the preview table.
func describeCipherShort(p *flow.PurposeCipher) string {
	if p == nil {
		return "-"
	}
	k := p.Key
	if len(k) > 8 {
		k = k[:8] + "…"
	}
	return "v" + itoaLocal(p.Version) + " skip=" + itoaLocal(p.Skip) +
		" len=" + itoaLocal(p.Length) + " key=" + k
}

// handleImportCaptured previews or applies a pasted RJ SLOT export.
//
//	GET  /api/importCaptured            → what is currently imported
//	POST /api/importCaptured?apply=0    → parse + preview only (default)
//	POST /api/importCaptured?apply=1    → parse, save to disk, activate
func handleImportCaptured(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		importMu.RLock()
		imp, at := importedCfg, importedSaved
		importMu.RUnlock()
		if imp == nil {
			writeJSON(w, map[string]interface{}{"ok": true, "active": false})
			return
		}
		p := buildPreview(imp)
		writeJSON(w, map[string]interface{}{
			"ok": true, "active": true, "summary": imp.Summary(),
			"importedAt": at.Format("2006-01-02 15:04"), "preview": p,
		})
		return
	}
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}

	raw, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil || len(raw) == 0 {
		writeJSON(w, importPreview{Error: "empty body — Export JSON paste korun"})
		return
	}
	imp, perr := flow.ParseImport(raw)
	if perr != nil {
		writeJSON(w, importPreview{Error: perr.Error()})
		return
	}
	p := buildPreview(imp)
	if r.URL.Query().Get("apply") != "1" {
		writeJSON(w, p) // preview only — nothing changed yet
		return
	}

	if werr := os.WriteFile(capturedConfigFile, raw, 0644); werr != nil {
		writeJSON(w, importPreview{Error: "save failed: " + werr.Error()})
		return
	}
	importMu.Lock()
	importedCfg, importedSaved = imp, time.Now()
	importMu.Unlock()
	// a fresh import should be seen by the next run, not by a cached scan
	flow.ClearScanCache()
	p.Summary = imp.Summary()
	writeJSON(w, map[string]interface{}{"ok": true, "applied": true, "preview": p, "summary": p.Summary})
}

// handleClearImport drops the imported config (file + memory), so the bot goes
// back to scan + built-in fallback only.
func handleClearImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	_ = os.Remove(capturedConfigFile)
	importMu.Lock()
	importedCfg, importedSaved = nil, time.Time{}
	importMu.Unlock()
	flow.ClearScanCache()
	writeJSON(w, map[string]interface{}{"ok": true, "cleared": true})
}

// handleConfigSources reports where each live config value came from — "scan",
// "import", "manual" or "built-in" — so a gap is visible BEFORE a run starts.
// GET /api/configSources
func handleConfigSources(w http.ResponseWriter, r *http.Request) {
	importMu.RLock()
	imp := importedCfg
	importMu.RUnlock()

	cur := flow.NewConfig()
	cur.Imported = imp
	cur.ForcedSlotID, cur.ForcedDgepayID = getOverrideIDs()

	out := map[string]interface{}{
		"ok":         true,
		"hasImport":  imp != nil,
		"slotId":     cur.SlotID,
		"dgepayId":   cur.DgepayID,
		"importedAt": "",
	}
	if imp != nil {
		out["importSummary"] = imp.Summary()
		if !imp.At.IsZero() {
			out["importedAt"] = imp.At.Format("2006-01-02 15:04")
		}
		if imp.SlotID != "" {
			out["slotId"] = imp.SlotID
		}
		if imp.DgepayID != "" {
			out["dgepayId"] = imp.DgepayID
		}
	}
	if cur.ForcedSlotID != "" {
		out["slotId"] = cur.ForcedSlotID
	}
	if cur.ForcedDgepayID != "" {
		out["dgepayId"] = cur.ForcedDgepayID
	}
	// last run's provenance, when a run has already filled it
	lastScanMu.Lock()
	if lastScanSources != nil {
		out["sources"] = lastScanSources
	}
	lastScanMu.Unlock()
	writeJSON(w, out)
}

// lastScanSources is the provenance map from the most recent scan, published so
// the dashboard can show it without re-running anything.
var (
	lastScanMu      sync.Mutex
	lastScanSources map[string]string
)

// publishScanSources stores a finished run's provenance map.
func publishScanSources(src map[string]string) {
	if len(src) == 0 {
		return
	}
	cp := make(map[string]string, len(src))
	for k, v := range src {
		cp[k] = v
	}
	lastScanMu.Lock()
	lastScanSources = cp
	lastScanMu.Unlock()
}
