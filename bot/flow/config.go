package flow

import "strings"

// Config is the live, scan-driven configuration the flow runs against. Everything
// the site changes (endpoint versions, slot id, dg-epay id, encryption secrets,
// dynamic headers) lives here. It is filled by the live scan; hardcoded canonical
// values act only as a fallback when the scan hasn't resolved a piece yet.
//
// This is the Go equivalent of RJ SLOT's RJ_DYN + encConfig + API_BASE_URL.
type Config struct {
	APIBase   string            // detectApiBaseUrl(), default APIBase const
	Endpoints map[string]string // family code -> current bundle literal (scanned)
	SlotID    string            // reserve slot uuid (scanned)
	DgepayID  string            // legacy dg-epay payment-method uuid (obsolete after the SSL switch)
	// InitiatePath is the full payment-initiate path pulled from the bundle by the
	// extractor. IVAC switched the gateway from dg-epay (/payment/<uuid>/dg-epay/
	// initiate) to SSLCommerz (/payment/ssl/initiate — a FIXED path, no uuid). The
	// extractor decodes whichever the current build uses; default is the SSL path.
	InitiatePath string

	// Manual overrides from the dashboard. When non-empty these WIN over the live
	// scan (used when the scan can't resolve an id, or to force a specific one).
	ForcedSlotID   string
	ForcedDgepayID string

	// dynamic headers learned from the bundle / site traffic
	NavState     string // x-sec-navigation-state
	RuntimeState string // x-sec-runtime-state
	VRequestMeta string // x-v-request-meta  (default "windos.s")
	DeviceID     string // x-device-id (random 20-char, persisted; getDeviceId)

	// encryption config per purpose (from resolveBundleConfigs)
	Signin   *PurposeCipher
	Reserve  *PurposeCipher
	Initiate *PurposeCipher
}

// PurposeCipher is one resolved cipher config (key/skip/length/version).
type PurposeCipher struct {
	Key     string
	Skip    int
	Length  int
	Version int
}

// NewConfig returns a Config with current known-good fallbacks in place. The live
// scan overwrites these when the bundle is reachable; when the site's Cloudflare
// 403s the bundle fetch, these keep the pipeline on the CURRENT endpoints/uuids
// (captured from the live bundle 2026-08) instead of stale ones.
func NewConfig() *Config {
	return &Config{
		APIBase: "https://api.ivacbd.com/iams/api/v1",
		Endpoints: map[string]string{
			"/auth/v2-sign-in":     "/auth/v3-sign-in",
			"/file/upload_file_v2": "/file/upload_file_v321",
			"/file/over-view-v3":   "/file/over-view-v421",
			"/otp/verifySigninOtp": "/otp/verifySigninOtp",
			"/file/file-confirmation_and_slot_status": "/file/file-confirmation-and-slot_status",
		},
		SlotID:       "139fd4d2-27c9-4758-a623-368583e830bs",
		DgepayID:     "23228961-2326-3s28-861f-465bb28337a3", // live dg-epay uuid (from a real 2026-09 initiate request)
		VRequestMeta: "windos.s",
		// x-sec-* security headers (RJ SLOT constants). WITHOUT a valid nav-state
		// the server accepts the request but returns {data:null,"Success"} — no
		// session — so these must be sent on sign-in / upload.
		NavState:     "80d51dc5-af20-46fa-a7bb-e6a8f3f80065",
		RuntimeState: "v1.5a4c8831.9a53.47ed.b579.042a2c0cee5a",
		// cipher fallback (from live bundle 2026-09: version 10 / skip 8 / len 21)
		// so signin/reserve can still encrypt the captcha token into body `c` when
		// the bundle is unreachable.
		Signin:   &PurposeCipher{Key: fallbackCipherKey, Skip: 8, Length: 21, Version: 10},
		Reserve:  &PurposeCipher{Key: fallbackCipherKey, Skip: 8, Length: 21, Version: 10},
		Initiate: &PurposeCipher{Key: fallbackCipherKey, Skip: 8, Length: 21, Version: 10},
	}
}

// fallbackCipherKey is the current bundle's captcha-token cipher key (live 2026-09).
const fallbackCipherKey = "Ak*a]5XJI8VhKgXkQwaE$fAQYG2IAYYkGq+g;7DPO0BnQmDqWcgK*lGWEM4OGEEq"

// ApplyEndpointScan merges a plain-regex scan result into the config.
func (c *Config) ApplyEndpointScan(s EndpointScan) {
	if s.APIBase != "" {
		c.APIBase = s.APIBase
	}
	for k, v := range s.Families {
		c.Endpoints[k] = v
	}
	if s.SlotID != "" {
		c.SlotID = s.SlotID
	}
}

// ep returns the scanned live literal for a family code, or the canonical code
// itself as fallback (mirrors RJ SLOT: rewrite to the bundle's current literal,
// fall back to the hardcoded family code when nothing was scanned).
func (c *Config) ep(familyCode string) string {
	if v, ok := c.Endpoints[familyCode]; ok && v != "" {
		return v
	}
	return familyCode
}

// join concatenates the API base and a path, avoiding a double slash.
func (c *Config) join(path string) string {
	base := strings.TrimRight(c.APIBase, "/")
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return base + path
}

// ── URL resolvers (scanned literal → full URL), used by the request builders ──

// SigninURL → .../auth/v26-sign-in (whatever the bundle currently uses).
func (c *Config) SigninURL() string { return c.join(c.ep("/auth/v2-sign-in")) }

// VerifyURL → .../otp/verifySigninOtp.
func (c *Config) VerifyURL() string { return c.join(c.ep("/otp/verifySigninOtp")) }

// BookURL → .../appointment/get-booking-config.
func (c *Config) BookURL() string { return c.join(c.ep("/appointment/get-booking-config")) }

// ReserveURLFor builds the reserve URL from the scanned slot id (path param).
func (c *Config) ReserveURLFor() string {
	slot := c.SlotID
	if slot == "" {
		slot = "{slotId}"
	}
	return c.join("/slots/" + slot + "/reserve-slot")
}

// InitiateURLFor builds the payment-initiate URL: /payment/<dg-epay uuid>/dg-epay/
// initiate — confirmed byte-exact against a live browser request. The dg-epay uuid
// is an obfuscated, non-hex value assembled at runtime (e.g. "23228961-2326-3s28-
// 861f-465bb28337a3" — note the 's'), so it never appears as plaintext in the
// bundle. A manual dashboard override (ForcedDgepayID) wins; else the scanned /
// fallback DgepayID is used.
func (c *Config) InitiateURLFor() string {
	id := c.DgepayID
	if c.ForcedDgepayID != "" {
		id = c.ForcedDgepayID
	}
	if id != "" {
		return c.join("/payment/" + id + "/dg-epay/initiate")
	}
	// last resort: whatever initiate path the extractor decoded.
	if c.InitiatePath != "" {
		return c.join(c.InitiatePath)
	}
	return c.join("/payment/{dgepayId}/dg-epay/initiate")
}
