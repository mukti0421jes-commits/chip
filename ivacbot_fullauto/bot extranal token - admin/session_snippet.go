package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// ==================== SESSION SNIPPET / COPY-SESSION ====================
//
// This module lets an already-logged-in instance's IVAC session be re-used in a
// normal browser (or a small Chrome extension) — WITHOUT number / password / OTP.
//
// IVAC's SPA keeps its login in localStorage under the key "auth-storage"
// (a Zustand persist blob). If you drop a valid blob there and reload, the SPA
// treats you as logged in until the access token expires (~15 min).
//
// Two admin-only, READ-ONLY endpoints are exposed here. They never mutate any
// bot state — no start/stop, no token clearing, nothing. They only read the
// live in-memory flow session (getFlowSession) + instance config and hand back
// a ready-to-paste blob. So they cannot harm a running bot.
//
//   GET /api/sessionList             → instances that currently hold a live token
//   GET /api/sessionSnippet?id=<id>  → that instance's auth-storage blob + snippet
//
// AUTH: either a valid admin dashboard cookie (used by the in-dashboard
// "Copy Session" button) OR a secret extension key (used by the browser
// extension, which has no cookie). The key lives in session_ext_key.txt
// (gitignored, 0600), auto-created on first start — same pattern as the
// ivacflow push token. Pass it as header "X-Ext-Key: <key>" or "?key=<key>".

const sessionExtKeyFile = "session_ext_key.txt"

var sessionExtKey string

// LoadOrCreateSessionExtKey loads the extension key, or generates+saves one on
// first start. Mirrors LoadOrCreateIvacflowToken. Never fatal: if it fails, the
// cookie path still works; only the extension's key path is disabled.
func LoadOrCreateSessionExtKey() {
	if b, err := os.ReadFile(sessionExtKeyFile); err == nil {
		if t := strings.TrimSpace(string(b)); t != "" {
			sessionExtKey = t
			return
		}
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		fmtPrintln("⚠ session ext key generate failed: " + err.Error() + " — extension key disabled")
		return
	}
	sessionExtKey = hex.EncodeToString(raw)
	if err := os.WriteFile(sessionExtKeyFile, []byte(sessionExtKey+"\n"), 0600); err != nil {
		fmtPrintln("⚠ session ext key save failed: " + err.Error() + " — extension key disabled")
		sessionExtKey = ""
		return
	}
	fmtPrintln("🔑 browser-extension key written to " + sessionExtKeyFile)
}

// sessionExtAuthorized reports whether the request may read session snippets:
// a valid admin cookie, OR a matching extension key (constant-time compare).
func sessionExtAuthorized(r *http.Request) bool {
	if u, ok := portalSessionUser(r); ok && u.Role == "admin" {
		return true
	}
	if sessionExtKey == "" {
		return false
	}
	key := r.Header.Get("X-Ext-Key")
	if key == "" {
		key = r.URL.Query().Get("key")
	}
	if key == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(key), []byte(sessionExtKey)) == 1
}

// sessionExtCORS reflects a chrome-extension:// origin so the extension can call
// these endpoints. Same-origin dashboard calls need no CORS. Returns true if the
// request was a CORS preflight that has now been answered (caller should stop).
func sessionExtCORS(w http.ResponseWriter, r *http.Request) (preflightHandled bool) {
	origin := r.Header.Get("Origin")
	if strings.HasPrefix(origin, "chrome-extension://") || strings.HasPrefix(origin, "moz-extension://") {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Headers", "X-Ext-Key, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return true
	}
	return false
}

// jwtClaims is the subset of the IVAC access-token payload we read.
type jwtClaims struct {
	Sub   string `json:"sub"`   // userId
	Phone string `json:"phone"` // account phone
	Exp   int64  `json:"exp"`   // unix expiry
	Iat   int64  `json:"iat"`   // unix issued-at
}

// decodeJWT reads (does not verify — we already own this token) the payload of a
// JWT and returns its claims. Verification isn't our job here: we're just
// re-packaging a token the bot already holds.
func decodeJWT(tok string) (jwtClaims, bool) {
	var c jwtClaims
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return c, false
	}
	seg := parts[1]
	payload, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		// tolerate an already-padded segment: pad to a multiple of 4 and retry.
		if m := len(seg) % 4; m != 0 {
			seg += strings.Repeat("=", 4-m)
		}
		if payload, err = base64.URLEncoding.DecodeString(seg); err != nil {
			return c, false
		}
	}
	if err := json.Unmarshal(payload, &c); err != nil {
		return c, false
	}
	return c, true
}

