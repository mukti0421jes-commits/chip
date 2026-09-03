package flow

import (
	"bytes"
	"testing"
)

// TestUploadByteParity proves our BuildUpload multipart body + headers are
// byte-identical to RJ SLOT's sendMultipartUpload (ln 4340) for the same inputs.
func TestUploadByteParity(t *testing.T) {
	cfg := NewConfig()
	fileBytes := []byte("PDFDATA-\x00\x01\x02-binary")
	boundary := "----RJUpload9a3f1c2b17d4e"
	p := UploadParams{
		AccessToken:  "ACCESS",
		CaptchaToken: "RAWTOKEN123",
		RuntimeState: "v1.5a4c",
		FileName:     "01= KANCHAN KUNDU BGDDVD555226KA820112.pdf",
		FileType:     "application/pdf",
		FileBytes:    fileBytes,
		IsPrimary:    true,
		Boundary:     boundary,
	}
	got := cfg.BuildUpload(p)

	// Independently build the EXACT bytes RJ SLOT sendMultipartUpload produces.
	var want bytes.Buffer
	want.WriteString("--" + boundary + "\r\n")
	want.WriteString(`Content-Disposition: form-data; name="files"; filename="` + p.FileName + `"` + "\r\n")
	want.WriteString("Content-Type: application/pdf\r\n\r\n")
	want.Write(fileBytes)
	want.WriteString("\r\n")
	want.WriteString("--" + boundary + "\r\n")
	want.WriteString(`Content-Disposition: form-data; name="isPrimary"` + "\r\n\r\n")
	want.WriteString("true\r\n")
	want.WriteString("--" + boundary + "--\r\n")

	if !bytes.Equal(got.Body, want.Bytes()) {
		t.Fatalf("BODY MISMATCH\n--- got (%d bytes) ---\n%q\n--- want (%d bytes) ---\n%q",
			len(got.Body), got.Body, want.Len(), want.Bytes())
	}
	t.Logf("✓ multipart body byte-identical (%d bytes)", len(got.Body))

	// Header parity (RJ SLOT uploadFile headers, ln 4393).
	wantHdr := map[string]string{
		"accept":              "application/json, text/plain, */*",
		"authorization":       "Bearer ACCESS",
		"cache-control":       "no-cache, no-store, must-revalidate",
		"pragma":              "no-cache",
		"x-sec-runtime-state": "v1.5a4c",
		"x-token":             "RAWTOKEN123", // RAW, not encrypted
		"content-type":        "multipart/form-data; boundary=" + boundary,
	}
	for k, v := range wantHdr {
		if got.Headers[k] != v {
			t.Fatalf("HEADER %q = %q, want %q", k, got.Headers[k], v)
		}
	}
	if len(got.Headers) != len(wantHdr) {
		t.Fatalf("header COUNT = %d, want %d: %+v", len(got.Headers), len(wantHdr), got.Headers)
	}
	t.Logf("✓ all %d headers byte-identical (x-token is RAW: %q)", len(wantHdr), got.Headers["x-token"])
	t.Logf("✓ method=%s url=%s", got.Method, got.URL)
}
