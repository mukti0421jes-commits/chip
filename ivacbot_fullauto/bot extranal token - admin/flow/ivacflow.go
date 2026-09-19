package flow

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// ==================== IVACFLOW SNAPSHOT ====================
//
// ivacflow is a separate Node + Playwright tool: it downloads the live bundle,
// hosts it locally, and walks signin→initiate headlessly with MOCK data. Because
// it actually RUNS the code instead of pattern-matching it, it resolves the two
// values a text scan cannot — the reserve slot id and the dg-epay uuid — plus
// the endpoints and cipher config.
//
// It pushes its snapshot to the bot (POST /api/ivacflowPush) the moment an
// extraction finishes. The snapshot has a different shape from the RJ SLOT
// userscript export, so it gets its own parser here; both end up as *Imported
// and feed the same gap-filling path.

// ivacflowSnapshot mirrors ivacflow's values.json / /api/state payload.
type ivacflowSnapshot struct {
	Config *struct {
		ExtractedAt  string            `json:"extractedAt"`
		APIBase      string            `json:"apiBase"`
		Endpoints    map[string]string `json:"endpoints"`
		SlotID       string            `json:"slotId"`
		DgepayUUID   string            `json:"dgepayUuid"`
		InitiatePath string            `json:"initiatePath"`
		Ciphers      struct {
			Roles []struct {
				Role    string  `json:"role"`
				Version flexInt `json:"version"`
				Algo    string  `json:"algo"`
				Skip    flexInt `json:"skip"`
				Len     flexInt `json:"len"`
				Key     string  `json:"key"`
			} `json:"roles"`
		} `json:"ciphers"`
	} `json:"config"`
	Template   []IvacflowStep `json:"template"`
	BundleName string         `json:"bundleName"`
	At         string         `json:"at"`
}

