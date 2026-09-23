package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"ivac-bot/flow"
)

// ==================== IVACFLOW PUSH ====================
//
// ivacflow (the Node + Playwright extractor) POSTs its snapshot here the moment
// an extraction finishes — no file watching, no polling, no button to press.
// The bot stores it and uses it on the NEXT run, where it sits at rung 3 of the
// ladder: manual override → live scan → ivacflow → RJ SLOT capture → built-in.
//
// Nothing here can break a run: if ivacflow never pushes, the bot behaves
// exactly as it does today.

const ivacflowConfigFile = "ivacflow_config.json"

// ── Push authentication ──────────────────────────────────────────────────────
//
// The push endpoint changes the API config every instance runs against, so it
// is NOT open. Two independent gates:
//
//  1. loopback only — the request must come from this machine;
//  2. a shared token — written to ivacflow_token.txt on first start. ivacflow
//     reads that file (same machine) and sends it as x-ivacflow-token.
//
// Both must pass. A wrong or missing token is rejected without touching config.

const ivacflowTokenFile = "ivacflow_token.txt"

var ivacflowToken string

// LoadOrCreateIvacflowToken reads the shared push token, creating it on first
// start. The file is what ivacflow reads to authenticate itself.
func LoadOrCreateIvacflowToken() {
	if b, err := os.ReadFile(ivacflowTokenFile); err == nil {
		if t := strings.TrimSpace(string(b)); t != "" {
			ivacflowToken = t
			return
		}
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		fmtPrintln("⚠ ivacflow token generate failed: " + err.Error() + " — push disabled")
		return
	}
	ivacflowToken = hex.EncodeToString(raw)
	if err := os.WriteFile(ivacflowTokenFile, []byte(ivacflowToken+"\n"), 0600); err != nil {
		fmtPrintln("⚠ ivacflow token save failed: " + err.Error() + " — push disabled")
		ivacflowToken = ""
		return
	}
	fmtPrintln("🔑 ivacflow push token written to " + ivacflowTokenFile)
}

// isLoopback reports whether a request came from this machine.
func isLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// authorizeIvacflowPush enforces both gates. It returns "" when the request may
// proceed, or the reason it was refused.
func authorizeIvacflowPush(r *http.Request) string {
	if !isLoopback(r) {
		return "push is loopback-only"
	}
	if ivacflowToken == "" {
		return "push token unavailable on this bot"
	}
	sent := strings.TrimSpace(r.Header.Get("x-ivacflow-token"))
	if sent == "" {
		return "x-ivacflow-token header missing (read it from " + ivacflowTokenFile + ")"
	}
	if subtle.ConstantTimeCompare([]byte(sent), []byte(ivacflowToken)) != 1 {
		return "x-ivacflow-token does not match"
	}
	return ""
}

// LoadIvacflowConfig restores the last pushed snapshot at startup, so a bot
// restart does not lose what ivacflow already taught it.
func LoadIvacflowConfig() {
	raw, err := os.ReadFile(ivacflowConfigFile)
	if err != nil || len(raw) == 0 {
		return
	}
	imp, perr := flow.ParseIvacflow(raw)
	if perr != nil {
		fmtPrintln("⚠ " + ivacflowConfigFile + " parse failed: " + perr.Error())
		return
	}
	importMu.Lock()
	ivacflowCfg = imp
	if st, serr := os.Stat(ivacflowConfigFile); serr == nil {
		ivacflowAt = st.ModTime()
	}
	importMu.Unlock()
	fmtPrintln("🧪 ivacflow config loaded: " + imp.Summary())
}

