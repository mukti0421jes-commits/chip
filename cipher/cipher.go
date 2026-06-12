// Package cipher implements the captcha-token ciphers used by the booking
// frontend, ported 1:1 from the site's JavaScript bundle.
//
//   Sign-in (version 3, module "m$"):  Binary Cellular Automaton
//   Reserve (version 2, module "HX"):  Bitmix Feistel network
//
// Both ciphers leave a prefix of `skip` characters untouched, transform the
// next `encryptLen` characters, and leave the remainder untouched. Characters
// outside Charset pass through unchanged.
package cipher

const (
	// Charset is the 64-character alphabet used by the ciphers.
	Charset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_"

	// Sign-in cipher parameters (Cellular Automaton, version 3).
	DefaultSigninKey        = "rb%a#)tveypgal^xc8qqzdox%vh23b@!lq8yj9@i@3jq$ua+@k"
	DefaultSigninSkip       = 5
	DefaultSigninEncryptLen = 22

	// Reserve slot cipher parameters (Bitmix Feistel, version 2).
	DefaultReserveKey        = "4%i$h3wegd7daghf4p!3a9kbxczvgk3gl@ozin01++b1z#g)=w"
	DefaultReserveSkip       = 3
	DefaultReserveEncryptLen = 20
)

// Global sign-in cipher parameters.
var (
	SignInCipherKey        = DefaultSigninKey
	SignInCipherSkip       = DefaultSigninSkip
	SignInCipherEncryptLen = DefaultSigninEncryptLen
)

// Global reserve slot cipher parameters.
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
func charsetIndex(ch byte) int {
	for i := 0; i < len(Charset); i++ {
		if Charset[i] == ch {
			return i
		}
	}
	return -1
}

// splitToken splits a token into the untouched prefix, the transformable
// middle, and the untouched suffix, following the JS slice logic exactly.
func splitToken(token string, skip, encryptLen int) (prefix, middle, suffix string, ok bool) {
	prefixLen := max(0, min(skip, len(token)))
	remaining := max(0, len(token)-prefixLen)
	actualLen := max(0, min(encryptLen, remaining))
	if actualLen == 0 {
		return token, "", "", false
	}
	return token[:prefixLen], token[prefixLen : prefixLen+actualLen], token[prefixLen+actualLen:], true
}

// ── Sign-In Cipher — Binary Cellular Automaton (JS module "m$", version 3) ────
//
// JS source (a$ function):
//   let s = new Uint8Array(64)
//   for each key char: s[h%64] ^= (charCode & 1)
//   s[32] = 1
//   per output position:
//     e[i] = s[(i+63)%64] ^ (s[i] | s[(i+1)%64])   for i in 0..63
//     shift = top 6 cells (i=0..5) read MSB-first   // 0..63
//     s = e

// generateShiftsCellularAutomaton derives the per-position shift values for the
// sign-in cipher by evolving a 64-cell binary cellular automaton seeded from
// the key.
func generateShiftsCellularAutomaton(key string, length int) []int {
	var state [64]byte
	for h := 0; h < len(key); h++ {
		state[h%64] ^= key[h] & 1
	}
	state[32] = 1

	shifts := make([]int, length)
	for h := 0; h < length; h++ {
		var next [64]byte
		t := 0
		for i := 0; i < 64; i++ {
			left := state[(i+63)%64]
			center := state[i]
			right := state[(i+1)%64]
			next[i] = left ^ (center | right)
			if i < 6 {
				t = (t << 1) | int(next[i])
			}
		}
		state = next
		shifts[h] = t % len(Charset)
	}
	return shifts
}

// ProcessToken encrypts a captcha token using the sign-in Cellular Automaton
// cipher. JavaScript equivalent: m$.encryptText(token, key, skip, encryptLen).
func ProcessToken(token, key string, skip, encryptLen int) string {
	prefix, middle, suffix, ok := splitToken(token, skip, encryptLen)
	if !ok {
		return token
	}
	shifts := generateShiftsCellularAutomaton(key, len(middle))
	out := make([]byte, len(middle))
	for i := 0; i < len(middle); i++ {
		idx := charsetIndex(middle[i])
		if idx == -1 {
			out[i] = middle[i]
		} else {
			out[i] = Charset[(idx+shifts[i])%len(Charset)]
		}
	}
	return prefix + string(out) + suffix
}

