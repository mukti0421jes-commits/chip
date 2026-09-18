package flow

import (
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ==================== IMPORTED (CAPTURED) CONFIG ====================
//
// Two values the bundle scan can almost never resolve — the reserve SLOT ID and
// the dg-epay payment-method UUID — are assembled at runtime by the site, so
// they never appear as plaintext in the bundle. They DO appear, in the clear, in
// the URL of a real request. The RJ SLOT userscript records those requests and
// exports them as a "rj_dyn_sync" JSON; this file parses that export and uses it
// to fill whatever the live scan could not resolve.
//
// PRECEDENCE — highest first. The live scan is always preferred, because it is
// fresh; an import can be weeks old. An imported value is a SAFETY NET, used
// only where the scan came back empty:
//
//	1. manual override (dashboard boxes)  — the user said so explicitly
//	2. live bundle scan                   — the normal path, unchanged
//	3. import (this file)                 — only where the scan resolved nothing
//	4. built-in fallback (NewConfig)      — last resort
//
// So on a day when the scan resolves everything, nothing here runs at all.

// Source labels recorded in Config.Source, so the dashboard can show where each
// resolved value actually came from.
const (
	SrcManual  = "manual"
	SrcScan    = "scan"
	SrcImport  = "import"
	SrcBuiltIn = "built-in"
)

// Imported is the technical config learned from a real browser session.
type Imported struct {
	At       time.Time         // when the export was taken
	Families map[string]string // endpoint family code -> live literal
	Headers  map[string]string // fixed headers observed on real requests
	SlotID   string            // from a recorded /slots/<id>/reserve-slot URL
	DgepayID string            // from a recorded /payment/<uuid>/dg-epay/initiate URL
	Signin   *PurposeCipher
	Reserve  *PurposeCipher
	Initiate *PurposeCipher
	// Records is the raw per-endpoint record set, kept for the dashboard's
	// "what was captured, and when" view.
	Records map[string]ImportedRecord
}

// ImportedRecord is one recorded successful request.
type ImportedRecord struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	At      int64             `json:"at"`
}

// slotFromURLRe / dgepayFromURLRe pull the two ids out of a recorded URL. They
// accept ANY alphanumeric id, not just hex: IVAC's live ids are not strictly hex
// (e.g. "139fd4d2-27c9-4758-a623-368583e830bs" — note the trailing "bs"), and a
// hex-only pattern silently rejects the real value.
var (
	slotFromURLRe   = regexp.MustCompile(`/slots/([0-9a-zA-Z-]{36})/reserve-slot`)
	dgepayFromURLRe = regexp.MustCompile(`/payment/([0-9a-zA-Z-]{36})/dg-epay/initiate`)
)

// perCallHeaders are never imported: they belong to one single request, not to
// the site's configuration.
var perCallHeaders = map[string]bool{
	"authorization": true, "x-token": true, "content-length": true,
	"cookie": true, "host": true, "connection": true, "x-device-id": true,
}

// syncExport mirrors the userscript's export shape.
type syncExport struct {
	Type     string `json:"_t"`
	Version  int    `json:"v"`
	At       int64  `json:"at"`
	Captured struct {
		Fam     map[string]string `json:"fam"`
		EpMap   map[string]string `json:"epMap"`
		Headers map[string]string `json:"headers"`
		// slotId / payId are deliberately NOT read: in the userscript they are a
		// hardcoded fallback, not something observed on the wire. The recorded
		// request URLs below are the only trustworthy source for those two.
	} `json:"rj_dyn_captured"`
	Records map[string]ImportedRecord `json:"rj_req_records"`
	Enc     struct {
		Signin   *importCipher `json:"signin"`
		Reserve  *importCipher `json:"reserve"`
		Initiate *importCipher `json:"initiate"`
	} `json:"rj_enc"`
}

