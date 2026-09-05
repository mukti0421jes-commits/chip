package flow

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
)

// UploadMaxTries mirrors RJ SLOT's inner UPLOAD_MAX_TRIES = 4.
const UploadMaxTries = 4

// PDFFile is one applicant file to upload (from the File Manager).
type PDFFile struct {
	Name      string
	Type      string // e.g. application/pdf
	Bytes     []byte
	IsPrimary bool
}

// randomBoundary mirrors RJ SLOT's '----RJUpload' + random.
func randomBoundary() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "----RJUpload" + hex.EncodeToString(b[:])
}

// getDeviceID returns the persisted device id, generating one if empty
// (RJ SLOT getDeviceId — random 20 alpha chars).
func (c *Config) getDeviceID() string {
	if c.DeviceID == "" {
		const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
		var b [20]byte
		_, _ = rand.Read(b[:])
		for i := range b {
			b[i] = chars[int(b[i])%len(chars)]
		}
		c.DeviceID = string(b[:])
	}
	return c.DeviceID
}

// RunUpload runs the upload sub-flow after signin+verify, mirroring RJ SLOT's
// Full Auto upload block, in this exact order:
//
//	appointment (2xx success only — NO id here; appointmentId comes later from
//	             get-booking-config / the Book step)
//	→ Primary file upload → Attendant 1 → 2 → 3 (fresh captcha token each, retry on 429/503)
//	→ Overview check (/file/over-view-v3)
//	→ every saved file uploaded → Confirm Mission & Center (appointment-booking-config)
//
// Returns nil only when every file uploaded and the center was confirmed.
func RunUpload(r *Runner, files []PDFFile, mission, ivacCenter string) error {
	dev := r.Config.getDeviceID()

	// 1) APPOINTMENT — POST /appointment. This call does NOT return an appointmentId
	//    (that comes later from get-booking-config); success is just 2xx. It creates
	//    the appointment context on the server for the uploads that follow.
	resp, err := r.Doer.Do(r.Config.BuildAppointment(r.AccessToken, dev))
	if err != nil {
		return err
	}
	if !appointmentOK(resp) {
		return errAppointment
	}
	r.log("📋 Appointment created (2xx)")

	// 2a) PRE-CHECK overview — a previous session may have ALREADY uploaded these
	//     files. Re-uploading an already-present applicant makes the server 404.
	//     So fetch the overview once; any file whose name already matches an
	//     overview applicant is treated as done and NOT re-uploaded.
	alreadyUp := map[int]bool{}
	if pre, err := r.Doer.Do(r.Config.BuildOverview(r.AccessToken, dev)); err == nil && pre.OK() {
		var pb struct {
			Data []overviewApplicant `json:"data"`
		}
		_ = json.Unmarshal(pre.Body, &pb)
		used := make([]bool, len(pb.Data))
		for fi, f := range files {
			ftok := nameTokens(f.Name)
			for i := range pb.Data {
				if !used[i] && tokensMatch(ftok, nameTokens(pb.Data[i].FullName)) {
					used[i] = true
					alreadyUp[fi] = true
					r.log("✔ " + f.Name + ": already uploaded — skip")
					break
				}
			}
		}
	}

	// 2b) UPLOADS in order — Primary first, then Attendant 1..3. Skip any file
	//     already present in the overview (from a previous session/login).
	uploadedOK := 0
	newlyUploaded := 0 // files actually uploaded THIS run (not carried over from a prior session)
	for fi, f := range files {
		if r.Stopped() {
			return errStopped
		}
		if alreadyUp[fi] {
			uploadedOK++ // counts as done — do not re-upload (would 404)
			continue
		}
		ok, newly := r.uploadOne(f, dev)
		if r.fatalUpload != nil { // e.g. appointment expired (>30 days) — stop, don't retry
			return r.fatalUpload
		}
		if ok {
			uploadedOK++
			if newly {
				newlyUploaded++ // a 409 (already uploaded) counts as done, but NOT new
			}
		} else if f.IsPrimary {
			return errPrimaryUpload
		}
	}
	if uploadedOK != len(files) {
		return errPartialUpload
	}

	// 3) OVERVIEW check + NAME MATCH — verify uploads before confirming.
	//    RJ SLOT: fetch over-view-v3, then require overviewCount == loaded,
	//    every file name-matched to a distinct applicant, and >=1 primary.
	ov, err := r.Doer.Do(r.Config.BuildOverview(r.AccessToken, dev))
	if err != nil {
		return err
	}
	if !ov.OK() {
		snip := string(ov.Body)
		if len(snip) > 200 {
			snip = snip[:200]
		}
		r.log("✗ over-view API — HTTP " + itoa(ov.Status) + " • " + snip + "  (upload window bondho thakle server eta dey)")
		return errOverview
	}
	// RAW overview body (once) — so we can see EXACTLY which per-applicant fields
	// IVAC returns (webFileNo / applicationId / email / …). This is what lets us
	// later match slip-number-named PDFs to applicants without relying on names.
	rawOv := string(ov.Body)
	if len(rawOv) > 1200 {
		rawOv = rawOv[:1200]
	}
	r.log("🧾 Overview RAW body: " + rawOv)
	var ovBody struct {
		Data []overviewApplicant `json:"data"`
	}
	_ = json.Unmarshal(ov.Body, &ovBody)
	// show what overview returned vs what we uploaded — so a mismatch is legible.
	var ovNames, fNames []string
	for _, a := range ovBody.Data {
		tag := a.FullName
		if a.Primary {
			tag += "(primary)"
		}
		ovNames = append(ovNames, tag)
	}
	for _, f := range files {
		fNames = append(fNames, f.Name)
	}
	r.log("🔎 Overview applicants (" + itoa(len(ovBody.Data)) + "): " + strings.Join(ovNames, " | "))
	r.log("🔎 Uploaded files (" + itoa(len(files)) + "): " + strings.Join(fNames, " | "))
	// NOTE: no name/count matching gate anymore (it blocked valid uploads whose PDFs
	// are named by slip/application number). We proceed to confirm the center as long
	// as the overview has at least one applicant — but we DO check the mission below.

	// RJ SLOT parity (re-login skip): if NOTHING was newly uploaded this run — every
	// file was already on the server from a prior session — the appointment MAY already
	// be fully set up. But "file uploaded" and "center confirmed" are SEPARATE: the
	// overview reports ivacCenter=null until the center is actually confirmed. Only
	// skip confirm-center when the center is genuinely confirmed (ivacCenter != null);
	// otherwise Book (get-booking-config) has no confirmed appointment and loops
	// forever. If center is still null we MUST run confirm-center below.
	if newlyUploaded == 0 {
		centerConfirmed := false
		for _, a := range ovBody.Data {
			if a.IvacCenter != nil && *a.IvacCenter != "" {
				centerConfirmed = true
				break
			}
		}
		if centerConfirmed {
			r.log("⏭ All files uploaded AND center already confirmed (ivacCenter set) — skipping confirm-center → Book/Reserve")
			return nil
		}
		r.log("ℹ Files already uploaded but center NOT confirmed yet (ivacCenter=null) — running confirm-center")
	}

	// 4) CONFIRM MISSION & CENTER.
	//    The mission the uploaded files ACTUALLY belong to is authoritative from the
	//    overview (commissionName per applicant) — so we confirm THAT mission's center,
	//    not blindly the entry's. Prefer the primary applicant's commissionName; fall
	//    back to any applicant's, then to the entry's mission/ivacCenter.
	overviewMission := ""
	for _, a := range ovBody.Data {
		if a.Primary && a.CommissionName != "" {
			overviewMission = a.CommissionName
			break
		}
	}
	if overviewMission == "" {
		for _, a := range ovBody.Data {
			if a.CommissionName != "" {
				overviewMission = a.CommissionName
				break
			}
		}
	}
	// entry's own choice (the specific center the user picked, e.g. Jashore under Dhaka)
	entryKey := ivacCenter
	if entryKey == "" {
		entryKey = mission
	}
	entryMission, entryCenter := ResolveMissionCenter(entryKey)

	var rMission, rCenter string
	switch {
	case overviewMission == "":
		// overview didn't say — trust the entry's choice.
		rMission, rCenter = entryMission, entryCenter
	case strings.EqualFold(overviewMission, entryMission):
		// file's mission agrees with the entry → keep the entry's SPECIFIC center
		// (so Jashore vs Dhaka-JFP under the same Dhaka mission is respected).
		rMission, rCenter = entryMission, entryCenter
	default:
		// the uploaded file's mission differs from the entry → the FILE's mission is
		// authoritative (you can't confirm a Dhaka center for a Rajshahi file).
		rMission, rCenter = ResolveMissionCenter(overviewMission)
		r.log("⚠ mission mismatch — entry='" + entryMission + "' but uploaded file's mission='" + overviewMission + "'; confirming the FILE's mission")
	}
	r.log("🏛 Confirming center: mission=" + rMission + " • ivacCenter=" + rCenter + " (file's mission from overview=" + overviewMission + ")")
	bc, err := r.Config.BuildBookingConfig(rMission, rCenter, r.AccessToken, dev)
	if err != nil {
		return err
	}
	cr, err := r.Doer.Do(bc)
	if err != nil {
		return err
	}
	// RJ SLOT: success = 2xx AND (statusCode absent or 2xx).
	if !cr.OK() {
		snip := string(cr.Body)
		if len(snip) > 200 {
			snip = snip[:200]
		}
		r.log("✗ confirm center — HTTP " + itoa(cr.Status) + " • " + snip)
		// 404 "Appointment not found" = the appointment is in a stuck/gone state
		// (files uploaded in a prior session, center never confirmed). Retrying the
		// exact same appointment→confirm can NEVER succeed and only triggers 429
		// rate-limits. Stop now with a clear, actionable message.
		if cr.Status == 404 || strings.Contains(strings.ToLower(string(cr.Body)), "appointment not found") {
			r.log("🛑 confirm center: appointment not found — this appointment is stuck (files uploaded earlier but center not confirmed). Delete this entry & re-add to get a fresh appointment.")
			return errAppointmentNotFound
		}
		return errConfirmCenter
	}
	r.log("✅ Mission & Center confirmed (" + rCenter + ") — uploads complete")
	return nil
}

