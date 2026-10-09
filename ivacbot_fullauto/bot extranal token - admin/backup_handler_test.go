package main

import (
	"archive/zip"
	"bytes"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Round-trip against the REAL legacy backup zip (entries.json + entry_files/**):
// import restores entries + PDFs, then export reproduces the same layout.
func TestBackupImportExportRoundTrip(t *testing.T) {
	const realZip = "/tmp/real-backup.zip"
	raw, err := os.ReadFile(realZip)
	if err != nil {
		t.Skip("real backup not present at " + realZip + " — skipping")
	}

	// isolate: run in a temp cwd so entry_files/ is written there, not in the repo
	tmp := t.TempDir()
	old, _ := os.Getwd()
	if e := os.Chdir(tmp); e != nil {
		t.Fatal(e)
	}
	defer os.Chdir(old)

	// reset global entry state for a clean import
	pMu.Lock()
	pEntries = nil
	pMu.Unlock()

	// ── IMPORT: POST the real zip as multipart field "backup" ──
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("backup", "ivac-backup.zip")
	fw.Write(raw)
	mw.Close()
	req := httptest.NewRequest("POST", "/api/importBackup", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	handleImportBackup(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("import failed: %d %s", rec.Code, rec.Body.String())
	}

	pMu.Lock()
	nEntries := len(pEntries)
	firstName := ""
	if nEntries > 0 {
		firstName = pEntries[0].Name
	}
	pMu.Unlock()
	if nEntries != 21 {
		t.Fatalf("expected 21 entries imported, got %d", nEntries)
	}
	// a known PDF must be on disk under entry_files/<id>/
	pdfs := 0
	_ = filepath.Walk("entry_files", func(p string, fi os.FileInfo, e error) error {
		if e == nil && !fi.IsDir() && strings.EqualFold(filepath.Ext(p), ".pdf") {
			pdfs++
		}
		return nil
	})
	if pdfs != 78 {
		t.Fatalf("expected 78 PDFs restored, got %d", pdfs)
	}
	t.Logf("imported %d entries (first=%q), %d PDFs", nEntries, firstName, pdfs)

	// ── EXPORT: pull it back out and verify the same layout ──
	erec := httptest.NewRecorder()
	handleExportBackup(erec, httptest.NewRequest("GET", "/api/exportBackup", nil))
	if erec.Code != 200 {
		t.Fatalf("export status %d", erec.Code)
	}
	zr, err := zip.NewReader(bytes.NewReader(erec.Body.Bytes()), int64(erec.Body.Len()))
	if err != nil {
		t.Fatalf("export not a zip: %v", err)
	}
	hasEntries, expPDFs := false, 0
	for _, zf := range zr.File {
		if zf.Name == "entries.json" {
			hasEntries = true
			rc, _ := zf.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			if !strings.Contains(string(b), firstName) {
				t.Fatalf("exported entries.json missing entry %q", firstName)
			}
		}
		if strings.HasPrefix(filepath.ToSlash(zf.Name), "entry_files/") && strings.EqualFold(filepath.Ext(zf.Name), ".pdf") {
			expPDFs++
		}
	}
	if !hasEntries {
		t.Fatal("export missing entries.json")
	}
	if expPDFs != 78 {
		t.Fatalf("export should carry 78 PDFs, got %d", expPDFs)
	}
	t.Logf("export OK: entries.json + %d PDFs (round-trip matches)", expPDFs)
}

// Zip-slip: a malicious entry_files/../evil path must be refused.
func TestBackupZipSlipBlocked(t *testing.T) {
	if _, ok := safeExtractPath("entry_files/../evil.txt"); ok {
		t.Fatal("zip-slip path was accepted")
	}
	if _, ok := safeExtractPath("entry_files/123/ok.pdf"); !ok {
		t.Fatal("normal path was rejected")
	}
}
