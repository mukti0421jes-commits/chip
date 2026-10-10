package flow

import "math/big"

// Captcha-token cipher — a faithful Go port of RJ SLOT v10.5's encryptByVersion
// (10 versions). Byte-for-byte verified against the JS module. Used to encrypt
// the captcha token before signin/reserve (initiate sends the raw token instead).

const cipherCharset = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_"
const cipherAlpha = 64

func csIdx(b byte) int {
	for i := 0; i < len(cipherCharset); i++ {
		if cipherCharset[i] == b {
			return i
		}
	}
	return -1
}

func cmax(a, b int) int {
	if a > b {
		return a
	}
	return b
}
func cmin(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func additiveShift(token, key string, skip, encLen int, gen func(string, int) []int) string {
	if token == "" {
		return token
	}
	p := cmax(0, cmin(skip, len(token)))
	a := cmax(0, cmin(encLen, len(token)-p))
	if a == 0 {
		return token
	}
	mid := []byte(token[p : p+a])
	sh := gen(key, len(mid))
	for i := 0; i < len(mid); i++ {
		x := csIdx(mid[i])
		if x == -1 {
			continue
		}
		mid[i] = cipherCharset[(x+sh[i])%cipherAlpha]
	}
	return token[:p] + string(mid) + token[p+a:]
}

// v1 block_mix / ChaCha
func rotl32(x uint32, n uint) uint32 { return (x << n) | (x >> (32 - n)) }
func chachaQR(s []uint32, a, b, c, d int) {
	s[a] += s[b]
	s[d] = rotl32(s[d]^s[a], 16)
	s[c] += s[d]
	s[b] = rotl32(s[b]^s[c], 12)
	s[a] += s[b]
	s[d] = rotl32(s[d]^s[a], 8)
	s[c] += s[d]
	s[b] = rotl32(s[b]^s[c], 7)
}
func genChaCha(key string, length int) []int {
	st := make([]uint32, 16)
	for p := 0; p < len(key); p++ {
		st[p%16] += uint32(key[p])
	}
	st[15] = uint32(length)
	out := make([]int, 0, length)
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
			out = append(out, int(e[k]%cipherAlpha))
		}
	}
	return out
}

// v2 bitmix
func bitmixRK(key string) []int {
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
func bitmixFwd(v int, rk []int) int {
	hi, lo := (v>>3)&7, v&7
	for r := 0; r < len(rk); r++ {
		x := hi ^ (7 & ((lo*3 + rk[r]) ^ 3))
		hi, lo = lo, x
	}
	return (lo << 3) | hi
}
func bitmixInv(v int, rk []int) int {
	lo, hi := (v>>3)&7, v&7
	for r := len(rk) - 1; r >= 0; r-- {
		x := hi
		hi = lo ^ (7 & ((x*3 + rk[r]) ^ 3))
		lo = x
	}
	return (hi << 3) | lo
}
func cryptBitmix(token, key string, skip, encLen int, enc bool) string {
	if token == "" {
		return token
	}
	p := cmax(0, cmin(skip, len(token)))
	a := cmax(0, cmin(encLen, len(token)-p))
	if a == 0 {
		return token
	}
	mid := []byte(token[p : p+a])
	rk := bitmixRK(key)
	for i := 0; i < len(mid); i++ {
		x := csIdx(mid[i])
		if x == -1 {
			continue
		}
		if enc {
			mid[i] = cipherCharset[bitmixFwd(x, rk)%cipherAlpha]
		} else {
			mid[i] = cipherCharset[bitmixInv(x, rk)%cipherAlpha]
		}
	}
	return token[:p] + string(mid) + token[p+a:]
}

// v3 cellular
func genCellular(key string, length int) []int {
	cur := make([]byte, 64)
	for i := 0; i < len(key); i++ {
		cur[i%64] ^= key[i] & 1
	}
	cur[32] = 1
	out := make([]int, 0, length)
	for s := 0; s < length; s++ {
		nx := make([]byte, 64)
		v := 0
		for d := 0; d < 64; d++ {
			L, C, R := cur[(d+63)%64], cur[d], cur[(d+1)%64]
			nx[d] = byte(30>>((L<<2)|(C<<1)|R)) & 1
			if d < 6 {
				v = (v << 1) | int(nx[d])
			}
		}
		cur = nx
		out = append(out, v%cipherAlpha)
	}
	return out
}

// v4 rc4
func genRC4(key string, length int) []int {
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
	out := make([]int, 0, length)
	for k := 0; k < length; k++ {
		i = (i + 1) % sz
		j = (j + S[i]) % sz
		S[i], S[j] = S[j], S[i]
		out = append(out, S[(S[i]+S[j])%sz])
	}
	return out
}

// v5 lfsr
func genLFSR(key string, length int) []int {
	var u, s, l uint32 = 74565, 424090, 773615
	for i := 0; i < len(key); i++ {
		c := uint32(key[i])
		u ^= c | 1
		s ^= 1 | (c << 2)
		l ^= 1 | (c << 4)
	}
	out := make([]int, 0, length)
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
		out = append(out, int(((e%cipherAlpha)+cipherAlpha)%cipherAlpha))
	}
	return out
}

