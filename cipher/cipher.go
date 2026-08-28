// Package cipher implements the RJ SLOT captcha-token ciphers exactly as the
// site's browser bundle does, so tokens encrypted here can be decrypted by the
// server. It is a faithful Go port of the reference JavaScript module
// (rjslotencryptionmodule.js): the same 10 cipher versions, the same additive
// shift driver, and the same version dispatch.
//
// Correctness is defined as byte-for-byte agreement with the JS module for a
// given (version, key, skip, length) — not merely "reversible". The previous
// implementation used invented SplitMix64/Fisher-Yates algorithms that round-
// tripped locally but produced ciphertext the site could not decrypt.
package cipher

import "math/big"

const (
	// Charset is the 64-character alphabet used by every cipher version.
	Charset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_"

	// alphaLen is len(Charset); every shift/substitution is taken modulo this.
	alphaLen = 64

	// Cipher version identifiers (match encryptByVersion in the JS module).
	VersionBlockMix     = 1  // block_mix / ChaCha-style keystream
	VersionBitmix       = 2  // bitmix / 6-bit Feistel network
	VersionCellular     = 3  // cellular_shift / Rule-30 automaton
	VersionRC4          = 4  // rc4_shift
	VersionLFSR         = 5  // lfsr_shift / Geffe generator
	VersionPolynomial   = 6  // polynomial / GF(67)
	VersionSubstReverse = 7  // subst_reverse / S-box + reverse
	VersionPRNG         = 8  // prng / LCG
	VersionModSquare    = 9  // modular square (Blum Blum Shub style)
	VersionLogistic     = 10 // logistic_shift / chaotic map

	// Default sign-in cipher parameters (Rule-30 cellular, v3).
	DefaultSigninVersion    = VersionCellular
	DefaultSigninKey        = "rb%a#)tveypgal^xc8qqzdox%vh23b@!lq8yj9@i@3jq$ua+@k"
	DefaultSigninSkip       = 5
	DefaultSigninEncryptLen = 22

	// Default reserve slot cipher parameters (bitmix Feistel, v2).
	DefaultReserveVersion    = VersionBitmix
	DefaultReserveKey        = "4%i$h3wegd7daghf4p!3a9kbxczvgk3gl@ozin01++b1z#g)=w"
	DefaultReserveSkip       = 3
	DefaultReserveEncryptLen = 20
)

// Global sign-in cipher parameters (updated by the live bundle scan).
var (
	SignInCipherVersion    = DefaultSigninVersion
	SignInCipherKey        = DefaultSigninKey
	SignInCipherSkip       = DefaultSigninSkip
	SignInCipherEncryptLen = DefaultSigninEncryptLen
)

// Global reserve slot cipher parameters (updated by the live bundle scan).
var (
	ReserveCipherVersion    = DefaultReserveVersion
	ReserveCipherKey        = DefaultReserveKey
	ReserveCipherSkip       = DefaultReserveSkip
	ReserveCipherEncryptLen = DefaultReserveEncryptLen
)

// Global initiate/payment cipher parameters (dg-epay; updated by the scan).
// Newer bundles reuse a single key for all purposes, so these default to the
// reserve config until the scan overrides them.
var (
	InitiateCipherVersion    = DefaultReserveVersion
	InitiateCipherKey        = DefaultReserveKey
	InitiateCipherSkip       = DefaultReserveSkip
	InitiateCipherEncryptLen = DefaultReserveEncryptLen
)

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// charsetIndex returns the index of a byte in Charset, or -1 if not present.
// Charset is ASCII, so a byte lookup matches JS's charCodeAt-based indexing.
func charsetIndex(b byte) int {
	for i := 0; i < len(Charset); i++ {
		if Charset[i] == b {
			return i
		}
	}
	return -1
}

// ── Additive-shift driver (mirrors additiveShift in the JS module) ────────────

