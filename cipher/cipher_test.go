package cipher

import "testing"

const sampleToken = "abc123XYZ_-456defGHIjkl789MNOpqr0stuvwx"

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
	encA := ProcessToken(sampleToken, "keyAAAAAAAAAAAAAAAAA", SignInCipherSkip, SignInCipherEncryptLen)
	encB := ProcessToken(sampleToken, "keyBBBBBBBBBBBBBBBBB", SignInCipherSkip, SignInCipherEncryptLen)
	if encA == encB {
		t.Fatal("sign-in cipher output is independent of the key")
	}

	rA := ProcessTokenFeistel(sampleToken, "keyAAAAAAAAAAAAAAAAA", ReserveCipherSkip, ReserveCipherEncryptLen)
	rB := ProcessTokenFeistel(sampleToken, "keyBBBBBBBBBBBBBBBBB", ReserveCipherSkip, ReserveCipherEncryptLen)
	if rA == rB {
		t.Fatal("reserve cipher output is independent of the key")
	}
}

// TestJSParity locks the Go output to the reference values produced by the
// site's JavaScript bundle (modules "m$" version 3 and "HX" version 2) for the
// real sign-in and reserve keys.
func TestJSParity(t *testing.T) {
	const token = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_0123456789"

	gotSignin := ProcessToken(token, DefaultSigninKey, DefaultSigninSkip, DefaultSigninEncryptLen)
	wantSignin := "01234tXIBq5dPF0-Utdlr10yOc8rstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_0123456789"
	if gotSignin != wantSignin {
		t.Fatalf("sign-in JS parity mismatch:\n got %q\nwant %q", gotSignin, wantSignin)
	}

	gotReserve := ProcessTokenFeistel(token, DefaultReserveKey, DefaultReserveSkip, DefaultReserveEncryptLen)
	wantReserve := "012KpEXGCjANynwRL-dYHW9nopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_0123456789"
	if gotReserve != wantReserve {
		t.Fatalf("reserve JS parity mismatch:\n got %q\nwant %q", gotReserve, wantReserve)
	}
}
