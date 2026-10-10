package flow

import (
	"os"
	"strings"
	"testing"
)

// TestRealIvacflowPush_FullAutoReadiness loads the ACTUAL values.json the updated
// ivacflow pushes (bundle muz358li) and proves, end to end, what the bot gets from
// it: parse, the authoritative slot/dg-epay override, cipher, endpoints and the
// reserve/initiate URLs. This is the byte-level answer to "is this enough for the
// full-auto flow (data-wise)".
func TestRealIvacflowPush_FullAutoReadiness(t *testing.T) {
	raw, err := os.ReadFile("testdata_real_values.json")
	if err != nil {
		t.Skip("real values.json not present")
	}
	if !LooksLikeIvacflow(raw) {
		t.Fatal("not recognised as an ivacflow snapshot")
	}
	imp, err := ParseIvacflow(raw)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}

	// ── ids ──
	const wantSlot = "539fd5i2-27a9-4928-a103-278583e830bs"
	const wantDg = "1c228961-2324-3s28-861h-465sb28327b3"
	if imp.SlotID != wantSlot {
		t.Fatalf("slot id = %q, want %q", imp.SlotID, wantSlot)
	}
	if imp.DgepayID != wantDg {
		t.Fatalf("dg-epay uuid = %q, want %q", imp.DgepayID, wantDg)
	}

	// ── cipher (version empty in JSON → algo CELLULAR must map to 3) ──
	if imp.Signin == nil {
		t.Fatal("signin cipher missing")
	}
	if imp.Signin.Version != 3 || imp.Signin.Skip != 7 || imp.Signin.Length != 27 {
		t.Fatalf("cipher = ver%d skip%d len%d, want ver3 skip7 len27", imp.Signin.Version, imp.Signin.Skip, imp.Signin.Length)
	}
	if imp.Reserve == nil || imp.Initiate == nil {
		t.Fatal("reserve/initiate cipher not defaulted from signin")
	}

	// ── endpoints that ivacflow DID map (friendly key → family code) ──
	wantEP := map[string]string{
		"/file/upload_file_v2":            "/file/upload-file_v5",
		"/file/over-view-v3":              "/file/over_view-v5",
		"/appointment/appointment-booking-config": "/appointment/appointment-booking-config",
		"/appointment/get-booking-config": "/appointment/get-booking-config",
	}
	for code, want := range wantEP {
		if imp.Families[code] != want {
			t.Errorf("endpoint %s = %q, want %q", code, imp.Families[code], want)
		}
	}
	// OTP-verify endpoint: ivacflow leaves it OUT of `endpoints`, but the fill from
	// allEndpoints now recovers it (version/separator-proof) — so the push alone is
	// enough, no live scan required for this one either.
	if got := imp.Families["/otp/verifySigninOtp"]; got != "/otp/v5_verify_Signin_Otp" {
		t.Fatalf("OTP-verify endpoint not recovered from allEndpoints: %q", got)
	}
	t.Logf("OTP-verify endpoint recovered: %s", imp.Families["/otp/verifySigninOtp"])

	// ── apply as an authoritative ivacflow push, on top of a DIFFERENT scan ──
	c := NewConfig()
	c.Fallbacks = []*Imported{imp}
	c.SlotID = "SCAN-RESOLVED-DIFFERENT-SLOT-aaaa"          // pretend the live scan found another id
	c.ForcedDgepayID = "STALE-MANUAL-DGEPAY-bbbbbbbbbbbb"   // and a stale manual override exists
	c.ApplyImportGaps(EndpointScan{Families: map[string]string{}, SlotID: c.SlotID}, true, nil)

	if c.SlotID != wantSlot || c.IvacflowSlotID != wantSlot {
		t.Fatalf("ivacflow slot not authoritative: SlotID=%q sticky=%q", c.SlotID, c.IvacflowSlotID)
	}
	if c.IvacflowDgepayID != wantDg {
		t.Fatalf("ivacflow dg-epay not authoritative: %q", c.IvacflowDgepayID)
	}
	rURL := c.ReserveURLFor()
	iURL := c.InitiateURLFor()
	if !strings.Contains(rURL, wantSlot) {
		t.Fatalf("reserve URL does not carry ivacflow slot: %q", rURL)
	}
	if !strings.Contains(iURL, wantDg) || strings.Contains(iURL, "STALE-MANUAL") {
		t.Fatalf("initiate URL wrong (manual override not beaten): %q", iURL)
	}
	t.Logf("reserve  URL: %s", rURL)
	t.Logf("initiate URL: %s", iURL)
}
