package flow

// Response is a minimal HTTP response the flow cares about.
type Response struct {
	Status int
	Body   []byte
}

// OK mirrors JS fetch's r.ok (2xx).
func (r Response) OK() bool { return r.Status >= 200 && r.Status < 300 }

// Doer sends a built Request and returns the Response. In the bot this is backed
// by the HTTP/2 (utls) client; tests supply a mock.
type Doer interface {
	Do(req Request) (Response, error)
}

// TokenProvider yields a captcha token (from the queue / solver). RJ SLOT's
// getCaptchaTokenSmart. Returns the raw (un-encrypted) token.
type TokenProvider interface {
	GetCaptchaToken() (string, error)
}

// Fetcher does a plain GET and returns the response body — used by the SMS/email
// OTP pollers (sms.php) and by the bundle downloader.
type Fetcher interface {
	Get(url string) (string, error)
}

// FetchFunc adapts a function to Fetcher.
type FetchFunc func(string) (string, error)

func (f FetchFunc) Get(url string) (string, error) { return f(url) }

// DoerFunc adapts a function to Doer (handy for tests).
type DoerFunc func(Request) (Response, error)

func (f DoerFunc) Do(r Request) (Response, error) { return f(r) }

// TokenFunc adapts a function to TokenProvider.
type TokenFunc func() (string, error)

func (f TokenFunc) GetCaptchaToken() (string, error) { return f() }
