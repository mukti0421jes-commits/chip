// Package cipher implements both the cellular-automaton cipher and the bitmix
// Feistel cipher used to encrypt captcha tokens before sending them to the
// booking API.
package cipher

const (
	// Charset is the 64-character alphabet used by the cipher.
	Charset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_"

	// Sign-in cipher parameters (cellular automaton, version 3)
	SigninKey        = "rb%a#)tveypgal^xc8qqzdox%vh23b@!lq8yj9@i@3jq$ua+@k"
	SigninSkip       = 5
	SigninEncryptLen = 22

	// Reserve slot cipher parameters (bitmix Feistel, version 2)
	ReserveKey        = "4%i$h3wegd7daghf4p!3a9kbxczvgk3gl@ozin01++b1z#g)=w"
	ReserveSkip       = 3
	ReserveEncryptLen = 20

	// Deprecated: Use SigninKey instead
	DefaultKey = SigninKey
	// Deprecated: Use SigninSkip instead
	DefaultSkip = SigninSkip
	// Deprecated: Use SigninEncryptLen instead
	DefaultEncryptLen = SigninEncryptLen
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

// generateShiftsCA generates the per-position shift values for the sign-in
// cipher by evolving a 64-cell binary cellular automaton seeded from the key.
// This is a port of the JavaScript a$ function (module "m$").
//
// The automaton:
//   - seeds 64 cells with the parity of each key character (cell[h%64] ^= key[h]&1)
//   - sets cell[32] = 1
//   - per output position evolves one step with the rule
//     new[i] = left ^ (center | right) over wrap-around neighbours
//     and reads the top 6 cells (i=0..5, MSB first) as the shift value.
func generateShiftsCA(key string, length int) []int {
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
		shifts[h] = t % 64
	}
	return shifts
}

// ProcessToken encrypts a captcha token using the cellular-automaton cipher.
// This is the equivalent of encryptSigninCaptchaToken() in JavaScript.
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

	shifts := generateShiftsCA(key, len(middle))

	encrypted := make([]byte, len(middle))
	for i := 0; i < len(middle); i++ {
		ch := middle[i]
		charIdx := charsetIndex(rune(ch))
		if charIdx == -1 {
			encrypted[i] = ch
		} else {
			encrypted[i] = Charset[(charIdx+shifts[i])%64]
		}
	}

	return prefix + string(encrypted) + suffix
}

// ReverseToken decrypts a captcha token using the cellular-automaton cipher.
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

	shifts := generateShiftsCA(key, len(middle))

	decrypted := make([]byte, len(middle))
	for i := 0; i < len(middle); i++ {
		ch := middle[i]
		charIdx := charsetIndex(rune(ch))
		if charIdx == -1 {
			decrypted[i] = ch
		} else {
			// Reverse the shift: subtract instead of add, then handle negative modulo
			newIdx := (charIdx - shifts[i]) % 64
			if newIdx < 0 {
				newIdx += 64
			}
			decrypted[i] = Charset[newIdx]
		}
	}

	return prefix + string(decrypted) + suffix
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

// keySchedule generates a key schedule for the Feistel cipher.
// This is the bitmix "add" seed mode implementation (JavaScript PX function).
func keySchedule(key string) []int {
	const keyScheduleLen = 8

	i := uint32(0)
	for s := 0; s < len(key); s++ {
		i = (i + uint32(key[s])*(uint32(s)+1))
	}

	out := make([]int, keyScheduleLen)
	for s := 0; s < keyScheduleLen; s++ {
		// Linear congruential generator (LCG)
		// Same as Math.imul(i, 1103515245) + 12345 in JavaScript
		i = (i*1103515245 + 12345)
		out[s] = int(i & 7)
	}

	return out
}

// roundFn is the Feistel round function (JavaScript NX function).
func roundFn(e, t int) int {
	return 7 & ((e*3 + t) ^ 3)
}

// feistel applies the Feistel cipher to an index.
func feistel(e int, schedule []int) int {
	o := (e >> 3) & 7
	i := e & 7

	for c := 0; c < len(schedule); c++ {
		newI := o ^ roundFn(i, schedule[c])
		o = i
		i = newI
	}

	return (i << 3) | o
}

// feistelInverse inverts feistel, used for decryption.
func feistelInverse(x int, schedule []int) int {
	i := (x >> 3) & 7
	o := x & 7

	for c := len(schedule) - 1; c >= 0; c-- {
		newI := o
		newO := i ^ roundFn(o, schedule[c])
		o = newO
		i = newI
	}

	return (o << 3) | i
}

// ProcessTokenBitmix encrypts a captcha token using the bitmix Feistel cipher.
// This is used for reserve slot tokens.
//
// The algorithm:
//  1. Generates a key schedule using LCG (Linear Congruential Generator)
//  2. Applies Feistel cipher to each character index
//  3. Maps the result back to the charset
func ProcessTokenBitmix(token, key string, skip, encryptLen int) string {
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

	// Generate key schedule for Feistel cipher
	schedule := keySchedule(key)

	// Encrypt each character
	encrypted := make([]byte, len(middle))
	for x := 0; x < len(middle); x++ {
		ch := middle[x]
		idx := charsetIndex(rune(ch))
		if idx != -1 {
			feistelResult := feistel(idx, schedule)
			newIdx := feistelResult % len(Charset)
			encrypted[x] = Charset[newIdx]
		} else {
			encrypted[x] = ch
		}
	}

	return prefix + string(encrypted) + suffix
}

// ReverseTokenBitmix decrypts a captcha token using the bitmix Feistel cipher.
func ReverseTokenBitmix(token, key string, skip, encryptLen int) string {
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

	schedule := keySchedule(key)

	decrypted := make([]byte, len(middle))
	for x := 0; x < len(middle); x++ {
		ch := middle[x]
		idx := charsetIndex(rune(ch))
		if idx != -1 {
			feistelResult := feistelInverse(idx, schedule)
			newIdx := feistelResult % len(Charset)
			decrypted[x] = Charset[newIdx]
		} else {
			decrypted[x] = ch
		}
	}

	return prefix + string(decrypted) + suffix
}

// ProcessTokenReserveSlot is a convenience function that encrypts a reserve slot token
// using the correct bitmix parameters.
func ProcessTokenReserveSlot(token string) string {
	return ProcessTokenBitmix(token, ReserveKey, ReserveSkip, ReserveEncryptLen)
}

// ProcessTokenSignin is a convenience function that encrypts a sign-in token
// using the correct cellular-automaton parameters.
func ProcessTokenSignin(token string) string {
	return ProcessToken(token, SigninKey, SigninSkip, SigninEncryptLen)
}
