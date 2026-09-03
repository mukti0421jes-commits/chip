package flow

import (
	_ "embed"
	"hash/fnv"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/dop251/goja"
)

// dg-epay results are cached by bundle-content hash — deobfuscation is expensive
// (goja runs the whole extractor, ~seconds) and a bundle only changes on redeploy.
var (
	dgCacheMu sync.Mutex
	dgCache   = map[uint64]string{}
)

// ClearDgCache empties the dg-epay bundle-hash cache so the next scan re-resolves
// from scratch (used by the dashboard's Clean Cache button).
func ClearDgCache() {
	dgCacheMu.Lock()
	dgCache = map[uint64]string{}
	dgCacheMu.Unlock()
}

// dgEpayExtractor is the proven RJ SLOT / IVAC bundle extractor (extract_fetch.js
// v11). It deobfuscates the payment generator to recover the dg-epay gateway
// UUID that lives in a lazy payment chunk. We run the EXACT script on goja so the
// decode is byte-identical to what the browser produces — no reimplementation.
//
//go:embed extract_fetch.js
var dgEpayExtractor string

// dgEpayPrelude shims the small Node surface the extractor needs (fs/path/vm/
// process/console/require). Node's `vm` sandbox just exposes context keys as
// globals; we reproduce that with `new Function(keys, code)` (goja-native), so
// runInContext runs the obfuscated rotation IIFE with the same visibility.
const dgEpayPrelude = `
var __logs = [];
function __join(a){ return Array.prototype.map.call(a, function(x){ return (typeof x==='string')?x:String(x); }).join(' '); }
var console = { log:function(){ __logs.push(__join(arguments)); }, error:function(){ __logs.push(__join(arguments)); } };
var __dirname = '.';
var process = { argv:['node','extract_fetch.js','bundle.js','out.js'], exit:function(c){ throw new Error('__EXIT__'+(c||0)); } };
var module = { exports:{} }; var exports = module.exports;
function __vmScript(code){ this.__code = code; }
__vmScript.prototype.runInContext = function(ctx, opts){
  var keys = Object.keys(ctx);
  var vals = keys.map(function(k){ return ctx[k]; });
  var fn = new Function(keys.join(','), this.__code);
  return fn.apply(null, vals);
};
var __vm = { createContext:function(o){ return o; }, Script:__vmScript };
function require(m){
  if(m==='fs') return { readFileSync:function(){ return __BUNDLE_SRC; }, writeFileSync:function(){}, existsSync:function(){ return false; } };
  if(m==='path') return { join:function(){ return __join(arguments); }, basename:function(p){ p=String(p); var i=Math.max(p.lastIndexOf('/'),p.lastIndexOf('\\')); return i>=0?p.slice(i+1):p; } };
  if(m==='vm') return __vm;
  throw new Error('no module '+m);
}
`

var dgEpayPathRe = regexp.MustCompile(`/payment/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/dg-epay/initiate`)

// ScanDgEpay runs the embedded extractor on the given bundle text and returns the
// resolved dg-epay gateway UUID (empty string if not resolvable). It is safe:
// any goja error or missing match yields "" so the caller can keep its fallback.
func ScanDgEpay(bundle string) (uuid string) {
	defer func() { _ = recover() }()

	h := fnv.New64a()
	h.Write([]byte(strconv.Itoa(len(bundle))))
	h.Write([]byte(bundle))
	key := h.Sum64()
	dgCacheMu.Lock()
	if v, ok := dgCache[key]; ok {
		dgCacheMu.Unlock()
		return v
	}
	dgCacheMu.Unlock()
	defer func() {
		dgCacheMu.Lock()
		dgCache[key] = uuid
		dgCacheMu.Unlock()
	}()

	src := dgEpayExtractor
	if strings.HasPrefix(src, "#!") { // strip shebang
		if i := strings.IndexByte(src, '\n'); i >= 0 {
			src = src[i+1:]
		}
	}

	vm := goja.New()
	vm.Set("__BUNDLE_SRC", bundle)
	wrapped := dgEpayPrelude + "\ntry{\n" + src +
		"\n}catch(__e){ if(String(__e.message).indexOf('__EXIT__')<0) __logs.push('__ERR__'+__e); }\n"
	if _, err := vm.RunString(wrapped); err != nil {
		return ""
	}
	var logs []string
	vm.ExportTo(vm.Get("__logs"), &logs)
	for _, l := range logs {
		if m := dgEpayPathRe.FindStringSubmatch(l); m != nil {
			return m[1] // the UUID
		}
	}
	return ""
}
