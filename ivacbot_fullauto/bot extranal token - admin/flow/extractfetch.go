package flow

import (
	"context"
	_ "embed"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// ── Option A: run the PROVEN extract_fetch.js (v15) on the live-scanned bundle ──
//
// The Go live scan already downloads the bundle (for the cipher). Instead of
// waiting for an EXTERNAL autocheck to push endpoints, we run extract_fetch.js
// v15 on that SAME in-memory bundle, in a short `node` subprocess. It writes a
// `.endpoint-cache.json` we read back and apply — so ONE download gives cipher
// (Go scan) + all endpoints + slot id + dg-epay uuid (extract_fetch), with no
// autocheck push and no pre-signin wait.
//
// The script is EMBEDDED in the binary (below), so nothing has to ship beside the
// exe. It needs `node` on PATH; when node is missing or the run fails, the caller
// falls back to the built-in regex scan + any pushed cache — never a crash.

//go:embed extract_fetch.js
var extractFetchJS []byte

// extractFetchTimeout caps the subprocess. v15 finishes in <1s in Node; the cap
// only guards against a hang.
const extractFetchTimeout = 25 * time.Second

// RunExtractFetch writes bundleText to a temp file (named bundleBasename so the
// emitted cache's bundleName matches the live bundle), runs `node extract_fetch.js`
// on it, and returns the `.endpoint-cache.json` bytes. Returns nil on any problem
// (node missing, timeout, parse) after logging — the caller then keeps its regex
// scan / pushed cache. Safe to call once per shared scan (not per instance).
func RunExtractFetch(bundleText, bundleBasename string, log func(string)) []byte {
	if bundleText == "" {
		return nil
	}
	dir, err := os.MkdirTemp("", "ivac-ef-")
	if err != nil {
		log("⚠ extract_fetch: temp dir failed (" + err.Error() + ") — regex scan use hobe")
		return nil
	}
	defer os.RemoveAll(dir)

	scriptPath := filepath.Join(dir, "extract_fetch.js")
	if err := os.WriteFile(scriptPath, extractFetchJS, 0644); err != nil {
		log("⚠ extract_fetch: script write failed (" + err.Error() + ")")
		return nil
	}
	if bundleBasename == "" {
		bundleBasename = "bundle.js"
	}
	bundlePath := filepath.Join(dir, bundleBasename)
	if err := os.WriteFile(bundlePath, []byte(bundleText), 0644); err != nil {
		log("⚠ extract_fetch: bundle write failed (" + err.Error() + ")")
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), extractFetchTimeout)
	defer cancel()
	// node extract_fetch.js <bundle> <fetch-api-out>  → writes .endpoint-cache.json in `dir`
	cmd := exec.CommandContext(ctx, "node", scriptPath, bundlePath, filepath.Join(dir, "fetch-api.js"))
	cmd.Dir = dir
	if err := cmd.Start(); err != nil {
		log("⚠ extract_fetch: node start failed (" + err.Error() + ") — node install ache? — regex scan e fallback")
		return nil
	}
	// SPEED: the .endpoint-cache.json (all endpoints + slot + dg-epay) is written in
	// ~1.8s; the remaining ~9s only builds a fetch-api.js file we never use. So poll
	// for the cache and, the moment it is a COMPLETE JSON, read it and kill node —
	// ~1.8s instead of ~11s.
	cachePath := filepath.Join(dir, ".endpoint-cache.json")
	deadline := time.Now().Add(extractFetchTimeout)
	var cache []byte
	for time.Now().Before(deadline) {
		if b, e := os.ReadFile(cachePath); e == nil && cacheComplete(b) {
			cache = b
			break
		}
		// node exited on its own? then read whatever it wrote and stop.
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			cache, _ = os.ReadFile(cachePath)
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	_ = cmd.Process.Kill() // stop the ~9s fetch-api.js generation we don't need
	_ = cmd.Wait()
	if !cacheComplete(cache) {
		log("⚠ extract_fetch: .endpoint-cache.json complete hoyni — regex scan use hobe")
		return nil
	}
	return cache
}

// cacheComplete reports whether the bytes are a fully-written .endpoint-cache.json
// (node writeFileSync is atomic, but this guards a torn read): valid-looking JSON
// object that carries the bundleName field the writer always emits last-ish.
func cacheComplete(b []byte) bool {
	if len(b) < 40 {
		return false
	}
	s := strings.TrimSpace(string(b))
	if !strings.HasPrefix(s, "{") || !strings.HasSuffix(s, "}") {
		return false
	}
	return strings.Contains(s, "\"bundleName\"") && strings.Contains(s, "\"endpoints\"")
}
