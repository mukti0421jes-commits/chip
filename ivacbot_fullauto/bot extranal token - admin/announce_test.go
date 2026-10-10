package main

import (
	"testing"
	"time"
)

// TestScanAnnounceOncePerScan: Full Auto All runs every instance against ONE
// shared scan, so each instance reports the same result. Only the first may
// advance Seq — otherwise the dashboard plays the announcement once per
// instance, which is what the user was hearing.
func TestScanAnnounceOncePerScan(t *testing.T) {
	scanAnnMu.Lock()
	scanAnn, scanAnnAt = scanAnnouncement{}, time.Time{}
	scanAnnMu.Unlock()

	const detail = "endpoints=10 cipher=ok slot=139fd4d2-27c9-4758-a623-368583e830bs"
	for i := 0; i < 10; i++ { // ten instances, one shared scan
		announceScanComplete(true, detail)
	}
	scanAnnMu.Lock()
	seq := scanAnn.Seq
	scanAnnMu.Unlock()
	if seq != 1 {
		t.Fatalf("ten instances produced %d announcements, want 1", seq)
	}
}

// TestScanAnnounceNewResultStillAnnounces: a genuinely different scan result
// must still be announced, even inside the cooldown.
func TestScanAnnounceNewResultStillAnnounces(t *testing.T) {
	scanAnnMu.Lock()
	scanAnn, scanAnnAt = scanAnnouncement{}, time.Time{}
	scanAnnMu.Unlock()

	announceScanComplete(true, "endpoints=10 cipher=ok slot=AAA")
	announceScanComplete(true, "endpoints=10 cipher=ok slot=AAA") // repeat → ignored
	announceScanComplete(true, "endpoints=10 cipher=ok slot=BBB") // changed → announced

	scanAnnMu.Lock()
	seq, detail := scanAnn.Seq, scanAnn.Detail
	scanAnnMu.Unlock()
	if seq != 2 {
		t.Fatalf("Seq = %d, want 2 (first result + the changed one)", seq)
	}
	if detail != "endpoints=10 cipher=ok slot=BBB" {
		t.Fatalf("latest detail = %q", detail)
	}
}

// TestScanAnnounceAfterCooldown: once the cooldown lapses, the same result is a
// new scan and is announced again.
func TestScanAnnounceAfterCooldown(t *testing.T) {
	const detail = "endpoints=10 cipher=ok slot=AAA"
	scanAnnMu.Lock()
	scanAnn, scanAnnAt = scanAnnouncement{}, time.Time{}
	scanAnnMu.Unlock()

	announceScanComplete(true, detail)
	scanAnnMu.Lock()
	scanAnnAt = time.Now().Add(-scanAnnounceCooldown - time.Second) // pretend time passed
	scanAnnMu.Unlock()
	announceScanComplete(true, detail)

	scanAnnMu.Lock()
	seq := scanAnn.Seq
	scanAnnMu.Unlock()
	if seq != 2 {
		t.Fatalf("Seq = %d, want 2 (cooldown lapsed → new scan)", seq)
	}
}

// TestScanAnnounceIgnoresIncompleteScan: a fallback scan is logged, never sounded.
func TestScanAnnounceIgnoresIncompleteScan(t *testing.T) {
	scanAnnMu.Lock()
	scanAnn, scanAnnAt = scanAnnouncement{}, time.Time{}
	scanAnnMu.Unlock()
	announceScanComplete(false, "bundle unreachable")
	scanAnnMu.Lock()
	seq := scanAnn.Seq
	scanAnnMu.Unlock()
	if seq != 0 {
		t.Fatalf("an incomplete scan was announced (Seq=%d)", seq)
	}
}
