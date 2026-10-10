package flow

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
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
	//
	//    CREATE ONCE PER SESSION. The upload sub-flow is retried as a whole (fullauto
	//    retries RunUpload on an over-view hiccup). Re-POSTing /appointment on every
	//    retry risks RESETTING the server-side appointment, so the over-view would then
	//    see an empty appointment and return 400 — exactly the "over-view keeps failing"
	//    symptom. RJ SLOT creates it a single time; we match that. Uploaded applicants
	//    persist on the server across the retries, so skipping the re-create is safe.
	if !r.appointmentSetupDone {
		resp, err := r.Do(r.Config.BuildAppointment(r.AccessToken, dev))
		if err != nil {
			return err
		}
		if !appointmentOK(resp) {
			return errAppointment
		}
		r.appointmentSetupDone = true
		r.log("📋 Appointment created (2xx)")
	} else {
		r.log("⏭ Appointment already created this session — skip re-create (RJ parity)")
	}

	// 2a) PRE-CHECK overview — a previous session may have ALREADY uploaded these
	//     files. Re-uploading an already-present applicant makes the server 404.
	//     So fetch the overview once; any file whose name already matches an
	//     overview applicant is treated as done and NOT re-uploaded.
	alreadyUp := map[int]bool{}
	// preApplicants = how many applicants the appointment ALREADY held before this run
	// (from the pre-check overview). If >0 and an upload later gets 404 "appointment
	// not found", the appointment is already set up/locked on the server — re-uploading
	// can never succeed — so we skip to Book/Reserve instead of aborting (slip-number-
	// named PDFs can't name-match the existing applicants, which is why they weren't
	// skipped above).
	preApplicants := 0
	if pre, err := r.Do(r.Config.BuildOverview(r.AccessToken, dev)); err == nil && pre.OK() {
		var pb struct {
			Data []overviewApplicant `json:"data"`
		}
		_ = json.Unmarshal(pre.Body, &pb)
		preApplicants = len(pb.Data)
		// COUNT-AUTHORITY: if the appointment already holds as many applicants as we
		// have files, EVERY file is already uploaded — mark them all, WITHOUT relying
		// on fragile name-matching. (A single-word filename like "SHUVO" won't match
		// "SHUVO HALDER" by tokens, which used to make the primary get re-uploaded and
		// hit 404 on an already-complete appointment.)
		if len(pb.Data) >= len(files) && len(files) > 0 {
			for fi := range files {
				alreadyUp[fi] = true
			}
			r.log("✔ overview shows " + itoa(len(pb.Data)) + " applicant(s) ≥ " + itoa(len(files)) + " file(s) — all already uploaded, skipping uploads")
		} else {
			// partial: match by name to find which specific files are still missing.
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
		ok, newly := r.uploadOne(f, dev, len(files))
		if r.fatalUpload != nil {
			// The only fatal, do-not-retry upload state uploadOne sets is appointment
			// EXPIRED (>30 days) — retrying can never fix it; a NEW appointment is required,
			// so stop here. A 404/409 is NOT fatal anymore: uploadOne reality-checks it via
			// the overview and either moves to the next file (already present) or retries the
			// upload until it succeeds (the user stops the instance manually if an
			// appointment is truly locked) — it never reaches this branch.
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
	ov, err := r.Do(r.Config.BuildOverview(r.AccessToken, dev))
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
	// If NOTHING was newly uploaded this run — every file was already on the server
	// from a prior session — then the upload+confirm was ALREADY done in that prior
	// session (files fully uploaded, mission/center confirmed). Overview's ivacCenter
	// stays null even then, so it is NOT a reliable "confirmed" signal — trying to
	// re-confirm makes the server return 404 "Appointment not found" (it is already
	// confirmed) and loops forever. So SKIP confirm-center and let Book
	// (get-booking-config, the real authority) drive → Reserve → Initiate.
	if newlyUploaded == 0 {
		r.log("⏭ All files already uploaded in a prior session — skipping confirm-center → Book/Reserve (get-booking-config is authoritative)")
		return nil
	}

	// 4) CONFIRM MISSION & CENTER.
	var rMission, rCenter string
	//    GUARANTEED path (RJ SLOT v10.7.4): the overview carries each applicant's
	//    commissionId; high-commissions/by-id returns the EXACT {mission, center} the
	//    appointment-booking-config body must use. Use that verbatim — no hard-coded
	//    label, so it matches whatever IVAC expects and survives any future rename.
	if sm, sc := r.resolveMissionCenterFromServer(ovBody.Data, dev); sm != "" && sc != "" {
		rMission, rCenter = sm, sc
		r.log("🏛 Confirming center (server-exact via high-commissions): mission=" + rMission + " • ivacCenter=" + rCenter)
	} else {
		// FALLBACK (no commissionId / call failed): the mission the uploaded files
		// belong to is authoritative from the overview (commissionName per applicant);
		// resolve the label via the known MissionMap, preferring the primary applicant.
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
	}
	bc, err := r.Config.BuildBookingConfig(rMission, rCenter, r.AccessToken, dev)
	if err != nil {
		return err
	}
	cr, err := r.Do(bc)
	if err != nil {
		return err
	}
	// Success is decided by the response's successFlag / statusCode / message —
	// not merely HTTP 2xx (server can return 200 with successFlag:false). An
	// "already confirmed" response also counts as done.
	var cb struct {
		SuccessFlag bool   `json:"successFlag"`
		StatusCode  *int   `json:"statusCode"`
		Message     string `json:"message"`
	}
	_ = json.Unmarshal(cr.Body, &cb)
	cmsg := strings.ToLower(cb.Message)
	confirmOK := cr.OK() && (cb.SuccessFlag ||
		(cb.StatusCode != nil && *cb.StatusCode >= 200 && *cb.StatusCode < 300) ||
		strings.Contains(cmsg, "success") || strings.Contains(cmsg, "already"))
	if confirmOK {
		r.log("✅ Mission & Center confirmed (" + rCenter + ") — successFlag=" + itoa(boolToInt(cb.SuccessFlag)) + " — uploads complete")
		return nil
	}
	{
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
			// Same stuck-appointment guard as the upload loop: if the overview already had
			// applicant(s) before this run, a confirm-center 404 means the appointment is
			// already set up/locked — skip to Book/Reserve instead of aborting the entry.
			if preApplicants > 0 {
				r.log("⏭ confirm center 404, kintu overview-e age thekei " + itoa(preApplicants) +
					" ta applicant chilo — appointment already set up; Book/Reserve e jacchi")
				return nil
			}
			r.log("🛑 confirm center: appointment not found — this appointment is stuck (files uploaded earlier but center not confirmed). Delete this entry & re-add to get a fresh appointment.")
			return errAppointmentNotFound
		}
		return errConfirmCenter
	}
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// overviewHasFile fetches the CURRENT overview and reports whether this file's applicant
// is already present (by the same name-token match the pre-check uses), plus the total
// applicant count the appointment now holds. Used by uploadOne to turn a 409/404 into a
// correct per-file decision (skip-if-present vs retry). On any overview error it reports
// (false, 0) — i.e. "not confirmed present" — so the caller retries rather than wrongly
// skipping a file.
func (r *Runner) overviewHasFile(f PDFFile, deviceID string) (bool, int) {
	ov, err := r.Do(r.Config.BuildOverview(r.AccessToken, deviceID))
	if err != nil || !ov.OK() {
		return false, 0
	}
	var ob struct {
		Data []overviewApplicant `json:"data"`
	}
	_ = json.Unmarshal(ov.Body, &ob)
	ftok := nameTokens(f.Name)
	for _, a := range ob.Data {
		if tokensMatch(ftok, nameTokens(a.FullName)) {
			return true, len(ob.Data)
		}
	}
	return false, len(ob.Data)
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

// uploadOne uploads a single file with a fresh captcha token per attempt.
//
// TRANSIENT errors (429 / 503 / 5xx / network) are retried:
//   - retry mode ON (Single)  → retry FOREVER until success (server-busy safe);
//   - retry mode OFF          → up to UploadMaxTries (RJ SLOT UPLOAD_MAX_TRIES=4).
//
// The wait between retries is the dashboard "Upld" delay (live) and is done with
// interruptibleSleep, so pressing Stop cancels the loop immediately — it does not
// keep running in the background until the delay elapses.
//
// Returns (ok, newly): ok=true means the file is on the server; newly=true means
// it was uploaded THIS call. An HTTP 409 (Conflict) means the file is ALREADY
// uploaded on the server, so it returns (true, false) — done, but not new — which
// also lets the re-login "skip confirm-center" logic work correctly.
//
// A 404 "appointment not found" OR a 409 "already uploaded" is NOT trusted blindly.
// Both trigger a REALITY CHECK via the overview: if THIS file's applicant is already
// present (its slip-number name just didn't name-match earlier), or the appointment
// already holds >= totalFiles applicants, the file is done → return (true,false) and the
// caller moves on to the next file. If it is genuinely absent, the upload is retried with
// the dashboard upload-delay UNTIL IT SUCCEEDS (Stop-aware) — the user stops the instance
// manually if an appointment is truly locked. Appointment EXPIRED (>30 days) is the one
// exception: it can never succeed, so it stays a fatal stop (create a new appointment).
func (r *Runner) uploadOne(f PDFFile, deviceID string, totalFiles int) (bool, bool) {
	// retryTransient decides whether to try once more after a transient failure.
	retryTransient := func(attempt int) bool { return r.Mode.Single || attempt < UploadMaxTries }
	for attempt := 1; ; attempt++ {
		if r.Stopped() {
			return false, false
		}
		token, err := r.Tokens.GetCaptchaToken()
		if err != nil {
			r.log("❌ upload captcha: " + err.Error())
			return false, false
		}
		// Default: RAW captcha token → x-token. If a future bundle requires it
		// encrypted, flip Config.EncryptUpload ON and it is encrypted with the
		// scanned cipher (all purposes share one key) instead.
		xtoken := token
		if r.Config.EncryptUpload {
			xtoken = r.Config.EncryptForPurpose(token, r.Config.anyCipher())
		}
		req := r.Config.BuildUpload(UploadParams{
			AccessToken:  r.AccessToken,
			CaptchaToken: xtoken, // raw by default; encrypted when EncryptUpload ON
			RuntimeState: r.Config.RuntimeState,
			FileName:     f.Name,
			FileType:     f.Type,
			FileBytes:    f.Bytes,
			IsPrimary:    f.IsPrimary,
			Boundary:     randomBoundary(),
		})
		resp, err := r.Do(req)
		if err != nil {
			r.log("✗ " + f.Name + " upload — network error: " + err.Error())
			if retryTransient(attempt) {
				r.interruptibleSleep(r.delayFor(StUpload)) // UI upload-delay controller (live), Stop-aware
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

		// APPOINTMENT EXPIRED (>30 days) — checked FIRST (its message also mentions
		// "appointment"). Retrying can't fix this; a new appointment is needed. STOP.
		if strings.Contains(msg, "more than 30 days") || strings.Contains(msg, "30 days") ||
			(strings.Contains(msg, "appointment") && strings.Contains(msg, "expired")) {
			r.log("🛑 " + f.Name + " — appointment expired (>30 days): " + body.Message)
			r.fatalUpload = errAppointmentExpired
			return false, false
		}
		// ALREADY UPLOADED (409) — the server's OWN authoritative confirmation that this
		// file is on the appointment. We still fetch the overview (as a reality check /
		// for the log), but a 409 is NEVER retried: whether or not the name-token match
		// finds it (slip-number PDFs often don't name-match), the file is done → move to
		// the next file. Retrying a 409 can only 409 again, which would loop forever.
		if resp.Status == 409 || (body.StatusCode != nil && *body.StatusCode == 409) ||
			strings.Contains(msg, "already uploaded") || strings.Contains(msg, "already exist") {
			present, ovTotal := r.overviewHasFile(f, deviceID)
			if present || (totalFiles > 0 && ovTotal >= totalFiles) {
				r.log("✔ " + f.Name + " — already uploaded (409) & overview confirms present → porer file")
			} else {
				r.log("✔ " + f.Name + " — already uploaded (409); overview name-match hoyni (" +
					itoa(ovTotal) + "/" + itoa(totalFiles) + ") kintu server 409 confirm korche → done, porer file")
			}
			return true, false
		}
		// APPOINTMENT NOT FOUND (404) — ambiguous: could be a real stuck/locked appointment
		// OR a transient server state. REALITY CHECK via the overview: if THIS file's
		// applicant is present (name-match), or the appointment already holds >= totalFiles
		// applicants, the file is done → next file. If genuinely absent, retry the upload at
		// the dashboard upload-delay UNTIL IT SUCCEEDS (Stop-aware) — the user stops the
		// instance manually if the appointment is truly locked. Overview is fetched ONLY here.
		if resp.Status == 404 || strings.Contains(msg, "appointment not found") {
			present, ovTotal := r.overviewHasFile(f, deviceID)
			if present || (totalFiles > 0 && ovTotal >= totalFiles) {
				r.log("✔ " + f.Name + " — overview confirms present (404 ignore); already uploaded → porer file")
				return true, false
			}
			d := r.delayFor(StUpload)
			r.log("↻ " + f.Name + " — HTTP 404 kintu overview-te ekhono nei (" +
				itoa(ovTotal) + "/" + itoa(totalFiles) + " applicant); " + d.String() +
				" por abar upload (success na howa porjonto; dorkar hole instance stop korun)")
			r.interruptibleSleep(d)
			continue
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
		r.log("✗ " + f.Name + " upload — HTTP " + itoa(resp.Status) + " (try " + itoa(attempt) + ") • " + snip)
		transient := resp.Status == 429 || resp.Status == 503 || resp.Status >= 500
		if transient && retryTransient(attempt) {
			// Retry delay follows the dashboard's UPLOAD controller (live): whatever
			// the user set in the "Upld" box governs every upload retry. In retry
			// (Single) mode this loops until success — so a busy/slow server no longer
			// makes the file give up after 4 tries. interruptibleSleep keeps Stop instant.
			d := r.delayFor(StUpload)
			r.log("⏳ " + f.Name + " " + itoa(resp.Status) + " — retry in " + d.String() + " with fresh token")
			r.interruptibleSleep(d)
			continue
		}
		return false, false
	}
}
