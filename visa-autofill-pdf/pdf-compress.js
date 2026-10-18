/* RJ PDF — Reduce Size (rasterize pages to JPEG at a quality/scale that hits the target) */
import * as pdfjsLib from './lib/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const $ = (id) => document.getElementById(id);
const kb = (b) => Math.round(b / 1024) + ' KB';
let files = []; // {name, buf, size, done, outBlob}

$('home').onclick = () => { location.href = chrome.runtime.getURL('docgen.html'); };

function refresh() {
  $('empty').classList.toggle('hidden', files.length > 0);
  $('loaded').classList.toggle('hidden', files.length === 0);
  $('stFiles').textContent = files.length;
  $('stSize').textContent = kb(files.reduce((a, f) => a + f.size, 0));
  $('stDone').textContent = files.filter((f) => f.done).length;
  const list = $('list'); list.innerHTML = '';
  files.forEach((f, i) => {
    const row = document.createElement('div'); row.className = 'filerow';
    row.innerHTML = `<div class="fi">📄</div><div><div class="nm">${f.name}</div><div class="meta">${kb(f.size)}${f.pages ? ' · ' + f.pages + ' পেজ' : ''}${f.done ? ' · <b style="color:var(--brand)">✔ ' + kb(f.outSize) + '</b>' : ''}</div></div>`;
    const right = document.createElement('div'); right.style.marginLeft = 'auto'; right.style.display = 'flex'; right.style.gap = '6px';
    if (f.done) { const dl = document.createElement('button'); dl.className = 'btn-soft'; dl.textContent = '↓ ডাউনলোড'; dl.onclick = () => saveBlob(f.outBlob, f.name.replace(/\.pdf$/i, '') + '_small.pdf'); right.appendChild(dl); }
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '✕'; x.onclick = () => { files.splice(i, 1); refresh(); };
    right.appendChild(x); row.appendChild(right); list.appendChild(row);
  });
}

function saveBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }

async function addFiles(fl) {
  for (const file of fl) {
    if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) continue;
    files.push({ name: file.name, buf: await file.arrayBuffer(), size: file.size, done: false });
  }
  refresh();
}

// একটা পেজ → canvas
async function renderPage(page, scale) {
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  return { canvas: c, wpt: page.getViewport({ scale: 1 }).width, hpt: page.getViewport({ scale: 1 }).height };
}

// একটা ফাইল কম্প্রেস — scale ও quality কমিয়ে target-এর নিচে আনার চেষ্টা
async function compressOne(f, targetKB) {
  const { jsPDF } = window.jspdf;
  const doc = await pdfjsLib.getDocument({ data: f.buf.slice(0) }).promise;
  f.pages = doc.numPages;
  const scales = [1.5, 1.25, 1.0, 0.8, 0.65];
  const quals = [0.7, 0.55, 0.42, 0.3];
  // পেজ pt-সাইজ ধরে রাখি
  const pageMeta = [];
  for (let i = 1; i <= doc.numPages; i++) { const p = await doc.getPage(i); const vp = p.getViewport({ scale: 1 }); pageMeta.push({ p, w: vp.width, h: vp.height }); }
  let best = null;
  for (const scale of scales) {
    // এই scale-এ সব পেজ একবার render করি
    const imgsByQ = {};
    const canvases = [];
    for (const pm of pageMeta) canvases.push((await renderPage(pm.p, scale)).canvas);
    for (const q of quals) {
      const pdf = new jsPDF({ unit: 'pt', format: [pageMeta[0].w, pageMeta[0].h] });
      pageMeta.forEach((pm, idx) => {
        if (idx > 0) pdf.addPage([pm.w, pm.h]);
        const data = canvases[idx].toDataURL('image/jpeg', q);
        pdf.addImage(data, 'JPEG', 0, 0, pm.w, pm.h);
      });
      const blob = pdf.output('blob');
      if (!best || blob.size < best.size) best = { blob, size: blob.size };
      if (blob.size <= targetKB * 1024) { return { blob, size: blob.size }; }
    }
  }
  return best; // target-এ না নামলে সবচেয়ে ছোটটা
}

$('run').onclick = async () => {
  if (!files.length) return;
  const target = +$('target').value;
  $('run').disabled = true;
  for (const f of files) {
    if (f.done) continue;
    $('status').textContent = '⏳ ছোট করা হচ্ছে: ' + f.name; $('status').className = 'ok';
    try { const r = await compressOne(f, target); f.outBlob = r.blob; f.outSize = r.size; f.done = true; refresh(); }
    catch (e) { console.error(e); $('status').textContent = '✘ ' + f.name + ': ' + e.message; $('status').className = 'err'; }
  }
  $('run').disabled = false;
  $('status').textContent = '✔ সম্পন্ন — প্রতিটি ফাইলের পাশে "↓ ডাউনলোড" চাপুন।'; $('status').className = 'ok';
};

// wiring
(function () {
  const drop = $('drop'), inp = $('file');
  drop.onclick = () => inp.click();
  inp.onchange = () => { addFiles(inp.files); inp.value = ''; };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  $('add').onclick = () => inp.click();
  $('clear').onclick = () => { files = []; refresh(); };
})();
refresh();
