package flow

import "strings"

// ── body/header DRIFT ADAPTER ────────────────────────────────────────────────
//
// extract_fetch.js v15 decodes each endpoint's body-field NAMES and custom header
// NAMES out of the live bundle and writes them into `.endpoint-cache.json` (body:
// "phone,password,c", hdrs: ["x-sec-navigation-state"]). Go's request builders keep
// their PROVEN hardcoded field order — but if IVAC ever RENAMES a field or header,
// the proven names would be wrong and the request would break.
//
// The adapter closes that gap WITHOUT touching the normal path: it compares the
// decoded spec against the proven default and,
//   • when they are equal (the everyday case) → returns the proven names verbatim,
//     so the request is byte-for-byte identical to before; the adapter is a no-op.
//   • when they DIFFER by name only (same count) → returns the decoded names, mapped
//     POSITIONALLY onto the same values, and logs the drift loudly.
//   • when they differ in a way we cannot safely map (different field count, an
//     opaque/FormData/empty spec) → keeps the proven default (never a blind guess).
//
// So the adapter can only ever help; it cannot silently break a working request.

// setEndpointSpec records a decoded body/header spec under a logical key
// ("signin"/"reserve"). Called from ApplyEndpointCache. A blank/opaque spec is
// still stored (the accessors treat it as "no clean spec" and keep the default).
func (c *Config) setEndpointSpec(key, body string, hdrs []string) {
	if c.EndpointSpec == nil {
		c.EndpointSpec = map[string]EndpointSpec{}
	}
	c.EndpointSpec[key] = EndpointSpec{Body: parseBodySpec(body), Hdrs: hdrs}
}

// parseBodySpec splits a cache body string ("phone,password,c") into ordered field
// names. Returns nil when the spec is empty, "null", or NOT a clean comma list of
// identifiers (FormData / parenthesised / decode-failed) — in those cases the caller
// keeps its proven default rather than guessing.
func parseBodySpec(body string) []string {
	body = strings.TrimSpace(body)
	if body == "" || strings.EqualFold(body, "null") {
		return nil
	}
	// opaque markers the extractor emits when it could not resolve clean fields
	if strings.ContainsAny(body, "(){}[]\"'") || strings.Contains(body, "FormData") {
		return nil
	}
	parts := strings.Split(body, ",")
	out := make([]string, 0, len(parts))
	for _, f := range parts {
		f = strings.TrimSpace(f)
		if f == "" || !isCleanIdent(f) {
			return nil
		}
		out = append(out, f)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// isCleanIdent accepts a plain JSON key: letters, digits, '_' or '-', and not
// absurdly long. Anything else means the decode was noisy → keep the default.
func isCleanIdent(s string) bool {
	if len(s) == 0 || len(s) > 40 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
		default:
			return false
		}
	}
	return true
}

// adaptBodyKeys returns the body field names to use for a request. def is the proven
// order; the spec comes from the endpoint cache. It returns def unless the cache
// decoded a DIFFERENT set of the SAME length (a rename), in which case the cache
// names are used positionally. drifted reports whether a remap happened (for logs).
func adaptBodyKeys(def, spec []string, log func(string), label string) (keys []string, drifted bool) {
	if len(spec) == 0 {
		return def, false
	}
	if len(spec) != len(def) {
		// A field was added/removed — we can't map values safely. Keep proven order and
		// warn so the operator knows the cache saw a shape we didn't apply.
		if log != nil {
			log("⚠ " + label + ": cache body [" + strings.Join(spec, ",") + "] field-count != proven [" + strings.Join(def, ",") + "] — proven body rakha holo (nirapod)")
		}
		return def, false
	}
	same := true
	for i := range def {
		if !strings.EqualFold(def[i], spec[i]) {
			same = false
			break
		}
	}
	if same {
		return def, false
	}
	if log != nil {
		log("🔧 " + label + ": IVAC body field rename dhora porlo [" + strings.Join(def, ",") + "] → [" + strings.Join(spec, ",") + "] — auto-adapt (positional)")
	}
	return spec, true
}

// adaptHeader returns the header NAME to use. def is the proven name. If the cache's
// header list already contains def → proven (no-op). Otherwise, if it contains a
// single renamed variant recognisable by `mustContain` (e.g. "navigation") → that
// name, logged. Otherwise → def.
func adaptHeader(def string, spec []string, mustContain string, log func(string), label string) string {
	if len(spec) == 0 {
		return def
	}
	for _, h := range spec {
		if strings.EqualFold(strings.TrimSpace(h), def) {
			return def // proven header present → nothing changed
		}
	}
	lc := strings.ToLower(mustContain)
	for _, h := range spec {
		h = strings.TrimSpace(h)
		if h != "" && strings.Contains(strings.ToLower(h), lc) {
			if log != nil {
				log("🔧 " + label + ": header rename dhora porlo " + def + " → " + h + " — auto-adapt")
			}
			return h
		}
	}
	return def
}

// SigninBodyKeys / SigninNavHeader / ReserveBodyKeys / ReserveMetaHeader are the
// adapter entry points the steps call. Each returns the proven default when there is
// no drift, so the everyday request is unchanged.

func (c *Config) SigninBodyKeys(log func(string)) []string {
	def := []string{"phone", "password", "c"}
	keys, _ := adaptBodyKeys(def, c.EndpointSpec["signin"].Body, log, "signin")
	return keys
}

func (c *Config) SigninNavHeader(log func(string)) string {
	return adaptHeader("x-sec-navigation-state", c.EndpointSpec["signin"].Hdrs, "navigation", log, "signin")
}

func (c *Config) ReserveBodyKeys(log func(string)) []string {
	def := []string{"c", "appointmentDate"}
	keys, _ := adaptBodyKeys(def, c.EndpointSpec["reserve"].Body, log, "reserve")
	return keys
}

func (c *Config) ReserveMetaHeader(log func(string)) string {
	return adaptHeader("x-v-request-meta", c.EndpointSpec["reserve"].Hdrs, "request-meta", log, "reserve")
}
