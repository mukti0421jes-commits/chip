package flow

import (
	"regexp"
	"strings"

	"github.com/dop251/goja"
)

// ── Live dg-epay UUID / initiate-path extraction ──────────────────────────────
//
// The payment-initiate URL ("/payment/<uuid>/dg-epay/initiate") is NOT plaintext
// in the bundle: it is assembled at runtime from ~12 base64+RC4-encrypted string
// fragments pulled out of a rotated string array (javascript-obfuscator). So no
// regex can find the uuid. This scanner reproduces, generically (by PATTERN, not
// by the per-build randomized names), exactly what the browser does:
//
//  1. locate the payment mutation region (anchored on "paymentMethod");
//  2. extract the base decoders it uses (e.g. mU/WU/CU) + their string arrays +
//     the load-time rotation IIFEs → a self-contained "prelude";
//  3. find the candidate concatenation expressions in that region;
//  4. run the prelude in goja, then evaluate each candidate WITH the wrapper
//     functions from its own lexical scope, and keep the one that decodes to a
//     /payment/.../initiate path (preferring the dg-epay+uuid form over ssl).
//
// Returns the full initiate path (e.g. "payment/<uuid>/dg-epay/initiate") or "".

var (
	reArrFn      = regexp.MustCompile(`function (\w+)\(\)\{(?:var|const|let) \w+=\[`)
	reWrapFn     = regexp.MustCompile(`function \w+\(\w+,\w+\)\{return \w+\([^{}]*\)\}`)
	reWrapTarget = regexp.MustCompile(`return (\w+)\(`)
	reArrRef     = regexp.MustCompile(`=(\w+)\(\)`)
	reCandidate  = regexp.MustCompile(`"[^"]{0,12}"(?:\+(?:\w+\([^()]*\)|"[^"]*"|\w+\(\w+\)))+`)
	reScopeOpen  = regexp.MustCompile(`function\*?\s*\w*\s*\([^)]*\)\s*\{|=>\s*\{`)
	reInitPath   = regexp.MustCompile(`payment/[0-9a-zA-Z_-]+(?:/dg-epay)?/initiate`)
	reInitUUID   = regexp.MustCompile(`payment/([0-9a-zA-Z_-]{20,40})/dg-epay/initiate`)
)

// ScanDgEpayUUID decodes the live dg-epay gateway UUID out of the bundle (via
// ScanInitiatePath) — empty if the current build uses a uuid-less path or it can't
// be resolved, so the caller keeps its fallback / manual id.
func ScanDgEpayUUID(bundle string) string {
	if m := reInitUUID.FindStringSubmatch(ScanInitiatePath(bundle)); m != nil {
		return m[1]
	}
	return ""
}

// grabBalanced returns s[start:end] where end closes the first '{' at/after start.
func grabBalanced(s string, start int) (string, int) {
	j := strings.IndexByte(s[start:], '{')
	if j < 0 {
		return "", len(s)
	}
	j += start
	depth := 0
	for k := j; k < len(s); k++ {
		switch s[k] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[start : k+1], k + 1
			}
		}
	}
	return "", len(s)
}

// grabNamedFn returns the full `function name(...){...}` body, or "".
func grabNamedFn(s, name string) string {
	i := strings.Index(s, "function "+name+"(")
	if i < 0 {
		return ""
	}
	body, _ := grabBalanced(s, i)
	return body
}

