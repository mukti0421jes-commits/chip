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
	got := ScanDgEpay(string(b))
	want := "20218968-2226-4e28-861f-465bb28337e6"
	if got != want {
		t.Fatalf("dg-epay uuid = %q, want %q", got, want)
	}
	t.Logf("✅ dg-epay UUID resolved byte-accurately: %s", got)
}
