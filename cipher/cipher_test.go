package cipher

import "testing"

const sampleToken = "abc123XYZ_-456defGHIjkl789MNOpqr0stuvwx"

// vectorKey/Skip/Len match the parameters used to generate the reference
// vectors from rjslotencryptionmodule.js (see TestMatchesJSVectors).
const (
	vectorKey  = "rb%a#)tveypgal^xc8qqzdox%vh23b@!lq8yj9@i@3jq$ua+@k"
	vectorSkip = 5
	vectorLen  = 22
)

// jsVectors is the exact ciphertext produced by encryptByVersion(v, token, key,
// skip, len) in the reference JavaScript module for every version 1..10. These
// are the ground truth: the Go port must reproduce them byte-for-byte, or the
// site will be unable to decrypt tokens the bot sends.
var jsVectors = map[int]string{
	1:  "abc12el0raoNzhDXJR5TNvLCCkaNOpqr0stuvwx",
	2:  "abc12Fg1ikzsH-0N6hCTrKpJn4eNOpqr0stuvwx",
	3:  "abc12rMxqgV6Iy_ZTSCKq0_iyYuNOpqr0stuvwx",
	4:  "abc12B9KfEGmayzUxNvFp2UjwHkNOpqr0stuvwx",
	5:  "abc12FGdG9N698o16dvWAIRFwaKNOpqr0stuvwx",
	6:  "abc12tfKYFiB97moLH80i3EWs9tNOpqr0stuvwx",
	7:  "abc12Pfmdls9DActq6LjbUkJGFwNOpqr0stuvwx",
	8:  "abc12KqEya8XdmL9cZkoowALpgQNOpqr0stuvwx",
	9:  "abc12VexOMZKFnjXa_bK4pTnKDHNOpqr0stuvwx",
	10: "abc12HI_YFeDsate2ANeHSlW1D8NOpqr0stuvwx",
}

// TestMatchesJSVectors is the core correctness check: every cipher version must
// match the reference JS module exactly.
func TestMatchesJSVectors(t *testing.T) {
	for v := 1; v <= 10; v++ {
		got := EncryptByVersion(v, sampleToken, vectorKey, vectorSkip, vectorLen, 0)
		if got != jsVectors[v] {
			t.Errorf("v%d encrypt mismatch:\n got  %q\n want %q", v, got, jsVectors[v])
		}
	}
}

// TestAllVersionsRoundTrip checks every version decrypts back to the original.
func TestAllVersionsRoundTrip(t *testing.T) {
	for v := 1; v <= 10; v++ {
		enc := EncryptByVersion(v, sampleToken, vectorKey, vectorSkip, vectorLen, 0)
		if enc == sampleToken {
			t.Errorf("v%d did not change the token", v)
		}
		dec := DecryptByVersion(v, enc, vectorKey, vectorSkip, vectorLen, 0)
		if dec != sampleToken {
			t.Errorf("v%d round trip mismatch: got %q want %q", v, dec, sampleToken)
		}
	}
}

func TestSigninRoundTrip(t *testing.T) {
	enc := ProcessToken(sampleToken, SignInCipherKey, SignInCipherSkip, SignInCipherEncryptLen)
	if enc == sampleToken {
		t.Fatal("sign-in encryption did not change the token")
	}
	dec := ReverseToken(enc, SignInCipherKey, SignInCipherSkip, SignInCipherEncryptLen)
	if dec != sampleToken {
		t.Fatalf("sign-in round trip mismatch: got %q want %q", dec, sampleToken)
	}
}

func TestReserveRoundTrip(t *testing.T) {
	enc := ProcessTokenFeistel(sampleToken, ReserveCipherKey, ReserveCipherSkip, ReserveCipherEncryptLen)
	if enc == sampleToken {
		t.Fatal("reserve encryption did not change the token")
	}
	dec := ReverseTokenFeistel(enc, ReserveCipherKey, ReserveCipherSkip, ReserveCipherEncryptLen)
	if dec != sampleToken {
		t.Fatalf("reserve round trip mismatch: got %q want %q", dec, sampleToken)
	}
}

func TestKeySensitivity(t *testing.T) {
	for v := 1; v <= 10; v++ {
		a := EncryptByVersion(v, sampleToken, "keyAAAAAAAAAAAAAAAAA", vectorSkip, vectorLen, 0)
		b := EncryptByVersion(v, sampleToken, "keyBBBBBBBBBBBBBBBBB", vectorSkip, vectorLen, 0)
		if a == b {
			t.Errorf("v%d cipher output is independent of the key", v)
		}
	}
}
