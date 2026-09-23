package flow

import (
	"strings"
	"testing"
)

// realIvacflow is a trimmed copy of a genuine ivacflow snapshot. Note the two
// traps it carries: reserveSlot / paymentInitiate include the /iams/api/v1
// prefix the other entries lack, and both live ids contain a non-hex character.
const realIvacflow = `{
  "config": {
    "extractedAt": "2026-09-18T19:52:52.506Z",
    "apiBase": "https://api.ivacbd.com/iams/api/v1",
    "endpoints": {
      "signin": "/auth/v3-sign-in",
      "verifySigninOtp": "/otp/verifySigninOtp",
      "uploadFile": "/file/upload_file_v321",
      "overView": "/file/over-view-v421",
      "getBookingConfig": "/appointment/get-booking-config",
      "fileConfirmation": "/file/file-confirmation-and-slot_status",
      "reserveSlot": "/iams/api/v1/slots/139fd4d2-27c9-4758-a623-368583e830bs/reserve-slot",
      "paymentInitiate": "/iams/api/v1/payment/23228961-2326-3s28-861f-465bb28337a3/dg-epay/initiate"
    },
    "slotId": "139fd4d2-27c9-4758-a623-368583e830bs",
    "dgepayUuid": "23228961-2326-3s28-861f-465bb28337a3",
    "ciphers": { "roles": [
      { "role": "Signin",  "version": "10", "algo": "LOGISTIC", "skip": 8, "len": 21, "key": "LIVE-KEY" },
      { "role": "Reserve", "version": "10", "algo": "LOGISTIC", "skip": 8, "len": 21, "key": "LIVE-KEY" }
    ] }
  },
  "template": [
    { "name": "SIGN IN", "method": "POST", "path": "/iams/api/v1/auth/v3-sign-in",
      "headers": { "accept": "application/json, text/plain, */*", "x-sec-navigation-state": "{{ivac:navState}}" },
      "body": { "phone": "{{ivac:phone}}", "password": "{{ivac:password}}", "c": "{{ivac:captcha}}" } },
    { "name": "PAYMENT INITIATE", "method": "POST",
      "path": "/iams/api/v1/payment/23228961-2326-3s28-861f-465bb28337a3/dg-epay/initiate",
      "headers": { "accept": "application/json, text/plain, */*" },
      "body": { "reservationId": "{{ivac:reservationId}}", "amount": "{{ivac:amount}}" } }
  ],
  "bundleName": "mtv1rx02-e9bAiBuo     c.js",
  "at": "9/19/2026, 1:52:54 AM"
}`

func TestParseIvacflowCore(t *testing.T) {
	imp, err := ParseIvacflow([]byte(realIvacflow))
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if imp.Origin != SrcIvacflow {
		t.Fatalf("origin = %q", imp.Origin)
	}
	if imp.SlotID != "139fd4d2-27c9-4758-a623-368583e830bs" {
		t.Fatalf("slot id: %q", imp.SlotID)
	}
	if imp.DgepayID != "23228961-2326-3s28-861f-465bb28337a3" {
		t.Fatalf("dg-epay id: %q", imp.DgepayID)
	}
	if imp.At.IsZero() {
		t.Fatal("extractedAt not parsed")
	}
	if imp.Signin == nil || imp.Signin.Key != "LIVE-KEY" ||
		imp.Signin.Skip != 8 || imp.Signin.Length != 21 || imp.Signin.Version != 10 {
		t.Fatalf("signin cipher: %+v", imp.Signin)
	}
	// one key serving every purpose is the common case
	if imp.Initiate == nil || imp.Initiate.Key != "LIVE-KEY" {
		t.Fatalf("initiate cipher not defaulted: %+v", imp.Initiate)
	}
}

// TestParseIvacflowEndpointMapping: friendly names must land on the family codes
// the flow looks up, and the /iams/api/v1 prefix must be stripped.
func TestParseIvacflowEndpointMapping(t *testing.T) {
	imp, _ := ParseIvacflow([]byte(realIvacflow))
	want := map[string]string{
		"/auth/v2-sign-in":                        "/auth/v3-sign-in",
		"/file/upload_file_v2":                    "/file/upload_file_v321",
		"/file/over-view-v3":                      "/file/over-view-v421",
		"/appointment/get-booking-config":         "/appointment/get-booking-config",
		"/file/file-confirmation_and_slot_status": "/file/file-confirmation-and-slot_status",
	}
	for code, lit := range want {
		if imp.Families[code] != lit {
			t.Errorf("%s = %q, want %q", code, imp.Families[code], lit)
		}
	}
	for code, lit := range imp.Families {
		if strings.Contains(lit, "/iams/api/") {
			t.Errorf("%s kept the api prefix: %q", code, lit)
		}
	}
}

// TestParseIvacflowSkipsPlaceholderHeaders: "{{ivac:navState}}" is a slot to
// fill, not a value — importing it would poison every request.
func TestParseIvacflowSkipsPlaceholderHeaders(t *testing.T) {
	imp, _ := ParseIvacflow([]byte(realIvacflow))
	for k, v := range imp.Headers {
		if strings.Contains(v, "{{") {
			t.Fatalf("placeholder imported as a header value: %s=%s", k, v)
		}
	}
	if imp.Headers["accept"] == "" {
		t.Fatal("a real header value was dropped")
	}
}

