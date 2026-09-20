/* RJ PDF — Edit Invoice: detect IVAC payment-invoice fields, edit, preview, download (vector) */
import * as pdfjsLib from './lib/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const $ = (id) => document.getElementById(id);
let srcBytes = null, page = null, styles = {}, lines = [], zoom = 1;
let fields = []; // {key, label, value, orig, x, yb, fh, w, serif}

$('home').onclick = () => { location.href = chrome.runtime.getURL('docgen.html'); };
function status(m, ok = true) { $('status').textContent = m; $('status').className = ok ? 'ok' : 'err'; }
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// লেবেল → key + বাংলা টাইটেল (invoice-এর লাইন থেকে ভ্যালু বের করি)
const SPEC = [
  ['name', 'নাম (Name)', /^name$/],
  ['webfile', 'Web File No', /^webfileno$/],
  ['visatype', 'Visa Type', /^visatype$/],
  ['mission', 'Mission', /^mission$/],
  ['center', 'Center', /^cent(er|re)$/],
  ['paymentfor', 'Payment For', /^paymentfor$/],
  ['paymenttype', 'Payment Type', /^paymenttype$/],
  ['fee', 'Fee (Collected by SBI)', /^fee.*statebankofindia|^fee.*sbi|^fee$/],
  ['gateway', 'Payment Gateway Convenience Fee', /gatewayconveniencefee/],
  ['paid', 'Paid Amount', /^paidamount$/],
  ['appt', 'Appointment Date', /^appointmentdate$/],
];

async function loadPdf(file) {
  srcBytes = new Uint8Array(await file.arrayBuffer()).slice(0);
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(srcBytes) }).promise;
  page = await doc.getPage(1);
  const tc = await page.getTextContent(); styles = tc.styles || {};
  buildLines(tc.items);
  detectFields();
  $('empty').classList.add('hidden'); $('editor').classList.remove('hidden');
  renderForm(); await renderPreview();
  status('✔ পড়া হয়েছে — তথ্য এডিট করে "প্রিভিউ"/"Save"।');
}

// একই y-লাইনে item গুলো একসাথে (scale-1 PDF coords: transform[4]=x, [5]=baseline)
function buildLines(items) {
  const rows = new Map();
  items.forEach((it) => {
    if (!it.str || !it.str.trim()) return;
    const y = Math.round(it.transform[5]);
    let key = null; for (const k of rows.keys()) if (Math.abs(k - y) <= 2) { key = k; break; }
    if (key === null) { key = y; rows.set(key, []); }
    rows.get(key).push({ str: it.str, x: it.transform[4], yb: it.transform[5], fh: Math.hypot(it.transform[2], it.transform[3]), w: it.width || 0, fontName: it.fontName });
  });
  lines = [...rows.entries()].map(([y, its]) => ({ y, items: its.sort((a, b) => a.x - b.x) })).sort((a, b) => b.y - a.y);
}
function serifOf(fontName) { const s = styles[fontName]; const fam = (s && s.fontFamily) || ''; return !/sans/i.test(fam) && /serif|times|roman/i.test((fontName || '') + fam); }

function detectFields() {
  fields = [];
  for (const [key, label, re] of SPEC) {
    let found = null;
    for (const ln of lines) {
      // লাইনের শুরু থেকে item জোড়া দিয়ে লেবেল খুঁজি
      let acc = '', splitAt = -1;
      for (let i = 0; i < ln.items.length; i++) {
        acc += norm(ln.items[i].str);
        if (re.test(acc)) { splitAt = i; break; }
        if (acc.length > 40) break;
      }
      if (splitAt >= 0) {
        const val = ln.items.slice(splitAt + 1);
        const first = val[0] || ln.items[splitAt];
        const last = val[val.length - 1] || first;
        const x = val.length ? first.x : (ln.items[splitAt].x + ln.items[splitAt].w);
        const w = val.length ? (last.x + last.w - x) : 200;
        found = { key, label, value: val.map((v) => v.str).join('').trim(), orig: '', x, yb: first.yb, fh: first.fh || ln.items[splitAt].fh, w: Math.max(w, 120), serif: serifOf((val[0] || ln.items[splitAt]).fontName) };
        break;
      }
    }
    if (found) { found.orig = found.value; fields.push(found); }
  }
  // Barcode No — শুধু সংখ্যার একটি লাইন (৬-১৪ ডিজিট), অন্য কোনো লেবেলের ভ্যালু নয়
  for (const ln of lines) {
    const s = ln.items.map((i) => i.str).join('').trim();
    if (/^\d{6,14}$/.test(s) && !fields.some((f) => f.value === s)) {
      const first = ln.items[0], last = ln.items[ln.items.length - 1];
      fields.unshift({ key: 'barcode', label: 'বারকোড নম্বর (Barcode No)', value: s, orig: s, x: first.x, yb: first.yb, fh: first.fh, w: Math.max(last.x + last.w - first.x, 120), serif: serifOf(first.fontName) });
      break;
    }
  }
}

