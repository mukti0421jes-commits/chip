package flow

// VerifyParams are the inputs to the OTP verify call.
type VerifyParams struct {
	RequestID   string
	Phone       string
	Code        string // the OTP
	AccessToken string // Bearer token from signin
}

// BuildVerify builds POST /otp/verifySigninOtp exactly as RJ SLOT v10.5 stepVerify:
//
//	body: JSON.stringify({ requestId, phone, code: otp, otpChannel:'PHONE' })
//	headers: accept, authorization Bearer, cache-control, content-type, pragma
func BuildVerify(p VerifyParams) (Request, error) {
	body, err := marshalBody(map[string]string{
		"requestId":  p.RequestID,
		"phone":      p.Phone,
		"code":       p.Code,
		"otpChannel": "PHONE",
	}, "requestId", "phone", "code", "otpChannel")
	if err != nil {
		return Request{}, err
	}
	return Request{
		Method: "POST",
		URL:    EPVerify,
		Headers: map[string]string{
			"accept":        "application/json, text/plain, */*",
			"authorization": "Bearer " + p.AccessToken,
			"cache-control": "no-cache, no-store, must-revalidate",
			"content-type":  "application/json",
			"pragma":        "no-cache",
		},
		Body:     body,
		Referrer: APIReferrer,
	}, nil
}
