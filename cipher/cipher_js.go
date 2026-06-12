// Package cipher — JavaScript source port: three new cipher algorithms
// extracted from the minified frontend bundle.
//
// Algorithm A: Dual LCG  (Q0 key schedule  → H0/Y0 encrypt/decrypt)
// Algorithm B: Mod-Exp   (g1 key schedule  → x1/b1 encrypt/decrypt)
// Algorithm C: Logistic  (G1 key schedule  → L1/K1 encrypt/decrypt)
package cipher

import (
	"math"
	"math/big"
)

// ── JS cipher parameters ──────────────────────────────────────────────────────

const (
	// JSSigninSkip and JSSigninEncryptLen are the skip/encryptLen values
	// observed in the JS bundle validation calls.
	JSSigninSkip       = 9
	JSSigninEncryptLen = 19

	// JSReserveSkip and JSReserveEncryptLen are the observed reserve params.
	JSReserveSkip       = 9
	JSReserveEncryptLen = 19
)

// ── Algorithm A — Dual LCG (Q0 key schedule) ─────────────────────────────────
//
// JS source (Q0 function):
//   let c = 123456789, u = 1103515245
//   for key chars: c = (c + charCode) >>> 0
//   per position:  c = (Math.imul(c, u) + 12345) >>> 0
//                  u = ((u + c) >>> 0) | 1
//                  output: (c >>> 16) % 64

func dualLCGKeySchedule(key string, length int) []int {
	c := uint32(123456789)
	u := uint32(1103515245)

	for i := 0; i < len(key); i++ {
		c = c + uint32(key[i])
	}

	out := make([]int, length)
	for i := 0; i < length; i++ {
		c = c*u + 12345
		u = (u + c) | 1
		out[i] = int((c >> 16) % 64)
	}
	return out
}

// ProcessTokenDualLCG encrypts a captcha token using the Dual LCG cipher.
// JavaScript equivalent: H0(token, key, skip, encryptLen)
func ProcessTokenDualLCG(token, key string, skip, encryptLen int) string {
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

	shifts := dualLCGKeySchedule(key, len(middle))

	encrypted := make([]byte, len(middle))
	for i := 0; i < len(middle); i++ {
		ch := middle[i]
		idx := charsetIndex(rune(ch))
		if idx == -1 {
			encrypted[i] = ch
		} else {
			encrypted[i] = Charset[(idx+shifts[i])%len(Charset)]
		}
	}
	return prefix + string(encrypted) + suffix
}

// ReverseTokenDualLCG decrypts a captcha token encrypted with ProcessTokenDualLCG.
// JavaScript equivalent: Y0(token, key, skip, encryptLen)
func ReverseTokenDualLCG(token, key string, skip, encryptLen int) string {
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

	shifts := dualLCGKeySchedule(key, len(middle))

	decrypted := make([]byte, len(middle))
	for i := 0; i < len(middle); i++ {
		ch := middle[i]
		idx := charsetIndex(rune(ch))
		if idx == -1 {
			decrypted[i] = ch
		} else {
			newIdx := (idx - shifts[i]) % len(Charset)
			if newIdx < 0 {
				newIdx += len(Charset)
			}
			decrypted[i] = Charset[newIdx]
		}
	}
	return prefix + string(decrypted) + suffix
}

// ── Algorithm B — Modular Exponentiation (g1 key schedule) ───────────────────
//
// JS source (g1 function):
//   const a = 0xe8d6ca6163   // 999_999_999_843
//   let f = 314159265
//   for key chars: f = (f + charCode * (k+1)) % a
//   if f % 2 == 0: f++
//   per position:  f = f^f mod a  (via m1 square-and-multiply)
//                  output: f % 64

var modExpA = new(big.Int).SetUint64(0xe8d6ca6163)

func modExpKeySchedule(key string, length int) []int {
	f := new(big.Int).SetInt64(314159265)
	a := new(big.Int).Set(modExpA)

	for k := 0; k < len(key); k++ {
		// f = (f + charCode*(k+1)) % a
		term := new(big.Int).SetInt64(int64(key[k]) * int64(k+1))
		f.Add(f, term)
		f.Mod(f, a)
	}
	if new(big.Int).Mod(f, big.NewInt(2)).Sign() == 0 {
		f.Add(f, big.NewInt(1))
	}

	out := make([]int, length)
	for k := 0; k < length; k++ {
		base := new(big.Int).Set(f)
		exp := new(big.Int).Set(f)
		f.Exp(base, exp, a)
		out[k] = int(new(big.Int).Mod(f, big.NewInt(64)).Int64())
	}
	return out
}

