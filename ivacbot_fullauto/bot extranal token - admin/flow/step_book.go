package flow

import "encoding/json"

type bookResponse struct {
	SuccessFlag bool   `json:"successFlag"`
	Message     string `json:"message"`
	StatusCode  int    `json:"statusCode"`
	Data        *struct {
		AppointmentID   string   `json:"appointmentId"`
		AppointmentDate jsonAny  `json:"appointmentDate"` // string or []string
		AppointmentSlot string   `json:"appointmentSlot"`
		IvacCenter      string   `json:"ivacCenter"`
		Mission         string   `json:"mission"`
	} `json:"data"`
}

// StepBook runs GET /appointment/get-booking-config (RJ SLOT stepBook):
//   success = r.ok && (successFlag || message=="Success" || statusCode==200) && data.
// It saves appointmentId and the available appointment date(s) into the runner.
func StepBook(r *Runner) StepResult {
	if r.AccessToken == "" {
		r.log("❌ No session")
		return StepResult{}
	}
	req := Request{
		Method: "GET", URL: r.Config.BookURL(), Referrer: APIReferrer,
		Headers: map[string]string{
			"accept":        "application/json, text/plain, */*",
			"authorization": "Bearer " + r.AccessToken,
			"cache-control": "no-cache, no-store, must-revalidate",
			"pragma":        "no-cache",
		},
	}
	resp, err := r.Do(req)
	if err != nil {
		if r.Stopped() {
			return StepResult{Cancelled: true}
		}
		return StepResult{}
	}
	var body bookResponse
	_ = json.Unmarshal(resp.Body, &body)
	ok := resp.OK() && (body.SuccessFlag || body.Message == "Success" || body.StatusCode == 200) && body.Data != nil
	if !ok {
		snip := string(resp.Body)
		if len(snip) > 220 {
			snip = snip[:220]
		}
		r.log("✗ book (get-booking-config) — HTTP " + itoa(resp.Status) + " • " + snip)
		return StepResult{Status: resp.Status}
	}
	r.mu.Lock()
	if body.Data.AppointmentID != "" {
		r.AppointmentID = body.Data.AppointmentID
	}
	// appointmentDate may be a single string or an array — keep the first.
	if d := body.Data.AppointmentDate.first(); d != "" && r.AppointmentDate == "" {
		r.AppointmentDate = d
	}
	r.mu.Unlock()
	if r.OnAppointment != nil && body.Data.AppointmentID != "" {
		r.OnAppointment(body.Data.AppointmentID, r.AppointmentDate)
	}
	r.log("✅ Booked: appointmentId " + body.Data.AppointmentID)
	return StepResult{Win: true, Data: body}
}

// LoadReserveDates mirrors RJ SLOT loadReserveDates + the ↻ "Sync dates" button:
// GET /appointment/get-booking-config, read data.appointmentDate (an ARRAY of the
// currently OPEN dates), normalize → YYYY-MM-DD, sort+dedup, and pick one per the
// date-target toggle (Latest = last, else Earliest = first). This runs right
// BEFORE reserve so the slot date is fresh + valid (a stale/closed date → HTTP
// 400 on reserve). Also refreshes appointmentId if the server returns a new one.
// Returns the picked date ("" if none available).
func LoadReserveDates(r *Runner) string {
	if r.AccessToken == "" {
		r.log("❌ Load dates: no session")
		return ""
	}
	req := Request{
		Method: "GET", URL: r.Config.BookURL(), Referrer: APIReferrer,
		Headers: map[string]string{
			"accept":        "application/json, text/plain, */*",
			"authorization": "Bearer " + r.AccessToken,
			"cache-control": "no-cache, no-store, must-revalidate",
			"pragma":        "no-cache",
		},
	}
	resp, err := r.Do(req)
	if err != nil {
		if !r.Stopped() {
			r.log("✗ Load dates: " + err.Error())
		}
		return ""
	}
	var body bookResponse
	_ = json.Unmarshal(resp.Body, &body)
	if body.Data == nil {
		r.log("⚠ Load dates: no data (HTTP " + itoa(resp.Status) + ")")
		return ""
	}
	// refresh appointmentId if the server handed a new/first one
	if body.Data.AppointmentID != "" && body.Data.AppointmentID != r.AppointmentID {
		r.mu.Lock()
		r.AppointmentID = body.Data.AppointmentID
		r.mu.Unlock()
		if r.OnAppointment != nil {
			r.OnAppointment(body.Data.AppointmentID, r.AppointmentDate)
		}
	}
	// normalize + sort + dedup the available open dates
	seen := map[string]bool{}
	var dates []string
	for _, d := range body.Data.AppointmentDate.vals {
		nd := normDate(d)
		if nd == "" {
			nd = trimSpace(d)
		}
		if nd != "" && !seen[nd] {
			seen[nd] = true
			dates = append(dates, nd)
		}
	}
	sortStrings(dates)
	if len(dates) == 0 {
		r.log("⚠ Load dates: none available (booking window closed?)")
		return ""
	}
	r.mu.Lock()
	r.AppointmentDates = dates
	picked := dates[0]
	if r.PickLatestDate {
		picked = dates[len(dates)-1]
	}
	r.AppointmentDate = picked
	r.mu.Unlock()
	which := "earliest"
	if r.PickLatestDate {
		which = "latest"
	}
	r.log("📅 " + itoa(len(dates)) + " open date(s) — picked " + which + ": " + picked + " • all: " + joinStrings(dates, ", "))
	return picked
}

// sortStrings sorts a []string ascending (small n; simple insertion sort — no
// sort import needed, keeps the flow package dependency-light).
func sortStrings(a []string) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j-1] > a[j]; j-- {
			a[j-1], a[j] = a[j], a[j-1]
		}
	}
}

func joinStrings(a []string, sep string) string {
	out := ""
	for i, s := range a {
		if i > 0 {
			out += sep
		}
		out += s
	}
	return out
}

// jsonAny decodes a field that may be a string OR an array of strings.
type jsonAny struct{ vals []string }

func (j *jsonAny) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		if s != "" {
			j.vals = []string{s}
		}
		return nil
	}
	var arr []string
	if err := json.Unmarshal(b, &arr); err == nil {
		j.vals = arr
		return nil
	}
	return nil // ignore other shapes
}

func (j jsonAny) first() string {
	if len(j.vals) > 0 {
		return j.vals[0]
	}
	return ""
}
