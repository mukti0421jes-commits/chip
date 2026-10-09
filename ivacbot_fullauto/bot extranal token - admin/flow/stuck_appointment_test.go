package flow

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// routeDoer answers by URL substring so a test can script the upload sub-flow.
type routeDoer struct{ fn func(url string) Response }

func (d routeDoer) Do(req Request) (Response, error) { return d.fn(req.URL), nil }

func newUploadRunner(t *testing.T, d Doer) *Runner {
	t.Helper()
	r := NewRunner(&Config{}, Mode{Single: true}, func(string) {}, func(time.Duration) {})
	r.Doer = d
	r.Tokens = TokenFunc(func() (string, error) { return "captcha-token", nil })
	r.AccessToken = "acc"
	return r
}

func route(url string) string {
	switch {
	case strings.Contains(url, "booking-config"):
		return "booking"
	case strings.Contains(url, "over-view"):
		return "overview"
	case strings.Contains(url, "upload_file"):
		return "upload"
	case strings.Contains(url, "/appointment"):
		return "appointment"
	}
	return "other"
}

// A 404 on a file whose applicant the overview then shows as PRESENT must NOT abort:
// uploadOne treats the file as done and the loop continues to the next file, which
// uploads normally → whole sub-flow succeeds (nil). This is the slip-number-named PDF
// case: the name didn't match in the pre-check, but a post-404 overview confirms it.
func TestUpload404ThenPresentContinuesToNextFile(t *testing.T) {
	var uploads int32
	d := routeDoer{fn: func(url string) Response {
		switch route(url) {
		case "appointment":
			return Response{Status: 200, Body: []byte(`{"successFlag":true}`)}
		case "booking":
			return Response{Status: 200, Body: []byte(`{"successFlag":true}`)}
		case "upload":
			if atomic.AddInt32(&uploads, 1) == 1 {
				return Response{Status: 404, Body: []byte(`{"message":"Appointment not found"}`)} // file #1
			}
			return Response{Status: 200, Body: []byte(`{"successFlag":true}`)} // file #2
		case "overview":
			switch atomic.LoadInt32(&uploads) {
			case 0: // pre-check: nothing uploaded yet
				return Response{Status: 200, Body: []byte(`{"data":[]}`)}
			case 1: // recheck after file #1's 404 → it IS present
				return Response{Status: 200, Body: []byte(`{"data":[{"fullName":"ALPHA NAME","primary":true}]}`)}
			default: // final overview
				return Response{Status: 200, Body: []byte(`{"data":[{"fullName":"ALPHA NAME","primary":true},{"fullName":"BETA NAME"}]}`)}
			}
		}
		return Response{Status: 200, Body: []byte(`{}`)}
	}}
	r := newUploadRunner(t, d)
	files := []PDFFile{
		{Name: "ALPHA NAME=BGDDW012.pdf", Type: "application/pdf", Bytes: []byte("a"), IsPrimary: true},
		{Name: "BETA NAME=BGDDW013.pdf", Type: "application/pdf", Bytes: []byte("b")},
	}
	if err := RunUpload(r, files, "dhaka", "dhaka"); err != nil {
		t.Fatalf("404-then-present must continue and succeed (nil), got: %v", err)
	}
}

// A 409 "already uploaded" must also be verified via the overview, then skipped.
func TestUpload409VerifiedViaOverviewThenDone(t *testing.T) {
	var uploads int32
	d := routeDoer{fn: func(url string) Response {
		switch route(url) {
		case "appointment":
			return Response{Status: 200, Body: []byte(`{"successFlag":true}`)}
		case "upload":
			atomic.AddInt32(&uploads, 1)
			return Response{Status: 409, Body: []byte(`{"message":"already uploaded"}`)}
		case "overview":
			if atomic.LoadInt32(&uploads) == 0 {
				return Response{Status: 200, Body: []byte(`{"data":[]}`)} // pre-check
			}
			return Response{Status: 200, Body: []byte(`{"data":[{"fullName":"ALPHA NAME","primary":true}]}`)}
		}
		return Response{Status: 200, Body: []byte(`{}`)}
	}}
	r := newUploadRunner(t, d)
	files := []PDFFile{{Name: "ALPHA NAME=BGDDW012.pdf", Type: "application/pdf", Bytes: []byte("a"), IsPrimary: true}}
	if err := RunUpload(r, files, "dhaka", "dhaka"); err != nil {
		t.Fatalf("409 verified present via overview must be done (nil), got: %v", err)
	}
}

