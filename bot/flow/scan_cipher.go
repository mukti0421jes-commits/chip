package flow

import (
	_ "embed"
	"encoding/json"
	"fmt"

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

// ScanCipher resolves the encryption config (key/skip/length/version per purpose)
// from a bundle chunk using the embedded RJ SLOT resolver via goja.
func ScanCipher(bundle string) (CipherScan, error) {
	vm := goja.New()
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
	conv := func(p *jsPurpose) *PurposeCipher {
		if p == nil {
			return nil
		}
		return &PurposeCipher{Key: p.Key, Skip: p.Skip, Length: p.Length, Version: p.Version}
	}
	return CipherScan{Signin: conv(out.Signin), Reserve: conv(out.Reserve), Initiate: conv(out.Initiate)}, nil
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
