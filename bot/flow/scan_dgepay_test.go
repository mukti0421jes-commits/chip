package flow

import (
	"os"
	"testing"
)

func TestScanDgEpayRealBundle(t *testing.T) {
	b, err := os.ReadFile("testbundle_full.js")
	if err != nil {
		t.Skip("testbundle_full.js not present")
	}
	// ScanDgEpay now returns the FULL payment-initiate PATH (the gateway switched
	// from dg-epay to SSLCommerz). For this legacy dg-epay bundle that path still
	// embeds the uuid.
	got := ScanDgEpay(string(b))
	want := "/payment/20218968-2226-4e28-861f-465bb28337e6/dg-epay/initiate"
	if got != want {
		t.Fatalf("initiate path = %q, want %q", got, want)
	}
	t.Logf("✅ initiate path resolved byte-accurately: %s", got)
}
