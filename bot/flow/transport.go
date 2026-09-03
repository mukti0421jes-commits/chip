package flow

import (
	"bytes"
	"io"
	"net/http"
	"time"
)

// HTTPDoer sends a built Request over an *http.Client and returns the Response.
// It implements Doer. The real bot swaps in a utls/HTTP-2 client with the SAME
// interface; this net/http version is the default and what tests exercise.
type HTTPDoer struct {
	Client *http.Client
}

// NewHTTPDoer returns an HTTPDoer with a sane default client.
func NewHTTPDoer() *HTTPDoer {
	return &HTTPDoer{Client: &http.Client{Timeout: 60 * time.Second}}
}

// Do sends the Request exactly as built: same method, URL, header set/values and
// body bytes. Header keys are set via the canonical map so values pass through
// unchanged (RJ SLOT uses lowercase header names; HTTP/2 lowercases them anyway).
func (d *HTTPDoer) Do(req Request) (Response, error) {
	var bodyReader io.Reader
	if len(req.Body) > 0 {
		bodyReader = bytes.NewReader(req.Body)
	}
	hr, err := http.NewRequest(req.Method, req.URL, bodyReader)
	if err != nil {
		return Response{}, err
	}
	// Browser-identity defaults so Cloudflare in front of api.ivacbd.com does not
	// serve its 403 challenge page to a bare Go client. Only set when the request
	// didn't already specify them.
	for k, v := range browserAPIHeaders {
		if hr.Header.Get(k) == "" {
			hr.Header.Set(k, v)
		}
	}
	for k, v := range req.Headers {
		hr.Header.Set(k, v)
	}
	if req.Referrer != "" {
		hr.Header.Set("referer", req.Referrer)
	}
	resp, err := d.Client.Do(hr)
	if err != nil {
		return Response{}, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return Response{}, err
	}
	return Response{Status: resp.StatusCode, Body: b}, nil
}

// HTTPFetcher implements Fetcher (plain GET) over an *http.Client.
type HTTPFetcher struct {
	Client *http.Client
}

// NewHTTPFetcher returns an HTTPFetcher with a default client.
func NewHTTPFetcher() *HTTPFetcher {
	return &HTTPFetcher{Client: &http.Client{Timeout: 30 * time.Second}}
}

// browserAPIHeaders make a Go request look like a real Chrome XHR from the
// appointment.ivacbd.com origin, so Cloudflare admits it (combined with the utls
// browser TLS fingerprint of the client). Header keys the app sets per-request
// (content-type, authorization, x-token, x-sec-*) always win over these.
var browserAPIHeaders = map[string]string{
	"accept":             "application/json, text/plain, */*",
	"accept-language":    "en-US,en;q=0.9",
	"cache-control":      "no-cache, no-store, must-revalidate",
	"pragma":             "no-cache",
	"priority":           "u=1, i",
	"sec-ch-ua":          `"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"`,
	"sec-ch-ua-mobile":   "?0",
	"sec-ch-ua-platform": `"Windows"`,
	"sec-fetch-dest":     "empty",
	"sec-fetch-mode":     "cors",
	"sec-fetch-site":     "same-site",
	"origin":             "https://appointment.ivacbd.com",
	"referer":            "https://appointment.ivacbd.com/",
	"user-agent":         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
}

// Get does a GET and returns the response body as a string (SMS OTP poll, bundle).
// It sends browser-like headers so Cloudflare/WAF in front of the site does not
// 403 the request the way it does a bare Go client.
func (f *HTTPFetcher) Get(url string) (string, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Referer", "https://appointment.ivacbd.com/")
	resp, err := f.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
