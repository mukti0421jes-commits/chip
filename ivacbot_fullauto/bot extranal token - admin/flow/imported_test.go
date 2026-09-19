package flow

import (
	"strings"
	"testing"
)

// realExport is a trimmed copy of an actual RJ SLOT "Exp" payload. It is the
// shape the parser must handle, including the trap that motivated this code:
// rj_dyn_captured.slotId / payId are the userscript's HARDCODED fallbacks, while
// the trustworthy value lives in the URL of a recorded, successful request.
const realExport = `{"_t":"rj_dyn_sync","v":1,"at":1789754708927,
"rj_dyn_captured":{
  "epMap":{"/file/upload_file_v2":"/file/upload_file_v321"},
  "headers":{"x-sec-runtime-state":"v1.5a4c8831.9a53.47ed.b579.042a2c0cee5a","authorization":"Bearer SECRET","x-v-request-meta":"windos.s"},
  "fam":{"/auth/v2-sign-in":"/auth/v3-sign-in","/file/over-view-v3":"/file/over-view-v421"},
  "slotId":"719fd4d2-27b9-4758-a523-368582e830ba",
  "payId":"20218968-2226-4e28-861f-465bb28337e6"},
"rj_req_records":{
  "/slots/reserve-slot":{"url":"https://api.ivacbd.com/iams/api/v1/slots/139fd4d2-27c9-4758-a623-368583e830bs/reserve-slot","method":"POST","at":1789021078665},
  "/payment/dg-epay/initiate":{"url":"https://api.ivacbd.com/iams/api/v1/payment/23228961-2326-3s28-861f-465bb28337a3/dg-epay/initiate","method":"POST","at":1789021078665}},
"rj_enc":{"signin":{"key":"KEY-SIGNIN","skip":8,"length":21,"version":10},
          "reserve":{"key":"KEY-RESERVE","skip":"3","length":"20","version":"2"},
          "initiate":null}}`

// TestParseImportPrefersRecordedURLs is the core rule: the two runtime-assembled
// ids must come from a URL that really worked, never from the userscript's
// hardcoded slotId/payId fields.
func TestParseImportPrefersRecordedURLs(t *testing.T) {
	imp, err := ParseImport([]byte(realExport))
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if imp.SlotID != "139fd4d2-27c9-4758-a623-368583e830bs" {
		t.Fatalf("slot id not taken from the recorded URL: %q", imp.SlotID)
	}
	if imp.SlotID == "719fd4d2-27b9-4758-a523-368582e830ba" {
		t.Fatal("slot id was taken from the hardcoded field")
	}
	if imp.DgepayID != "23228961-2326-3s28-861f-465bb28337a3" {
		t.Fatalf("dg-epay id not taken from the recorded URL: %q", imp.DgepayID)
	}
	if imp.DgepayID == "20218968-2226-4e28-861f-465bb28337e6" {
		t.Fatal("dg-epay id was taken from the hardcoded field")
	}
}

// TestParseImportNonHexIDs guards the actual bug: both live ids contain a
// non-hex character, so a hex-only pattern silently drops them.
func TestParseImportNonHexIDs(t *testing.T) {
	imp, _ := ParseImport([]byte(realExport))
	if !strings.HasSuffix(imp.SlotID, "bs") {
		t.Fatalf("non-hex slot id was rejected: %q", imp.SlotID)
	}
	if !strings.Contains(imp.DgepayID, "3s28") {
		t.Fatalf("non-hex dg-epay id was rejected: %q", imp.DgepayID)
	}
}

func TestParseImportEndpointsHeadersCipher(t *testing.T) {
	imp, err := ParseImport([]byte(realExport))
	if err != nil {
		t.Fatal(err)
	}
	if imp.Families["/auth/v2-sign-in"] != "/auth/v3-sign-in" {
		t.Fatalf("fam endpoint missing: %v", imp.Families)
	}
	if imp.Families["/file/upload_file_v2"] != "/file/upload_file_v321" {
		t.Fatalf("epMap did not fill a gap fam left: %v", imp.Families)
	}
	if _, leaked := imp.Headers["authorization"]; leaked {
		t.Fatal("a per-call secret header was imported")
	}
	if imp.Headers["x-v-request-meta"] != "windos.s" {
		t.Fatalf("fixed header missing: %v", imp.Headers)
	}
	if imp.Signin == nil || imp.Signin.Key != "KEY-SIGNIN" || imp.Signin.Skip != 8 {
		t.Fatalf("signin cipher not parsed: %+v", imp.Signin)
	}
	// numbers-as-strings must decode too (they pass through UI inputs)
	if imp.Reserve == nil || imp.Reserve.Skip != 3 || imp.Reserve.Length != 20 || imp.Reserve.Version != 2 {
		t.Fatalf("string-typed cipher numbers not parsed: %+v", imp.Reserve)
	}
	if imp.Initiate != nil {
		t.Fatal("a null cipher should stay nil")
	}
}

