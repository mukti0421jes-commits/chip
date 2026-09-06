package main

import (
	"encoding/json"
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

// handlePortalInvoiceDownload downloads the IVAC invoice PDF for a paid txrId,
// server-side (our dashboard is not on ivacbd.com, so we proxy it): it uses the
// instance's live accessToken (Bearer) + a fresh RAW captcha (x-token), exactly
// like the IVAC invoice endpoint expects, and streams the PDF back to the browser.
// GET /api/portal/invoiceDownload?entryId=<id>&txrId=<36-char-trxId>
func handlePortalInvoiceDownload(w http.ResponseWriter, r *http.Request) {
	if _, ok := portalSessionUser(r); !ok {
		w.WriteHeader(401)
		_, _ = w.Write([]byte("not logged in"))
		return
	}
	entryID := strings.TrimSpace(r.URL.Query().Get("entryId"))
	txrID := strings.TrimSpace(r.URL.Query().Get("txrId"))
	if txrID == "" {
		w.WriteHeader(400)
		_, _ = w.Write([]byte("txrId required"))
		return
	}
	// resolve the entry → its instance → live accessToken (from the flow session).
	instID := 0
	pMu.Lock()
	for _, e := range pEntries {
		if e.ID == entryID {
			instID = e.InstanceID
			break
		}
	}
	pMu.Unlock()
	accessTok := ""
	if s := getFlowSession(instID); s != nil {
		accessTok = s.AccessToken
	}
	if accessTok == "" {
		w.WriteHeader(409)
		_, _ = w.Write([]byte("session expired — restart this instance (Full Auto) to refresh the login, then download the invoice"))
		return
	}
	// fresh RAW captcha token for x-token (invoice uses a raw token, like upload/initiate).
	capTok, ok := captchaMgr.TakeRaw("Signin")
	if !ok || capTok == "" {
		if t, err := captchaMgr.solveRaw("Signin"); err == nil {
			capTok = t
		}
	}
	cfg := flow.NewConfig()
	doer := &flow.HTTPDoer{Client: newH2Client(pickFlowProxyForInstance(instID))}
	resp, err := doer.Do(flow.Request{
		Method: "GET", URL: cfg.InvoiceDownloadURL(txrID), Referrer: flow.APIReferrer,
		Headers: map[string]string{
			"accept":        "application/pdf,application/json,*/*",
			"authorization": "Bearer " + accessTok,
			"x-token":       capTok,
		},
	})
	if err != nil {
		w.WriteHeader(502)
		_, _ = w.Write([]byte("invoice fetch error: " + err.Error()))
		return
	}
	if resp.Status < 200 || resp.Status >= 300 {
		w.WriteHeader(resp.Status)
		snip := string(resp.Body)
		if len(snip) > 300 {
			snip = snip[:300]
		}
		_, _ = w.Write([]byte("invoice download failed (HTTP " + itoaLocal(resp.Status) + "): " + snip))
		return
	}
	// success → stream the PDF to the browser as a download.
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", `attachment; filename="Invoice-`+txrID+`.pdf"`)
	_, _ = w.Write(resp.Body)
}

func itoaLocal(n int) string { return fmt.Sprintf("%d", n) }

// handlePortalInvoiceCheck confirms whether an entry's payment is DONE by looking
// up the instance's RID (reservationId) in GET /invoice/all-by-user. An invoice is
// only generated after a real payment, so if the RID appears as a row's tranId the
// payment is confirmed done. On a hit it persists inst.Data.PaymentDone=true so the
// payment hub shows ✓ Done even after the link expires. Server-side proxy (Bearer +
// raw x-token), same as the invoice download. GET /api/portal/invoiceCheck?entryId=
func handlePortalInvoiceCheck(w http.ResponseWriter, r *http.Request) {
	if _, ok := portalSessionUser(r); !ok {
		w.WriteHeader(401)
		writeJSON(w, map[string]interface{}{"done": false, "error": "not logged in"})
		return
	}
	entryID := strings.TrimSpace(r.URL.Query().Get("entryId"))
	// resolve entry → instance.
	instID := 0
	pMu.Lock()
	for _, e := range pEntries {
		if e.ID == entryID {
			instID = e.InstanceID
			break
		}
	}
	pMu.Unlock()
	if instID == 0 {
		writeJSON(w, map[string]interface{}{"done": false, "error": "no instance"})
		return
	}
	done, errMsg := invoiceDoneCheck(instID)
	out := map[string]interface{}{"done": done}
	if errMsg != "" {
		out["error"] = errMsg
	}
	writeJSON(w, out)
}

// invoiceDoneCheck looks up an instance's RID (reservationId) in GET
// /invoice/all-by-user and, on a hit, persists inst.Data.PaymentDone=true. An
// invoice exists only after a real payment, so an RID present there = payment DONE.
// Server-side proxy (Bearer + raw x-token). Returns (done, errMsg). It spends one
// captcha only when a check actually runs (already-done / no-RID / no-session short-
// circuit first). Used by both the manual check handler and the auto watcher.
func invoiceDoneCheck(instID int) (bool, string) {
	if instID == 0 {
		return false, "no instance"
	}
	instancesMu.RLock()
	inst, ok := instances[instID]
	instancesMu.RUnlock()
	if !ok {
		return false, "no instance"
	}
	inst.mu.Lock()
	rid := strings.TrimSpace(inst.Data.ReservationID)
	if inst.Data.PaymentDone { // already confirmed — no need to spend a captcha
		inst.mu.Unlock()
		return true, ""
	}
	inst.mu.Unlock()
	if rid == "" {
		return false, "no reservationId yet"
	}
	accessTok := ""
	if s := getFlowSession(instID); s != nil {
		accessTok = s.AccessToken
	}
	if accessTok == "" {
		return false, "session expired"
	}
	// fresh RAW captcha for x-token (all-by-user uses a raw token, like invoice download).
	capTok, ok2 := captchaMgr.TakeRaw("Signin")
	if !ok2 || capTok == "" {
		if t, err := captchaMgr.solveRaw("Signin"); err == nil {
			capTok = t
		}
	}
	cfg := flow.NewConfig()
	doer := &flow.HTTPDoer{Client: newH2Client(pickFlowProxyForInstance(instID))}
	resp, err := doer.Do(flow.Request{
		Method: "GET", URL: cfg.InvoiceAllByUserURL(), Referrer: flow.APIReferrer,
		Headers: map[string]string{
			"accept":        "application/json, text/plain, */*",
			"authorization": "Bearer " + accessTok,
			"x-token":       capTok,
		},
	})
	if err != nil {
		return false, "fetch error"
	}
	if resp.Status < 200 || resp.Status >= 300 {
		return false, "HTTP " + itoaLocal(resp.Status)
	}
	var body struct {
		Data []struct {
			TranId string `json:"tranId"`
		} `json:"data"`
	}
	_ = json.Unmarshal(resp.Body, &body)
	found := false
	for _, d := range body.Data {
		if strings.EqualFold(strings.TrimSpace(d.TranId), rid) {
			found = true
			break
		}
	}
	if found {
		inst.mu.Lock()
		inst.Data.PaymentDone = true
		inst.mu.Unlock()
		saveInstancesToFile()
	}
	return found, ""
}

// invoiceDoneAutoInterval is how often the background watcher re-checks each
// ready-but-not-done payment against /invoice/all-by-user.
const invoiceDoneAutoInterval = 20 * time.Second

// StartInvoiceDoneWatcher runs a background loop that auto-confirms payments:
// every 20s it checks each instance that has a payment URL but is not yet marked
// done (and whose login session is still live). It stops checking an instance once
// it's confirmed done, or once the payment window is well past (lifetime + 5 min
// grace) so abandoned links don't burn captchas forever. Started once from main.
func StartInvoiceDoneWatcher() {
	go func() {
		for {
			time.Sleep(invoiceDoneAutoInterval)
			// snapshot the candidate instance ids without holding locks during the checks.
			var ids []int
			instancesMu.RLock()
			for id, inst := range instances {
				inst.mu.Lock()
				candidate := inst.Data.PaymentURL != "" && !inst.Data.PaymentDone && inst.Data.ReservationID != ""
				pAt := inst.Data.PaymentAt
				inst.mu.Unlock()
				if !candidate {
					continue
				}
				// bound the checks to the payment window + a 5-min grace.
				if pAt != "" {
					if t, err := time.Parse(time.RFC3339, pAt); err == nil {
						if time.Since(t) > time.Duration(PaymentLifetimeSec+300)*time.Second {
							continue
						}
					}
				}
				ids = append(ids, id)
			}
			instancesMu.RUnlock()
			for _, id := range ids {
				if getFlowSession(id) == nil {
					continue // no live login → skip (don't waste a captcha)
				}
				done, _ := invoiceDoneCheck(id)
				if done {
					addLog(id, "✅ Payment confirmed (invoice found) — marked Done")
				}
				time.Sleep(500 * time.Millisecond) // stagger so N instances don't fire at once
			}
		}
	}()
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
			ReserveStartOffset: id,                // round-robin: each instance starts its date-sweep at a different date
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
				if resID != it.Data.ReservationID {
					it.Data.PaymentDone = false // new reservation → its payment isn't confirmed yet
				}
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
			inst.Data.PaymentAt = time.Now().Format(time.RFC3339) // for the lifetime countdown
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
