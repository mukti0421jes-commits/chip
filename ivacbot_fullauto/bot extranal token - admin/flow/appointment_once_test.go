package flow

import (
	"sync/atomic"
	"testing"
)

// TestAppointmentCreatedOncePerSession proves the fix for the "over-view keeps
// 400-ing" symptom: when fullauto retries the upload sub-flow, POST /appointment
// must fire ONLY on the first run — re-creating it would reset the server-side
// appointment and make the over-view see an empty appointment (→ 400). RJ SLOT
// parity: create once, reuse.
func TestAppointmentCreatedOncePerSession(t *testing.T) {
	var appts, uploads int32
	d := routeDoer{fn: func(url string) Response {
		switch route(url) {
		case "appointment":
			atomic.AddInt32(&appts, 1)
			return Response{Status: 200, Body: []byte(`{"successFlag":true}`)}
		case "booking":
			return Response{Status: 200, Body: []byte(`{"successFlag":true}`)}
		case "upload":
			atomic.AddInt32(&uploads, 1)
			return Response{Status: 200, Body: []byte(`{"successFlag":true}`)}
		case "overview":
			if atomic.LoadInt32(&uploads) == 0 {
				return Response{Status: 200, Body: []byte(`{"data":[]}`)} // pre-check: empty
			}
			return Response{Status: 200, Body: []byte(`{"data":[{"fullName":"ALPHA NAME","primary":true}]}`)}
		}
		return Response{Status: 200, Body: []byte(`{}`)}
	}}
	r := newUploadRunner(t, d)
	files := []PDFFile{{Name: "ALPHA NAME=BGDDW012.pdf", Type: "application/pdf", Bytes: []byte("a"), IsPrimary: true}}

	// fullauto retries the WHOLE sub-flow — simulate two runs on the same Runner.
	if err := RunUpload(r, files, "dhaka", "dhaka"); err != nil {
		t.Fatalf("first RunUpload failed: %v", err)
	}
	if err := RunUpload(r, files, "dhaka", "dhaka"); err != nil {
		t.Fatalf("second RunUpload failed: %v", err)
	}

	if n := atomic.LoadInt32(&appts); n != 1 {
		t.Fatalf("POST /appointment must fire ONCE per session (RJ parity), got %d", n)
	}
	if !r.appointmentSetupDone {
		t.Fatal("appointmentSetupDone flag not set after a successful create")
	}
}
