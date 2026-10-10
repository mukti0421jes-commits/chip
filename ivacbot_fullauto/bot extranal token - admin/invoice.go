package main

// Invoice download — RJ SLOT JS parity, server side.
//
// The reservationId captured on a successful reserve becomes the trxId. The
// dashboard auto-fills it, then polls /api/invoice which fetches the invoice
// PDF (auth token + x-token captcha header, strict h2). When the PDF is ready
// the bytes are streamed back as an attachment so the browser downloads it,
// exactly like the userscript. Until then a small JSON status is returned so
// the dashboard keeps retrying.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const API_INVOICE_DOWNLOAD = "https://api.ivacbd.com/iams/api/v1/invoice/download"

// invoiceStatus is the JSON returned while the invoice is not yet a PDF.
type invoiceStatus struct {
	Ready  bool   `json:"ready"`
	Status int    `json:"status"`
	Msg    string `json:"msg"`
}

func writeInvoiceStatus(w http.ResponseWriter, st invoiceStatus) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(st)
}

// handleInvoiceDownload performs ONE invoice fetch attempt. The dashboard owns
// the retry loop (Submit → poll every couple of seconds → Stop), mirroring the
// userscript's auto-reload behaviour.
func handleInvoiceDownload(w http.ResponseWriter, r *http.Request) {
	trxID := strings.TrimSpace(r.URL.Query().Get("trxId"))
	if trxID == "" {
		writeInvoiceStatus(w, invoiceStatus{Ready: false, Status: 0, Msg: "trxId required"})
		return
	}

	// Resolve the access token for the request. Prefer the named instance's
	// live session; fall back to any running instance that has a token.
	token, deviceID := invoiceTokenForInstance(r.URL.Query().Get("instanceId"))
	if token == "" {
		writeInvoiceStatus(w, invoiceStatus{Ready: false, Status: 0, Msg: "no active session token — login/reserve an instance first"})
		return
	}

	reqURL := API_INVOICE_DOWNLOAD + "?txrId=" + url.QueryEscape(trxID)
	req, err := http.NewRequest("GET", reqURL, nil)
	if err != nil {
		writeInvoiceStatus(w, invoiceStatus{Ready: false, Status: 0, Msg: "build request: " + err.Error()})
		return
	}
	req.Host = "api.ivacbd.com"
	for k, v := range browserHeaders {
		req.Header.Set(k, v)
	}
	req.Header.Set("accept", "application/pdf, application/json, */*")
	req.Header.Set("authorization", "Bearer "+token)
	if deviceID != "" {
		req.Header.Set("x-device-id", deviceID)
	}
	if xt := InitiateXToken(); xt != "" {
		req.Header.Set("x-token", xt)
	}

	client := getHTTPClient("")
	resp, err := client.Do(req)
	if err != nil {
		writeInvoiceStatus(w, invoiceStatus{Ready: false, Status: 0, Msg: "fetch: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	isPDF := strings.HasPrefix(string(body), "%PDF") || strings.Contains(ct, "application/pdf")

	if resp.StatusCode == 200 && isPDF {
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=invoice-%s.pdf", sanitizeFilename(trxID)))
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.Write(body)
		return
	}

	// Not a PDF yet — surface any server message so the dashboard can show it.
	msg := ""
	var parsed map[string]interface{}
	if json.Unmarshal(body, &parsed) == nil {
		if m, ok := parsed["message"].(string); ok {
			msg = m
		}
	}
	if msg == "" {
		msg = fmt.Sprintf("not ready (HTTP %d)", resp.StatusCode)
	}
	writeInvoiceStatus(w, invoiceStatus{Ready: false, Status: resp.StatusCode, Msg: msg})
}

// invoiceTokenForInstance returns the access token + device id to use. If a
// valid instanceId is given and that instance has a live token, it is used;
// otherwise the most recently usable instance token is returned.
func invoiceTokenForInstance(instIDStr string) (string, string) {
	instancesMu.RLock()
	defer instancesMu.RUnlock()

	pick := func(inst *Instance) (string, string) {
		if inst == nil || inst.client == nil || inst.client.session == nil {
			return "", ""
		}
		tok := inst.client.session.Token
		dev := ""
		if inst.Data.DeviceInfo != nil {
			dev = inst.Data.DeviceInfo.DeviceID
		}
		return tok, dev
	}

	if instIDStr != "" {
		if id, err := strconv.Atoi(instIDStr); err == nil {
			if inst, ok := instances[id]; ok {
				if tok, dev := pick(inst); tok != "" {
					return tok, dev
				}
			}
		}
	}

	// Fallback: first instance with a live token.
	for _, inst := range instances {
		if tok, dev := pick(inst); tok != "" {
			return tok, dev
		}
	}
	return "", ""
}

func sanitizeFilename(s string) string {
	repl := strings.NewReplacer("/", "_", "\\", "_", " ", "_", ":", "_", "?", "_", "*", "_", "\"", "_", "<", "_", ">", "_", "|", "_")
	return repl.Replace(s)
}