// authStorageState mirrors the IVAC SPA's Zustand "auth-storage" state object.
type authStorageState struct {
	Token           string `json:"token"`
	UserID          string `json:"userId"`
	ExpiresAt       int64  `json:"expiresAt"` // seconds remaining (SPA recomputes from token anyway)
	IsAuthenticated bool   `json:"isAuthenticated"`
	IsVerified      bool   `json:"isVerified"`
	RequestID       string `json:"requestId"`
	Phone           string `json:"phone"`
	OtpSentAt       int64  `json:"otpSentAt"` // ms
}

type authStorageBlob struct {
	State   authStorageState `json:"state"`
	Version int              `json:"version"`
}

// buildAuthStorage assembles the auth-storage blob (as a compact JSON string)
// from a live token. Returns the blob string and seconds until token expiry.
func buildAuthStorage(token, requestID, phone string) (blob string, secsLeft int64, ok bool) {
	if token == "" {
		return "", 0, false
	}
	claims, _ := decodeJWT(token) // best-effort: userId/phone/exp if decodable
	userID := claims.Sub
	if claims.Phone != "" {
		phone = claims.Phone // prefer the token's own phone
	}
	now := time.Now()
	if claims.Exp > 0 {
		secsLeft = claims.Exp - now.Unix()
	}
	if secsLeft < 0 {
		secsLeft = 0
	}
	b := authStorageBlob{
		State: authStorageState{
			Token:           token,
			UserID:          userID,
			ExpiresAt:       secsLeft,
			IsAuthenticated: true,
			IsVerified:      true,
			RequestID:       requestID,
			Phone:           phone,
			OtpSentAt:       now.UnixMilli(),
		},
		Version: 0,
	}
	raw, err := json.Marshal(b)
	if err != nil {
		return "", 0, false
	}
	return string(raw), secsLeft, true
}

// proxyInfo is the per-instance proxy the Session-Login extension must route the
// other browser through, so the re-used session stays on the SAME egress IP (the
// IVAC session is pinned to the IP it was created on).
type proxyInfo struct {
	Type  string `json:"type"`  // http (always, for these proxies)
	Host  string `json:"host"`  // egress IP / hostname
	Port  string `json:"port"`
	User  string `json:"user"`
	Pass  string `json:"pass"`
	Label string `json:"label"` // host:port — what the extension highlights
}

// parseProxyURL splits a "scheme://user:pass@host:port" proxy URL into parts.
func parseProxyURL(raw string) (proxyInfo, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "-" {
		return proxyInfo{}, false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return proxyInfo{}, false
	}
	pi := proxyInfo{Type: u.Scheme, Host: u.Hostname(), Port: u.Port()}
	if pi.Type == "" {
		pi.Type = "http"
	}
	if u.User != nil {
		pi.User = u.User.Username()
		pi.Pass, _ = u.User.Password()
	}
	pi.Label = pi.Host
	if pi.Port != "" {
		pi.Label += ":" + pi.Port
	}
	return pi, true
}

// instanceProxyInfo returns the proxy an instance is (or would be) running on:
// its live CurrentProxy if set, else the round-robin proxy it would be assigned.
// ok=false means a direct connection (no proxy) — nothing to pin.
func instanceProxyInfo(id int) (proxyInfo, bool) {
	raw := ""
	instancesMu.RLock()
	if inst, ok := instances[id]; ok {
		inst.mu.Lock()
		raw = inst.Data.CurrentProxy
		inst.mu.Unlock()
	}
	instancesMu.RUnlock()
	if raw == "" || raw == "-" {
		raw = pickFlowProxyForInstance(id) // what the flow would pick for this id
	}
	return parseProxyURL(raw)
}

