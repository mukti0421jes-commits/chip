package flow

import (
	"os"
	"testing"
	"time"
)

const bPath = "/root/.claude/uploads/bf3c8f2c-e414-5e47-b0f2-65f4196bd38b/e7deb00c-muz358li-SUslH98Q.js"

func TestCipherNodeMatchesGojaAndFaster(t *testing.T) {
	b, err := os.ReadFile(bPath)
	if err != nil {
		t.Skip("bundle not present")
	}
	bundle := string(b)

	st := time.Now()
	nc, okN := scanCipherNode(bundle)
	dN := time.Since(st)
	if !okN || nc.Signin == nil {
		t.Fatal("node cipher failed")
	}
	st = time.Now()
	gc, err := scanCipherGoja(bundle)
	dG := time.Since(st)
	if err != nil || gc.Signin == nil {
		t.Fatalf("goja cipher failed: %v", err)
	}
	// byte-identical?
	if nc.Signin.Key != gc.Signin.Key || nc.Signin.Skip != gc.Signin.Skip ||
		nc.Signin.Length != gc.Signin.Length || nc.Signin.Version != gc.Signin.Version {
		t.Fatalf("node != goja:\n node=%+v\n goja=%+v", *nc.Signin, *gc.Signin)
	}
	t.Logf("✓ MATCH signin: key=%q skip=%d len=%d ver=%d", nc.Signin.Key, nc.Signin.Skip, nc.Signin.Length, nc.Signin.Version)
	t.Logf("✓ TIMING  node=%v   goja=%v   (node %.1fx faster)", dN, dG, float64(dG)/float64(dN))

	// ScanCipher is node-first → must equal node output
	cs, err := ScanCipher(bundle)
	if err != nil || cs.Signin == nil || cs.Signin.Key != nc.Signin.Key {
		t.Fatalf("ScanCipher (node-first) wrong: %v", err)
	}
	t.Logf("✓ ScanCipher (node-first) OK")
}
