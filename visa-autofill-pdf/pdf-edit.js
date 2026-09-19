/* RJ PDF — Edit: transparent text layer over the page; click a text to edit it in place
   (whites out the original beneath), add movable new text, then flatten & download. */
import * as pdfjsLib from './lib/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const $ = (id) => document.getElementById(id);
let pages = [];   // {page,w,h,items,edits:Map(idx->text),newboxes:[], _canvas,_ctx,_vp}
let zoom = 1, editing = true, focused = null; // focused: {type:'item',pg,idx,el} | {type:'new',pg,nb,el}
let srcBytes = null; // আসল PDF bytes (vector ডাউনলোডের জন্য)

$('home').onclick = () => { location.href = chrome.runtime.getURL('docgen.html'); };
function status(m, ok = true) { $('status').textContent = m; $('status').className = ok ? 'ok' : 'err'; }

async function loadPdf(file) {
  const buf = await file.arrayBuffer();
  srcBytes = new Uint8Array(buf).slice(0); // আসল bytes রাখি (pdf.js buffer neuter করতে পারে)
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
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

function markSel(el) { document.querySelectorAll('.t.sel,.newbox.sel').forEach((e) => e.classList.remove('sel')); el.classList.add('sel'); }

function itemBox(pg, it) {
  const tx = pdfjsLib.Util.transform(pg._vp.transform, it.transform);
  const fh = Math.hypot(tx[2], tx[3]);
  const w = Math.max((it.width || 0) * zoom, fh);
  return { left: tx[4], top: tx[5] - fh, fh, w };
}
function whiteout(pg, it) {
  const b = itemBox(pg, it);
  pg._ctx.fillStyle = '#fff';
  pg._ctx.fillRect(b.left - 1, b.top - 1, b.w + 3, b.fh + 4);
}

async function renderAll() {
  const box = $('pages'); box.innerHTML = '';
  $('zVal').textContent = Math.round(zoom * 100) + '%';
  for (let pi = 0; pi < pages.length; pi++) {
    const pg = pages[pi];
    const vp = pg.page.getViewport({ scale: zoom }); pg._vp = vp;
    const num = document.createElement('div'); num.className = 'pagenum'; num.textContent = 'PAGE ' + (pi + 1) + ' / ' + pages.length; box.appendChild(num);
    const wrap = document.createElement('div'); wrap.className = 'page'; wrap.style.width = vp.width + 'px'; wrap.style.height = vp.height + 'px';
    const RES = Math.max(2, Math.min(3, window.devicePixelRatio || 1)); // শার্প রেন্ডার (ঝাপসা নয়)
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width * RES); canvas.height = Math.ceil(vp.height * RES);
    canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
    pg._canvas = canvas; pg._ctx = canvas.getContext('2d');
    await pg.page.render({ canvasContext: pg._ctx, viewport: vp, transform: [RES, 0, 0, RES, 0, 0] }).promise;
    pg._ctx.setTransform(RES, 0, 0, RES, 0, 0); // পরের whiteout/bake CSS-px স্কেলে
    // re-apply whiteouts for already-edited items
    pg.items.forEach((it, idx) => { if (pg.edits.has(idx)) whiteout(pg, it); });
    wrap.appendChild(canvas);
    const tl = document.createElement('div'); tl.className = 'tlayer' + (editing ? ' editing' : ''); wrap.appendChild(tl);
    pg.items.forEach((it, idx) => {
      if (!it.str || !it.str.trim()) return;
      const b = itemBox(pg, it);
      const span = document.createElement('div'); span.className = 't';
      span.style.left = b.left + 'px'; span.style.top = b.top + 'px'; span.style.fontSize = b.fh + 'px'; span.style.caretColor = '#000';
      const edited = pg.edits.has(idx);
      span.textContent = edited ? pg.edits.get(idx) : it.str;
      span.style.color = edited ? '#000' : 'transparent';
      span.contentEditable = editing ? 'true' : 'false';
      const selectThis = () => { focused = { type: 'item', pg, idx, el: span }; markSel(span); };
      span.addEventListener('pointerdown', selectThis);   // ক্লিক করলেই সিলেক্ট (নির্ভরযোগ্য)
      span.addEventListener('focus', () => {
        selectThis();
        if (!pg.edits.has(idx)) { pg.edits.set(idx, it.str); whiteout(pg, it); span.style.color = '#000'; span.classList.add('edited'); }
      });
      span.addEventListener('input', () => { pg.edits.set(idx, span.textContent); });
      tl.appendChild(span);
    });
    pg.newboxes.forEach((nb) => tl.appendChild(makeNewEl(pg, nb)));
    wrap._tl = tl; box.appendChild(wrap);
  }
}

