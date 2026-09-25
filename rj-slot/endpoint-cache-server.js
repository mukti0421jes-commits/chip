#!/usr/bin/env node
// endpoint-cache-server.js — serves this folder's .endpoint-cache.json to the RJ SLOT userscript.
//
// Sibling of cipher-server.js (port 8799) and token-relay.js (port 8787). Your existing pipeline
// (runfetch/extract_fetch → .endpoint-cache.json → push-endpoint-cache.js) already writes the cache
// in this folder; this just also exposes it over HTTP so the browser (RJ SLOT) can PULL it.
//
// Usage (Windows / any OS with Node):
//   1. Put this file in the SAME folder as your ".endpoint-cache.json"
//      e.g. C:\Users\Tasnim Jannat\Desktop\autocheck
//   2. Open a terminal in that folder and run:
//         node endpoint-cache-server.js
//      (or: node endpoint-cache-server.js .endpoint-cache.json 8798)
//   3. Leave the window open (it must stay running).
//   4. In RJ SLOT, click A_E — it fetches http://127.0.0.1:8798/endpoint-cache and syncs
//      the endpoints + slot-id + dg-epay id + reserve segment into the live config.
//
// Options:
//   node endpoint-cache-server.js                          -> file ".endpoint-cache.json", port 8798
//   node endpoint-cache-server.js mycache.json             -> custom file name
//   node endpoint-cache-server.js .endpoint-cache.json 9001 -> custom file + port

const http = require('http');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = process.argv[2] || '.endpoint-cache.json';
const PORT = parseInt(process.argv[3], 10) || 8798;

const BASE_DIR = __dirname;
const CACHE_PATH = path.isAbsolute(CACHE_FILE) ? CACHE_FILE : path.join(BASE_DIR, CACHE_FILE);

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'no-store');
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
    // Any path returns the endpoint-cache file (RJ hits /endpoint-cache).
    fs.readFile(CACHE_PATH, 'utf8', (err, data) => {
        cors(res);
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('endpoint-cache not found: ' + CACHE_PATH + '  (run runfetch first)');
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(String(err.message || err));
            }
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(data);
    });
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[endpoint-cache-server] port ${PORT} is already in use. Try: node endpoint-cache-server.js ${CACHE_FILE} 9001`);
    } else {
        console.error('[endpoint-cache-server] error:', err.message);
    }
    process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[endpoint-cache-server] serving '${CACHE_PATH}'`);
    console.log(`[endpoint-cache-server] open URL: http://127.0.0.1:${PORT}/endpoint-cache`);
    console.log('[endpoint-cache-server] keep this window open. Ctrl+C to stop.');
});
