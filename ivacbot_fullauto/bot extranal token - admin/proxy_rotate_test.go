package main

import (
	"errors"
	"testing"
)

func TestIsProxyFault(t *testing.T) {
	if !isProxyFault(0, errors.New("dial timeout")) {
		t.Fatal("transport error must be a proxy fault")
	}
	for _, s := range []int{403, 407, 408, 429, 502, 504, 520, 522, 524} {
		if !isProxyFault(s, nil) {
			t.Fatalf("status %d must be a proxy fault", s)
		}
	}
	// app-level replies: the proxy reached IVAC, so NOT a proxy fault
	for _, s := range []int{200, 201, 301, 400, 401, 404, 409, 500, 503} {
		if isProxyFault(s, nil) {
			t.Fatalf("status %d must NOT be a proxy fault (app-level)", s)
		}
	}
}

func setTestProxies(t *testing.T, ps []ProxyConfig) {
	t.Helper()
	orig := globalProxies
	globalProxies = ps
	t.Cleanup(func() { globalProxies = orig })
}

func TestNextEnabledProxyURLRoundRobin(t *testing.T) {
	setTestProxies(t, []ProxyConfig{
		{Type: "http", Host: "1.1.1.1", Port: 1, Enabled: true},
		{Type: "http", Host: "2.2.2.2", Port: 2, Enabled: true},
		{Type: "http", Host: "3.3.3.3", Port: 3, Enabled: true},
	})
	if got := nextEnabledProxyURL("http://1.1.1.1:1"); got != "http://2.2.2.2:2" {
		t.Fatalf("after p1 want p2, got %q", got)
	}
	if got := nextEnabledProxyURL("http://3.3.3.3:3"); got != "http://1.1.1.1:1" {
		t.Fatalf("after p3 should wrap to p1, got %q", got)
	}
	// single proxy == current → nothing to rotate to
	setTestProxies(t, []ProxyConfig{{Type: "http", Host: "9.9.9.9", Port: 9, Enabled: true}})
	if got := nextEnabledProxyURL("http://9.9.9.9:9"); got != "" {
		t.Fatalf("single same proxy → want empty, got %q", got)
	}
}

// setProxyRotate flips the P_rotate toggle for a test and restores it after.
func setProxyRotate(t *testing.T, on bool) {
	t.Helper()
	configMu.Lock()
	orig := globalConfig.ProxyRotate
	globalConfig.ProxyRotate = on
	configMu.Unlock()
	t.Cleanup(func() {
		configMu.Lock()
		globalConfig.ProxyRotate = orig
		configMu.Unlock()
	})
}

// With P_rotate OFF, repeated faults must NEVER rotate the proxy.
func TestFlowDoerNoRotateWhenToggleOff(t *testing.T) {
	setTestProxies(t, []ProxyConfig{
		{Type: "http", Host: "1.1.1.1", Port: 1, Enabled: true},
		{Type: "http", Host: "2.2.2.2", Port: 2, Enabled: true},
	})
	setProxyRotate(t, false)
	d := newFlowDoer("http://1.1.1.1:1", nil, func(string) {})
	for i := 0; i < 6; i++ {
		d.noteResult(429, nil)
	}
	if d.curProxy != "http://1.1.1.1:1" {
		t.Fatalf("P_rotate OFF must never rotate, got %q", d.curProxy)
	}
}

func TestFlowDoerRotatesAfterThresholdAndResetsOnSuccess(t *testing.T) {
	setTestProxies(t, []ProxyConfig{
		{Type: "http", Host: "1.1.1.1", Port: 1, Enabled: true},
		{Type: "http", Host: "2.2.2.2", Port: 2, Enabled: true},
	})
	setProxyRotate(t, true)
	d := newFlowDoer("http://1.1.1.1:1", nil, func(string) {})

	// two faults then a success → no rotation, streak reset
	d.noteResult(0, errors.New("timeout"))
	d.noteResult(502, nil)
	d.noteResult(200, nil) // success resets
	if d.curProxy != "http://1.1.1.1:1" {
		t.Fatalf("2 faults + success must NOT rotate, proxy=%q", d.curProxy)
	}
	if d.errStreak != 0 {
		t.Fatalf("success must reset streak, got %d", d.errStreak)
	}

	// three consecutive faults → rotate to the next proxy
	d.noteResult(429, nil)
	d.noteResult(403, nil)
	d.noteResult(0, errors.New("reset")) // 3rd fault → rotate
	if d.curProxy != "http://2.2.2.2:2" {
		t.Fatalf("3 consecutive faults must rotate to p2, got %q", d.curProxy)
	}
	if d.errStreak != 0 {
		t.Fatalf("streak must reset after rotation, got %d", d.errStreak)
	}
}
