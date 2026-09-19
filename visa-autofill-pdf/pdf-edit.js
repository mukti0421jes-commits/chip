/* RJ PDF — Edit: render pages, edit existing text inline, add new text, flatten & download */
import * as pdfjsLib from './lib/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const $ = (id) => document.getElementById(id);
let pages = [];      // {page, w, h, items, edits:Map, newboxes:[]}
let zoom = 1, editing = true, focusedNew = null;

$('home').onclick = () => { location.href = chrome.runtime.getURL('docgen.html'); };

async function loadPdf(file) {
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({ page, w: vp1.width, h: vp1.height, items: tc.items, edits: new Map(), newboxes: [] });
  }
  $('empty').classList.add('hidden'); $('editor').classList.remove('hidden');
  await renderAll();
  status('✔ লোড হয়েছে — যেকোনো লেখায় ক্লিক করে বদলান, বা "নতুন লেখা" যোগ করুন।');
}

function status(m, ok = true) { $('status').textContent = m; $('status').className = ok ? 'ok' : 'err'; }

async function renderAll() {
  const box = $('pages'); box.innerHTML = '';
  $('zVal').textContent = Math.round(zoom * 100) + '%';
  for (let pi = 0; pi < pages.length; pi++) {
    const pg = pages[pi];
    const vp = pg.page.getViewport({ scale: zoom });
    const wrap = document.createElement('div'); wrap.className = 'page'; wrap.style.width = vp.width + 'px'; wrap.style.height = vp.height + 'px';
    const num = document.createElement('div'); num.className = 'pagenum'; num.textContent = 'PAGE ' + (pi + 1) + ' / ' + pages.length; box.appendChild(num);
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    await pg.page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    wrap.appendChild(canvas);
    const tl = document.createElement('div'); tl.className = 'tlayer' + (editing ? ' editing' : ''); wrap.appendChild(tl);
    // existing text items
    pg.items.forEach((it, idx) => {
      if (!it.str || !it.str.trim()) return;
      const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
      const fh = Math.hypot(tx[2], tx[3]);
      const span = document.createElement('div'); span.className = 't' + (pg.edits.has(idx) ? ' edited' : '');
      span.style.left = tx[4] + 'px'; span.style.top = (tx[5] - fh) + 'px'; span.style.fontSize = fh + 'px';
      span.textContent = pg.edits.has(idx) ? pg.edits.get(idx) : it.str;
      span.contentEditable = editing ? 'true' : 'false';
      span.dataset.idx = idx;
      span.addEventListener('input', () => { pg.edits.set(idx, span.textContent); span.classList.add('edited'); });
      tl.appendChild(span);
    });
    // new boxes
    pg.newboxes.forEach((nb) => tl.appendChild(makeNewEl(pg, nb, zoom)));
    box.appendChild(wrap);
    wrap._page = pg; wrap._tl = tl;
  }
}

function makeNewEl(pg, nb, z) {
  const el = document.createElement('div'); el.className = 'newbox';
  el.contentEditable = 'true'; el.textContent = nb.text || 'নতুন লেখা';
  el.style.left = (nb.x * z) + 'px'; el.style.top = (nb.y * z) + 'px'; el.style.fontSize = (nb.size * z) + 'px';
  el.addEventListener('input', () => { nb.text = el.textContent; });
  el.addEventListener('focus', () => { focusedNew = { pg, nb, el }; });
  // drag
  let dragging = false, sx, sy, ox, oy;
  el.addEventListener('pointerdown', (e) => { if (e.target !== el) return; if (document.activeElement === el && e.detail > 1) return; dragging = true; sx = e.clientX; sy = e.clientY; ox = nb.x; oy = nb.y; });
  window.addEventListener('pointermove', (e) => { if (!dragging) return; nb.x = ox + (e.clientX - sx) / zoom; nb.y = oy + (e.clientY - sy) / zoom; el.style.left = (nb.x * zoom) + 'px'; el.style.top = (nb.y * zoom) + 'px'; });
  window.addEventListener('pointerup', () => { dragging = false; });
  return el;
}

