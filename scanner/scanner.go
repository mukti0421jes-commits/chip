// Package scanner resolves the RJ SLOT encryption configuration (key, skip,
// length, version per purpose) from a live site JavaScript bundle.
//
// The site ships a heavily obfuscated Vite bundle: the cipher secrets are hidden
// behind a decoder cluster (base64/RC4 over a rotated string array). Rather than
// re-implement that obfuscation resolver in Go — subtle, easy to get wrong, and
// prone to breaking on every bundle variation — this package embeds the proven
// reference resolver (rjslotencryptionmodule.js) and runs it on a pure-Go
// JavaScript engine (goja). The scan therefore executes the exact same algorithm
// the browser userscript does, so its output matches the site byte-for-byte.
package scanner

import (
	_ "embed"
	"encoding/json"
	"fmt"

	"github.com/dop251/goja"

	"github.com/mukti0421jes-commits/chip/cipher"
)

//go:embed rjslotencryptionmodule.js
var resolverJS string

// PurposeConfig is a resolved cipher configuration for a single purpose.
type PurposeConfig struct {
	Key     string `json:"key"`
	Skip    int    `json:"skip"`
	Length  int    `json:"length"`
	Version int    `json:"version"`
}

// Config holds the cipher configuration for each purpose resolved from a bundle.
// A purpose is nil when the bundle carried no config for it.
type Config struct {
	Signin   *PurposeConfig `json:"signin"`
	Reserve  *PurposeConfig `json:"reserve"`
	Initiate *PurposeConfig `json:"initiate"`
}

// ScanBundle resolves the cipher configuration from the JavaScript bundle text.
// It returns an error only when the bundle cannot be evaluated; a bundle with no
// recognizable config yields a Config whose purposes are all nil.
func ScanBundle(bundleText string) (Config, error) {
	vm := goja.New()
	if _, err := vm.RunString(resolverJS + "\nvar __scan = resolveBundleConfigs;\n"); err != nil {
		return Config{}, fmt.Errorf("scanner: evaluate resolver: %w", err)
	}
	fn, ok := goja.AssertFunction(vm.Get("__scan"))
	if !ok {
		return Config{}, fmt.Errorf("scanner: resolveBundleConfigs not found in resolver")
	}
	res, err := fn(goja.Undefined(), vm.ToValue(bundleText))
	if err != nil {
		return Config{}, fmt.Errorf("scanner: run resolveBundleConfigs: %w", err)
	}
	// Marshal the JS result object back through JSON for a clean Go decode.
	raw, err := json.Marshal(res.Export())
	if err != nil {
		return Config{}, fmt.Errorf("scanner: encode result: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return Config{}, fmt.Errorf("scanner: decode result: %w", err)
	}
	return cfg, nil
}

// Apply pushes a resolved Config into the cipher package's global configuration.
// Only non-nil purposes are applied, so a partial scan never clears a previously
// resolved purpose. It reports whether anything was applied.
func (c Config) Apply() bool {
	applied := false
	if c.Signin != nil {
		cipher.SetSignInCipherConfig(c.Signin.Version, c.Signin.Key, c.Signin.Skip, c.Signin.Length)
		applied = true
	}
	if c.Reserve != nil {
		cipher.SetReserveCipherConfig(c.Reserve.Version, c.Reserve.Key, c.Reserve.Skip, c.Reserve.Length)
		applied = true
	}
	if c.Initiate != nil {
		cipher.SetInitiateCipherConfig(c.Initiate.Version, c.Initiate.Key, c.Initiate.Skip, c.Initiate.Length)
		applied = true
	}
	return applied
}
