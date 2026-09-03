package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"ivac-bot/flow"
)

// ==================== FULL AUTO (RJ SLOT runFullAuto) WIRING ====================
//
// This file wires the byte-faithful RJ SLOT Full Auto pipeline (package flow)
// into the admin dashboard. A File-Manager entry supplies phone/password/
// mission/center; its uploaded PDFs live on disk under entry_files/<entryId>/.
// The admin clicks "Full Auto" on an instance → handleFullAuto runs the whole
// A_E scan → signin → OTP+verify → upload → book → reserve → initiate pipeline,
// streaming logs into that instance's log panel.

// faStops maps instanceID → the running Full Auto's Stop func, so the Stop
// button (stopInstanceHandler) can cancel the flow pipeline for that instance.
var (
	faStopMu sync.Mutex
	faStops  = map[int]func(){}
)

// flowSession is the in-memory resume state per instance. Stop → Start within the
// token window resumes from where it stopped instead of re-signing in.
type flowSession struct {
	AccessToken   string
	RequestID     string
	Verified      bool
	ReservationID string
	At            time.Time
}

const flowSessionTTL = 14 * time.Minute // IVAC access token lives ~15 min

var (
	flowSessMu   sync.Mutex
	flowSessions = map[int]*flowSession{}
)

func getFlowSession(id int) *flowSession {
	flowSessMu.Lock()
	defer flowSessMu.Unlock()
	s := flowSessions[id]
	if s == nil || time.Since(s.At) > flowSessionTTL {
		return nil // none, or expired → full re-signin
	}
	return s
}

func updateFlowSession(id int, mut func(*flowSession)) {
	flowSessMu.Lock()
	s := flowSessions[id]
	if s == nil {
		s = &flowSession{}
		flowSessions[id] = s
	}
	mut(s)
	s.At = time.Now()
	flowSessMu.Unlock()
}

func clearFlowSession(id int) {
	flowSessMu.Lock()
	delete(flowSessions, id)
	flowSessMu.Unlock()
}

// clearAllFlowSessions drops every in-memory resume session (Clean Cache button).
func clearAllFlowSessions() {
	flowSessMu.Lock()
	flowSessions = map[int]*flowSession{}
	flowSessMu.Unlock()
}

