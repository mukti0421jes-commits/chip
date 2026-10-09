package flow

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ── 429 "try after X minute Y seconds" parser ────────────────────────────────
//
// IVAC's rate-limit (HTTP 429) response carries the exact wait in its body, e.g.
// "Please try after 0 minute 54 seconds later". Instead of retrying on a blind fixed
// delay, we read that schedule and wait EXACTLY that long — so the next signin lands
// right when the server allows it, not before (which would just earn another 429).

var (
	// "X minute(s) Y second(s)" — the precise IVAC form, trusted anywhere in the body.
	reMinSec = regexp.MustCompile(`(?i)(\d+)\s*min(?:ute)?s?\s*(?:and\s*)?(\d+)\s*sec`)
	// minutes-only / seconds-only — only trusted when the body looks like a rate limit.
	reMin = regexp.MustCompile(`(?i)(\d+)\s*min(?:ute)?s?`)
	reSec = regexp.MustCompile(`(?i)(\d+)\s*sec(?:ond)?s?`)
	// a rate-limit-ish body, so a stray number elsewhere is not mistaken for a wait.
	reRateWord = regexp.MustCompile(`(?i)again|after|wait|limit|attempt|try|later|too many`)
)

// ParseRetryAfter extracts the server-scheduled wait from a 429 body. Returns 0 when
// no schedule is found (the caller then keeps its own configured delay). The result is
// clamped to a sane [2s, 30m] so a malformed body can neither hot-loop nor hang a run.
func ParseRetryAfter(body string) time.Duration {
	if strings.TrimSpace(body) == "" {
		return 0
	}
	atoi := func(s string) int { n, _ := strconv.Atoi(s); return n }
	var d time.Duration

	if m := reMinSec.FindStringSubmatch(body); m != nil {
		d = time.Duration(atoi(m[1])*60+atoi(m[2])) * time.Second
	} else if reRateWord.MatchString(body) {
		// fall back to minutes/seconds mentioned in an obviously rate-limited message
		if m := reMin.FindStringSubmatch(body); m != nil {
			d += time.Duration(atoi(m[1])) * time.Minute
		}
		if m := reSec.FindStringSubmatch(body); m != nil {
			d += time.Duration(atoi(m[1])) * time.Second
		}
	}
	if d <= 0 {
		return 0
	}
	if d < 2*time.Second {
		d = 2 * time.Second
	}
	if d > 30*time.Minute {
		d = 30 * time.Minute
	}
	return d
}
