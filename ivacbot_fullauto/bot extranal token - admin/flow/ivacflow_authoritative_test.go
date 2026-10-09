package flow

import (
	"strings"
	"testing"
)

// TestDefaultsAreBlank: slot id and dg-epay uuid start EMPTY by design, so a
// stale hardcoded id can never be used. They are filled by the live scan, then
// overwritten by an ivacflow push when the two differ.
func TestDefaultsAreBlank(t *testing.T) {
	c := NewConfig()
	if c.SlotID != "" {
		t.Fatalf("slot id default should be blank, got %q", c.SlotID)
	}
	if c.DgepayID != "" {
		t.Fatalf("dg-epay uuid default should be blank, got %q", c.DgepayID)
	}
}

// TestIvacflowOverridesScannedSlotAndDgepay is the user's precedence rule: the
// live scan fills slot/dg-epay first; an ivacflow push that DIFFERS then wins and
// is what the reserve/initiate URLs use — over the scan AND a manual override.
func TestIvacflowOverridesScannedSlotAndDgepay(t *testing.T) {
	ivf, err := ParseIvacflow([]byte(realIvacflow)) // slot 139fd4d2-…-bs, dg-epay 23228961-…-a3
	if err != nil {
		t.Fatal(err)
	}

	c := NewConfig()
	c.Fallbacks = []*Imported{ivf}
	// the live scan resolved DIFFERENT ids…
	c.SlotID = "SCAN-SLOT-aaaaaaaaaaaaaaaaaaaaaa"
	// …and a stale manual dg-epay override is sitting on the dashboard.
	c.ForcedDgepayID = "FORCED-DGEPAY-bbbbbbbbbbbbbbbbbb"
	scan := EndpointScan{Families: map[string]string{}, SlotID: c.SlotID}

	c.ApplyImportGaps(scan, true, nil)

	// slot: ivacflow overrides the scanned value.
	if c.SlotID != ivf.SlotID {
		t.Fatalf("ivacflow did not override scanned slot: got %q want %q", c.SlotID, ivf.SlotID)
	}
	if c.Source["slotId"] != SrcIvacflow {
		t.Fatalf("slot provenance = %q, want ivacflow", c.Source["slotId"])
	}
	if c.IvacflowSlotID != ivf.SlotID {
		t.Fatalf("sticky IvacflowSlotID not set: %q", c.IvacflowSlotID)
	}
	if u := c.ReserveURLFor(); !strings.Contains(u, ivf.SlotID) {
		t.Fatalf("reserve URL did not use the ivacflow slot: %q", u)
	}

	// dg-epay: ivacflow wins over the manual override in the initiate URL.
	if c.DgepayID != ivf.DgepayID || c.IvacflowDgepayID != ivf.DgepayID {
		t.Fatalf("ivacflow dg-epay not applied: DgepayID=%q sticky=%q", c.DgepayID, c.IvacflowDgepayID)
	}
	u := c.InitiateURLFor()
	if !strings.Contains(u, ivf.DgepayID) || strings.Contains(u, "FORCED-DGEPAY") {
		t.Fatalf("initiate URL did not prefer ivacflow dg-epay over the manual override: %q", u)
	}
}

// TestIvacflowSameValueKeepsWorking: when the ivacflow push MATCHES what the scan
// already resolved, nothing changes and the URLs still carry that value.
func TestIvacflowSameValueKeepsWorking(t *testing.T) {
	ivf, _ := ParseIvacflow([]byte(realIvacflow))
	c := NewConfig()
	c.Fallbacks = []*Imported{ivf}
	c.SlotID = ivf.SlotID // scan already found the same id
	scan := EndpointScan{Families: map[string]string{}, SlotID: ivf.SlotID}

	c.ApplyImportGaps(scan, true, nil)

	if c.SlotID != ivf.SlotID {
		t.Fatalf("same-value slot changed: %q", c.SlotID)
	}
	if u := c.ReserveURLFor(); !strings.Contains(u, ivf.SlotID) {
		t.Fatalf("reserve URL wrong: %q", u)
	}
}
