# cipher

A small, self-contained Go package demonstrating two **reversible, key-derived**
string ciphers over a 64-character alphabet. This is educational/generic crypto
code — it transforms arbitrary sample strings and is not tied to any external
service.

## Alphabet

```
0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_
```

64 characters (URL-safe base64 style), so index arithmetic is done `% 64`.

## How the skip / encryptLen window works

Both ciphers split the input into three parts and only transform the middle:

```
token = [ prefix (skip chars) ][ middle (encryptLen chars) ][ suffix ]
                                  ^^^^^^ only this is encrypted ^^^^^^
```

Characters not in the alphabet are passed through unchanged.

## Cipher 1 — "Cellular Automaton v3" (sign-in)

A **keyed polyalphabetic shift** (Vigenère-style over the 64-char alphabet):

1. A deterministic key stream (SplitMix64 seeded from an FNV-1a hash of the key)
   produces one shift value `shift[i]` in `[0, 64)` per position.
2. Encrypt: `out[i] = Charset[(idx[i] + shift[i]) % 64]`
3. Decrypt: `out[i] = Charset[(idx[i] - shift[i]) mod 64]`

Because the shifts come from the key, the same key always reproduces the same
stream, so decryption is exact.

## Cipher 2 — "Feistel v2" (reserve slot)

A **keyed bijective substitution**:

1. The key seeds a Fisher-Yates shuffle that builds a *permutation* of the 64
   alphabet indices (a one-to-one mapping).
2. Encrypt: substitute each char through the permutation.
3. Decrypt: substitute through the inverse permutation.

Being a true permutation guarantees lossless round-trips.

## Run the demo

```
go run ./cmd/demo
```

## Run the tests

```
go test ./cipher/
```

Tests cover round-trip correctness, key sensitivity, and that the reserve
permutation is bijective.
