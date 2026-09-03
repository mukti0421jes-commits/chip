package flow

import "strings"

// missionEntry is one row of RJ SLOT's MISSION_MAP.
type missionEntry struct {
	Mission    string
	IvacCenter string
}

// MissionMap mirrors RJ SLOT v10.5 MISSION_MAP EXACTLY. The confirm-center
// (appointment-booking-config) body must carry the full ivacCenter label
// (e.g. "IVAC, Dhaka (JFP)") — NOT the bare city — or the server rejects it.
var MissionMap = map[string]missionEntry{
	"dhaka":      {Mission: "Dhaka", IvacCenter: "IVAC, Dhaka (JFP)"},
	"jashore":    {Mission: "Dhaka", IvacCenter: "IVAC, Jashore"},
	"chittagong": {Mission: "Chittagong", IvacCenter: "IVAC, Chittagong"},
	"khulna":     {Mission: "Khulna", IvacCenter: "IVAC, Khulna"},
	"rajshahi":   {Mission: "Rajshahi", IvacCenter: "IVAC, Rajshahi"},
	"sylhet":     {Mission: "Sylhet", IvacCenter: "IVAC, Sylhet"},
}

// ResolveMissionCenter maps a UI value (mission name / center key, any case) to
// the exact {mission, ivacCenter} pair RJ SLOT sends. Falls back to Dhaka (JFP)
// — RJ SLOT's default selected option — when the key is unknown.
func ResolveMissionCenter(key string) (mission, ivacCenter string) {
	k := strings.ToLower(strings.TrimSpace(key))
	// direct key match (dhaka, jashore, …)
	if e, ok := MissionMap[k]; ok {
		return e.Mission, e.IvacCenter
	}
	// match by the label containing the city (e.g. "IVAC, Jashore", "Dhaka (JFP)")
	for _, e := range MissionMap {
		if strings.Contains(strings.ToLower(e.IvacCenter), k) || strings.EqualFold(e.Mission, key) {
			return e.Mission, e.IvacCenter
		}
	}
	d := MissionMap["dhaka"]
	return d.Mission, d.IvacCenter
}
