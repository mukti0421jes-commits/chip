// Multi-bundle test harness: runs flow-capture.js against every _b_*.js bundle
// and reports which steps each bundle completes.
//
//   node test-all-bundles.js [bundleName ...]

'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const BASE_PORT = 9200;

const bundles = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(DIR).filter(f => /^_b_.*\.js$/.test(f)).map(f => f.replace(/^_b_|\.js$/g, ''));

function startServer(port, bundleFile) {
  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    if (urlPath === '/' || urlPath.startsWith('/appointment') || urlPath === '/signin' || urlPath.startsWith('/verify')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>IVAC</title></head><body><div id="root"></div><script type="module" src="/${bundleFile}"></script></body></html>`);
    }
    const fp = path.join(DIR, urlPath);
    if (!fp.startsWith(DIR)) { res.writeHead(403); return res.end('no'); }
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(fp);
      const mime = { '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.html': 'text/html' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

(async () => {
  const results = [];
  for (let i = 0; i < bundles.length; i++) {
    const name = bundles[i];
    const bundleFile = `_b_${name}.js`;
    if (!fs.existsSync(path.join(DIR, bundleFile))) { console.log(`skip ${name} (missing)`); continue; }
    const port = BASE_PORT + i;
    const server = await startServer(port, bundleFile);

    const cfgPath = path.join(DIR, `_cfg_${name}.json`);
    const outDir = path.join(DIR, `_out_${name}`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({
      url: `http://localhost:${port}/`,
      hostOrigin: `http://localhost:${port}`,
      headless: true,
      walkTimeoutMs: 60000,
      runMs: 70000,
      bundlePath: path.join(DIR, bundleFile),
      out: outDir,
    }));

    console.log(`\n${'='.repeat(60)}\n▶ ${name}  (port ${port})\n${'='.repeat(60)}`);
    const r = spawnSync('node', [path.join(DIR, 'flow-capture.js'), cfgPath], {
      encoding: 'utf8', timeout: 180000, cwd: DIR,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    process.stdout.write(out.split('\n').filter(l =>
      /✓|→|❌|captured|extracted|error|stuck|complete/i.test(l)
    ).join('\n') + '\n');

    let flow = [];
    try { flow = JSON.parse(fs.readFileSync(path.join(outDir, 'flow.json'), 'utf8')); } catch (_) {}
    const calls = Array.isArray(flow) ? flow : (flow.calls || []);
    const urls = calls.map(c => c.url || '');
    fs.appendFileSync(path.join(DIR, '_progress.log'),
      `${name}: ${urls.length} calls | pageErrors=${(out.match(/page-error/g) || []).length}\n` +
      urls.map(u => '   ' + u.replace(/^https?:\/\/[^/]+/, '')).join('\n') + '\n');
    results.push({
      bundle: name,
      total: urls.length,
      signin: urls.some(u => /sign-?in/i.test(u)),
      otp: urls.some(u => /otp\/verify/i.test(u)),
      overview: urls.some(u => /over-?view/i.test(u)),
      bookingCfg: urls.some(u => /get-booking-config/i.test(u)),
      reserve: urls.some(u => /reserve-slot/i.test(u)),
      payAmount: urls.some(u => /payment-amount/i.test(u)),
      payInit: urls.some(u => /\/payment\/.*initiate/i.test(u)),
    });

    server.close();
  }

  console.log(`\n\n${'#'.repeat(72)}\n# SUMMARY\n${'#'.repeat(72)}`);
  const cols = ['signin', 'otp', 'overview', 'bookingCfg', 'reserve', 'payAmount', 'payInit'];
  console.log('bundle'.padEnd(12) + 'calls'.padEnd(7) + cols.map(c => c.slice(0, 9).padEnd(11)).join(''));
  for (const r of results) {
    console.log(r.bundle.padEnd(12) + String(r.total).padEnd(7) + cols.map(c => (r[c] ? '  ✓' : '  ✗').padEnd(11)).join(''));
  }
  const full = results.filter(r => cols.every(c => r[c]));
  console.log(`\n${full.length}/${results.length} bundles completed the full flow.`);
})();
