# cipher

A Go port of the RJ SLOT captcha-token ciphers, matching the site's browser
bundle **byte-for-byte**. Tokens encrypted here can be decrypted by the server
because every cipher version reproduces the exact output of the reference
JavaScript module (`rjslotencryptionmodule.js`).

## Alphabet

```
0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_
```

64 characters (URL-safe base64 style), so index arithmetic is done `% 64`.

## How the skip / encryptLen window works

Every version splits the input into three parts and only transforms the middle:

```
token = [ prefix (skip chars) ][ middle (encryptLen chars) ][ suffix ]
                                  ^^^^^^ only this is encrypted ^^^^^^
```

Characters not in the alphabet are passed through unchanged.

## Cipher versions

`EncryptByVersion(version, token, key, skip, encryptLen, modulus)` selects the
algorithm, exactly like `encryptByVersion` in the JS bundle. `DecryptByVersion`
inverts it. `modulus` is only used by v9 (pass `0` for the default).

| v  | Name           | Algorithm                                        |
|----|----------------|--------------------------------------------------|
| 1  | block_mix      | ChaCha-style keystream (16-word state, 10 rounds)|
| 2  | bitmix         | 6-bit Feistel network (8 rounds)                 |
| 3  | cellular_shift | Rule-30 cellular automaton                       |
| 4  | rc4_shift      | RC4 over a 64-element state                      |
| 5  | lfsr_shift     | three-LFSR Geffe generator                       |
| 6  | polynomial     | GF(67) polynomial evaluation                     |
| 7  | subst_reverse  | RC4-keyed S-box substitution + reverse           |
| 8  | prng           | LCG additive shift                               |
| 9  | modular square | Blum-Blum-Shub style (uses `modulus`)            |
| 10 | logistic_shift | chaotic logistic map (r=3.99, 100-step warmup)   |

Versions 1, 3, 4, 5, 6, 8, 9, 10 are additive shifts (each derives per-position
shift values from the key); versions 2 and 7 transform each character directly.

## Purpose configs

The bot resolves a cipher config per purpose from the live bundle scan and
stores it in the global config, used by the convenience helpers:

- **sign-in** — `ProcessTokenSignin` (default v3, cellular)
- **reserve slot** — `ProcessTokenReserveSlot` (default v2, bitmix)
- **initiate / payment (dg-epay)** — `ProcessTokenInitiate`

Update them with `SetSignInCipherConfig`, `SetReserveCipherConfig`, and
`SetInitiateCipherConfig`.

## Run the demo

```
go run ./cmd/demo
```

## Run the tests

```
go test ./cipher/
```

`TestMatchesJSVectors` pins each version's output against the reference vectors
extracted from the JS module, so any drift from the site's algorithm fails the
build. Other tests cover round-trip correctness and key sensitivity.