func TestParseImportRejectsForeignJSON(t *testing.T) {
	if _, err := ParseImport([]byte(`{"hello":"world"}`)); err == nil {
		t.Fatal("a non-rj_dyn_sync document was accepted")
	}
	if _, err := ParseImport([]byte(`not json at all`)); err == nil {
		t.Fatal("invalid JSON was accepted")
	}
}

// TestParseImportTolerantOfTrailingJunk covers a real paste: two exports
// concatenated, or a truncated tail. The first complete object must still load.
func TestParseImportTolerantOfTrailingJunk(t *testing.T) {
	imp, err := ParseImport([]byte(realExport + `{"url":"truncated tail`))
	if err != nil {
		t.Fatalf("trailing junk broke the parse: %v", err)
	}
	if imp.SlotID == "" {
		t.Fatal("slot id lost when trailing junk was present")
	}
}

// ── gap filling ──────────────────────────────────────────────────────────────

// TestImportFillsOnlyGaps is the precedence rule: a value THIS run's scan
// resolved is never replaced by the import.
func TestImportFillsOnlyGaps(t *testing.T) {
	imp, _ := ParseImport([]byte(realExport))
	c := NewConfig()
	c.Fallbacks = []*Imported{imp}

	// the scan resolved the signin endpoint and the cipher, but not the slot id
	scan := EndpointScan{
		Families: map[string]string{"/auth/v2-sign-in": "/auth/v9-sign-in"},
		SlotID:   "",
	}
	c.Endpoints["/auth/v2-sign-in"] = scan.Families["/auth/v2-sign-in"]
	before := c.Signin.Key
	c.ApplyImportGaps(scan, true, nil)

	if c.Endpoints["/auth/v2-sign-in"] != "/auth/v9-sign-in" {
		t.Fatalf("import overwrote an endpoint the scan resolved: %q", c.Endpoints["/auth/v2-sign-in"])
	}
	if c.Source["ep:/auth/v2-sign-in"] != SrcScan {
		t.Fatalf("scan-resolved endpoint mislabelled: %q", c.Source["ep:/auth/v2-sign-in"])
	}
	if c.Signin.Key != before {
		t.Fatal("import overwrote a cipher the scan resolved")
	}
	if c.SlotID != imp.SlotID {
		t.Fatalf("import did not fill the slot-id gap: %q", c.SlotID)
	}
	if c.Source["slotId"] != SrcImport {
		t.Fatalf("filled slot id mislabelled: %q", c.Source["slotId"])
	}
	// a family the scan missed gets filled from the import
	if c.Endpoints["/file/over-view-v3"] != "/file/over-view-v421" {
		t.Fatalf("import did not fill an endpoint gap: %q", c.Endpoints["/file/over-view-v3"])
	}
}

// TestImportFillsCipherOnlyWhenScanFailed covers the bundle-unreachable case.
func TestImportFillsCipherOnlyWhenScanFailed(t *testing.T) {
	imp, _ := ParseImport([]byte(realExport))
	c := NewConfig()
	c.Fallbacks = []*Imported{imp}
	c.ApplyImportGaps(EndpointScan{Families: map[string]string{}}, false, nil)

	if c.Signin == nil || c.Signin.Key != "KEY-SIGNIN" {
		t.Fatalf("cipher gap not filled: %+v", c.Signin)
	}
	if c.Source["cipher"] != SrcImport {
		t.Fatalf("cipher source mislabelled: %q", c.Source["cipher"])
	}
	if id, _ := c.ImportedDgepayID(); id != "23228961-2326-3s28-861f-465bb28337a3" {
		t.Fatalf("dg-epay id not exposed for the initiate fallback: %q", id)
	}
}

// TestNoImportChangesNothing: with no capture loaded the config is untouched —
// the normal day must behave exactly as before.
func TestNoImportChangesNothing(t *testing.T) {
	c := NewConfig()
	slot, key := c.SlotID, c.Signin.Key
	c.ApplyImportGaps(EndpointScan{Families: map[string]string{}}, false, nil)
	if c.SlotID != slot || c.Signin.Key != key {
		t.Fatal("config changed even though no capture was imported")
	}
	if c.Source["slotId"] != SrcBuiltIn {
		t.Fatalf("unresolved slot id should read built-in, got %q", c.Source["slotId"])
	}
}

// TestSummaryFlagsMissingPieces: an export with no reserve-slot record must say
// so, since that is the single most common reason this whole path fails.
func TestSummaryFlagsMissingPieces(t *testing.T) {
	const noReserve = `{"_t":"rj_dyn_sync","v":1,"at":1789754708927,
	"rj_dyn_captured":{"fam":{},"headers":{},"slotId":"719fd4d2-27b9-4758-a523-368582e830ba"},
	"rj_req_records":{}}`
	imp, err := ParseImport([]byte(noReserve))
	if err != nil {
		t.Fatal(err)
	}
	if imp.SlotID != "" {
		t.Fatalf("slot id invented from the hardcoded field: %q", imp.SlotID)
	}
	if !strings.Contains(imp.Summary(), "slot=MISSING") {
		t.Fatalf("summary did not flag the missing slot id: %s", imp.Summary())
	}
}
