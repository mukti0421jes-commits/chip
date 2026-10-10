package flow

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// recDoer answers by the FULL request (so a test can inspect the confirm body).
type recDoer struct{ fn func(req Request) Response }

func (d recDoer) Do(req Request) (Response, error) { return d.fn(req), nil }

// The confirm-center body must use the SERVER's exact {mission, center} from
// high-commissions/by-id — even when the user's entry said something else — so a
// renamed/unknown center can never make confirm send the wrong label.
func TestConfirmCenterUsesServerExact(t *testing.T) {
	var uploads int32
	var confirmBody, hcSeen string
	d := recDoer{fn: func(req Request) Response {
		u := req.URL
		switch {
		case strings.Contains(u, "high-commissions/by-id"):
			hcSeen = u
			return Response{Status: 200, Body: []byte(`{"data":{"commission":[{"missionName":"Rajshahi"}],"centers":[{"centerName":"IVAC, RAJSHAHI"}]}}`)}
		case strings.Contains(u, "booking-config"):
			confirmBody = string(req.Body)
			return Response{Status: 200, Body: []byte(`{"successFlag":true}`)}
		case strings.Contains(u, "over-view"):
			if atomic.LoadInt32(&uploads) == 0 {
				return Response{Status: 200, Body: []byte(`{"data":[]}`)} // pre-check: empty
			}
			// after upload: the applicant, carrying a commissionId the server resolves
			return Response{Status: 200, Body: []byte(`{"data":[{"fullName":"ALPHA NAME","primary":true,"commissionId":"COM-9","commissionName":"Rajshahi"}]}`)}
		case strings.Contains(u, "upload"):
			atomic.AddInt32(&uploads, 1)
			return Response{Status: 200, Body: []byte(`{"successFlag":true}`)}
		case strings.Contains(u, "/appointment"):
			return Response{Status: 200, Body: []byte(`{"successFlag":true}`)}
		}
		return Response{Status: 200, Body: []byte(`{}`)}
	}}
	r := NewRunner(&Config{}, Mode{Single: true}, func(string) {}, func(time.Duration) {})
	r.Doer = d
	r.Tokens = TokenFunc(func() (string, error) { return "captcha", nil })
	r.AccessToken = "acc"

	files := []PDFFile{{Name: "ALPHA NAME=BGDDW012.pdf", Type: "application/pdf", Bytes: []byte("a"), IsPrimary: true}}
	// entry says "dhaka", but the SERVER says Rajshahi → server must win.
	if err := RunUpload(r, files, "dhaka", "dhaka"); err != nil {
		t.Fatalf("RunUpload failed: %v", err)
	}
	if hcSeen == "" {
		t.Fatal("high-commissions/by-id was never called")
	}
	if !strings.Contains(confirmBody, "Rajshahi") || !strings.Contains(confirmBody, "IVAC, RAJSHAHI") {
		t.Fatalf("confirm did not use the server-exact mission/center; body=%q", confirmBody)
	}
	if strings.Contains(confirmBody, "Dhaka") {
		t.Fatalf("confirm wrongly used the entry (Dhaka) instead of the server (Rajshahi); body=%q", confirmBody)
	}
}
