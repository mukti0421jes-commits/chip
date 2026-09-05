package flow

import (
	"bytes"
	"strconv"
)

// ── Upload sub-flow endpoint URLs (scanned literal → full URL) ────────────────

// AppointmentURL → .../appointment (fixed path, no version).
func (c *Config) AppointmentURL() string { return c.join("/appointment") }

// BookingConfigURL → .../appointment/appointment-booking-config.
func (c *Config) BookingConfigURL() string {
	return c.join(c.ep("/appointment/appointment-booking-config"))
}

// OverviewURL → .../file/over-view-v347 (scanned).
func (c *Config) OverviewURL() string { return c.join(c.ep("/file/over-view-v3")) }

// SlotStatusURL → .../file/file-confirmation_and_slot_status.
func (c *Config) SlotStatusURL() string {
	return c.join(c.ep("/file/file-confirmation_and_slot_status"))
}

// UploadURL → .../file/upload_file_v2117 (scanned).
func (c *Config) UploadURL() string { return c.join(c.ep("/file/upload_file_v2")) }

// InvoiceDownloadURL → .../invoice/download?txrId=<trxId> (fixed path).
func (c *Config) InvoiceDownloadURL(trxID string) string {
	return c.join("/invoice/download") + "?txrId=" + trxID
}

// ── Request builders (byte-exact from RJ SLOT v10.5) ──────────────────────────

// BuildAppointment: POST /appointment, no body.
//   headers: accept, authorization Bearer, cache-control:no-cache, x-device-id
func (c *Config) BuildAppointment(accessToken, deviceID string) Request {
	return Request{
		Method: "POST", URL: c.AppointmentURL(), Referrer: APIReferrer,
		Headers: map[string]string{
			"accept":        "application/json, text/plain, */*",
			"authorization": "Bearer " + accessToken,
			"cache-control": "no-cache",
			"x-device-id":   deviceID,
		},
	}
}

// BuildBookingConfig: POST /appointment/appointment-booking-config
//   body {mission, ivacCenter}; headers accept, auth, content-type, x-device-id
func (c *Config) BuildBookingConfig(mission, ivacCenter, accessToken, deviceID string) (Request, error) {
	body, err := marshalBody(map[string]string{"mission": mission, "ivacCenter": ivacCenter}, "mission", "ivacCenter")
	if err != nil {
		return Request{}, err
	}
	return Request{
		Method: "POST", URL: c.BookingConfigURL(), Referrer: APIReferrer, Body: body,
		Headers: map[string]string{
			"accept":        "application/json",
			"authorization": "Bearer " + accessToken,
			"content-type":  "application/json",
			"x-device-id":   deviceID,
		},
	}, nil
}

// BuildOverview: POST /file/over-view-v3, no body.
//   headers accept:application/json, auth, x-device-id
func (c *Config) BuildOverview(accessToken, deviceID string) Request {
	return Request{
		Method: "POST", URL: c.OverviewURL(), Referrer: APIReferrer,
		Headers: map[string]string{
			"accept":        "application/json",
			"authorization": "Bearer " + accessToken,
			"x-device-id":   deviceID,
		},
	}
}

// BuildSlotStatus: GET /file/file-confirmation_and_slot_status.
//   headers accept, auth, cache-control:full, pragma, x-device-id
func (c *Config) BuildSlotStatus(accessToken, deviceID string) Request {
	return Request{
		Method: "GET", URL: c.SlotStatusURL(), Referrer: APIReferrer,
		Headers: map[string]string{
			"accept":        "application/json, text/plain, */*",
			"authorization": "Bearer " + accessToken,
			"cache-control": "no-cache, no-store, must-revalidate",
			"pragma":        "no-cache",
			"x-device-id":   deviceID,
		},
	}
}

// UploadParams are the inputs to a file upload.
type UploadParams struct {
	AccessToken  string
	CaptchaToken string // raw captcha token → x-token
	RuntimeState string // x-sec-runtime-state
	FileName     string
	FileType     string // defaults to application/octet-stream
	FileBytes    []byte
	IsPrimary    bool
	Boundary     string // multipart boundary (deterministic; caller randomizes)
}

// BuildUpload builds POST /file/upload_file_v2 with a multipart body byte-exact
// to RJ SLOT sendMultipartUpload: one "files" part + an isPrimary field.
func (c *Config) BuildUpload(p UploadParams) Request {
	ftype := p.FileType
	if ftype == "" {
		ftype = "application/octet-stream"
	}
	body := buildMultipart(p.Boundary, p.FileName, ftype, p.FileBytes,
		[][2]string{{"isPrimary", strconv.FormatBool(p.IsPrimary)}})
	return Request{
		Method: "POST", URL: c.UploadURL(), Referrer: APIReferrer, Body: body,
		Headers: map[string]string{
			"accept":              "application/json, text/plain, */*",
			"authorization":       "Bearer " + p.AccessToken,
			"cache-control":       "no-cache, no-store, must-revalidate",
			"pragma":              "no-cache",
			"x-sec-runtime-state": p.RuntimeState,
			"x-token":             p.CaptchaToken,
			"content-type":        "multipart/form-data; boundary=" + p.Boundary,
		},
	}
}

// buildMultipart reproduces RJ SLOT's exact byte layout:
//
//	--BOUNDARY\r\n
//	Content-Disposition: form-data; name="files"; filename="NAME"\r\n
//	Content-Type: TYPE\r\n\r\n
//	<file bytes>\r\n
//	--BOUNDARY\r\n
//	Content-Disposition: form-data; name="KEY"\r\n\r\nVALUE\r\n
//	--BOUNDARY--\r\n
func buildMultipart(boundary, fileName, fileType string, fileBytes []byte, fields [][2]string) []byte {
	var b bytes.Buffer
	b.WriteString("--" + boundary + "\r\n")
	b.WriteString(`Content-Disposition: form-data; name="files"; filename="` + fileName + `"` + "\r\n")
	b.WriteString("Content-Type: " + fileType + "\r\n\r\n")
	b.Write(fileBytes)
	b.WriteString("\r\n")
	for _, kv := range fields {
		b.WriteString("--" + boundary + "\r\n")
		b.WriteString(`Content-Disposition: form-data; name="` + kv[0] + `"` + "\r\n\r\n")
		b.WriteString(kv[1] + "\r\n")
	}
	b.WriteString("--" + boundary + "--\r\n")
	return b.Bytes()
}
