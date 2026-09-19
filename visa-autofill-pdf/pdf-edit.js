/* RJ PDF — Edit: edit existing text in its own font, erase anything (text/photo/added),
   add movable text, then flatten & download. */
import * as pdfjsLib from './lib/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const $ = (id) => document.getElementById(id);
let pages = [];   // {page,w,h,items,styles,edits:Map,newboxes:[],erases:[], _canvas,_ctx,_vp}
let zoom = 1, editing = true, eraser = false, focused = null;

$('home').onclick = () => { location.href = chrome.runtime.getURL('docgen.html'); };
function status(m, ok = true) { $('status').textContent = m; $('status').className = ok ? 'ok' : 'err'; }

async function loadPdf(file) {
  const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({ page, w: vp1.width, h: vp1.height, items: tc.items, styles: tc.styles || {}, edits: new Map(), newboxes: [], erases: [] });
  }
  $('empty').classList.add('hidden'); $('editor').classList.remove('hidden');
  await renderAll();
  status('✔ লোড হয়েছে — লেখায় ক্লিক করে বদলান · "মুছুন" দিয়ে যেকোনো কিছু ঘষে তুলুন · "নতুন লেখা" যোগ করুন।');
}

// PDF-এর ফন্ট বের করি (embedded family + bold/italic + generic fallback)
function fontOf(pg, it) {
  const s = pg.styles && pg.styles[it.fontName];
  let fam = (s && s.fontFamily) ? s.fontFamily : 'serif';
  const nm = (it.fontName || '') + ' ' + fam;
  const weight = /bold|black|semibold|heavy/i.test(nm) ? '700' : '400';
  const style = /italic|oblique/i.test(nm) ? 'italic' : 'normal';
  const generic = (/mono|courier/i.test(nm)) ? 'monospace' : (/sans/i.test(fam) ? 'sans-serif' : (/serif/i.test(fam) ? 'serif' : 'sans-serif'));
  return { family: fam + ', ' + generic, weight, style };
}
function box(pg, it, scale) { const tx = pdfjsLib.Util.transform(pg.page.getViewport({ scale }).transform, it.transform); const fh = Math.hypot(tx[2], tx[3]); return { left: tx[4], top: tx[5] - fh, base: tx[5], fh, w: Math.max((it.width || 0) * scale, fh) }; }

async function renderAll() {
  const wrapbox = $('pages'); wrapbox.innerHTML = '';
  $('zVal').textContent = Math.round(zoom * 100) + '%';
  for (let pi = 0; pi < pages.length; pi++) {
    const pg = pages[pi];
    const vp = pg.page.getViewport({ scale: zoom }); pg._vp = vp;
    const RES = Math.max(2, Math.min(3, window.devicePixelRatio || 1)); // শার্প রেন্ডার
    const num = document.createElement('div'); num.className = 'pagenum'; num.textContent = 'PAGE ' + (pi + 1) + ' / ' + pages.length; wrapbox.appendChild(num);
    const wrap = document.createElement('div'); wrap.className = 'page'; wrap.style.width = vp.width + 'px'; wrap.style.height = vp.height + 'px';
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width * RES); canvas.height = Math.ceil(vp.height * RES);
    canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
    pg._canvas = canvas; pg._ctx = canvas.getContext('2d');
    await pg.page.render({ canvasContext: pg._ctx, viewport: vp, transform: [RES, 0, 0, RES, 0, 0] }).promise;
    pg._ctx.setTransform(RES, 0, 0, RES, 0, 0); // পরবর্তী whiteout/erase CSS-px স্কেলে
    // white-out edited items + erases
    pg.items.forEach((it, idx) => { if (pg.edits.has(idx)) { const b = box(pg, it, zoom); pg._ctx.fillStyle = '#fff'; pg._ctx.fillRect(b.left - 1, b.top - 1, b.w + 3, b.fh + 4); } });
    pg.erases.forEach((e) => { pg._ctx.fillStyle = '#fff'; pg._ctx.fillRect(e.x * zoom, e.y * zoom, e.w * zoom, e.h * zoom); });
    wrap.appendChild(canvas);
    const tl = document.createElement('div'); tl.className = 'tlayer' + (editing && !eraser ? ' editing' : ''); if (eraser) tl.style.pointerEvents = 'none'; wrap.appendChild(tl);
    pg.items.forEach((it, idx) => {
      if (!it.str || !it.str.trim()) return;
      const b = box(pg, it, zoom); const f = fontOf(pg, it);
      const span = document.createElement('div'); span.className = 't';
      span.style.left = b.left + 'px'; span.style.top = b.top + 'px'; span.style.fontSize = b.fh + 'px';
      span.style.fontFamily = f.family; span.style.fontWeight = f.weight; span.style.fontStyle = f.style; span.style.caretColor = '#000';
      const ed = pg.edits.has(idx);
      span.textContent = ed ? pg.edits.get(idx) : it.str;
      span.style.color = ed ? '#000' : 'transparent';
      span.contentEditable = (editing && !eraser) ? 'true' : 'false';
      span.addEventListener('focus', () => { focused = { type: 'item', pg, idx, el: span }; if (!pg.edits.has(idx)) { pg.edits.set(idx, it.str); const bb = box(pg, it, zoom); pg._ctx.fillStyle = '#fff'; pg._ctx.fillRect(bb.left - 1, bb.top - 1, bb.w + 3, bb.fh + 4); span.style.color = '#000'; } });
      span.addEventListener('input', () => pg.edits.set(idx, span.textContent));
      tl.appendChild(span);
    });
    pg.newboxes.forEach((nb) => tl.appendChild(makeNewEl(pg, nb)));
    if (eraser) { wrap.classList.add('eraseon'); attachEraser(pg, wrap); }
    wrap._tl = tl; wrapbox.appendChild(wrap);
  }
}