// A 409 whose file the overview can NOT name-match (slip-number PDF) and where the
// appointment holds fewer applicants than files must STILL be treated as done — the
// server's 409 is authoritative — and must NOT retry (a 409 only 409s again → loop).
// The test would hang if uploadOne retried the 409.
func TestUpload409NameMismatchTrustsServerNoLoop(t *testing.T) {
	var uploads int32
	d := routeDoer{fn: func(url string) Response {
		switch route(url) {
		case "appointment":
			return Response{Status: 200, Body: []byte(`{"successFlag":true}`)}
		case "booking":
			return Response{Status: 200, Body: []byte(`{"successFlag":true}`)}
		case "upload":
			n := atomic.AddInt32(&uploads, 1)
			if n == 1 {
				return Response{Status: 409, Body: []byte(`{"message":"already uploaded"}`)} // slip-number file #1
			}
			return Response{Status: 200, Body: []byte(`{"successFlag":true}`)} // file #2
		case "overview":
			// Always shows ONE applicant whose name does not match either slip-number file,
			// and count(1) < files(2) → the 409 path must trust the server, not retry.
			return Response{Status: 200, Body: []byte(`{"data":[{"fullName":"UNRELATED PERSON","primary":true}]}`)}
		}
		return Response{Status: 200, Body: []byte(`{}`)}
	}}
	r := newUploadRunner(t, d)
	files := []PDFFile{
		{Name: "BGDDW012C426.pdf", Type: "application/pdf", Bytes: []byte("a"), IsPrimary: true},
		{Name: "BGDDW013.pdf", Type: "application/pdf", Bytes: []byte("b")},
	}
	done := make(chan error, 1)
	go func() { done <- RunUpload(r, files, "dhaka", "dhaka") }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("409 name-mismatch must be trusted as done and continue, got: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RunUpload looped on a 409 — it must NOT retry a 409")
	}
	if n := atomic.LoadInt32(&uploads); n != 2 {
		t.Fatalf("expected exactly 2 upload calls (409 once, then next file), got %d", n)
	}
}

// Count-authority on a 404: the file name does NOT match any applicant (slip-number
// PDF), but the appointment already holds >= totalFiles applicants → treat as present
// and move on, instead of retrying forever.
func TestUpload404CountAuthorityTreatsPresent(t *testing.T) {
	var uploads int32
	d := routeDoer{fn: func(url string) Response {
		switch route(url) {
		case "appointment":
			return Response{Status: 200, Body: []byte(`{"successFlag":true}`)}
		case "upload":
			atomic.AddInt32(&uploads, 1)
			return Response{Status: 404, Body: []byte(`{"message":"Appointment not found"}`)}
		case "overview":
			if atomic.LoadInt32(&uploads) == 0 {
				return Response{Status: 200, Body: []byte(`{"data":[]}`)} // pre-check: empty
			}
			// recheck: one applicant, name does NOT match the slip-number file, but
			// count(1) >= files(1) → count-authority says present.
			return Response{Status: 200, Body: []byte(`{"data":[{"fullName":"SOME PERSON","primary":true}]}`)}
		}
		return Response{Status: 200, Body: []byte(`{}`)}
	}}
	r := newUploadRunner(t, d)
	files := []PDFFile{{Name: "BGDDW0133426.pdf", Type: "application/pdf", Bytes: []byte("a"), IsPrimary: true}}
	if err := RunUpload(r, files, "dhaka", "dhaka"); err != nil {
		t.Fatalf("404 with count-authority present must be done (nil), got: %v", err)
	}
}

// A file that keeps 404-ing AND stays absent from the overview must RETRY (not abort,
// not skip) until the instance is stopped — proving per-file persistence and that Stop
// cancels the loop (no infinite hang).
func TestUpload404AbsentRetriesUntilStop(t *testing.T) {
	var r *Runner
	var uploads int32
	d := routeDoer{fn: func(url string) Response {
		switch route(url) {
		case "appointment":
			return Response{Status: 200, Body: []byte(`{"successFlag":true}`)}
		case "overview":
			return Response{Status: 200, Body: []byte(`{"data":[]}`)} // never present
		case "upload":
			if atomic.AddInt32(&uploads, 1) >= 3 {
				r.Stop() // after a few retries the user stops the instance
			}
			return Response{Status: 404, Body: []byte(`{"message":"Appointment not found"}`)}
		}
		return Response{Status: 200, Body: []byte(`{}`)}
	}}
	r = newUploadRunner(t, d)
	files := []PDFFile{{Name: "X=BGDDW999.pdf", Type: "application/pdf", Bytes: []byte("x")}}
	done := make(chan error, 1)
	go func() { done <- RunUpload(r, files, "dhaka", "dhaka") }()
	select {
	case <-done: // returned after Stop → good (it retried, then the stop cancelled it)
	case <-time.After(5 * time.Second):
		t.Fatal("RunUpload did not stop retrying after Stop() — possible infinite loop")
	}
	if n := atomic.LoadInt32(&uploads); n < 3 {
		t.Fatalf("expected the file to be retried (>=3 upload attempts), got %d", n)
	}
}
