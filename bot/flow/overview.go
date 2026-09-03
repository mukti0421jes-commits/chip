package flow

import (
	"regexp"
	"strings"
)

// overviewApplicant is one entry from /file/over-view-v3 (body.data[]).
type overviewApplicant struct {
	FullName       string  `json:"fullName"`
	Primary        bool    `json:"primary"`
	IvacCenter     *string `json:"ivacCenter"`     // null until the center is confirmed for this appointment
	CommissionName string  `json:"commissionName"` // the mission this applicant/file belongs to (e.g. "Dhaka", "Rajshahi")
}

var extRe = regexp.MustCompile(`(?i)\.[a-z0-9]+$`)
var nonAlphaRe = regexp.MustCompile(`[^A-Z]+`)

// nameTokens mirrors RJ SLOT _auNameTokens: drop extension, uppercase, split on
// non-letters, keep tokens of length >= 3.
func nameTokens(s string) []string {
	s = extRe.ReplaceAllString(s, "")
	s = strings.ToUpper(s)
	parts := nonAlphaRe.Split(s, -1)
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if len(p) >= 3 {
			out = append(out, p)
		}
	}
	return out
}

// tokensMatch mirrors RJ SLOT _auTokensMatch: at least min(2, len(nameTokens))
// shared tokens, both sides non-empty.
func tokensMatch(fileTokens, nameTok []string) bool {
	if len(fileTokens) == 0 || len(nameTok) == 0 {
		return false
	}
	fileSet := map[string]bool{}
	for _, t := range fileTokens {
		fileSet[t] = true
	}
	shared := 0
	for _, t := range nameTok {
		if fileSet[t] {
			shared++
		}
	}
	need := 2
	if len(nameTok) < need {
		need = len(nameTok)
	}
	return shared >= need
}

// OverviewMatch verifies the uploaded files against the overview, mirroring RJ
// SLOT autoUploadChain's final check:
//
//	match = (overviewCount == loadedCount) && (all loaded files name-matched to a
//	         DISTINCT overview applicant) && (at least one primary applicant).
//
// Returns (ok, reason). ok=true means Confirm Center may proceed.
func OverviewMatch(applicants []overviewApplicant, files []PDFFile) (bool, string) {
	overviewCount := len(applicants)
	primaryCount := 0
	for _, a := range applicants {
		if a.Primary {
			primaryCount++
		}
	}
	// distinct name matching
	used := make([]bool, len(applicants))
	entryTokens := make([][]string, len(applicants))
	for i, a := range applicants {
		entryTokens[i] = nameTokens(a.FullName)
	}
	var unmatched []string
	for _, f := range files {
		ftok := nameTokens(f.Name)
		found := false
		for i := range applicants {
			if !used[i] && tokensMatch(ftok, entryTokens[i]) {
				used[i] = true
				found = true
				break
			}
		}
		if !found {
			unmatched = append(unmatched, f.Name)
		}
	}
	countOk := overviewCount == len(files)
	namesOk := len(unmatched) == 0
	patientOk := primaryCount >= 1
	if countOk && namesOk && patientOk {
		return true, ""
	}
	// Single applicant: there is exactly one file and one applicant, so the file
	// unambiguously belongs to that applicant — name matching is pointless (the PDF
	// is often named by application/slip number, e.g. "BGDRV1E2E826SA020902.pdf",
	// not the person's name). Proceed as long as the count lines up and a primary
	// applicant exists.
	if countOk && patientOk && overviewCount == 1 {
		return true, ""
	}
	var why []string
	if !countOk {
		why = append(why, "count "+itoa(overviewCount)+"≠"+itoa(len(files)))
	}
	if !namesOk {
		why = append(why, "unmatched: "+strings.Join(unmatched, ", "))
	}
	if !patientOk {
		why = append(why, "no patient(primary)")
	}
	return false, strings.Join(why, " | ")
}
