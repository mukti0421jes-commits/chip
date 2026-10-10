package flow

import "testing"

func silent(string) {}

// 1) No drift: an empty spec (or one equal to the default) must return the proven
// order verbatim, and BuildSignin must produce the exact same bytes as before.
func TestAdapterNoOpWhenNoDrift(t *testing.T) {
	c := &Config{}
	keys := c.SigninBodyKeys(silent)
	if len(keys) != 3 || keys[0] != "phone" || keys[1] != "password" || keys[2] != "c" {
		t.Fatalf("no-spec signin keys = %v, want [phone password c]", keys)
	}
	if h := c.SigninNavHeader(silent); h != "x-sec-navigation-state" {
		t.Fatalf("no-spec nav header = %q", h)
	}
	// spec identical to default → still proven, still no-op
	c.EndpointSpec = map[string]EndpointSpec{
		"signin": {Body: []string{"phone", "password", "c"}, Hdrs: []string{"x-sec-navigation-state"}},
	}
	req, err := BuildSignin(SigninParams{
		Phone: "01700000000", Password: "pw", EncryptedCaptcha: "ENC", NavState: "NS",
		BodyKeys: c.SigninBodyKeys(silent), NavHeader: c.SigninNavHeader(silent),
	})
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"phone":"01700000000","password":"pw","c":"ENC"}`
	if string(req.Body) != want {
		t.Fatalf("body drifted with matching spec:\n got=%s\nwant=%s", req.Body, want)
	}
	if _, ok := req.Headers["x-sec-navigation-state"]; !ok {
		t.Fatalf("proven nav header missing: %v", req.Headers)
	}
}

// 2) Field rename: IVAC renames phone→mobile, password→pass. Same count, so the
// adapter maps the SAME values onto the new names, positionally.
func TestAdapterRemapsRenamedFields(t *testing.T) {
	c := &Config{EndpointSpec: map[string]EndpointSpec{
		"signin": {Body: []string{"mobile", "pass", "c"}, Hdrs: []string{"x-sec-navigation-state-v2"}},
	}}
	req, err := BuildSignin(SigninParams{
		Phone: "01700000000", Password: "pw", EncryptedCaptcha: "ENC", NavState: "NS",
		BodyKeys: c.SigninBodyKeys(silent), NavHeader: c.SigninNavHeader(silent),
	})
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"mobile":"01700000000","pass":"pw","c":"ENC"}`
	if string(req.Body) != want {
		t.Fatalf("rename not adapted:\n got=%s\nwant=%s", req.Body, want)
	}
	if _, ok := req.Headers["x-sec-navigation-state-v2"]; !ok {
		t.Fatalf("renamed nav header not applied: %v", req.Headers)
	}
	if _, ok := req.Headers["x-sec-navigation-state"]; ok {
		t.Fatalf("old nav header should be gone: %v", req.Headers)
	}
}

// 3) Unsafe spec (different field count, or opaque/FormData) must fall back to the
// proven default — never a blind guess.
func TestAdapterKeepsDefaultOnUnsafeSpec(t *testing.T) {
	// different count → keep proven
	c := &Config{EndpointSpec: map[string]EndpointSpec{
		"signin": {Body: []string{"phone", "password"}}, // only 2
	}}
	if k := c.SigninBodyKeys(silent); len(k) != 3 || k[0] != "phone" || k[2] != "c" {
		t.Fatalf("count-mismatch should keep proven, got %v", k)
	}
	// opaque/FormData spec → parseBodySpec returns nil → proven
	if got := parseBodySpec("FormData(files PDF, isPrimary)"); got != nil {
		t.Fatalf("FormData spec should parse to nil, got %v", got)
	}
	if got := parseBodySpec("null"); got != nil {
		t.Fatalf("null spec should parse to nil, got %v", got)
	}
	if got := parseBodySpec(""); got != nil {
		t.Fatalf("empty spec should parse to nil, got %v", got)
	}
	// clean list parses in order
	got := parseBodySpec("c, appointmentDate")
	if len(got) != 2 || got[0] != "c" || got[1] != "appointmentDate" {
		t.Fatalf("clean parse wrong: %v", got)
	}
}

// 4) End-to-end via ApplyEndpointCache: a cache carrying renamed signin fields for
// the matching bundle must land in EndpointSpec and drive the adapter.
func TestApplyEndpointCacheStoresSpec(t *testing.T) {
	raw := []byte(`{"endpoints":[
	  {"method":"POST","path":"/auth/v9-sign_in","normPath":"/auth/v9-sign_in","body":"mobile,secret,c","hdrs":["x-sec-navigation-state"]},
	  {"method":"POST","path":"/slots/139fd5d2-27c9-4728-a103-278583e830bd/reserve_slot","normPath":"/slots/:uuid/reserve_slot","body":"c,appointmentDate","hdrs":["x-v-request-meta"]}
	],"uuids":{"SLOT_UUID":"139fd5d2-27c9-4728-a103-278583e830bd","DGEPAY_UUID":"27228961-2327-3s28-861a-465sb28327b3"},"bundleName":"mum.js"}`)
	c := NewConfig()
	if !c.ApplyEndpointCache(raw, "mum.js", silent) {
		t.Fatal("ApplyEndpointCache returned false for matching bundle")
	}
	sp := c.EndpointSpec["signin"]
	if len(sp.Body) != 3 || sp.Body[0] != "mobile" || sp.Body[1] != "secret" {
		t.Fatalf("signin spec not stored: %v", sp.Body)
	}
	keys := c.SigninBodyKeys(silent)
	if keys[0] != "mobile" || keys[1] != "secret" || keys[2] != "c" {
		t.Fatalf("adapter did not use cached rename: %v", keys)
	}
	rk := c.ReserveBodyKeys(silent)
	if rk[0] != "c" || rk[1] != "appointmentDate" {
		t.Fatalf("reserve keys wrong: %v", rk)
	}
}