function renderForm() {
  const box = $('fields'); box.innerHTML = '';
  if (!fields.length) { box.innerHTML = '<div class="note err" style="background:none;border:none">কোনো পরিচিত ফিল্ড ধরা যায়নি — অন্য ইনভয়েস দিন বা আমাকে নমুনা পাঠান।</div>'; return; }
  fields.forEach((f, i) => {
    const d = document.createElement('div'); d.className = 'fld';
    d.innerHTML = `<label><span class="dot"></span> ${f.label}</label>`;
    const inp = document.createElement('input'); inp.value = f.value;
    inp.oninput = () => { f.value = inp.value; };
    d.appendChild(inp); box.appendChild(d);
  });
}

async function renderPreview(baked) {
  const box = $('pages'); box.innerHTML = '';
  $('zVal').textContent = Math.round(zoom * 100) + '%';
  const vp = page.getViewport({ scale: zoom });
  const RES = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
  const num = document.createElement('div'); num.className = 'pagenum'; num.textContent = 'PAGE 1 / 1'; box.appendChild(num);
  const wrap = document.createElement('div'); wrap.className = 'page'; wrap.style.width = vp.width + 'px'; wrap.style.height = vp.height + 'px';
  const canvas = document.createElement('canvas'); canvas.width = Math.ceil(vp.width * RES); canvas.height = Math.ceil(vp.height * RES);
  canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp, transform: [RES, 0, 0, RES, 0, 0] }).promise;
  ctx.setTransform(RES, 0, 0, RES, 0, 0);
  if (baked) {
    // scale-1 PDF coords (y-up) → viewport (y-down) at current zoom
    fields.forEach((f) => {
      if (f.value === f.orig) return;
      const vx = f.x * zoom, vy = (page.getViewport({ scale: 1 }).height - f.yb) * zoom, fh = f.fh * zoom;
      ctx.fillStyle = '#fff'; ctx.fillRect(vx - 1, vy - fh - 1, f.w * zoom + 4, fh + 5);
      ctx.fillStyle = '#000'; ctx.textBaseline = 'alphabetic'; ctx.font = (f.serif ? '' : '') + (fh * 0.92) + 'px ' + (f.serif ? 'serif' : 'sans-serif');
      ctx.fillText(f.value, vx, vy);
    });
  }
  wrap.appendChild(canvas); box.appendChild(wrap);
}

$('preview').onclick = () => renderPreview(true);
$('revert').onclick = () => { fields.forEach((f) => f.value = f.orig); renderForm(); renderPreview(false); status('↺ আসল তথ্য ফিরিয়ে আনা হয়েছে।'); };
$('zIn').onclick = () => { zoom = Math.min(3, +(zoom + 0.15).toFixed(2)); renderPreview(true); };
$('zOut').onclick = () => { zoom = Math.max(0.5, +(zoom - 0.15).toFixed(2)); renderPreview(true); };
$('other').onclick = () => { $('editor').classList.add('hidden'); $('empty').classList.remove('hidden'); };

function ansi(s) { return String(s || '').replace(/[^\x20-\x7E\xA0-\xFF]/g, ''); }
function saveBytes(bytes, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
$('save').onclick = async () => {
  status('⏳ ফাইল তৈরি হচ্ছে...');
  try {
    const changed = fields.filter((f) => f.value !== f.orig);
    if (!changed.length) { saveBytes(srcBytes, 'RJ_invoice.pdf'); status('✔ ডাউনলোড হয়েছে (অপরিবর্তিত — সাইজ একই)।'); return; }
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const out = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
    const needSerif = changed.some((f) => f.serif), needSans = changed.some((f) => !f.serif);
    const helv = needSans ? await out.embedFont(StandardFonts.Helvetica) : null;
    const times = needSerif ? await out.embedFont(StandardFonts.TimesRoman) : null;
    const p = out.getPages()[0];
    changed.forEach((f) => {
      p.drawRectangle({ x: f.x - 1, y: f.yb - f.fh * 0.3, width: f.w + 4, height: f.fh * 1.35, color: rgb(1, 1, 1) });
      try { p.drawText(ansi(f.value), { x: f.x, y: f.yb, size: f.fh * 0.92, font: f.serif ? times : helv, color: rgb(0, 0, 0) }); } catch (_) {}
    });
    const bytes = await out.save({ useObjectStreams: true });
    saveBytes(bytes, 'RJ_invoice.pdf');
    status('✔ ডাউনলোড হয়েছে — সাইজ প্রায় একই, text layer অক্ষত।');
  } catch (e) { console.error(e); status('✘ ' + e.message, false); }
};

(function () {
  const drop = $('drop'), inp = $('file');
  drop.onclick = () => inp.click();
  inp.onchange = () => { if (inp.files[0]) loadPdf(inp.files[0]); };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) loadPdf(f); });
})();
