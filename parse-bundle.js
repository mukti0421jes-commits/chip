const fs = require("fs");

const filePath = process.argv[2];
if (!filePath) {
  console.log("Usage: node parse-bundle.js <bundle.js>");
  process.exit(1);
}

const code = fs.readFileSync(filePath, "utf-8");
console.log(`Bundle size: ${(code.length / 1024).toFixed(1)}KB\n`);

const URL_PATTERNS = [
  /https?:\/\/[^\s"'`<>{}()\[\]\\,;]+/g,
];

const PATH_PATTERNS = [
  /['"`](\/api\/[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/v[0-9]+\/[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/graphql[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/rest\/[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/auth\/[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/login[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/register[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/token[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/oauth[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/callback[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/webhook[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/socket[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/ws[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/reserve[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/appointment[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/booking[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/slot[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/captcha[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/verify[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/submit[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/session[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/user[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/process[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/check[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/status[^\s"'`<>{}()\[\]\\,;]*)/g,
  /['"`](\/config[^\s"'`<>{}()\[\]\\,;]*)/g,
];

const FETCH_PATTERNS = [
  /fetch\s*\(\s*['"`]([^"'`]+)['"`]/g,
  /axios\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"`]([^"'`]+)['"`]/g,
  /axios\s*\(\s*\{[^}]*url\s*:\s*['"`]([^"'`]+)['"`]/g,
  /\$\.ajax\s*\(\s*\{[^}]*url\s*:\s*['"`]([^"'`]+)['"`]/g,
  /\.open\s*\(\s*['"`](?:GET|POST|PUT|DELETE|PATCH)['"`]\s*,\s*['"`]([^"'`]+)['"`]/g,
  /baseURL\s*[:=]\s*['"`]([^"'`]+)['"`]/g,
  /endpoint\s*[:=]\s*['"`]([^"'`]+)['"`]/g,
  /apiUrl\s*[:=]\s*['"`]([^"'`]+)['"`]/g,
  /API_URL\s*[:=]\s*['"`]([^"'`]+)['"`]/g,
  /BASE_URL\s*[:=]\s*['"`]([^"'`]+)['"`]/g,
  /SERVER_URL\s*[:=]\s*['"`]([^"'`]+)['"`]/g,
  /host\s*[:=]\s*['"`](https?:\/\/[^"'`]+)['"`]/g,
  /url\s*[:=]\s*['"`](https?:\/\/[^"'`]+)['"`]/g,
  /\.post\s*\(\s*['"`]([^"'`]+)['"`]/g,
  /\.get\s*\(\s*['"`]([^"'`]+)['"`]/g,
  /\.put\s*\(\s*['"`]([^"'`]+)['"`]/g,
  /\.delete\s*\(\s*['"`]([^"'`]+)['"`]/g,
];

const allUrls = new Set();

function extract(patterns) {
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(code)) !== null) {
      const url = match[2] || match[1];
      if (url && url.length > 3 && url.length < 500) {
        allUrls.add(url.replace(/['"`]+$/g, ""));
      }
    }
  }
}

extract(URL_PATTERNS);
extract(PATH_PATTERNS);
extract(FETCH_PATTERNS);

const skip = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|html|htm|md|txt|xml|json)(\?|$)/i;
const cdnSkip = /fonts\.googleapis|cdnjs|jsdelivr|unpkg|googleapis\.com\/css|fontawesome|bootstrapcdn/i;

const apiUrls = [...allUrls]
  .filter((u) => !skip.test(u) && !cdnSkip.test(u))
  .sort();

const staticUrls = [...allUrls]
  .filter((u) => skip.test(u) || cdnSkip.test(u))
  .sort();

console.log(`========== API / ENDPOINTS (${apiUrls.length}) ==========\n`);
for (const u of apiUrls) {
  console.log(`  ${u}`);
}

console.log(`\n========== STATIC / CDN (${staticUrls.length}) ==========\n`);
for (const u of staticUrls) {
  console.log(`  ${u}`);
}

console.log(`\n========== TOTAL ==========`);
console.log(`  API/Endpoints: ${apiUrls.length}`);
console.log(`  Static/CDN:    ${staticUrls.length}`);
console.log(`  Total unique:  ${allUrls.size}`);
