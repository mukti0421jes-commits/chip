package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// setupPortalState installs a known admin + user and a live admin session, restoring
// the globals afterwards so other tests are unaffected.
func setupPortalState(t *testing.T) (adminTok string) {
	t.Helper()
	oU, oS, oI := pUsers, pSessions, pImpersonate
	t.Cleanup(func() { pUsers, pSessions, pImpersonate = oU, oS, oI })
	pUsers = []portalUser{
		{Username: "admin", PassHash: portalHash("admin123"), Role: "admin"},
		{Username: "bob", PassHash: portalHash("x"), Role: "user"},
	}
	adminTok = "admintok"
	pSessions = map[string]string{adminTok: "admin"}
	pImpersonate = map[string]string{}
	return adminTok
}

func cookieVal(rec *httptest.ResponseRecorder) string {
	for _, c := range rec.Result().Cookies() {
		if c.Name == "ivs_session" {
			return c.Value
		}
	}
	return ""
}

// Admin "View as user" mints a user session, keeps the admin token recorded, and
// "Return to Admin" restores the admin cookie — the admin session is never lost.
func TestImpersonateAndReturnAdmin(t *testing.T) {
	adminTok := setupPortalState(t)

	// admin impersonates bob (from the tunnel = loopback)
	req := httptest.NewRequest("POST", "/api/portal/impersonate", strings.NewReader(`{"Username":"bob"}`))
	req.RemoteAddr = "127.0.0.1:5555"
	req.AddCookie(&http.Cookie{Name: "ivs_session", Value: adminTok})
	rec := httptest.NewRecorder()
	portalImpersonate(rec, req)
	if rec.Code != 200 {
		t.Fatalf("impersonate want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	impTok := cookieVal(rec)
	if impTok == "" || impTok == adminTok {
		t.Fatalf("expected a NEW impersonation token, got %q", impTok)
	}
	if pSessions[impTok] != "bob" {
		t.Fatalf("impersonation session must resolve to bob, got %q", pSessions[impTok])
	}
	if pImpersonate[impTok] != adminTok {
		t.Fatalf("impersonation must remember the admin token")
	}
	// the admin session must STILL be alive
	if pSessions[adminTok] != "admin" {
		t.Fatal("admin session must remain alive during impersonation")
	}

	// portalMe on the impersonation session reports it
	meReq := httptest.NewRequest("GET", "/api/portal/me", nil)
	meReq.AddCookie(&http.Cookie{Name: "ivs_session", Value: impTok})
	meRec := httptest.NewRecorder()
	portalMe(meRec, meReq)
	body := meRec.Body.String()
	if !strings.Contains(body, `"impersonating":"1"`) || !strings.Contains(body, `"username":"bob"`) {
		t.Fatalf("me should report impersonating as bob, got %s", body)
	}

	// Return to Admin restores the admin cookie and drops the impersonation
	rReq := httptest.NewRequest("GET", "/portal/returnAdmin", nil)
	rReq.AddCookie(&http.Cookie{Name: "ivs_session", Value: impTok})
	rRec := httptest.NewRecorder()
	portalReturnAdmin(rRec, rReq)
	if rRec.Code != http.StatusFound {
		t.Fatalf("returnAdmin want redirect 302, got %d", rRec.Code)
	}
	if cookieVal(rRec) != adminTok {
		t.Fatalf("returnAdmin must restore the admin cookie, got %q", cookieVal(rRec))
	}
	if _, still := pImpersonate[impTok]; still {
		t.Fatal("impersonation record must be cleared after return")
	}
	if _, still := pSessions[impTok]; still {
		t.Fatal("impersonation session must be cleared after return")
	}
}

// A non-admin must NOT be able to impersonate.
func TestImpersonateDeniedForNonAdmin(t *testing.T) {
	setupPortalState(t)
	pSessions["bobtok"] = "bob"
	req := httptest.NewRequest("POST", "/api/portal/impersonate", strings.NewReader(`{"Username":"admin"}`))
	req.RemoteAddr = "127.0.0.1:5555" // loopback, so the 403 is purely the role check
	req.AddCookie(&http.Cookie{Name: "ivs_session", Value: "bobtok"})
	rec := httptest.NewRecorder()
	portalImpersonate(rec, req)
	if rec.Code != 403 {
		t.Fatalf("non-admin impersonate must be 403, got %d", rec.Code)
	}
}

// Admin login from the PUBLIC internet (non-loopback) must be refused even with the
// correct password; a regular user login from the public link must succeed.
func TestAdminLoginLoopbackOnly(t *testing.T) {
	setupPortalState(t)

	// admin from public IP → 403
	aReq := httptest.NewRequest("POST", "/api/portal/login", strings.NewReader(`{"Username":"admin","Password":"admin123"}`))
	aReq.RemoteAddr = "203.0.113.9:443" // public
	aRec := httptest.NewRecorder()
	portalLoginAPI(aRec, aReq)
	if aRec.Code != 403 {
		t.Fatalf("admin login from public must be 403, got %d (%s)", aRec.Code, aRec.Body.String())
	}

	// admin from loopback (tunnel) → 200
	a2 := httptest.NewRequest("POST", "/api/portal/login", strings.NewReader(`{"Username":"admin","Password":"admin123"}`))
	a2.RemoteAddr = "127.0.0.1:5555"
	a2Rec := httptest.NewRecorder()
	portalLoginAPI(a2Rec, a2)
	if a2Rec.Code != 200 {
		t.Fatalf("admin login from loopback must be 200, got %d", a2Rec.Code)
	}

	// regular user from public → 200 (users can log in from anywhere)
	uReq := httptest.NewRequest("POST", "/api/portal/login", strings.NewReader(`{"Username":"bob","Password":"x"}`))
	uReq.RemoteAddr = "203.0.113.9:443"
	uRec := httptest.NewRecorder()
	portalLoginAPI(uRec, uReq)
	if uRec.Code != 200 {
		t.Fatalf("user login from public must be 200, got %d (%s)", uRec.Code, uRec.Body.String())
	}
}

// Admin impersonation from the public internet must be refused.
func TestImpersonateDeniedFromPublic(t *testing.T) {
	adminTok := setupPortalState(t)
	req := httptest.NewRequest("POST", "/api/portal/impersonate", strings.NewReader(`{"Username":"bob"}`))
	req.RemoteAddr = "203.0.113.9:443" // public
	req.AddCookie(&http.Cookie{Name: "ivs_session", Value: adminTok})
	rec := httptest.NewRecorder()
	portalImpersonate(rec, req)
	if rec.Code != 403 {
		t.Fatalf("impersonate from public must be 403, got %d", rec.Code)
	}
}