// ScanInitiatePath extracts the live payment-initiate path from the bundle by
// decoding the obfuscated fragments in goja. Empty string if not resolvable.
func ScanInitiatePath(bundle string) (path string) {
	defer func() { _ = recover() }()

	pi := strings.Index(bundle, "paymentMethod")
	if pi < 0 {
		return ""
	}
	winStart := pi - 500
	if winStart < 0 {
		winStart = 0
	}
	winEnd := pi + 6000
	if winEnd > len(bundle) {
		winEnd = len(bundle)
	}
	region := bundle[winStart:winEnd]

	// 1) base decoders the region's wrappers call.
	base := map[string]bool{}
	for _, w := range reWrapFn.FindAllString(region, -1) {
		if m := reWrapTarget.FindStringSubmatch(w); m != nil {
			base[m[1]] = true
		}
	}
	if len(base) == 0 {
		return ""
	}

	// 2) build the prelude: base decoders (+ any decoders they call) + their string
	//    arrays + the matching rotation IIFEs.
	seen := map[string]bool{}
	arrays := map[string]bool{}
	var decoderDefs []string
	var addDecoder func(name string)
	addDecoder = func(name string) {
		if seen[name] {
			return
		}
		seen[name] = true
		body := grabNamedFn(bundle, name)
		if body == "" {
			return
		}
		decoderDefs = append(decoderDefs, body)
		for _, a := range reArrRef.FindAllStringSubmatch(body, -1) {
			arrays[a[1]] = true
		}
		// follow decoders this one delegates to (e.g. pU -> PU)
		for _, r := range reWrapTarget.FindAllStringSubmatch(body, -1) {
			if r[1] != name && strings.Contains(bundle, "function "+r[1]+"(") {
				addDecoder(r[1])
			}
		}
	}
	for b := range base {
		addDecoder(b)
	}
	// array function names are the intersection of "arrays referenced" and real
	// array functions; grab each array fn + its rotation IIFE.
	var prelude []string
	realArr := map[string]bool{}
	for _, m := range reArrFn.FindAllStringSubmatch(bundle, -1) {
		realArr[m[1]] = true
	}
	for a := range arrays {
		if !realArr[a] {
			continue
		}
		if af := grabNamedFn(bundle, a); af != "" {
			prelude = append(prelude, af)
		}
		if rot := grabRotationFor(bundle, a); rot != "" {
			prelude = append(prelude, rot)
		}
	}
	prelude = append(prelude, decoderDefs...)
	if len(prelude) == 0 {
		return ""
	}

	// 3) candidate concat expressions in the region.
	cands := reCandidate.FindAllString(region, -1)
	if len(cands) == 0 {
		return ""
	}

	// 4) run prelude in goja, eval each candidate with its lexical-scope wrappers.
	vm := goja.New()
	if _, err := vm.RunString(strings.Join(prelude, ";\n") + ";"); err != nil {
		return ""
	}
	var sslPath string
	for _, c := range cands {
		wraps := scopeWrappers(bundle, c, pi)
		expr := "(function(){" + strings.Join(wraps, "\n") + "\nreturn (" + c + ");})()"
		v, err := vm.RunString(expr)
		if err != nil || v == nil {
			continue
		}
		got, ok := v.Export().(string)
		if !ok {
			continue
		}
		if m := reInitPath.FindString(got); m != "" {
			if strings.Contains(m, "/dg-epay/initiate") {
				return m // prefer the real dg-epay+uuid path
			}
			if sslPath == "" {
				sslPath = m // decoy / alternate gateway; keep as fallback
			}
		}
	}
	return sslPath
}

// grabRotationFor returns the load-time rotation IIFE `!function(e){...}(arr)`.
func grabRotationFor(s, arr string) string {
	tgt := "(" + arr + ")"
	for _, idx := range indexAll(s, "!function(") {
		body, end := grabBalanced(s, idx+1)
		if body == "" {
			continue
		}
		if strings.HasPrefix(s[end:minInt(end+len(tgt)+2, len(s))], tgt) {
			return "!" + body + tgt
		}
	}
	return ""
}

// scopeWrappers returns the wrapper function defs in the innermost function scope
// that contains the candidate expression — those are the ones in scope for it.
func scopeWrappers(bundle, cand string, near int) []string {
	cpos := strings.Index(bundle[near-1000:], cand)
	if cpos < 0 {
		cpos = strings.Index(bundle, cand)
	} else {
		cpos += near - 1000
	}
	if cpos < 0 {
		return nil
	}
	scanFrom := cpos - 4000
	if scanFrom < 0 {
		scanFrom = 0
	}
	var bestBody string
	bestLen := 1 << 30
	for _, m := range reScopeOpen.FindAllStringIndex(bundle[scanFrom:cpos], -1) {
		st := scanFrom + m[1] - 1 // position of '{'
		body, end := grabBalanced(bundle, st)
		if st < cpos && cpos < end && len(body) < bestLen {
			bestBody, bestLen = body, len(body)
		}
	}
	if bestBody == "" {
		return nil
	}
	return reWrapFn.FindAllString(bestBody, -1)
}

func indexAll(s, sub string) []int {
	var out []int
	for i := 0; ; {
		j := strings.Index(s[i:], sub)
		if j < 0 {
			break
		}
		out = append(out, i+j)
		i += j + len(sub)
	}
	return out
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