function makeNewEl(pg, nb) {
  const el = document.createElement('div'); el.className = 'newbox'; el.contentEditable = 'true';
  el.textContent = nb.text || 'নতুন লেখা';
  el.style.left = (nb.x * zoom) + 'px'; el.style.top = (nb.y * zoom) + 'px'; el.style.fontSize = (nb.size * zoom) + 'px';
  el.addEventListener('input', () => { nb.text = el.textContent; });
  const selN = () => { focused = { type: 'new', pg, nb, el }; markSel(el); };
  el.addEventListener('pointerdown', selN);
  el.addEventListener('focus', selN);
  let drag = false, sx, sy, ox, oy;
  el.addEventListener('pointerdown', (e) => { if (document.activeElement === el) return; drag = true; sx = e.clientX; sy = e.clientY; ox = nb.x; oy = nb.y; e.preventDefault(); });
  window.addEventListener('pointermove', (e) => { if (!drag) return; nb.x = ox + (e.clientX - sx) / zoom; nb.y = oy + (e.clientY - sy) / zoom; el.style.left = (nb.x * zoom) + 'px'; el.style.top = (nb.y * zoom) + 'px'; });
  window.addEventListener('pointerup', () => { drag = false; });
  return el;
}

$('tEdit').onclick = () => { editing = !editing; $('tEdit').textContent = '✎ লেখা এডিট: ' + (editing ? 'চালু' : 'বন্ধ'); renderAll(); };
$('tNew').onclick = () => {
  const pg = pages[0]; if (!pg) return;
  const nb = { x: pg.w / 2 - 40, y: 40, text: 'নতুন লেখা', size: 14 };
  pg.newboxes.push(nb);
  const wrap = $('pages').querySelector('.page'); if (wrap && wrap._tl) { const el = makeNewEl(pg, nb); wrap._tl.appendChild(el); el.focus(); }
};
$('tDel').onclick = () => {
  if (!focused) { status('মুছতে আগে একটি লেখায় ক্লিক করুন।', false); return; }
  if (focused.type === 'new') { const i = focused.pg.newboxes.indexOf(focused.nb); if (i >= 0) focused.pg.newboxes.splice(i, 1); focused.el.remove(); }
  else { focused.pg.edits.set(focused.idx, ''); focused.el.textContent = ''; }
  focused = null;
  status('🗑 মুছে ফেলা হয়েছে।');
};
$('zIn').onclick = () => { zoom = Math.min(3, +(zoom + 0.15).toFixed(2)); renderAll(); };
$('zOut').onclick = () => { zoom = Math.max(0.4, +(zoom - 0.15).toFixed(2)); renderAll(); };
$('tReset').onclick = () => { pages.forEach((p) => { p.edits.clear(); p.newboxes = []; }); focused = null; renderAll(); status('↺ সব এডিট রিসেট।'); };

