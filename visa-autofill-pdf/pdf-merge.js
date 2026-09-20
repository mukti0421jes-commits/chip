/* RJ PDF — Merge: order files, optional per-file page range, combine into one PDF */
import * as pdfjsLib from './lib/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const $ = (id) => document.getElementById(id);
const kb = (b) => Math.round(b / 1024) + ' KB';
let files = []; // {name,bytes,size,pages,range}

$('home').onclick = () => { location.href = chrome.runtime.getURL('docgen.html'); };
function status(m, ok = true) { $('status').textContent = m; $('status').className = ok ? 'ok' : 'err'; }

async function addFiles(fl) {
  for (const f of fl) {
    if (!(f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) continue;
    const bytes = new Uint8Array(await f.arrayBuffer());
    let pages = 0; try { pages = (await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise).numPages; } catch (_) {}
    files.push({ name: f.name, bytes, size: f.size, pages, range: '' });
  }
  render();
}
function render() {
  $('loaded').classList.toggle('hidden', files.length === 0);
  const list = $('list'); list.innerHTML = '';
  files.forEach((f, idx) => {
    const row = document.createElement('div'); row.className = 'frow'; row.draggable = true; row.dataset.i = idx;
    row.innerHTML = `<span style="cursor:grab">⠿</span><div class="no">${idx + 1}</div><div class="fi">📄</div>
      <div><div class="nm">${f.name}</div><div class="meta">${kb(f.size)} · ${f.pages || '?'} পেজ</div></div>
      <div class="rng"><label>পেজ রেঞ্জ</label><br><input placeholder="যেমন: 1-3, 5" value="${f.range}"></div>
      <button class="x">✕</button>`;
    row.querySelector('input').oninput = (e) => { f.range = e.target.value; };
    row.querySelector('.x').onclick = () => { files.splice(idx, 1); render(); };
    row.addEventListener('dragstart', (e) => { row.classList.add('drag'); e.dataTransfer.setData('text/plain', idx); });
    row.addEventListener('dragend', () => row.classList.remove('drag'));
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', (e) => { e.preventDefault(); const from = +e.dataTransfer.getData('text/plain'); if (from === idx) return; const [m] = files.splice(from, 1); files.splice(idx, 0, m); render(); });
    list.appendChild(row);
  });
  $('stFiles').textContent = files.length;
  $('stPages').textContent = files.reduce((a, f) => a + (f.pages || 0), 0);
  $('stSize').textContent = kb(files.reduce((a, f) => a + f.size, 0));
}
function parseRange(txt, n) {
  if (!txt || !txt.trim()) return Array.from({ length: n }, (_, i) => i);
  const set = new Set();
  txt.split(',').forEach((p) => { const m = p.trim().match(/^(\d+)\s*-\s*(\d+)$/); if (m) { for (let i = +m[1]; i <= +m[2]; i++) if (i >= 1 && i <= n) set.add(i - 1); } else { const k = parseInt(p.trim(), 10); if (k >= 1 && k <= n) set.add(k - 1); } });
  return [...set].sort((a, b) => a - b);
}

$('merge').onclick = async () => {
  if (!files.length) return;
  status('⏳ মার্জ হচ্ছে...');
  try {
    const { PDFDocument } = window.PDFLib;
    const out = await PDFDocument.create();
    for (const f of files) {
      const src = await PDFDocument.load(f.bytes, { ignoreEncryption: true });
      const idxs = parseRange(f.range, src.getPageCount());
      const copied = await out.copyPages(src, idxs);
      copied.forEach((pg) => out.addPage(pg));
    }
    const bytes = await out.save();
    const nm = ($('outname').value.trim() || 'merged').replace(/\.pdf$/i, '') + '.pdf';
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); a.download = nm; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    status('✔ ডাউনলোড হয়েছে (' + nm + ') — ' + out.getPageCount() + ' পেজ।');
  } catch (e) { console.error(e); status('✘ ' + e.message, false); }
};

(function () {
  const drop = $('drop'), inp = $('file');
  drop.onclick = () => inp.click();
  inp.onchange = () => { addFiles(inp.files); inp.value = ''; };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  $('add').onclick = () => inp.click();
  $('clear').onclick = () => { files = []; render(); };
})();
