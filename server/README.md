# RJ Automation — Backend (pay-as-you-go)

Pure Node.js (no dependencies). Accounts, balance, per-use charge,
manual bKash/Nagad recharge + admin approval, and a server-side OCR proxy.

## Run
1. `cp config.sample.json config.json` and edit:
   - `jwtSecret` (long random), `pricePerUse`, `minRecharge`
   - `payment.bkash/nagad/rocket` (your numbers)
   - `ocrSpaceKey` (free key from ocr.space/ocrapi)
   - `admin.email` / `admin.password`
2. Put the extension zip at `public/download/rj-automation.zip`
3. `node server.js`  → opens on config `port` (or env PORT)

## Deploy on Render (free)
- New Web Service → connect repo (root dir: `server`)
- Build command: (none)  · Start command: `node server.js`
- Env vars: JWT_SECRET, OCR_SPACE_KEY, ADMIN_EMAIL, ADMIN_PASSWORD
- The public URL Render gives is your share link. `/admin` = admin panel.

## Endpoints
POST /api/register · /api/login · GET /api/me · POST /api/charge ·
POST /api/recharge · GET /api/history · POST /api/ocr ·
GET /api/admin/recharges · POST /api/admin/approve · /api/admin/reject
