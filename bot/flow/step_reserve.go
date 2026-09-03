package flow

import (
	"encoding/json"
	"regexp"
	"strings"
)

// normDate mirrors RJ SLOT _normDate: reserve requires appointmentDate as
// YYYY-MM-DD. get-booking-config / the page often give DD-MM-YYYY or DD/MM/YYYY,
// which the server rejects with HTTP 400. Convert to YYYY-MM-DD; return "" if the
// shape is unrecognized.
var reISO = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)
var reDMYd = regexp.MustCompile(`^(\d{2})-(\d{2})-(\d{4})$`)
var reDMYs = regexp.MustCompile(`^(\d{2})/(\d{2})/(\d{4})$`)

func normDate(s string) string {
	s = trimSpace(s)
	if m := reISO.FindStringSubmatch(s); m != nil {
		return m[1] + "-" + m[2] + "-" + m[3]
	}
	if m := reDMYd.FindStringSubmatch(s); m != nil {
		return m[3] + "-" + m[2] + "-" + m[1] // DD-MM-YYYY → YYYY-MM-DD
	}
	if m := reDMYs.FindStringSubmatch(s); m != nil {
		return m[3] + "-" + m[2] + "-" + m[1] // DD/MM/YYYY → YYYY-MM-DD
	}
	return ""
}

func trimSpace(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t' || s[0] == '\n' || s[0] == '\r') {
		s = s[1:]
	}
	for len(s) > 0 {
		c := s[len(s)-1]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			s = s[:len(s)-1]
		} else {
			break
		}
	}
	return s
}

// reserveResponse is parsed loosely; success is decided by isReserved.
type reserveResponse struct {
	SuccessFlag   bool   `json:"successFlag"`
	Message       string `json:"message"`
	Status        string `json:"status"`
	StatusCode    int    `json:"statusCode"`
	HTTPStatus    int    `json:"http_status"` // IVAC sometimes returns a body-level status inside a 200
	Code          int    `json:"code"`        // e.g. {"code":429,...}
	ReservationID string `json:"reservationId"`
	Data          *struct {
		Status         string `json:"status"`
		Message        string `json:"message"`
		ReservationID  string `json:"reservationId"`
		ReserveTTLSecs int    `json:"reserveTtlSeconds"`
		AppointmentDate string `json:"appointmentDate"`
	} `json:"data"`
}

// isReserved mirrors RJ SLOT isReservedResponse (byte-faithful).
func isReserved(status int, b reserveResponse) bool {
	if b.Message == "Reserved booking" {
		return true
	}
	if b.Status == "OK_NEW" || b.Status == "OK_EXISTING" {
		return true
	}
	okHTTP := status >= 200 && status < 300
	if okHTTP {
		if b.SuccessFlag {
			return true
		}
		if b.StatusCode == 200 || b.StatusCode == 201 {
			return true
		}
		m := b.Message
		if len(m) >= 2 && (hasPrefixFold(m, "reserv") || hasPrefixFold(m, "success") || hasPrefixFold(m, "ok")) {
			return true
		}
		if b.ReservationID != "" || (b.Data != nil && b.Data.ReservationID != "") {
			return true
		}
		if b.Data != nil && (b.Data.Status == "OK_NEW" || b.Data.Status == "OK_EXISTING" || b.Data.Message == "Reserved booking") {
			return true
		}
	}
	return false
}

