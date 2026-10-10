package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// A SYNTHETIC token (fake sub/phone/exp, non-real signature) with the exact
// structure of an IVAC access token, so decodeJWT can be exercised without
// embedding a real account's token in the repo.
const sampleJWT = "eyJraWQiOiJpYW0tand0LXJzYS0xIiwidHlwIjoiSldUIiwiYWxnIjoiUlMyNTYifQ.eyJzdWIiOiIwMDAwMDAwMC0xMTExLTIyMjItMzMzMy00NDQ0NDQ0NDQ0NDQiLCJhdWQiOiJpYW1zLWFwaSIsInBob25lIjoiMDE3MDAwMDAwMDAiLCJpc3MiOiJpYW1zIiwiZXhwIjoxODkzNDU2MDAwLCJpYXQiOjE4OTM0NTUxMDAsImp0aSI6IjExMTExMTExLTIyMjItMzMzMy00NDQ0LTU1NTU1NTU1NTU1NSIsInNpZCI6IjY2NjY2NjY2LTc3NzctODg4OC05OTk5LTAwMDAwMDAwMDAwMCJ9.FAKE_SIGNATURE_NOT_REAL"

func TestDecodeJWT(t *testing.T) {
	c, ok := decodeJWT(sampleJWT)
	if !ok {
		t.Fatal("decode failed")
	}
	if c.Sub != "00000000-1111-2222-3333-444444444444" {
		t.Fatalf("sub = %q", c.Sub)
	}
	if c.Phone != "01700000000" {
		t.Fatalf("phone = %q", c.Phone)
	}
	if c.Exp != 1893456000 {
		t.Fatalf("exp = %d", c.Exp)
	}
}

// A token whose payload segment carries base64 '=' padding (RawURLEncoding
// would reject it) must still decode via the padding fallback.
func TestDecodeJWTPadded(t *testing.T) {
	parts := strings.Split(sampleJWT, ".")
	// re-pad the middle segment to a multiple of 4
	seg := parts[1]
	for len(seg)%4 != 0 {
		seg += "="
	}
	padded := parts[0] + "." + seg + "." + parts[2]
	c, ok := decodeJWT(padded)
	if !ok {
		t.Fatal("padded decode failed")
	}
	if c.Phone != "01700000000" {
		t.Fatalf("phone = %q", c.Phone)
	}
}

func TestDecodeJWTBad(t *testing.T) {
	if _, ok := decodeJWT("not-a-jwt"); ok {
		t.Fatal("expected failure on non-jwt")
	}
	if _, ok := decodeJWT(""); ok {
		t.Fatal("expected failure on empty")
	}
}

func TestBuildAuthStorage(t *testing.T) {
	blob, _, ok := buildAuthStorage(sampleJWT, "req-123", "01700000000")
	if !ok {
		t.Fatal("build failed")
	}
	// Must be valid JSON with the SPA's shape and the token's own phone/userId.
	var parsed authStorageBlob
	if err := json.Unmarshal([]byte(blob), &parsed); err != nil {
		t.Fatalf("blob not valid json: %v", err)
	}
	if parsed.State.Token != sampleJWT {
		t.Fatal("token not embedded")
	}
	if parsed.State.UserID != "00000000-1111-2222-3333-444444444444" {
		t.Fatalf("userId = %q", parsed.State.UserID)
	}
	// phone from token overrides the passed-in instance phone
	if parsed.State.Phone != "01700000000" {
		t.Fatalf("phone = %q", parsed.State.Phone)
	}
	if parsed.State.RequestID != "req-123" {
		t.Fatalf("requestId = %q", parsed.State.RequestID)
	}
	if !parsed.State.IsAuthenticated || !parsed.State.IsVerified {
		t.Fatal("auth/verified flags must be true")
	}
	if !strings.Contains(blob, `"version":0`) {
		t.Fatal("version:0 missing")
	}
}

func TestBuildAuthStorageEmptyToken(t *testing.T) {
	if _, _, ok := buildAuthStorage("", "r", "p"); ok {
		t.Fatal("empty token must fail")
	}
}