function makeNewEl(pg, nb) {
  const el = document.createElement('div'); el.className = 'newbox'; el.contentEditable = 'true'; el.textContent = nb.text || 'নতুন লেখা';
  el.style.left = (nb.x * zoom) + 'px'; el.style.top = (nb.y * zoom) + 'px'; el.style.fontSize = (nb.size * zoom) + 'px';
  const del = document.createElement('span'); del.className = 'del'; del.textContent = '×'; del.title = 'মুছুন';
  del.onclick = (e) => { e.stopPropagation(); const i = pg.newboxes.indexOf(nb); if (i >= 0) pg.newboxes.splice(i, 1); el.remove(); };
  el.appendChild(del);
  el.addEventListener('input', () => { nb.text = el.childNodes[0] ? el.childNodes[0].textContent : el.textContent; });
  el.addEventListener('focus', () => { focused = { type: 'new', pg, nb, el }; });
  let drag = false, sx, sy, ox, oy;
  el.addEventListener('pointerdown', (e) => { if (e.target === del) return; if (document.activeElement === el) return; drag = true; sx = e.clientX; sy = e.clientY; ox = nb.x; oy = nb.y; e.preventDefault(); });
  window.addEventListener('pointermove', (e) => { if (!drag) return; nb.x = ox + (e.clientX - sx) / zoom; nb.y = oy + (e.clientY - sy) / zoom; el.style.left = (nb.x * zoom) + 'px'; el.style.top = (nb.y * zoom) + 'px'; });
  window.addEventListener('pointerup', () => { drag = false; });
  return el;
}

// eraser: rubber-band a rectangle over a page → white it out (covers text/photo);
// also removes new boxes / blanks edited text inside it
function attachEraser(pg, wrap) {
  let sel = null, sx, sy;
  wrap.addEventListener('pointerdown', (e) => {
    const r = wrap.getBoundingClientRect(); sx = e.clientX - r.left; sy = e.clientY - r.top;
    sel = document.createElement('div'); sel.className = 'selrect'; sel.style.left = sx + 'px'; sel.style.top = sy + 'px'; wrap.appendChild(sel);
    wrap.setPointerCapture(e.pointerId); e.preventDefault();
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!sel) return; const r = wrap.getBoundingClientRect(); const cx = e.clientX - r.left, cy = e.clientY - r.top;
    sel.style.left = Math.min(sx, cx) + 'px'; sel.style.top = Math.min(sy, cy) + 'px'; sel.style.width = Math.abs(cx - sx) + 'px'; sel.style.height = Math.abs(cy - sy) + 'px';
  });
  wrap.addEventListener('pointerup', (e) => {
    if (!sel) return; const r = wrap.getBoundingClientRect(); const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const x = Math.min(sx, cx), y = Math.min(sy, cy), w = Math.abs(cx - sx), h = Math.abs(cy - sy);
    sel.remove(); sel = null;
    if (w < 4 || h < 4) return;
    const rect = { x: x / zoom, y: y / zoom, w: w / zoom, h: h / zoom };
    pg.erases.push(rect);
    // remove new boxes whose origin is inside
    pg.newboxes = pg.newboxes.filter((nb) => !(nb.x >= rect.x && nb.x <= rect.x + rect.w && nb.y >= rect.y && nb.y <= rect.y + rect.h));
    // blank edited items intersecting
    pg.items.forEach((it, idx) => { if (!pg.edits.has(idx)) return; const b = box(pg, it, 1); if (b.left < rect.x + rect.w && b.left + b.w > rect.x && b.top < rect.y + rect.h && b.top + b.fh > rect.y) pg.edits.set(idx, ''); });
    renderAll();
    status('🧽 মোছা হয়েছে।');
  });
}

