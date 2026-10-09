package flow

import (
	"encoding/json"
	"net/url"
	"strings"
)

// Server-sourced mission/center resolution (RJ SLOT v10.7.4 parity).
//
// The hard-coded MissionMap matches only the 6 known missions with their exact
// labels; if IVAC renames a center, adds a mission, or returns a commissionName
// the map doesn't have, confirm-center would pick the wrong value (or fall back to
// Dhaka). The overview carries each applicant's commissionId; high-commissions/by-id
// returns the EXACT {missionName, centerName} the appointment-booking-config body
// must use — so resolving from the server makes confirm-center match whatever IVAC
// expects, with no hard-coding and surviving any future rename.

// BuildHighCommissionByID: GET /high-commissions/by-id?id=<commissionId>.
// Headers mirror the real browser call (incl. x-device-id, which binds it to the
// same appointment as the upload/confirm).
func (c *Config) BuildHighCommissionByID(commissionID, accessToken, deviceID string) Request {
	return Request{
		Method:   "GET",
		URL:      c.join("/high-commissions/by-id") + "?id=" + url.QueryEscape(commissionID),
		Referrer: APIReferrer,
		Headers: map[string]string{
			"accept":        "application/json, text/plain, */*",
			"authorization": "Bearer " + accessToken,
			"cache-control": "no-cache, no-store, must-revalidate",
			"pragma":        "no-cache",
			"x-device-id":   deviceID,
		},
	}
}

// highCommissionResp mirrors the by-id response: data.commission[0].missionName
// and data.centers[0].centerName.
type highCommissionResp struct {
	Data struct {
		Commission []struct {
			MissionName string `json:"missionName"`
		} `json:"commission"`
		Centers []struct {
			CenterName string `json:"centerName"`
		} `json:"centers"`
	} `json:"data"`
}

// resolveMissionCenterFromServer picks the primary applicant's commissionId (or any
// applicant's), calls high-commissions/by-id, and returns the server's exact
// {mission, center}. Returns ("","") when there is no commissionId or the call
// fails — the caller then keeps its existing MissionMap logic.
func (r *Runner) resolveMissionCenterFromServer(apps []overviewApplicant, deviceID string) (mission, center string) {
	cid := ""
	for _, a := range apps {
		if a.Primary && string(a.CommissionID) != "" {
			cid = string(a.CommissionID)
			break
		}
	}
	if cid == "" {
		for _, a := range apps {
			if string(a.CommissionID) != "" {
				cid = string(a.CommissionID)
				break
			}
		}
	}
	if cid == "" {
		return "", ""
	}
	resp, err := r.Do(r.Config.BuildHighCommissionByID(cid, r.AccessToken, deviceID))
	if err != nil || !resp.OK() {
		return "", ""
	}
	var hb highCommissionResp
	if json.Unmarshal(resp.Body, &hb) != nil {
		return "", ""
	}
	if len(hb.Data.Commission) > 0 {
		mission = strings.TrimSpace(hb.Data.Commission[0].MissionName)
	}
	if len(hb.Data.Centers) > 0 {
		center = strings.TrimSpace(hb.Data.Centers[0].CenterName)
	}
	if mission == "" || center == "" {
		return "", ""
	}
	return mission, center
}