// ProcessTokenModExp encrypts a captcha token using the Modular-Exponentiation cipher.
// JavaScript equivalent: x1(token, key, skip, encryptLen)
func ProcessTokenModExp(token, key string, skip, encryptLen int) string {
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

	shifts := modExpKeySchedule(key, len(middle))

	encrypted := make([]byte, len(middle))
	for i := 0; i < len(middle); i++ {
		ch := middle[i]
		idx := charsetIndex(rune(ch))
		if idx == -1 {
			encrypted[i] = ch
		} else {
			encrypted[i] = Charset[(idx+shifts[i])%len(Charset)]
		}
	}
	return prefix + string(encrypted) + suffix
}

// ReverseTokenModExp decrypts a captcha token encrypted with ProcessTokenModExp.
// JavaScript equivalent: b1(token, key, skip, encryptLen)
func ReverseTokenModExp(token, key string, skip, encryptLen int) string {
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

	shifts := modExpKeySchedule(key, len(middle))

	decrypted := make([]byte, len(middle))
	for i := 0; i < len(middle); i++ {
		ch := middle[i]
		idx := charsetIndex(rune(ch))
		if idx == -1 {
			decrypted[i] = ch
		} else {
			newIdx := (idx - shifts[i]) % len(Charset)
			if newIdx < 0 {
				newIdx += len(Charset)
			}
			decrypted[i] = Charset[newIdx]
		}
	}
	return prefix + string(decrypted) + suffix
}

// ── Algorithm C — Logistic Map (G1 key schedule) ─────────────────────────────
//
// JS source (G1 function):
//   let u = 0.5
//   for key chars: u = (u * charCode / 256) % 1
//   if u == 0: u = 0.5
//   warmup 100 iters + collect length values:
//     u = 3.99 * u * (1 - u)
//     output: floor(1e7 * u) % 64

func logisticKeySchedule(key string, length int) []int {
	u := 0.5

	for i := 0; i < len(key); i++ {
		u = math.Mod(u*float64(key[i])/256.0, 1.0)
	}
	if u == 0 {
		u = 0.5
	}

	out := make([]int, length)
	outIdx := 0
	for w := 0; w < length+100; w++ {
		u = 3.99 * u * (1.0 - u)
		if w >= 100 {
			out[outIdx] = int(math.Floor(1e7*u)) % 64
			outIdx++
		}
	}
	return out
}

// ProcessTokenLogistic encrypts a captcha token using the Logistic Map cipher.
// JavaScript equivalent: L1(token, key, skip, encryptLen)
func ProcessTokenLogistic(token, key string, skip, encryptLen int) string {
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

	shifts := logisticKeySchedule(key, len(middle))

	encrypted := make([]byte, len(middle))
	for i := 0; i < len(middle); i++ {
		ch := middle[i]
		idx := charsetIndex(rune(ch))
		if idx == -1 {
			encrypted[i] = ch
		} else {
			encrypted[i] = Charset[(idx+shifts[i])%len(Charset)]
		}
	}
	return prefix + string(encrypted) + suffix
}

// ReverseTokenLogistic decrypts a captcha token encrypted with ProcessTokenLogistic.
// JavaScript equivalent: K1(token, key, skip, encryptLen)
func ReverseTokenLogistic(token, key string, skip, encryptLen int) string {
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

	shifts := logisticKeySchedule(key, len(middle))

	decrypted := make([]byte, len(middle))
	for i := 0; i < len(middle); i++ {
		ch := middle[i]
		idx := charsetIndex(rune(ch))
		if idx == -1 {
			decrypted[i] = ch
		} else {
			newIdx := (idx - shifts[i]) % len(Charset)
			if newIdx < 0 {
				newIdx += len(Charset)
			}
			decrypted[i] = Charset[newIdx]
		}
	}
	return prefix + string(decrypted) + suffix
}