// StepReserve runs POST /slots/{slotId}/reserve-slot (RJ SLOT stepReserve):
//   get captcha → encrypt('reserve') → body {c, appointmentDate};
//   headers include x-v-request-meta: windos.s. Parses reservationId.
func StepReserve(r *Runner) StepResult {
	if r.AccessToken == "" {
		r.log("❌ No session")
		return StepResult{}
	}
	if r.Config.SlotID == "" {
		r.log("❌ No Slot ID (scan)")
		return StepResult{}
	}
	if r.AppointmentDate == "" {
		r.log("❌ No appointment date")
		return StepResult{}
	}
	// Reserve MUST use a RESERVE-purpose token (a Signin token fails Turnstile
	// verification for the reserve endpoint → "Captcha verification failed").
	tokenSrc := r.ReserveTokens
	if tokenSrc == nil {
		tokenSrc = r.Tokens
	}
	token, err := tokenSrc.GetCaptchaToken()
	if err != nil {
		r.log("✗ captcha: " + err.Error())
		return StepResult{}
	}
	// RJ SLOT parity: reserve wants YYYY-MM-DD. Normalize whatever get-booking-config
	// gave (often DD-MM-YYYY) or the server 400s. Keep the raw value only if it can't
	// be parsed (so we don't silently drop a valid but unusual format).
	apptDate := normDate(r.AppointmentDate)
	if apptDate == "" {
		apptDate = r.AppointmentDate
		r.log("⚠ reserve date not normalizable, sending raw: " + apptDate)
	} else if apptDate != r.AppointmentDate {
		r.log("📅 reserve date normalized: " + r.AppointmentDate + " → " + apptDate)
	}
	enc := r.Config.EncryptForPurpose(token, r.Config.Reserve)
	body, err := marshalBody(map[string]string{"c": enc, "appointmentDate": apptDate}, "c", "appointmentDate")
	if err != nil {
		return StepResult{}
	}
	req := Request{
		Method: "POST", URL: r.Config.ReserveURLFor(), Referrer: APIReferrer, Body: body,
		Headers: map[string]string{
			"accept":          "application/json, text/plain, */*",
			"authorization":   "Bearer " + r.AccessToken,
			"cache-control":   "no-cache, no-store, must-revalidate",
			"content-type":    "application/json",
			"pragma":          "no-cache",
			"x-v-request-meta": r.Config.VRequestMeta,
		},
	}
	resp, err := r.Doer.Do(req)
	if err != nil {
		if r.Stopped() {
			return StepResult{Cancelled: true}
		}
		return StepResult{}
	}
	var rb reserveResponse
	_ = json.Unmarshal(resp.Body, &rb)
	if !isReserved(resp.Status, rb) {
		snip := string(resp.Body)
		if len(snip) > 250 {
			snip = snip[:250]
		}
		r.log("✗ reserve — HTTP " + itoa(resp.Status) + " • date=" + apptDate + " • " + snip)
		// carry the parsed body so ReserveCycle can tell a rate-limit / captcha
		// failure (retry same date) apart from a genuinely full slot (next date).
		return StepResult{Status: resp.Status, Data: rb}
	}
	rid := rb.ReservationID
	if rid == "" && rb.Data != nil {
		rid = rb.Data.ReservationID
	}
	r.mu.Lock()
	r.ReservationID = rid
	r.mu.Unlock()
	if r.OnReservation != nil && rid != "" {
		r.OnReservation(rid)
	}
	r.log("✅ Reserved • reservationId " + rid)
	return StepResult{Win: true, Data: rb}
}

