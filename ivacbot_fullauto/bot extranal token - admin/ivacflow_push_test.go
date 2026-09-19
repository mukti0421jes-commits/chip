package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"ivac-bot/flow"
)

const pushBody = `{"config":{"extractedAt":"2026-09-18T19:52:52.506Z",
"apiBase":"https://api.ivacbd.com/iams/api/v1",
"endpoints":{"signin":"/auth/v3-sign-in","uploadFile":"/file/upload_file_v321"},
"slotId":"139fd4d2-27c9-4758-a623-368583e830bs",
"dgepayUuid":"23228961-2326-3s28-861f-465bb28337a3",
"ciphers":{"roles":[{"role":"Signin","version":"10","skip":8,"len":21,"key":"K"}]}},
"template":[],"bundleName":"abc-def.js","at":"9/19/2026"}`

func newPush(t *testing.T, token string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("POST", "/api/ivacflowPush", strings.NewReader(pushBody))
	r.RemoteAddr = "127.0.0.1:54321"
	if token != "" {
		r.Header.Set("x-ivacflow-token", token)
	}
	w := httptest.NewRecorder()
	handleIvacflowPush(w, r)
	return w
}

// TestPushRejectedWithoutToken: the endpoint rewrites the config every instance
// runs against, so an unauthenticated caller must get nowhere.
func TestPushRejectedWithoutToken(t *testing.T) {
	ivacflowToken = "correct-token"
	defer func() { ivacflowCfg = nil }()

	if w := newPush(t, ""); w.Code != 403 {
		t.Fatalf("missing token accepted: HTTP %d", w.Code)
	}
	if w := newPush(t, "wrong-token"); w.Code != 403 {
		t.Fatalf("wrong token accepted: HTTP %d", w.Code)
	}
	if getFallbackConfigs() != nil {
		t.Fatal("a rejected push still changed the stored config")
	}
}

// TestPushRejectedFromRemoteAddr: loopback-only, so a push cannot arrive from
// another machine even with a leaked token.
func TestPushRejectedFromRemoteAddr(t *testing.T) {
	ivacflowToken = "correct-token"
	r := httptest.NewRequest("POST", "/api/ivacflowPush", strings.NewReader(pushBody))
	r.RemoteAddr = "203.0.113.9:4444"
	r.Header.Set("x-ivacflow-token", "correct-token")
	w := httptest.NewRecorder()
	handleIvacflowPush(w, r)
	if w.Code != 403 {
		t.Fatalf("a non-loopback push was accepted: HTTP %d", w.Code)
	}
}

// TestPushStoresSnapshot: the happy path — a valid push lands in the fallback
// ladder ahead of any RJ SLOT capture.
func TestPushStoresSnapshot(t *testing.T) {
	dir := t.TempDir()
	wd, _ := os.Getwd()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(wd)

	ivacflowToken = "correct-token"
	ivacflowCfg = nil
	defer func() { ivacflowCfg = nil }()

	w := newPush(t, "correct-token")
	if w.Code != 200 {
		t.Fatalf("valid push refused: HTTP %d — %s", w.Code, w.Body.String())
	}
	fb := getFallbackConfigs()
	if len(fb) != 1 {
		t.Fatalf("stored %d fallbacks, want 1", len(fb))
	}
	if fb[0].SlotID != "139fd4d2-27c9-4758-a623-368583e830bs" {
		t.Fatalf("slot id not stored: %q", fb[0].SlotID)
	}
	if _, err := os.Stat(ivacflowConfigFile); err != nil {
		t.Fatal("snapshot was not persisted for the next restart")
	}
}

// TestPushRejectsEmptyWalk: a snapshot from a walk that never reached reserve or
// initiate carries nothing worth keeping and must not replace a good one.
func TestPushRejectsEmptyWalk(t *testing.T) {
	ivacflowToken = "correct-token"
	ivacflowCfg = nil
	body := `{"config":{"extractedAt":"2026-09-18T19:52:52.506Z","endpoints":{}},"template":[]}`
	r := httptest.NewRequest("POST", "/api/ivacflowPush", strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:1"
	r.Header.Set("x-ivacflow-token", "correct-token")
	w := httptest.NewRecorder()
	handleIvacflowPush(w, r)
	if w.Code != 400 {
		t.Fatalf("an empty snapshot was accepted: HTTP %d", w.Code)
	}
	if ivacflowCfg != nil {
		t.Fatal("an empty snapshot was stored")
	}
}

func TestPushRejectsNonPost(t *testing.T) {
	w := httptest.NewRecorder()
	handleIvacflowPush(w, httptest.NewRequest("GET", "/api/ivacflowPush", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET accepted: HTTP %d", w.Code)
	}
}

// TestCompareTemplateFlagsDrift: ivacflow's observed body fields vs what the bot
// actually sends. This is how a builder that drifted from the live API shows up
// as a warning instead of an unexplained failure — the real example being
// PAYMENT INITIATE, where ivacflow observed {reservationId, amount} while the
// bot sends {appointmentId}.
func TestCompareTemplateFlagsDrift(t *testing.T) {
	if out := compareTemplate(nil); len(out) != 0 {
		t.Fatalf("no template should mean no warnings, got %v", out)
	}

	matching := []flow.IvacflowStep{{
		Name: "RESERVE",
		Body: map[string]string{"c": "{{ivac:captcha}}", "appointmentDate": "{{ivac:appointmentDate}}"},
	}}
	if out := compareTemplate(matching); len(out) != 0 {
		t.Fatalf("a step that agrees was flagged: %v", out)
	}

	drifted := []flow.IvacflowStep{{
		Name: "PAYMENT INITIATE",
		Body: map[string]string{"reservationId": "{{ivac:reservationId}}", "amount": "{{ivac:amount}}"},
	}}
	out := compareTemplate(drifted)
	if len(out) != 1 {
		t.Fatalf("drift not reported: %v", out)
	}
	if !strings.Contains(out[0], "PAYMENT INITIATE") || !strings.Contains(out[0], "reservationId") {
		t.Fatalf("unhelpful drift message: %q", out[0])
	}

	unknown := []flow.IvacflowStep{{Name: "SOMETHING NEW", Body: map[string]string{"x": "1"}}}
	if out := compareTemplate(unknown); len(out) != 0 {
		t.Fatalf("a step the bot does not send was flagged: %v", out)
	}
}
