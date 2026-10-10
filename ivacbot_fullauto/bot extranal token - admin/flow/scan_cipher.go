package flow

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/dop251/goja"
)

// rjEncResolver is the proven RJ SLOT encryption resolver (resolveBundleConfigs +
// buildBundleResolver + execution fallback). We run it on a pure-Go JS engine
// (goja) so the obfuscated cipher secret is decoded by the EXACT algorithm the
// browser uses — no reimplementation risk.
//
//go:embed rjenc.js
var rjEncResolver string

// CipherScan is the per-purpose cipher config resolved from a bundle.
type CipherScan struct {
	Signin   *PurposeCipher
	Reserve  *PurposeCipher
	Initiate *PurposeCipher
}

type jsPurpose struct {
	Key     string `json:"key"`
	Skip    int    `json:"skip"`
	Length  int    `json:"length"`
	Version int    `json:"version"`
}

func convPurpose(p *jsPurpose) *PurposeCipher {
	if p == nil {
		return nil
	}
	return &PurposeCipher{Key: p.Key, Skip: p.Skip, Length: p.Length, Version: p.Version}
}

const cipherNodeTimeout = 20 * time.Second

// ScanCipher resolves the encryption config (key/skip/length/version per purpose)
// from a bundle by running the PROVEN rjenc.js resolver.
//
// NODE FIRST: V8 runs the ~48KB resolver over a multi-MB bundle ~10-15x faster than
// the pure-Go goja interpreter (measured ~0.1s via node vs ~1.5s via goja on the
// 2.3MB muz358li bundle). Both produce the BYTE-IDENTICAL cipher (same rjenc.js).
// Falls back to the in-process goja engine when node is missing or the run fails,
// so the scan always succeeds whether or not node is on PATH.
func ScanCipher(bundle string) (CipherScan, error) {
	if cs, ok := scanCipherNode(bundle); ok {
		return cs, nil
	}
	return scanCipherGoja(bundle)
}

// scanCipherNode runs rjenc.js's resolveBundleConfigs in a short `node` subprocess.
// Returns (_, false) when node is unavailable / errors / resolves nothing, so the
// caller falls back to goja.
func scanCipherNode(bundle string) (CipherScan, bool) {
	if bundle == "" {
		return CipherScan{}, false
	}
	dir, err := os.MkdirTemp("", "ivac-cipher-")
	if err != nil {
		return CipherScan{}, false
	}
	defer os.RemoveAll(dir)
	// same no-op console shim as the goja path, then the embedded resolver, then a
	// tiny caller that writes the per-purpose cipher config to a JSON file.
	script := "var console={log:function(){},warn:function(){},error:function(){},info:function(){}};\n" +
		rjEncResolver + "\n" +
		"var fs=require('fs');\n" +
		"var r=resolveBundleConfigs(fs.readFileSync(process.argv[2],'utf8'));\n" +
		"var pick=function(p){return p?{key:p.key,skip:p.skip,length:p.length,version:p.version}:null;};\n" +
		"fs.writeFileSync(process.argv[3], JSON.stringify({signin:pick(r.signin),reserve:pick(r.reserve),initiate:pick(r.initiate)}));\n"
	sp := filepath.Join(dir, "cipher.js")
	bp := filepath.Join(dir, "bundle.js")
	op := filepath.Join(dir, "out.json")
	if os.WriteFile(sp, []byte(script), 0644) != nil || os.WriteFile(bp, []byte(bundle), 0644) != nil {
		return CipherScan{}, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), cipherNodeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", sp, bp, op)
	cmd.Dir = dir
	if err := cmd.Run(); err != nil {
		return CipherScan{}, false
	}
	raw, err := os.ReadFile(op)
	if err != nil {
		return CipherScan{}, false
	}
	var out struct {
		Signin   *jsPurpose `json:"signin"`
		Reserve  *jsPurpose `json:"reserve"`
		Initiate *jsPurpose `json:"initiate"`
	}
	if json.Unmarshal(raw, &out) != nil {
		return CipherScan{}, false
	}
	cs := CipherScan{Signin: convPurpose(out.Signin), Reserve: convPurpose(out.Reserve), Initiate: convPurpose(out.Initiate)}
	if cs.Signin == nil || cs.Signin.Key == "" {
		return CipherScan{}, false // node ran but resolved nothing → let goja try
	}
	return cs, true
}

// scanCipherGoja is the in-process fallback (no node dependency).
func scanCipherGoja(bundle string) (CipherScan, error) {
	vm := goja.New()
	// goja has no console; the resolver logs via console.log/warn on decode-fail and
	// sitekey-decoy-skip paths. Provide a no-op shim so those paths don't throw.
	if _, err := vm.RunString("var console={log:function(){},warn:function(){},error:function(){},info:function(){}};\n"); err != nil {
		return CipherScan{}, fmt.Errorf("scan_cipher: console shim: %w", err)
	}
	if _, err := vm.RunString(rjEncResolver + "\nvar __scan = resolveBundleConfigs;\n"); err != nil {
		return CipherScan{}, fmt.Errorf("scan_cipher: eval resolver: %w", err)
	}
	fn, ok := goja.AssertFunction(vm.Get("__scan"))
	if !ok {
		return CipherScan{}, fmt.Errorf("scan_cipher: resolveBundleConfigs missing")
	}
	res, err := fn(goja.Undefined(), vm.ToValue(bundle))
	if err != nil {
		return CipherScan{}, fmt.Errorf("scan_cipher: run resolver: %w", err)
	}
	raw, err := json.Marshal(res.Export())
	if err != nil {
		return CipherScan{}, err
	}
	var out struct {
		Signin   *jsPurpose `json:"signin"`
		Reserve  *jsPurpose `json:"reserve"`
		Initiate *jsPurpose `json:"initiate"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return CipherScan{}, err
	}
	return CipherScan{Signin: convPurpose(out.Signin), Reserve: convPurpose(out.Reserve), Initiate: convPurpose(out.Initiate)}, nil
}

// ApplyCipherScan merges a cipher scan into the config (non-nil purposes only).
func (c *Config) ApplyCipherScan(s CipherScan) {
	if s.Signin != nil {
		c.Signin = s.Signin
	}
	if s.Reserve != nil {
		c.Reserve = s.Reserve
	}
	if s.Initiate != nil {
		c.Initiate = s.Initiate
	}
}