// importCipher is one purpose's cipher config as the userscript stores it. The
// numeric fields may arrive as numbers or as strings (they pass through UI
// inputs), so they are decoded leniently.
type importCipher struct {
	Key     string  `json:"key"`
	Skip    flexInt `json:"skip"`
	Length  flexInt `json:"length"`
	Version flexInt `json:"version"`
}

// flexInt accepts both 8 and "8" from JSON.
type flexInt int

func (f *flexInt) UnmarshalJSON(b []byte) error {
	s := strings.Trim(strings.TrimSpace(string(b)), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return nil // unparseable → leave zero rather than failing the whole import
	}
	*f = flexInt(n)
	return nil
}

func (c *importCipher) toPurpose() *PurposeCipher {
	if c == nil || c.Key == "" {
		return nil
	}
	return &PurposeCipher{Key: c.Key, Skip: int(c.Skip), Length: int(c.Length), Version: int(c.Version)}
}

// ParseImport reads an "rj_dyn_sync" export. Trailing junk after the JSON object
// is tolerated (two exports pasted together, or a truncated tail): the first
// complete object is used.
func ParseImport(raw []byte) (*Imported, error) {
	dec := json.NewDecoder(strings.NewReader(strings.TrimSpace(string(raw))))
	var e syncExport
	if err := dec.Decode(&e); err != nil {
		return nil, errors.New("invalid JSON: " + err.Error())
	}
	if e.Type != "rj_dyn_sync" {
		return nil, errors.New(`not an RJ SLOT export (expected "_t":"rj_dyn_sync")`)
	}

	imp := &Imported{
		Families: map[string]string{},
		Headers:  map[string]string{},
		Records:  e.Records,
	}
	if e.At > 0 {
		imp.At = time.UnixMilli(e.At)
	}

	// Endpoint literals: the userscript's own bundle scan (fam) is the primary
	// source — it is re-run on every page load, so it is the freshest thing in the
	// export. epMap (learned from live traffic) fills anything fam is missing.
	for code, lit := range e.Captured.Fam {
		if lit != "" {
			imp.Families[code] = lit
		}
	}
	for code, lit := range e.Captured.EpMap {
		if lit != "" && imp.Families[code] == "" {
			imp.Families[code] = lit
		}
	}

	for k, v := range e.Captured.Headers {
		lk := strings.ToLower(k)
		if v != "" && !perCallHeaders[lk] {
			imp.Headers[lk] = v
		}
	}

	// The two runtime-assembled ids come ONLY from a URL that really worked.
	for _, rec := range e.Records {
		if m := slotFromURLRe.FindStringSubmatch(rec.URL); m != nil && imp.SlotID == "" {
			imp.SlotID = m[1]
		}
		if m := dgepayFromURLRe.FindStringSubmatch(rec.URL); m != nil && imp.DgepayID == "" {
			imp.DgepayID = m[1]
		}
		// a record may also carry an endpoint literal fam missed
		for _, f := range epFamilies {
			if imp.Families[f.Code] != "" {
				continue
			}
			if lit := f.Re.FindString(rec.URL); lit != "" {
				imp.Families[f.Code] = lit
			}
		}
	}

	imp.Signin = e.Enc.Signin.toPurpose()
	imp.Reserve = e.Enc.Reserve.toPurpose()
	imp.Initiate = e.Enc.Initiate.toPurpose()
	return imp, nil
}

// Summary renders a one-line description of what an import carries, for the log
// and the dashboard.
func (i *Imported) Summary() string {
	if i == nil {
		return "none"
	}
	parts := []string{"endpoints=" + itoa(len(i.Families))}
	if i.SlotID != "" {
		parts = append(parts, "slot="+i.SlotID)
	} else {
		parts = append(parts, "slot=MISSING (no reserve-slot request recorded)")
	}
	if i.DgepayID != "" {
		parts = append(parts, "dg-epay="+i.DgepayID)
	} else {
		parts = append(parts, "dg-epay=MISSING")
	}
	if i.Signin != nil {
		parts = append(parts, "cipher=yes")
	} else {
		parts = append(parts, "cipher=MISSING")
	}
	if !i.At.IsZero() {
		parts = append(parts, "captured "+i.At.Format("2006-01-02 15:04"))
	}
	return strings.Join(parts, " ")
}

