#!/usr/bin/env python3
# cipher-server.py — serves the local "cipher" file to the IVAC userscript.
#
# Usage (Windows):
#   1. Put this file in the SAME folder as your "cipher" file
#      e.g. C:\Users\mital\Desktop\autocheck\
#   2. Double-click it, OR run in a terminal:
#         python cipher-server.py
#   3. Leave the window open (it must stay running).
#   4. In the IVAC panel, click the 🔑 button — it fetches
#      http://localhost:8799/cipher, pastes it into the encryption box,
#      saves it, and turns Encryption ON automatically.
#
# Notes:
#   - Default file name is "cipher" (no extension). Override with: python cipher-server.py mycipher.js
#   - Default port is 8799. Override with: python cipher-server.py cipher 9000
#   - CORS is open so the browser/userscript can read it.

import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CIPHER_FILE = sys.argv[1] if len(sys.argv) > 1 else "cipher.js"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8799

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CIPHER_PATH = CIPHER_FILE if os.path.isabs(CIPHER_FILE) else os.path.join(BASE_DIR, CIPHER_FILE)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cache-Control", "no-store")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        # Any path returns the cipher file (button hits /cipher).
        try:
            with open(CIPHER_PATH, "r", encoding="utf-8") as f:
                data = f.read().encode("utf-8")
        except FileNotFoundError:
            self.send_response(404)
            self._cors()
            self.end_headers()
            self.wfile.write(b"cipher file not found: " + CIPHER_PATH.encode("utf-8"))
            return
        except Exception as e:
            self.send_response(500)
            self._cors()
            self.end_headers()
            self.wfile.write(str(e).encode("utf-8"))
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass  # quiet


if __name__ == "__main__":
    print(f"[cipher-server] serving '{CIPHER_PATH}'")
    print(f"[cipher-server] open URL: http://localhost:{PORT}/cipher")
    print("[cipher-server] keep this window open. Ctrl+C to stop.")
    try:
        ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\n[cipher-server] stopped.")
