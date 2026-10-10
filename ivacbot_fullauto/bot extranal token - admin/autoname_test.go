package main

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHolderNameFromFilename(t *testing.T) {
	cases := map[string]string{
		"LITAN BISWAS=BGDDW0A25A26LI830520.pdf":              "LITAN",
		"SOSHY RANI KUNDU=BGDDW0A22326SO941226.pdf":          "SOSHY",
		"01=  KANCHAN KUNDU ====   BGDDW0F13226KA820112.pdf": "KANCHAN",
		"81. MST MAHMUDA FERDOUS 1980 02.pdf":                "MST",
		"06. RAKIB HASAN 1999 01.pdf":                        "RAKIB",
		"Md_Rahim_Uddin.pdf":                                 "Md",
	}
	for in, want := range cases {
		if got := holderNameFromFilename(in); got != want {
			t.Errorf("holderNameFromFilename(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestAutoDetectClientNameFromPrimary reproduces the File-Manager flow: an entry
// with an EMPTY name, then a PRIMARY pdf upload whose filename carries the holder.
// The CLIENT (instance.Data.ClientName) must become the given name automatically.
func TestAutoDetectClientNameFromPrimary(t *testing.T) {
	// seed a logged-in admin session
	pUsers = []portalUser{{Username: "admin", PassHash: portalHash("x"), Role: "admin"}}
	pSessions = map[string]string{"tok": "admin"}
	pEntries = nil

	// create an entry with NO manual name → instance CLIENT starts as the username
	instID := addInstance("admin", "01700000000", "pw", "01700000000", "", "Dhaka", "Tourist", "auto")
	e := portalEntry{ID: "E1", Owner: "admin", Name: "", InstanceID: instID}
	pEntries = append(pEntries, e)

	// build the multipart upload the browser sends for the primary file
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "LITAN BISWAS=BGDDW0A25A26LI830520.pdf")
	fw.Write([]byte("%PDF-1.4 dummy"))
	mw.Close()

	req := httptest.NewRequest("POST", "/api/portal/uploadFile?entryId=E1&slot=primary&primary=1", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.AddCookie(&http.Cookie{Name: "ivs_session", Value: "tok"})
	rr := httptest.NewRecorder()

	handlePortalUploadFile(rr, req)

	if rr.Code != 200 {
		t.Fatalf("upload failed: %d %s", rr.Code, rr.Body.String())
	}
	instancesMu.RLock()
	inst := instances[instID]
	instancesMu.RUnlock()
	inst.mu.Lock()
	got := inst.Data.ClientName
	inst.mu.Unlock()
	if got != "LITAN" {
		t.Fatalf("CLIENT auto-detect: got %q, want %q", got, "LITAN")
	}
}
