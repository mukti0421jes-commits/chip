#!/usr/bin/env node
// cipher-server.js — serves the local "cipher" file to the IVAC userscript.
//
// Usage (Windows / any OS with Node installed):
//   1. Put this file in the SAME folder as your "cipher" file
//      e.g. C:\Users\mital\Desktop\autocheck\
//   2. Open a terminal in that folder and run:
//         node cipher-server.js
//      (or just double-click if .js is associated with Node)
//   3. Leave the window open (it must stay running).
//   4. In the IVAC panel, click the 🔑 button — it fetches
//      http://localhost:8799/cipher, pastes it into the encryption box,
//      saves it, and turns Encryption ON automatically.
//
// Options:
//   node cipher-server.js                 -> file "cipher", port 8799
//   node cipher-server.js mycipher.js     -> custom file name
//   node cipher-server.js cipher 9000     -> custom file + port

const http = require('http');
const fs = require('fs');
const path = require('path');

const CIPHER_FILE = process.argv[2] || 'cipher.js';
const PORT = parseInt(process.argv[3], 10) || 8799;

const BASE_DIR = __dirname;
const CIPHER_PATH = path.isAbsolute(CIPHER_FILE) ? CIPHER_FILE : path.join(BASE_DIR, CIPHER_FILE);

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'no-store');
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        cors(res);
        res.writeHead(204);
        res.end();
        return;
    }
    // Any path returns the cipher file (button hits /cipher).
    fs.readFile(CIPHER_PATH, 'utf8', (err, data) => {
        cors(res);
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('cipher file not found: ' + CIPHER_PATH);
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(String(err.message || err));
            }
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(data);
    });
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[cipher-server] port ${PORT} is already in use. Try: node cipher-server.js ${CIPHER_FILE} 9000`);
    } else {
        console.error('[cipher-server] error:', err.message);
    }
    process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[cipher-server] serving '${CIPHER_PATH}'`);
    console.log(`[cipher-server] open URL: http://localhost:${PORT}/cipher`);
    console.log('[cipher-server] keep this window open. Ctrl+C to stop.');
});
