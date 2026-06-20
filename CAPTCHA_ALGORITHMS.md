# Captcha Token Encryption — 10 Algorithm Versions

Reverse-engineered and **verified byte-for-byte** against the live app bundle
(`encryptText`/`decryptText` of each module). Verification: 2000 random tokens
per version, encrypt + decrypt + roundtrip all match the bundle exactly.

Shared charset (radix-64), same for every version:

```
0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_
```

Only the window `[prefix_len, prefix_len + encode_len)` of a token is transformed;
the prefix and the tail are left untouched. The clean, runnable implementation of
all ten is in `cipher.js` (`encryptVersion(v, token, key, prefixLen, encodeLen)` /
`decryptVersion(...)`).

| version | algorithm        | bundle module (enc/dec) | core technique                                             |
|--------:|------------------|-------------------------|------------------------------------------------------------|
| 1       | `block_mix`      | `PX` / `qX`             | ChaCha-style 16-word state, 10 column quarter-rounds       |
| 2       | `bitmix`         | `e$` / `t$`             | 6-bit Feistel network, 8 rounds, F = `7&((x*3+k)^3)`       |
| 3       | `cellular_shift` | `x$` / `w$`             | elementary cellular automaton, **Rule 30**                 |
| 4       | `rc4_shift`      | `D$` / `j$`             | RC4 (KSA+PRGA) over a 64-element state                     |
| 5       | `lfsr_shift`     | `o0` / `u0`             | three LFSRs combined by a **Geffe** generator              |
| 6       | `polynomial`     | `C0` / `_0`             | Horner polynomial evaluation over GF(67)                   |
| 7       | `subst_reverse`  | `j0` / `Q0`             | key-scheduled S-box substitution + window reversal         |
| 8       | `prng`           | `d1` / `f1`             | LCG with self-modifying multiplier                         |
| 9       | `mod_square`     | `G1` / `q1`             | Blum-Blum-Shub style `x = x*x mod 0xe8d6ca6163`            |
| 10      | `logistic_shift` | `$1` / `e4`             | chaotic logistic map `r·x·(1−x)`, r=3.99, 100-step warm-up |

Versions 1,3,4,5,6,8,9,10 are **additive-shift** ciphers (`out = Charset[(idx + keystream[i]) mod 64]`,
keystream derived from the key only). Version 2 is a data-dependent Feistel
permutation per character; version 7 is an S-box permutation plus reversal.

## Per-version config (from the app)

```
v1  block_mix       prefix=?  encode=?   key=(template / not provided)
v2  bitmix          prefix=3  encode=20  key=4%i$h3wegd7daghf4p!3a9kbxczvgk3gl@ozin01++b1z#g)=w
v3  cellular_shift  prefix=5  encode=22  key=rb%a#)tveypgal^xc8qqzdox%vh23b@!lq8yj9@i@3jq$ua+@k
v4  rc4_shift       prefix=3  encode=20  key=l4z&xb9q!7sfon6hhi&p5d1dgyy#f$-y%tx66sdb#0i31xg^ke
v5  lfsr_shift      prefix=4  encode=22  key=@541m3tp&t63noy&3ngwa%fgfivy3n1_7d)zvj$h-au+bah50f
v6  polynomial      prefix=7  encode=23  key=671hnk6vg7e5hnv$4fy+7-_ch_io0)q$_xz=k++r-^&i32dfst
v7  subst_reverse   prefix=3  encode=21  key=7*z-x)kx)p&a$381#fv$=d8-8(41e7s!*orx9e3s$1ne2z6c7w
v8  prng            prefix=7  encode=19  key=tbp&12h&cc0q58*s!!+x)ga83rncmmzv9mb^%4r+3j)5caqrrn
v9  mod_square      prefix=4  encode=23  key=mg!b=zdz^y_ly!-#x_e%z65s_$&#!d1@w%@2ux%mr0d)o+6mp9
v10 logistic_shift  prefix=8  encode=29  key=vd@+sy&b)fjogphl3#=3i(-uuqemhdk2%7zuybitu)!^)rcy5v
```
