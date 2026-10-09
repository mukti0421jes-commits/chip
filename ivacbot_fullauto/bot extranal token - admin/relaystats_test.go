package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// fetchRelayStats must parse the farm relay /stats and count browsers (perSource keys).
func TestFetchRelayStats(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/stats" {
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"perSource":{"profile-a3f9":{"pushed":10},"profile-77bc":{"pushed":7}},"totalPushed":17,"totalPulled":5,"totalExpired":2,"fresh":12}`))
	}))
	defer srv.Close()

	rs, ok := fetchRelayStats(srv.URL)
	if !ok {
		t.Fatal("expected ok")
	}
	if len(rs.PerSource) != 2 {
		t.Fatalf("browsers = %d, want 2", len(rs.PerSource))
	}
	if rs.Fresh != 12 || rs.TotalPushed != 17 || rs.TotalPulled != 5 {
		t.Fatalf("stats mismatch: %+v", rs)
	}
}

// A dead relay → ok=false (dashboard flags farm/relay off).
func TestFetchRelayStatsDown(t *testing.T) {
	if _, ok := fetchRelayStats("http://127.0.0.1:1"); ok {
		t.Fatal("unreachable relay should return ok=false")
	}
}