// additiveShift adds (encrypt) or subtracts (decrypt) key-derived shifts over
// the [skip, skip+encryptLen) window of token, leaving the prefix/suffix and
// any non-charset bytes untouched. genShifts supplies the per-position shifts.
func additiveShift(token, key string, skip, encryptLen int, encrypt bool, genShifts func(key string, length int) []int) string {
	if token == "" {
		return token
	}
	p := max(0, min(skip, len(token)))
	a := max(0, min(encryptLen, len(token)-p))
	if a == 0 {
		return token
	}
	mid := []byte(token[p : p+a])
	shifts := genShifts(key, len(mid))
	for i := 0; i < len(mid); i++ {
		x := charsetIndex(mid[i])
		if x == -1 {
			continue
		}
		if encrypt {
			mid[i] = Charset[(x+shifts[i])%alphaLen]
		} else {
			mid[i] = Charset[((x-shifts[i])%alphaLen+alphaLen)%alphaLen]
		}
	}
	return token[:p] + string(mid) + token[p+a:]
}

// ── v1: block_mix / ChaCha-style keystream ────────────────────────────────────

func rotl32(x uint32, n uint) uint32 { return (x << n) | (x >> (32 - n)) }

func chachaQR(s []uint32, a, b, c, d int) {
	s[a] = s[a] + s[b]
	s[d] = rotl32(s[d]^s[a], 16)
	s[c] = s[c] + s[d]
	s[b] = rotl32(s[b]^s[c], 12)
	s[a] = s[a] + s[b]
	s[d] = rotl32(s[d]^s[a], 8)
	s[c] = s[c] + s[d]
	s[b] = rotl32(s[b]^s[c], 7)
}

func generateShiftsChaCha(key string, length int) []int {
	st := make([]uint32, 16)
	for p := 0; p < len(key); p++ {
		st[p%16] += uint32(key[p])
	}
	st[15] = uint32(length)
	shifts := make([]int, 0, length)
	blocks := (length + 3) / 4
	for p := 0; p < blocks; p++ {
		st[14] = uint32(p)
		e := make([]uint32, 16)
		copy(e, st)
		for r := 0; r < 10; r++ {
			chachaQR(e, 0, 4, 8, 12)
			chachaQR(e, 1, 5, 9, 13)
			chachaQR(e, 2, 6, 10, 14)
			chachaQR(e, 3, 7, 11, 15)
		}
		for k := 0; k < 4; k++ {
			shifts = append(shifts, int(e[k]%alphaLen))
		}
	}
	return shifts
}

// ── v2: bitmix / 6-bit Feistel network ────────────────────────────────────────

func bitmixRoundKeys(key string) []int {
	var c uint32
	for f := 0; f < len(key); f++ {
		c += uint32(key[f]) * uint32(f+1)
	}
	rk := make([]int, 8)
	for f := 0; f < 8; f++ {
		c = c*1103515245 + 12345
		rk[f] = int(c & 7)
	}
	return rk
}

func bitmixFwd(val int, rk []int) int {
	hi, lo := (val>>3)&7, val&7
	for r := 0; r < len(rk); r++ {
		x := hi ^ (7 & ((lo*3 + rk[r]) ^ 3))
		hi, lo = lo, x
	}
	return (lo << 3) | hi
}

func bitmixInv(val int, rk []int) int {
	lo, hi := (val>>3)&7, val&7
	for r := len(rk) - 1; r >= 0; r-- {
		x := hi
		hi = lo ^ (7 & ((x*3 + rk[r]) ^ 3))
		lo = x
	}
	return (hi << 3) | lo
}

func cryptBitmix(token, key string, skip, encryptLen int, encrypt bool) string {
	if token == "" {
		return token
	}
	p := max(0, min(skip, len(token)))
	a := max(0, min(encryptLen, len(token)-p))
	if a == 0 {
		return token
	}
	mid := []byte(token[p : p+a])
	rk := bitmixRoundKeys(key)
	for i := 0; i < len(mid); i++ {
		x := charsetIndex(mid[i])
		if x == -1 {
			continue
		}
		if encrypt {
			mid[i] = Charset[bitmixFwd(x, rk)%alphaLen]
		} else {
			mid[i] = Charset[bitmixInv(x, rk)%alphaLen]
		}
	}
	return token[:p] + string(mid) + token[p+a:]
}

// ── v3: cellular_shift / Rule-30 cellular automaton ───────────────────────────

