const { chromium } = require("playwright");

const TARGET_URL = process.argv[2] || "https://appointment.ivacbd.com";

const URL_PATTERNS = [
  /https?:\/\/[^\s"'`<>{}()\[\]\\]+/g,
  /['"`](\/api\/[^\s"'`<>{}()\[\]\\]*)/g,
  /['"`](\/v[0-9]+\/[^\s"'`<>{}()\[\]\\]*)/g,
  /['"`](\/graphql[^\s"'`<>{}()\[\]\\]*)/g,
  /['"`](\/rest\/[^\s"'`<>{}()\[\]\\]*)/g,
  /['"`](\/auth\/[^\s"'`<>{}()\[\]\\]*)/g,
  /['"`](\/login[^\s"'`<>{}()\[\]\\]*)/g,
  /['"`](\/register[^\s"'`<>{}()\[\]\\]*)/g,
  /['"`](\/token[^\s"'`<>{}()\[\]\\]*)/g,
  /['"`](\/oauth[^\s"'`<>{}()\[\]\\]*)/g,
  /['"`](\/callback[^\s"'`<>{}()\[\]\\]*)/g,
  /['"`](\/webhook[^\s"'`<>{}()\[\]\\]*)/g,
  /['"`](\/socket[^\s"'`<>{}()\[\]\\]*)/g,
  /['"`](\/ws[^\s"'`<>{}()\[\]\\]*)/g,
];

const FETCH_PATTERNS = [
  /fetch\s*\(\s*['"`]([^"'`]+)['"`]/g,
  /axios\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^"'`]+)['"`]/g,
  /axios\s*\(\s*\{[^}]*url\s*:\s*['"`]([^"'`]+)['"`]/g,
  /\$\.ajax\s*\(\s*\{[^}]*url\s*:\s*['"`]([^"'`]+)['"`]/g,
  /\.open\s*\(\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`]\s*,\s*['"`]([^"'`]+)['"`]/g,
  /XMLHttpRequest[^;]*\.open\s*\([^,]*,\s*['"`]([^"'`]+)['"`]/g,
  /baseURL\s*[:=]\s*['"`]([^"'`]+)['"`]/g,
  /endpoint\s*[:=]\s*['"`]([^"'`]+)['"`]/g,
  /apiUrl\s*[:=]\s*['"`]([^"'`]+)['"`]/g,
  /API_URL\s*[:=]\s*['"`]([^"'`]+)['"`]/g,
  /BASE_URL\s*[:=]\s*['"`]([^"'`]+)['"`]/g,
  /SERVER_URL\s*[:=]\s*['"`]([^"'`]+)['"`]/g,
  /host\s*[:=]\s*['"`](https?:\/\/[^"'`]+)['"`]/g,
];

function isApiEndpoint(url) {
  const skip = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|html|htm)(\?|$)/i;
  if (skip.test(url)) return false;
  const indicators = [
    "/api/", "/v1/", "/v2/", "/v3/", "/graphql", "/rest/",
    "/auth/", "/login", "/token", "/oauth", "/callback",
    "/webhook", "/socket", "/ws", "/reserve", "/appointment",
    "/booking", "/slot", "/captcha", "/verify", "/submit",
    "/register", "/signup", "/session", "/user", "/account",
    "/process", "/check", "/status", "/config", "/setting",
  ];
  const lower = url.toLowerCase();
  return indicators.some((ind) => lower.includes(ind)) || /https?:\/\/api\./i.test(url);
}

function extractFromBundle(code, sourceUrl) {
  const found = new Set();

  for (const pattern of [...URL_PATTERNS, ...FETCH_PATTERNS]) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(code)) !== null) {
      const url = match[2] || match[1];
      if (url && url.length > 3 && url.length < 500) {
        found.add(url);
      }
    }
  }

  return [...found];
}

(async () => {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;

  const launchOpts = {
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    headless: true,
    args: ["--no-sandbox"],
  };
  if (proxyUrl) {
    launchOpts.proxy = { server: proxyUrl };
  }

  const browser = await chromium.launch(launchOpts);

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  const networkEndpoints = [];
  const bundleEndpoints = new Map();
  const bundles = [];

  // 1. Intercept network requests (API calls)
  page.on("request", (req) => {
    const url = req.url();
    const method = req.method();
    const resourceType = req.resourceType();

    if (["xhr", "fetch"].includes(resourceType)) {
      const parsed = new URL(url);
      networkEndpoints.push({
        method,
        url,
        origin: parsed.origin,
        path: parsed.pathname,
        query: parsed.search || null,
        headers: req.headers(),
        postData: req.postData() || null,
      });
    }
  });

  // 2. Capture JS bundle content
  page.on("response", async (res) => {
    const req = res.request();
    const url = req.url();
    const contentType = res.headers()["content-type"] || "";

    if (
      req.resourceType() === "script" ||
      contentType.includes("javascript")
    ) {
      try {
        const body = await res.text();
        if (body.length > 0) {
          bundles.push({ url, size: body.length, content: body });
        }
      } catch {}
    }
  });

  console.log(`\nLoading: ${TARGET_URL}\n`);

  try {
    await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 30000 });
  } catch (e) {
    console.log(`Page load note: ${e.message.split("\n")[0]}`);
  }

  await page.waitForTimeout(5000);

  // 3. Also grab inline scripts from the page
  try {
    const inlineScripts = await page.evaluate(() => {
      return [...document.querySelectorAll("script:not([src])")]
        .map((s) => s.textContent)
        .filter((t) => t.length > 0);
    });
    for (const code of inlineScripts) {
      bundles.push({ url: "(inline)", size: code.length, content: code });
    }
  } catch {}

  // 4. Extract endpoints from all bundles
  for (const bundle of bundles) {
    const urls = extractFromBundle(bundle.content, bundle.url);
    for (const u of urls) {
      if (!bundleEndpoints.has(u)) {
        bundleEndpoints.set(u, bundle.url);
      }
    }
  }

  // === OUTPUT ===

  console.log("========== JS BUNDLES LOADED ==========");
  for (const b of bundles) {
    console.log(`  ${(b.size / 1024).toFixed(1)}KB  ${b.url}`);
  }

  console.log(`\n========== NETWORK API CALLS (${networkEndpoints.length}) ==========`);
  const uniqueNet = new Map();
  for (const ep of networkEndpoints) {
    const key = `${ep.method} ${ep.origin}${ep.path}`;
    if (!uniqueNet.has(key)) uniqueNet.set(key, ep);
  }
  for (const [key, ep] of uniqueNet) {
    console.log(`  ${key}`);
    if (ep.query) console.log(`    query: ${ep.query}`);
    if (ep.postData) console.log(`    body:  ${ep.postData.slice(0, 150)}`);
  }

  console.log(`\n========== ENDPOINTS FROM BUNDLES ==========`);
  const apiUrls = [...bundleEndpoints.entries()]
    .filter(([url]) => isApiEndpoint(url))
    .sort((a, b) => a[0].localeCompare(b[0]));

  console.log(`  API endpoints found: ${apiUrls.length}\n`);
  for (const [url, source] of apiUrls) {
    console.log(`  ${url}`);
    console.log(`    from: ${source}`);
  }

  console.log(`\n========== ALL URLs FROM BUNDLES ==========`);
  const allUrls = [...bundleEndpoints.keys()].sort();
  console.log(`  Total URLs found: ${allUrls.length}\n`);
  for (const url of allUrls) {
    console.log(`  ${url}`);
  }

  await browser.close();
})();