// appointmentOK mirrors RJ SLOT: success = 2xx AND (no statusCode, or statusCode 2xx).
func appointmentOK(resp Response) bool {
	if !resp.OK() {
		return false
	}
	var body struct {
		StatusCode *int `json:"statusCode"`
	}
	_ = json.Unmarshal(resp.Body, &body)
	return body.StatusCode == nil || (*body.StatusCode >= 200 && *body.StatusCode < 300)
}

// uploadOne uploads a single file with a fresh captcha token per attempt,
// retrying on transient (429/503/5xx) up to UploadMaxTries with 700ms*attempt
// backoff — byte-faithful to RJ SLOT uploadFile.
//
// Returns (ok, newly): ok=true means the file is on the server; newly=true means
// it was uploaded THIS call. An HTTP 409 (Conflict) means the file is ALREADY
// uploaded on the server, so it returns (true, false) — done, but not new — which
// also lets the re-login "skip confirm-center" logic work correctly.
func (r *Runner) uploadOne(f PDFFile, deviceID string) (bool, bool) {
	for attempt := 1; attempt <= UploadMaxTries; attempt++ {
		if r.Stopped() {
			return false, false
		}
		token, err := r.Tokens.GetCaptchaToken()
		if err != nil {
			r.log("❌ upload captcha: " + err.Error())
			return false, false
		}
		req := r.Config.BuildUpload(UploadParams{
			AccessToken:  r.AccessToken,
			CaptchaToken: token, // raw token → x-token
			RuntimeState: r.Config.RuntimeState,
			FileName:     f.Name,
			FileType:     f.Type,
			FileBytes:    f.Bytes,
			IsPrimary:    f.IsPrimary,
			Boundary:     randomBoundary(),
		})
		resp, err := r.Doer.Do(req)
		if err != nil {
			r.log("✗ " + f.Name + " upload — network error: " + err.Error())
			if attempt < UploadMaxTries {
				r.sleep(time.Duration(700*attempt) * time.Millisecond)
				continue
			}
			return false, false
		}
		// success = 2xx AND (no statusCode, or statusCode 2xx)
		var body struct {
			StatusCode *int   `json:"statusCode"`
			Message    string `json:"message"`
		}
		_ = json.Unmarshal(resp.Body, &body)
		msg := strings.ToLower(body.Message)

		// ALREADY UPLOADED — detect by HTTP 409, body statusCode 409, OR the message
		// (server sometimes says "already uploaded" inside a 200/400). Treat as done.
		if resp.Status == 409 || (body.StatusCode != nil && *body.StatusCode == 409) ||
			strings.Contains(msg, "already uploaded") || strings.Contains(msg, "already exist") {
			r.log("✔ " + f.Name + " — already uploaded (server), treating as done")
			return true, false
		}
		// APPOINTMENT EXPIRED (>30 days) — retrying can't fix this; a new appointment
		// is needed. Signal the sub-flow to STOP with a clear message (from sample).
		if strings.Contains(msg, "more than 30 days") || strings.Contains(msg, "30 days") ||
			(strings.Contains(msg, "appointment") && strings.Contains(msg, "expired")) {
			r.log("🛑 " + f.Name + " — appointment expired (>30 days): " + body.Message)
			r.fatalUpload = errAppointmentExpired
			return false, false
		}
		// APPOINTMENT NOT FOUND (404) — the appointment is stuck/gone; re-uploading
		// can't fix it and only draws 429 rate-limits. Stop the sub-flow.
		if resp.Status == 404 || strings.Contains(msg, "appointment not found") {
			r.log("🛑 " + f.Name + " — appointment not found (404): appointment stuck; delete & re-add this entry.")
			r.fatalUpload = errAppointmentNotFound
			return false, false
		}
		ok := resp.OK() && (body.StatusCode == nil || (*body.StatusCode >= 200 && *body.StatusCode < 300))
		if ok {
			r.log("✅ " + f.Name + " uploaded")
			return true, true
		}
		// show EXACTLY what the server said, so a 400/404/422 is diagnosable.
		snip := string(resp.Body)
		if len(snip) > 220 {
			snip = snip[:220]
		}
		r.log("✗ " + f.Name + " upload — HTTP " + itoa(resp.Status) + " (try " + itoa(attempt) + "/" + itoa(UploadMaxTries) + ") • " + snip)
		transient := resp.Status == 429 || resp.Status == 503 || resp.Status >= 500
		if transient && attempt < UploadMaxTries {
			if resp.Status == 429 {
				r.log("⏳ " + f.Name + " 429 — waiting 20s, retry with fresh token")
				r.sleep(20 * time.Second)
			} else {
				r.log("⏳ " + f.Name + " " + itoa(resp.Status) + " — retry with fresh token")
				r.sleep(time.Duration(700*attempt) * time.Millisecond)
			}
			continue
		}
		return false, false
	}
	return false, false
}