// ReverseToken decrypts a token produced by ProcessToken.
func ReverseToken(token, key string, skip, encryptLen int) string {
	prefix, middle, suffix, ok := splitToken(token, skip, encryptLen)
	if !ok {
		return token
	}
	shifts := generateShiftsCellularAutomaton(key, len(middle))
	out := make([]byte, len(middle))
	for i := 0; i < len(middle); i++ {
		idx := charsetIndex(middle[i])
		if idx == -1 {
			out[i] = middle[i]
		} else {
			n := (idx - shifts[i]) % len(Charset)
			if n < 0 {
				n += len(Charset)
			}
			out[i] = Charset[n]
		}
	}
	return prefix + string(out) + suffix
}

// ── Reserve Cipher — Bitmix Feistel network (JS module "HX", version 2) ───────
//
// JS source (PX key schedule + feistel + NX round function):
//   i = Σ charCode(s) * (s+1)           (mod 2^32)
//   round keys (8): i = imul(i, 1103515245) + 12345; key = i & 7
//   roundFn(half, k) = 7 & ((3*half + k) ^ 3)
//   feistel splits the 6-bit index into two 3-bit halves and runs 8 rounds.

const feistelRounds = 8

// feistelKeySchedule derives the 8 round keys from the cipher key (JS: PX).
func feistelKeySchedule(key string) []int {
	var i uint32
	for s := 0; s < len(key); s++ {
		i = i + uint32(key[s])*uint32(s+1)
	}
	out := make([]int, feistelRounds)
	for s := 0; s < feistelRounds; s++ {
		i = i*1103515245 + 12345 // imul + add, wraps at 2^32
		out[s] = int(i & 7)
	}
	return out
}

// feistelRoundFn is the round function (JS: NX).
func feistelRoundFn(half, k int) int {
	return 7 & ((3*half + k) ^ 3)
}

// feistelEncrypt applies the Feistel network to a 6-bit charset index.
func feistelEncrypt(e int, schedule []int) int {
	o := (e >> 3) & 7
	i := e & 7
	for c := 0; c < len(schedule); c++ {
		ni := o ^ feistelRoundFn(i, schedule[c])
		o = i
		i = ni
	}
	return (i << 3) | o
}

// feistelDecrypt inverts feistelEncrypt.
func feistelDecrypt(x int, schedule []int) int {
	i := (x >> 3) & 7
	o := x & 7
	for c := len(schedule) - 1; c >= 0; c-- {
		newI := o
		newO := i ^ feistelRoundFn(o, schedule[c])
		o = newO
		i = newI
	}
	return (o << 3) | i
}

// ProcessTokenFeistel encrypts a captcha token using the reserve Bitmix Feistel
// cipher. JavaScript equivalent: HX.encryptText(token, key, skip, encryptLen).
func ProcessTokenFeistel(token, key string, skip, encryptLen int) string {
	prefix, middle, suffix, ok := splitToken(token, skip, encryptLen)
	if !ok {
		return token
	}
	schedule := feistelKeySchedule(key)
	out := make([]byte, len(middle))
	for i := 0; i < len(middle); i++ {
		idx := charsetIndex(middle[i])
		if idx == -1 {
			out[i] = middle[i]
		} else {
			out[i] = Charset[feistelEncrypt(idx, schedule)%len(Charset)]
		}
	}
	return prefix + string(out) + suffix
}

// ReverseTokenFeistel decrypts a token produced by ProcessTokenFeistel.
func ReverseTokenFeistel(token, key string, skip, encryptLen int) string {
	prefix, middle, suffix, ok := splitToken(token, skip, encryptLen)
	if !ok {
		return token
	}
	schedule := feistelKeySchedule(key)
	out := make([]byte, len(middle))
	for i := 0; i < len(middle); i++ {
		idx := charsetIndex(middle[i])
		if idx == -1 {
			out[i] = middle[i]
		} else {
			out[i] = Charset[feistelDecrypt(idx, schedule)%len(Charset)]
		}
	}
	return prefix + string(out) + suffix
}

// ── Backward-compatibility aliases ────────────────────────────────────────────

// ProcessTokenBitmix is an alias for ProcessTokenFeistel.
func ProcessTokenBitmix(token, key string, skip, encryptLen int) string {
	return ProcessTokenFeistel(token, key, skip, encryptLen)
}

// ── Convenience functions ─────────────────────────────────────────────────────

// ProcessTokenSignin encrypts a sign-in captcha token.
func ProcessTokenSignin(token string) string {
	return ProcessToken(token, SignInCipherKey, SignInCipherSkip, SignInCipherEncryptLen)
}

// ProcessTokenReserveSlot encrypts a reserve slot captcha token.
func ProcessTokenReserveSlot(token string) string {
	return ProcessTokenFeistel(token, ReserveCipherKey, ReserveCipherSkip, ReserveCipherEncryptLen)
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
}