// handleCleanCache clears the bot's in-memory caches: resume sessions, pre-solved
// captcha queues, and the dg-epay scan cache. Endpoint: POST /api/cleanCache.
func handleCleanCache(w http.ResponseWriter, r *http.Request) {
	clearAllFlowSessions()
	captchaMgr.ClearQueues()
	flow.ClearDgCache()
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true,"cleared":["resume-sessions","captcha-queues","dg-epay-cache"]}`))
}

// stopFullAuto cancels a running Full Auto pipeline for id (no-op if none).
func stopFullAuto(id int) {
	faStopMu.Lock()
	s := faStops[id]
	faStopMu.Unlock()
	if s != nil {
		s()
	}
}

// flowEndpointName turns a full API URL into a short label for the ENDPOINT column.
func flowEndpointName(url string) string {
	switch {
	case strings.Contains(url, "sign-in"):
		return "signin"
	case strings.Contains(url, "verifySigninOtp"):
		return "verify-otp"
	case strings.HasSuffix(url, "/appointment"):
		return "appointment"
	case strings.Contains(url, "over-view"):
		return "over-view"
	case strings.Contains(url, "upload_file"):
		return "upload"
	case strings.Contains(url, "appointment-booking-config"):
		return "confirm-center"
	case strings.Contains(url, "get-booking-config"):
		return "get-booking-config"
	case strings.Contains(url, "reserve-slot"):
		return "reserve"
	case strings.Contains(url, "dg-epay/initiate"):
		return "initiate"
	}
	if i := strings.LastIndex(url, "/"); i >= 0 && i+1 < len(url) {
		return url[i+1:]
	}
	return url
}

// httpStatusText gives a short label for a status code (0 = network error).
func httpStatusText(s int) string {
	switch {
	case s == 0:
		return "ERR"
	case s >= 200 && s < 300:
		return "OK"
	case s == 429:
		return "Too Many"
	case s == 403:
		return "Forbidden"
	case s == 503:
		return "Unavailable"
	case s >= 500:
		return "Server Err"
	case s >= 400:
		return "Client Err"
	}
	return ""
}

// entryFilesDir is where an entry's applicant PDFs are stored on disk.
func entryFilesDir(entryID string) string {
	return filepath.Join("entry_files", entryID)
}

// pickFlowProxy returns a proxy URL for the flow's H2 client (empty = direct).
// Deprecated in favor of pickFlowProxyForInstance — kept for callers without an id.
func pickFlowProxy() string { return pickFlowProxyForInstance(0) }

// pickFlowProxyForInstance gives each instance its OWN proxy from the enabled list,
// round-robin by instance id, so N instances spread across the available proxies
// (instance 0→proxy0, 1→proxy1, … wrapping around). Empty list → direct (no proxy).
func pickFlowProxyForInstance(id int) string {
	var enabled []ProxyConfig
	for _, p := range getEnabledProxies() {
		if p.Enabled {
			enabled = append(enabled, p)
		}
	}
	if len(enabled) == 0 {
		return "" // no proxy configured → direct connection
	}
	idx := id % len(enabled)
	if idx < 0 {
		idx = 0
	}
	return getProxyURL(enabled[idx])
}

// maskProxy hides any user:pass in a proxy URL before logging it.
func maskProxy(u string) string {
	if i := strings.Index(u, "://"); i >= 0 {
		rest := u[i+3:]
		if at := strings.LastIndex(rest, "@"); at >= 0 {
			return u[:i+3] + "***@" + rest[at+1:]
		}
	}
	return u
}

// loadEntryPDFs reads the applicant PDFs saved for an entry. The file named
// primary*.pdf (or the first file, if none is marked) is flagged IsPrimary,
// matching RJ SLOT's "Primary REQUIRED first, then attendants" upload order.
func loadEntryPDFs(entryID string) ([]flow.PDFFile, error) {
	dir := entryFilesDir(entryID)
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var primary []flow.PDFFile
	var others []flow.PDFFile
	for _, de := range ents {
		if de.IsDir() {
			continue
		}
		name := de.Name()
		if !strings.EqualFold(filepath.Ext(name), ".pdf") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || len(b) == 0 {
			continue
		}
		// stored as "<slot>__<ORIGINAL FILENAME>.pdf". Strip the slot/primary
		// marker so the ORIGINAL IVAC filename (which carries the applicant name)
		// is what overview-matching sees — RJ SLOT matches on that name.
		isPrimary := strings.HasPrefix(name, "PRIMARY__")
		realName := name
		if i := strings.Index(name, "__"); i >= 0 {
			realName = name[i+2:]
		}
		f := flow.PDFFile{Name: realName, Type: "application/pdf", Bytes: b, IsPrimary: isPrimary}
		if isPrimary {
			primary = append(primary, f)
		} else {
			others = append(others, f)
		}
	}
	files := append(primary, others...)
	if len(files) == 0 {
		return nil, fmt.Errorf("no PDF files uploaded for entry %s", entryID)
	}
	// If nothing was named primary*, promote the first file.
	if len(primary) == 0 {
		files[0].IsPrimary = true
	}
	return files, nil
}

// handlePortalUploadFile stores one applicant PDF for a File-Manager entry.
// POST multipart/form-data: field "file"; query ?entryId=..&primary=1&slot=app2
func handlePortalUploadFile(w http.ResponseWriter, r *http.Request) {
	u, ok := portalSessionUser(r)
	if !ok {
		w.WriteHeader(401)
		portalJSON(w, map[string]string{"error": "not logged in"})
		return
	}
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	entryID := r.URL.Query().Get("entryId")
	if entryID == "" {
		w.WriteHeader(400)
		portalJSON(w, map[string]string{"error": "entryId required"})
		return
	}
	// authorize: admin, or the entry's owner
	pMu.Lock()
	authorized := u.Role == "admin"
	for _, e := range pEntries {
		if e.ID == entryID && e.Owner == u.Username {
			authorized = true
		}
	}
	pMu.Unlock()
	if !authorized {
		w.WriteHeader(403)
		portalJSON(w, map[string]string{"error": "not your entry"})
		return
	}

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		w.WriteHeader(400)
		portalJSON(w, map[string]string{"error": "bad form: " + err.Error()})
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		w.WriteHeader(400)
		portalJSON(w, map[string]string{"error": "file field required"})
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		w.WriteHeader(400)
		portalJSON(w, map[string]string{"error": "read: " + err.Error()})
		return
	}

	dir := entryFilesDir(entryID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		w.WriteHeader(500)
		portalJSON(w, map[string]string{"error": "mkdir: " + err.Error()})
		return
	}
	// Preserve the ORIGINAL filename (it carries the applicant's name, which
	// overview-matching needs). Store as "<slot>__<original>.pdf"; slot marks
	// order + primary. Old naming ("<slot>.pdf") destroyed the name → overview
	// mismatch.
	slot := r.URL.Query().Get("slot")
	if slot == "" {
		slot = "app"
	}
	slot = filepath.Base(slot)
	if r.URL.Query().Get("primary") == "1" {
		slot = "PRIMARY"
	}
	orig := filepath.Base(hdr.Filename)
	if !strings.EqualFold(filepath.Ext(orig), ".pdf") {
		orig += ".pdf"
	}
	fname := slot + "__" + orig
	if err := os.WriteFile(filepath.Join(dir, fname), data, 0644); err != nil {
		w.WriteHeader(500)
		portalJSON(w, map[string]string{"error": "save: " + err.Error()})
		return
	}
	fmt.Printf("📎 [Portal] %s uploaded %s (%d bytes) for entry %s\n", u.Username, fname, len(data), entryID)
	portalJSON(w, map[string]interface{}{"ok": "1", "name": fname, "size": len(data)})
}

// fullAutoStepDelays snapshots the dashboard's per-step retry delays (seconds) so
// the Full Auto flow uses the values the user set in the UI controller.
func fullAutoStepDelays() map[string]int {
	configMu.RLock()
	defer configMu.RUnlock()
	out := map[string]int{}
	for k, v := range globalConfig.StepDelaySec {
		out[k] = v
	}
	return out
}

// liveStepDelaySec returns the CURRENT retry delay (seconds) for a step, read fresh
// from the dashboard controller so a value changed mid-run applies to the next
// retry. Returns -1 when the step has no configured value (flow falls back).
func liveStepDelaySec(step string) int {
	configMu.RLock()
	defer configMu.RUnlock()
	if globalConfig.StepDelaySec != nil {
		if v, ok := globalConfig.StepDelaySec[step]; ok && v >= 0 {
			return v
		}
	}
	return -1
}

// handleFullAuto runs the RJ SLOT Full Auto pipeline for one admin instance.
// GET/POST /api/fullAuto?id=<instanceId>[&mission=..&center=..&single=1]
func handleFullAuto(w http.ResponseWriter, r *http.Request) {
	var id int
	fmt.Sscanf(r.URL.Query().Get("id"), "%d", &id)

	instancesMu.RLock()
	inst, ok := instances[id]
	instancesMu.RUnlock()
	if !ok {
		w.WriteHeader(404)
		writeJSON(w, map[string]string{"status": "not found"})
		return
	}

	inst.mu.Lock()
	if inst.Data.Status == "RUNNING" {
		inst.mu.Unlock()
		writeJSON(w, map[string]string{"status": "already running"})
		return
	}
	phone := inst.Data.LoginPhone
	otpPhone := inst.Data.OTPPhone
	password := inst.Data.Password
	entryID := inst.Data.PortalEntryID
	mission := inst.Data.HighCom
	knownAppt := inst.Data.AppointmentID // for get-booking-config smart-skip
	inst.Data.Status = "RUNNING"
	inst.Data.Step = "FULL-AUTO"
	inst.Data.PaymentURL = ""
	inst.mu.Unlock()

	// mission/center resolution: instance HighCom → portal entry Mission → query.
	center := ""
	pMu.Lock()
	for _, e := range pEntries {
		if e.ID == entryID {
			if mission == "" {
				mission = e.Mission
			}
			center = e.Mission
		}
	}
	pMu.Unlock()
	if q := r.URL.Query().Get("mission"); q != "" {
		mission = q
	}
	if q := r.URL.Query().Get("center"); q != "" {
		center = q
	}

	files, ferr := loadEntryPDFs(entryID)
	if ferr != nil {
		addLog(id, "⚠ Full Auto: "+ferr.Error()+" — running without upload")
	}

	// Full Auto retries each step until success, per delay — RJ SLOT parity. Pass
	// ?single=0 to disable retry (fail-fast). Default: retry ON.
	retry := r.URL.Query().Get("single") != "0"
	delaySec := 4
	if v := r.URL.Query().Get("delay"); v != "" {
		fmt.Sscanf(v, "%d", &delaySec)
	}

	// Log sink: instance panel + server console + live STEP column, so progress
	// is visible everywhere (like RJ SLOT's A_E status line).
	logSink := func(m string) {
		addLog(id, m)
		fmt.Printf("[FullAuto #%d] %s\n", id, m)
		instancesMu.RLock()
		it, ok := instances[id]
		instancesMu.RUnlock()
		if ok {
			it.mu.Lock()
			rs := []rune(m)
			if len(rs) > 48 {
				rs = rs[:48]
			}
			it.Data.Step = string(rs)
			it.mu.Unlock()
		}
	}

	// RESUME: reuse a still-live session (stop → start within the token window) so
	// signin/OTP/verify (and reserve, if already done) are skipped.
	var preTok, preReq, preRes string
	var preVer bool
	if s := getFlowSession(id); s != nil {
		preTok, preReq, preVer, preRes = s.AccessToken, s.RequestID, s.Verified, s.ReservationID
		if preTok != "" {
			addLog(id, "⏭ Resume: live session found — continuing from where it stopped")
		}
	}

	// per-instance proxy: each instance gets its own proxy from the enabled list.
	flowProxy := pickFlowProxyForInstance(id)
	if flowProxy != "" {
		addLog(id, "🌐 Using proxy: "+maskProxy(flowProxy))
	} else {
		addLog(id, "🌐 No proxy — direct connection")
	}

	go func() {
		in := FullAutoInput{
			Phone:      phone,
			Password:   password,
			OTPPhone:   otpPhone,
			Mission:    mission,
			IvacCenter: center,
			Files:      files,
			ProxyURL:   flowProxy,
			Single:           retry, // retry each step until success (RJ SLOT)
			Auto:             true,
			DelaySec:         delaySec,
			StepDelays:       fullAutoStepDelays(), // initial snapshot (fallback)
			LiveDelaySec:     liveStepDelaySec,     // read fresh each retry (runtime change)
			AppointmentID:    knownAppt,
			PreAccessToken:   preTok,
			PreRequestID:     preReq,
			PreVerified:      preVer,
			PreReservationID: preRes,
			Log:              logSink,
			OnSignedIn: func(tok, rid string) {
				updateFlowSession(id, func(s *flowSession) { s.AccessToken = tok; s.RequestID = rid })
			},
			OnVerified: func() {
				updateFlowSession(id, func(s *flowSession) { s.Verified = true })
			},
			RegisterStop: func(stop func()) {
				faStopMu.Lock()
				faStops[id] = stop
				faStopMu.Unlock()
			},
			OnScanIDs: func(slotID, dgepayID string) { setDetectedIDs(slotID, dgepayID) },
			OnHTTP: func(url string, status int) {
				// live ENDPOINT + STATUS (200/403/503…) column per API call
				addNetworkLog(id, NetworkRequest{
					Endpoint:   flowEndpointName(url),
					Method:     "POST",
					StatusCode: status,
					StatusText: httpStatusText(status),
					Timestamp:  time.Now(),
					InstanceID: id,
				})
			},
			OnOTP: func(otp string) {
				instancesMu.RLock()
				it, ok := instances[id]
				instancesMu.RUnlock()
				if ok {
					it.mu.Lock()
					it.Data.OTP = otp
					it.mu.Unlock()
				}
			},
		}
		// persistence hooks (closures over this instance id)
		in.OnAppointment = func(apptID, date string) {
			instancesMu.RLock()
			it, ok := instances[id]
			instancesMu.RUnlock()
			if ok {
				it.mu.Lock()
				it.Data.AppointmentID = apptID
				it.Data.HasAppointmentID = true
				if date != "" {
					it.Data.AppointmentDate = date
				}
				it.mu.Unlock()
				saveInstancesToFile() // persist → survives session, enables smart-skip
				logSink("💾 appointmentId saved: " + apptID)
			}
		}
		in.OnReservation = func(resID string) {
			instancesMu.RLock()
			it, ok := instances[id]
			instancesMu.RUnlock()
			if ok {
				it.mu.Lock()
				it.Data.ReservationID = resID
				it.mu.Unlock()
				saveInstancesToFile()
				updateFlowSession(id, func(s *flowSession) { s.ReservationID = resID })
				logSink("💾 reservationId (RID) saved: " + resID)
			}
		}
		logSink("🚀 FULL AUTO started (RJ SLOT pipeline)")
		payURL, err := RunFullAutoForEntry(in)

		// unregister the stop hook now that the run is finished
		faStopMu.Lock()
		delete(faStops, id)
		faStopMu.Unlock()

		stopped := err != nil && strings.Contains(err.Error(), "stop")
		inst.mu.Lock()
		if stopped {
			inst.Data.Status = "STOPPED"
			inst.Data.Step = "⏹ STOPPED"
		} else if err != nil {
			inst.Data.Status = "STOPPED"
			inst.Data.Step = "FULL-AUTO FAILED"
		} else {
			inst.Data.Status = "SUCCESS"
			inst.Data.Step = "PAYMENT READY"
			inst.Data.PaymentURL = payURL
			clearFlowSession(id) // done — no resume needed
		}
		inst.mu.Unlock()
		// log AFTER releasing inst.mu — addLog locks inst.mu itself (would deadlock).
		if stopped {
			addLog(id, "⏹ Full Auto stopped by user")
		} else if err != nil {
			addLog(id, "❌ Full Auto: "+err.Error())
		} else {
			addLog(id, "🎉 Full Auto success — payment URL: "+payURL)
		}
		saveInstancesToFile()

		// mirror payment URL back onto the portal entry
		if err == nil && payURL != "" && entryID != "" {
			pMu.Lock()
			for i := range pEntries {
				if pEntries[i].ID == entryID {
					pEntries[i].PaymentURL = payURL
					pEntries[i].PayStatus = "ready"
				}
			}
			portalSaveEntriesLocked()
			pMu.Unlock()
		}
	}()

	writeJSON(w, map[string]interface{}{"status": "started", "mission": mission, "files": len(files), "time": time.Now().Format("15:04:05")})
}

// writeJSON is a tiny local JSON responder (admin routes).
func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	portalJSON(w, v)
}
