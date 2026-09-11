const { chromium } = require("playwright");

const TARGET_URL = process.argv[2] || "https://appointment.ivacbd.com";

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

  const endpoints = [];

  page.on("request", (req) => {
    const url = req.url();
    const method = req.method();
    const resourceType = req.resourceType();

    if (["xhr", "fetch"].includes(resourceType)) {
      const parsed = new URL(url);
      endpoints.push({
        method,
        url,
        origin: parsed.origin,
        path: parsed.pathname,
        query: parsed.search || null,
        headers: req.headers(),
        postData: req.postData() || null,
      });
      console.log(`[API] ${method} ${url}`);
    }
  });

  page.on("response", async (res) => {
    const req = res.request();
    if (["xhr", "fetch"].includes(req.resourceType())) {
      const status = res.status();
      const contentType = res.headers()["content-type"] || "";
      let body = null;
      try {
        if (contentType.includes("json")) {
          body = await res.json();
        }
      } catch {}
      console.log(`[RES] ${status} ${req.method()} ${req.url()}`);
      if (body) {
        console.log(`      ${JSON.stringify(body).slice(0, 200)}`);
      }
    }
  });

  console.log(`\nLoading: ${TARGET_URL}\n`);

  try {
    await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 30000 });
  } catch (e) {
    console.log(`Page load note: ${e.message.split("\n")[0]}`);
  }

  // wait a bit more for lazy-loaded API calls
  await page.waitForTimeout(5000);

  console.log(`\n========== SUMMARY ==========`);
  console.log(`Total API calls intercepted: ${endpoints.length}\n`);

  const unique = new Map();
  for (const ep of endpoints) {
    const key = `${ep.method} ${ep.origin}${ep.path}`;
    if (!unique.has(key)) {
      unique.set(key, ep);
    }
  }

  for (const [key, ep] of unique) {
    console.log(`${key}`);
    if (ep.query) console.log(`  query: ${ep.query}`);
    if (ep.postData) console.log(`  body:  ${ep.postData.slice(0, 150)}`);
  }

  await browser.close();
})();