// Apply/Save — এডিটগুলো প্রিভিউ ক্যানভাসে বেক করে দেখায় (ডাউনলোডের আগে নিশ্চিত হতে)
$('tApply').onclick = () => {
  pages.forEach((pg) => {
    if (!pg._ctx) return;
    const ctx = pg._ctx;
    ctx.textBaseline = 'alphabetic';
    pg.items.forEach((it, idx) => {
      if (!pg.edits.has(idx)) return;
      const b = itemBox(pg, it);
      ctx.fillStyle = '#fff'; ctx.fillRect(b.left - 1, b.top - 1, b.w + 3, b.fh + 4);
      const t = pg.edits.get(idx);
      if (t) { ctx.fillStyle = '#000'; ctx.font = b.fh + 'px sans-serif'; ctx.fillText(t, b.left, b.top + b.fh); }
    });
    ctx.textBaseline = 'top';
    pg.newboxes.forEach((nb) => { ctx.fillStyle = '#000'; ctx.font = (nb.size * zoom) + 'px sans-serif'; (nb.text || '').split('\n').forEach((ln, i) => ctx.fillText(ln, nb.x * zoom, nb.y * zoom + i * nb.size * zoom * 1.25)); });
  });
  // spans লুকিয়ে দিই যাতে শুধু বেক করা ক্যানভাস দেখা যায়
  document.querySelectorAll('.tlayer').forEach((tl) => { tl.style.display = 'none'; });
  editing = false; $('tEdit').textContent = '✎ লেখা এডিট: বন্ধ';
  status('✔ সংরক্ষণ হয়েছে — এখন "Download" চাপুন। আবার এডিট করতে "লেখা এডিট" চালু করুন।');
};

// শুধু WinAnsi-এনকোডযোগ্য অক্ষর রাখি (Helvetica), নাহলে drawText ভাঙে
function ansi(s) { return String(s || '').replace(/[^\x20-\x7E\xA0-\xFF]/g, ''); }

$('tDownload').onclick = async () => {
  if (!srcBytes) { status('আগে একটি PDF লোড করুন।', false); return; }
  status('⏳ ফাইল তৈরি হচ্ছে...');
  try {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const out = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
    const helv = await out.embedFont(StandardFonts.Helvetica);
    const opages = out.getPages();
    const white = rgb(1, 1, 1), black = rgb(0, 0, 0);
    pages.forEach((pg, pi) => {
      const page = opages[pi]; if (!page) return; const H = page.getHeight();
      // edited / erased items — আসল লেখার উপর সাদা বক্স, তারপর নতুন লেখা (থাকলে)
      pg.items.forEach((it, idx) => {
        if (!pg.edits.has(idx)) return;
        const x = it.transform[4], yb = it.transform[5], fh = Math.hypot(it.transform[2], it.transform[3]);
        const w = Math.max(it.width || 0, fh);
        page.drawRectangle({ x: x - 1, y: yb - fh * 0.3, width: w + 2, height: fh * 1.35, color: white });
        const t = ansi(pg.edits.get(idx));
        if (t) { try { page.drawText(t, { x, y: yb, size: fh * 0.9, font: helv, color: black }); } catch (_) {} }
      });
      // new text boxes (top-left, points) → pdf-lib bottom-left
      pg.newboxes.forEach((nb) => {
        const size = nb.size; const lines = ansi(nb.text).split('\n');
        lines.forEach((ln, i) => { try { page.drawText(ln, { x: nb.x, y: H - nb.y - size * (i + 1), size, font: helv, color: black }); } catch (_) {} });
      });
    });
    const bytes = await out.save();
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    a.download = 'RJ_edited.pdf'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    status('✔ ডাউনলোড হয়েছে — এই ফাইল আবার এডিট করা যাবে (text layer অক্ষত)।');
  } catch (e) { console.error(e); status('✘ তৈরি হয়নি: ' + e.message, false); }
};

(function () {
  const drop = $('drop'), inp = $('file');
  drop.onclick = () => inp.click();
  inp.onchange = () => { if (inp.files[0]) loadPdf(inp.files[0]); };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) loadPdf(f); });
})();