func generateShiftsCellular(key string, length int) []int {
	cur := make([]byte, 64)
	for i := 0; i < len(key); i++ {
		cur[i%64] ^= key[i] & 1
	}
	cur[32] = 1
	shifts := make([]int, 0, length)
	for s := 0; s < length; s++ {
		nx := make([]byte, 64)
		v := 0
		for d := 0; d < 64; d++ {
			L := cur[(d+63)%64]
			C := cur[d]
			R := cur[(d+1)%64]
			nx[d] = byte(30>>((L<<2)|(C<<1)|R)) & 1
			if d < 6 {
				v = (v << 1) | int(nx[d])
			}
		}
		cur = nx
		shifts = append(shifts, v%alphaLen)
	}
	return shifts
}

// ── v4: rc4_shift / RC4 over a 64-element state ───────────────────────────────

func generateShiftsRC4(key string, length int) []int {
	const sz = 64
	S := make([]int, sz)
	for i := range S {
		S[i] = i
	}
	j := 0
	for i := 0; i < sz; i++ {
		j = (j + S[i] + int(key[i%len(key)])) % sz
		S[i], S[j] = S[j], S[i]
	}
	i, j := 0, 0
	shifts := make([]int, 0, length)
	for k := 0; k < length; k++ {
		i = (i + 1) % sz
		j = (j + S[i]) % sz
		S[i], S[j] = S[j], S[i]
		shifts = append(shifts, S[(S[i]+S[j])%sz])
	}
	return shifts
}

// ── v5: lfsr_shift / three-LFSR Geffe generator ───────────────────────────────

func generateShiftsLFSR(key string, length int) []int {
	var u, s, l uint32 = 74565, 424090, 773615
	for i := 0; i < len(key); i++ {
		c := uint32(key[i])
		u ^= c | 1
		s ^= 1 | (c << 2)
		l ^= 1 | (c << 4)
	}
	shifts := make([]int, 0, length)
	for p := 0; p < length; p++ {
		var e uint32
		for t := 0; t < 6; t++ {
			ub := 1 & (u ^ u>>2 ^ u>>3 ^ u>>5)
			u = (u >> 1) | (ub << 15)
			sb := 1 & (s ^ s>>1 ^ s>>2 ^ s>>7)
			s = (s >> 1) | (sb << 16)
			lb := 1 & (l ^ l>>1 ^ l>>2 ^ l>>22)
			l = (l >> 1) | (lb << 23)
			h := (ub & sb) ^ (^ub & lb)
			e = (e << 1) | (h & 1)
		}
		shifts = append(shifts, int(((e%alphaLen)+alphaLen)%alphaLen))
	}
	return shifts
}

// ── v6: polynomial / GF(67) additive-shift ────────────────────────────────────

func generateShiftsPolynomial(key string, length int) []int {
	coeff := make([]int, 0, len(key))
	for n := 0; n < len(key); n++ {
		coeff = append(coeff, ((int(key[n%len(key)])+n)%67+67)%67)
	}
	shifts := make([]int, 0, length)
	for d := 1; d <= length; d++ {
		e, t := 0, 1
		for _, a := range coeff {
			e = (e + a*t) % 67
			t = (t * d) % 67
		}
		shifts = append(shifts, e%alphaLen)
	}
	return shifts
}

// ── v7: subst_reverse / RC4-keyed S-box substitution + reverse ────────────────

func cryptSBox(token, key string, skip, encryptLen int, encrypt bool) string {
	if token == "" {
		return token
	}
	p := max(0, min(skip, len(token)))
	a := max(0, min(encryptLen, len(token)-p))
	if a == 0 {
		return token
	}
	mid := []byte(token[p : p+a])
	n := alphaLen
	sbox := make([]int, n)
	for i := range sbox {
		sbox[i] = i
	}
	u := 0
	for h := 0; h < n; h++ {
		u = (u + sbox[h] + int(key[h%len(key)])) % n
		sbox[h], sbox[u] = sbox[u], sbox[h]
	}
	inv := make([]int, n)
	for h := 0; h < n; h++ {
		inv[sbox[h]] = h
	}
	reverse := func(b []byte) {
		for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
			b[i], b[j] = b[j], b[i]
		}
	}
	if encrypt {
		for i := 0; i < len(mid); i++ {
			if x := charsetIndex(mid[i]); x != -1 {
				mid[i] = Charset[sbox[x]]
			}
		}
		reverse(mid)
	} else {
		reverse(mid)
		for i := 0; i < len(mid); i++ {
			if x := charsetIndex(mid[i]); x != -1 {
				mid[i] = Charset[inv[x]]
			}
		}
	}
	return token[:p] + string(mid) + token[p+a:]
}

