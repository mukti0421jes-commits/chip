package flow

import (
	"regexp"
	"strings"
)

// AppointmentOrigin is the site the bundle is served from (RJ SLOT location.origin).
const AppointmentOrigin = "https://appointment.ivacbd.com"

// bundleRe / bundleReG mirror RJ SLOT findBundleUrls:
//
//	/\/assets\/[a-zA-Z0-9]{8,}(?:-[a-zA-Z0-9]+)+\.js/g
var bundleReG = regexp.MustCompile(`/assets/[a-zA-Z0-9]{8,}(?:-[a-zA-Z0-9]+)+\.js`)

// pathRe / bareRe mirror the transitive chunk discovery inside the entry bundle:
//
//	PATH_RE = /(?:\/|\b)assets\/[\w.-]+\.js/g
//	BARE_RE = /["'`]([\w.-]+-[A-Za-z0-9_]{8,})\.js["'`]/g
var pathRe = regexp.MustCompile(`assets/[\w.-]+\.js`)
var bareRe = regexp.MustCompile("[\"'`]([\\w.-]+-[A-Za-z0-9_]{8,})\\.js[\"'`]")

// FindBundleURLs discovers the site's bundle chunk URLs, mirroring RJ SLOT
// findBundleUrls (server-side subset — no DOM/performance):
//  1. fetch <origin>/ (index.html) and pull every /assets/xHASH.js;
//  2. open the entry chunks and pull lazy-chunk names referenced inside them
//     (full /assets/ paths AND bare "name-HASH.js" basenames) — one level deep,
//     so the payment lazy-chunk (where dg-epay lives) is found without loading it.
//
// origin defaults to AppointmentOrigin when empty.
func FindBundleURLs(f Fetcher, origin string) []string {
	if origin == "" {
		origin = AppointmentOrigin
	}
	origin = strings.TrimRight(origin, "/")

	seen := map[string]bool{}
	var urls []string
	add := func(u string) {
		if u != "" && !seen[u] {
			seen[u] = true
			urls = append(urls, u)
		}
	}

	// 1) index.html
	if html, err := f.Get(origin + "/"); err == nil {
		for _, m := range bundleReG.FindAllString(html, -1) {
			add(origin + m)
		}
	}

	// 2) transitive: open the first few entry chunks, pull referenced chunk names.
	assetBase := origin + "/assets/"
	for _, u := range urls {
		if i := strings.Index(u, "/assets/"); i >= 0 {
			assetBase = u[:i+len("/assets/")]
			break
		}
	}
	seed := urls
	if len(seed) > 8 {
		seed = seed[:8]
	}
	for _, u := range append([]string{}, seed...) {
		t, err := f.Get(u)
		if err != nil {
			continue
		}
		for _, m := range pathRe.FindAllString(t, -1) {
			add(origin + "/" + strings.TrimPrefix(m, "/"))
		}
		for _, m := range bareRe.FindAllStringSubmatch(t, -1) {
			add(assetBase + m[1] + ".js")
		}
	}
	return urls
}

// DownloadBundles fetches each URL and returns the concatenated text of the
// chunks, stopping early once a core chunk (containing signin/reserve markers or
// a cipher `secret:`) is found — mirroring RJ SLOT's "up to first core chunk".
// It returns the combined text plus the individual chunk texts.
func DownloadBundles(f Fetcher, urls []string) (string, []string) {
	var combined strings.Builder
	var chunks []string
	for _, u := range urls {
		t, err := f.Get(u)
		if err != nil || t == "" {
			continue
		}
		chunks = append(chunks, t)
		combined.WriteString("\n")
		combined.WriteString(t)
		if strings.Contains(t, "secret:") || strings.Contains(t, "reserve-slot") || strings.Contains(t, "sign-in") {
			break
		}
	}
	return combined.String(), chunks
}
