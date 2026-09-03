package flow

import "encoding/json"

// StepInitiate runs POST /payment/{dgepayId}/dg-epay/initiate (RJ SLOT stepInitiate):
//   get captcha (RAW, sent as x-token — NOT encrypted) → body {appointmentId};
//   success = r.ok || statusCode==201 || successFlag; then extract payment URL.
func StepInitiate(r *Runner) StepResult {
	if r.AccessToken == "" {
		r.log("❌ No session")
		return StepResult{}
	}
	if r.AppointmentID == "" {
		r.log("❌ No appointmentId")
		return StepResult{}
	}
	token, err := r.Tokens.GetCaptchaToken()
	if err != nil {
		r.log("✗ captcha: " + err.Error())
		return StepResult{}
	}
	body, err := marshalBody(map[string]string{"appointmentId": r.AppointmentID}, "appointmentId")
	if err != nil {
		return StepResult{}
	}
	req := Request{
		Method: "POST", URL: r.Config.InitiateURLFor(), Referrer: APIReferrer, Body: body,
		Headers: map[string]string{
			"accept":        "application/json, text/plain, */*",
			"authorization": "Bearer " + r.AccessToken,
			"content-type":  "application/json",
			"x-token":       token, // RAW captcha token (initiate does NOT encrypt)
		},
	}
	resp, err := r.Doer.Do(req)
	if err != nil {
		if r.Stopped() {
			return StepResult{Cancelled: true}
		}
		return StepResult{}
	}
	var body2 struct {
		SuccessFlag bool                   `json:"successFlag"`
		StatusCode  int                    `json:"statusCode"`
		Data        map[string]interface{} `json:"data"`
	}
	_ = json.Unmarshal(resp.Body, &body2)
	success := resp.OK() || body2.StatusCode == 201 || body2.SuccessFlag
	if !success {
		return StepResult{Status: resp.Status}
	}
	url := extractPaymentURL(resp.Body)
	if url == "" {
		r.log("⚠ Initiate succeeded but no payment URL")
		return StepResult{}
	}
	r.mu.Lock()
	r.PaymentURL = url
	r.mu.Unlock()
	r.log("✅ Payment URL received")
	return StepResult{Win: true, Data: url}
}

// extractPaymentURL mirrors RJ SLOT extractPaymentUrl: check body.data (or body)
// for any of the known payment-url field names, in order.
func extractPaymentURL(raw []byte) string {
	var outer map[string]interface{}
	if json.Unmarshal(raw, &outer) != nil {
		return ""
	}
	d := outer
	if dd, ok := outer["data"].(map[string]interface{}); ok {
		d = dd
	}
	for _, k := range []string{
		"webview_url", "GatewayPageURL", "gatewayPageURL", "paymentUrl",
		"payment_url", "gatewayUrl", "redirectUrl", "redirect_url", "url",
		"epayUrl", "securePayUrl",
	} {
		if v, ok := d[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}
