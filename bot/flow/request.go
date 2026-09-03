package flow

// Request is a fully-specified HTTP request, built to match RJ SLOT v10.5
// byte-for-byte (method, url, header set/values, JSON body). The H2 client
// sends it as-is.
type Request struct {
	Method   string
	URL      string
	Headers  map[string]string
	Body     []byte // nil for GET
	Referrer string
}
