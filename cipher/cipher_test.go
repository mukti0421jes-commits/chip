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

func TestReservePermutationIsBijective(t *testing.T) {
	perm := deriveReservePermutation(ReserveCipherKey)
	seen := make([]bool, len(Charset))
	for _, v := range perm {
		if v < 0 || v >= len(Charset) || seen[v] {
			t.Fatalf("derived map is not a valid permutation: %v", perm)
		}
		seen[v] = true
	}
}
