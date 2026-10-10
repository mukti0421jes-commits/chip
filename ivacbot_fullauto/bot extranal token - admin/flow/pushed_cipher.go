package flow

import "github.com/dop251/goja"

// ──────────────────────────────────────────────────────────────────────────────
// PUSHED-CIPHER ENCRYPT
//
// ivacflow generates a self-contained cipher.js by RUNNING the live bundle's own
// cipher during the walk — it exposes encryptToken(rawToken, purpose). Running that
// code directly encrypts a fresh captcha token for ANY algorithm the walk captured,
// including ones the bot never reimplemented in Go (the walk can recover an unknown
// additive cipher's keystream straight from the site's output).
//
// This is why the bot prefers the pushed code: it USES what ivacflow resolved,
// instead of re-deriving it. The Go per-version path stays as the fallback for when
// no code was pushed (the bot's own scan) or the code fails to run.
//
// A fresh goja.Runtime per call keeps this goroutine-safe (Config is shared across
// instances) at the cost of compiling a ~2 KB script each time — cheap, and it runs
// at most twice per booking (signin + reserve).
// ──────────────────────────────────────────────────────────────────────────────

// runPushedCipher runs ivacflow's pushed cipher code and returns
// encryptToken(token, purpose). ok=false on any problem, so the caller falls back to
// the Go reimplementation — this path can never make encryption worse, only add
// coverage for algorithms Go does not know.
func runPushedCipher(code, token, purpose string) (out string, ok bool) {
	if code == "" || token == "" || purpose == "" {
		return "", false
	}
	defer func() {
		if recover() != nil { // a malformed pushed script must never crash a run
			out, ok = "", false
		}
	}()
	vm := goja.New()
	if _, err := vm.RunString(code); err != nil {
		return "", false
	}
	fn, isFn := goja.AssertFunction(vm.Get("encryptToken"))
	if !isFn {
		return "", false
	}
	res, err := fn(goja.Undefined(), vm.ToValue(token), vm.ToValue(purpose))
	if err != nil {
		return "", false
	}
	s, isStr := res.Export().(string)
	if !isStr || s == "" {
		return "", false
	}
	return s, true
}