// handleSessionList: GET /api/sessionList — instances that currently hold a live
// token, newest-usable first. Read-only.
func handleSessionList(w http.ResponseWriter, r *http.Request) {
	if sessionExtCORS(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if !sessionExtAuthorized(r) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
		return
	}

	type row struct {
		ID        int    `json:"id"`
		Name      string `json:"name"`
		Phone     string `json:"phone"`
		Status    string `json:"status"`
		ExpiresIn int64  `json:"expiresIn"` // seconds until token expiry
		IP        string `json:"ip"`        // the proxy IP:port this session is pinned to
	}
	out := make([]row, 0)

	instancesMu.RLock()
	for _, inst := range instances {
		// Read instance fields under inst.mu (matches getInstances), then look up
		// the flow session separately — never hold inst.mu across getFlowSession.
		inst.mu.Lock()
		id := inst.Data.ID
		name := strings.TrimSpace(inst.Data.ClientName)
		if name == "" {
			name = strings.TrimSpace(inst.Data.Name)
		}
		if name == "" {
			name = "Instance " + strconv.Itoa(id)
		}
		phone := inst.Data.LoginPhone
		status := inst.Data.Status
		rawProxy := inst.Data.CurrentProxy
		inst.mu.Unlock()

		s := getFlowSession(id)
		if s == nil || s.AccessToken == "" {
			continue
		}

		_, secsLeft, ok := buildAuthStorage(s.AccessToken, s.RequestID, phone)
		if !ok {
			continue
		}
		// Which egress IP this session is pinned to (for display + highlight).
		if rawProxy == "" || rawProxy == "-" {
			rawProxy = pickFlowProxyForInstance(id)
		}
		ip := ""
		if pi, pok := parseProxyURL(rawProxy); pok {
			ip = pi.Label
		}
		out = append(out, row{ID: id, Name: name, Phone: phone, Status: status, ExpiresIn: secsLeft, IP: ip})
	}
	instancesMu.RUnlock()

	_ = json.NewEncoder(w).Encode(map[string]interface{}{"instances": out})
}

// handleSessionSnippet: GET /api/sessionSnippet?id=<id> — that instance's
// auth-storage blob + a one-paste console snippet. Read-only.
func handleSessionSnippet(w http.ResponseWriter, r *http.Request) {
	if sessionExtCORS(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if !sessionExtAuthorized(r) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
		return
	}

	id, err := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("id")))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"bad id"}`))
		return
	}

	s := getFlowSession(id)
	if s == nil || s.AccessToken == "" {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"no live session for this instance — sign it in first"}`))
		return
	}

	instancesMu.RLock()
	inst, ok := instances[id]
	var phone, name string
	if ok {
		inst.mu.Lock()
		phone = inst.Data.LoginPhone
		name = strings.TrimSpace(inst.Data.ClientName)
		if name == "" {
			name = strings.TrimSpace(inst.Data.Name)
		}
		inst.mu.Unlock()
	}
	instancesMu.RUnlock()

	blob, secsLeft, bok := buildAuthStorage(s.AccessToken, s.RequestID, phone)
	if !bok {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"could not build session blob"}`))
		return
	}

	// snippet = one console paste that sets the blob and reloads.
	// json.Marshal(blob) yields a JS-safe double-quoted string literal.
	litRaw, _ := json.Marshal(blob)
	snippet := "localStorage.setItem('auth-storage', " + string(litRaw) + "); location.reload();"

	resp := map[string]interface{}{
		"id":          id,
		"name":        name,
		"phone":       phone,
		"expiresIn":   secsLeft,
		"authStorage": blob,    // raw value for the "auth-storage" localStorage key
		"snippet":     snippet, // ready-to-paste console one-liner
	}
	// The proxy this session is pinned to — the extension routes the other browser
	// through it so the re-used session stays on the SAME egress IP.
	if pi, ok := instanceProxyInfo(id); ok {
		resp["proxy"] = pi
	}
	_ = json.NewEncoder(w).Encode(resp)
}

// digitsOnly strips every non-digit so phone numbers compare regardless of
// spaces, +, country-code prefixes, etc.
func digitsOnly(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// handleSessionName: GET /api/sessionName?phone=<phone> — the Client name for the
// instance that owns this phone, so the extension's on-page badge can show a NAME
// instead of a bare number however the session was injected. Read-only.
func handleSessionName(w http.ResponseWriter, r *http.Request) {
	if sessionExtCORS(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if !sessionExtAuthorized(r) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
		return
	}
	want := digitsOnly(r.URL.Query().Get("phone"))
	name := ""
	if want != "" {
		instancesMu.RLock()
		for _, inst := range instances {
			inst.mu.Lock()
			ph := digitsOnly(inst.Data.LoginPhone)
			// match exactly, or by the last 11 digits (local vs +88-prefixed)
			hit := ph != "" && (ph == want ||
				(len(ph) >= 11 && len(want) >= 11 && ph[len(ph)-11:] == want[len(want)-11:]))
			if hit {
				name = strings.TrimSpace(inst.Data.ClientName)
				if name == "" {
					name = strings.TrimSpace(inst.Data.Name)
				}
			}
			inst.mu.Unlock()
			if name != "" {
				break
			}
		}
		instancesMu.RUnlock()
	}
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"name": name})
}
