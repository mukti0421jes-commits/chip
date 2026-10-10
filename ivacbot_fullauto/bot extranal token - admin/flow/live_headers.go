package flow

import "strings"

// ──────────────────────────────────────────────────────────────────────────────
// LIVE HEADER MERGE
//
// Every step's request passes through Runner.Do. When ivacflow has pushed a
// per-step template, applyLiveHeaders rebuilds the request's header SET from what
// ivacflow OBSERVED LIVE on the real site — so the bot stops carrying a hardcoded
// header set of its own. The step still computes the session/request VALUES
// (token, captcha, nav-state, boundary…); the push decides WHICH headers to send
// and their STATIC values (accept, content-type, cache-control, pragma…).
//
// Two things are deliberately NOT taken from the push:
//   - environment / fingerprint headers (user-agent, sec-ch-ua*): ivacflow captures
//     these from its own HeadlessChrome, which is NOT the bot's client — copying them
//     would corrupt the bot's identity. The bot keeps its own.
//   - per-call VALUES: the template only marks that a dynamic header is PRESENT; the
//     value is copied from what the step already set, never from the template's
//     placeholder ("{{ivac:…}}") or mock.
//
// No matching template → the request is left exactly as the step built it (fallback),
// so behaviour is unchanged when ivacflow has not pushed.
// ──────────────────────────────────────────────────────────────────────────────

// envLiveHeader: fingerprint headers the bot always supplies itself.
var envLiveHeader = map[string]bool{
	"user-agent": true, "sec-ch-ua": true, "sec-ch-ua-mobile": true,
	"sec-ch-ua-platform": true, "sec-fetch-site": true, "sec-fetch-mode": true,
	"sec-fetch-dest": true, "sec-fetch-user": true,
}

// dropLiveHeader: transport headers that must never be set from a template.
var dropLiveHeader = map[string]bool{
	"host": true, "content-length": true, "connection": true,
	"accept-encoding": true, "cookie": true, "referer": true, "origin": true,
}

// dynLiveHeader: per-call headers whose VALUE is session/request specific — the
// template says they're present, but the value comes from the step (req.Headers).
var dynLiveHeader = map[string]bool{
	"authorization": true, "x-token": true, "x-sec-navigation-state": true,
	"x-sec-runtime-state": true, "x-v-request-meta": true, "x-device-id": true,
	"content-type": true, // upload's multipart boundary is per-call
}

// liveIvacflowTemplate returns the per-step template from the ivacflow push, or nil.
func (c *Config) liveIvacflowTemplate() []IvacflowStep {
	if c == nil {
		return nil
	}
	for _, imp := range c.Fallbacks {
		if imp != nil && imp.Origin == SrcIvacflow && len(imp.Template) > 0 {
			return imp.Template
		}
	}
	return nil
}

// urlPathOnly strips scheme+host and any query, leaving the leading-slash path.
func urlPathOnly(u string) string {
	if i := strings.Index(u, "://"); i >= 0 {
		if j := strings.IndexByte(u[i+3:], '/'); j >= 0 {
			u = u[i+3+j:]
		} else {
			u = "/"
		}
	}
	if i := strings.IndexByte(u, '?'); i >= 0 {
		u = u[:i]
	}
	return u
}

// matchLiveStep finds the template entry for this request by an EXACT token-set
// match on the last path segment (version/separator/case proof) within the same
// first-segment group, and a matching method. Exact (not subset) so "initiate"
// never grabs a different payment step and "reserve-slot" is unambiguous. Returns
// nil when there is no confident single match, so the caller leaves the request alone.
func matchLiveStep(tmpl []IvacflowStep, method, rawURL string) *IvacflowStep {
	p := urlPathOnly(rawURL)
	grp := firstSeg(p)
	want := endpointTokens(lastSeg(p))
	if len(want) == 0 {
		return nil
	}
	var best *IvacflowStep
	bestLen := 1 << 30
	matches := 0
	for i := range tmpl {
		st := &tmpl[i]
		if st.Path == "" {
			continue
		}
		if st.Method != "" && method != "" && !strings.EqualFold(st.Method, method) {
			continue
		}
		if firstSeg(st.Path) != grp {
			continue
		}
		have := endpointTokens(lastSeg(st.Path))
		if !tokensSubset(want, have) || !tokensSubset(have, want) {
			continue // exact token-set equality only
		}
		matches++
		if len(have) < bestLen {
			best, bestLen = st, len(have)
		}
	}
	if matches != 1 {
		return nil // ambiguous or none → do not touch the request
	}
	return best
}

// applyLiveHeaders rebuilds req.Headers from the matched ivacflow template step.
// See the file header for the rules. A no-op when no template is pushed or no step
// matches confidently.
func (c *Config) applyLiveHeaders(req *Request) {
	tmpl := c.liveIvacflowTemplate()
	if len(tmpl) == 0 {
		return
	}
	st := matchLiveStep(tmpl, req.Method, req.URL)
	if st == nil || len(st.Headers) == 0 {
		return
	}
	// case-insensitive view of what the step already set (source of dynamic values).
	cur := make(map[string]string, len(req.Headers))
	for k, v := range req.Headers {
		cur[strings.ToLower(k)] = v
	}
	out := make(map[string]string, len(st.Headers))
	for k, v := range st.Headers {
		lk := strings.ToLower(k)
		if envLiveHeader[lk] || dropLiveHeader[lk] {
			continue // keep the bot's own identity / never send transport noise
		}
		if dynLiveHeader[lk] || strings.Contains(v, "{{") {
			if cv, ok := cur[lk]; ok && cv != "" {
				out[lk] = cv // per-call value the step computed — never the mock/placeholder
			}
			continue
		}
		out[lk] = v // live STATIC value straight from the push
	}
	// Defensive: never let the merge drop the auth / captcha the step set, even if a
	// template omitted them — keeps the header set a strict superset for those two.
	for _, lk := range []string{"authorization", "x-token"} {
		if _, has := out[lk]; !has {
			if cv, ok := cur[lk]; ok && cv != "" {
				out[lk] = cv
			}
		}
	}
	req.Headers = out
}
