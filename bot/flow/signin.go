package flow

import "encoding/json"

// SigninParams are the inputs to the sign-in call.
type SigninParams struct {
	Phone            string
	Password         string
	EncryptedCaptcha string // captcha token already encrypted with the 'signin' cipher
	NavState         string // x-sec-navigation-state (from dynamic scan / runtime)
}

// BuildSignin builds the POST /auth/v2-sign-in request exactly as RJ SLOT v10.5
// stepSignin does:
//
//   H2.fetchH2(API_SIGNIN_V2, { method:'POST', headers:{
//       'accept':'application/json, text/plain, */*',
//       'cache-control':'no-cache, no-store, must-revalidate',
//       'content-type':'application/json',
//       'pragma':'no-cache',
//       'x-sec-navigation-state': _navState() },
//     referrer: API_REFERRER,
//     body: JSON.stringify({ phone, password, c: encryptedCaptcha }) })
func BuildSignin(p SigninParams) (Request, error) {
	body, err := marshalBody(map[string]string{
		"phone":    p.Phone,
		"password": p.Password,
		"c":        p.EncryptedCaptcha,
	}, "phone", "password", "c")
	if err != nil {
		return Request{}, err
	}
	return Request{
		Method: "POST",
		URL:    EPSignin,
		Headers: map[string]string{
			"accept":                  "application/json, text/plain, */*",
			"cache-control":           "no-cache, no-store, must-revalidate",
			"content-type":            "application/json",
			"pragma":                  "no-cache",
			"x-sec-navigation-state":  p.NavState,
		},
		Body:     body,
		Referrer: APIReferrer,
	}, nil
}

// marshalBody encodes a JSON object with keys in the given order, matching
// JavaScript's JSON.stringify({...}) field order exactly (Go's map marshalling
// sorts keys, which would change the byte output — so we emit in order).
func marshalBody(m map[string]string, order ...string) ([]byte, error) {
	out := []byte{'{'}
	for i, k := range order {
		if i > 0 {
			out = append(out, ',')
		}
		kb, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		vb, err := json.Marshal(m[k])
		if err != nil {
			return nil, err
		}
		out = append(out, kb...)
		out = append(out, ':')
		out = append(out, vb...)
	}
	out = append(out, '}')
	return out, nil
}
