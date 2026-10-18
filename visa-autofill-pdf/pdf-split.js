/* RJ PDF — Split: pick pages (thumbnails/range) → one combined PDF or each page separately */
import * as pdfjsLib from './lib/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const $ = (id) => document.getElementById(id);
let srcBytes = null, doc = null, nPages = 0, sel = new Set(), baseName = 'file';

$('home').onclick = () => { location.href = chrome.runtime.getURL('docgen.html'); };
function status(m, ok = true) { $('status').textContent = m; $('status').className = ok ? 'ok' : 'err'; }
function saveBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }

async function loadPdf(file) {
  baseName = file.name.replace(/\.pdf$/i, '');
  srcBytes = new Uint8Array(await file.arrayBuffer()).slice(0);
  doc = await pdfjsLib.getDocument({ data: new Uint8Array(srcBytes) }).promise;
  nPages = doc.numPages; sel = new Set();
  $('empty').classList.add('hidden'); $('loaded').classList.remove('hidden');
  $('fname').textContent = file.name; $('pcount').textContent = nPages + ' পেজ'; $('totCount').textContent = nPages;
  updateCount();
  const box = $('thumbs'); box.innerHTML = '';
  for (let i = 1; i <= nPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 0.4 });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const t = document.createElement('div'); t.className = 'thumb'; t.dataset.p = i;
    t.innerHTML = '<div class="lab">পেজ ' + i + '</div><div class="chk">✓</div>';
    t.insertBefore(c, t.firstChild);
    t.onclick = () => { if (sel.has(i)) sel.delete(i); else sel.add(i); t.classList.toggle('sel', sel.has(i)); updateCount(); };
    box.appendChild(t);
  }
  status('✔ লোড হয়েছে — পেজে ক্লিক করে নির্বাচন করুন।');
}
function updateCount() { $('selCount').textContent = sel.size; }
function refreshThumbs() { $('thumbs').querySelectorAll('.thumb').forEach((t) => t.classList.toggle('sel', sel.has(+t.dataset.p))); updateCount(); }

$('selAll').onclick = () => { sel = new Set(Array.from({ length: nPages }, (_, i) => i + 1)); refreshThumbs(); };
$('cancel').onclick = () => { sel = new Set(); refreshThumbs(); };
$('other').onclick = () => { $('loaded').classList.add('hidden'); $('empty').classList.remove('hidden'); };

$('applyRange').onclick = () => {
  const txt = $('range').value.trim(); if (!txt) { status('রেঞ্জ লিখুন, যেমন 1-3, 5, 8', false); return; }
  const s = new Set();
  txt.split(',').forEach((part) => {
    const m = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) { for (let i = +m[1]; i <= +m[2]; i++) if (i >= 1 && i <= nPages) s.add(i); }
    else { const n = parseInt(part.trim(), 10); if (n >= 1 && n <= nPages) s.add(n); }
  });
  sel = s; refreshThumbs(); status('✔ ' + sel.size + ' পেজ নির্বাচিত।');
};

function selectedSorted() { return [...sel].sort((a, b) => a - b); }

$('oneFile').onclick = async () => {
  const pages = selectedSorted(); if (!pages.length) { status('আগে পেজ নির্বাচন করুন।', false); return; }
  status('⏳ তৈরি হচ্ছে...');
  try {
    const { PDFDocument } = window.PDFLib;
    const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, pages.map((p) => p - 1));
    copied.forEach((pg) => out.addPage(pg));
    const bytes = await out.save();
    saveBlob(new Blob([bytes], { type: 'application/pdf' }), baseName + '_split.pdf');
    status('✔ ডাউনলোড হয়েছে (' + pages.length + ' পেজ)।');
  } catch (e) { console.error(e); status('✘ ' + e.message, false); }
};

$('eachFile').onclick = async () => {
  const pages = selectedSorted(); if (!pages.length) { status('আগে পেজ নির্বাচন করুন।', false); return; }
  status('⏳ প্রতিটি পেজ আলাদা করা হচ্ছে...');
  try {
    const { PDFDocument } = window.PDFLib;
    const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
    for (const p of pages) {
      const out = await PDFDocument.create();
      const [pg] = await out.copyPages(src, [p - 1]); out.addPage(pg);
      const bytes = await out.save();
      saveBlob(new Blob([bytes], { type: 'application/pdf' }), baseName + '_page' + p + '.pdf');
      await new Promise((r) => setTimeout(r, 250)); // ব্রাউজারকে ডাউনলোড সামলাতে সময়
    }
    status('✔ ' + pages.length + 'টি আলাদা ফাইল ডাউনলোড হয়েছে।');
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
