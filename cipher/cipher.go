// Package cipher implements Cellular Automaton v3 and Feistel v2 ciphers
// used to encrypt captcha tokens before sending them to the booking API.
package cipher

const (
	// Charset is the 64-character alphabet used by the cipher.
	Charset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_"

	// Default sign-in cipher parameters (Cellular Automaton v3)
	DefaultSigninKey        = "rb%a#)tveypgal^xc8qqzdox%vh23b@!lq8yj9@i@3jq$ua+@k"
	DefaultSigninSkip       = 5
	DefaultSigninEncryptLen = 22

	// Default reserve slot cipher parameters (Feistel v2)
	DefaultReserveKey        = "4%i$h3wegd7daghf4p!3a9kbxczvgk3gl@ozin01++b1z#g)=w"
	DefaultReserveSkip       = 3
	DefaultReserveEncryptLen = 20
)

// Global sign-in cipher parameters (Cellular Automaton v3)
var (
	SignInCipherKey        = DefaultSigninKey
	SignInCipherSkip       = DefaultSigninSkip
	SignInCipherEncryptLen = DefaultSigninEncryptLen
)

// Global reserve slot cipher parameters (Feistel v2)
var (
	ReserveCipherKey        = DefaultReserveKey
	ReserveCipherSkip       = DefaultReserveSkip
	ReserveCipherEncryptLen = DefaultReserveEncryptLen
)

// max returns the maximum of two integers.
func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// min returns the minimum of two integers.
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// charsetIndex returns the index of ch in Charset, or -1 if not found.
func charsetIndex(ch rune) int {
	for i, c := range Charset {
		if c == ch {
			return i
		}
	}
	return -1
}

// keyStream is a deterministic, key-seeded pseudo-random generator
// (SplitMix64). It is used to derive cipher material from a string key so
// that the key actually influences the encryption output, while remaining
// fully reproducible for decryption.
type keyStream struct {
	state uint64
}

// newKeyStream seeds a keyStream from the given key. An optional salt allows
// two ciphers to derive independent streams from the same key.
func newKeyStream(key string, salt uint64) *keyStream {
	// FNV-1a hash of the key bytes for the initial seed.
	var h uint64 = 1469598103934665603
	for i := 0; i < len(key); i++ {
		h ^= uint64(key[i])
		h *= 1099511628211
	}
	h ^= salt + 0x9e3779b97f4a7c15
	return &keyStream{state: h}
}