// ── Gap filling ──────────────────────────────────────────────────────────────

// noteSource records where a resolved value came from (dashboard provenance).
func (c *Config) noteSource(key, src string) {
	if c.Source == nil {
		c.Source = map[string]string{}
	}
	c.Source[key] = src
}

// markScanSources records, per value, whether THIS run's live scan resolved it.
// Called right after the scan is applied and before the import fills gaps, so
// the dashboard can show a value the scan never produced.
func (c *Config) markScanSources(s EndpointScan, cipherOK bool) {
	for _, f := range epFamilies {
		if s.Families[f.Code] != "" {
			c.noteSource("ep:"+f.Code, SrcScan)
		} else if c.Source == nil || c.Source["ep:"+f.Code] == "" {
			c.noteSource("ep:"+f.Code, SrcBuiltIn)
		}
	}
	if s.SlotID != "" {
		c.noteSource("slotId", SrcScan)
	} else {
		c.noteSource("slotId", SrcBuiltIn)
	}
	if cipherOK {
		c.noteSource("cipher", SrcScan)
	} else {
		c.noteSource("cipher", SrcBuiltIn)
	}
}

// ApplyImportGaps fills ONLY what the live scan left unresolved. s is this run's
// scan result (empty EndpointScan when the bundle was unreachable). It never
// overwrites a value the scan produced, and never touches a manual override.
// log may be nil.
func (c *Config) ApplyImportGaps(s EndpointScan, cipherOK bool, log func(string)) {
	c.markScanSources(s, cipherOK)
	imp := c.Imported
	if imp == nil {
		return
	}
	say := func(m string) {
		if log != nil {
			log(m)
		}
	}

	for _, f := range epFamilies {
		if s.Families[f.Code] != "" {
			continue // scan resolved it → scan wins
		}
		if lit := imp.Families[f.Code]; lit != "" && lit != c.Endpoints[f.Code] {
			c.Endpoints[f.Code] = lit
			c.noteSource("ep:"+f.Code, SrcImport)
			say("📥 import: " + f.Code + " → " + lit)
		}
	}

	if s.SlotID == "" && imp.SlotID != "" {
		if c.SlotID != imp.SlotID {
			say("📥 import: slot id → " + imp.SlotID + " (scan resolve korte pareni)")
		}
		c.SlotID = imp.SlotID
		c.noteSource("slotId", SrcImport)
	}

	if !cipherOK && imp.Signin != nil {
		c.Signin = imp.Signin
		if imp.Reserve != nil {
			c.Reserve = imp.Reserve
		}
		if imp.Initiate != nil {
			c.Initiate = imp.Initiate
		}
		c.noteSource("cipher", SrcImport)
		say("📥 import: cipher config (scan resolve korte pareni)")
	}

	for k, v := range imp.Headers {
		switch k {
		case "x-sec-navigation-state":
			if c.NavState == "" {
				c.NavState = v
				c.noteSource("navState", SrcImport)
			}
		case "x-sec-runtime-state":
			if c.RuntimeState == "" {
				c.RuntimeState = v
				c.noteSource("runtimeState", SrcImport)
			}
		case "x-v-request-meta":
			if c.VRequestMeta == "" {
				c.VRequestMeta = v
				c.noteSource("vRequestMeta", SrcImport)
			}
		}
	}
}

// ImportedDgepayID returns the imported dg-epay uuid, or "" when there is none.
// The Initiate step uses it only after the background bundle resolve came back
// empty (see ensureDgEpay).
func (c *Config) ImportedDgepayID() string {
	if c.Imported == nil {
		return ""
	}
	return c.Imported.DgepayID
}
