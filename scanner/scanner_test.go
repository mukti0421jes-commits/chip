package scanner

import (
	"os"
	"testing"
)

// TestScanRealBundle verifies the scanner against a real captured IVAC bundle.
// The bundle is not committed (it is third-party site code); drop one at
// testdata/bundle.js to run this test. It is skipped when absent.
func TestScanRealBundle(t *testing.T) {
	data, err := os.ReadFile("testdata/bundle.js")
	if err != nil {
		t.Skip("testdata/bundle.js not present; skipping real-bundle scan test")
	}
	cfg, err := ScanBundle(string(data))
	if err != nil {
		t.Fatalf("ScanBundle failed: %v", err)
	}
	if cfg.Signin == nil || cfg.Reserve == nil || cfg.Initiate == nil {
		t.Fatalf("expected all purposes resolved, got %+v", cfg)
	}
	// Ground truth extracted by running the reference JS resolver directly.
	const wantKey = "AO0BflM#Ic>5<TsOQlrGvf$2YaNu+q98GU2HlrS&Oi!7`ZyUWrxMbl*4EgTa]w10"
	for name, pc := range map[string]*PurposeConfig{
		"signin": cfg.Signin, "reserve": cfg.Reserve, "initiate": cfg.Initiate,
	} {
		if pc.Key != wantKey {
			t.Errorf("%s key mismatch:\n got  %q\n want %q", name, pc.Key, wantKey)
		}
		if pc.Skip != 5 || pc.Length != 24 || pc.Version != 1 {
			t.Errorf("%s params mismatch: got skip=%d len=%d v=%d, want 5/24/1", name, pc.Skip, pc.Length, pc.Version)
		}
	}

	if !cfg.Apply() {
		t.Fatal("Apply reported nothing applied")
	}
}