// v6 polynomial
func genPoly(key string, length int) []int {
	coeff := make([]int, 0, len(key))
	for n := 0; n < len(key); n++ {
		coeff = append(coeff, ((int(key[n%len(key)])+n)%67+67)%67)
	}
	out := make([]int, 0, length)
	for d := 1; d <= length; d++ {
		e, t := 0, 1
		for _, a := range coeff {
			e = (e + a*t) % 67
			t = (t * d) % 67
		}
		out = append(out, e%cipherAlpha)
	}
	return out
}

// v7 sbox
func cryptSBox(token, key string, skip, encLen int, enc bool) string {
	if token == "" {
		return token
	}
	p := cmax(0, cmin(skip, len(token)))
	a := cmax(0, cmin(encLen, len(token)-p))
	if a == 0 {
		return token
	}
	mid := []byte(token[p : p+a])
	n := cipherAlpha
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
	rev := func(b []byte) {
		for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
			b[i], b[j] = b[j], b[i]
		}
	}
	if enc {
		for i := 0; i < len(mid); i++ {
			if x := csIdx(mid[i]); x != -1 {
				mid[i] = cipherCharset[sbox[x]]
			}
		}
		rev(mid)
	} else {
		rev(mid)
		for i := 0; i < len(mid); i++ {
			if x := csIdx(mid[i]); x != -1 {
				mid[i] = cipherCharset[inv[x]]
			}
		}
	}
	return token[:p] + string(mid) + token[p+a:]
}

// v8 lcg
func genLCG(key string, length int) []int {
	var seed uint32 = 123456789
	var mul uint32 = 1103515245
	for i := 0; i < len(key); i++ {
		seed += uint32(key[i])
	}
	out := make([]int, length)
	for i := 0; i < length; i++ {
		seed = seed*mul + 12345
		mul = (mul + seed) | 1
		out[i] = int((seed >> 16) % cipherAlpha)
	}
	return out
}

// v9 modsquare
func genModSquare(key string, length int) []int {
	A := big.NewInt(1000036000099)
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
	alpha := big.NewInt(cipherAlpha)
	out := make([]int, length)
	for i := 0; i < length; i++ {
		s.Mul(s, s)
		s.Mod(s, A)
		out[i] = int(new(big.Int).Mod(s, alpha).Int64())
	}
	return out
}

// v10 logistic
func genLogistic(key string, length int) []int {
	u := 0.5
	for i := 0; i < len(key); i++ {
		u += float64(key[i]) / 256
		u -= float64(int(u))
	}
	if u == 0 {
		u = 0.5
	}
	out := make([]int, 0, length)
	for f := 0; f < length+100; f++ {
		u = (3.99 * u) * (1 - u)
		if f >= 100 {
			out = append(out, int(1e7*u)%cipherAlpha)
		}
	}
	return out
}

// EncryptByVersion encrypts a captcha token, matching RJ SLOT encryptByVersion.
func EncryptByVersion(version int, token, key string, skip, encLen int) string {
	switch version {
	case 1:
		return additiveShift(token, key, skip, encLen, genChaCha)
	case 2:
		return cryptBitmix(token, key, skip, encLen, true)
	case 3:
		return additiveShift(token, key, skip, encLen, genCellular)
	case 4:
		return additiveShift(token, key, skip, encLen, genRC4)
	case 5:
		return additiveShift(token, key, skip, encLen, genLFSR)
	case 6:
		return additiveShift(token, key, skip, encLen, genPoly)
	case 7:
		return cryptSBox(token, key, skip, encLen, true)
	case 8:
		return additiveShift(token, key, skip, encLen, genLCG)
	case 9:
		return additiveShift(token, key, skip, encLen, genModSquare)
	case 10:
		return additiveShift(token, key, skip, encLen, genLogistic)
	default:
		return token
	}
}

// EncryptForPurpose encrypts the token with the given purpose's scanned cipher.
// If the purpose has no config, the raw token is returned (matches RJ SLOT
// encryptTokenByPurpose: inactive/no-key → raw).
func (c *Config) EncryptForPurpose(token string, p *PurposeCipher) string {
	if p == nil || p.Key == "" {
		return token
	}
	return EncryptByVersion(p.Version, token, p.Key, p.Skip, p.Length)
}
