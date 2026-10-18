/* RJ PDF — Image to PDF: order images, choose page size/orientation/margin, build PDF */
(function () {
  const $ = (id) => document.getElementById(id);
  let images = []; // {id,name,dataURL,w,h}
  function status(m, ok = true) { const e = $('status'); e.textContent = m; e.className = ok ? 'ok' : 'err'; }

  $('home').onclick = () => { location.href = chrome.runtime.getURL('docgen.html'); };

  function readImage(file) {
    return new Promise((res) => {
      const r = new FileReader();
      r.onload = () => { const img = new Image(); img.onload = () => res({ id: 'i' + Date.now() + Math.random().toString(36).slice(2, 5), name: file.name, dataURL: r.result, w: img.naturalWidth, h: img.naturalHeight }); img.onerror = () => res(null); img.src = r.result; };
      r.onerror = () => res(null); r.readAsDataURL(file);
    });
  }
  async function addFiles(fl) {
    for (const f of fl) { if (!f.type.startsWith('image/')) continue; const im = await readImage(f); if (im) images.push(im); }
    render();
  }
  function render() {
    $('loaded').classList.toggle('hidden', images.length === 0);
    const box = $('imgs'); box.innerHTML = '';
    images.forEach((im, idx) => {
      const c = document.createElement('div'); c.className = 'imgc'; c.draggable = true; c.dataset.i = idx;
      c.innerHTML = `<div class="no">${idx + 1}</div><button class="x">×</button><img src="${im.dataURL}"><div class="nm">${im.name}</div>`;
      c.querySelector('.x').onclick = (e) => { e.stopPropagation(); images.splice(idx, 1); render(); };
      c.addEventListener('dragstart', (e) => { c.classList.add('drag'); e.dataTransfer.setData('text/plain', idx); });
      c.addEventListener('dragend', () => c.classList.remove('drag'));
      c.addEventListener('dragover', (e) => e.preventDefault());
      c.addEventListener('drop', (e) => { e.preventDefault(); const from = +e.dataTransfer.getData('text/plain'), to = idx; if (from === to) return; const [m] = images.splice(from, 1); images.splice(to, 0, m); render(); });
      box.appendChild(c);
    });
  }
  const fmtOf = (d) => (/^data:image\/png/i.test(d) ? 'PNG' : /^data:image\/webp/i.test(d) ? 'WEBP' : 'JPEG');

  $('make').onclick = () => {
    if (!images.length) return;
    status('⏳ PDF তৈরি হচ্ছে...');
    try {
      const { jsPDF } = window.jspdf;
      const size = $('size').value, orient = $('orient').value, margin = +$('margin').value;
      let pdf = null;
      images.forEach((im) => {
        let format, orientation, m = margin;
        if (size === 'fit') { const pw = im.w * 0.75, ph = im.h * 0.75; format = [pw, ph]; orientation = pw >= ph ? 'l' : 'p'; m = 0; }
        else { format = size; orientation = (orient === 'auto') ? (im.w >= im.h ? 'l' : 'p') : (orient === 'landscape' ? 'l' : 'p'); }
        if (!pdf) pdf = new jsPDF({ unit: 'pt', format, orientation }); else pdf.addPage(format, orientation);
        const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
        const availW = pw - 2 * m, availH = ph - 2 * m;
        const scale = Math.min(availW / im.w, availH / im.h);
        const dw = im.w * scale, dh = im.h * scale, x = (pw - dw) / 2, y = (ph - dh) / 2;
        pdf.addImage(im.dataURL, fmtOf(im.dataURL), x, y, dw, dh);
      });
      pdf.save('RJ_images.pdf');
      status('✔ ডাউনলোড হয়েছে (RJ_images.pdf) — ' + images.length + ' পেজ।');
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
    $('clear').onclick = () => { images = []; render(); };
  })();
})();
