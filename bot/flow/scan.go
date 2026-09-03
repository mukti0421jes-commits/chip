package flow

import "regexp"

// Endpoint family — byte-exact from RJ SLOT v10.5 RJ_EP_FAMILIES. `Code` is the
// canonical path; `Re` finds the bundle's current literal for that family.
type epFamily struct {
	Code string
	Re   *regexp.Regexp
}

// epFamilies mirrors RJ_EP_FAMILIES (Go's (?i) == JS /i). Order preserved.
var epFamilies = []epFamily{
	{"/auth/v2-sign-in", regexp.MustCompile(`(?i)/auth/[a-z0-9-]*sign-?in[a-z0-9-]*`)},
	{"/file/upload_file_v2", regexp.MustCompile(`(?i)/file/upload_file[a-z0-9_-]*`)},
	{"/otp/verify-otp", regexp.MustCompile(`(?i)/otp/verify-otp[a-z0-9_-]*`)},
	{"/otp/verifySigninOtp", regexp.MustCompile(`(?i)/otp/verifySigninOtp[a-z0-9_-]*`)},
	{"/otp/signupOtp", regexp.MustCompile(`(?i)/otp/signupOtp[a-z0-9_-]*`)},
	{"/appointment/get-booking-config", regexp.MustCompile(`(?i)/appointment/get-booking-config[a-z0-9_-]*`)},
	{"/appointment/appointment-booking-config", regexp.MustCompile(`(?i)/appointment/appointment-booking-config[a-z0-9_-]*`)},
	{"/file/over-view-v3", regexp.MustCompile(`(?i)/file/over-view[a-z0-9_-]*`)},
	{"/file/file-confirmation_and_slot_status", regexp.MustCompile(`(?i)/file/file-confirmation[a-z0-9_-]*`)},
	{"/file/payment-amount", regexp.MustCompile(`(?i)/file/payment-amount[a-z0-9_-]*`)},
}

// detectApiBaseUrl patterns — byte-exact from RJ SLOT v10.5 detectApiBaseUrl.
var apiBasePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)["'](https?://[^"']+?/iams/api/v\d+)["']`),
	regexp.MustCompile(`(?i)["'](https?://[^"']+?/api/v\d+)["']`),
	regexp.MustCompile(`(?i)BASE_URL\s*=\s*["'](https?://[^"']+)["']`),
	regexp.MustCompile(`(?i)baseURL\s*:\s*["'](https?://[^"']+)["']`),
}

// slotIDRe mirrors /\/slots\/([0-9a-fA-F-]{36})\/reserve-slot/ from rjResolveEndpointsLive.
var slotIDRe = regexp.MustCompile(`/slots/([0-9a-fA-F-]{36})/reserve-slot`)

// EndpointScan is the plain-text (non-obfuscated) part of the live scan: API base,
// per-family endpoint literals, and the reserve slot id. Encryption config and the
// obfuscated dg-epay id are resolved separately (goja resolver).
type EndpointScan struct {
	APIBase  string            // detectApiBaseUrl()
	Families map[string]string // family code -> current bundle literal
	SlotID   string            // reserve slot uuid ("" if not in this chunk)
}

// ScanEndpoints runs the plain-regex part of the scan on a bundle chunk, exactly
// as RJ SLOT v10.5 does in rjResolveEndpointsLive + detectApiBaseUrl.
func ScanEndpoints(bundle string) EndpointScan {
	out := EndpointScan{Families: map[string]string{}}
	out.APIBase = detectAPIBase(bundle)
	for _, f := range epFamilies {
		if m := f.Re.FindString(bundle); m != "" {
			out.Families[f.Code] = m
		}
	}
	if m := slotIDRe.FindStringSubmatch(bundle); m != nil {
		out.SlotID = m[1]
	}
	return out
}

// detectAPIBase mirrors detectApiBaseUrl(): first matching pattern wins; if the
// match lacks an /api/v segment, append one found nearby, else default /api/v1.
func detectAPIBase(src string) string {
	for _, p := range apiBasePatterns {
		loc := p.FindStringSubmatchIndex(src)
		if loc == nil {
			continue
		}
		url := src[loc[2]:loc[3]]
		if !containsAny(url, "/api/v", "/iams/api") {
			if len(url) > 0 && url[len(url)-1] == '/' {
				url = url[:len(url)-1]
			}
			start := loc[0] - 200
			if start < 0 {
				start = 0
			}
			end := loc[1] + 200
			if end > len(src) {
				end = len(src)
			}
			ctx := src[start:end]
			apiM := regexp.MustCompile(`(?i)(/iams/api/v\d+|/api/v\d+)`).FindString(ctx)
			if apiM != "" {
				url += apiM
			} else {
				url += "/api/v1"
			}
		}
		return url
	}
	return "https://api.ivacbd.com/iams/api/v1"
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if idx := indexOf(s, sub); idx >= 0 {
			return true
		}
	}
	return false
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