// ── v8: prng / LCG additive-shift ─────────────────────────────────────────────

func generateShiftsLCG(key string, length int) []int {
	var seed uint32 = 123456789
	var mul uint32 = 1103515245
	for i := 0; i < len(key); i++ {
		seed += uint32(key[i])
	}
	shifts := make([]int, length)
	for i := 0; i < length; i++ {
		seed = seed*mul + 12345
		mul = (mul + seed) | 1
		shifts[i] = int((seed >> 16) % alphaLen)
	}
	return shifts
}

// ── v9: modular square (Blum Blum Shub style) ─────────────────────────────────

func generateShiftsModSquare(key string, length int, modulus int64) []int {
	A := big.NewInt(1000036000099)
	if modulus > 0 {
		A = big.NewInt(modulus)
	}
	s := big.NewInt(314159265)
	tmp := new(big.Int)
	for i := 0; i < len(key); i++ {
		tmp.SetInt64(int64(key[i]) * int64(i+1))
		s.Add(s, tmp)
		s.Mod(s, A)
	}
	if s.Bit(0) == 0 {
		s.Add(s, big.NewInt(1))
	}
	alpha := big.NewInt(alphaLen)
	shifts := make([]int, length)
	for i := 0; i < length; i++ {
		s.Mul(s, s)
		s.Mod(s, A)
		shifts[i] = int(new(big.Int).Mod(s, alpha).Int64())
	}
	return shifts
}

// ── v10: logistic_shift / chaotic logistic map ────────────────────────────────

func generateShiftsLogistic(key string, length int) []int {
	u := 0.5
	for i := 0; i < len(key); i++ {
		u += float64(key[i]) / 256
		u -= float64(int(u)) // u % 1 for the non-negative u produced here
	}
	if u == 0 {
		u = 0.5
	}
	shifts := make([]int, 0, length)
	for f := 0; f < length+100; f++ {
		u = (3.99 * u) * (1 - u)
		if f >= 100 {
			shifts = append(shifts, int(1e7*u)%alphaLen)
		}
	}
	return shifts
}

// ── Version dispatch (mirrors encryptByVersion) ───────────────────────────────

// EncryptByVersion encrypts token with the given cipher version. modulus is only
// used by v9 (pass 0 for the default); it is ignored by every other version.
func EncryptByVersion(version int, token, key string, skip, encryptLen int, modulus int64) string {
	return cryptByVersion(version, token, key, skip, encryptLen, modulus, true)
}

// DecryptByVersion inverts EncryptByVersion for the same parameters.
func DecryptByVersion(version int, token, key string, skip, encryptLen int, modulus int64) string {
	return cryptByVersion(version, token, key, skip, encryptLen, modulus, false)
}

func cryptByVersion(version int, token, key string, skip, encryptLen int, modulus int64, encrypt bool) string {
	switch version {
	case VersionBlockMix:
		return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsChaCha)
	case VersionBitmix:
		return cryptBitmix(token, key, skip, encryptLen, encrypt)
	case VersionCellular:
		return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsCellular)
	case VersionRC4:
		return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsRC4)
	case VersionLFSR:
		return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsLFSR)
	case VersionPolynomial:
		return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsPolynomial)
	case VersionSubstReverse:
		return cryptSBox(token, key, skip, encryptLen, encrypt)
	case VersionPRNG:
		return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsLCG)
	case VersionModSquare:
		return additiveShift(token, key, skip, encryptLen, encrypt, func(k string, l int) []int {
			return generateShiftsModSquare(k, l, modulus)
		})
	case VersionLogistic:
		return additiveShift(token, key, skip, encryptLen, encrypt, generateShiftsLogistic)
	default:
		return token
	}
}

