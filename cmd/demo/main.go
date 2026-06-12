package main

import (
	"fmt"

	"github.com/mukti0421jes-commits/chip/cipher"
)

// Demo shows the two reversible, key-derived ciphers in the package.
// This is a learning/example program — it operates only on sample strings.
func main() {
	sample := "abc123XYZ_-456defGHIjkl789MNOpqr0stuvwx"

	fmt.Println("Charset:", cipher.Charset)
	fmt.Println("Original:", sample)
	fmt.Println()

	// 1. Sign-in cipher (keyed polyalphabetic shift over the 64-char alphabet).
	encA := cipher.ProcessTokenSignin(sample)
	decA := cipher.ReverseToken(encA, cipher.SignInCipherKey, cipher.SignInCipherSkip, cipher.SignInCipherEncryptLen)
	fmt.Println("[sign-in]  encrypted:", encA)
	fmt.Println("[sign-in]  decrypted:", decA, ok(decA == sample))

	// 2. Reserve cipher (keyed bijective substitution / permutation).
	encB := cipher.ProcessTokenReserveSlot(sample)
	decB := cipher.ReverseTokenFeistel(encB, cipher.ReserveCipherKey, cipher.ReserveCipherSkip, cipher.ReserveCipherEncryptLen)
	fmt.Println("[reserve]  encrypted:", encB)
	fmt.Println("[reserve]  decrypted:", decB, ok(decB == sample))

	// 3. Different keys produce different ciphertext (the key actually matters).
	fmt.Println()
	fmt.Println("key sensitivity:")
	fmt.Println("  keyA ->", cipher.ProcessToken(sample, "key-AAAAAAAAAAAAAAAA", 5, 22))
	fmt.Println("  keyB ->", cipher.ProcessToken(sample, "key-BBBBBBBBBBBBBBBB", 5, 22))
}

func ok(b bool) string {
	if b {
		return "(round-trip OK)"
	}
	return "(MISMATCH!)"
}