func TestLooksLikeIvacflow(t *testing.T) {
	if !LooksLikeIvacflow([]byte(realIvacflow)) {
		t.Fatal("an ivacflow snapshot was not recognised")
	}
	if LooksLikeIvacflow([]byte(realExport)) {
		t.Fatal("an RJ SLOT export was mistaken for an ivacflow snapshot")
	}
	if _, err := ParseIvacflow([]byte(`{"hello":"world"}`)); err == nil {
		t.Fatal("a foreign document was accepted")
	}
}

// TestBundleMatches is the freshness test: a capture taken against a different
// bundle is stale, whatever its timestamp says.
func TestBundleMatches(t *testing.T) {
	imp, _ := ParseIvacflow([]byte(realIvacflow))
	if imp.BundleName != "mtv1rx02-e9bAiBuoc.js" {
		t.Fatalf("bundle name not normalised: %q", imp.BundleName)
	}
	if !imp.BundleMatches("https://appointment.ivacbd.com/assets/mtv1rx02-e9bAiBuoc.js") {
		t.Fatal("the bundle it was extracted from was treated as different")
	}
	if imp.BundleMatches("https://appointment.ivacbd.com/assets/zzz-OTHERBUNDLE.js") {
		t.Fatal("a different bundle was treated as a match")
	}
	if !imp.BundleMatches("") {
		t.Fatal("an unknown live bundle should not invalidate a capture")
	}
}

// TestIvacflowOutranksRecorder is the ladder: with both captures loaded, the
// ivacflow value wins the gaps, because it ran the bundle instead of guessing.
func TestIvacflowOutranksRecorder(t *testing.T) {
	ivf, _ := ParseIvacflow([]byte(realIvacflow))
	rec, _ := ParseImport([]byte(realExport))
	rec.SlotID = "RECORDER-SLOT-ID-aaaaaaaaaaaaaaaaaaa"

	c := NewConfig()
	c.Fallbacks = []*Imported{ivf, rec} // ivacflow first
	c.ApplyImportGaps(EndpointScan{Families: map[string]string{}}, false, nil)

	if c.SlotID != ivf.SlotID {
		t.Fatalf("recorder beat ivacflow for the slot id: %q", c.SlotID)
	}
	if c.Source["slotId"] != SrcIvacflow {
		t.Fatalf("slot id provenance = %q, want ivacflow", c.Source["slotId"])
	}
	if c.Signin.Key != "LIVE-KEY" {
		t.Fatalf("recorder cipher beat ivacflow's: %q", c.Signin.Key)
	}
}

// TestRecorderFillsWhatIvacflowLacks: the second capture still gets its turn on
// anything the first one did not carry.
func TestRecorderFillsWhatIvacflowLacks(t *testing.T) {
	ivf, _ := ParseIvacflow([]byte(realIvacflow))
	delete(ivf.Families, "/auth/v2-sign-in") // ivacflow missed this one
	rec, _ := ParseImport([]byte(realExport))

	c := NewConfig()
	c.Fallbacks = []*Imported{ivf, rec}
	c.ApplyImportGaps(EndpointScan{Families: map[string]string{}}, false, nil)

	if c.Endpoints["/auth/v2-sign-in"] != "/auth/v3-sign-in" {
		t.Fatalf("recorder did not fill what ivacflow lacked: %q", c.Endpoints["/auth/v2-sign-in"])
	}
	if c.Source["ep:/auth/v2-sign-in"] != SrcImport {
		t.Fatalf("provenance = %q, want import", c.Source["ep:/auth/v2-sign-in"])
	}
}

// TestStaleBundleCaptureIsSkipped: a capture for another bundle must not be
// applied at all, however complete it looks.
func TestStaleBundleCaptureIsSkipped(t *testing.T) {
	ivf, _ := ParseIvacflow([]byte(realIvacflow))
	c := NewConfig()
	c.Fallbacks = []*Imported{ivf}
	c.LiveBundleURL = "https://appointment.ivacbd.com/assets/brand-new-bundle.js"
	before := c.SlotID
	c.ApplyImportGaps(EndpointScan{Families: map[string]string{}}, false, nil)

	if c.SlotID != before {
		t.Fatalf("a capture for a different bundle was applied: %q", c.SlotID)
	}
	if id, _ := c.ImportedDgepayID(); id != "" {
		t.Fatalf("stale capture still offered a dg-epay id: %q", id)
	}
}

// TestHeadersOutrankBuiltIn: the bundle scan never produces headers, so there is
// no scan value to defend — a capture must be able to refresh them.
func TestHeadersOutrankBuiltIn(t *testing.T) {
	imp, _ := ParseIvacflow([]byte(realIvacflow))
	imp.Headers["x-sec-navigation-state"] = "NEW-NAV-STATE"
	c := NewConfig()
	if c.NavState == "" {
		t.Fatal("precondition: built-in nav state should be non-empty")
	}
	c.Fallbacks = []*Imported{imp}
	c.ApplyImportGaps(EndpointScan{Families: map[string]string{}}, false, nil)

	if c.NavState != "NEW-NAV-STATE" {
		t.Fatalf("captured nav state did not replace the built-in: %q", c.NavState)
	}
	if c.Source["navState"] != SrcIvacflow {
		t.Fatalf("nav state provenance = %q", c.Source["navState"])
	}
}