// ── Sign-in cipher (Rule-30 cellular, v3) ─────────────────────────────────────

// ProcessToken encrypts a captcha token with the cellular (v3) sign-in cipher.
func ProcessToken(token, key string, skip, encryptLen int) string {
	return EncryptByVersion(VersionCellular, token, key, skip, encryptLen, 0)
}

// ReverseToken decrypts a captcha token encrypted with ProcessToken.
func ReverseToken(token, key string, skip, encryptLen int) string {
	return DecryptByVersion(VersionCellular, token, key, skip, encryptLen, 0)
}

// ── Reserve slot cipher (bitmix Feistel, v2) ──────────────────────────────────

// ProcessTokenFeistel encrypts a captcha token with the bitmix (v2) cipher.
func ProcessTokenFeistel(token, key string, skip, encryptLen int) string {
	return EncryptByVersion(VersionBitmix, token, key, skip, encryptLen, 0)
}

// ReverseTokenFeistel decrypts a captcha token encrypted with ProcessTokenFeistel.
func ReverseTokenFeistel(token, key string, skip, encryptLen int) string {
	return DecryptByVersion(VersionBitmix, token, key, skip, encryptLen, 0)
}

// ── Backward-compatibility aliases ────────────────────────────────────────────

// ProcessTokenPoly is retained for callers that used the old name; it encrypts
// with the bitmix (v2) cipher. Use ProcessTokenFeistel or EncryptByVersion.
func ProcessTokenPoly(token, key string, skip, encryptLen int) string {
	return ProcessTokenFeistel(token, key, skip, encryptLen)
}

// ProcessTokenBitmix encrypts with the bitmix (v2) cipher.
func ProcessTokenBitmix(token, key string, skip, encryptLen int) string {
	return ProcessTokenFeistel(token, key, skip, encryptLen)
}

// ReverseTokenPoly decrypts a token encrypted with ProcessTokenPoly.
func ReverseTokenPoly(token, key string, skip, encryptLen int) string {
	return ReverseTokenFeistel(token, key, skip, encryptLen)
}

// ── Convenience functions (use the current global config) ─────────────────────

// ProcessTokenReserveSlot encrypts a reserve slot token with the reserve config.
func ProcessTokenReserveSlot(token string) string {
	return EncryptByVersion(ReserveCipherVersion, token, ReserveCipherKey, ReserveCipherSkip, ReserveCipherEncryptLen, 0)
}

// ProcessTokenSignin encrypts a sign-in token with the sign-in config.
func ProcessTokenSignin(token string) string {
	return EncryptByVersion(SignInCipherVersion, token, SignInCipherKey, SignInCipherSkip, SignInCipherEncryptLen, 0)
}

// ProcessTokenInitiate encrypts an initiate/payment (dg-epay) token.
func ProcessTokenInitiate(token string) string {
	return EncryptByVersion(InitiateCipherVersion, token, InitiateCipherKey, InitiateCipherSkip, InitiateCipherEncryptLen, 0)
}

// SetSignInCipherConfig updates the global sign-in cipher configuration.
func SetSignInCipherConfig(version int, key string, skip, encryptLen int) {
	SignInCipherVersion = version
	SignInCipherKey = key
	SignInCipherSkip = skip
	SignInCipherEncryptLen = encryptLen
}

// SetReserveCipherConfig updates the global reserve slot cipher configuration.
func SetReserveCipherConfig(version int, key string, skip, encryptLen int) {
	ReserveCipherVersion = version
	ReserveCipherKey = key
	ReserveCipherSkip = skip
	ReserveCipherEncryptLen = encryptLen
}

// SetInitiateCipherConfig updates the global initiate/payment cipher configuration.
func SetInitiateCipherConfig(version int, key string, skip, encryptLen int) {
	InitiateCipherVersion = version
	InitiateCipherKey = key
	InitiateCipherSkip = skip
	InitiateCipherEncryptLen = encryptLen
}