// handleIvacflowPush accepts a snapshot pushed by ivacflow.
//
//	POST /api/ivacflowPush   body: ivacflow's values.json / /api/state payload
//
// It stores and persists the snapshot, and reports back what it understood so
// the push shows up in ivacflow's own console.
func handleIvacflowPush(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	if why := authorizeIvacflowPush(r); why != "" {
		w.WriteHeader(403)
		writeJSON(w, map[string]interface{}{"ok": false, "error": why})
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
	if err != nil || len(raw) == 0 {
		w.WriteHeader(400)
		writeJSON(w, map[string]interface{}{"ok": false, "error": "empty body"})
		return
	}
	imp, perr := flow.ParseIvacflow(raw)
	if perr != nil {
		w.WriteHeader(400)
		writeJSON(w, map[string]interface{}{"ok": false, "error": perr.Error()})
		return
	}
	// A snapshot with neither id is not worth storing — the walk did not reach
	// reserve/initiate, which is the whole reason ivacflow exists.
	if imp.SlotID == "" && imp.DgepayID == "" && len(imp.Families) == 0 {
		w.WriteHeader(400)
		writeJSON(w, map[string]interface{}{"ok": false,
			"error": "snapshot carries no endpoints, slot id or dg-epay id — was the walk cut short?"})
		return
	}

	if werr := os.WriteFile(ivacflowConfigFile, raw, 0644); werr != nil {
		w.WriteHeader(500)
		writeJSON(w, map[string]interface{}{"ok": false, "error": "save failed: " + werr.Error()})
		return
	}
	importMu.Lock()
	ivacflowCfg, ivacflowAt = imp, time.Now()
	importMu.Unlock()
	// the next run should scan afresh and see this capture, not reuse a cached scan
	flow.ClearScanCache()

	fmtPrintln("🧪 ivacflow push received: " + imp.Summary())
	writeJSON(w, map[string]interface{}{
		"ok": true, "stored": true, "summary": imp.Summary(),
		"slotId": imp.SlotID, "dgepayId": imp.DgepayID,
		"endpoints": len(imp.Families), "bundle": imp.BundleName,
	})
}

// handleIvacflowStatus reports what the bot currently holds from ivacflow.
// GET /api/ivacflowStatus
func handleIvacflowStatus(w http.ResponseWriter, r *http.Request) {
	importMu.RLock()
	imp, at := ivacflowCfg, ivacflowAt
	importMu.RUnlock()
	if imp == nil {
		writeJSON(w, map[string]interface{}{"ok": true, "active": false})
		return
	}
	out := map[string]interface{}{
		"ok": true, "active": true, "summary": imp.Summary(),
		"slotId": imp.SlotID, "dgepayId": imp.DgepayID,
		"endpoints": len(imp.Families), "bundle": imp.BundleName,
		"receivedAt": at.Format("2006-01-02 15:04"),
	}
	if !imp.At.IsZero() {
		out["extractedAt"] = imp.At.Format("2006-01-02 15:04")
	}
	if len(imp.Template) > 0 {
		out["mismatches"] = compareTemplate(imp.Template)
	}
	writeJSON(w, out)
}

// handleClearIvacflow drops the stored ivacflow snapshot.
func handleClearIvacflow(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	_ = os.Remove(ivacflowConfigFile)
	importMu.Lock()
	ivacflowCfg, ivacflowAt = nil, time.Time{}
	importMu.Unlock()
	flow.ClearScanCache()
	writeJSON(w, map[string]interface{}{"ok": true, "cleared": true})
}

// botBodyFields is what each step's request builder actually sends today. It is
// compared against ivacflow's observed template so a builder that has drifted
// from the live API shows up as a warning instead of an unexplained failure.
var botBodyFields = map[string][]string{
	"SIGN IN":          {"phone", "password", "c"},
	"VERIFY OTP":       {"requestId", "phone", "code", "otpChannel"},
	"CONFIG":           {"mission", "ivacCenter"},
	"RESERVE":          {"c", "appointmentDate"},
	"PAYMENT INITIATE": {"appointmentId"},
}

// compareTemplate returns a human-readable note for every step where the fields
// the bot sends differ from the fields ivacflow observed on the live site.
func compareTemplate(steps []flow.IvacflowStep) []string {
	var out []string
	for _, st := range steps {
		want, known := botBodyFields[st.Name]
		if !known || len(st.Body) == 0 {
			continue
		}
		got := map[string]bool{}
		for k := range st.Body {
			got[k] = true
		}
		same := len(got) == len(want)
		if same {
			for _, w := range want {
				if !got[w] {
					same = false
					break
				}
			}
		}
		if !same {
			out = append(out, st.Name+": ivacflow dekheche "+joinKeys(st.Body)+
				", bot pathay ["+joinList(want)+"]")
		}
	}
	return out
}

func joinKeys(m map[string]string) string {
	s := "["
	first := true
	for k := range m {
		if !first {
			s += " "
		}
		s += k
		first = false
	}
	return s + "]"
}

func joinList(l []string) string {
	s := ""
	for i, v := range l {
		if i > 0 {
			s += " "
		}
		s += v
	}
	return s
}
