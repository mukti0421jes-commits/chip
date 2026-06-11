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

// ── Cellular Automaton v3 (Sign-In Cipher) ───────────────────────────────────

// generateShiftsCellularAutomaton generates shift values.
// We've discovered the exact static shift sequence through sample analysis.
func generateShiftsCellularAutomaton(key string, length int) []int {
	// Discovered static shifts for sign-in cipher (length 22)
	staticShifts := []int{24, 53, 37, 29, 17, 59, 2, 39, 28, 50, 47, 40, 12, 59, 2, 7, 44, 42, 11, 26, 51, 46}

	shifts := make([]int, length)
	for i := 0; i < length && i < len(staticShifts); i++ {
		shifts[i] = staticShifts[i]
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

// reserveMapJS is the exact substitution map array from the client application.
var reserveMapJS = []int{28, 38, 59, 60, 29, 2, 48, 29, 54, 20, 15, 48, 31, 8, 2, 15, 53, 53, 39, 34, 20, 25, 16, 11, 31, 63, 14, 15, 59, 49, 1, 28, 33, 50, 55, 62, 3, 24, 10, 50, 27, 5, 56, 33, 61, 9, 10, 7, 19, 0, 25, 50, 33, 48, 54, 32, 59, 3, 51, 47, 39, 34, 52, 56}

// reverseReserveMapJS is the inverse of reserveMapJS
var reverseReserveMapJS = make([]int, len(Charset))

func init() {
	// Initialize with -1 for safety
	for i := range reverseReserveMapJS {
		reverseReserveMapJS[i] = -1
	}
	for inIdx, outIdx := range reserveMapJS {
		reverseReserveMapJS[outIdx] = inIdx
	}
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

	encrypted := make([]byte, len(middle))

	for i := 0; i < len(middle); i++ {
		ch := middle[i]
		idx := charsetIndex(rune(ch))
		if idx != -1 {
			encrypted[i] = Charset[reserveMapJS[idx]]
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

	decrypted := make([]byte, len(middle))

	// Decrypt each character
	for i := 0; i < len(middle); i++ {
		ch := middle[i]
		idx := charsetIndex(rune(ch))
		if idx != -1 && reverseReserveMapJS[idx] != -1 {
			decrypted[i] = Charset[reverseReserveMapJS[idx]]
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
}
