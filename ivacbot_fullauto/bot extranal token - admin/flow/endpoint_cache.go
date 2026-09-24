package flow

import (
	"encoding/json"
	"strings"
)

// ── external endpoint cache (.endpoint-cache.json) ───────────────────────────
//
// extract_fetch.js (v15) is a heavy deobfuscator: in Node it finishes in <1s, but
// inside the bot's goja engine the same run takes ~90s — far too slow to sit in
// front of sign-in. So instead of running it in-process, the operator runs it
// OUTSIDE (runfetch.bat in the autocheck folder) which writes `.endpoint-cache.json`
// and PUSHES it to the bot. The bot stores it and applies it during Scan.
//
// SAFETY: the cache is applied ONLY when its bundleName matches the live bundle the
// scan just downloaded. A cache produced against an older bundle carries stale
// endpoint versions, so on a mismatch the bot ignores it and keeps its own live
// regex scan. This makes the cache a strict upgrade: it can help, never harm.

type endpointCacheFile struct {
	Endpoints []struct {
		Method   string `json:"method"`
		Path     string `json:"path"`
		NormPath string `json:"normPath"`
	} `json:"endpoints"`
	UUIDs struct {
		SlotUUID   string `json:"SLOT_UUID"`
		DgepayUUID string `json:"DGEPAY_UUID"`
	} `json:"uuids"`
	BundleName  string `json:"bundleName"`
	GeneratedAt string `json:"generatedAt"`
}

// EndpointCacheBundleName returns the bundleName a pushed cache was built for (or
// "" if the bytes are not a valid cache), so a push can be acknowledged/logged.
func EndpointCacheBundleName(raw []byte) string {
	var cf endpointCacheFile
	if json.Unmarshal(raw, &cf) != nil {
		return ""
	}
	return strings.TrimSpace(cf.BundleName)
}

// normSep lowercases and strips '-' and '_' so path-version noise (v4-sign_in vs
// v3-sign-in) does not defeat family matching.
func normSep(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, "-", "")
	s = strings.ReplaceAll(s, "_", "")
	return s
}

// endpointCacheRules map a cache endpoint path to a canonical family code. Order
// matters: the more specific rule (verifySigninOtp) must come before the general
// one (verify-otp). Each match func gets the lowercased raw path and its separator-
// stripped form.
var endpointCacheRules = []struct {
	code  string
	match func(raw, norm string) bool
}{
	{"/otp/verifySigninOtp", func(raw, n string) bool { return strings.Contains(n, "verifysigninotp") }},
	{"/otp/signupOtp", func(raw, n string) bool { return strings.Contains(n, "signupotp") }},
	{"/otp/verify-otp", func(raw, n string) bool { return strings.Contains(n, "verifyotp") && !strings.Contains(n, "signin") }},
	{"/auth/v2-sign-in", func(raw, n string) bool { return strings.Contains(raw, "/auth/") && strings.Contains(n, "signin") }},
	{"/file/upload_file_v2", func(raw, n string) bool { return strings.Contains(n, "uploadfile") }},
	{"/file/over-view-v3", func(raw, n string) bool { return strings.Contains(n, "overview") }},
	{"/appointment/appointment-booking-config", func(raw, n string) bool { return strings.Contains(n, "appointmentbookingconfig") }},
	{"/appointment/get-booking-config", func(raw, n string) bool { return strings.Contains(n, "getbookingconfig") }},
	{"/file/file-confirmation_and_slot_status", func(raw, n string) bool { return strings.Contains(n, "fileconfirmation") }},
	{"/file/payment-amount", func(raw, n string) bool { return strings.Contains(n, "paymentamount") }},
}

// baseName returns the file part of a URL/path (drops query and directories).
func baseName(u string) string {
	if i := strings.IndexAny(u, "?#"); i >= 0 {
		u = u[:i]
	}
	if i := strings.LastIndexAny(u, "/\\"); i >= 0 {
		u = u[i+1:]
	}
	return u
}

// ApplyEndpointCache applies a pushed `.endpoint-cache.json` (raw bytes) to the
// config, but ONLY when its bundleName matches liveBundle (basename, case-
// insensitive). On any problem (empty, invalid JSON, bundle mismatch) it does
// nothing so the live regex scan stays in force. Returns true when it applied.
func (c *Config) ApplyEndpointCache(raw []byte, liveBundle string, log func(string)) bool {
	if len(raw) == 0 {
		return false
	}
	var cf endpointCacheFile
	if json.Unmarshal(raw, &cf) != nil {
		if log != nil {
			log("⚠ endpoint-cache: invalid JSON — ignored")
		}
		return false
	}
	cacheBundle := baseName(cf.BundleName)
	liveName := baseName(liveBundle)
	if cacheBundle == "" || liveName == "" || !strings.EqualFold(cacheBundle, liveName) {
		if log != nil {
			log("⏭ endpoint-cache skipped (bundle mismatch: cache=" + cacheBundle + " live=" + liveName + ") — using live regex scan")
		}
		return false
	}
	fams := map[string]string{}
	for _, e := range cf.Endpoints {
		p := strings.TrimSpace(e.Path)
		if p == "" {
			continue
		}
		lp, np := strings.ToLower(p), normSep(p)
		for _, rule := range endpointCacheRules {
			if _, seen := fams[rule.code]; seen {
				continue
			}
			if rule.match(lp, np) {
				fams[rule.code] = p
				break
			}
		}
	}
	if len(fams) == 0 && cf.UUIDs.SlotUUID == "" && cf.UUIDs.DgepayUUID == "" {
		if log != nil {
			log("⚠ endpoint-cache: nothing usable parsed — ignored")
		}
		return false
	}
	for code, lit := range fams {
		c.Endpoints[code] = lit
		c.noteSource("ep:"+code, SrcIvacflow)
	}
	if s := strings.TrimSpace(cf.UUIDs.SlotUUID); s != "" {
		c.SlotID = s
		c.noteSource("slotId", SrcIvacflow)
	}
	if d := strings.TrimSpace(cf.UUIDs.DgepayUUID); d != "" {
		c.DgepayID = d
		c.noteSource("dgepayId", SrcIvacflow)
	}
	if log != nil {
		log("✅ endpoint-cache applied (bundle " + cacheBundle + ", " + itoa(len(fams)) + " endpoints, slot=" + c.SlotID + ", dgepay=" + c.DgepayID + ")")
	}
	return true
}