$('tEdit').onclick = () => { editing = !editing; if (editing) eraser = false; $('tEdit').textContent = '✎ লেখা এডিট: ' + (editing ? 'চালু' : 'বন্ধ'); updateEraserBtn(); renderAll(); };
$('tNew').onclick = () => { const pg = pages[0]; if (!pg) return; const nb = { x: pg.w / 2 - 40, y: 40, text: 'নতুন লেখা', size: 14 }; pg.newboxes.push(nb); const wrap = $('pages').querySelector('.page'); if (wrap && wrap._tl) { const el = makeNewEl(pg, nb); wrap._tl.appendChild(el); el.focus(); } };
$('tDel').onclick = () => { eraser = !eraser; if (eraser) editing = false; $('tEdit').textContent = '✎ লেখা এডিট: বন্ধ'; updateEraserBtn(); renderAll(); status(eraser ? '🧽 ইরেজার চালু — পেজে টেনে বক্স এঁকে মুছুন (লেখা/ছবি/নতুন সব)।' : 'ইরেজার বন্ধ।'); };
function updateEraserBtn() { $('tDel').textContent = eraser ? '🧽 মুছুন: চালু' : '🧽 মুছুন'; $('tDel').classList.toggle('btn-soft', eraser); }
$('zIn').onclick = () => { zoom = Math.min(3, +(zoom + 0.15).toFixed(2)); renderAll(); };
$('zOut').onclick = () => { zoom = Math.max(0.4, +(zoom - 0.15).toFixed(2)); renderAll(); };
$('tReset').onclick = () => { pages.forEach((p) => { p.edits.clear(); p.newboxes = []; p.erases = []; }); focused = null; renderAll(); status('↺ সব রিসেট।'); };

$('tApply').onclick = () => { document.querySelectorAll('.tlayer').forEach((tl) => tl.style.display = 'none'); bakeAll(zoom); editing = false; eraser = false; $('tEdit').textContent = '✎ লেখা এডিট: বন্ধ'; updateEraserBtn(); status('✔ সংরক্ষণ হয়েছে — এখন Download চাপুন। আবার এডিট করতে "লেখা এডিট" চালু করুন।'); };

function bakeAll(scale, ctxByPage) {
  pages.forEach((pg, pi) => {
    const ctx = ctxByPage ? ctxByPage[pi] : pg._ctx; if (!ctx) return;
    pg.erases.forEach((e) => { ctx.fillStyle = '#fff'; ctx.fillRect(e.x * scale, e.y * scale, e.w * scale, e.h * scale); });
    ctx.textBaseline = 'alphabetic';
    pg.items.forEach((it, idx) => { if (!pg.edits.has(idx)) return; const b = box(pg, it, scale); const f = fontOf(pg, it); ctx.fillStyle = '#fff'; ctx.fillRect(b.left - 1, b.top - 1, b.w + 4, b.fh + 5); const t = pg.edits.get(idx); if (t) { ctx.fillStyle = '#000'; ctx.font = `${f.style} ${f.weight} ${b.fh}px ${f.family}`; ctx.fillText(t, b.left, b.base); } });
    ctx.textBaseline = 'top';
    pg.newboxes.forEach((nb) => { ctx.fillStyle = '#000'; ctx.font = `${nb.size * scale}px sans-serif`; (nb.text || '').split('\n').forEach((ln, i) => ctx.fillText(ln, nb.x * scale, nb.y * scale + i * nb.size * scale * 1.25)); });
  });
}

$('tDownload').onclick = async () => {
  status('⏳ ফাইল তৈরি হচ্ছে...');
  try {
    await document.fonts.ready;
    const { jsPDF } = window.jspdf; const FS = 2; let pdf = null; const ctxs = [];
    const canvases = [];
    for (let pi = 0; pi < pages.length; pi++) {
      const pg = pages[pi]; const vp = pg.page.getViewport({ scale: FS });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d'); await pg.page.render({ canvasContext: ctx, viewport: vp }).promise;
      ctxs[pi] = ctx; canvases[pi] = c;
    }
    bakeAll(FS, ctxs);
    for (let pi = 0; pi < pages.length; pi++) {
      const pg = pages[pi]; const img = canvases[pi].toDataURL('image/jpeg', 0.92);
      if (!pdf) pdf = new jsPDF({ unit: 'pt', format: [pg.w, pg.h] }); else pdf.addPage([pg.w, pg.h]);
      pdf.addImage(img, 'JPEG', 0, 0, pg.w, pg.h);
    }
    pdf.save('RJ_edited.pdf'); status('✔ ডাউনলোড হয়েছে (RJ_edited.pdf)।');
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
