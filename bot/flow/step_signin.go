package flow

import (
	"encoding/json"
	"strings"
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
		r.mu.Unlock()
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
	return StepResult{Status: resp.Status}
}