// toolbar
$('tEdit').onclick = () => { editing = !editing; $('tEdit').textContent = '✎ লেখা এডিট: ' + (editing ? 'চালু' : 'বন্ধ'); renderAll(); };
$('tNew').onclick = () => {
  const pg = pages[0]; if (!pg) return;
  const nb = { x: pg.w / 2 - 40, y: 40, text: 'নতুন লেখা', size: 14 };
  pg.newboxes.push(nb);
  const wrap = $('pages').querySelector('.page'); const tl = wrap && wrap._tl;
  if (tl) { const el = makeNewEl(pg, nb, zoom); tl.appendChild(el); el.focus(); }
};
$('tDel').onclick = () => {
  if (!focusedNew) { status('মুছতে আগে একটি "নতুন লেখা" বক্সে ক্লিক করুন।', false); return; }
  const { pg, nb, el } = focusedNew; const i = pg.newboxes.indexOf(nb);
  if (i >= 0) pg.newboxes.splice(i, 1); if (el) el.remove(); focusedNew = null;
};
$('zIn').onclick = () => { zoom = Math.min(3, zoom + 0.15); renderAll(); };
$('zOut').onclick = () => { zoom = Math.max(0.4, zoom - 0.15); renderAll(); };
$('tReset').onclick = () => { pages.forEach((p) => { p.edits.clear(); p.newboxes = []; }); renderAll(); status('↺ সব এডিট রিসেট।'); };

// flatten + download
$('tDownload').onclick = async () => {
  status('⏳ ফাইল তৈরি হচ্ছে...');
  try {
    const { jsPDF } = window.jspdf;
    const FS = 2;
    let pdf = null;
    for (let pi = 0; pi < pages.length; pi++) {
      const pg = pages[pi];
      const vp = pg.page.getViewport({ scale: FS });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d');
      await pg.page.render({ canvasContext: ctx, viewport: vp }).promise;
      // edited items: whiteout original + draw new text
      ctx.textBaseline = 'alphabetic';
      pg.items.forEach((it, idx) => {
        if (!pg.edits.has(idx)) return;
        const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
        const fh = Math.hypot(tx[2], tx[3]);
        const w = (it.width || 0) * FS || fh * (it.str.length * 0.5);
        ctx.fillStyle = '#fff';
        ctx.fillRect(tx[4] - 1, tx[5] - fh - 1, Math.max(w, fh) + 4, fh + 5);
        ctx.fillStyle = '#000'; ctx.font = fh + 'px sans-serif';
        ctx.fillText(pg.edits.get(idx), tx[4], tx[5]);
      });
      // new boxes
      pg.newboxes.forEach((nb) => {
        ctx.fillStyle = '#000'; ctx.font = (nb.size * FS) + 'px sans-serif'; ctx.textBaseline = 'top';
        (nb.text || '').split('\n').forEach((ln, i) => ctx.fillText(ln, nb.x * FS, nb.y * FS + i * nb.size * FS * 1.2));
      });
      const img = c.toDataURL('image/jpeg', 0.92);
      if (!pdf) pdf = new jsPDF({ unit: 'pt', format: [pg.w, pg.h] });
      else pdf.addPage([pg.w, pg.h]);
      pdf.addImage(img, 'JPEG', 0, 0, pg.w, pg.h);
    }
    pdf.save('RJ_edited.pdf');
    status('✔ ডাউনলোড হয়েছে (RJ_edited.pdf)।');
  } catch (e) { console.error(e); status('✘ তৈরি হয়নি: ' + e.message, false); }
};

// drop wiring
(function () {
  const drop = $('drop'), inp = $('file');
  drop.onclick = () => inp.click();
  inp.onchange = () => { if (inp.files[0]) loadPdf(inp.files[0]); };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) loadPdf(f); });
})();