// ReserveCycle tries the available dates IN ORDER: first date first; if that slot
// is booked/full (the server rejects it, typically HTTP 4xx), it moves to the
// second date, then the third, and so on — reserving on the first date that still
// has an open slot. Rate-limit (HTTP 429) is NOT a "date full" signal, so it waits
// 20s and retries the SAME date. When every date is exhausted with no slot, it (in
// Single/retry mode) reloads the fresh date list and starts the sweep again.
func ReserveCycle(r *Runner) StepResult {
	for !r.Stopped() {
		dates := r.AppointmentDates
		if len(dates) == 0 {
			if r.AppointmentDate == "" {
				r.log("❌ reserve: no dates available")
				return StepResult{}
			}
			dates = []string{r.AppointmentDate}
		}
		i := 0
		for i < len(dates) && !r.Stopped() {
			r.mu.Lock()
			r.AppointmentDate = dates[i]
			r.mu.Unlock()
			r.log("🎟 reserve try date " + itoa(i+1) + "/" + itoa(len(dates)) + ": " + dates[i])
			res := StepReserve(r)
			if res.Win || res.Cancelled {
				return res
			}
			rb, _ := res.Data.(reserveResponse)
			switch classifyReserve(res.Status, rb) {
			case reserveRateLimited:
				// 429 (rate limit) — global, NOT date-specific. Wait the CONFIGURED
				// reserve delay (dashboard controller, default 21s) and retry the SAME
				// date (do NOT burn the other dates).
				d := r.delayFor(StReserve)
				r.log("↻ reserve rate-limited on " + dates[i] + " — waiting " + d.String() + ", retry same date")
				r.interruptibleSleep(d)
			case reserveCaptchaFail:
				// bad/expired captcha token — grab a fresh one and retry the SAME date.
				// RJ SLOT parity: wait the CONFIGURED reserve delay (UI controller).
				d := r.delayFor(StReserve)
				r.log("↻ reserve captcha failed on " + dates[i] + " — fresh token, retry in " + d.String())
				r.interruptibleSleep(d)
			case reserveTransient:
				// network / no-status. Retry same date in Single mode; else advance.
				if !r.Mode.Single {
					i++
					continue
				}
				d := r.delayFor(StReserve)
				r.log("↻ reserve retry on " + dates[i] + " in " + d.String())
				r.interruptibleSleep(d)
			default: // reserveSlotUnavailable — this date is genuinely full → NEXT date.
				// Wait the configured reserve delay before the next date too, so the
				// UI retry-delay controller governs every reserve attempt (RJ parity).
				d := r.delayFor(StReserve)
				r.log("→ date " + dates[i] + " slot full (HTTP " + itoa(res.Status) + ") — next date in " + d.String())
				r.interruptibleSleep(d)
				i++
			}
		}
		if r.Stopped() {
			return StepResult{Cancelled: true}
		}
		// every date swept, none open.
		if !r.Mode.Single {
			r.log("✗ reserve — all " + itoa(len(dates)) + " date(s) unavailable")
			return StepResult{Status: 400}
		}
		r.log("↻ reserve — all dates full, reloading fresh dates & retrying…")
		r.interruptibleSleep(r.delayFor(StReserve))
		LoadReserveDates(r)
	}
	return StepResult{Cancelled: true}
}

// reserve failure classes — decide whether to wait & retry the SAME date or move
// on to the NEXT date.
type reserveClass int

const (
	reserveSlotUnavailable reserveClass = iota // this date is full → next date
	reserveRateLimited                         // 429 → wait 21s, same date
	reserveCaptchaFail                         // bad token → fresh token, same date
	reserveTransient                           // network/no-status → retry same date
)

// classifyReserve inspects the HTTP status AND the parsed body. IVAC often returns
// a rate-limit or captcha error INSIDE an HTTP 200 envelope ({"http_status":429,…}
// or {"code":429,…} or {"message":"Captcha verification failed…"}), so the HTTP
// status alone is not enough.
func classifyReserve(httpStatus int, rb reserveResponse) reserveClass {
	msg := strings.ToLower(rb.Message)
	if rb.Data != nil && rb.Data.Message != "" {
		msg = strings.ToLower(rb.Data.Message)
	}
	// rate limited (any of: real 429, body http_status/code 429, or the wording)
	if httpStatus == 429 || rb.HTTPStatus == 429 || rb.Code == 429 || rb.StatusCode == 429 ||
		strings.Contains(msg, "wait a little longer") || strings.Contains(msg, "too many") {
		return reserveRateLimited
	}
	if strings.Contains(msg, "captcha") {
		return reserveCaptchaFail
	}
	if httpStatus == 0 {
		return reserveTransient
	}
	return reserveSlotUnavailable
}

func hasPrefixFold(s, prefix string) bool {
	if len(s) < len(prefix) {
		return false
	}
	for i := 0; i < len(prefix); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		p := prefix[i]
		if p >= 'A' && p <= 'Z' {
			p += 'a' - 'A'
		}
		if c != p {
			return false
		}
	}
	return true
}
