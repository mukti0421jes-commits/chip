package flow

import (
	"testing"
	"time"
)

func TestParseRetryAfter(t *testing.T) {
	cases := []struct {
		body string
		want time.Duration
	}{
		// the real IVAC form
		{`{"message":"Please try after 0 minute 54 seconds later"}`, 54 * time.Second},
		{"Too many attempts. Try after 1 minute 30 seconds later.", 90 * time.Second},
		{"try after 2 minutes 5 sec", 125 * time.Second},
		// minutes only / seconds only, in a rate-limit body
		{"Please wait 3 minutes and try again", 3 * time.Minute},
		{"rate limit — try again after 45 seconds", 45 * time.Second},
		// clamp: absurdly small rounds up to 2s
		{"try after 0 minute 0 seconds", 0}, // 0 → no schedule
		{"please wait 1 second", 2 * time.Second}, // clamped up
		// no schedule / not rate-limited → 0 (caller keeps its own delay)
		{`{"successFlag":true,"data":{"requestId":"abc123"}}`, 0},
		{"", 0},
		{"some error with number 500 in it", 0}, // no rate-limit words → ignore stray number
	}
	for _, c := range cases {
		got := ParseRetryAfter(c.body)
		if got != c.want {
			t.Errorf("ParseRetryAfter(%q) = %v, want %v", c.body, got, c.want)
		}
	}
}
