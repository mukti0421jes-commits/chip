package flow

import (
	"encoding/json"
	"strings"
	"time"
)

// ── last-good config (smart-skip scan) ───────────────────────────────────────
//
// A live bundle scan is expensive: download the ~2 MB bundle + run the goja cipher
// deobfuscation (and the ~37 s dg-epay resolve). When the server serves the SAME
// bundle as a previous SUCCESSFUL run, all of that produces the identical result,
// so it is wasted time. After a successful Full Auto we snapshot the resolved
// config here; on the next run, if the live bundle NAME still matches this
// snapshot, Scan reuses it and skips the heavy work. If the bundle changed, the
// name won't match and Scan does a full live scan (and re-snapshots).
//
// SAFETY: reuse happens ONLY on an exact bundle-name match, so a stale cipher is
// never applied to a new bundle.

type lastGoodConfig struct {
	BundleName string            `json:"bundleName"`
	APIBase    string            `json:"apiBase"`
	Endpoints  map[string]string `json:"endpoints"`
	SlotID     string            `json:"slotId"`
	DgepayID   string            `json:"dgepayId"`
	Signin     *PurposeCipher    `json:"signin"`
	Reserve    *PurposeCipher    `json:"reserve"`
	Initiate   *PurposeCipher    `json:"initiate"`
	SavedAt    string            `json:"savedAt"`
}

// serializeLastGood snapshots the resolved config so a same-bundle run can reuse it.
// Returns nil if the config has no cipher yet (nothing worth saving).
func serializeLastGood(c *Config, bundleName string) []byte {
	if c == nil || bundleName == "" || c.Signin == nil || c.Signin.Key == "" {
		return nil
	}
	lg := lastGoodConfig{
		BundleName: baseName(bundleName),
		APIBase:    c.APIBase,
		Endpoints:  map[string]string{},
		SlotID:     c.SlotID,
		DgepayID:   c.DgepayID,
		Signin:     c.Signin,
		Reserve:    c.Reserve,
		Initiate:   c.Initiate,
		SavedAt:    time.Now().Format(time.RFC3339),
	}
	for k, v := range c.Endpoints {
		lg.Endpoints[k] = v
	}
	b, err := json.MarshalIndent(lg, "", "  ")
	if err != nil {
		return nil
	}
	return b
}

// parseLastGood decodes a snapshot; nil on empty/invalid/no-bundle.
func parseLastGood(raw []byte) *lastGoodConfig {
	if len(raw) == 0 {
		return nil
	}
	var lg lastGoodConfig
	if json.Unmarshal(raw, &lg) != nil {
		return nil
	}
	if strings.TrimSpace(lg.BundleName) == "" {
		return nil
	}
	return &lg
}

func (lg *lastGoodConfig) hasCipher() bool {
	return lg != nil && lg.Signin != nil && lg.Signin.Key != ""
}

// applyTo fills the config from the snapshot (only non-empty fields, so it never
// wipes a value the snapshot lacks).
func (lg *lastGoodConfig) applyTo(c *Config) {
	if lg.APIBase != "" {
		c.APIBase = lg.APIBase
	}
	if c.Endpoints == nil {
		c.Endpoints = map[string]string{}
	}
	for k, v := range lg.Endpoints {
		if v != "" {
			c.Endpoints[k] = v
		}
	}
	if lg.SlotID != "" {
		c.SlotID = lg.SlotID
	}
	if lg.DgepayID != "" {
		c.DgepayID = lg.DgepayID
	}
	if lg.Signin != nil {
		c.Signin = lg.Signin
	}
	if lg.Reserve != nil {
		c.Reserve = lg.Reserve
	}
	if lg.Initiate != nil {
		c.Initiate = lg.Initiate
	}
}

// bundleNameMatches reports whether the snapshot's bundle is among the live bundle
// URLs just discovered (basename, case-insensitive).
func bundleNameMatches(storedBundle string, liveURLs []string) bool {
	s := baseName(storedBundle)
	if s == "" {
		return false
	}
	for _, u := range liveURLs {
		if strings.EqualFold(baseName(u), s) {
			return true
		}
	}
	return false
}
