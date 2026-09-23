package flow

// IVAC API endpoints — byte-exact from RJ SLOT v10.5 (the current, working site).
// These replace the Go bot's outdated/wrong paths (e.g. sign-in-v2, reserveSlot).
const (
	APIBase     = "https://api.ivacbd.com/iams/api/v1"
	APIReferrer = "https://appointment.ivacbd.com/"

	EPSignin = APIBase + "/auth/v2-sign-in"            // POST
	EPVerify = APIBase + "/otp/verifySigninOtp"        // POST
	EPBook   = APIBase + "/appointment/get-booking-config" // GET
	// reserve & initiate URLs carry a scanned id in the path:
	//   reserve : /slots/{slotId}/reserve-slot
	//   initiate: /payment/{dgepayId}/dg-epay/initiate
)

// ReserveURL builds the reserve endpoint with the scanned slot id in the path.
func ReserveURL(slotID string) string { return APIBase + "/slots/" + slotID + "/reserve-slot" }

// InitiateURL builds the dg-epay initiate endpoint with the scanned payment id.
func InitiateURL(dgepayID string) string { return APIBase + "/payment/" + dgepayID + "/dg-epay/initiate" }
