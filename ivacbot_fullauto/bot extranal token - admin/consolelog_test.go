package main

import "testing"

func TestConsoleRingSinceAndCap(t *testing.T) {
	c := &consoleRing{max: 3}
	c.add("a")
	c.add("b")
	lines, head := c.since(0, 400)
	if head != 2 || len(lines) != 2 {
		t.Fatalf("since(0) want 2 lines head 2, got %d lines head %d", len(lines), head)
	}
	// incremental: only lines newer than seq=1
	lines, head = c.since(1, 400)
	if len(lines) != 1 || lines[0].Msg != "b" || head != 2 {
		t.Fatalf("since(1) want only 'b', got %+v head %d", lines, head)
	}
	// ring cap: adding beyond max drops oldest
	c.add("c")
	c.add("d") // now max 3 → a,b dropped; b? max=3 keeps b,c,d
	all, _ := c.since(0, 400)
	if len(all) != 3 || all[0].Msg != "b" || all[2].Msg != "d" {
		t.Fatalf("ring cap want [b c d], got %+v", all)
	}
}
