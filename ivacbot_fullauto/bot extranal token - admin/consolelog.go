package main

// Server Console capture: on the VPS the bot runs under systemd with NO attached
// terminal, so the global console output (captcha pool fills, ivacflow cipher/endpoint
// pushes, startup banners — everything printed with fmt.Print*) is invisible unless you
// tail journald. This tees stdout+stderr into an in-memory ring buffer AND keeps writing
// to the real console (so journald still records it), then serves the ring to a dashboard
// "Server Console" panel — so the whole live picture is readable in ONE place from the web.

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

type consoleLine struct {
	Seq int64  `json:"seq"`
	T   string `json:"t"`
	Msg string `json:"msg"`
}

type consoleRing struct {
	mu    sync.Mutex
	lines []consoleLine
	seq   int64
	max   int
}

var serverConsole = &consoleRing{max: 3000}

// add appends one line (dropping the oldest when the ring is full).
func (c *consoleRing) add(msg string) {
	c.mu.Lock()
	c.seq++
	c.lines = append(c.lines, consoleLine{Seq: c.seq, T: time.Now().Format("15:04:05"), Msg: msg})
	if len(c.lines) > c.max {
		c.lines = c.lines[len(c.lines)-c.max:]
	}
	c.mu.Unlock()
}

// since returns every line newer than seq, plus the current head seq. seq<=0 returns
// the last `tail` lines so a fresh dashboard shows recent history immediately.
func (c *consoleRing) since(seq int64, tail int) ([]consoleLine, int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]consoleLine, 0, 64)
	if seq <= 0 {
		start := 0
		if tail > 0 && len(c.lines) > tail {
			start = len(c.lines) - tail
		}
		out = append(out, c.lines[start:]...)
		return out, c.seq
	}
	for _, l := range c.lines {
		if l.Seq > seq {
			out = append(out, l)
		}
	}
	return out, c.seq
}

// startConsoleCapture tees os.Stdout+os.Stderr through a pipe into the ring buffer while
// still writing to the real console. Best-effort: on any setup error it leaves the
// console untouched (logging keeps working exactly as before, just without the panel).
func startConsoleCapture() {
	r, w, err := os.Pipe()
	if err != nil {
		return
	}
	orig := os.Stdout
	os.Stdout = w
	os.Stderr = w
	go func() {
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024) // allow long banner lines
		for sc.Scan() {
			line := sc.Text()
			_, _ = orig.WriteString(line + "\n") // keep the journald/terminal copy
			serverConsole.add(line)
		}
		// SAFETY: if the scanner ever stops (read error / a single line over the buffer
		// limit), keep draining the pipe to the real console forever — otherwise a full
		// pipe would BLOCK every future fmt.Print* and hang the bot. The ring just stops
		// getting new lines; logging to journald continues unaffected.
		_, _ = io.Copy(orig, r)
	}()
}

// handleConsole serves the ring as JSON: /api/console?since=<seq>. The dashboard polls
// with the last seq it saw and appends only the new lines.
func handleConsole(w http.ResponseWriter, r *http.Request) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	lines, head := serverConsole.since(since, 400)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"lines": lines, "seq": head})
}
