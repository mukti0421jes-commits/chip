package flow

import (
	"encoding/json"
	"strings"
	"time"
)

// signinResponse is the subset of the sign-in JSON RJ SLOT reads. `data` is kept
// raw so we can pull whichever token/requestId fields the current API returns.
type signinResponse struct {
	SuccessFlag bool            `json:"successFlag"`
	Message     string          `json:"message"`
	RequestID   string          `json:"requestId"`
	Data        json.RawMessage `json:"data"`
}

func pickStr(m map[string]interface{}, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// StepSignin runs one sign-in attempt, mirroring RJ SLOT stepSignin:
// get captcha → encrypt('signin') → POST /auth/v26-sign-in. IVAC's sign-in SENDS
// THE OTP and returns HTTP 200 + successFlag/"Success" (the accessToken/requestId
// used by verify). Success is detected on that 200 so we do NOT re-send the OTP
// (which triggers HTTP 429 "Too many attempts").
func StepSignin(r *Runner) StepResult {
	// OTP SESSION GATE: a successful sign-in already sent an OTP and opened a
	// ~15-minute session. Signing in again inside that window re-sends the OTP,
	// kills the code the user is holding and trips HTTP 429. So reuse the live
	// session instead of signing in again, until the window closes.
	if tok, rid, left, ok := LiveSignin(r.Phone); ok {
		r.mu.Lock()
		if tok != "" {
			r.AccessToken = tok
		}
		if rid != "" {
			r.RequestID = rid
		}
		r.mu.Unlock()
		r.log("⏳ Signin skip — OTP session ekhono alive (" + left.Round(time.Second).String() +
			" baki). Notun signin/OTP pathano hobe na, ei session-er OTP diyei verify hobe.")
		if r.OnSignedIn != nil {
			r.OnSignedIn(tok, rid)
		}
		return StepResult{Win: true}
	}

	token, err := r.Tokens.GetCaptchaToken()
	if err != nil {
		r.log("✗ signin: captcha token nei — " + err.Error() + " (Token Management-e C_token/E_token set korun)")
		return StepResult{}
	}
	if token == "" {
		r.log("✗ signin: captcha token khali (Token Management-e key set korun)")
		return StepResult{}
	}
	r.log("🔑 captcha token peyechi (len " + itoa(len(token)) + ") — signin request pathacchi…")
	enc := r.Config.EncryptForPurpose(token, r.Config.Signin)

	req, err := BuildSignin(SigninParams{
		Phone:            r.Phone,
		Password:         r.Password,
		EncryptedCaptcha: enc,
		NavState:         r.Config.NavState,
		BodyKeys:         r.Config.SigninBodyKeys(r.log), // proven {phone,password,c} unless IVAC renamed
		NavHeader:        r.Config.SigninNavHeader(r.log),
	})
	if err != nil {
		return StepResult{}
	}
	req.URL = r.Config.SigninURL() // live scanned endpoint (e.g. /auth/v26-sign-in)

	resp, err := r.Do(req)
	if err != nil {
		if r.Stopped() {
			return StepResult{Cancelled: true}
		}
		r.log("✗ signin: " + err.Error())
		return StepResult{}
	}

	var body signinResponse
	_ = json.Unmarshal(resp.Body, &body)

	// DIAGNOSTIC: show the exact response shape so field names are visible.
	raw := string(resp.Body)
	if len(raw) > 400 {
		raw = raw[:400]
	}
	r.log("📄 signin response (HTTP " + itoa(resp.Status) + "): " + raw)

	// Real signin success MUST carry a requestId (verify needs it). Accept only
	// when the body actually contains requestId or an accessToken.
	hasCreds := false
	accessToken, requestID := "", body.RequestID
	if len(body.Data) > 0 {
		var dm map[string]interface{}
		if json.Unmarshal(body.Data, &dm) == nil {
			accessToken = pickStr(dm, "accessToken", "access_token", "token", "verifyToken", "bearerToken")
			if rid := pickStr(dm, "requestId", "request_id", "reqId"); rid != "" {
				requestID = rid
			}
		}
	}
	if requestID != "" || accessToken != "" {
		hasCreds = true
	}
	success := resp.OK() && (body.SuccessFlag || strings.Contains(strings.ToLower(body.Message), "success")) && hasCreds
	if success {
		r.mu.Lock()
		r.AccessToken = accessToken
		if requestID != "" {
			r.RequestID = requestID
		}
		rid := r.RequestID
		r.mu.Unlock()
		// Open the 15-minute OTP window: no further sign-in for this phone until it
		// closes (see LiveSignin above).
		RememberSignin(r.Phone, accessToken, rid)
		if r.OnSignedIn != nil {
			r.OnSignedIn(accessToken, requestID)
		}
		r.log("✅ Signin OK — OTP sent to " + r.Phone + " (requestId " + requestID + ", token " + itoa(len(accessToken)) + " chars)")
		return StepResult{Win: true, Data: body}
	}

	// failure: surface HTTP status + the raw body so the exact shape is visible.
	snip := string(resp.Body)
	if len(snip) > 300 {
		snip = snip[:300]
	}
	r.log("✗ signin rejected — HTTP " + itoa(resp.Status) + " • " + snip)
	// TOO MANY ATTEMPTS (server lockout): applies to first-time login AND relogin. Do
	// NOT retry or re-login — that only extends the lockout. HardStop makes RunStepSmart
	// return at once and RunFullAuto auto-stop the instance (manual restart only).
	if isTooManyAttempts(string(resp.Body)) {
		r.log("🛑 signin: 'too many attempts' — server lockout. Ar signin/relogin kora hobe na; instance AUTO-STOP. Dorkar hole manually start korun.")
		return StepResult{Status: resp.Status, HardStop: true}
	}
	// #1: flag a cipher/verification rejection (HTTP 400 or "captcha verification
	// failed" from the SERVER) so RunStepSmart PAUSES the loop and waits for the
	// correct ivacflow_FINAL cipher+endpoints, then restarts from signin. A missing
	// captcha token / network error is handled earlier and never reaches here, so it
	// is never mistaken for a cipher failure.
	// 429 (rate limit): read the server's own "try after X minute Y seconds" schedule so
	// the retry waits exactly that long instead of a blind fixed delay.
	var retryAfter time.Duration
	if resp.Status == 429 {
		retryAfter = ParseRetryAfter(string(resp.Body))
	}
	return StepResult{Status: resp.Status, CipherFail: isCipherFail(resp.Status, string(resp.Body)), RetryAfter: retryAfter}
}

// isTooManyAttempts reports whether a sign-in rejection body carries a "too many
// attempts" / "too many requests" lockout message (the server's rate-limit response,
// usually with HTTP 429). Matched by message text — not status alone — so a transient
// 429 without that message still follows the normal retry path.
func isTooManyAttempts(body string) bool {
	b := strings.ToLower(body)
	return strings.Contains(b, "too many attempt") || strings.Contains(b, "too many request") ||
		strings.Contains(b, "too many tries") || strings.Contains(b, "too many login")
}

// isCipherFail reports whether a signin/reserve rejection is cipher/captcha related
// — the symptom that the encrypted `c` (cipher) or endpoint is wrong.
func isCipherFail(status int, body string) bool {
	if status == 400 {
		return true
	}
	b := strings.ToLower(body)
	return strings.Contains(b, "captcha") || strings.Contains(b, "cipher") ||
		strings.Contains(b, "verification failed") || strings.Contains(b, "invalid token")
}

// maybeCipherFallback fires the ivacflow fallback hook when the failure looks
// cipher-related. Safe no-op when no hook is wired.
func maybeCipherFallback(r *Runner, status int, body, step string) {
	if r.OnCipherFail == nil || !isCipherFail(status, body) {
		return
	}
	if r.OnCipherFail() {
		r.log("🔄 " + step + ": cipher/captcha bipatti → ivacflow push (cipher+endpoint) apply kora holo — porer retry-te notun config")
	} else {
		r.log("⏳ " + step + ": cipher/captcha bipatti → ivacflow theke notun cipher+endpoint ekhono ashe nai — wait kore abar cheshta hobe")
	}
}
