# RJ SLOT — Real Proxy Setup

A Tampermonkey userscript **cannot** set a browser/network proxy on its own
(`fetch` / `GM_xmlhttpRequest` have no proxy option). So "Connect" alone never
changed your IP. To actually route through a proxy, run the tiny local relay
below; the userscript then sends its booking requests to the relay, which
forwards them through your selected proxy.

## One-time setup
```
cd userscript
npm init -y
npm i node-fetch@2 proxy-agent
```

## Run (keep it running while booking)
```
node proxy-relay.js          # listens on http://127.0.0.1:8781
```

## Use
1. In the userscript Proxy tab, Add your proxy (host:port[:user:pass]) and pick a scheme.
2. Click **Connect**. The script asks the relay for the egress IP and shows
   `🌍 Proxy egress IP: x.x.x.x` in the status log — that confirms it works.
3. All booking API calls (signin/verify/reserve/book/initiate) now go through the proxy.

Notes
- Supports HTTP / HTTPS / SOCKS4 / SOCKS5 (with auth).
- File uploads (multipart) and a couple of helper calls still go direct.
- If you see `⚠ Relay offline`, the relay isn't running on port 8781.
