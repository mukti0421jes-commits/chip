package main

import (
	"io"
	"net/http"
	"os"
	"sync"

	"ivac-bot/flow"
)

// ==================== ENDPOINT-CACHE PUSH ====================
//
// The autocheck folder runs extract_fetch.js (v15) via runfetch.bat — in Node it
// finishes in <1s and writes `.endpoint-cache.json`. A tiny pusher POSTs that file
// here. The bot stores it and applies it on the NEXT scan, but ONLY when its
// bundleName matches the live bundle (flow.Config.ApplyEndpointCache gates that).
//
// Auth is identical to the ivacflow push: loopback-only + the shared
// ivacflow_token.txt (x-ivacflow-token). Nothing here can break a run: without a
// push, or on a bundle mismatch, the bot behaves exactly as before.

const endpointCacheStoreFile = "endpoint_cache.json"

var (
	endpointCacheMu  sync.RWMutex
	endpointCacheRaw []byte
)

// LoadEndpointCacheStore restores the last pushed endpoint cache at startup.
func LoadEndpointCacheStore() {
	raw, err := os.ReadFile(endpointCacheStoreFile)
	if err != nil || len(raw) == 0 {
		return
	}
	if name := flow.EndpointCacheBundleName(raw); name == "" {
		return // not a valid cache
	}
	endpointCacheMu.Lock()
	endpointCacheRaw = raw
	endpointCacheMu.Unlock()
	fmtPrintln("🧭 endpoint-cache loaded: " + flow.EndpointCacheBundleName(raw))
}

// currentEndpointCache returns the stored cache bytes (nil if none), for the flow
// adapter to hand to each run's Config.
func currentEndpointCache() []byte {
	endpointCacheMu.RLock()
	defer endpointCacheMu.RUnlock()
	if len(endpointCacheRaw) == 0 {
		return nil
	}
	cp := make([]byte, len(endpointCacheRaw))
	copy(cp, endpointCacheRaw)
	return cp
}

// handleEndpointCachePush accepts a `.endpoint-cache.json` pushed from the autocheck
// folder. POST /api/endpointCachePush
func handleEndpointCachePush(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	if why := authorizeIvacflowPush(r); why != "" { // same loopback + token gate
		w.WriteHeader(403)
		writeJSON(w, map[string]interface{}{"ok": false, "error": why})
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil || len(raw) == 0 {
		w.WriteHeader(400)
		writeJSON(w, map[string]interface{}{"ok": false, "error": "empty body"})
		return
	}
	bundle := flow.EndpointCacheBundleName(raw)
	if bundle == "" {
		w.WriteHeader(400)
		writeJSON(w, map[string]interface{}{"ok": false, "error": "not a valid .endpoint-cache.json (no bundleName)"})
		return
	}
	if werr := os.WriteFile(endpointCacheStoreFile, raw, 0644); werr != nil {
		w.WriteHeader(500)
		writeJSON(w, map[string]interface{}{"ok": false, "error": "save failed: " + werr.Error()})
		return
	}
	endpointCacheMu.Lock()
	endpointCacheRaw = raw
	endpointCacheMu.Unlock()
	flow.ClearScanCache() // next scan should re-run and pick up this cache

	fmtPrintln("🧭 endpoint-cache push received: bundle " + bundle)
	writeJSON(w, map[string]interface{}{"ok": true, "stored": true, "bundle": bundle})
}

// handleEndpointCacheStatus reports what the bot currently holds.
// GET /api/endpointCacheStatus
func handleEndpointCacheStatus(w http.ResponseWriter, r *http.Request) {
	raw := currentEndpointCache()
	if len(raw) == 0 {
		writeJSON(w, map[string]interface{}{"ok": true, "active": false})
		return
	}
	writeJSON(w, map[string]interface{}{"ok": true, "active": true, "bundle": flow.EndpointCacheBundleName(raw)})
}