// next returns the next 64-bit value in the stream (SplitMix64).
func (k *keyStream) next() uint64 {
	k.state += 0x9e3779b97f4a7c15
	z := k.state
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

// intn returns a deterministic value in [0, n) using rejection sampling to
// avoid modulo bias.
func (k *keyStream) intn(n int) int {
	if n <= 0 {
		return 0
	}
	un := uint64(n)
	limit := (^uint64(0) / un) * un
	for {
		v := k.next()
		if v < limit {
			return int(v % un)
		}
	}
}

// ── Cellular Automaton v3 (Sign-In Cipher) ───────────────────────────────────

// signinSalt namespaces the sign-in key stream so it stays independent from
// any other cipher deriving material from the same key.
const signinSalt = 0x5347_4e49_4e00 // "SGNIN"

// generateShiftsCellularAutomaton derives per-position shift values
// deterministically from the key, so that the key actually drives the
// encryption. Each shift is in [0, len(Charset)) and the sequence is fully
// reproducible for decryption.
func generateShiftsCellularAutomaton(key string, length int) []int {
	stream := newKeyStream(key, signinSalt)
	shifts := make([]int, length)
	for i := 0; i < length; i++ {
		shifts[i] = stream.intn(len(Charset))
	}
	return shifts
}

// ProcessToken encrypts a captcha token using Cellular Automaton v3.
// This is used for sign-in operations.
func ProcessToken(token, key string, skip, encryptLen int) string {
	if token == "" {
		return token
	}

	prefixLen := max(0, min(skip, len(token)))
	remaining := max(0, len(token)-prefixLen)
	actualLen := max(0, min(encryptLen, remaining))

	if actualLen == 0 {
		return token
	}

	prefix := token[:prefixLen]
	middle := token[prefixLen : prefixLen+actualLen]
	suffix := token[prefixLen+actualLen:]

	shifts := generateShiftsCellularAutomaton(key, len(middle))

	encrypted := make([]byte, len(middle))
	for i := 0; i < len(middle); i++ {
		ch := middle[i]
		charIdx := charsetIndex(rune(ch))
		if charIdx == -1 {
			encrypted[i] = ch
		} else {
			encrypted[i] = Charset[(charIdx+shifts[i])%len(Charset)]
		}
	}

	return prefix + string(encrypted) + suffix
}

// ReverseToken decrypts a captcha token using Cellular Automaton v3.
func ReverseToken(token, key string, skip, encryptLen int) string {
	if token == "" {
		return token
	}

	prefixLen := max(0, min(skip, len(token)))
	remaining := max(0, len(token)-prefixLen)
	actualLen := max(0, min(encryptLen, remaining))

	if actualLen == 0 {
		return token
	}

	prefix := token[:prefixLen]
	middle := token[prefixLen : prefixLen+actualLen]
	suffix := token[prefixLen+actualLen:]

	shifts := generateShiftsCellularAutomaton(key, len(middle))

	decrypted := make([]byte, len(middle))
	for i := 0; i < len(middle); i++ {
		ch := middle[i]
		charIdx := charsetIndex(rune(ch))
		if charIdx == -1 {
			decrypted[i] = ch
		} else {
			newIdx := (charIdx - shifts[i]) % len(Charset)
			if newIdx < 0 {
				newIdx += len(Charset)
			}
			decrypted[i] = Charset[newIdx]
		}
	}

	return prefix + string(decrypted) + suffix
}

// ── Feistel v2 (Reserve Slot Cipher) ─────────────────────────────────────────

// reserveSalt namespaces the reserve key stream.
const reserveSalt = 0x5245_5345_5256 // "RESERV"

// reserveMapJS is the substitution permutation, derived from the reserve key.
var reserveMapJS = deriveReservePermutation(ReserveCipherKey)

// reverseReserveMapJS is the inverse of reserveMapJS.
var reverseReserveMapJS = invertPermutation(reserveMapJS)

// deriveReservePermutation builds a bijective substitution of the charset
// (a permutation of 0..len(Charset)-1) deterministically from the key using
// a key-seeded Fisher-Yates shuffle. Because it is a true permutation, it is
// always invertible for decryption.
func deriveReservePermutation(key string) []int {
	n := len(Charset)
	perm := make([]int, n)
	for i := range perm {
		perm[i] = i
	}
	stream := newKeyStream(key, reserveSalt)
	for i := n - 1; i > 0; i-- {
		j := stream.intn(i + 1)
		perm[i], perm[j] = perm[j], perm[i]
	}
	return perm
}

// invertPermutation returns the inverse of a permutation.
func invertPermutation(perm []int) []int {
	inv := make([]int, len(perm))
	for i := range inv {
		inv[i] = -1
	}
	for inIdx, outIdx := range perm {
		inv[outIdx] = inIdx
	}
	return inv
}

// rebuildReserveMaps regenerates the substitution maps from the current
// reserve key. Call this after changing ReserveCipherKey directly.
func rebuildReserveMaps() {
	reserveMapJS = deriveReservePermutation(ReserveCipherKey)
	reverseReserveMapJS = invertPermutation(reserveMapJS)
}

// ProcessTokenFeistel encrypts a captcha token using the static map array.
// This is used for reserve slot operations.
func ProcessTokenFeistel(token, key string, skip, encryptLen int) string {
	if token == "" {
		return token
	}

	prefixLen := max(0, min(skip, len(token)))
	remaining := max(0, len(token)-prefixLen)
	actualLen := max(0, min(encryptLen, remaining))

	if actualLen == 0 {
		return token
	}

	prefix := token[:prefixLen]
	middle := token[prefixLen : prefixLen+actualLen]
	suffix := token[prefixLen+actualLen:]

	subMap := deriveReservePermutation(key)

	encrypted := make([]byte, len(middle))

	for i := 0; i < len(middle); i++ {
		ch := middle[i]
		idx := charsetIndex(rune(ch))
		if idx != -1 {
			encrypted[i] = Charset[subMap[idx]]
		} else {
			encrypted[i] = ch // Fallback if not in charset
		}
	}

	return prefix + string(encrypted) + suffix
}

// ReverseTokenFeistel decrypts a captcha token using the static map array.
func ReverseTokenFeistel(token, key string, skip, encryptLen int) string {
	if token == "" {
		return token
	}

	prefixLen := max(0, min(skip, len(token)))
	remaining := max(0, len(token)-prefixLen)
	actualLen := max(0, min(encryptLen, remaining))

	if actualLen == 0 {
		return token
	}

	prefix := token[:prefixLen]
	middle := token[prefixLen : prefixLen+actualLen]
	suffix := token[prefixLen+actualLen:]

	revMap := invertPermutation(deriveReservePermutation(key))

	decrypted := make([]byte, len(middle))

	// Decrypt each character
	for i := 0; i < len(middle); i++ {
		ch := middle[i]
		idx := charsetIndex(rune(ch))
		if idx != -1 && revMap[idx] != -1 {
			decrypted[i] = Charset[revMap[idx]]
		} else {
			decrypted[i] = ch // Fallback if not in map
		}
	}

	return prefix + string(decrypted) + suffix
}

// ── Backward Compatibility Aliases ───────────────────────────────────────────

// ProcessTokenPoly is an alias for ProcessTokenFeistel for backward compatibility.
func ProcessTokenPoly(token, key string, skip, encryptLen int) string {
	return ProcessTokenFeistel(token, key, skip, encryptLen)
}

// ProcessTokenBitmix is an alias for ProcessTokenFeistel for backward compatibility.
func ProcessTokenBitmix(token, key string, skip, encryptLen int) string {
	return ProcessTokenFeistel(token, key, skip, encryptLen)
}

// ReverseTokenPoly is an alias for ReverseTokenFeistel for backward compatibility.
func ReverseTokenPoly(token, key string, skip, encryptLen int) string {
	return ReverseTokenFeistel(token, key, skip, encryptLen)
}

// ── Convenience Functions ────────────────────────────────────────────────────

// ProcessTokenReserveSlot encrypts a reserve slot token using Feistel v2.
func ProcessTokenReserveSlot(token string) string {
	return ProcessTokenFeistel(token, ReserveCipherKey, ReserveCipherSkip, ReserveCipherEncryptLen)
}

// ProcessTokenSignin encrypts a sign-in token using Cellular Automaton v3.
func ProcessTokenSignin(token string) string {
	return ProcessToken(token, SignInCipherKey, SignInCipherSkip, SignInCipherEncryptLen)
}

// SetSignInCipherConfig updates the global sign-in cipher configuration.
func SetSignInCipherConfig(key string, skip, encryptLen int) {
	SignInCipherKey = key
	SignInCipherSkip = skip
	SignInCipherEncryptLen = encryptLen
}

// SetReserveCipherConfig updates the global reserve slot cipher configuration.
func SetReserveCipherConfig(key string, skip, encryptLen int) {
	ReserveCipherKey = key
	ReserveCipherSkip = skip
	ReserveCipherEncryptLen = encryptLen
	rebuildReserveMaps()
}
