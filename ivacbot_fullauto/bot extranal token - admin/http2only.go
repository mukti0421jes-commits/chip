package main

// Strict HTTP/2-only client. There is NO HTTP/1.1 fallback: if the server (or
// proxy tunnel) cannot negotiate h2 over TLS-ALPN, the request fails.
//
// Supports: direct, HTTP/HTTPS proxy (CONNECT), and SOCKS5 proxy — all forced
// to HTTP/2. Swap your getHTTPClient / getRoutingClient internals to call
// newH2Client(proxyURL) and you are 100% h2-only.

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
	"golang.org/x/net/proxy"
)

// newH2Client returns an http.Client that speaks ONLY HTTP/2.
// proxyURL: "" for direct, or "http://host:port", "https://host:port",
// "socks5://host:port" (with optional user:pass@).
func newH2Client(proxyURL string) *http.Client {
	tr := &http2.Transport{
		AllowHTTP: false, // never plaintext
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true,
			ServerName:         "api.ivacbd.com",
			NextProtos:         []string{"h2"}, // ALPN: h2 ONLY (no http/1.1)
		},
		DialTLSContext: func(ctx context.Context, network, addr string, cfg *tls.Config) (net.Conn, error) {
			return dialH2(ctx, addr, cfg, proxyURL)
		},
	}
	return &http.Client{
		Transport: tr,
		Timeout:   0,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// dialH2 establishes a TCP (optionally via proxy) + TLS-ALPN-h2 connection.
// It rejects the connection if the negotiated protocol is not "h2".
func dialH2(ctx context.Context, addr string, cfg *tls.Config, proxyURL string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}

	var raw net.Conn
	var err error

	if proxyURL == "" || proxyURL == "none" {
		// Direct TCP
		raw, err = dialer.DialContext(ctx, "tcp", addr)
		if err != nil {
			return nil, err
		}
	} else {
		pu, perr := url.Parse(proxyURL)
		if perr != nil {
			return nil, fmt.Errorf("bad proxy url: %v", perr)
		}
		switch pu.Scheme {
		case "socks5", "socks5h":
			var auth *proxy.Auth
			if pu.User != nil {
				pw, _ := pu.User.Password()
				auth = &proxy.Auth{User: pu.User.Username(), Password: pw}
			}
			sd, derr := proxy.SOCKS5("tcp", pu.Host, auth, dialer)
			if derr != nil {
				return nil, derr
			}
			raw, err = sd.Dial("tcp", addr)
			if err != nil {
				return nil, err
			}
		case "http", "https":
			// HTTP CONNECT tunnel
			raw, err = dialer.DialContext(ctx, "tcp", pu.Host)
			if err != nil {
				return nil, err
			}
			if err = httpConnect(raw, addr, pu); err != nil {
				raw.Close()
				return nil, err
			}
		default:
			return nil, fmt.Errorf("unsupported proxy scheme: %s", pu.Scheme)
		}
	}

	// TLS handshake using a CHROME fingerprint (uTLS) so Cloudflare treats us as
	// a real browser — then require ALPN h2 (strict, no HTTP/1.1 fallback).
	serverName := cfg.ServerName
	if serverName == "" {
		serverName = "api.ivacbd.com"
	}
	uconf := &utls.Config{
		ServerName:         serverName,
		InsecureSkipVerify: cfg.InsecureSkipVerify,
		NextProtos:         []string{"h2"},
	}
	uconn := utls.UClient(raw, uconf, utls.HelloChrome_Auto)
	if err = uconn.Handshake(); err != nil {
		raw.Close()
		return nil, err
	}
	if uconn.ConnectionState().NegotiatedProtocol != "h2" {
		uconn.Close()
		return nil, fmt.Errorf("server did not negotiate HTTP/2 (got %q) — strict h2, no fallback", uconn.ConnectionState().NegotiatedProtocol)
	}
	return uconn, nil
}

// httpConnect performs an HTTP CONNECT handshake through an HTTP(S) proxy.
func httpConnect(conn net.Conn, targetAddr string, pu *url.URL) error {
	req := &http.Request{
		Method: http.MethodConnect,
		URL:    &url.URL{Opaque: targetAddr},
		Host:   targetAddr,
		Header: make(http.Header),
	}
	if pu.User != nil {
		pw, _ := pu.User.Password()
		req.SetBasicAuth(pu.User.Username(), pw)
		req.Header.Set("Proxy-Authorization", req.Header.Get("Authorization"))
		req.Header.Del("Authorization")
	}
	if err := req.Write(conn); err != nil {
		return err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("proxy CONNECT failed: %s", resp.Status)
	}
	return nil
}