// IvacflowStep is one entry of ivacflow's request template: the method, path,
// headers and body FIELD NAMES it observed for a step. Values are placeholders
// (e.g. "{{ivac:phone}}"), never real data.
type IvacflowStep struct {
	Name    string            `json:"name"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Found   bool              `json:"found"`
	Probed  bool              `json:"probed"`
	Headers map[string]string `json:"headers"`
	Body    map[string]string `json:"body"`
}

// ivacflowEndpointKeys maps ivacflow's friendly endpoint names onto the family
// codes the flow's Config.ep() lookups use.
var ivacflowEndpointKeys = map[string]string{
	"signin":           "/auth/v2-sign-in",
	"verifySigninOtp":  "/otp/verifySigninOtp",
	"verifyOtp":        "/otp/verify-otp",
	"signupOtp":        "/otp/signupOtp",
	"uploadFile":       "/file/upload_file_v2",
	"overView":         "/file/over-view-v3",
	"getBookingConfig": "/appointment/get-booking-config",
	"bookingConfig":    "/appointment/appointment-booking-config",
	"fileConfirmation": "/file/file-confirmation_and_slot_status",
	"paymentAmount":    "/file/payment-amount",
}

// LooksLikeIvacflow reports whether raw is an ivacflow snapshot rather than an
// RJ SLOT export, so one endpoint can accept either.
func LooksLikeIvacflow(raw []byte) bool {
	var probe struct {
		Type   string `json:"_t"`
		Config *struct {
			ExtractedAt string `json:"extractedAt"`
		} `json:"config"`
	}
	if json.Unmarshal(raw, &probe) != nil {
		return false
	}
	return probe.Type == "" && probe.Config != nil
}

// ParseIvacflow reads an ivacflow snapshot into the same *Imported the RJ SLOT
// path produces, so both share one gap-filling code path.
func ParseIvacflow(raw []byte) (*Imported, error) {
	dec := json.NewDecoder(strings.NewReader(strings.TrimSpace(string(raw))))
	var s ivacflowSnapshot
	if err := dec.Decode(&s); err != nil {
		return nil, errors.New("invalid JSON: " + err.Error())
	}
	if s.Config == nil {
		return nil, errors.New(`not an ivacflow snapshot (no "config" object)`)
	}

	imp := &Imported{
		Origin:     SrcIvacflow,
		Families:   map[string]string{},
		Headers:    map[string]string{},
		SlotID:     strings.TrimSpace(s.Config.SlotID),
		DgepayID:   strings.TrimSpace(s.Config.DgepayUUID),
		APIBase:    strings.TrimSpace(s.Config.APIBase),
		BundleName: normalizeBundleName(s.BundleName),
		Template:   s.Template,
	}
	if t, err := time.Parse(time.RFC3339, s.Config.ExtractedAt); err == nil {
		imp.At = t
	}

	for key, lit := range s.Config.Endpoints {
		code, ok := ivacflowEndpointKeys[key]
		if !ok || lit == "" {
			continue
		}
		// ivacflow prefixes some entries with the api base path; the family map
		// wants the bare path.
		imp.Families[code] = stripAPIPrefix(lit)
	}

	// Cross-check the two ids against the full URLs ivacflow also records — a
	// recorded URL is the strongest evidence either tool produces.
	if u := s.Config.Endpoints["reserveSlot"]; u != "" {
		if m := slotFromURLRe.FindStringSubmatch(u); m != nil {
			imp.SlotID = m[1]
		}
	}
	for _, u := range []string{s.Config.Endpoints["paymentInitiate"], s.Config.InitiatePath} {
		if m := dgepayFromURLRe.FindStringSubmatch(u); m != nil {
			imp.DgepayID = m[1]
			break
		}
	}

	for _, r := range s.Config.Ciphers.Roles {
		if r.Key == "" {
			continue
		}
		p := &PurposeCipher{Key: r.Key, Skip: int(r.Skip), Length: int(r.Len), Version: int(r.Version)}
		switch strings.ToLower(r.Role) {
		case "signin":
			imp.Signin = p
		case "reserve":
			imp.Reserve = p
		case "initiate":
			imp.Initiate = p
		}
	}
	// ivacflow often reports one key that serves every purpose.
	if imp.Signin != nil {
		if imp.Reserve == nil {
			imp.Reserve = imp.Signin
		}
		if imp.Initiate == nil {
			imp.Initiate = imp.Signin
		}
	}

	// Fixed headers observed in the template (placeholder values are skipped —
	// "{{ivac:navState}}" is a slot to fill, not a value).
	for _, st := range s.Template {
		for k, v := range st.Headers {
			lk := strings.ToLower(k)
			if v == "" || perCallHeaders[lk] || strings.Contains(v, "{{") {
				continue
			}
			if imp.Headers[lk] == "" {
				imp.Headers[lk] = v
			}
		}
	}
	return imp, nil
}

// stripAPIPrefix removes a leading /iams/api/v<N> so an endpoint literal is the
// bare path Config.join() expects. ivacflow is inconsistent about this: most
// entries are bare, but reserveSlot/paymentInitiate carry the prefix.
func stripAPIPrefix(p string) string {
	if i := strings.Index(p, "/iams/api/"); i >= 0 {
		rest := p[i+len("/iams/api/"):]
		if j := strings.Index(rest, "/"); j >= 0 {
			return rest[j:]
		}
	}
	return p
}

// normalizeBundleName collapses whitespace in a bundle filename. ivacflow's
// snapshot sometimes carries padding inside the name, which would break an
// exact comparison against the file the bot downloaded.
func normalizeBundleName(n string) string {
	return strings.Join(strings.Fields(n), "")
}

// BundleMatches reports whether this capture describes the bundle the bot is
// running against. Both names are normalized and compared on their hash part,
// so padding or a path prefix does not matter. An empty name on either side
// means "unknown" — treated as a match, since there is nothing to contradict.
func (i *Imported) BundleMatches(liveURL string) bool {
	if i == nil || i.BundleName == "" || liveURL == "" {
		return true
	}
	live := normalizeBundleName(liveURL)
	if j := strings.LastIndex(live, "/"); j >= 0 {
		live = live[j+1:]
	}
	if j := strings.Index(live, "?"); j >= 0 {
		live = live[:j]
	}
	return strings.EqualFold(live, i.BundleName) ||
		strings.Contains(live, i.BundleName) || strings.Contains(i.BundleName, live)
}
