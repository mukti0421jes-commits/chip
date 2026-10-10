package main

// ============================================================================
//  ENTRY BACKUP — export / import (entries + their applicant PDFs) as ONE zip
//
//  Fixed instances carry many applicant PDFs; re-typing them is painful. So this
//  exports every File-Manager entry plus its PDFs into a single zip, and imports
//  that same zip back in one click. The zip layout matches the legacy backup:
//
//      entries.json                                  (the portalEntry array)
//      entry_files/<entryId>/<PRIMARY__|appN__>NAME.pdf   (the applicant PDFs)
//
//  Import is an UPSERT: an entry whose id is already present is replaced, a new
//  id is added, and entries not in the backup are left untouched. PDFs are
//  written under entry_files/<id>/ exactly as exported. Zip-slip is blocked.
// ============================================================================

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const entryFilesRoot = "entry_files"

// handleExportBackup streams a zip of entries.json + entry_files/** as a download.
// GET /api/exportBackup
func handleExportBackup(w http.ResponseWriter, r *http.Request) {
	pMu.Lock()
	entriesJSON, err := json.MarshalIndent(pEntries, "", "  ")
	n := len(pEntries)
	pMu.Unlock()
	if err != nil {
		http.Error(w, "encode entries failed: "+err.Error(), 500)
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="ivac-backup.zip"`)
	zw := zip.NewWriter(w)
	defer zw.Close()

	// 1) entries.json at the root
	if f, e := zw.Create("entries.json"); e == nil {
		_, _ = f.Write(entriesJSON)
	}

	// 2) every PDF under entry_files/** (skip if the folder does not exist yet)
	files := 0
	if st, e := os.Stat(entryFilesRoot); e == nil && st.IsDir() {
		_ = filepath.Walk(entryFilesRoot, func(path string, info os.FileInfo, werr error) error {
			if werr != nil || info.IsDir() {
				return nil
			}
			b, re := os.ReadFile(path)
			if re != nil {
				return nil
			}
			// zip entry name is the forward-slash relative path (entry_files/<id>/file)
			name := filepath.ToSlash(path)
			if zf, ce := zw.Create(name); ce == nil {
				_, _ = zf.Write(b)
				files++
			}
			return nil
		})
	}
	fmtPrintln("📦 Backup exported: " + itoaLocal(n) + " entries, " + itoaLocal(files) + " PDF file(s)")
}

// handleImportBackup restores entries + PDFs from an uploaded backup zip.
// POST /api/importBackup   (multipart form, file field "backup")
func handleImportBackup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, map[string]interface{}{"ok": false, "error": "POST only"})
		return
	}
	if err := r.ParseMultipartForm(256 << 20); err != nil { // up to 256 MB
		writeJSON(w, map[string]interface{}{"ok": false, "error": "form parse failed: " + err.Error()})
		return
	}
	file, _, err := r.FormFile("backup")
	if err != nil {
		writeJSON(w, map[string]interface{}{"ok": false, "error": "no backup file (field 'backup')"})
		return
	}
	defer file.Close()
	raw, err := io.ReadAll(file)
	if err != nil || len(raw) == 0 {
		writeJSON(w, map[string]interface{}{"ok": false, "error": "read upload failed / empty"})
		return
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		writeJSON(w, map[string]interface{}{"ok": false, "error": "not a valid zip: " + err.Error()})
		return
	}

	var imported []portalEntry
	pdfCount, skipped := 0, 0
	for _, zf := range zr.File {
		name := filepath.ToSlash(zf.Name)
		if name == "entries.json" {
			rc, e := zf.Open()
			if e != nil {
				continue
			}
			b, _ := io.ReadAll(rc)
			rc.Close()
			if e := json.Unmarshal(b, &imported); e != nil {
				writeJSON(w, map[string]interface{}{"ok": false, "error": "entries.json parse failed: " + e.Error()})
				return
			}
			continue
		}
		if strings.HasPrefix(name, entryFilesRoot+"/") {
			if zf.FileInfo().IsDir() {
				continue
			}
			dest, ok := safeExtractPath(name)
			if !ok {
				skipped++
				continue // zip-slip guard
			}
			rc, e := zf.Open()
			if e != nil {
				skipped++
				continue
			}
			b, _ := io.ReadAll(rc)
			rc.Close()
			if e := os.MkdirAll(filepath.Dir(dest), 0755); e != nil {
				skipped++
				continue
			}
			if e := os.WriteFile(dest, b, 0644); e != nil {
				skipped++
				continue
			}
			pdfCount++
		}
	}

	if imported == nil {
		writeJSON(w, map[string]interface{}{"ok": false, "error": "backup has no entries.json"})
		return
	}

	// UPSERT into pEntries: replace same id, add new; leave others untouched.
	added, replaced := 0, 0
	pMu.Lock()
	byID := map[string]int{}
	for i := range pEntries {
		byID[pEntries[i].ID] = i
	}
	for _, ne := range imported {
		if idx, ok := byID[ne.ID]; ok {
			pEntries[idx] = ne
			replaced++
		} else {
			pEntries = append(pEntries, ne)
			byID[ne.ID] = len(pEntries) - 1
			added++
		}
	}
	portalSaveEntriesLocked()
	pMu.Unlock()

	fmtPrintln("📥 Backup imported: " + itoaLocal(added) + " added, " + itoaLocal(replaced) +
		" replaced, " + itoaLocal(pdfCount) + " PDF, " + itoaLocal(skipped) + " skipped")
	writeJSON(w, map[string]interface{}{
		"ok": true, "added": added, "replaced": replaced, "pdf": pdfCount, "skipped": skipped,
		"total": added + replaced,
	})
}

// safeExtractPath maps a zip entry name (entry_files/<id>/file.pdf) to a local path
// under entry_files/, refusing anything that would escape it (zip-slip). Returns the
// cleaned relative destination and true when safe.
func safeExtractPath(name string) (string, bool) {
	clean := filepath.Clean(filepath.FromSlash(name))
	absBase, e1 := filepath.Abs(entryFilesRoot)
	absDest, e2 := filepath.Abs(clean)
	if e1 != nil || e2 != nil {
		return "", false
	}
	if absDest == absBase || strings.HasPrefix(absDest, absBase+string(os.PathSeparator)) {
		return clean, true
	}
	return "", false
}
